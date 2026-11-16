// ランナーの通し（スタブ）: 生成物（skills/implement-issue-tree/scripts/implement-issue-tree.js）を load-workflow で読み、
// agent-host + 偽アダプタ（lib/fake-adapter.mjs）で終端まで流す。同じ args・同じ既定応答表（stub-run.mjs の
// makeDefaultReply）で src を stub-run の直結スタブに流した結果と、次の 2 点が一致することを確かめる。
//   1. 生成物が呼んだ agent() の列（label・model・effort・phase・isolation）。parallel 1 と dryRun は順序まで、
//      parallel 2 は並行の入れ子でスケジュールの順が変わり得るため多重集合で比べる。
//   2. ホストの return 値（終端状態）。
// 実行仕様の段の扱い: このブランチの生成物は 0 行目の実行仕様（<!-- iit-exec v1 ... -->）を持たない（P6 前）ため、
// 全段がモデル（偽アダプタ）へ回る。それを前提として明示的に確かめ（仕様行 0 件・境界の呼び出し = アダプタの
// 初回ターン）、比較から外す段は無い。仕様の段の直接実行は runner-agent-host.test.mjs で P6 形式の仕様行を使って確かめる。
// P6 の生成物に入れ替わったら、仕様の段は agent-host の spawnScript 注入で既定応答を返す形にして同じ比較を続ける。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BASE_ARGS, DIST_PATH, buildTree, runScript } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { createAgentHost } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { loadWorkflow } from '../../../skills/implement-issue-tree/runner/lib/load-workflow.mjs'
import { loadConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'

const MAIN_ROOT = '/repo'
const RUN_ID = 'wf_0123abcd-4ef'
const shape = ({ opts }) => ({ label: opts.label, model: opts.model ?? null, effort: opts.effort ?? null, phase: opts.phase ?? null, isolation: opts.isolation ?? null })
const sortKey = (c) => JSON.stringify(c)

async function runThroughRunner({ args, leaves }) {
  const workflow = loadWorkflow()
  const nodes = buildTree(leaves)
  const mod = makeFakeAdapterModule({ defaults: { args, nodes } })
  const worktrees = []
  const host = createAgentHost({
    adapter: mod.createAdapter({}),
    cfg: {
      config: loadConfig(),
      skillDir: args.skillDir,
      mainRoot: MAIN_ROOT,
      runId: RUN_ID,
      args,
      maxParallel: args.parallel,
      // git に触れない worktree（通し番号の確認だけ）
      createWorktree: ({ mainRoot, runId, n }) => {
        worktrees.push(n)
        return { path: `${mainRoot}/.claude/worktrees/${runId}-${n}` }
      },
    },
  })
  const calls = []
  const agent = (prompt, opts) => {
    calls.push({ prompt, opts })
    return host(prompt, opts)
  }
  const result = await workflow.run(structuredClone(args), agent, () => {}, () => {})
  return { result, calls, adapterCalls: mod.calls, worktrees, stats: host.stats }
}

const CASES = [
  { name: '葉 1 件・parallel 1', args: { ...BASE_ARGS }, leaves: [2], ordered: true, count: 30 },
  { name: '葉 2 件・parallel 2', args: { ...BASE_ARGS, parallel: 2 }, leaves: [2, 3], ordered: false, count: 43 },
  { name: 'dryRun・葉 2 件', args: { ...BASE_ARGS, dryRun: true }, leaves: [2, 3], ordered: true, count: 8 },
]

test('このブランチの生成物は実行仕様の行を持たない（全段がアダプタへ回る前提の確認）', () => {
  assert.equal(readFileSync(DIST_PATH, 'utf8').includes('<!-- iit-exec v1 '), false)
})

for (const c of CASES) {
  test(`通し（${c.name}）: 生成物 + ランナー + 偽アダプタが src + stub-run と同じ呼び出し列・終端状態になる`, async () => {
    const ref = await runScript({ args: structuredClone(c.args), leaves: c.leaves, target: 'src' })
    const got = await runThroughRunner({ args: c.args, leaves: c.leaves })

    assert.deepEqual(got.result, ref.result, '終端状態（ホストの return 値）')
    const a = got.calls.map(shape)
    const b = ref.calls.map(shape)
    if (c.ordered) assert.deepEqual(a, b, '呼び出し列（順序つき）')
    else assert.deepEqual(a.map(sortKey).sort(), b.map(sortKey).sort(), '呼び出し列（多重集合）')
    // 空の比較で通らないよう、呼び出し数を固定する（既定応答表・生成物が変わったら更新する）
    assert.equal(a.length, c.count)
    if (c.args.dryRun) assert.equal(typeof got.result.startable?.count, 'number', 'dryRun は見積りを返す')
    else assert.equal(got.result.dryRun, undefined)

    // 仕様の段が無いので、境界の呼び出しはすべてアダプタの初回ターンになる（修復ターンは不適合な既定応答の分だけ増える）
    const firstTurns = got.adapterCalls.filter((r) => r.resume === null)
    assert.equal(firstTurns.length, got.calls.length)
    assert.deepEqual(firstTurns.map((r) => r.label).sort(), got.calls.map((x) => x.opts.label).sort())
    // isolation: 'worktree' の呼び出しだけ worktree を作り、その呼び出しの通し番号を使う
    assert.equal(got.worktrees.length, got.calls.filter((x) => x.opts.isolation === 'worktree').length)
    for (const r of got.adapterCalls) {
      if (r.cwd !== MAIN_ROOT) assert.match(r.cwd, new RegExp(`^/repo/\\.claude/worktrees/${RUN_ID}-\\d+$`))
    }
    assert.equal(got.stats.calls, got.calls.length)
    assert.ok(got.stats.maxActive <= c.args.parallel, `同時実行 ${got.stats.maxActive}`)
  })
}

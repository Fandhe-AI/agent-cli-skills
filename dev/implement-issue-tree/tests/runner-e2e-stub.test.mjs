// ランナーの通し（スタブ）: 生成物（skills/implement-issue-tree/scripts/implement-issue-tree.js）を load-workflow で読み、
// agent-host + 偽アダプタ（lib/fake-adapter.mjs）+ 偽の run-verified.sh で終端まで流す。同じ args・同じ既定応答表
// （stub-run.mjs の makeDefaultReply）で src を stub-run の直結スタブに流した結果と、次が一致することを確かめる。
//   1. 生成物が呼んだ agent() の列（label・model・effort・phase・isolation）のうち、実行仕様の段を除いたもの。
//      parallel 1 と dryRun は順序まで、parallel 2 は並行の入れ子でスケジュールの順が変わり得るため多重集合で比べる。
//   2. ホストの return 値（終端状態）。
//
// 実行仕様の段（0 行目が <!-- iit-exec v1 … -->）の扱い: ランナーではアダプタへ回らず、agent-host が
// `bash <skillDir>/scripts/run-verified.sh …` を shell なしで起動する。ここではテスト用の skillDir に偽の
// run-verified.sh を置き（実スクリプトは実行しない）、agent-host の spawnScript を包んで、その段の出力を既定応答表から作る:
//   envelope = 既定応答の JSON を 1 行・line:<語> = `<語> <JSON>`・exit-ok = 既定応答の ok が true なら終了コード 0。
//   既定応答が null なら終了コード 1（ランナーは仕様の fail を返す）。
// stub-run 側ではその段に既定応答がそのまま返るので、両者は同じ値になる（ret ごとの失敗値と null がずれる段は、
// 下の CASES の流れには無い）。比較から仕様の段を外すのは、値の作り方が両側で違う（stub-run は既定応答・ランナーは
// 偽スクリプトの出力の解釈）ためで、仕様の段については別に次を確かめる:
//   - アダプタへ 1 件も回っていない・meta.json の status が exec-ok（許可表で拒否されて失敗値に倒れていない）
//   - 偽の launcher が受けた引数が [sha256, script, ...argv]（--verify-only は argv のみ）で、cwd がメイン worktree、
//     標準入力が仕様の stdinHex と同じ
//   - 仕様の段の label の多重集合が stub-run 側と同じ
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_ARGS, DIST_PATH, buildTree, makeDefaultReply, runScript } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { trackTmp } from './lib/tmp-track.mjs'
import { createAgentHost, parseExecSpec, spawnScript } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { loadWorkflow } from '../../../skills/implement-issue-tree/runner/lib/load-workflow.mjs'
import { loadConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'

const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-e2e-'))))
const RUN_ID = 'wf_0123abcd-4ef'
const shape = ({ opts }) => ({ label: opts.label, model: opts.model ?? null, effort: opts.effort ?? null, phase: opts.phase ?? null, isolation: opts.isolation ?? null })
const sortKey = (c) => JSON.stringify(c)
// src のプロンプトはスクリプトハッシュの目印のままなので parseExecSpec は 'bad' になる。どちらの側も「仕様行がある」で分ける
const isSpec = (c) => parseExecSpec(c.prompt).kind !== 'none'

// 偽の launcher: 受けた引数（NUL 区切り）・標準入力・cwd を書き出し、テストが用意した出力と終了コードを返す。
// 出力ファイルの場所は呼び出しごとに環境変数で渡す（エージェントの入力ではなく、テストの spawnScript の包みが決める）
const FAKE_LAUNCHER = `#!/bin/bash
set -u
for a in "$@"; do printf '%s\\0' "$a"; done > "$FAKE_RV.argv"
cat > "$FAKE_RV.stdin"
pwd -P > "$FAKE_RV.cwd"
cat "$FAKE_RV.out"
exit "$(cat "$FAKE_RV.code")"
`

/** 既定応答と ret から、偽の launcher の標準出力と終了コードを作る。 */
function launcherOutput(ret, reply) {
  if (ret === 'exit-ok') return { out: '', code: reply?.ok === true ? 0 : 1 }
  if (reply === null || reply === undefined) return { out: '', code: 1 }
  if (ret === 'envelope') return { out: `${JSON.stringify(reply)}\n`, code: 0 }
  return { out: `${ret.slice('line:'.length)} ${JSON.stringify(reply)}\n`, code: 0 }
}

let caseSeq = 0
async function runThroughRunner({ args, leaves }) {
  const dir = join(root, `case-${++caseSeq}`)
  const mainRoot = join(dir, 'main')
  const skillDir = join(dir, 'skill')
  const io = join(dir, 'io')
  const runDir = join(mainRoot, '_', 'iit-runner', RUN_ID)
  for (const d of [mainRoot, join(skillDir, 'scripts'), io]) mkdirSync(d, { recursive: true })
  writeFileSync(join(skillDir, 'scripts', 'run-verified.sh'), FAKE_LAUNCHER)
  chmodSync(join(skillDir, 'scripts', 'run-verified.sh'), 0o755)

  const workflow = loadWorkflow()
  const nodes = buildTree(leaves)
  const defaults = makeDefaultReply({ args, nodes })
  const mod = makeFakeAdapterModule({ defaults: { args, nodes } })
  const worktrees = []
  const launches = []
  const host = createAgentHost({
    adapter: mod.createAdapter({}),
    cfg: {
      config: loadConfig(),
      skillDir,
      mainRoot,
      runId: RUN_ID,
      runDir,
      args,
      maxParallel: args.parallel,
      // git に触れない worktree（通し番号の確認だけ）
      createWorktree: ({ mainRoot: m, runId, n }) => {
        worktrees.push(n)
        return { path: `${m}/.claude/worktrees/${runId}-${n}` }
      },
      // 実物の spawnScript で偽の launcher を起動する。出力は既定応答表から作る
      spawnScript: (file, argv, opts, ctx) => {
        const base = join(io, String(launches.length + 1))
        const { out, code } = launcherOutput(ctx.spec.ret, defaults(ctx.prompt, { label: ctx.label }))
        writeFileSync(`${base}.out`, out)
        writeFileSync(`${base}.code`, String(code))
        launches.push({ base, file, argv, cwd: opts.cwd, label: ctx.label, spec: ctx.spec })
        return spawnScript(file, argv, { ...opts, env: { ...process.env, FAKE_RV: base } })
      },
    },
  })
  const calls = []
  const agent = (prompt, opts) => {
    calls.push({ prompt, opts })
    return host(prompt, opts)
  }
  const result = await workflow.run(structuredClone(args), agent, () => {}, () => {})
  return { result, calls, adapterCalls: mod.calls, worktrees, launches, stats: host.stats, mainRoot, skillDir, runDir }
}

const CASES = [
  { name: '葉 1 件・parallel 1', args: { ...BASE_ARGS }, leaves: [2], ordered: true, count: 30, specCount: 12 },
  { name: '葉 2 件・parallel 2', args: { ...BASE_ARGS, parallel: 2 }, leaves: [2, 3], ordered: false, count: 43, specCount: 18 },
  { name: 'dryRun・葉 2 件', args: { ...BASE_ARGS, dryRun: true }, leaves: [2, 3], ordered: true, count: 8, specCount: 2 },
]

test('生成物は実行仕様の行を持つ（仕様の段の直接実行を通しで確かめる前提）', () => {
  assert.equal(readFileSync(DIST_PATH, 'utf8').includes('<!-- iit-exec v1 '), true)
})

for (const c of CASES) {
  test(`通し（${c.name}）: 生成物 + ランナー + 偽アダプタ + 偽 launcher が src + stub-run と同じ呼び出し列（仕様の段を除く）・終端状態になる`, async () => {
    const ref = await runScript({ args: structuredClone(c.args), leaves: c.leaves, target: 'src' })
    const got = await runThroughRunner({ args: c.args, leaves: c.leaves })

    assert.deepEqual(got.result, ref.result, '終端状態（ホストの return 値）')
    const a = got.calls.filter((x) => !isSpec(x)).map(shape)
    const b = ref.calls.filter((x) => !isSpec(x)).map(shape)
    if (c.ordered) assert.deepEqual(a, b, '呼び出し列（仕様の段を除く・順序つき）')
    else assert.deepEqual(a.map(sortKey).sort(), b.map(sortKey).sort(), '呼び出し列（仕様の段を除く・多重集合）')
    // 空の比較で通らないよう、呼び出し数を固定する（既定応答表・生成物が変わったら更新する）
    assert.equal(got.calls.length, c.count)
    assert.equal(got.calls.length, ref.calls.length)
    if (c.args.dryRun) assert.equal(typeof got.result.startable?.count, 'number', 'dryRun は見積りを返す')
    else assert.equal(got.result.dryRun, undefined)

    // 仕様の段: アダプタへ回らず、偽の launcher で直接実行され、許可表で拒否されていない
    const specCalls = got.calls.filter(isSpec)
    assert.equal(specCalls.length, c.specCount)
    assert.deepEqual(specCalls.filter((x) => parseExecSpec(x.prompt).kind !== 'spec').map((x) => x.opts.label), [], '生成物の仕様行は読める')
    assert.deepEqual(specCalls.map((x) => x.opts.label).sort(), ref.calls.filter(isSpec).map((x) => x.opts.label).sort(), '仕様の段の label')
    const specLabels = new Set(specCalls.map((x) => x.opts.label))
    assert.equal(got.adapterCalls.filter((r) => specLabels.has(r.label)).length, 0, '仕様の段がアダプタへ回った')
    assert.equal(got.launches.length, specCalls.length, '仕様の段ごとに launcher を 1 回起動する')
    for (const l of got.launches) {
      assert.equal(l.file, 'bash')
      assert.equal(l.argv[0], join(got.skillDir, 'scripts', 'run-verified.sh'))
      const want = l.spec.script === 'run-verified.sh' ? l.spec.argv : [l.spec.sha256, l.spec.script, ...l.spec.argv]
      assert.deepEqual(readFileSync(`${l.base}.argv`, 'utf8').split('\0').slice(0, -1), want, `${l.label}: launcher の引数`)
      assert.equal(readFileSync(`${l.base}.cwd`, 'utf8').trim(), got.mainRoot, `${l.label}: cwd はメイン worktree`)
      assert.equal(readFileSync(`${l.base}.stdin`, 'utf8'), l.spec.stdinHex === undefined ? '' : Buffer.from(l.spec.stdinHex, 'hex').toString('utf8'), `${l.label}: 標準入力`)
    }
    const metas = readdirSync(join(got.runDir, 'agents')).map((d) => JSON.parse(readFileSync(join(got.runDir, 'agents', d, 'meta.json'), 'utf8')))
    assert.equal(metas.length, got.calls.length, 'agent() 1 回につき meta.json 1 つ')
    const specMetas = metas.filter((x) => x.outcome === 'exec-spec')
    assert.equal(specMetas.length, specCalls.length)
    assert.deepEqual([...new Set(specMetas.map((x) => x.status))], ['exec-ok'], '仕様の段はすべて exec-ok（拒否・失敗値に倒れていない）')

    // 仕様の段以外は、すべてアダプタの初回ターンになる（修復ターンは不適合な既定応答の分だけ増える）
    const firstTurns = got.adapterCalls.filter((r) => r.resume === null)
    assert.equal(firstTurns.length, got.calls.length - specCalls.length)
    assert.deepEqual(firstTurns.map((r) => r.label).sort(), got.calls.filter((x) => !isSpec(x)).map((x) => x.opts.label).sort())
    // isolation: 'worktree' の呼び出しだけ worktree を作り、その呼び出しの通し番号を使う
    assert.equal(got.worktrees.length, got.calls.filter((x) => x.opts.isolation === 'worktree').length)
    for (const r of got.adapterCalls) {
      if (r.cwd !== got.mainRoot) assert.ok(r.cwd.startsWith(`${got.mainRoot}/.claude/worktrees/${RUN_ID}-`), r.cwd)
    }
    assert.equal(got.stats.calls, got.calls.length)
    assert.ok(got.stats.maxActive <= c.args.parallel, `同時実行 ${got.stats.maxActive}`)
  })
}

// ランナーの実行仕様の許可表（runner/lib/agent-host.mjs の EXEC_RULES）と、生成物が実際に出す実行仕様の突き合わせ。
//
// 縛るもの: 生成物・src が出す仕様行（プロンプト 0 行目の <!-- iit-exec v1 … -->）はすべて
//   1. parseExecSpec で読める（kind: 'spec'。壊れた仕様 'bad' が 1 件も無い）
//   2. checkExecRule で許可表に合う（label・script・mode・ret・fail のどれも食い違わない）
// 許可表に合わない仕様は、ランナーでは実行されず fail が返る（契約の決定・fail-closed）。生成物の変更で許可表とずれると
// その段が黙って失敗値に倒れ続けるため、ここで 1 件でも合わなければ失敗させる。
//
// 集め方は 2 層:
//   層 1（生成物）: 配布する生成物（scripts/implement-issue-tree.js）を stub-run の target: 'dist' で複数の args で最後まで
//     流し、出てきた全プロンプトを調べる。
//   層 2（src の関数）: 層 1 の流れでは到達しない段（closed の後始末・掃除・回復・高水位・マージ前の観測ゲート）は、
//     src の定義部を importDefinitions で読み、実際の label を付ける関数そのものを呼んで集める（生成物は src と α 同値で、
//     build-workflow.mjs --check がその同値を縛る）。
// 最後に、許可表の全行がどちらかの層で 1 回以上当たったことを確かめる（当たらない行は、生成物が出さない仕様を
// 許している = 表が古いか、ここで集め損ねている）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { BASE_ARGS, importDefinitions, runScript } from './lib/stub-run.mjs'
import { SCRIPT_HASH_PLACEHOLDER_RE, bundleSha256 } from '../scripts/build-workflow.mjs'
import { EXEC_RULES, checkExecRule, parseExecSpec } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'

// 層 1 の args。仕様の段（状態・予検査・外部チェック検出・対象外ラベル・残置の測定）に届く組み合わせ
const FLOWS = [
  { name: '葉 1 件', args: {}, leaves: [2] },
  { name: '葉 2 件・parallel 2', args: { parallel: 2 }, leaves: [2, 3] },
  { name: 'dryRun', args: { dryRun: true }, leaves: [2, 3] },
  { name: '対象外ラベル・残置の上限あり', args: { skipLabels: ['wip'], maxResidualWorktrees: 5, maxResidualWorktreeBytes: 1_000_000_000 }, leaves: [2] },
]

// src のプロンプトはスクリプトハッシュの目印（@@SCRIPT_SHA256:<名前>@@）のままなので、ビルダーと同じ値に置き換えてから読む
const SCRIPTS_DIR = fileURLToPath(new URL('../../../skills/implement-issue-tree/scripts', import.meta.url))
const embedHashes = (prompt) => prompt.replace(SCRIPT_HASH_PLACEHOLDER_RE, (_m, name) => bundleSha256(SCRIPTS_DIR, name))

/** 呼び出しの列から仕様行を持つものを取り出す。'bad' は label つきで返し、呼び出し側で失敗にする。 */
function collect(calls, source) {
  const out = []
  for (const c of calls) {
    const p = parseExecSpec(source.startsWith('src:') ? embedHashes(c.prompt) : c.prompt)
    if (p.kind === 'none') continue
    out.push({ source, label: c.opts.label, parsed: p })
  }
  return out
}

// 層 2 の関数を呼ぶための globals（src の定義部は args・agent・log をグローバルとして読む）
const calls = []
globalThis.args = { ...BASE_ARGS, repo: 'o/r' }
globalThis.mainWorktreePath = '/repo/main'
globalThis.log = () => {}
// 既定はどの段にも null（失敗）を返す。再試行・モデル切り替えの接尾辞（:retry・-retry・:fallback-<model>）の label も出させる
let reply = (_prompt, opts) => (opts.label === 'nonce:seed' ? { seedHex: '0'.repeat(64) } : null)
globalThis.agent = async (prompt, opts) => {
  calls.push({ prompt, opts })
  return reply(prompt, opts)
}

const m = await importDefinitions(
  ['ensureBoundaryNonceSeed', 'releaseTreeDir', 'freeHeldBranch', 'confirmWorktreeAbsent', 'sweepClosedWorktrees', 'cleanupClosedMergedWorktree',
    'updateStateDetailed', 'persistPerWorktreeByteReserveHighWater', 'setPerWorktreeByteReserveHighWater',
    'observeAddedFileCollisions', 'observePolicyPaths', 'observeOptinRecord'],
  'runner-exec-rules',
)
await m.ensureBoundaryNonceSeed()

// 層 2 の段。どれも実際の呼び出し元と同じ関数で label を作る
const SRC_STAGES = [
  ['plan:issue-tree-release', () => m.releaseTreeDir('/tmp/iit-tree.abc')],
  ['free:#N', () => m.freeHeldBranch({ number: 2 }, 'feat/2-x')],
  ['worktree:absent', () => m.confirmWorktreeAbsent(2, '/repo/wt/old')],
  ['worktree:sweep', () => m.sweepClosedWorktrees(['/repo/wt/a', '/repo/wt/b'])],
  ['state:cleanup（closed の後始末）', async () => {
    const bind = { state: 'MERGED', headRefOid: 'c'.repeat(40), headRefName: 'feat/2-x', baseRefName: 'main', isCrossRepository: false, closingIssues: [2] }
    const prev = reply
    reply = (p, o) => (o.label.startsWith('pr-bind:') ? bind : prev(p, o))
    try { await m.cleanupClosedMergedWorktree({ number: 2, title: 't' }, { pr: 77, worktree: '/repo/wt/old', branch: 'feat/2-x' }) } finally { reply = prev }
  }],
  ['state:cleanup（使い捨て worktree の掃除）', async () => {
    // 掃除は状態の書き込みが成功した後にだけ走る
    const prev = reply
    reply = (p, o) => (o.label === 'nonce:seed' ? prev(p, o) : { ok: true, retained: false })
    try { await m.updateStateDetailed(2, { status: 'blocked' }, { cleanupWorktree: '/repo/wt/tmp', preserveWorktreeField: true, cleanupMode: 'discard' }) } finally { reply = prev }
  }],
  ['state:high-water', () => m.persistPerWorktreeByteReserveHighWater(5)],
  ['state:high-water-set', () => m.setPerWorktreeByteReserveHighWater(5)],
  ['merge:added-files', () => m.observeAddedFileCollisions({ number: 2 }, 7, [3, 4])],
  ['merge:policy-paths', () => m.observePolicyPaths({ number: 2 }, 7)],
  ['optin-record-verify / reverify', async () => {
    // 1 回目（verify）が合格のときだけ 2 回目（reverify）が走る。封筒の照合はここでは通らないため、
    // reverify の label は 1 回目を合格にした呼び出しで別に作る（下の test で確かめる）
    await m.observeOptinRecord({ number: 2 }, { prNumber: 7 }, ['npm test'])
  }],
]

let flowSpecs = []
let srcSpecs = []

test('層 1: 生成物を複数の args で流し、出てきた仕様行がすべて読め、許可表に合う', async () => {
  for (const f of FLOWS) {
    const { calls: ran } = await runScript({ args: { ...BASE_ARGS, ...f.args }, leaves: f.leaves, target: 'dist' })
    flowSpecs.push(...collect(ran, `dist:${f.name}`))
  }
  const bad = flowSpecs.filter((s) => s.parsed.kind === 'bad').map((s) => `${s.source} ${s.label}: ${s.parsed.reason}`)
  assert.deepEqual(bad, [], '壊れた仕様行')
  const refused = flowSpecs.map((s) => ({ s, r: checkExecRule(s.label, s.parsed.spec) })).filter((x) => !x.r.ok).map((x) => `${x.s.source} ${x.s.label}: ${x.r.reason}`)
  assert.deepEqual(refused, [], '許可表に合わない仕様')
  // 空の集合で通らないよう件数を固定する（生成物・既定応答表が変わったら数え直す）
  assert.equal(flowSpecs.length, 44)
})

test('層 2: 流れで届かない段を src の関数で作り、仕様行がすべて読め、許可表に合う', async () => {
  for (const [name, run] of SRC_STAGES) {
    calls.length = 0
    try { await run() } catch { /* 失敗応答で例外になる段もある。集めるのはプロンプトだけ */ }
    const got = collect(calls, `src:${name}`)
    assert.ok(got.length >= 1, `${name}: 仕様行を持つ呼び出しが無い`)
    srcSpecs.push(...got)
  }
  // optin-record の 2 回目（reverify）: 1 回目の観測を合格にして 2 回目を走らせる代わりに、同じ関数の label の作り方
  // （optin-record-${k}:#N）どおりの 2 つの label で 1 回目の仕様を照らす（仕様の中身は k に依らない）
  const verify = srcSpecs.find((s) => /^optin-record-verify:#\d+/.test(s.label))
  assert.ok(verify, 'optin-record-verify の仕様が無い')
  srcSpecs.push({ ...verify, source: 'src:optin-record-reverify', label: verify.label.replace('verify', 'reverify') })
  // 件数の固定（失敗応答による再試行・モデル切り替えの label を含む。src の関数が変わったら数え直す）
  assert.equal(srcSpecs.length, 20)

  const bad = srcSpecs.filter((s) => s.parsed.kind === 'bad').map((s) => `${s.source} ${s.label}: ${s.parsed.reason}`)
  assert.deepEqual(bad, [], '壊れた仕様行')
  const refused = srcSpecs.map((s) => ({ s, r: checkExecRule(s.label, s.parsed.spec) })).filter((x) => !x.r.ok).map((x) => `${x.s.source} ${x.s.label}: ${x.r.reason}`)
  assert.deepEqual(refused, [], '許可表に合わない仕様')
})

test('許可表の全行が、層 1 か層 2 のどちらかで 1 回以上当たる（生成物が出さない仕様を許していない）', (t) => {
  const all = [...flowSpecs, ...srcSpecs]
  assert.ok(all.length > 0, '層 1・層 2 が先に走っていない')
  const miss = EXEC_RULES.filter((r) => !all.some((s) => r.re.test(s.label))).map((r) => r.re.source)
  assert.deepEqual(miss, [])
  // どの行がどちらの層で当たったか（生成物の流れで当たらない行は src の関数でしか確かめていない）
  for (const r of EXEC_RULES) {
    const hits = (xs) => xs.filter((s) => r.re.test(s.label)).length
    t.diagnostic(`${r.re.source.replace(/\(\?::fallback.*$/, '')}: 生成物 ${hits(flowSpecs)} 件・src ${hits(srcSpecs)} 件`)
  }
  t.diagnostic(`合計: 生成物 ${flowSpecs.length} 件・src ${srcSpecs.length} 件・許可表 ${EXEC_RULES.length} 行`)
})

test('許可表と食い違う仕様（script・mode・ret・fail の 1 つ違い・表に無い label）は合格にならない', () => {
  const base = flowSpecs.find((s) => s.label === 'state:load-verify')?.parsed.spec
  assert.ok(base, 'state:load-verify の仕様が無い')
  assert.equal(checkExecRule('state:load-verify', base).ok, true)
  for (const [why, spec, label] of [
    ['script', { ...base, script: 'observe-pr.sh' }, 'state:load-verify'],
    ['mode', { ...base, argv: base.argv.map((a) => (a === 'verify' ? 'merge' : a)) }, 'state:load-verify'],
    ['ret', { ...base, ret: 'line:STATE_RESULT' }, 'state:load-verify'],
    ['fail', { ...base, fail: { ok: false } }, 'state:load-verify'],
    ['label', base, 'plan:#2'],
  ]) {
    const r = checkExecRule(label, spec)
    assert.equal(r.ok, false, why)
  }
})

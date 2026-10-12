// Issue #592: Workflow ランタイムは 1 ラン 1,000 エージェントで打ち切り、打ち切りは completed として返る。
// 予算を持たないと PR 作成直後の未監視のままランが終わる。是正後の契約を固定する:
//   1. 駆動部が agent を数える関数へ差し替え、全 agent() 呼び出し（リトライ・フォールバック含む）を数える。
//   2. 残り呼び出し数が「実行中 × 目安 + 候補の目安 + 終了処理の予備」を下回ったら新規着手を止め、
//      実行中の issue は完了まで進める。止めた分は未着手（not-started）として理由付きで返す。
//   3. 上限が十分大きければ従来どおり全件着手する。
//   4. 上限での打ち切りで監視に進めなかった PR を返却値 unmonitoredPrs とログに出す。
//   5. args.agentCallLimit は新規着手を止める判断に使う想定値で、呼び出し自体は止めない。下限（81）未満と
//      1000 超は受理しない。超過時は最初の 1 回だけ警告し、呼び出しは続行する。
//
// 検証の二層構造: 定義部をスライス import して純粋関数を直接実行（単体）し、実装スクリプト全体を
// Workflow ランタイムと同じ評価形態（AsyncFunction。agent は引数）で stub agent に対して実行する（結合）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripMetaExport } from './lib/workflow-script-contract.mjs'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'implement-issue-tree.src.js')
const DRIVER_MARKER = ['__IMPLEMENT', 'ISSUE', 'TREE', 'DRIVER', 'START__'].join('_')

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない`)
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)

globalThis.args = { parent: 1 }
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-agent-budget-'))
const slicePath = join(sliceDir, 'implement-issue-tree-agent-budget-defs.mjs')
// 旧実装（修正前）にはこれらの宣言が無い。RED 確認用に typeof ガードで存在しない名前を undefined にする。
const SLICE_EXPORTS = [
  'AGENT_RUN_LIMIT', 'AGENT_CALLS_START', 'AGENT_CALLS_PER_ISSUE', 'AGENT_CALLS_TERMINAL_BASE', 'BLOCKED_STATE_CHUNK_SIZE',
  'parseAgentCallLimit', 'wrapAgentCounting', 'agentBudgetHold', 'sha256Hex', 'canonicalJson',
  'declaredDepsChecksum', 'outOfTreeStateChecksum', 'stopReasons', 'stopNote',
]
const optionalExports = SLICE_EXPORTS.map((n) => `const __opt_${n} = typeof ${n} === 'undefined' ? undefined : ${n}`).join('\n')
const exportList = SLICE_EXPORTS.map((n) => `__opt_${n} as ${n}`).join(', ')
globalThis.agent = async () => null
globalThis.log = () => {}
writeFileSync(slicePath, `${definitionPart}\n${optionalExports}\nexport { ${exportList} }\n`)
const mod = await import(pathToFileURL(slicePath).href)
const {
  AGENT_RUN_LIMIT, AGENT_CALLS_START, AGENT_CALLS_PER_ISSUE, AGENT_CALLS_TERMINAL_BASE, BLOCKED_STATE_CHUNK_SIZE,
  parseAgentCallLimit, wrapAgentCounting, agentBudgetHold, declaredDepsChecksum, outOfTreeStateChecksum, sha256Hex, canonicalJson,
  stopReasons, stopNote,
} = mod

// ---------------------------------------------------------------------------
// 単体
// ---------------------------------------------------------------------------

test('単体: 既定はランタイムの 1,000 件で、agentCallLimit は下限（開始処理 + 終了処理の予備 + 1 issue の目安 + 1）〜1000 に限る', () => {
  assert.equal(AGENT_RUN_LIMIT, 1000)
  const min = AGENT_CALLS_START + AGENT_CALLS_TERMINAL_BASE + AGENT_CALLS_PER_ISSUE.implement + 1
  assert.equal(min, 81)
  assert.equal(parseAgentCallLimit(undefined), 1000)
  assert.equal(parseAgentCallLimit(null), 1000)
  assert.equal(parseAgentCallLimit(min), min)
  assert.equal(parseAgentCallLimit(1000), 1000)
  for (const bad of [1, 0, -1, min - 1, 1001, 1.5, '100', true, NaN]) {
    assert.throws(() => parseAgentCallLimit(bad), /agentCallLimit/, String(bad))
  }
  assert.throws(() => parseAgentCallLimit(1), /81〜1000/, 'エラーメッセージに範囲を示す')
})

test('単体: wrapAgentCounting は呼び出す前に数え、null 返却・例外・引数をそのまま通す', async () => {
  const budget = { used: 0 }
  const seen = []
  const wrapped = wrapAgentCounting(async (p, o) => {
    seen.push([p, o])
    if (o.label === 'boom') throw new Error('x')
    return o.label === 'nil' ? null : { ok: true }
  }, budget)
  assert.deepEqual(await wrapped('p1', { label: 'a' }), { ok: true })
  assert.equal(await wrapped('p2', { label: 'nil' }), null)
  await assert.rejects(() => wrapped('p3', { label: 'boom' }), /x/)
  assert.equal(budget.used, 3, 'null 返却・例外も起動した 1 件として数える')
  assert.deepEqual(seen.map((s) => s[0]), ['p1', 'p2', 'p3'])
})

test('単体: 上限を超えると警告を最初の 1 回だけ出し、呼び出しは止めない', async () => {
  const budget = { limit: 3, used: 0 }
  const warns = []
  const wrapped = wrapAgentCounting(async () => 'ran', budget, (m) => warns.push(m))
  for (let i = 0; i < 3; i++) assert.equal(await wrapped('p', {}), 'ran')
  assert.deepEqual(warns, [], '上限ちょうどまでは警告しない')
  for (let i = 0; i < 4; i++) assert.equal(await wrapped('p', {}), 'ran', '超過後も呼び出しは実行される')
  assert.equal(warns.length, 1, '警告は 1 回だけ')
  assert.match(warns[0], /想定上限 3/)
  assert.equal(budget.used, 7)
})

test('単体: agentBudgetHold の式は「実行中 × 目安 + 候補の目安 + 終了処理の予備」', () => {
  const impl = AGENT_CALLS_PER_ISSUE.implement
  const base = { limit: 1000, used: 0 }
  // 未完了 100 件以下なら chunks は 1
  const need = (running, kind) => impl * running + AGENT_CALLS_PER_ISSUE[kind] + AGENT_CALLS_TERMINAL_BASE + 1
  assert.equal(agentBudgetHold(base, { running: 0, kind: 'implement', pending: 10 }), null)
  const exact = need(5, 'implement')
  assert.equal(agentBudgetHold({ limit: 1000, used: 1000 - exact }, { running: 5, kind: 'implement', pending: 100 }), null, '残りがちょうど必要量なら通る')
  const held = agentBudgetHold({ limit: 1000, used: 1000 - exact + 1 }, { running: 5, kind: 'implement', pending: 100 })
  assert.deepEqual(held, { remaining: exact - 1, required: exact })
  // 実行中が減れば同じ使用量でも通る（非ラッチ）
  assert.equal(agentBudgetHold({ limit: 1000, used: 1000 - exact + 1 }, { running: 4, kind: 'implement', pending: 100 }), null)
  // 小さい種別（close / resume）は implement が通らない残りでも通り得る
  const tight = { limit: 1000, used: 1000 - need(0, 'close') }
  assert.equal(agentBudgetHold(tight, { running: 0, kind: 'close', pending: 100 }), null)
  assert.ok(agentBudgetHold(tight, { running: 0, kind: 'implement', pending: 100 }))
  // 未完了ノードが多いほど終了処理（blocked 一括記録の chunks）の予備が増える
  const many = agentBudgetHold({ limit: 1000, used: 0 }, { running: 0, kind: 'implement', pending: 1100 })
  assert.equal(many, null)
  const manyReq = agentBudgetHold({ limit: 1, used: 0, starts: 1 }, { running: 0, kind: 'implement', pending: 1100 }).required
  assert.equal(manyReq, impl + AGENT_CALLS_TERMINAL_BASE + Math.ceil(1100 / BLOCKED_STATE_CHUNK_SIZE))
})

test('単体: 生成元は agent() の呼び出し箇所を変えず、pipeline() も使わない（数え方が 1:1 で成り立つ前提）', () => {
  const dist = readFileSync(join(dirname(SCRIPT_PATH), 'implement-issue-tree.js'), 'utf8')
  assert.doesNotMatch(dist, /\bpipeline\(/, 'pipeline() が増えると agent() 呼び出し数とランタイムの数がずれる（コメント除去済みの生成物で検査）')
  assert.ok(driverPart.includes('agent = countedAgent'), '駆動部で agent を再束縛する')
  assert.ok(driverPart.includes('wrapAgentCounting(agent, agentBudget, log)'), '超過の警告をラン中のログへ出す')
  assert.ok(!definitionPart.includes('agent = countedAgent'), '定義部に置くとスライス import のテストが ReferenceError になる')
})

test('単体: 差し替えより前に agent() が呼ばれない（定義部にトップレベル await が無く、駆動部で差し替えが最初の await より前）', () => {
  assert.doesNotMatch(definitionPart, /^(await |(const|let|var) [^=\n]*= await |for await )/m, '定義部のトップレベルで agent() を呼ぶと数え漏れになる')
  const swap = driverPart.indexOf('agent = countedAgent')
  assert.ok(swap > 0)
  assert.ok(!/\bawait\b/.test(driverPart.slice(0, swap).replace(/\/\/.*$/gm, '')), '差し替えより前の駆動部に await が無い')
  // extractDeclaredDeps（定義部の関数。レート制限時に待って再試行する）も呼び出し時に束縛を解決するため、差し替え後の呼び出しは数えられる
  assert.ok(driverPart.indexOf('extractDeclaredDeps(chunks') > swap)
})

// ---------------------------------------------------------------------------
// 結合
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const scriptBody = stripMetaExport(source)

function buildTree(leaves) {
  const nodes = [{ number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: leaves.length }]
  leaves.forEach((n, i) => nodes.push({ number: n, title: `issue ${n}`, state: 'open', parent: 1, siblingIndex: i, dependsOn: [], subIssuesTotal: 0 }))
  return nodes
}

// 1 issue が plan → impl → review → pr-create → PR 照合 → monitor まで進む stub。monitor は blocked(quality)
// で終端させる（マージまで進める必要はなく、1 issue あたり約 10 回のエージェント呼び出しになる）。
// cutoffAfter: ランタイムの打ち切りを模して、この回数を超えた agent() は null を返す。
// 保存済み状態（照合用のハッシュ付き）。monitoring 再開の候補を作るために使う。
function stateVerifyFor(items) {
  const keys = Object.keys(items).sort()
  return {
    fileExists: true,
    hashes: Object.fromEntries(keys.map((k) => [k, sha256Hex(canonicalJson(items[k]))])),
    keysSha256: sha256Hex(canonicalJson(keys)),
    keysCount: keys.length,
    highWaterBytes: 0,
    highWaterVersion: 0,
  }
}
async function runScript({ args, leaves, cutoffAfter = Infinity, override = () => undefined, constAgent = false, saved = null, tree = null }) {
  const nodes = tree ?? buildTree(leaves)
  const calls = []
  const logs = []
  const inFlight = new Set()
  let peak = 0
  const handler = (prompt, opts) => {
    const label = opts.label
    const overridden = override(label, opts, prompt)
    if (overridden !== undefined) return overridden
    const n = Number(/#(\d+)/.exec(label)?.[1])
    if (label === 'nonce:seed') return { seedHex: 'b'.repeat(64) }
    if (label === 'worktree:untracked-scan') return { count: 0, paths: [] }
    if (label === 'state:load') return { ok: true, fileExisted: saved !== null, items: saved ?? {}, highWaterBytes: 0, highWaterVersion: saved ? 2 : 0 }
    if (label === 'state:load-verify') return saved === null ? { fileExists: false, hashes: {}, keysSha256: '', keysCount: 0, highWaterBytes: 0, highWaterVersion: 0 } : { ...stateVerifyFor(saved), highWaterVersion: 2 }
    if (label === 'plan:issue-tree') return { nodes: structuredClone(nodes) }
    if (label === 'detect:external-checks') return { apps: [] }
    if (label.startsWith('plan:declared-deps')) {
      const m = /for n in ([0-9 ]+); do/.exec(prompt)
      return { entries: m[1].trim().split(' ').map(Number).map((x) => ({ number: x, deps: [], sig: declaredDepsChecksum(x, []) })) }
    }
    if (label.startsWith('plan:root-ancestors')) return { fetched: true, chain: [{ number: args.parent, parent: 0 }] }
    if (label.startsWith('plan:out-of-tree-deps')) {
      const m = /for n in ([0-9 ]+); do/.exec(prompt)
      return { entries: m[1].trim().split(' ').map(Number).map((x) => ({ number: x, state: 'OPEN', sig: outOfTreeStateChecksum(x, 'OPEN') })) }
    }
    if (label === 'worktree:orphan-scan') return { entries: [{ path: '/repo', branch: 'main', isMain: true }] }
    if (label === 'worktree:record-count') return { count: 1 }
    if (label.startsWith('plan:#')) { inFlight.add(n); peak = Math.max(peak, inFlight.size); return { plan: 'p', summary: 's' } }
    if (label.startsWith('impl:#')) return { branch: `feat/${n}-x`, summary: 's', worktreePath: `/repo/wt/${n}` }
    if (label.startsWith('review:#')) return { state: 'ok', highestSeverity: 'none', summary: 's', worktreePath: `/repo/wt/r${n}` }
    if (label.startsWith('pr-create:#')) return { prNumber: 1000 + n, summary: 's', worktreePath: `/repo/wt/p${n}`, checksStarted: true, mergeableAfterPush: 'MERGEABLE' }
    if (label.startsWith('pr-bind:#')) return { state: 'OPEN', headRefOid: 'a'.repeat(40), headRefName: `feat/${n}-x`, baseRefName: 'main', isCrossRepository: false, closingIssues: [n] }
    if (label.startsWith('merge:#')) { inFlight.delete(n); return { state: 'blocked', blockedReason: 'quality', summary: '監視中断', unresolvedComments: [] } }
    if (label.startsWith('state:')) return { ok: true }
    return null
  }
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    await Promise.resolve()
    if (calls.length > cutoffAfter) return null
    return handler(prompt, opts)
  }
  // constAgent: agent を再束縛できない実行環境（const 宣言）を模す。差し替えは TypeError になり enforced: false へ倒れる。
  const fn = constAgent
    ? new AsyncFunction('args', '__agent', 'log', 'phase', `const agent = __agent\n${scriptBody}`)
    : new AsyncFunction('args', 'agent', 'log', 'phase', scriptBody)
  const result = await fn(args, agent, (m) => { logs.push(m) }, () => {})
  return { result, calls, logs, peak }
}

const BASE_ARGS = { parent: 1, parallel: 1, maxResidualWorktrees: 0, maxResidualWorktreeBytes: 0 }
const LEAVES = [2, 3, 4, 5, 6, 7, 8, 9]

test('結合: 上限が十分大きければ従来どおり全件に着手し、予算による停止は起きない', async () => {
  const { result, calls } = await runScript({ args: BASE_ARGS, leaves: LEAVES })
  const planned = calls.filter((c) => c.opts.label.startsWith('plan:#')).map((c) => c.opts.label)
  assert.equal(planned.length, LEAVES.length, `全 ${LEAVES.length} 件が着手される: ${planned.join(',')}`)
  assert.equal(result.agentBudget.limit, 1000)
  assert.equal(result.agentBudget.enforced, true)
  assert.equal(result.agentBudget.stoppedDispatchAt, null)
  assert.equal(result.agentBudget.reached, false)
  assert.equal(result.agentBudget.used, calls.length, '返却値の used は stub が観測した起動数と一致する（数え方の 1:1）')
  assert.equal(result.notStarted.length, 0)
})

test('結合: 上限を小さくすると新規着手が止まり、着手済みの issue は完了まで進み、残りは理由付きの未着手になる', async () => {
  const { result, calls, logs } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 120 }, leaves: LEAVES })
  const planned = calls.filter((c) => c.opts.label.startsWith('plan:#')).map((c) => Number(c.opts.label.slice(6)))
  const prCreated = calls.filter((c) => c.opts.label.startsWith('pr-create:#')).map((c) => Number(c.opts.label.slice(11)))
  assert.ok(planned.length >= 1 && planned.length < LEAVES.length, `一部だけ着手される: ${planned}`)
  assert.deepEqual(prCreated, planned, '着手した issue はすべて PR 作成まで進む（途中で止めない）')
  const monitored = calls.filter((c) => /^merge:#\d+$/.test(c.opts.label)).map((c) => Number(c.opts.label.slice(7)))
  assert.deepEqual(monitored, planned, '着手した issue はすべて監視まで進む')
  assert.deepEqual(result.unmonitoredPrs, [], '打ち切りではないので未監視の PR は無い')
  assert.equal(result.notStarted.length, LEAVES.length - planned.length + 1, '未着手 = 着手しなかった葉 + 子が終わらないため verify-close に進めない親 #1')
  assert.ok(result.agentBudget.stoppedDispatchAt !== null && result.agentBudget.stoppedDispatchAt <= 120)
  assert.equal(result.agentBudget.reached, false, '上限に達する前に止める')
  assert.ok(result.agentBudget.used <= 120, `使用 ${result.agentBudget.used} が上限 120 以内`)
  const notStartedEntries = result.done.filter((d) => d.status === 'not-started' && d.issue !== 1)
  assert.equal(notStartedEntries.length, LEAVES.length - planned.length)
  assert.ok(notStartedEntries.every((d) => d.note.includes('エージェント呼び出し数の予算不足')), '未着手の理由が予算不足と分かる')
  assert.ok(logs.some((l) => l.includes('新規着手を停止する') && l.includes('120')), '停止をログに出す')
  // 状態の一括記録（blocked）に予備を回せている: 打ち切られていれば最後の記録が欠ける
  assert.equal(result.blockedStateWrite.unwritten, 0)
})

test('結合: parallel の既存挙動を維持する（同時に実行中の issue は parallel 件まで。予算が十分なら全件着手）', async () => {
  const { result, peak, calls } = await runScript({ args: { ...BASE_ARGS, parallel: 3 }, leaves: LEAVES })
  assert.equal(result.parallel, 3)
  assert.equal(peak, 3, '3 件が同時に実行中になり、それを超えない')
  assert.equal(calls.filter((c) => c.opts.label.startsWith('plan:#')).length, LEAVES.length)
  assert.equal(result.agentBudget.stoppedDispatchAt, null)
})

test('結合: parallel 3 でも小さい上限では着手を絞り、実行中の分は完了させる', async () => {
  const { result, calls, peak } = await runScript({ args: { ...BASE_ARGS, parallel: 3, agentCallLimit: 130 }, leaves: LEAVES })
  const planned = calls.filter((c) => c.opts.label.startsWith('plan:#')).length
  const monitored = calls.filter((c) => /^merge:#\d+$/.test(c.opts.label)).length
  assert.ok(planned >= 3 && planned < LEAVES.length, `最初は 3 件並列で着手し、その後は絞られる: ${planned}`)
  assert.equal(monitored, planned, '着手した分はすべて監視まで進む')
  assert.ok(result.agentBudget.used <= 130 && !result.agentBudget.reached)
  assert.equal(peak, 3)
  assert.deepEqual(result.unmonitoredPrs, [])
})

test('結合: 上限で打ち切られ PR 作成後に監視へ進めなかった場合、未監視の PR 一覧が返却値とログに出る', async () => {
  // 1 つ目の issue が pr-create を返した直後に打ち切る: pr-create の呼び出し位置を先に測る。
  const probe = await runScript({ args: BASE_ARGS, leaves: [2] })
  const prCreateIndex = probe.calls.findIndex((c) => c.opts.label === 'pr-create:#2')
  assert.ok(prCreateIndex > 0)
  // 見積りが外れて予算ゲートをすり抜けた場合（実行中の issue が目安を超えて呼び出した場合）の打ち切りを模す。
  const { result, logs } = await runScript({ args: BASE_ARGS, leaves: [2], cutoffAfter: prCreateIndex + 1 })
  assert.deepEqual(result.unmonitoredPrs, [{ issue: 2, pr: 1002, resumable: false }], '状態の保存前に打ち切られた PR は再開できない')
  assert.ok(logs.some((l) => l.includes('未監視（状態ファイルに pr が無い／照合未了）') && l.includes('#2→PR #1002') && l.includes('手動確認')), '再開できない旨の案内を終了ログに出す')
  assert.ok(!logs.some((l) => l.includes('pr 保存済み')), '再開できる案内は出さない')
  assert.ok(logs.some((l) => l.includes('エージェント呼び出し数:')))
})

test('結合: 監視まで進んだ PR は未監視に載らない', async () => {
  const { result } = await runScript({ args: BASE_ARGS, leaves: [2, 3] })
  assert.deepEqual(result.unmonitoredPrs, [])
})

test('結合: 状態保存・照合が済んだ PR は resumable: true で「再実行で monitor から再開」と案内し、未了の PR とは案内が分かれる', async () => {
  // #2: monitor の直前で打ち切り(pr 保存済み) / #3: PR 照合が不成立 / #4: pr-create 直後の状態保存が失敗
  const probe = await runScript({ args: BASE_ARGS, leaves: [2] })
  const mergeIndex = probe.calls.findIndex((c) => c.opts.label === 'merge:#2')
  const saved = await runScript({ args: BASE_ARGS, leaves: [2], cutoffAfter: mergeIndex })
  assert.deepEqual(saved.result.unmonitoredPrs, [{ issue: 2, pr: 1002, resumable: true }], 'pr の保存まで済んでいれば再開できる')
  assert.ok(saved.logs.some((l) => l.includes('状態ファイルに pr 保存済み') && l.includes('#2→PR #1002') && l.includes('再実行すると monitor から再開する')))
  assert.ok(!saved.logs.some((l) => l.includes('pr が無い／照合未了')))

  const unbound = await runScript({
    args: BASE_ARGS,
    leaves: [3],
    override: (label) => (label.startsWith('pr-bind:#') ? { state: 'OPEN', headRefOid: 'a'.repeat(40), headRefName: 'other/branch', baseRefName: 'main', isCrossRepository: false, closingIssues: [] } : undefined),
  })
  assert.deepEqual(unbound.result.unmonitoredPrs, [{ issue: 3, pr: 1003, resumable: false }], '照合不成立の PR は再開できない')
  assert.ok(unbound.logs.some((l) => l.includes('pr が無い／照合未了') && l.includes('#3→PR #1003')))
  assert.ok(!unbound.logs.some((l) => l.includes('pr 保存済み')))

  let prCreated = false
  const unsaved = await runScript({
    args: BASE_ARGS,
    leaves: [4],
    override: (label) => {
      if (label.startsWith('pr-create:#')) { prCreated = true; return undefined }
      return prCreated && label.startsWith('state:update:#') ? { ok: false } : undefined
    },
  })
  assert.deepEqual(unsaved.result.unmonitoredPrs, [{ issue: 4, pr: 1004, resumable: false }], '保存に失敗した PR は再開できない')
  assert.ok(unsaved.logs.some((l) => l.includes('pr が無い／照合未了') && l.includes('#4→PR #1004')))
})

test('結合: monitoring 保存が失敗しても blocked の退避保存で pr を書けたら resumable: true、退避も失敗なら false のまま', async () => {
  // monitoring 遷移（status: monitoring）の書き込みだけを失敗させ、退避の blocked + pr 保存の成否を切り替える。
  // 次回ランの isActiveMonitoring は status が monitoring / blocked かつ pr > 0 かつ branch が issue の命名で再開する。
  const run = (fallbackOk) => {
    let prCreated = false
    return runScript({
      args: BASE_ARGS,
      leaves: [2],
      override: (label, _opts, prompt) => {
        if (label.startsWith('pr-create:#')) { prCreated = true; return undefined }
        if (!prCreated || !label.startsWith('state:update:#')) return undefined
        if (prompt.includes('"status":"monitoring"')) return { ok: false }
        if (prompt.includes('"pr":1002') && prompt.includes('"status":"blocked"')) return fallbackOk ? undefined : { ok: false }
        return undefined
      },
    })
  }
  const saved = await run(true)
  assert.deepEqual(saved.result.unmonitoredPrs, [{ issue: 2, pr: 1002, resumable: true }], '退避保存で pr を書けたので次回は再開できる')
  assert.ok(saved.logs.some((l) => l.includes('状態ファイルに pr 保存済み') && l.includes('#2→PR #1002')))
  assert.ok(!saved.logs.some((l) => l.includes('pr が無い／照合未了')))
  assert.ok(saved.logs.some((l) => l.includes('monitoring 遷移') || l.includes('マージ監視へ進まず停止')), '前提: monitoring 保存の失敗経路を通っている')

  const unsaved = await run(false)
  assert.deepEqual(unsaved.result.unmonitoredPrs, [{ issue: 2, pr: 1002, resumable: false }], '退避保存も失敗なら再開できない')
  assert.ok(unsaved.logs.some((l) => l.includes('pr が無い／照合未了') && l.includes('#2→PR #1002')))
  assert.ok(!unsaved.logs.some((l) => l.includes('pr 保存済み')))
})

test('結合: agent を再束縛できない（enforced: false）ときは予算ゲートを適用せず、上限が小さくても全件に着手する', async () => {
  const { result, calls, logs } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 81 }, leaves: LEAVES, constAgent: true })
  assert.equal(result.agentBudget.enforced, false)
  assert.equal(result.agentBudget.used, 0, '数えられていない')
  assert.equal(result.agentBudget.stoppedDispatchAt, null)
  assert.equal(calls.filter((c) => c.opts.label.startsWith('plan:#')).length, LEAVES.length, '全件着手される')
  assert.equal(result.notStarted.length, 0)
  assert.ok(logs.some((l) => l.includes('予算ゲートは無効')))
})

test('単体: 最初の 1 件は blocked 一括記録の chunks 分を課されず、2 件目以降は課される（未完了が多くても前進できる）', () => {
  const budget = { limit: 81, used: 20, starts: 0 }
  const first = agentBudgetHold(budget, { running: 0, kind: 'implement', pending: 3101 })
  assert.equal(first, null, '実行中 0・未着手の最初の 1 件は chunks 32 を課さず着手できる（30 + 20 = 50 <= 残り 61）')
  const second = agentBudgetHold({ ...budget, starts: 1 }, { running: 0, kind: 'implement', pending: 3101 })
  assert.deepEqual(second, { remaining: 61, required: 30 + 20 + 32 }, '1 件着手した後は chunks 分を課す')
  assert.ok(agentBudgetHold({ ...budget, used: 40 }, { running: 0, kind: 'implement', pending: 3101 }), '残りが最初の 1 件の目安にも足りなければ止める')
})

test('結合: 未完了ノードが多く limit が下限に近いときも、最初の 1 件は着手して完了まで進め、残りは未着手になる', async () => {
  const many = Array.from({ length: 400 }, (_, i) => 2 + i)
  const { result, calls } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 81 }, leaves: many })
  const planned = calls.filter((c) => c.opts.label.startsWith('plan:#')).length
  const monitored = calls.filter((c) => /^merge:#\d+$/.test(c.opts.label)).length
  assert.equal(planned, 1, `前進保証で 1 件だけ着手する: ${planned}`)
  assert.equal(monitored, 1, '着手した 1 件は監視まで進む')
  assert.equal(result.notStarted.length, many.length - 1 + 1, '残りの葉と親 #1 は未着手')
  assert.ok(result.agentBudget.stoppedDispatchAt !== null)
})

// ---------------------------------------------------------------------------
// Bugbot 指摘の是正（Issue #592 の followup）
// ---------------------------------------------------------------------------

// agentCallLimit を掃引して、予算ゲートが実際に効いた（新規着手停止のログが出た）ランだけを検査対象にする。
// 単一の limit を決め打ちすると、開始処理の呼び出し数が変わっただけで検査が空振りするため。
async function sweepLimits(limits, makeRun) {
  const hit = []
  for (const limit of limits) {
    const run = await makeRun(limit)
    if (run.logs.some((l) => l.includes('新規着手を停止する'))) hit.push({ limit, ...run })
  }
  return hit
}
const EXTRA_WORKTREES = [
  { path: '/repo', branch: 'main', isMain: true },
  { path: '/repo/wt/x1', branch: 'misc/a', isMain: false },
  { path: '/repo/wt/x2', branch: 'misc/b', isMain: false },
]
const MANY = Array.from({ length: 1000 }, (_, i) => 2 + i)

test('結合: 残置 worktree 上限の新規着手抑止があるとき、予算の not-started note で本当の理由を上書きしない (Bugbot A)', async () => {
  // 1,000 件のツリーは開始処理だけで約 52 回使う（依存宣言のチャンク分）ため、下限付近の limit では最初の候補から予算で止まる。
  const hit = await sweepLimits([81, 90, 100], (limit) => runScript({
    args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
    leaves: MANY,
    override: (label) => (label === 'worktree:orphan-scan' ? { entries: EXTRA_WORKTREES } : undefined),
  }))
  assert.ok(hit.length > 0, '予算ゲートが効いたランが 1 つ以上ある（検査が空振りしていない）')
  for (const { limit, result } of hit) {
    const notes = result.done.filter((d) => d.status === 'not-started').map((d) => d.note)
    assert.ok(notes.length > 0, `limit ${limit}: 未着手がある`)
    assert.ok(notes.every((t) => !t.includes('予算不足')), `limit ${limit}: 再実行しても解けない抑止を「同じ引数で再実行すると着手する」と案内しない: ${notes[0]}`)
    assert.ok(notes.every((t) => t.includes('残置 worktree 上限ゲート')), `limit ${limit}: 抑止の理由が残る`)
  }
})

// ---------------------------------------------------------------------------
// 予算枯渇は「ループ前」ではなく「ランの終了時点」で判定する（#596 の Bugbot 指摘 3 件）
// ---------------------------------------------------------------------------
// ループ前の検査は、ループ中にしか分からない着手可否（monitoring 再開の worktree ゲート、ラン中に ready に
// なる前提解消後のノード）を断定して throw していた。終了時に「このランで 1 件も着手せず（starts === 0）、
// 予算だけが理由の保留ノードがある」を starved として判定し、throw せずに必要な最小値を返す。

const OOT = 9999
const batchCalls = (calls) => calls.filter((c) => /^state:update-batch:\d+$/.test(c.opts.label))
// blocked 一括記録のプロンプトから { 番号 → patch } を復元する（状態ファイルへ保存される note の文言を確かめる）。
function patchesFromBatchCalls(calls) {
  const out = {}
  for (const c of batchCalls(calls)) {
    for (const g of JSON.parse(c.prompt.split('\n').find((l) => l.startsWith('[{"numbers"')))) {
      for (const n of g.numbers) out[n] = g.patch
    }
  }
  return out
}
const notStartedNotes = (result) => result.done.filter((d) => d.status === 'not-started').map((d) => d.note)
const noteOf = (result, issue) => result.done.find((d) => d.issue === issue)?.note ?? ''
// 保存済みの monitoring 状態（PR #1000+n・ブランチ feat/n-x）。monitoring 再開の候補になる。
const resumeSaved = (n) => ({ type: 'implement', status: 'monitoring', pr: 1000 + n, branch: `feat/${n}-x`, worktree: '', fixCount: 0 })
// 保存済みの merged だが再開情報（pr）が無い葉。GitHub 上は open のため failedSet に入り、完了を検証できない前提として扱われる。
const mergedNoResume = { type: 'implement', status: 'merged', pr: 0, branch: '', worktree: '', fixCount: 0 }
// 残置 worktree が上限ちょうど（1 件）。新規着手は latch されないが、予約込みの projected が上限を超えるため monitoring 再開は defer される。
const ONE_EXTRA_WORKTREE = [
  { path: '/repo', branch: 'main', isMain: true },
  { path: '/repo/wt/x1', branch: 'misc/a', isMain: false },
]
const withOneExtraWorktree = (label) => {
  if (label === 'worktree:orphan-scan') return { entries: ONE_EXTRA_WORKTREE }
  if (label === 'worktree:record-count') return { count: ONE_EXTRA_WORKTREE.length }
  return undefined
}
// 親 #1 の配下: 着手できる葉（ready）、ツリー外前提待ちの葉（pad。開始処理の呼び出し数を増やすだけで着手しない）、
// #10（verify-close）とその子 #11。#11 を mergedNoResume にすると #11 が failedSet に入り、#10 は前提プローブの対象になる。
function budgetTree({ ready = [], pad = 1000 }) {
  const kids = [
    ...ready.map((number) => ({ number, parent: 1, dependsOn: [] })),
    ...Array.from({ length: pad }, (_, i) => ({ number: 100 + i, parent: 1, dependsOn: [OOT] })),
    { number: 10, parent: 1, dependsOn: [] },
  ]
  const node = (number, parent, siblingIndex, dependsOn, subIssuesTotal) => ({ number, title: number === 1 ? 'root' : `issue ${number}`, state: 'open', parent, siblingIndex, dependsOn, subIssuesTotal })
  return [
    node(1, 0, 0, [], kids.length),
    ...kids.map((k, i) => node(k.number, 1, i, k.dependsOn, k.number === 10 ? 1 : 0)),
    node(11, 10, 0, [], 0),
  ]
}
const closedProbe = (label) => (label === 'prereq:probe'
  ? { results: [{ issue: 11, issueState: 'CLOSED', prState: 'NONE', pr: 0, headRefName: '', baseRefName: '', isCrossRepository: true, closingIssues: [-1] }] }
  : undefined)
const callsBefore = (calls, pred) => calls.findIndex((c) => pred(c.opts.label))

test('結合: 開始処理で予算を使い切り最初の 1 件も着手できなくても throw せず、starved と必要な最小値を返し、保存される note も「agentCallLimit を少なくとも N にして再実行」になる (Bugbot D → 終了時判定)', async () => {
  const { result, calls, logs } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 81 }, leaves: MANY })
  const a = result.agentBudget
  assert.equal(a.starved, true)
  assert.equal(a.starts, 0, '1 件も着手していない')
  assert.ok(!calls.some((c) => c.opts.label.startsWith('plan:#')), '何も着手していない')
  const notes = notStartedNotes(result).filter((t) => t.includes('予算不足'))
  assert.ok(notes.length >= MANY.length, `予算で保留した葉 ${MANY.length} 件が対象（子待ちの親 #1 は予算の保留ではない）: ${notes.length}`)
  assert.ok(notes.every((t) => /agentCallLimit を少なくとも \d+ にして再実行/.test(t) && !t.includes('同じ引数で再実行すると着手する')), `全件が「同じ引数」ではなく limit の引き上げを案内する: ${notes[0]}`)
  const used = Number(/使用 (\d+)\/81/.exec(notes[0])[1])
  assert.ok(used > AGENT_CALLS_START, `開始処理の見積り ${AGENT_CALLS_START} を超えて使っている（${used}）ことが前提`)
  assert.equal(a.neededLimit, used + AGENT_CALLS_PER_ISSUE.implement + AGENT_CALLS_TERMINAL_BASE, '必要な最小値 = 使用量 + 最初の 1 件に要る量（実装の目安 + 終了処理の予備）')
  assert.equal(Number(/agentCallLimit を少なくとも (\d+) にして再実行/.exec(notes[0])[1]), a.neededLimit)
  assert.ok(logs.some((l) => l.includes('⚠️') && l.includes(String(a.neededLimit)) && l.includes('1 件も着手していない')), '終了ログに警告を出す')
  // 次ランが同じ引数で同じ停滞を繰り返さないよう、状態ファイルへ保存される note も同じ文言にする。
  const saved = Object.values(patchesFromBatchCalls(calls)).filter((p) => p.note.includes('予算不足'))
  assert.ok(saved.length >= MANY.length && saved.every((p) => p.note.includes(`agentCallLimit を少なくとも ${a.neededLimit} にして再実行`)), '保存される blocked の note も limit の引き上げを案内する')
  // 示された最小値で再実行すれば最初の 1 件に着手する（案内が実際に効く）。1 少ないと再び starved になる。
  const ok = await runScript({ args: { ...BASE_ARGS, agentCallLimit: a.neededLimit }, leaves: MANY })
  assert.equal(ok.calls.filter((c) => c.opts.label.startsWith('plan:#')).length, 1)
  assert.equal(ok.result.agentBudget.starts, 1)
  assert.equal(ok.result.agentBudget.starved, false)
  assert.equal(ok.result.agentBudget.neededLimit, null)
  const short = await runScript({ args: { ...BASE_ARGS, agentCallLimit: a.neededLimit - 1 }, leaves: MANY })
  assert.equal(short.result.agentBudget.starved, true)
})

test('結合: 開始処理が小さいツリーでは starved にならず従来どおり着手する (Bugbot D 対照)', async () => {
  const { result, calls } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 81 }, leaves: LEAVES })
  assert.ok(calls.some((c) => c.opts.label.startsWith('plan:#')))
  assert.equal(result.agentBudget.starved, false)
  assert.equal(result.agentBudget.neededLimit, null)
})

test('結合: 予算に収まる monitoring 再開が worktree ゲートで defer されて 1 件も着手しないランも throw せず starved になる (Bugbot 指摘 1)', async () => {
  // 再開（目安 12 + 予備 20 = 32）は収まり、実装（30 + 20 = 50）は収まらない残りになる limit だけを検査対象にする
  // （開始処理の呼び出し数が変わっても検査が空振りしないよう掃引し、空振りしたら失敗にする）。
  const hits = []
  for (let limit = 81; limit <= 100; limit++) {
    const run = await runScript({
      args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
      leaves: MANY,
      saved: { 2: resumeSaved(2) },
      override: withOneExtraWorktree,
    })
    if (run.logs.some((l) => l.includes('#2:') && l.includes('monitoring 再開を defer')) && run.logs.some((l) => l.includes('新規着手を停止する'))) hits.push({ limit, ...run })
  }
  assert.ok(hits.length > 0, '再開は予算を通って worktree ゲートで defer され、実装は予算で保留されるランが 1 つ以上ある')
  for (const { limit, result, calls, logs } of hits) {
    assert.ok(logs.some((l) => l.includes('#2: 再開できないまま monitoring 状態を維持する')) && !logs.some((l) => l.includes('halt 時も')), `limit ${limit}: halt していないランの終了ログに「halt 時も」と書かない（理由は note にある）`)
    const a = result.agentBudget
    assert.equal(a.starts, 0, `limit ${limit}: 再開は defer され、実装は予算で保留され、1 件も着手しない`)
    assert.equal(a.starved, true, `limit ${limit}`)
    const notes = notStartedNotes(result).filter((t) => t.includes('予算不足'))
    assert.ok(notes.length > 0 && notes.every((t) => t.includes(`agentCallLimit を少なくとも ${a.neededLimit} にして再実行`)), `limit ${limit}: 実装の保留は limit の引き上げを案内する: ${notes[0]}`)
    const used = Number(/使用 (\d+)\//.exec(notes[0])[1])
    assert.equal(a.neededLimit, used + AGENT_CALLS_PER_ISSUE.implement + AGENT_CALLS_TERMINAL_BASE, `limit ${limit}: 必要な最小値 = 使用量 + 実装 1 件に要る量（予算で保留されていない再開 #2 は数えない）`)
    assert.ok(result.interrupted.includes(2), `limit ${limit}: 再開 #2 は中断として残る`)
    assert.ok(noteOf(result, 2).includes('worktree') && !noteOf(result, 2).includes('予算'), `limit ${limit}: 再開 #2 の note は worktree ゲートの理由のまま: ${noteOf(result, 2)}`)
    const saved = Object.values(patchesFromBatchCalls(calls)).filter((p) => p.note.includes('予算不足'))
    assert.ok(saved.length > 0 && saved.every((p) => p.note.includes(`agentCallLimit を少なくとも ${a.neededLimit} にして再実行`)), `limit ${limit}: 保存される note も同じ文言`)
    assertStarvedConsistent(result, `limit ${limit}`)
  }
})

test('結合: ラン中に ready になった安価な verify-close は、開始時に実装が予算で保留されていても着手できる（ループ前で止まらない）(Bugbot 指摘 2)', async () => {
  // 実装（50）は収まらず verify-close（6 + 20 = 26）は収まる残りになる limit だけを検査対象にする（掃引。空振りは失敗）。
  const hits = []
  for (let limit = 81; limit <= 100; limit++) {
    const run = await runScript({
      args: { ...BASE_ARGS, agentCallLimit: limit },
      tree: budgetTree({ ready: [3, 4, 5] }),
      saved: { 11: mergedNoResume },
      override: closedProbe,
    })
    if (run.logs.some((l) => l.includes('新規着手を停止する')) && !run.calls.some((c) => c.opts.label.startsWith('plan:#'))) hits.push({ limit, ...run })
  }
  assert.ok(hits.length > 0, '実装が予算で一度も着手されないランが 1 つ以上ある')
  for (const { limit, result, calls, logs } of hits) {
    assert.ok(!calls.some((c) => c.opts.label.startsWith('plan:#')), `limit ${limit}: 実装は予算で着手されない`)
    assert.ok(logs.some((l) => l.includes('#10 を開始')), `limit ${limit}: プローブで前提が解消された後に #10（verify-close）が着手される`)
    assert.equal(result.agentBudget.starts, 1, `limit ${limit}`)
    assert.equal(result.agentBudget.starved, false, `limit ${limit}: 1 件でも着手したランは starved ではない`)
    const notes = notStartedNotes(result).filter((t) => t.includes('予算不足'))
    assert.ok(notes.length > 0 && notes.every((t) => t.includes('同じ引数で再実行すると着手する') && !t.includes('agentCallLimit を')), `limit ${limit}: 1 件以上着手したランの保留は従来どおり「同じ引数で再実行」: ${notes[0]}`)
  }
})

test('結合: 予算で保留した monitoring 再開の note は、前回評価したゲートの理由を消さず、予算の不足と併記する (Issue #598 指摘 3。#596 の「ゲート理由を消す」を反転)', async () => {
  const mk = (limit) => ({
    args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
    tree: budgetTree({ ready: [2], pad: 1600 }),
    saved: { 2: resumeSaved(2), 11: mergedNoResume },
    override: (label, ...rest) => withOneExtraWorktree(label) ?? closedProbe(label, ...rest),
  })
  // 較正: 周回 1 の時点（前提プローブの直前）の使用量。残りが再開 #2（目安 12 + 予備 20 = 32）にちょうど足りる limit にする。
  // 周回 1: #2 は予算を通り worktree ゲートで defer される（理由を記録）。#10 は前提待ち。続く前提プローブと状態更新で残りが 32 を割り、
  // 周回 2: #2 は予算で保留される。#10（verify-close）はプローブで ready になり 26 に収まるので着手する。
  const probe = await runScript(mk(1000))
  const loopUsed = callsBefore(probe.calls, (l) => l === 'prereq:probe')
  assert.ok(loopUsed > 0)
  const limit = loopUsed + AGENT_CALLS_PER_ISSUE.resume + AGENT_CALLS_TERMINAL_BASE
  assert.ok(limit >= 81, `limit ${limit} は下限以上（パディングの葉を増やして開始処理の使用量を上げる）`)
  const { result, logs } = await runScript(mk(limit))
  assert.ok(logs.some((l) => l.includes('#2:') && l.includes('monitoring 再開を defer')), '前提: 周回 1 で worktree ゲートの理由が記録される')
  assert.ok(logs.some((l) => l.includes('新規着手を停止する')), '前提: 周回 2 で #2 は予算で保留される')
  assert.equal(result.agentBudget.starts, 1, '#10 は着手する')
  assert.ok(result.interrupted.includes(2))
  const note = noteOf(result, 2)
  // 周回 2 のゲートは予算が足りないため評価されない（ゲートの実測 du・df は自身がエージェントを呼ぶ）。残るのは周回 1 の観測。
  assert.ok(note.includes('monitoring 再開を defer した'), `前回評価したゲートの理由を残す: ${note}`)
  assert.ok(note.includes('前回の評価') && note.includes('再評価していない'), `ゲートが今回未評価と分かる: ${note}`)
  assert.ok(note.includes('予算も不足していた'), `予算の不足も併記する: ${note}`)
  assert.ok(!note.includes('予算不足で monitoring 再開を見送った'), `予算だけが理由とは案内しない: ${note}`)
})

test('結合: ゲートの理由が残る monitoring 再開は予算だけが理由ではないため、1 件も着手しないランでも starved / neededLimit に数えない (Issue #598 指摘 3)', async () => {
  // #2 は周回 1 で予算を通り worktree ゲートで defer される。前提プローブで使用量が増えた周回 2 では予算で保留される。
  // #10 は ツリー外前提待ちのままなので着手せず、ラン全体で 1 件も着手しない。保留は #2 だけ（実装の葉は居ない）。
  const kid = (number, dependsOn, subIssuesTotal = 0, parent = 1, siblingIndex = 0) => ({ number, title: `issue ${number}`, state: 'open', parent, siblingIndex, dependsOn, subIssuesTotal })
  const tree = [
    { number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: 1602 },
    kid(2, [], 0, 1, 0),
    ...Array.from({ length: 1600 }, (_, i) => kid(100 + i, [OOT], 0, 1, 1 + i)),
    kid(10, [OOT], 1, 1, 1601),
    kid(11, [], 0, 10, 0),
  ]
  const mk = (limit) => ({
    args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
    tree,
    saved: { 2: resumeSaved(2), 11: mergedNoResume },
    override: (label, ...rest) => withOneExtraWorktree(label) ?? closedProbe(label, ...rest),
  })
  const probe = await runScript(mk(1000))
  const limit = callsBefore(probe.calls, (l) => l === 'prereq:probe') + AGENT_CALLS_PER_ISSUE.resume + AGENT_CALLS_TERMINAL_BASE
  assert.ok(limit >= 81)
  const { result, logs } = await runScript(mk(limit))
  assert.ok(logs.some((l) => l.includes('#2:') && l.includes('monitoring 再開を defer')), '前提: 周回 1 でゲートの理由が記録される')
  assert.ok(logs.some((l) => l.includes('新規着手を停止する')), '前提: 周回 2 で #2 は予算で保留される')
  assert.equal(result.agentBudget.starts, 0, '前提: 1 件も着手しない')
  assert.ok(result.interrupted.includes(2))
  assert.equal(result.agentBudget.starved, false, '上限を上げても worktree ゲートで止まり得るため、予算だけが理由の停滞ではない')
  assert.equal(result.agentBudget.neededLimit, null)
  const note = noteOf(result, 2)
  assert.ok(note.includes('予算も不足していた') && note.includes('monitoring 再開を defer した'), note)
  assert.ok(!note.includes('にして再実行'), `上限の引き上げだけで再開するとは案内しない: ${note}`)
})

test('結合: halt が立ったあとも、予算で保留した monitoring 再開の note から予算の事実を落とさず、「同じ引数で再実行すれば再開する」とだけは書かない (Issue #598 指摘 2)', async () => {
  // #9 は保存済みの monitoring。実装 3 件（#2〜#4）の着手中に評価されて予算で保留され、その後 3 件の実装が失敗して halt し、
  // 再評価されないまま残る。失敗する実装の呼び出し数を増やすため、状態書込みも未返却（sonnet へフォールバック = 2 回）にする。
  const hits = []
  for (let limit = 100; limit <= 140; limit++) {
    const run = await runScript({
      args: { ...BASE_ARGS, parallel: 3, agentCallLimit: limit },
      leaves: LEAVES,
      saved: { 9: resumeSaved(9) },
      override: (label) => (label.startsWith('impl:#') || label.startsWith('state:update:#') ? null : undefined),
    })
    if (run.result.halted && run.result.interrupted.includes(9) && noteOf(run.result, 9).includes('予算も不足していた')) hits.push({ limit, ...run })
  }
  assert.ok(hits.length > 0, 'halt と monitoring 再開の予算保留が同じランで起きる limit が 1 つ以上ある')
  for (const { limit, result } of hits) {
    const note = noteOf(result, 9)
    assert.ok(note.includes('halt のため再開しなかった'), `limit ${limit}: halt の文言を残す: ${note}`)
    assert.match(note, /保留時の使用 \d+\/\d+。この周回の使用量では再開に args\.agentCallLimit が少なくとも \d+ 要った/, `limit ${limit}: 予算の不足量を示す: ${note}`)
    assert.ok(!note.includes('同じ引数で再実行すると monitor から再開する'), `limit ${limit}: 同じ引数で再開するとだけは書かない: ${note}`)
  }
})

test('単体: monitoring 再開の予算保留はゲートの理由を消さず、予算の文言でゲートの理由を上書きしない (Issue #598)', () => {
  // 結合で再現するには保存済みの monitoring 状態と照合用ハッシュが要るため、書き込み経路を構造で固定する。
  assert.doesNotMatch(driverPart, /monitoringResumeGateDeferred\.set\([^)]*予算/, '予算の文言でゲートの理由を上書きしない')
  const hold = driverPart.slice(driverPart.indexOf('if (budgetHold) {'), driverPart.indexOf('agentBudgetHeld.delete(n)'))
  assert.ok(hold.length > 0 && !hold.includes('monitoringResumeGateDeferred.delete'), '予算保留の分岐でゲートの理由を消さない（消すとゲートが未評価のまま予算だけを理由と案内する）')
  // 旧: budgetOnly の式に `!monitoringResumeGateDeferred.has(n)` が含まれることを文字列で固定していた。#600 で note と budgetOnly を
  // 同じ理由の集合（stopReasons）から導く構造へ変えたため、式の文字列ではなく導出元を固定する。ゲートが残る再開を数えない振る舞いは
  // 下の「全組み合わせ」の表（budget だけの行以外は budgetOnly でない）と、上の結合テスト（starved: false）が検査する。
  assert.ok(driverPart.includes('const budgetOnly = (n) => { const r = stopReasons(stopFacts(n)); return r.length === 1 && r[0] === \'budget\' }'), 'budgetOnly（starved / neededLimit の対象）は note と同じ理由の集合から導く')
  assert.equal((driverPart.match(/stopNote\(stopFacts\(n\), agentBudget\)/g) ?? []).length, 2, '未着手（保存する blocked の note を含む）と中断の note は同じ合成関数を通る')
  assert.ok(!/monitoringResumeGateDeferred\.get\(n\)\s*\?/.test(driverPart) && !driverPart.includes('deferredReason'), '理由を選ぶ三項・if/else を note の組み立てに残さない')
})

test('結合: starved の note は neededLimit を下限値として案内し、「N 以上にすれば必ず進む」と読める文言を使わない (Issue #598 指摘 1)', async () => {
  const { result, logs, calls } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 81 }, leaves: MANY })
  assert.equal(result.agentBudget.starved, true)
  const notes = notStartedNotes(result).filter((t) => t.includes('予算不足'))
  const saved = Object.values(patchesFromBatchCalls(calls)).filter((p) => p.note.includes('予算不足')).map((p) => p.note)
  assert.ok(notes.length > 0 && saved.length > 0)
  for (const t of [...notes, ...saved]) {
    assert.ok(t.includes('下限値') && t.includes('開始処理の分だけさらに要る'), `開始処理の読み込み分が不定で下限値であることを示す: ${t}`)
    assert.doesNotMatch(t, /以上にして/, `「N 以上にして」とは書かない: ${t}`)
  }
  assert.ok(logs.some((l) => l.includes('1 件も着手していない') && l.includes('下限値')), '終了ログも下限値と案内する')
})

test('結合: 新規着手抑止（ラッチ）が効いていても、予算で保留された monitoring 再開は予算だけが理由なので starved になる（再開はラッチの対象外）', async () => {
  const hits = []
  for (let limit = 81; limit <= 100; limit++) {
    const run = await runScript({
      args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
      tree: budgetTree({ ready: [2], pad: 1600 }),
      saved: { 2: resumeSaved(2) },
      override: (label) => (label === 'worktree:orphan-scan' ? { entries: EXTRA_WORKTREES } : undefined),
    })
    if (run.logs.some((l) => l.includes('新規着手を停止する')) && noteOf(run.result, 2).includes('予算不足')) hits.push({ limit, ...run })
  }
  assert.ok(hits.length > 0, '再開 #2 が予算で保留されるランが 1 つ以上ある')
  for (const { limit, result } of hits) {
    const a = result.agentBudget
    assert.equal(a.starts, 0, `limit ${limit}`)
    assert.equal(a.starved, true, `limit ${limit}: 実装の保留はラッチが理由だが、再開 #2 は予算だけが理由`)
    assert.equal(a.neededLimit, Number(/使用 (\d+)\//.exec(noteOf(result, 2))[1]) + AGENT_CALLS_PER_ISSUE.resume + AGENT_CALLS_TERMINAL_BASE, `limit ${limit}: 必要な最小値は再開 1 件分`)
    assert.ok(noteOf(result, 2).includes(`agentCallLimit を少なくとも ${a.neededLimit} にして再実行`), `limit ${limit}: ${noteOf(result, 2)}`)
    const impl = notStartedNotes(result).filter((t) => t.includes('残置 worktree 上限ゲート'))
    assert.ok(impl.length > 0 && impl.every((t) => !t.includes('予算不足')), `limit ${limit}: ラッチが理由の実装の note は抑止の理由のまま`)
    assertStarvedConsistent(result, `limit ${limit}`)
  }
})

test('単体: ループ前に着手可否を断定して throw する検査を持たない（着手可否はループ中にしか分からない）', () => {
  assert.doesNotMatch(driverPart, /予算が開始処理で足りなくなった/)
  const loopStart = driverPart.indexOf('while (true) {\n  dispatchIterationSeq += 1')
  assert.ok(loopStart > 0)
  assert.ok(!/agentBudgetHold\(/.test(driverPart.slice(0, loopStart)), 'ループより前に agentBudgetHold の判定を置かない')
})

test('結合: 予算だけが理由の未着手は、従来どおり予算不足と案内する (Bugbot A 対照)', async () => {
  const { result, logs } = await runScript({ args: { ...BASE_ARGS, agentCallLimit: 120 }, leaves: LEAVES })
  assert.ok(logs.some((l) => l.includes('新規着手を停止する')))
  assert.equal(result.agentBudget.starved, false, '1 件以上着手したランは starved ではない')
  const notes = result.done.filter((d) => d.status === 'not-started' && d.issue !== 1).map((d) => d.note)
  assert.ok(notes.length > 0 && notes.every((t) => t.includes('予算不足') && t.includes('同じ引数で再実行すると着手する')))
})

test('結合: halt しているとき、予算の not-started note で halt の理由を上書きしない (Bugbot A)', async () => {
  const hit = await sweepLimits([81, 90, 100, 110, 120, 130, 140, 160, 200], (limit) => runScript({
    args: { ...BASE_ARGS, parallel: 3, agentCallLimit: limit },
    leaves: LEAVES,
    // 実装が毎回失敗して 3 連続で halt する
    override: (label) => (label.startsWith('impl:#') ? { branch: '', summary: '', worktreePath: '' } : undefined),
  }))
  const halted = hit.filter((h) => h.result.halted)
  assert.ok(halted.length > 0, 'halt と予算の停止が同じランで起きる limit が 1 つ以上ある')
  for (const { limit, result } of halted) {
    const notes = result.done.filter((d) => d.status === 'not-started' && d.issue !== 1).map((d) => d.note)
    assert.ok(notes.length > 0, `limit ${limit}`)
    assert.ok(notes.every((t) => !t.includes('予算不足') && t.includes('halted')), `limit ${limit}: halt の理由が残る: ${notes[0]}`)
  }
})

// ---------------------------------------------------------------------------
// 終了時 note の停止理由は「1 つ選ぶ」のではなく「成立しているものをすべて優先順に並べる」(Issue #600)
// ---------------------------------------------------------------------------
// #595 → #596 → #597 → #599 は note を「止めた理由を 1 つ選ぶ」if/else で組み、修正のたびに 1 つの組み合わせだけを塞いだため、
// 未テストの組み合わせが毎回残った。ここでは停止理由の軸（halt・新規着手抑止のラッチ・再開ゲート・予算保留）× ノード種別を
// 表で網羅し、到達可能な全行で note が「成立している理由の断片をすべて含み、成立していない理由の断片を含まない」ことを固定する。
//
// 到達可能性（コードから判断。到達不能な行は呼び出しだけを確認し、期待は課さない）:
//   - ゲート理由 (gate): monitoringResumeGateDeferred.set は isActiveMonitoring かつ item.kind === 'implement' の再開ブロック内にしか無い。
//     よって「再開 × implement」以外（新規着手、verify-close の再開）は常にゲート理由なし。
//   - ラッチ (latch): 新規着手抑止は再開ブロックの後に判定されるため、再開ノードには適用されない（再開はラッチの対象外）。
//     implementOnly のラッチ（空き容量起因）は implement にしか効かず、verify-close には適用されない。
//   - 予算保留 (held): 予算検査は種別を問わず走るため、どの種別にも付き得る。
//   - 「ゲートを今回再評価済み × 予算保留」は無い: 予算保留の分岐は agentBudgetHeld.delete よりも前で continue し、ゲート評価はその後。
//     よって held とゲート理由が併存するなら、ゲートは必ず「前回の評価」。
//   - halt はグローバル状態で、どの種別にも併存し得る（halt 後は dispatch が走らず、それ以前の held・gate が残る）。
const HALT = { reason: 'HALT_REASON_X', issues: [3] }
const LATCH = { reason: 'LATCH_REASON_X' }
const LATCH_IMPL_ONLY = { reason: 'LATCH_REASON_X', implementOnly: true }
const GATE = 'GATE_REASON_X のため monitoring 再開を defer した。'
const HELD = { required: 32, used: 90 }
const BUDGET_CTX = { used: 95, limit: 100, neededLimit: 127 }

function* stopRows() {
  for (const resume of [false, true]) {
    for (const kind of ['implement', 'verify-close']) {
      for (const halted of [null, HALT]) {
        for (const latch of [null, LATCH, LATCH_IMPL_ONLY]) {
          for (const gate of [undefined, GATE]) {
            for (const held of [undefined, HELD]) {
              for (const starved of [false, true]) yield { resume, kind, halted, latch, gate, held, starved }
            }
          }
        }
      }
    }
  }
}
const gateReachable = (r) => r.resume && r.kind === 'implement'
const expectedReasons = (r) => [
  r.halted && 'halt',
  !r.resume && r.latch && (!r.latch.implementOnly || r.kind === 'implement') && 'latch',
  r.gate && 'gate',
  r.held && 'budget',
].filter(Boolean)

function checkNote(row, note) {
  const order = expectedReasons(row)
  const where = JSON.stringify({ ...row, halted: !!row.halted, latch: row.latch && (row.latch.implementOnly ? 'implementOnly' : 'all'), gate: !!row.gate, held: !!row.held })
  const has = (s) => note.includes(s)
  const sole = order.length === 1 && order[0] === 'budget'
  assert.equal(has('HALT_REASON_X'), order.includes('halt'), `halt の理由: ${where}\n${note}`)
  assert.equal(has(row.resume ? 'halt のため再開しなかった' : 'halted により未着手'), order.includes('halt'), `halt の文言: ${where}\n${note}`)
  assert.equal(has('LATCH_REASON_X'), order.includes('latch'), `ラッチの理由は適用される行にだけ: ${where}\n${note}`)
  assert.equal(has('残置 worktree 上限ゲートにより新規着手を抑止'), order.includes('latch'), `ラッチの文言: ${where}\n${note}`)
  assert.equal(has('GATE_REASON_X'), order.includes('gate'), `ゲートの理由: ${where}\n${note}`)
  assert.equal(has('前回の評価') && has('再評価していない'), order.includes('gate') && order.includes('budget'), `ゲートが前回の評価と分かるのは予算保留と併存するときだけ: ${where}\n${note}`)
  assert.equal(has('予算'), order.includes('budget'), `予算の言及は予算保留があるときだけ: ${where}\n${note}`)
  if (sole) {
    assert.ok(has('予算不足'), `予算だけが理由なら予算不足: ${where}\n${note}`)
    assert.ok(row.starved ? has(`少なくとも ${BUDGET_CTX.neededLimit} にして再実行`) && has('下限値') : has('同じ引数で再実行すると'), `starved の出し分け: ${where}\n${note}`)
    assert.equal(has('にして再実行'), row.starved, `limit の引き上げを案内するのは starved のときだけ: ${where}\n${note}`)
  } else if (order.includes('budget')) {
    assert.ok(has('予算も不足していた'), `他の理由があるときは併記形: ${where}\n${note}`)
    assert.ok(has(`保留時の使用 ${HELD.used}/${BUDGET_CTX.limit}`) && has(`少なくとも ${HELD.used + HELD.required}`), `保留時の使用量から言う下限値: ${where}\n${note}`)
    assert.ok(!has('予算不足') && !has('にして再実行'), `他の理由が残るのに limit の引き上げだけで進むとは案内しない: ${where}\n${note}`)
  }
  assert.equal(has('キュー未到達'), order.length === 0 && !row.resume, `理由なしの新規着手の既定文: ${where}\n${note}`)
  const resumeAdvice = has('同じ引数で再実行すると monitor から再開する')
  assert.equal(resumeAdvice, row.resume && (order.length === 0 || (sole && !row.starved)), `「同じ引数で再実行すると再開する」は理由が残らないときだけ: ${where}\n${note}`)
  assert.ok(!has('。。'), `句点が重ならない: ${where}\n${note}`)
  const at = [['halt', row.resume ? 'halt のため再開しなかった' : 'halted により未着手'], ['latch', '残置 worktree 上限ゲートにより'], ['gate', 'GATE_REASON_X'], ['budget', '予算']]
    .filter(([k]) => order.includes(k)).map(([, s]) => note.indexOf(s))
  assert.deepEqual(at, [...at].sort((a, b) => a - b), `優先順 halt → ラッチ → ゲート → 予算: ${where}\n${note}`)
}

test('単体: 停止理由の全組み合わせ（軸 × 種別の表）で、note は成立している理由をすべて優先順に含み、成立していない理由を含まない (Issue #600)', () => {
  let reachable = 0
  let unreachable = 0
  let multi = 0
  for (const row of stopRows()) {
    const facts = { resume: row.resume, kind: row.kind, halted: row.halted, latch: row.latch, gate: row.gate, held: row.held }
    const reasons = stopReasons(facts)
    assert.deepEqual(reasons, expectedReasons(row), `理由の集合と順序: ${JSON.stringify(row)}`)
    const note = stopNote(facts, { ...BUDGET_CTX, starved: row.starved })
    if (row.gate && !gateReachable(row)) { unreachable += 1; continue } // 到達不能（上の根拠）。呼び出しが落ちないことだけ確認
    reachable += 1
    if (reasons.length >= 2) multi += 1
    checkNote(row, note)
  }
  assert.ok(reachable > 0 && unreachable > 0 && multi > 0, `表が空振りしていない: reachable ${reachable} / unreachable ${unreachable} / multi ${multi}`)
})

test('単体: 名前付きの行 — #600（ゲートで defer → 予算保留 → halt）と #596 #597 #598 が指した組み合わせ', () => {
  const ctx = { ...BUDGET_CTX, starved: false }
  // #600: ゲート（前回の評価）・予算・halt が併存。halt が落ちず、先頭に来る。
  const n600 = stopNote({ resume: true, kind: 'implement', halted: HALT, latch: null, gate: GATE, held: HELD }, ctx)
  assert.match(n600, /^halt のため再開しなかった（理由: HALT_REASON_X）。GATE_REASON_X.*（この理由は前回の評価。予算で保留した周回では再評価していない）。エージェント呼び出し数の予算も不足していた/, n600)
  // #598 指摘 2: halt + 予算保留の再開。予算の事実を落とさず、「同じ引数で再開する」とは書かない。
  const n598b = stopNote({ resume: true, kind: 'implement', halted: HALT, latch: null, gate: undefined, held: HELD }, ctx)
  assert.match(n598b, /保留時の使用 90\/100。この周回の使用量では再開に args\.agentCallLimit が少なくとも 122 要った/)
  assert.ok(!n598b.includes('同じ引数で再実行すると monitor から再開する'), n598b)
  // #598 指摘 3: ゲート理由 + 予算保留。ゲートは前回の評価で、予算だけが理由とは案内しない。
  const n598c = stopNote({ resume: true, kind: 'implement', halted: null, latch: null, gate: GATE, held: HELD }, { ...BUDGET_CTX, starved: true })
  assert.ok(n598c.includes('前回の評価') && n598c.includes('予算も不足していた') && !n598c.includes('にして再実行') && !n598c.includes('予算不足'), n598c)
  // #596 の Bugbot A: ラッチ + 予算保留の新規着手は、ラッチの理由を残しつつ予算も併記する。
  const nA = stopNote({ resume: false, kind: 'implement', halted: null, latch: LATCH, gate: undefined, held: HELD }, { ...BUDGET_CTX, starved: true })
  assert.match(nA, /^残置 worktree 上限ゲートにより新規着手を抑止（理由: LATCH_REASON_X）。エージェント呼び出し数の予算も不足していた/, nA)
  // #597: 再開はラッチの対象外。ラッチが立っていても、予算で保留した再開は予算だけが理由。
  const n597 = stopNote({ resume: true, kind: 'implement', halted: null, latch: LATCH, gate: undefined, held: HELD }, { ...BUDGET_CTX, starved: true })
  assert.match(n597, /予算不足で monitoring 再開を見送った/)
  assert.ok(!n597.includes('LATCH_REASON_X') && n597.includes('少なくとも 127 にして再実行'), n597)
  // 適用されないラッチ: 空き容量起因（implementOnly）のラッチは verify-close に効かない。前提待ちで未着手の verify-close の理由にしない。
  const nVC = stopNote({ resume: false, kind: 'verify-close', halted: null, latch: LATCH_IMPL_ONLY, gate: undefined, held: undefined }, ctx)
  assert.equal(nVC, 'スケジューラ終了時に未着手（キュー未到達）')
  // halt のみの再開は halt の理由を残す（以前は halt を落として「同じ引数で再実行すると再開する」だけを出していた）。
  const nH = stopNote({ resume: true, kind: 'implement', halted: HALT, latch: null, gate: undefined, held: undefined }, ctx)
  assert.equal(nH, 'halt のため再開しなかった（理由: HALT_REASON_X）')
})

// ---------------------------------------------------------------------------
// 統合: 実際にその状態へ到達するランで、note と starved / neededLimit / budgetOnly が矛盾しないことを確かめる (Issue #600)
// ---------------------------------------------------------------------------
// note が「agentCallLimit を少なくとも N にして再実行」と言うのは、予算だけが理由の保留ノードがあり 1 件も着手しなかったラン（starved）の
// そのノードだけ。starved の neededLimit は note の N と一致し、他の理由が残るノードの note は limit の引き上げだけを案内しない。
function assertStarvedConsistent(result, where) {
  const a = result.agentBudget
  const notes = result.done.filter((d) => d.status === 'not-started' || d.status === 'monitoring' || d.status === 'blocked').map((d) => d.note)
  const raising = notes.filter((t) => t.includes('にして再実行'))
  if (!a.starved) assert.equal(raising.length, 0, `${where}: starved でないランは limit の引き上げを案内しない: ${raising[0]}`)
  else {
    assert.ok(raising.length > 0, `${where}: starved なら引き上げを案内する note がある`)
    for (const t of raising) assert.ok(t.includes(`少なくとも ${a.neededLimit} にして再実行`) && t.includes('予算不足') && !t.includes('予算も不足していた'), `${where}: 引き上げを案内するのは予算だけが理由のノードで、値は neededLimit: ${t}`)
  }
  for (const t of notes.filter((x) => x.includes('予算も不足していた'))) assert.ok(!t.includes('にして再実行'), `${where}: 他の理由が残るノードは引き上げだけを案内しない: ${t}`)
}

// 親 #1 の配下: 保存済み monitoring の再開 #2、閉じた子を持つ verify-close #10 #20 #30（close の agent が closed: false を返して
// 'failed' で終わり、3 連続で halt する）、ツリー外前提待ちで着手しない葉 pad 件（未完了ノード数 = blocked 一括記録の chunks を増やし、
// 再開 #2（目安 12）が verify-close（目安 6）より多く要る窓を作る）。
function haltTree(pad = 1600) {
  const node = (number, parent, siblingIndex, state, subIssuesTotal, dependsOn = []) => ({ number, title: number === 1 ? 'root' : `issue ${number}`, state, parent, siblingIndex, dependsOn, subIssuesTotal })
  return [
    node(1, 0, 0, 'open', 4 + pad),
    node(2, 1, 0, 'open', 0),
    node(10, 1, 1, 'open', 1), node(11, 10, 0, 'closed', 0),
    node(20, 1, 2, 'open', 1), node(21, 20, 0, 'closed', 0),
    node(30, 1, 3, 'open', 1), node(31, 30, 0, 'closed', 0),
    ...Array.from({ length: pad }, (_, i) => node(100 + i, 1, 4 + i, 'open', 0, [OOT])),
  ]
}
const failClose = (label) => (label.startsWith('close:#') ? { closed: false, summary: '検証失敗' } : undefined)

test('結合: ゲートで defer した再開が、次の周回で予算保留になり、そのあと halt すると、note に halt・前回のゲート・予算の不足が優先順にすべて出る (Issue #600)', async () => {
  const hits = []
  for (let limit = 81; limit <= 140; limit++) {
    const run = await runScript({
      args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
      tree: haltTree(),
      saved: { 2: resumeSaved(2) },
      override: (label, ...rest) => withOneExtraWorktree(label) ?? failClose(label, ...rest),
    })
    const gateAt = run.logs.findIndex((l) => l.includes('#2:') && l.includes('monitoring 再開を defer'))
    const holdAt = run.logs.findIndex((l) => l.includes('新規着手を停止する') && l.includes('#2 '))
    if (run.result.halted && run.result.interrupted.includes(2) && gateAt >= 0 && holdAt > gateAt && noteOf(run.result, 2).includes('予算も不足していた')) hits.push({ limit, ...run })
  }
  assert.ok(hits.length > 0, 'ゲート defer → 予算保留 → halt の順に起きる limit が 1 つ以上ある')
  for (const { limit, result } of hits) {
    const note = noteOf(result, 2)
    const at = ['halt のため再開しなかった', 'monitoring 再開を defer した', '前回の評価', '予算も不足していた'].map((s) => note.indexOf(s))
    assert.ok(at.every((i) => i >= 0), `limit ${limit}: halt・ゲート・前回の評価・予算がすべて出る: ${note}`)
    assert.deepEqual(at, [...at].sort((a, b) => a - b), `limit ${limit}: 優先順 halt → ゲート → 予算: ${note}`)
    assert.ok(!note.includes('同じ引数で再実行すると monitor から再開する') && !note.includes('にして再実行'), `limit ${limit}: ${note}`)
    assert.equal(result.agentBudget.starved, false, `limit ${limit}: halt とゲートが残るので予算だけが理由の停滞ではない`)
    assertStarvedConsistent(result, `limit ${limit}`)
  }
})

test('結合: 新規着手抑止（ラッチ）と予算保留が併存する未着手の note は、ラッチの理由に予算の不足を併記する (Issue #600)', async () => {
  const hit = await sweepLimits([81, 90, 100], (limit) => runScript({
    args: { ...BASE_ARGS, maxResidualWorktrees: 1, agentCallLimit: limit },
    leaves: MANY,
    override: (label) => (label === 'worktree:orphan-scan' ? { entries: EXTRA_WORKTREES } : undefined),
  }))
  assert.ok(hit.length > 0, '予算ゲートが効いたランが 1 つ以上ある')
  for (const { limit, result, calls } of hit) {
    const both = notStartedNotes(result).filter((t) => t.includes('残置 worktree 上限ゲート') && t.includes('予算も不足していた'))
    assert.ok(both.length > 0, `limit ${limit}: 予算で保留したノードの note はラッチと予算の両方を示す`)
    assert.ok(both.every((t) => t.indexOf('残置 worktree 上限ゲート') < t.indexOf('予算も不足していた') && !t.includes('予算不足')), `limit ${limit}: ラッチ → 予算の順で、予算だけが理由とは書かない: ${both[0]}`)
    const saved = Object.values(patchesFromBatchCalls(calls)).map((p) => p.note)
    assert.ok(saved.some((t) => t.includes('残置 worktree 上限ゲート') && t.includes('予算も不足していた')), `limit ${limit}: 状態ファイルへ保存する note も同じ合成`)
    assertStarvedConsistent(result, `limit ${limit}`)
  }
})

test('結合: halt と予算保留が併存する未着手の note は、halt の理由に予算の不足を併記する (Issue #600)', async () => {
  const hit = await sweepLimits([81, 90, 100, 110, 120, 130, 140, 160, 200], (limit) => runScript({
    args: { ...BASE_ARGS, parallel: 3, agentCallLimit: limit },
    leaves: LEAVES,
    override: (label) => (label.startsWith('impl:#') ? { branch: '', summary: '', worktreePath: '' } : undefined),
  }))
  const halted = hit.filter((h) => h.result.halted)
  assert.ok(halted.length > 0, 'halt と予算の保留が同じランで起きる limit が 1 つ以上ある')
  let both = 0
  for (const { limit, result } of halted) {
    for (const t of notStartedNotes(result).filter((x) => x.includes('予算も不足していた'))) {
      both += 1
      assert.ok(t.startsWith('halted により未着手') && !t.includes('予算不足') && !t.includes('にして再実行'), `limit ${limit}: halt が先頭で、予算だけが理由とは書かない: ${t}`)
    }
    assertStarvedConsistent(result, `limit ${limit}`)
  }
  assert.ok(both > 0, '予算で保留したあとに halt したノードの note が 1 件以上ある')
})

test('結合: halt だけが理由の monitoring 再開は halt の理由を残し、「同じ引数で再実行すると再開する」とは書かない (Issue #600)', async () => {
  // #9 は保存済みの monitoring。予算は十分で、実装 3 件（#2〜#4）が失敗して halt し、#9 は評価されないまま残る。
  const { result } = await runScript({
    args: { ...BASE_ARGS, parallel: 3, agentCallLimit: 1000 },
    leaves: LEAVES,
    saved: { 9: resumeSaved(9) },
    override: (label) => (label.startsWith('impl:#') ? { branch: '', summary: '', worktreePath: '' } : undefined),
  })
  assert.ok(result.halted && result.interrupted.includes(9))
  const note = noteOf(result, 9)
  assert.ok(note.includes('halt のため再開しなかった') && note.includes('3 イシュー連続で完了できなかった'), `halt の理由を残す: ${note}`)
  assert.ok(!note.includes('同じ引数で再実行すると monitor から再開する') && !note.includes('予算'), `halt は再実行で解けるとは限らない。予算は無関係: ${note}`)
  assertStarvedConsistent(result, 'halt のみ')
})

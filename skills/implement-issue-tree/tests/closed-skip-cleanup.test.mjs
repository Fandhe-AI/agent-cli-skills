// closed で skip する実装ノードの後始末（Issue #632）の回帰テスト。
//
// 背景: 既定の autoMerge: false で止まった PR を人手でマージすると、PR 本文の Closes #N で子イシューが自動 close し、再実行は
// そのノードを「すでに closed」で skip する。skip は状態ファイルを読まず掃除の入口も通らないため、blocked / monitoring が記録した
// 実装 worktree が残り、状態も blocked のままだった。
// 契約: PR のマージ済み（state == MERGED・結び付き成立・headRefOid 取得）を独立に確認できたときだけ、
//   worktree-remove.sh remove --mode discard --head <PR の head> で破棄し、そのあとで状態を merged へ更新する（掃除 → 状態の順）。
//   確認できない場合（未マージの CLOSED・結び付き不成立・HEAD 不一致や lock で保持・dryRun・状態の照合未成立）は状態も worktree も触らない。
//
// 三層: 1. 候補の特定（純粋関数 closedCleanupCandidate の表）  2. cleanupClosedMergedWorktree（stub agent・台帳と除外集合）
//       3. 実装スクリプト全体（tests/lib/stub-run.mjs）でのホスト結合。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importDefinitions, runScript, BASE_ARGS } from './lib/stub-run.mjs'

globalThis.args = { parent: 1, skillDir: '/opt/skills/implement-issue-tree' }
const SHA = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const WT = '/repo/wt/old'

const m = await importDefinitions(
  ['closedCleanupCandidate', 'cleanupClosedMergedWorktree', 'worktreeRemoveCommand', 'sweepClosedWorktrees', 'sweepEligiblePaths', 'sweepHeldPaths', 'confirmedRemovedPaths', 'ensureBoundaryNonceSeed', 'sha256Hex', 'canonicalJson'],
  'closed-skip-cleanup',
)
globalThis.agent = async (_p, opts) => (opts.label === 'nonce:seed' ? { seedHex: '0'.repeat(64) } : null)
globalThis.log = () => {}
await m.ensureBoundaryNonceSeed()

// ---- 1. 候補の特定 ----

const ctx = { dryRun: false, verified: true, unverified: new Set() }
const impl = { number: 2, kind: 'implement' }
const savedOf = (extra = {}) => ({ status: 'blocked', branch: 'feat/2-x', worktree: WT, pr: 77, ...extra })

test('closedCleanupCandidate: blocked / monitoring で worktree と pr（無ければ unverifiedPr）を記録した実装ノードだけが候補になる', () => {
  assert.deepEqual(m.closedCleanupCandidate(impl, savedOf(), ctx), { pr: 77, worktree: WT, branch: 'feat/2-x' })
  assert.deepEqual(m.closedCleanupCandidate(impl, savedOf({ status: 'monitoring' }), ctx), { pr: 77, worktree: WT, branch: 'feat/2-x' })
  // pr が無ければ unverifiedPr。両方あれば pr が先
  assert.equal(m.closedCleanupCandidate(impl, savedOf({ pr: 0, unverifiedPr: 88 }), ctx).pr, 88)
  assert.equal(m.closedCleanupCandidate(impl, savedOf({ pr: 77, unverifiedPr: 88 }), ctx).pr, 77)
})

test('closedCleanupCandidate: 候補にならない条件（dryRun・照合未成立・state-unverified・種別・状態・worktree/pr の欠落や不正）', () => {
  const rows = [
    ['dryRun', impl, savedOf(), { ...ctx, dryRun: true }],
    ['状態の照合未成立', impl, savedOf(), { ...ctx, verified: false }],
    ['state-unverified の項目', impl, savedOf(), { ...ctx, unverified: new Set([2]) }],
    ['verify-close', { number: 2, kind: 'verify-close' }, savedOf(), ctx],
    ['保存状態なし', impl, undefined, ctx],
    ['status: failed', impl, savedOf({ status: 'failed' }), ctx],
    ['status: merged', impl, savedOf({ status: 'merged' }), ctx],
    ['status: closed', impl, savedOf({ status: 'closed' }), ctx],
    ['status: pending', impl, savedOf({ status: 'pending' }), ctx],
    ['worktree なし', impl, savedOf({ worktree: '' }), ctx],
    ['worktree が相対パス', impl, savedOf({ worktree: 'rel/p' }), ctx],
    ['worktree に ..', impl, savedOf({ worktree: '/repo/../x' }), ctx],
    ['worktree が文字列でない', impl, savedOf({ worktree: 5 }), ctx],
    ['pr も unverifiedPr もなし', impl, savedOf({ pr: 0 }), ctx],
    ['pr が整数でない', impl, savedOf({ pr: '77' }), ctx],
    ['pr が負', impl, savedOf({ pr: -1 }), ctx],
  ]
  for (const [name, item, saved, c] of rows) assert.equal(m.closedCleanupCandidate(item, saved, c), null, name)
})

// ---- 2. cleanupClosedMergedWorktree ----

const bindOk = { state: 'MERGED', headRefOid: SHA, headRefName: 'feat/2-x', baseRefName: 'main', isCrossRepository: false, closingIssues: [2] }
function stub(behavior) {
  const calls = []
  const logs = []
  globalThis.agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    return behavior(opts, prompt)
  }
  globalThis.log = (msg) => { logs.push(msg) }
  return { calls, logs }
}
const labelsOf = (calls) => calls.map((c) => c.opts.label)
const mergedWrites = (calls) => calls.filter((c) => c.opts.label.startsWith('state:update:#2') && c.prompt.includes('"merged"'))

test('MERGED かつ結び付き成立: --head つきの discard で掃除し、掃除のあとで merged・pr・unverifiedPr: 0・worktree: "" を書く。ブランチは消さない', async () => {
  const s = stub((opts) => {
    if (opts.label.startsWith('pr-bind:')) return bindOk
    if (opts.label.startsWith('state:cleanup')) return { ok: true, retained: false }
    return { ok: true }
  })
  const note = await m.cleanupClosedMergedWorktree(impl, { pr: 77, worktree: WT, branch: 'feat/2-x' })
  assert.match(note, /worktree を破棄して状態を merged/)
  const labels = labelsOf(s.calls)
  assert.deepEqual(labels.filter((l) => l !== 'state:update:#2:fallback-sonnet'), ['pr-bind:#2', 'state:cleanup:#2', 'state:update:#2'])
  const cleanup = s.calls[1].prompt
  assert.match(cleanup, new RegExp(`worktree-remove\\.sh remove --mode discard --path '${WT}' --head '${SHA}'$`, 'm'))
  assert.doesNotMatch(cleanup, /--branch/, 'ブランチは消さない')
  assert.doesNotMatch(cleanup, /state\.sh/, '状態の書き込みは掃除エージェントに持たせない')
  const w = s.calls[2].prompt
  assert.match(w, /"status":\s*"merged"/)
  assert.match(w, /"pr":\s*77/)
  assert.match(w, /"unverifiedPr":\s*0/)
  assert.match(w, /"worktree":\s*""/)
  assert.ok(m.confirmedRemovedPaths.has(WT))
  assert.ok(!m.sweepHeldPaths.has(WT))
})

const NO_CHANGE = [
  ['未マージの CLOSED', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, state: 'CLOSED' } : undefined), /マージ済みではない/],
  ['OPEN', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, state: 'OPEN' } : undefined), /マージ済みではない/],
  ['取得失敗（UNKNOWN）', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, state: 'UNKNOWN', headRefOid: '', headRefName: '', baseRefName: '', isCrossRepository: true, closingIssues: [-1] } : undefined), /結び付きを確認できない/],
  ['結び付き不成立（head のブランチ名が違う）', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, headRefName: 'feat/3-x' } : undefined), /結び付きを確認できない/],
  ['結び付き不成立（別イシューに紐付く）', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, closingIssues: [3] } : undefined), /結び付きを確認できない/],
  ['結び付き不成立（base が違う）', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, baseRefName: 'dev' } : undefined), /結び付きを確認できない/],
  ['結び付き不成立（fork）', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, isCrossRepository: true } : undefined), /結び付きを確認できない/],
  ['PR の取得が null', (o) => (o.label.startsWith('pr-bind:') ? null : undefined), /結び付きを確認できない/],
  ['headRefOid が 40 桁でない', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, headRefOid: 'abc123' } : undefined), /head を取得できない/],
  ['headRefOid に大文字', (o) => (o.label.startsWith('pr-bind:') ? { ...bindOk, headRefOid: 'C'.repeat(40) } : undefined), /head を取得できない/],
]
for (const [name, bindBehavior, expected] of NO_CHANGE) {
  test(`状態も worktree も触らない: ${name}`, async () => {
    const s = stub((opts) => {
      const b = bindBehavior(opts)
      if (b !== undefined) return b
      if (opts.label.startsWith('pr-bind:')) return bindOk
      return { ok: true, retained: false }
    })
    const note = await m.cleanupClosedMergedWorktree(impl, { pr: 77, worktree: WT, branch: 'feat/2-x' })
    assert.match(note, expected)
    assert.deepEqual(labelsOf(s.calls), ['pr-bind:#2'], '掃除も状態の書き込みも起動しない')
  })
}

const RETAINED = [
  ['HEAD 不一致・lock・汚れなどで保持（ok:false・retained:true）', () => ({ ok: false, retained: true })],
  ['ok だが保持', () => ({ ok: true, retained: true })],
  ['掃除の結果なし（StructuredOutput 未返却）', () => null],
  ['掃除が例外', () => { throw new Error('boom') }],
]
for (const [name, cleanupBehavior] of RETAINED) {
  test(`掃除が保持した: ${name} → 状態を書かず、最終スイープの候補にも載せない`, async () => {
    const s = stub((opts) => {
      if (opts.label.startsWith('pr-bind:')) return bindOk
      if (opts.label.startsWith('state:cleanup')) return cleanupBehavior()
      return { ok: true }
    })
    const note = await m.cleanupClosedMergedWorktree(impl, { pr: 77, worktree: '/repo/wt/keep', branch: 'feat/2-x' })
    assert.match(note, /worktree を保持した。状態は変更しない/)
    assert.equal(mergedWrites(s.calls).length, 0, 'merged を書かない')
    assert.equal(s.calls.filter((c) => c.opts.label.startsWith('state:update')).length, 0, '状態の書き込みを一切起動しない')
    assert.ok(!m.confirmedRemovedPaths.has('/repo/wt/keep'))
    assert.ok(m.sweepHeldPaths.has('/repo/wt/keep'), '削除を確認できるまで最終スイープから除外したまま')
    const sw = stub(() => ({ removed: [] }))
    assert.deepEqual(await m.sweepClosedWorktrees([]), [])
    assert.ok(sw.calls.every((c) => !c.prompt.includes('/repo/wt/keep')), '最終スイープのエージェントにパスが渡らない')
  })
}

test('掃除のあとの状態更新が失敗しても例外にしない（次の実行が同じ経路で再試行する）', async () => {
  stub((opts) => {
    if (opts.label.startsWith('pr-bind:')) return bindOk
    if (opts.label.startsWith('state:cleanup')) return { ok: true, retained: false }
    return { ok: false }
  })
  const note = await m.cleanupClosedMergedWorktree(impl, { pr: 77, worktree: '/repo/wt/other', branch: 'feat/2-x' })
  assert.match(note, /状態の更新に失敗/)
})

test('worktreeRemoveCommand: --head は discard・--path・40 桁の小文字 16 進のときだけ付く', () => {
  assert.match(m.worktreeRemoveCommand('discard', WT, '', SHA), new RegExp(`remove --mode discard --path '${WT}' --head '${SHA}'$`))
  assert.doesNotMatch(m.worktreeRemoveCommand('discard', WT, ''), /--head/)
  assert.doesNotMatch(m.worktreeRemoveCommand('superseded', WT, '', SHA), /--head/)
  assert.doesNotMatch(m.worktreeRemoveCommand('discard', '', 'feat/2-x', SHA), /--head/)
  for (const bad of ['abc', SHA.toUpperCase(), `${SHA}0`, `${SHA.slice(1)}'`, '$(x)', '']) assert.doesNotMatch(m.worktreeRemoveCommand('discard', WT, '', bad), /--head/, bad)
})

// ---- 3. 実装スクリプト全体でのホスト結合 ----

function tree(closed) {
  return {
    nodes: [
      { number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: 2 },
      { number: 2, title: 'issue 2', state: closed ? 'closed' : 'open', parent: 1, siblingIndex: 0, dependsOn: [], subIssuesTotal: 0 },
      { number: 3, title: 'issue 3', state: 'open', parent: 1, siblingIndex: 1, dependsOn: [], subIssuesTotal: 0 },
    ],
  }
}

function run({ saved = savedOf(), hashOk = true, bind = bindOk, cleanup = { ok: true, retained: false }, args = BASE_ARGS, extra = () => undefined } = {}) {
  const item = saved
  const hashes = { 2: hashOk ? m.sha256Hex(m.canonicalJson(item)) : 'f'.repeat(64) }
  const keysSha = m.sha256Hex(m.canonicalJson(Object.keys(hashes).sort()))
  return runScript({
    args,
    leaves: [2, 3],
    override: (label, opts, prompt) => {
      const x = extra(label, opts, prompt)
      if (x !== undefined) return x
      if (label === 'plan:issue-tree') return tree(true)
      if (label === 'state:load') return { ok: true, fileExisted: true, items: { 2: item }, highWaterBytes: 0, highWaterVersion: 0 }
      if (label === 'state:load-verify') return { fileExists: true, hashes, keysSha256: keysSha, keysCount: 1, highWaterBytes: 0, highWaterVersion: 0 }
      if (label === 'pr-bind:#2') return bind
      if (label === 'state:cleanup:#2') return cleanup
      return undefined
    },
  })
}
const callsOf = (calls, re) => calls.filter((c) => re.test(c.opts.label))
const skipEntry = (result) => result.done.find((r) => r.issue === 2)

test('結合: closed の子 + blocked + MERGED かつ記録どおり → --head つきで掃除し、そのあとで merged へ更新する。skip の status は変わらない', async () => {
  const { result, calls } = await run()
  const labels = labelsOf(calls)
  const bind = labels.indexOf('pr-bind:#2')
  const cleanup = labels.indexOf('state:cleanup:#2')
  const merged = calls.findIndex((c) => c.opts.label.startsWith('state:update:#2') && c.prompt.includes('"status":"merged"'))
  assert.ok(bind >= 0 && cleanup > bind && merged > cleanup, `順序は pr-bind → 掃除 → merged の書き込み: ${[bind, cleanup, merged]}`)
  assert.match(calls[cleanup].prompt, new RegExp(`worktree-remove\\.sh remove --mode discard --path '${WT}' --head '${SHA}'`))
  assert.equal(skipEntry(result).status, 'skipped')
  assert.match(skipEntry(result).note, /^すでに closed。closed 後始末: PR #77 のマージ済みを確認し/)
  // 後始末は他のノードの着手を妨げない
  assert.ok(result.done.some((r) => r.issue === 3))
})

test('結合: monitoring でも同じ。unverifiedPr だけの項目は unverifiedPr の PR で確かめ、pr へ移して unverifiedPr を 0 にする', async () => {
  const { calls } = await run({ saved: savedOf({ status: 'monitoring', pr: 0, unverifiedPr: 88 }) })
  assert.match(callsOf(calls, /^pr-bind:#2/)[0].prompt, /88/)
  const w = calls.find((c) => c.opts.label.startsWith('state:update:#2') && c.prompt.includes('"status":"merged"'))
  assert.ok(w, 'merged を書く')
  assert.match(w.prompt, /"pr":88/)
  assert.match(w.prompt, /"unverifiedPr":0/)
})

const UNTOUCHED = [
  ['HEAD 不一致などで掃除が保持', { cleanup: { ok: false, retained: true } }, { cleanup: true }],
  ['掃除の結果なし', { cleanup: null }, { cleanup: true }],
  ['未マージの CLOSED', { bind: { ...bindOk, state: 'CLOSED' } }, {}],
  ['結び付き不成立', { bind: { ...bindOk, closingIssues: [3] } }, {}],
  ['規約外のブランチ名の PR（unverifiedPr だけ）', { saved: savedOf({ branch: 'worktree-wf_x-2', pr: 0, unverifiedPr: 88 }), bind: { ...bindOk, headRefName: 'worktree-wf_x-2' } }, {}],
  ['状態の照合が成立しない（項目のハッシュ不一致）', { hashOk: false }, { noBind: true }],
  ['dryRun', { args: { ...BASE_ARGS, dryRun: true } }, { noBind: true }],
  ['status が failed', { saved: savedOf({ status: 'failed' }) }, { noBind: true }],
  ['status が merged', { saved: savedOf({ status: 'merged' }) }, { noBind: true }],
  ['worktree の記録なし', { saved: savedOf({ worktree: '' }) }, { noBind: true }],
]
for (const [name, opts, expect] of UNTOUCHED) {
  test(`結合: 状態も worktree も触らない: ${name}`, async () => {
    const { calls, result } = await run(opts)
    const labels = labelsOf(calls)
    assert.equal(labels.some((l) => l.startsWith('state:update:#2') && calls.find((c) => c.opts.label === l && c.prompt.includes('"status":"merged"'))), false, 'merged を書かない')
    if (!expect.cleanup) assert.equal(callsOf(calls, /^state:cleanup:#2/).length, 0, '掃除を起動しない')
    if (expect.noBind) assert.equal(callsOf(calls, /^pr-bind:#2/).length, 0, 'PR の取得すら起動しない')
    // 最終スイープのエージェントに worktree のパスを渡さない
    assert.ok(callsOf(calls, /^worktree:sweep/).every((c) => !c.prompt.includes(WT)), '最終スイープに渡さない')
    if (!opts.args?.dryRun) assert.equal(skipEntry(result)?.status, 'skipped')
  })
}

test('結合: dryRun は書き込み系を起動せず、後始末の対象見込みだけを返す', async () => {
  const { result, calls } = await run({ args: { ...BASE_ARGS, dryRun: true } })
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.closedCleanupPending, { count: 1, first: [2], maxAgentCalls: 6 })
  assert.equal(callsOf(calls, /^(pr-bind|state:cleanup|state:update)/).length, 0)
})

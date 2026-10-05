// 状態ファイル読込の内容照合（state:load-verify）と PR・issue の結び付け照合の回帰テスト。
//
// 事故（Phase 6 ラン）: state:load の haiku が約 48KB の状態ファイルをツール出力の 2KB プレビュー
// でしか見られず、残りの items を推測で埋めて返した（PR 番号は issue 番号 + 1006 の連番の捏造。
// 件数は実ファイルと一致）。isValidStateLoadResult は型と形しか見ないため採用され、runOne の
// resumable 判定・monitor / merge-exec の MERGED 受理が headRefName を照合しなかったため、未実装の
// issue が別 issue の MERGED PR で close された。
//
// 検証の三層構造（state-write-fallback.test.mjs と同型）:
//   1. 純粋関数（sha256Hex / canonicalJson / verifyLoadedItems / prBindingProblem）の入出力表。
//      canonicalJson の期待値は jq 1.8.1 の `jq -jcS` 出力の sha256 を固定値として埋め込む
//      （テストから jq を呼ばない。ランナーの jq バージョン差で揺れないため）。
//   2. スタブ agent による loadState の振る舞い（捏造 items・検証未返却・新規作成）。
//   3. ソース走査（配線検証）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, '..', 'scripts', 'implement-issue-tree.src.js')
const SAMPLE_STATE_PATH = join(HERE, '..', 'sample', 'state-example.json')
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)

globalThis.args = { parent: 1 }

const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-state-verify-'))
const slicePath = join(sliceDir, 'implement-issue-tree-state-verify-defs.mjs')
const SLICE_EXPORTS = [
  'sha256Hex',
  'canonicalJson',
  'verifyLoadedItems',
  'prBindingProblem',
  'loadState',
  'mergeVerifyPrompt',
  'monitorPrompt',
  'mergeExecutePrompt',
  'checkPrBinding',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)
const {
  sha256Hex,
  canonicalJson,
  verifyLoadedItems,
  prBindingProblem,
  loadState,
  mergeVerifyPrompt,
  monitorPrompt,
  mergeExecutePrompt,
  checkPrBinding,
} = await import(pathToFileURL(slicePath).href)

const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

// jq 1.8.1 で `jq -jcS --arg k "$k" '.items[$k]' sample/state-example.json | sha256sum` を実行した値。
const SAMPLE_JQ_HASHES = {
  42: 'c343d27a932798c0bb87a2c0d22c7427423b8a824d004e9ebfc53cfaf92668ae',
  43: 'bdb65d91dd3b17fd64c574c0a0843f84b84d5237607f80b1652be74a1a538fdc',
  44: '3ade2ae5dbeedcc16c6cf2619797ee85b97e49c2e48dee69a6e4395818d6dcbb',
  45: '9aba53f4b220229b479b32bde109a0cd1e422c06b26db2e78c19eeb600dbdee9',
}
const sampleItems = JSON.parse(readFileSync(SAMPLE_STATE_PATH, 'utf8')).items

// ---------------------------------------------------------------------------
// 層 1: 純粋関数
// ---------------------------------------------------------------------------

test('sha256Hex は node:crypto と一致する（ASCII・日本語・絵文字・DEL・空文字・ブロック境界長）', () => {
  const inputs = ['', 'abc', '状態ファイル', '😀𝒜', 'a\x7fb', 'x'.repeat(55), 'x'.repeat(56), 'y'.repeat(64), 'z'.repeat(1000)]
  for (const s of inputs) assert.equal(sha256Hex(s), nodeSha(s), JSON.stringify(s.slice(0, 20)))
})

test('canonicalJson + sha256Hex は jq -jcS | sha256sum と一致する（sample/state-example.json の全項目）', () => {
  assert.deepEqual(Object.keys(sampleItems).sort(), Object.keys(SAMPLE_JQ_HASHES).sort())
  for (const [k, expected] of Object.entries(SAMPLE_JQ_HASHES)) {
    assert.equal(sha256Hex(canonicalJson(sampleItems[k])), expected, `item ${k}`)
  }
})

test('canonicalJson はキー昇順・空白なし・DEL を \\u007f へエスケープする（jq 1.8.1 の実測出力と一致）', () => {
  const v = { s: 'a\x7fb\x01\x1f\t\n\\" é😀/<>&', n: [1, -2, 0, 123456789], z: null, t: true, o: { b: 1, a: { d: [], c: {} } }, キー: '値' }
  const jqOut = '{"n":[1,-2,0,123456789],"o":{"a":{"c":{},"d":[]},"b":1},"s":"a\\u007fb\\u0001\\u001f\\t\\n\\\\\\" é😀/<>&","t":true,"z":null,"キー":"値"}'
  assert.equal(canonicalJson(v), jqOut)
  assert.equal(sha256Hex(canonicalJson(v)), 'e145292f5956db2bc57183b563ea1fc2d14fed1cb5f16f5a1a6eefc68a7e6c2f')
})

test('verifyLoadedItems: 実ファイルと同一の items は全件採用し verified: true', () => {
  const r = verifyLoadedItems(sampleItems, { fileExists: true, hashes: SAMPLE_JQ_HASHES })
  assert.deepEqual(Object.keys(r.adopted).sort(), ['42', '43', '44', '45'])
  assert.deepEqual(r.dropped, [])
  assert.equal(r.verified, true)
})

test('verifyLoadedItems: 件数一致でも PR 番号を捏造（issue 番号 + 1006）した items は 1 件も採用しない', () => {
  const fabricated = Object.fromEntries(
    Object.entries(sampleItems).map(([k, v]) => [k, { ...v, pr: Number(k) + 1006 }]),
  )
  assert.equal(Object.keys(fabricated).length, Object.keys(SAMPLE_JQ_HASHES).length)
  const r = verifyLoadedItems(fabricated, { fileExists: true, hashes: SAMPLE_JQ_HASHES })
  assert.deepEqual(r.adopted, {})
  assert.deepEqual(r.dropped.sort(), ['42', '43', '44', '45'])
  assert.equal(r.verified, false)
})

test('verifyLoadedItems: 一部だけ捏造された場合は一致した項目のみ採用する（項目単位の fail-closed）', () => {
  const partly = { ...sampleItems, 44: { ...sampleItems[44], branch: 'feat/359-other-issue' } }
  const r = verifyLoadedItems(partly, { fileExists: true, hashes: SAMPLE_JQ_HASHES })
  assert.deepEqual(Object.keys(r.adopted).sort(), ['42', '43', '45'])
  assert.deepEqual(r.dropped, ['44'])
  assert.equal(r.verified, false)
})

test('verifyLoadedItems: 読込側が項目を省いた場合は採用分が一致しても verified: false', () => {
  const { 45: _omitted, ...rest } = sampleItems
  const r = verifyLoadedItems(rest, { fileExists: true, hashes: SAMPLE_JQ_HASHES })
  assert.deepEqual(Object.keys(r.adopted).sort(), ['42', '43', '44'])
  assert.deepEqual(r.dropped, [])
  assert.equal(r.verified, false)
})

test('verifyLoadedItems: 検証未返却・ファイルなし申告・不正ハッシュ・特殊キーはすべて不採用', () => {
  assert.deepEqual(verifyLoadedItems(sampleItems, null).adopted, {})
  assert.equal(verifyLoadedItems(sampleItems, null).verified, false)
  assert.deepEqual(verifyLoadedItems(sampleItems, { fileExists: false, hashes: SAMPLE_JQ_HASHES }).adopted, {})
  const upper = Object.fromEntries(Object.entries(SAMPLE_JQ_HASHES).map(([k, h]) => [k, h.toUpperCase()]))
  assert.deepEqual(verifyLoadedItems(sampleItems, { fileExists: true, hashes: upper }).adopted, {})
  const evil = JSON.parse('{"__proto__": {"status": "merged"}, "0": {}}')
  const r = verifyLoadedItems(evil, {
    fileExists: true,
    hashes: JSON.parse(`{"__proto__": "${sha256Hex(canonicalJson({ status: 'merged' }))}", "0": "${sha256Hex('{}')}"}`),
  })
  assert.deepEqual(Object.keys(r.adopted), [])
  assert.equal(Object.getPrototypeOf(r.adopted), Object.prototype)
  assert.equal(r.verified, false)
})

test('verifyLoadedItems: 空ファイル（items: {}）は空のまま verified: true（新規作成直後）', () => {
  const r = verifyLoadedItems({}, { fileExists: true, hashes: {} })
  assert.deepEqual(r, { adopted: {}, dropped: [], verified: true })
})

test('prBindingProblem: 別 issue（#359）のブランチ・closingIssues の PR は結び付けない', () => {
  const merged359 = { state: 'MERGED', isCrossRepository: false, headRefName: 'feat/359-foo', closingIssues: [359] }
  assert.notEqual(prBindingProblem(365, 'feat/365-bar', merged359), '')
  // ブランチは一致しても closingIssuesReferences が別 issue のみを指すなら結び付けない
  assert.notEqual(prBindingProblem(365, 'feat/365-bar', { state: 'MERGED', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [359] }), '')
  // 取得不能・UNKNOWN・closingIssues 欠落は fail-closed
  assert.notEqual(prBindingProblem(365, 'feat/365-bar', null), '')
  assert.notEqual(prBindingProblem(365, 'feat/365-bar', { state: 'UNKNOWN', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [] }), '')
  assert.notEqual(prBindingProblem(365, 'feat/365-bar', { state: 'MERGED', isCrossRepository: false, headRefName: 'feat/365-bar' }), '')
  // fork（isCrossRepository: true）・isCrossRepository 欠落は結び付けない
  assert.equal(prBindingProblem(365, 'feat/365-bar', { state: 'OPEN', isCrossRepository: true, headRefName: 'feat/365-bar', closingIssues: [365] }), 'cross-repository')
  assert.equal(prBindingProblem(365, 'feat/365-bar', { state: 'OPEN', headRefName: 'feat/365-bar', closingIssues: [365] }), 'cross-repository')
  // 期待ブランチ自体が本 issue の命名でなければ、headRefName と一致しても結び付けない
  assert.notEqual(prBindingProblem(365, 'feat/359-foo', { state: 'MERGED', isCrossRepository: false, headRefName: 'feat/359-foo', closingIssues: [365] }), '')
  assert.notEqual(prBindingProblem(365, 'misc-branch', { state: 'OPEN', isCrossRepository: false, headRefName: 'misc-branch', closingIssues: [] }), '')
  // 期待ブランチが不正値なら一致させない
  assert.notEqual(prBindingProblem(365, '', { state: 'OPEN', isCrossRepository: false, headRefName: '', closingIssues: [] }), '')
})

test('prBindingProblem: 本 issue のブランチで closingIssues が空か本 issue を含めば結び付ける', () => {
  assert.equal(prBindingProblem(365, 'feat/365-bar', { state: 'MERGED', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [] }), '')
  assert.equal(prBindingProblem(365, 'feat/365-bar', { state: 'OPEN', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [365, 400] }), '')
  assert.equal(prBindingProblem(365, 'feat/365-bar', { state: 'CLOSED', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [365] }), '')
})

// ---------------------------------------------------------------------------
// 層 2: loadState の振る舞い（スタブ agent）
// ---------------------------------------------------------------------------

function installAgentStub(behavior) {
  const calls = []
  globalThis.agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    return behavior(opts)
  }
  const logs = []
  globalThis.log = (msg) => { logs.push(msg) }
  return { calls, logs }
}

const loadResult = (items, extra = {}) => ({ ok: true, fileExisted: true, items, highWaterBytes: 0, highWaterVersion: 0, ...extra })

test('loadState: 捏造 items（PR = issue + 1006）は採用せず状態なしで返す（throw しない）', async () => {
  const fabricated = Object.fromEntries(Object.entries(sampleItems).map(([k, v]) => [k, { ...v, pr: Number(k) + 1006 }]))
  const { calls, logs } = installAgentStub((opts) =>
    opts.label === 'state:load'
      ? loadResult(fabricated)
      : { fileExists: true, hashes: SAMPLE_JQ_HASHES, highWaterBytes: 0, highWaterVersion: 0 })
  const r = await loadState()
  assert.deepEqual(r.items, {})
  assert.equal(r.verified, false)
  assert.deepEqual(calls.map((c) => c.opts.label), ['state:load', 'state:load-verify'])
  // 検証エージェントには読込結果を渡さない（鸚鵡返し防止）。
  assert.ok(!calls[1].prompt.includes('1049'), '検証プロンプトに読込結果が混入している')
  assert.ok(logs.some((l) => /内容照合で 4 件を不採用/.test(l)))
})

test('loadState: 実ファイルと一致する items は採用し、高水位は両エージェント一致時のみ採用する', async () => {
  installAgentStub((opts) =>
    opts.label === 'state:load'
      ? loadResult(sampleItems, { highWaterBytes: 4096, highWaterVersion: 2 })
      : { fileExists: true, hashes: SAMPLE_JQ_HASHES, highWaterBytes: 4096, highWaterVersion: 2 })
  const r = await loadState()
  assert.deepEqual(Object.keys(r.items).sort(), ['42', '43', '44', '45'])
  assert.equal(r.verified, true)
  assert.equal(r.highWaterBytes, 4096)
  assert.equal(r.highWaterVersion, 2)

  installAgentStub((opts) =>
    opts.label === 'state:load'
      ? loadResult(sampleItems, { highWaterBytes: 4096, highWaterVersion: 2 })
      : { fileExists: true, hashes: SAMPLE_JQ_HASHES, highWaterBytes: 1, highWaterVersion: 2 })
  const mismatch = await loadState()
  assert.equal(mismatch.highWaterBytes, 0)
  assert.equal(mismatch.highWaterVersion, 0)
})

test('loadState: 検証エージェントが haiku / sonnet とも未返却なら全項目不採用（throw しない）', async () => {
  installAgentStub((opts) => (opts.label === 'state:load' ? loadResult(sampleItems) : null))
  const r = await loadState()
  assert.deepEqual(r.items, {})
  assert.equal(r.verified, false)
})

test('loadState: 新規作成（items: {}）は検証成立で verified: true', async () => {
  installAgentStub((opts) =>
    opts.label === 'state:load'
      ? { ok: true, fileExisted: false, items: {}, highWaterBytes: 0, highWaterVersion: 2 }
      : { fileExists: true, hashes: {}, highWaterBytes: 0, highWaterVersion: 2 })
  const r = await loadState()
  assert.deepEqual(r.items, {})
  assert.equal(r.verified, true)
  assert.equal(r.highWaterVersion, 2)
})

// ---------------------------------------------------------------------------
// 層 3: プロンプト・駆動部の配線
// ---------------------------------------------------------------------------

test('検証プロンプトは項目ごとの jq -jcS ハッシュを要求し、読込プロンプトは分割読みと推測禁止を指示する', async () => {
  const { calls } = installAgentStub((opts) =>
    opts.label === 'state:load' ? loadResult({}) : { fileExists: true, hashes: {}, highWaterBytes: 0, highWaterVersion: 0 })
  await loadState()
  assert.match(calls[1].prompt, /jq -jcS --arg k "\$k" '\.items\[\$k\]'/)
  // キーは issue 番号（正の整数の 10 進表記）だけに絞り、「キー ハッシュ」行の解釈を一意にする。
  assert.ok(calls[1].prompt.includes(`keys[] | select(test("^[1-9][0-9]*$"))`))
  assert.match(calls[1].prompt, /sha256sum/)
  assert.match(calls[1].prompt, /shasum -a 256/)
  assert.match(calls[0].prompt, /5 件ずつ/)
  assert.match(calls[0].prompt, /推測で埋めない/)
})

test('mergeVerifyPrompt は headRefName と closingIssuesReferences を取得させる', () => {
  const p = mergeVerifyPrompt({ number: 365 }, { prNumber: 1371 })
  assert.ok(p.includes('gh pr view 1371 --json state,headRefOid,mergeCommit,headRefName,closingIssuesReferences,isCrossRepository'))
  assert.ok(p.includes('closingIssues'))
})

test('monitorPrompt 手順 1 は PR 照合不一致で MERGED でも ready にせず blocked / unrecoverable を返させる', () => {
  const p = monitorPrompt({ number: 365 }, { prNumber: 1366, branch: 'feat/365-bar' }, [], true, false)
  const step1 = p.slice(p.indexOf('1. まず gh pr view'), p.indexOf('\n', p.indexOf('1. まず gh pr view')))
  assert.ok(step1.includes('--json state,headRefOid,mergeable,headRefName,closingIssuesReferences,isCrossRepository'))
  assert.ok(step1.includes('"feat/365-bar" と完全一致しない'))
  assert.ok(step1.includes('#365 を含まない'))
  assert.ok(step1.includes('MERGED でも'))
  assert.ok(step1.indexOf('blockedReason: "unrecoverable" を返す（ready にしない）') < step1.indexOf('state が MERGED の場合'))
})

test('mergeExecutePrompt 手順 1 は PR 照合不一致で close せず wrong-target を返させ、MERGED 分岐より先に置く', () => {
  for (const allowMerge of [false, true]) {
    const p = mergeExecutePrompt({ number: 365 }, { prNumber: 1366, branch: 'feat/365-bar' }, allowMerge, [])
    const bindIdx = p.indexOf('イシューを close せず merged: false / reason: wrong-target を返す')
    const mergedIdx = p.indexOf('state が MERGED: マージ済み')
    assert.ok(bindIdx > 0, `allowMerge=${allowMerge}: PR 照合の分岐がない`)
    assert.ok(bindIdx < mergedIdx, `allowMerge=${allowMerge}: PR 照合が MERGED 分岐より後にある`)
    assert.ok(p.includes('--json state,headRefOid,mergeable,baseRefName,isDraft,headRefName,closingIssuesReferences,isCrossRepository'))
    assert.ok(p.includes('"feat/365-bar" と完全一致しない'))
  }
})

test('駆動部: isActiveMonitoring と runOne の resumable は branchMatchesIssue を要求する', () => {
  const start = driverPart.indexOf('function isActiveMonitoring(n)')
  const body = driverPart.slice(start, driverPart.indexOf('\n}\n', start))
  assert.match(body, /branchMatchesIssue\(s\.branch, n\)/)
  const resumableIdx = driverPart.indexOf('const resumable =')
  const resumable = driverPart.slice(resumableIdx, driverPart.indexOf('\n      if (', resumableIdx))
  assert.match(resumable, /branchMatchesIssue\(saved\.branch, item\.number\)/)
})

test('駆動部: runImplement は monitoring 再開前に PR 照合（pr-bind）し、不一致なら再開しない', () => {
  const start = driverPart.indexOf('async function runImplement(item)')
  const body = driverPart.slice(start, driverPart.indexOf('\nasync function ', start + 10))
  const resumeDecl = body.indexOf('let isResumeFromMonitoring = isActiveMonitoring(item.number)')
  const bindCheck = body.indexOf('const why = await checkPrBinding(item, saved.pr, saved.branch)')
  const resumeUse = body.indexOf('if (isResumeFromMonitoring) {\n    // 保存済みの pr')
  assert.ok(resumeDecl > 0 && bindCheck > resumeDecl, 'PR 照合の配線がない')
  assert.ok(resumeUse > bindCheck, 'PR 照合が monitoring 再開より後にある')
  const failBranch = body.slice(bindCheck, resumeUse)
  assert.match(failBranch, /isResumeFromMonitoring = false/)
  assert.doesNotMatch(failBranch, /updateState/, '照合失敗で状態ファイルを書き換えてはならない')
})

test('駆動部: merged 受理（already-merged を含む）は PR 照合を要求し、opt-in 前の MERGED 確認も照合する', () => {
  assert.match(driverPart, /const verifyBindIssue = prBindingProblem\(item\.number, impl\.branch, v\)/)
  assert.match(driverPart, /if \(!\(verifyStateOk && verifyHeadOk && !verifyBindIssue\)\) \{/)
})

test('駆動部: opt-in 前の MERGED 確認で PR 照合が不一致なら state を問わず blocked で終端する（allowMerge へ fail-open しない）', () => {
  const probeCheck = driverPart.indexOf('const probeBindIssue = prBindingProblem(item.number, impl.branch, mergedProbe)')
  const assign = driverPart.indexOf("prAlreadyMerged = mergedProbe?.state === 'MERGED'")
  const allowIdx = driverPart.indexOf('const allowMerge = !recoveryOnly && !prAlreadyMerged')
  assert.ok(probeCheck > 0 && probeCheck < assign && assign < allowIdx)
  const branch = driverPart.slice(probeCheck, assign)
  assert.match(branch, /if \(probeBindIssue\) \{\s*return await failMergeTerminal\(/)
  assert.match(branch, /'blocked'\)/)
})

test('駆動部: 新規 PR は pr-create 直後・Merge ループ投入前に PR 照合し、不一致なら blocked で終端する', () => {
  const created = driverPart.indexOf('impl = { ...impl, prNumber: prCreateResult.prNumber }')
  const check = driverPart.indexOf('const newPrBindIssue = await checkPrBinding(item, impl.prNumber, impl.branch)')
  const known = driverPart.indexOf('knownPrByIssue.set(item.number, impl.prNumber)', created)
  const loop = driverPart.indexOf('runMergeLoop(item, impl', created)
  assert.ok(created > 0 && check > created && check < known && known < loop, 'pr-create 後の PR 照合の位置が不正')
  const branch = driverPart.slice(check, known)
  assert.match(branch, /status: 'blocked'/)
  assert.match(branch, /return false/)
})

test('checkPrBinding: 例外・未返却・fork の PR は問題ありを返し、同一リポの本 issue ブランチは空文字を返す', async () => {
  const calls = []
  globalThis.log = () => {}
  globalThis.agent = async (prompt, opts) => { calls.push(opts.label); throw new Error('boom') }
  assert.equal(await checkPrBinding({ number: 365 }, 1371, 'feat/365-bar'), 'PR not found')
  globalThis.agent = async () => ({ state: 'OPEN', isCrossRepository: true, headRefName: 'feat/365-bar', closingIssues: [] })
  assert.equal(await checkPrBinding({ number: 365 }, 1371, 'feat/365-bar'), 'cross-repository')
  globalThis.agent = async (prompt, opts) => {
    calls.push(opts.label)
    assert.ok(prompt.includes('gh pr view 1371 --json'))
    return { state: 'OPEN', isCrossRepository: false, headRefName: 'feat/365-bar', closingIssues: [365] }
  }
  assert.equal(await checkPrBinding({ number: 365 }, 1371, 'feat/365-bar'), '')
  assert.deepEqual(calls, ['pr-bind:#365', 'pr-bind:#365'])
})

test('駆動部: ラン開始時の孤立 worktree 記録は状態ファイルの内容照合（verified）成立時のみ行う', () => {
  assert.match(driverPart, /verified: savedItemsVerified,/)
  assert.match(driverPart, /for \(const entry of mainWorktreePath && savedItemsVerified \? runStartOrphanEntries : \[\]\)/)
})

test('駆動部: ラン末尾の孤立 worktree 記録・削除は再読込の内容照合（verified）成立時のみ行う', () => {
  assert.match(driverPart, /const fresh = await enqueueStateWrite\(\(\) => loadState\(\)\)/)
  assert.match(driverPart, /freshVerified = fresh\.verified === true/)
  assert.match(driverPart, /for \(const entry of mainWorktreePathAtEnd && freshVerified \? orphanEntriesAtEnd : \[\]\)/)
})

test('駆動部: 未検証の PR 記録を「作成済み」と報告しない（markBlockedByDeps・interrupted）', () => {
  const start = driverPart.indexOf('async function markBlockedByDeps(')
  const body = driverPart.slice(start, driverPart.indexOf('\n}\n', start))
  assert.doesNotMatch(body, /PR #\$\{pr\} 作成済み/)
  assert.match(body, /PR_RECORD_UNVERIFIED\(pr\)/)
  const intStart = driverPart.indexOf('for (const n of interrupted) {')
  const intBody = driverPart.slice(intStart, driverPart.indexOf('\n}\n', intStart))
  assert.doesNotMatch(intBody, /作成済み/)
  assert.match(intBody, /PR_RECORD_UNVERIFIED\(pr\)/)
})

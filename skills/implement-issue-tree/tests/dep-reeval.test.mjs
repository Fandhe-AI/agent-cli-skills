// implement-issue-tree のスケジューラにおける「前提イシューのマージ後に依存ブロック項目を
// 同一ラン内で再判定する」回帰テスト（Issue #442）。
//
// 対象バグ: dispatch ループ（セクション 8）は各周回で post-order 走査し、依存に failedSet 入り
// した前提が 1 つでもあり、かつ全依存が確定していれば「その場で」markBlockedByDeps を呼び
// blocked を確定していた。markBlockedByDeps は failedSet へ追加するため、以後この項目は二度と
// 再評価されない。フロンティアの 1 件が Review 非収束等で blocked になり、その後前提がラン中に
// 人手マージされても、下流は同一ラン内で着手されず並列枠が遊んでいた（実運用で 48 件中 45 件が
// 連鎖ブロック）。
//
// 是正後の契約:
//   - blocked の即時確定を dispatch ループから除去し、判定を classifyDispatchReadiness に
//     一元化する（'ready' / 'dep-blocked' / 'wait'）。dispatch ループは 'dep-blocked' を保留
//     として扱い、確定はループ退出後の cascade（唯一の choke point）に委ねる。
//   - 保留中に前提が外部完了（Issue CLOSED / PR MERGED）したことをプローブで検知したら
//     applyPrereqTransitions で failedSet → done へ遷移させ、下流を classifyDispatchReadiness で
//     'ready' として同一ラン内で再判定する。
//
// 検証の二層構造（merge-loop-rescan.test.mjs / nopush-resolve-progress.test.mjs と同じ方針）:
//   1. 純粋関数（classifyDispatchReadiness / selectPrereqProbeTargets / classifyPrereqTransition /
//      applyPrereqTransitions / prereqProbePrompt）のテストで契約を固定する。
//   2. 駆動部（マーカーより下）はハーネス依存で import 不能のためソース走査で配線を機械検証する
//      — markBlockedByDeps の即時確定が dispatch ループ内に復活していないこと、cascade（唯一の
//      choke point）が classifyDispatchReadiness を経由すること、プローブ呼び出しが通常
//      dispatch の後・running.size===0 の break の前に位置することを固定する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'implement-issue-tree.js',
)
// マーカー文字列はソース中に 1 回しか現れてはならない（g0-gates.test.mjs が出現回数を固定して
// いる）ため、リテラルを直接書かず分割して組み立てる。
const DRIVER_MARKER = ['__IMPLEMENT', 'ISSUE', 'TREE', 'DRIVER', 'START__'].join('_')

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-dep-reeval-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
// 実装スクリプトは Workflow ランタイムの制約により `export const meta` 以外の top-level export を
// 持てない。定義部は非 export のまま置き、テスト側でスライスへ export 文を付与して読み込む。
const SLICE_EXPORTS = [
  'classifyDispatchReadiness',
  'selectPrereqProbeTargets',
  'classifyPrereqTransition',
  'applyPrereqTransitions',
  'prereqProbePrompt',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const {
  classifyDispatchReadiness,
  selectPrereqProbeTargets,
  classifyPrereqTransition,
  applyPrereqTransitions,
  prereqProbePrompt,
} = mod

// ---------------------------------------------------------------------------
// classifyDispatchReadiness: dispatch ループと cascade が共有する単一判定関数
// ---------------------------------------------------------------------------

test('classifyDispatchReadiness: 全依存が done なら ready', () => {
  const done = new Set([1, 2])
  assert.equal(classifyDispatchReadiness([1, 2], done, new Set()), 'ready')
})

test('classifyDispatchReadiness: failed 依存があり全依存が確定済みなら dep-blocked', () => {
  const done = new Set([1])
  const failedSet = new Set([2])
  assert.equal(classifyDispatchReadiness([1, 2], done, failedSet), 'dep-blocked')
})

test('classifyDispatchReadiness: 未確定の依存が残るなら wait（failed 依存があっても）', () => {
  const done = new Set()
  const failedSet = new Set([2])
  // 依存 1 が done でも failedSet でもない（まだ実行中）ため wait。dep-blocked へ早すぎる
  // 確定をしない（親が最初の子失敗で早すぎる blocked にならないための既存契約と同じ）。
  assert.equal(classifyDispatchReadiness([1, 2], done, failedSet), 'wait')
})

test('classifyDispatchReadiness: 依存が空なら ready', () => {
  assert.equal(classifyDispatchReadiness([], new Set(), new Set()), 'ready')
})

// ---------------------------------------------------------------------------
// selectPrereqProbeTargets: プローブ対象の選定
// ---------------------------------------------------------------------------

test('selectPrereqProbeTargets: failedSet 入りした前提のみを対象にする', () => {
  const work = [
    { number: 67 },
    { number: 80 },
    { number: 81 },
    { number: 90 },
  ]
  const depsMap = new Map([
    [67, new Set()],
    [80, new Set([67])],
    [81, new Set([80])],
    [90, new Set([67])],
  ])
  const done = new Set([90]) // 90 は前提 67 に依存するが自身は既に done（対象外）
  const failedSet = new Set([67])
  const targets = selectPrereqProbeTargets(work, depsMap, done, failedSet, new Map())
  assert.deepEqual(targets, [67])
})

test('selectPrereqProbeTargets: running 中の item は対象から除外する', () => {
  const work = [{ number: 80 }]
  const depsMap = new Map([[80, new Set([67])]])
  const failedSet = new Set([67])
  const runningMap = new Map([[80, Promise.resolve()]])
  assert.deepEqual(selectPrereqProbeTargets(work, depsMap, new Set(), failedSet, runningMap), [])
})

test('selectPrereqProbeTargets: 重複除去して昇順に返す', () => {
  const work = [{ number: 80 }, { number: 81 }]
  const depsMap = new Map([
    [80, new Set([67, 99])],
    [81, new Set([67])],
  ])
  const failedSet = new Set([67, 99])
  assert.deepEqual(selectPrereqProbeTargets(work, depsMap, new Set(), failedSet, new Map()), [67, 99])
})

// ---------------------------------------------------------------------------
// classifyPrereqTransition: enum 許可リストのみを遷移として受理する
// ---------------------------------------------------------------------------

test('classifyPrereqTransition: prState MERGED なら merged', () => {
  assert.equal(classifyPrereqTransition({ prState: 'MERGED', issueState: 'OPEN' }), 'merged')
})

test('classifyPrereqTransition: issueState CLOSED なら closed', () => {
  assert.equal(classifyPrereqTransition({ prState: 'NONE', issueState: 'CLOSED' }), 'closed')
})

test('classifyPrereqTransition: prState MERGED を issueState CLOSED より優先する', () => {
  assert.equal(classifyPrereqTransition({ prState: 'MERGED', issueState: 'CLOSED' }), 'merged')
})

test('classifyPrereqTransition: OPEN/UNKNOWN/NONE や不正値は null（fail-closed）', () => {
  assert.equal(classifyPrereqTransition({ prState: 'OPEN', issueState: 'OPEN' }), null)
  assert.equal(classifyPrereqTransition({ prState: 'UNKNOWN', issueState: 'UNKNOWN' }), null)
  assert.equal(classifyPrereqTransition({ prState: 'NONE', issueState: 'OPEN' }), null)
  assert.equal(classifyPrereqTransition({ prState: 'merged', issueState: 'OPEN' }), null, '小文字は許可リスト外')
  assert.equal(classifyPrereqTransition(null), null)
  assert.equal(classifyPrereqTransition(undefined), null)
  assert.equal(classifyPrereqTransition('MERGED'), null, '非オブジェクトは null')
})

// ---------------------------------------------------------------------------
// applyPrereqTransitions: ホスト側の二重フィルタ（targets 集合 × 整数検証）
// ---------------------------------------------------------------------------

test('applyPrereqTransitions: targets 内の MERGED を failedSet から done へ遷移する', () => {
  const done = new Set()
  const failedSet = new Set([67])
  const probe = { results: [{ issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 212 }] }
  const transitions = applyPrereqTransitions(probe, [67], done, failedSet)
  assert.deepEqual(transitions, [{ issue: 67, kind: 'merged', pr: 212 }])
  assert.ok(done.has(67))
  assert.ok(!failedSet.has(67))
})

test('applyPrereqTransitions: targets 外の番号は無視する（プローブ要求していない番号の捏造申告を防ぐ）', () => {
  const done = new Set()
  const failedSet = new Set([67])
  const probe = { results: [{ issue: 99, prState: 'MERGED', issueState: 'OPEN' }] }
  assert.deepEqual(applyPrereqTransitions(probe, [67], done, failedSet), [])
  assert.ok(!done.has(99))
})

test('applyPrereqTransitions: 非整数・文字列 issue は拒否する', () => {
  const done = new Set()
  const failedSet = new Set([67])
  const probe = { results: [{ issue: '67', prState: 'MERGED', issueState: 'OPEN' }] }
  assert.deepEqual(applyPrereqTransitions(probe, [67], done, failedSet), [])
  const probe2 = { results: [{ issue: 67.5, prState: 'MERGED', issueState: 'OPEN' }] }
  assert.deepEqual(applyPrereqTransitions(probe2, [67], done, failedSet), [])
})

test('applyPrereqTransitions: probe が null・results が非配列なら空配列で集合不変（fail-closed）', () => {
  const done = new Set()
  const failedSet = new Set([67])
  assert.deepEqual(applyPrereqTransitions(null, [67], done, failedSet), [])
  assert.deepEqual(applyPrereqTransitions({ results: 'not-array' }, [67], done, failedSet), [])
  assert.ok(failedSet.has(67), 'fail-closed で failedSet が変化してはならない')
})

test('applyPrereqTransitions: 同一 issue の重複 entry は最初の 1 件のみ採用する', () => {
  const done = new Set()
  const failedSet = new Set([67])
  const probe = {
    results: [
      { issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 1 },
      { issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 999 },
    ],
  }
  const transitions = applyPrereqTransitions(probe, [67], done, failedSet)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].pr, 1)
})

test('applyPrereqTransitions: pr が非正整数なら pr フィールドを持たない', () => {
  const done = new Set()
  const failedSet = new Set([67])
  const probe = { results: [{ issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 0 }] }
  const transitions = applyPrereqTransitions(probe, [67], done, failedSet)
  assert.deepEqual(transitions, [{ issue: 67, kind: 'merged' }])
})

// ---------------------------------------------------------------------------
// 受入条件 3 の本命: 前提 merged への遷移 → 下流の再判定
// ---------------------------------------------------------------------------

test('受入条件: 前提 67 が merged へ遷移すると下流 80 が dep-blocked → ready になる', () => {
  const depsMap = new Map([
    [67, new Set()],
    [80, new Set([67])],
  ])
  const done = new Set()
  const failedSet = new Set([67])
  assert.equal(classifyDispatchReadiness(depsMap.get(80), done, failedSet), 'dep-blocked')
  const probe = { results: [{ issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 212 }] }
  applyPrereqTransitions(probe, [67], done, failedSet)
  assert.equal(classifyDispatchReadiness(depsMap.get(80), done, failedSet), 'ready')
})

test('受入条件: 多段依存（81→80→67）で 67 merged 後も 81 は 80 が未確定のため wait のまま', () => {
  const depsMap = new Map([
    [67, new Set()],
    [80, new Set([67])],
    [81, new Set([80])],
  ])
  const done = new Set()
  const failedSet = new Set([67])
  const probe = { results: [{ issue: 67, prState: 'MERGED', issueState: 'OPEN', pr: 212 }] }
  applyPrereqTransitions(probe, [67], done, failedSet)
  assert.equal(classifyDispatchReadiness(depsMap.get(80), done, failedSet), 'ready', '80 は前提 67 の遷移で ready になる')
  assert.equal(classifyDispatchReadiness(depsMap.get(81), done, failedSet), 'wait', '81 は 80 がまだ done でないため wait のまま')
})

// ---------------------------------------------------------------------------
// prereqProbePrompt: 読み取り専用の権限境界
// ---------------------------------------------------------------------------

test('prereqProbePrompt: 対象の issue view / pr view を含み、書き込み系コマンドは含まない', () => {
  const prompt = prereqProbePrompt([67], { 67: 212 })
  assert.ok(prompt.includes('gh issue view 67 --json state'))
  assert.ok(prompt.includes('gh pr view <prNum67> --json state') || prompt.includes('gh pr view'))
  // 権限境界の説明文自体が「--json body」等を禁止語として言及するため、単純な文字列不在検査
  // では自己言及に誤反応する。実コマンド呼び出しの行（`gh issue view <N> --json ...` /
  // `gh pr view <N> --json ...`）を抽出し、state 以外のフィールドを含まないことを確認する。
  const issueViewCalls = [...prompt.matchAll(/gh issue view \S+ --json (\S+)/g)].map((m) => m[1])
  const prViewCalls = [...prompt.matchAll(/gh pr view \S+ --json (\S+)/g)].map((m) => m[1])
  assert.ok(issueViewCalls.length > 0, 'gh issue view コマンドが見つからない')
  assert.ok(prViewCalls.length > 0, 'gh pr view コマンドが見つからない')
  for (const fields of [...issueViewCalls, ...prViewCalls]) {
    assert.equal(fields, 'state', `--json フィールドは state のみであるべき（実際: ${fields}）`)
  }
  // 権限境界の説明文自体が「gh pr merge」「gh issue close」を禁止コマンドとして言及するため、
  // 単純な文字列不在検査は自己言及に誤反応する。「本エージェントは読み取り専用」「実行してよい
  // コマンドは次の 3 種のみ」という許可制の文言があることのみを確認する（許可制で 3 コマンドに
  // 限定されていれば、他コマンドは列挙されていても許可されない）。
  assert.ok(prompt.includes('読み取り専用'), '権限境界の宣言が見つからない')
  assert.ok(prompt.includes('次の 3 種のみ'), '許可コマンドを 3 種に限定する宣言が見つからない')
})

test('prereqProbePrompt: 非整数 target は throw する', () => {
  assert.throws(() => prereqProbePrompt([1.5], {}))
  assert.throws(() => prereqProbePrompt(['67'], {}))
})

// ---------------------------------------------------------------------------
// 配線検証: 駆動部（マーカーより下）がヘルパーを実際に経由すること
// ---------------------------------------------------------------------------

test('駆動部: dispatch ループ内即時確定が復活していない（markBlockedByDeps 呼び出しは cascade の 1 箇所のみ）', () => {
  const occurrences = [...driverPart.matchAll(/await markBlockedByDeps\(item, failedDeps\)/g)]
  assert.equal(occurrences.length, 1, 'markBlockedByDeps(item, failedDeps) 呼び出しは cascade の 1 箇所のみであるべき（dispatch ループ内での即時確定は禁止）')
})

test('駆動部: cascade が classifyDispatchReadiness を経由する', () => {
  const cascadeStart = driverPart.indexOf('依存失敗の連鎖を最終確定する')
  assert.ok(cascadeStart >= 0, 'cascade セクションが見つからない')
  const cascadeSection = driverPart.slice(cascadeStart, cascadeStart + 800)
  assert.ok(cascadeSection.includes("classifyDispatchReadiness(ds, done, failedSet) === 'dep-blocked'"), 'cascade が classifyDispatchReadiness を経由していない')
})

test('駆動部: プローブ呼び出しが通常 dispatch の後・running.size===0 の break の前に位置する', () => {
  const dispatchForStart = driverPart.indexOf('for (const item of work) {')
  assert.ok(dispatchForStart >= 0, 'dispatch ループの for 文が見つからない')
  const probeCallIdx = driverPart.indexOf('await probePrereqCompletion(probeTargets)')
  assert.ok(probeCallIdx > dispatchForStart, 'probePrereqCompletion 呼び出しが dispatch ループより前にある')
  const breakIdx = driverPart.indexOf('if (running.size === 0) break')
  assert.ok(breakIdx > probeCallIdx, 'running.size===0 の break が probePrereqCompletion 呼び出しより前にある（プローブが break 後に回っている）')
})

test('駆動部: Promise.race 後に必ず clearTimeout が存在する（tick timer のリーク防止）', () => {
  const raceIdx = driverPart.indexOf('await Promise.race(running.values())')
  assert.ok(raceIdx >= 0, '通常経路の Promise.race(running.values()) が見つからない')
  const clearTimeoutIdx = driverPart.indexOf('clearTimeout(')
  assert.ok(clearTimeoutIdx >= 0, 'clearTimeout 呼び出しが見つからない（tick timer が張りっぱなしになる回帰）')
})

// PR #444 Bugbot Medium (Tick delay collapses recheck interval) の回帰: 今回の周回で
// プローブを実際に実行した直後（prereqProbeLastAt がリセット済み）は cooldownRemainingMs が
// 常に PREREQ_RECHECK_MIN_MS 満了まで巻き戻り、min(TICK_MS, cooldownRemainingMs) が
// TICK_MS ではなく MIN_MS に潰れて定期監視が約5倍の頻度で prereq:probe を呼び続けてしまう。
// tickDelayMs の算出式が「今回の周回で probe 済みかどうか」を明示的に見て、probe 済みなら
// 短縮せず TICK_MS を使うことをソース走査で固定する。
test('駆動部: tick delay 算出は今回周回のプローブ済みフラグで短縮を打ち切る（cooldown 明け待ちのみ短縮する）', () => {
  const tickDelayIdx = driverPart.indexOf('const tickDelayMs =')
  assert.ok(tickDelayIdx >= 0, 'tickDelayMs の算出式が見つからない')
  const tickDelaySection = driverPart.slice(driverPart.lastIndexOf('const cooldownRemainingMs', tickDelayIdx), tickDelayIdx + 300)
  assert.ok(
    tickDelaySection.includes('probedThisIteration'),
    'tickDelayMs の算出が probedThisIteration を参照していない（今回周回でのプローブ実行直後に短縮してしまう回帰）',
  )
  const probedFlagIdx = driverPart.indexOf('const probedThisIteration =')
  assert.ok(probedFlagIdx >= 0, 'probedThisIteration の定義が見つからない')
  assert.ok(
    driverPart.slice(probedFlagIdx, probedFlagIdx + 120).includes('prereqProbeAtIterationSeq === dispatchIterationSeq'),
    'probedThisIteration が prereqProbeAtIterationSeq === dispatchIterationSeq で判定されていない',
  )
})

test('駆動部: schema: PREREQ_PROBE_SCHEMA を伴う agent 呼び出しが存在する', () => {
  assert.ok(driverPart.includes('schema: PREREQ_PROBE_SCHEMA'), 'プローブ agent 呼び出しに PREREQ_PROBE_SCHEMA が使われていない')
})

// 回復済み失敗が halt の連続カウントに残らないこと（Cursor Bugbot 指摘: Halt count ignores
// recovered failures）。probePrereqCompletion が failedSet → done へ遷移させ failures から
// エントリを除去する際、'blocked'（元々 halt 非カウント）以外なら consecutiveFailures を
// 対称的に 1 減じ、0 未満にはしないこと（recordFailure の 3360 行付近の increment と対で減算する）。
test('駆動部: probePrereqCompletion の failures 除去は blocked 以外で consecutiveFailures を対称的に減じる', () => {
  const probeFnStart = driverPart.indexOf('async function probePrereqCompletion(targets) {')
  assert.ok(probeFnStart >= 0, 'probePrereqCompletion の定義が見つからない')
  const probeFnEnd = driverPart.indexOf('\nwhile (true) {', probeFnStart)
  assert.ok(probeFnEnd > probeFnStart, 'probePrereqCompletion の終端（dispatch ループ開始）が見つからない')
  const probeFnBody = driverPart.slice(probeFnStart, probeFnEnd)
  const spliceIdx = probeFnBody.indexOf('failures.splice(failuresIdx, 1)')
  assert.ok(spliceIdx >= 0, 'failures からの除去処理が見つからない')
  const afterSplice = probeFnBody.slice(spliceIdx, spliceIdx + 1100)
  assert.ok(
    /removedFailure\??\.status\s*!==\s*'blocked'/.test(afterSplice),
    '除去対象が blocked（halt 非カウント）だったかどうかの分岐が見つからない',
  )
  assert.ok(
    /consecutiveFailures\s*>\s*0/.test(afterSplice) && /consecutiveFailures--/.test(afterSplice),
    'consecutiveFailures を 0 未満にしない減算処理が見つからない',
  )
})

// PR #444 codex(github-actions[bot]) P1 / cursor[bot] Medium の回帰:
// A失敗→B成功(consecutiveFailuresが0へリセット)→C失敗、の後で A の外部完了を検知すると、
// removedFailure（A）が現在の連続失敗 streak（C 分のみ）に属するかを見ずに一律デクリメントし、
// C の分まで 1→0 に削れてしまい、その後 D・E が失敗しても「3 連続失敗」の halt が発火しなく
// なる実バグ。除去対象の failure が記録された「世代」（failureEpoch）と現在の世代が一致する
// 場合のみ減算することで、既にリセット済みの世代に属する failure の回復が現在の streak を
// 侵食しないことを固定する。
test('駆動部: consecutiveFailures の減算は removedFailure が現在の failureEpoch に属する場合のみ行う（世代をまたいだ回復は無視する）', () => {
  // failureEpoch の宣言（世代カウンタ）が存在すること
  assert.ok(
    /let\s+failureEpoch\s*=\s*0/.test(driverPart),
    'failureEpoch（世代カウンタ）の宣言が見つからない',
  )

  // recordFailure が push 時に現在の世代を failure オブジェクトへ刻んでいること
  const recordFailureStart = driverPart.indexOf('function recordFailure(failure) {')
  assert.ok(recordFailureStart >= 0, 'recordFailure の定義が見つからない')
  const recordFailureSection = driverPart.slice(recordFailureStart, recordFailureStart + 300)
  assert.ok(
    /failure\.streakEpoch\s*=\s*failureEpoch/.test(recordFailureSection) &&
      recordFailureSection.indexOf('failure.streakEpoch') < recordFailureSection.indexOf('failures.push(failure)'),
    'recordFailure が failures.push より前に failure.streakEpoch へ現在の世代を刻んでいない',
  )

  // 2 つの成功リセット箇所（verify-close 成功 / merged 確定）がいずれも failureEpoch を進める
  // こと（世代を進めないと、リセット前後の failure を区別できず本バグの再発を防げない）。
  const resetSites = [...driverPart.matchAll(/(?<!let )consecutiveFailures = 0\n(\s*failureEpoch\+\+)?/g)]
  assert.strictEqual(resetSites.length, 2, 'consecutiveFailures = 0（リセット箇所）が想定の 2 箇所でない')
  for (const m of resetSites) {
    assert.ok(m[1], `リセット箇所 "${m[0].trim()}" の直後で failureEpoch がインクリメントされていない`)
  }

  // probePrereqCompletion の減算条件が removedFailure.streakEpoch と現在の failureEpoch の
  // 一致を確認したうえで減算していること。
  const probeFnStart = driverPart.indexOf('async function probePrereqCompletion(targets) {')
  const probeFnEnd = driverPart.indexOf('\nwhile (true) {', probeFnStart)
  const probeFnBody = driverPart.slice(probeFnStart, probeFnEnd)
  const spliceIdx = probeFnBody.indexOf('failures.splice(failuresIdx, 1)')
  const afterSplice = probeFnBody.slice(spliceIdx, spliceIdx + 1100)
  assert.ok(
    /removedFailure\??\.streakEpoch\s*===\s*failureEpoch/.test(afterSplice),
    'removedFailure.streakEpoch と現在の failureEpoch を突き合わせる条件が見つからない（世代をまたいだ誤減算を防げない）',
  )
})

// 残置 worktree 上限ゲートの既定値回帰テスト（Issue #348）。
// 旧既定 20 では 1 イシューあたり最大 6 件（EPHEMERAL_RESERVE_PER_NEW_START）の積み増しにより
// 1 ラン 3 件で新規着手が頭打ちになっていた。本テストは既定値そのものと、それが導く
// 「10 イシュー以上/ラン」というキャパシティ算術、および fail-closed 経路（観測失敗時の
// 抑止・誤記拒否）が退行していないことを固定する。
//
// 読み込み方式は g0-gates.test.mjs と同一: 実装スクリプトは Workflow ハーネス専用文法
// （トップレベル return・注入グローバル args / agent / log / phase）を含み module として
// 丸ごと import できないため、__IMPLEMENT_ISSUE_TREE_DRIVER_START__ マーカーより上
// （定義部のみ）を一時ファイルへ切り出して import する。
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
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-residual-cap-defs-'))
const slicePath = join(sliceDir, 'implement-issue-tree-residual-cap-defs.mjs')
// 実装スクリプトは `export const meta` 以外の top-level export を持てない（Workflow 起動制約）
// ため、定義部は非 export のまま置き、切り出したスライス側で export 文を付与する。
const SLICE_EXPORTS = [
  'parseMaxResidualWorktrees',
  'DEFAULT_MAX_RESIDUAL_WORKTREES',
  'parseMaxResidualWorktreeBytes',
  'DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES',
  'EPHEMERAL_KIND_MAX',
  'EPHEMERAL_RESERVE_PER_NEW_START',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const {
  parseMaxResidualWorktrees,
  DEFAULT_MAX_RESIDUAL_WORKTREES,
  parseMaxResidualWorktreeBytes,
  DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES,
  EPHEMERAL_KIND_MAX,
  EPHEMERAL_RESERVE_PER_NEW_START,
} = mod

test('既定値は 100（未指定・null のいずれも DEFAULT_MAX_RESIDUAL_WORKTREES を返す）', () => {
  assert.equal(DEFAULT_MAX_RESIDUAL_WORKTREES, 100)
  assert.equal(parseMaxResidualWorktrees(undefined), 100)
  assert.equal(parseMaxResidualWorktrees(null), 100)
})

test('0 は上限なしの明示オプトアウトとして通り、正の整数はそのまま返る', () => {
  assert.equal(parseMaxResidualWorktrees(0), 0)
  assert.equal(parseMaxResidualWorktrees(5), 5)
  assert.equal(parseMaxResidualWorktrees(250), 250)
})

test('負値・非整数・文字列・NaN は fail-closed で throw する（誤記拒否の維持）', () => {
  assert.throws(() => parseMaxResidualWorktrees(-1))
  assert.throws(() => parseMaxResidualWorktrees(1.5))
  assert.throws(() => parseMaxResidualWorktrees('20'))
  assert.throws(() => parseMaxResidualWorktrees(NaN))
})

test('EPHEMERAL_RESERVE_PER_NEW_START は EPHEMERAL_KIND_MAX の合計から導出され 6 のまま不変', () => {
  const expected = Object.values(EPHEMERAL_KIND_MAX).reduce((a, b) => a + b, 0)
  assert.equal(EPHEMERAL_RESERVE_PER_NEW_START, expected)
  assert.equal(EPHEMERAL_RESERVE_PER_NEW_START, 6)
})

test('キャパシティ算術: 既定値・最悪積み増し 6 件/イシューでも 10 イシュー以上/ランに着手できる', () => {
  // 受け入れ条件（Issue #348）: 開始時残置 0 の前提で、既定設定のまま 10 件以上のツリーを
  // 1 ランで消化できること。この床の算術を回帰として固定する。
  const capacity = Math.floor(parseMaxResidualWorktrees(undefined) / EPHEMERAL_RESERVE_PER_NEW_START)
  assert.ok(capacity >= 10, `既定値からのキャパシティが 10 未満に退行した: ${capacity}`)
})

test('fail-closed 分岐（スキャン失敗時の新規着手抑止）がスクリプト全体に存在する', () => {
  // 上限引き上げが観測失敗時の抑止ロジックを消していないことのソース存在確認（軽量な退行検知）。
  // この分岐はスケジューラ（駆動部）側にあり DRIVER_MARKER より下のためスクリプト全文で確認する。
  // バイト軸（Issue #348 案 B）追加により条件は件数軸単独の判定から OR 判定
  // （residualGateActive）へ拡張されているため、その形へ合わせて確認する。
  assert.match(
    source,
    /if \(!scanFailureDetail && residualGateActive\) {/,
  )
  assert.match(source, /newStartSuppressed/)
})

// --- バイト軸（maxResidualWorktreeBytes。Issue #348 案 B・PR #390 codex-review 指摘対応）---
// 件数軸だけでは配布先リポジトリのファイル量に依存する実バイト消費を捉えられないため、
// リポジトリ非依存の絶対閾値を独立した第2軸として併用する。検証・既定値・0 の意味・
// throw 条件は件数軸の parseMaxResidualWorktrees と同型のため、同じ観点で固定する。

test('バイト軸の既定値は 2 GiB（未指定・null のいずれも DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES を返す）', () => {
  assert.equal(DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES, 2 * 1024 * 1024 * 1024)
  assert.equal(parseMaxResidualWorktreeBytes(undefined), 2 * 1024 * 1024 * 1024)
  assert.equal(parseMaxResidualWorktreeBytes(null), 2 * 1024 * 1024 * 1024)
})

test('バイト軸の 0 はこの軸のみの明示オプトアウトとして通り、正の整数はそのまま返る', () => {
  assert.equal(parseMaxResidualWorktreeBytes(0), 0)
  assert.equal(parseMaxResidualWorktreeBytes(1024), 1024)
})

test('バイト軸の負値・非整数・文字列・NaN は fail-closed で throw する（誤記拒否の維持）', () => {
  assert.throws(() => parseMaxResidualWorktreeBytes(-1))
  assert.throws(() => parseMaxResidualWorktreeBytes(1.5))
  assert.throws(() => parseMaxResidualWorktreeBytes('2147483648'))
  assert.throws(() => parseMaxResidualWorktreeBytes(NaN))
})

test('両軸は独立に検証される（件数軸の値はバイト軸の検証・既定値に影響しない）', () => {
  // 件数軸を明示オプトアウト（0）にしても、バイト軸は独立に既定値のまま検証されること
  // （件数軸 0 がバイト軸の fail-closed まで無効化する fail-open を防ぐ）。
  assert.equal(parseMaxResidualWorktrees(0), 0)
  assert.equal(parseMaxResidualWorktreeBytes(undefined), DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES)
})

test('バイト測定の呼び出しと OR 判定・latch 保持がスクリプト全体に存在する', () => {
  assert.match(source, /measureResidualWorktreeBytes/)
  assert.match(source, /residualGateActive/)
  // 件数軸の途中経過再評価（3b/3c）・monitoring 再開の projected 判定は、比較式そのものは
  // 件数軸単独のまま維持する（可読性・過去の回帰固定のため）。該当行に maxResidualWorktreeBytes
  // が同居しないことを軽量に確認する。
  assert.match(source, /residualObservedAtStart \+ ephemeralWorktrees\.length > maxResidualWorktrees\b/)
  assert.doesNotMatch(
    source,
    /residualObservedAtStart \+ ephemeralWorktrees\.length > maxResidualWorktrees.*maxResidualWorktreeBytes/,
  )
})

// --- バイト軸のラン中再評価（Issue #348 codex-review 指摘・PR #390。measureResidualWorktreeBytes
// の追加呼び出しなしで perWorktreeByteReserve による安全側予約を dispatch ループの新規着手・
// monitoring 再開の両方に及ぼす）---

test('バイト軸はラン開始時の残置 0 件でもメイン worktree 測定で予約を確定できる構造になっている（開始時 0 件だと軸が丸ごと働かなかった穴の再発防止）', () => {
  // 旧実装は `maxResidualWorktreeBytes > 0 && residual.paths.length > 0` を条件にしていたため、
  // 開始時残置 0 件のランではバイト軸の測定自体がスキップされていた。修正後は
  // `maxResidualWorktreeBytes > 0` のみを条件にし、mainWorktreePath の独立測定で
  // perWorktreeByteReserve を確定する。
  assert.doesNotMatch(source, /if \(maxResidualWorktreeBytes > 0 && residual\.paths\.length > 0\)/)
  assert.match(source, /if \(maxResidualWorktreeBytes > 0\) {/)
  assert.match(source, /mainWorktreePath \? await measureResidualWorktreeBytes\(\[mainWorktreePath\]\)/)
  assert.match(source, /perWorktreeByteReserve = Math\.max\(mainKib \* 1024, avgResidualBytes\)/)
})

test('新規着手・monitoring 再開の両方が perWorktreeByteReserve による projected バイト判定を持つ', () => {
  assert.match(
    source,
    /residualBytesAtStart \+ ephemeralWorktrees\.length \* perWorktreeByteReserve > maxResidualWorktreeBytes/,
  )
  const projectedByteOccurrences = source.match(/const projectedBytes =/g) ?? []
  assert.ok(
    projectedByteOccurrences.length >= 2,
    'projectedBytes 系の計算式（新規着手・monitoring 再開の双方）が見つからない',
  )
})

test('容量軸のラン中再評価: 開始時残置 0 件でも 1 worktree あたりの予約が大きいと件数上限より先に新規着手を止める', () => {
  // 実装の projected バイト計算式（(a) 恒久 latch の単純形。予約 reservedUnits=0 の近似）を
  // そのまま模倣する。1 worktree ≈ 1.5 GiB（既定 2 GiB 上限に対し数件で到達する大きさ）の
  // 配布先で、件数軸だけなら 100/6 ≈ 16 イシュー着手できるはずが、バイト軸により
  // 数イシュー以内で止まることを固定する（Issue #348 codex-review 指摘の核心シナリオ）。
  const maxResidualWorktreeBytes = DEFAULT_MAX_RESIDUAL_WORKTREE_BYTES // 2 GiB
  const perWorktreeByteReserve = 1.5 * 1024 * 1024 * 1024 // 1 worktree ≈ 1.5 GiB
  const residualBytesAtStart = 0 // 開始時残置 0 件（旧実装ではバイト軸が丸ごと不成立になっていたケース）
  let ephemeralCount = 0
  let suppressedAtIssue = null
  for (let issue = 1; issue <= 10; issue++) {
    const projected = residualBytesAtStart + (ephemeralCount + EPHEMERAL_RESERVE_PER_NEW_START) * perWorktreeByteReserve
    if (projected > maxResidualWorktreeBytes) {
      suppressedAtIssue = issue
      break
    }
    ephemeralCount += 1 // 1 イシューあたり最低 1 worktree（implement）を積み増す近似
  }
  assert.ok(
    suppressedAtIssue !== null && suppressedAtIssue <= 2,
    `1 worktree ≈1.5GiB のとき 2 GiB 上限は 1〜2 イシュー目で抑止されるべきだが suppressedAtIssue=${suppressedAtIssue}`,
  )
})

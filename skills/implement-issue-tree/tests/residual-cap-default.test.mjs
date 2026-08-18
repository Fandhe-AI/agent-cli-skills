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
  'LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES',
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
  LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES,
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

// --- bytesAxisDisabled フォールバック（codex-review 指摘・PR #390 第 2 ラウンド）---
// 件数軸既定 100 の根拠は本リポジトリ 1 件のみの実測であり、リポジトリ非依存の絶対閾値である
// バイト軸が併用されている前提で許容される。利用者がバイト軸のみを明示オプトアウト
// （maxResidualWorktreeBytes: 0）し件数軸を未指定のままにした場合、この補強が働かないため
// 件数軸自体を安全側の旧既定値へ自動的に引き下げる。

test('LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES は 20（旧既定値のまま不変）', () => {
  assert.equal(LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES, 20)
})

test('bytesAxisDisabled が true のとき、未指定・null は旧既定 20 を返す（バイト軸オプトアウト時の安全側フォールバック）', () => {
  assert.equal(parseMaxResidualWorktrees(undefined, true), LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES)
  assert.equal(parseMaxResidualWorktrees(null, true), LEGACY_DEFAULT_MAX_RESIDUAL_WORKTREES)
})

test('bytesAxisDisabled が false・未指定のときは従来どおり既定 100 のまま（回帰なし）', () => {
  assert.equal(parseMaxResidualWorktrees(undefined, false), DEFAULT_MAX_RESIDUAL_WORKTREES)
  assert.equal(parseMaxResidualWorktrees(undefined), DEFAULT_MAX_RESIDUAL_WORKTREES)
})

test('bytesAxisDisabled が true でも利用者が明示指定した値は上書きしない', () => {
  assert.equal(parseMaxResidualWorktrees(5, true), 5)
  assert.equal(parseMaxResidualWorktrees(0, true), 0)
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
  // perWorktreeByteReserve を確定する。mainKib の測定は measureMainWorktreeContentBytes へ
  // 委譲する（共有 .git object store を除外した working tree 相当のみを floor に使うため。
  // PR #390 codex-review P1・Cursor Bugbot High: 素の du 値は object store 全量を含み過大予約
  // になっていた）。
  assert.doesNotMatch(source, /if \(maxResidualWorktreeBytes > 0 && residual\.paths\.length > 0\)/)
  assert.match(source, /if \(maxResidualWorktreeBytes > 0\) {/)
  assert.match(source, /mainWorktreePath \? await measureMainWorktreeContentBytes\(mainWorktreePath\)/)
  assert.match(source, /perWorktreeByteReserve = Math\.max\(mainKib \* 1024, avgResidualBytes\)/)
})

test('measureMainWorktreeContentBytes はメイン worktree 全体から .git を差し引いた working tree 相当を返す構造になっている（.git object store の過大予約防止）', () => {
  assert.match(source, /async function measureMainWorktreeContentBytes\(mainPath\)/)
  assert.match(source, /const gitPath = sanitizeWorktreePath\(`\$\{mainPath\}\/\.git`\)/)
  assert.match(source, /return Math\.max\(0, totalKib - gitKib\)/)
})

test('measureResidualWorktreeBytes はプロンプトへ渡す前に sanitizeWorktreePath で全パスを検証し、UNTRUSTED_POLICY を含める（codex-review P0 対応）', () => {
  assert.match(source, /const sanitizedPaths = paths\.map\(\(p\) => sanitizeWorktreePath/)
  assert.match(source, /if \(sanitizedPaths\.some\(\(p\) => p === ''\)\) {/)
  // measureResidualWorktreeBytes のプロンプト配列に UNTRUSTED_POLICY が直接含まれることを確認する
  // （du -sk の呼び出し指示より前の行に存在する = このプロンプトの一部であることの軽量確認）。
  const fnStart = source.indexOf('async function measureResidualWorktreeBytes(paths)')
  const fnBody = source.slice(fnStart, fnStart + 3000)
  assert.match(fnBody, /UNTRUSTED_POLICY,/)
  assert.match(fnBody, /xargs -0 du -sk/)
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

// --- バイト軸のラン中「実測し直し」（codex-review 指摘 5・PR #390 第 2 ラウンド）---
// perWorktreeByteReserve は開始時に確定する floor 値であり、ビルド成果物等でラン中に 1
// worktree が floor を超えて成長した場合、projection（floor × 台帳件数）だけでは実際の
// ディスク消費を過小評価し得る。台帳の積み増しが一定件数に達するたびに実測し直し、
// 実測超過を独立に検知して新規着手を止める構造になっていることをソース存在確認する。

test('ラン中の実測し直し（remeasureResidualBytesIfDue）が dispatch ループの毎周回冒頭で呼ばれる', () => {
  assert.match(source, /async function remeasureResidualBytesIfDue\(\)/)
  assert.match(source, /const BYTE_REMEASURE_LEDGER_INTERVAL = 3/)
  assert.match(source, /await remeasureResidualBytesIfDue\(\)/)
})

test('実測し直しは残置パス一覧＋台帳パスの合計を測定し、上限超過時に newStartSuppressed を立てる', () => {
  const fnStart = source.indexOf('async function remeasureResidualBytesIfDue()')
  const fnEnd = source.indexOf('\nwhile (true) {', fnStart)
  const fnBody = source.slice(fnStart, fnEnd)
  assert.match(fnBody, /residualPathsAtStart, \.\.\.ephemeralWorktrees\.map\(\(e\) => e\.path\)/)
  assert.match(fnBody, /actualBytes > maxResidualWorktreeBytes && !newStartSuppressed/)
})

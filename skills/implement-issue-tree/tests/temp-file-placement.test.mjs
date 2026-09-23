// メイン worktree 直下への一時ファイル残置事故（Issue #497）の回帰テスト。
//
// 背景: vector-db #861 ツリーのラン中、メイン worktree（リポジトリルート）直下に空ファイル
// `.lines`（0 バイト）が作られ、ラン終了後も残った。作成元は特定できていないが、
// measureResidualWorktreeBytesDetailed が `${tmpFile}.lines` という絶対パスのリテラルを
// プロンプト内に複数回書き下ろす構造を持ち、1 箇所でも写し間違えれば相対パス
// （カレント直下の `.lines`）へ化ける経路を持っていた（唯一 `.lines`（複数形）という
// ファイル名を生成する箇所）。本テストは、この経路の硬化（変数の単一代入・二重引用符参照・
// 件数照合）と、再発検出用のメイン worktree 未追跡ファイル検査（AC2）の両方を固定する。
//
// 読み込み方式は他の回帰テストと同一: 実装スクリプトは Workflow ハーネス専用文法（トップレベル
// return・注入グローバル args / agent / log / phase）を含み module として丸ごと import
// できないため、__IMPLEMENT_ISSUE_TREE_DRIVER_START__ マーカーより上（定義部のみ）を
// 一時ファイルへ切り出して import する。agent() を呼ぶ非同期関数（measure*・scan*）は
// グローバル注入前提のため直接呼び出さず、他の回帰テスト（remeasureResidualBytesNow 等）と
// 同じ「ソーステキストの部分一致固定」で契約を確認する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'implement-issue-tree.src.js',
)
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-temp-file-placement-defs-'))
const slicePath = join(sliceDir, 'implement-issue-tree-temp-file-placement-defs.mjs')
// 実装スクリプトは `export const meta` 以外の top-level export を持てない（Workflow 起動制約）
// ため、定義部は非 export のまま置き、切り出したスライス側で export 文を付与する。
const SLICE_EXPORTS = [
  'COMMON',
  'MERGE_CONTEXT_COMMON',
  'BASE_MERGE_CONTEXT_COMMON',
  'TEMP_FILE_POLICY',
  'UNTRUSTED_POLICY',
  'ORPHAN_BYTES_SCHEMA',
  'MAIN_UNTRACKED_SCHEMA',
  'diffMainWorktreeUntracked',
  'formatMainWorktreeUntrackedWarning',
  'sanitize',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const {
  COMMON,
  MERGE_CONTEXT_COMMON,
  BASE_MERGE_CONTEXT_COMMON,
  TEMP_FILE_POLICY,
  UNTRUSTED_POLICY,
  ORPHAN_BYTES_SCHEMA,
  MAIN_UNTRACKED_SCHEMA,
  diffMainWorktreeUntracked,
  formatMainWorktreeUntrackedWarning,
} = mod

// --- (a) COMMON 系が TEMP_FILE_POLICY / UNTRUSTED_POLICY をちょうど 1 回含む ---

function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1
    idx += needle.length
  }
  return count
}

test('COMMON は TEMP_FILE_POLICY と UNTRUSTED_POLICY をちょうど 1 回ずつ含む', () => {
  assert.equal(countOccurrences(COMMON, TEMP_FILE_POLICY), 1)
  assert.equal(countOccurrences(COMMON, UNTRUSTED_POLICY), 1)
})

test('MERGE_CONTEXT_COMMON は TEMP_FILE_POLICY と UNTRUSTED_POLICY をちょうど 1 回ずつ含む', () => {
  assert.equal(countOccurrences(MERGE_CONTEXT_COMMON, TEMP_FILE_POLICY), 1)
  assert.equal(countOccurrences(MERGE_CONTEXT_COMMON, UNTRUSTED_POLICY), 1)
})

test('BASE_MERGE_CONTEXT_COMMON は COMMON_LINES 由来の TEMP_FILE_POLICY 1 回のみを含む（UNTRUSTED_POLICY は専用文言で個別に付与するため 2 回になる）', () => {
  // BASE_MERGE_CONTEXT_COMMON は COMMON_LINES を index フィルタで再利用しつつ、UNTRUSTED_POLICY
  // だけは専用の「リポジトリ内ファイルを読まない」文言とセットで独自に追加し直す設計
  // （PR #443 codex P0）。TEMP_FILE_POLICY はフィルタ対象外の末尾要素のため 1 回のみのはず。
  assert.equal(countOccurrences(BASE_MERGE_CONTEXT_COMMON, TEMP_FILE_POLICY), 1)
})

// --- (b) measureResidualWorktreeBytesDetailed のプロンプト硬化（ソーステキスト固定） ---

function extractFunctionBody(fnSignature, stopSignature) {
  const start = source.indexOf(fnSignature)
  assert.ok(start >= 0, `関数 ${fnSignature} を特定できること`)
  const end = source.indexOf(stopSignature, start)
  assert.ok(end > start, `関数 ${fnSignature} の終端（${stopSignature}）を特定できること`)
  return source.slice(start, end)
}

test('measureResidualWorktreeBytesDetailed: TEMP_FILE_POLICY を含み、tmpFile リテラルの埋め込みは tf= 代入の1箇所に限られ、以降は "$tf" 参照になる', () => {
  const body = extractFunctionBody(
    'async function measureResidualWorktreeBytesDetailed(paths) {',
    'async function measureResidualWorktreeBytes(paths) {',
  )
  assert.match(body, /TEMP_FILE_POLICY/)
  // tmpFile の JS テンプレートリテラル埋め込みは、ヒアドキュメントの書き出し例と `tf=` 代入の
  // 2 箇所のみ（旧実装は `.lines` を含めて 5 箇所前後に埋め込んでいた）。
  const literalEmbeds = countOccurrences(body, '${tmpFile}')
  assert.ok(literalEmbeds <= 2, `tmpFile リテラルの埋め込み回数は 2 以下であるべき（実際: ${literalEmbeds}）`)
  // 引用なしの変数展開によるリダイレクト（例: > .lines のような相対パス化の温床）が無いこと。
  assert.doesNotMatch(body, />\s*\$\{tmpFile\}\.lines(?!['"])/)
  assert.match(body, /tf=\$\{tmpFile\}/)
  assert.match(body, /"\$tf\.lines"/)
  assert.match(body, /rm -f -- "\$tf" "\$tf\.lines"/)
  // 1 回の Bash 呼び出しで実行する指示を含む（Bash ツールは呼び出し間で変数を保持しないため）。
  assert.match(body, /1 回の Bash 呼び出しで実行/)
  // COUNT による件数照合（fail-closed 強化）。
  assert.match(body, /COUNT=\$count/)
  assert.match(body, /v\.count/)
})

test('measureFreeDiskKib: TEMP_FILE_POLICY を含み、tmpFile リテラルの埋め込みは最小化され "$tf" 参照へ統一されている', () => {
  const body = extractFunctionBody(
    'async function measureFreeDiskKib(path) {',
    'function findMainWorktreePath(entries) {',
  )
  assert.match(body, /TEMP_FILE_POLICY/)
  const literalEmbeds = countOccurrences(body, '${tmpFile}')
  assert.ok(literalEmbeds <= 2, `tmpFile リテラルの埋め込み回数は 2 以下であるべき（実際: ${literalEmbeds}）`)
  assert.match(body, /tf=\$\{tmpFile\}/)
  assert.match(body, /"\$tf\.line"/)
  assert.match(body, /rm -f -- "\$tf" "\$tf\.line"/)
  assert.match(body, /1 回の Bash 呼び出しで実行/)
})

// --- (c) ORPHAN_BYTES_SCHEMA の count 必須化（fail-closed 強化） ---

test('ORPHAN_BYTES_SCHEMA は count を required に含む', () => {
  assert.ok(ORPHAN_BYTES_SCHEMA.required.includes('count'))
  assert.equal(ORPHAN_BYTES_SCHEMA.properties.count.type, 'integer')
})

test('measureResidualWorktreeBytesDetailed: count が対象パス数と不一致なら null を返す fail-closed 分岐を持つ（ソーステキスト固定）', () => {
  const body = extractFunctionBody(
    'async function measureResidualWorktreeBytesDetailed(paths) {',
    'async function measureResidualWorktreeBytes(paths) {',
  )
  assert.match(body, /v\.count\s*===\s*sanitizedPaths\.length/)
  assert.match(body, /count が対象パス数と不一致/)
})

// --- (e) diffMainWorktreeUntracked ---

test('diffMainWorktreeUntracked: baseline に無い新規パスのみを added として返す', () => {
  const baseline = { observed: true, paths: ['/repo/existing.txt'] }
  const end = { observed: true, paths: ['/repo/existing.txt', '/repo/.lines'] }
  const result = diffMainWorktreeUntracked(baseline, end, '_/issue-trees/1.json')
  assert.equal(result.observed, true)
  assert.deepEqual(result.added, ['/repo/.lines'])
  assert.equal(result.baselineCount, 1)
})

test('diffMainWorktreeUntracked: baseline に既存のものは除外する', () => {
  const baseline = { observed: true, paths: ['/repo/a', '/repo/b'] }
  const end = { observed: true, paths: ['/repo/a', '/repo/b'] }
  const result = diffMainWorktreeUntracked(baseline, end, '')
  assert.deepEqual(result.added, [])
})

test('diffMainWorktreeUntracked: ホストが正規に書き込む状態ファイル自身は除外する', () => {
  const stateFile = '_/issue-trees/1.json'
  const baseline = { observed: true, paths: [] }
  const end = { observed: true, paths: [stateFile, '/repo/.lines'] }
  const result = diffMainWorktreeUntracked(baseline, end, stateFile)
  assert.deepEqual(result.added, ['/repo/.lines'])
})

test('diffMainWorktreeUntracked: 状態ファイルの mktemp 残骸（<stateFile>.XXXXXX）は除外しない（書き戻し失敗の痕跡のため警告対象に残す）', () => {
  const stateFile = '_/issue-trees/1.json'
  const residue = `${stateFile}.ab12cd`
  const baseline = { observed: true, paths: [] }
  const end = { observed: true, paths: [residue] }
  const result = diffMainWorktreeUntracked(baseline, end, stateFile)
  assert.deepEqual(result.added, [residue])
})

test('diffMainWorktreeUntracked: baseline / end のいずれかが未観測なら observed:false・added: []', () => {
  const observedEnd = { observed: true, paths: ['/repo/x'] }
  assert.deepEqual(diffMainWorktreeUntracked({ observed: false }, observedEnd, ''), { observed: false, added: [], baselineCount: 0 })
  assert.deepEqual(diffMainWorktreeUntracked(observedEnd, { observed: false }, ''), { observed: false, added: [], baselineCount: 0 })
})

// --- (f) formatMainWorktreeUntrackedWarning ---

test('formatMainWorktreeUntrackedWarning: added が空なら空文字を返す（警告を出さない）', () => {
  assert.equal(formatMainWorktreeUntrackedWarning({ observed: true, added: [] }), '')
  assert.equal(formatMainWorktreeUntrackedWarning({ observed: false, added: ['/x'] }), '')
})

test('formatMainWorktreeUntrackedWarning: 上限を超えた件数は省略し「ほか N 件」を付与する', () => {
  const added = Array.from({ length: 25 }, (_, i) => `/repo/file-${i}`)
  const warning = formatMainWorktreeUntrackedWarning({ observed: true, added }, 20)
  assert.match(warning, /ほか 5 件/)
  assert.match(warning, /file-0/)
  assert.doesNotMatch(warning, /file-24/)
})

test('formatMainWorktreeUntrackedWarning: バッククォート・$ を含むパスは sanitize されて出力される（未信頼データのため）', () => {
  const warning = formatMainWorktreeUntrackedWarning({ observed: true, added: ['/repo/$(rm -rf ~)`x`'] })
  // sanitize() は $ を \$ へエスケープしバッククォートを ' へ置換する。エスケープされていない
  // 生の $( や生のバッククォートが出力に残らないことを確認する。
  assert.doesNotMatch(warning, /[^\\]\$\(/)
  assert.doesNotMatch(warning, /`/)
})

// --- (g) scanMainWorktreeUntracked のプロンプトが破壊的操作を含まず例外時に throw しない ---

test('scanMainWorktreeUntracked: プロンプトが rm・git clean・git checkout -- を含まない読み取り専用タスクである', () => {
  const body = extractFunctionBody(
    'async function scanMainWorktreeUntracked(label) {',
    'function diffMainWorktreeUntracked(',
  )
  // プロンプトは「git clean・git checkout -- は一切行わない」という禁止の文言としてのみ
  // これらの語を含み、実行コマンドとして組み立てる箇所（例: 独立したシェル行）は持たない。
  assert.doesNotMatch(body, /^\s*git clean/m)
  assert.doesNotMatch(body, /^\s*git checkout --/m)
  assert.match(body, /一切行わない/)
  assert.match(body, /読み取り専用/)
  assert.match(body, /status --porcelain=v1 --untracked-files=all/)
})

test('scanMainWorktreeUntracked: 例外時は throw せず observed:false を返す（本処理を止めない）', () => {
  const body = extractFunctionBody(
    'async function scanMainWorktreeUntracked(label) {',
    'function diffMainWorktreeUntracked(',
  )
  assert.match(body, /catch \(e\) \{/)
  assert.match(body, /return \{ observed: false \}/)
})

// --- 駆動部の配線固定（dead code 化防止） ---

test('駆動部は scanMainWorktreeUntracked をラン開始直後（baseline）とラン終了直前（end）の2回呼ぶ', () => {
  const driverPart = source.slice(markerIndex)
  assert.match(driverPart, /const mainUntrackedBaseline = await scanMainWorktreeUntracked\('baseline'\)/)
  assert.match(driverPart, /const mainUntrackedEnd = await scanMainWorktreeUntracked\('end'\)/)
  assert.match(driverPart, /diffMainWorktreeUntracked\(mainUntrackedBaseline, mainUntrackedEnd, STATE_FILE\)/)
})

test('駆動部の返却値に mainWorktreeUntracked フィールドが含まれる', () => {
  const driverPart = source.slice(markerIndex)
  assert.match(driverPart, /mainWorktreeUntracked:\s*\{\s*observed:/)
})

test('駆動部は mainUntrackedDiff.added に対して削除コマンドを発行しない（警告のみ）', () => {
  const driverPart = source.slice(markerIndex)
  const idx = driverPart.indexOf('mainUntrackedDiff')
  const idxEnd = driverPart.indexOf('return { parent, baseBranch')
  const section = driverPart.slice(idx, idxEnd)
  assert.doesNotMatch(section, /rm -rf/)
  assert.doesNotMatch(section, /git worktree remove/)
})

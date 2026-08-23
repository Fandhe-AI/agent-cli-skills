// Issue #435 の回帰テスト: 作成時点から base とコンフリクトした PR が CI 未起動のまま
// blocked 終端し自動回復しないバグへの対応。push 前の base 最新化ゲート（prCreatePrompt /
// fixPrompt(pushAfterFix: true)）と、monitor の mergeable: CONFLICTING 検出ルーティング
// （monitorPrompt）をプロンプト契約として固定する。
//
// 読み込み方式は skills/implement-issue-tree/tests/g0-gates.test.mjs と同じ: 対象スクリプトは
// Workflow ハーネス専用文法（トップレベル return・注入グローバル args / agent / log / phase）を
// 含むため module として丸ごと import できない。__IMPLEMENT_ISSUE_TREE_DRIVER_START__ マーカー
// より上（定義部のみ）を一時ファイルへ切り出し、対象関数へ export を付与して import する。
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
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-conflict-gate-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
const SLICE_EXPORTS = ['prCreatePrompt', 'fixPrompt', 'monitorPrompt']
// fixPrompt は boundaryNonce() を内部で使う。本番では ensureBoundaryNonceSeed() が agent()
// 経由で乱数 seed を注入してから呼ばれるが、agent はこのスライスに未注入のため、テスト専用の
// setter を同一モジュールスコープへ追記して非 export の module-scope let（boundaryNonceSeed）
// へ疑似乱数値を直接注入する（g0-gates.test.mjs と同一パターン）。
const TEST_ONLY_SETTER =
  'export function __setBoundaryNonceSeedForTest(v) { boundaryNonceSeed = v }\n'
writeFileSync(
  slicePath,
  `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n${TEST_ONLY_SETTER}`,
)

const mod = await import(pathToFileURL(slicePath).href)
const { prCreatePrompt, fixPrompt, monitorPrompt } = mod

const item = { number: 435, title: 'テストイシュー' }
const impl = { prNumber: 777, branch: 'fix/435-conflict-gate' }

test('構造ガード: マーカーは 1 か所のみ存在し、対象 3 関数が import できる', () => {
  assert.equal(source.split(DRIVER_MARKER).length - 1, 1)
  assert.equal(typeof prCreatePrompt, 'function')
  assert.equal(typeof fixPrompt, 'function')
  assert.equal(typeof monitorPrompt, 'function')
})

test('prCreatePrompt: push 前 base 最新化ゲートが git push より前に現れる', () => {
  const prompt = prCreatePrompt(item, impl, [])
  const fetchIdx = prompt.indexOf('refs/remotes/origin/')
  const mergeIdx = prompt.indexOf('git merge --no-edit')
  const abortIdx = prompt.indexOf('git merge --abort')
  const pushIdx = prompt.indexOf('git push origin')
  assert.ok(fetchIdx >= 0, 'base fetch（保存先明示 refspec）の指示がない')
  assert.ok(mergeIdx >= 0, 'git merge --no-edit の指示がない')
  assert.ok(abortIdx >= 0, '解消不能時の git merge --abort 指示がない')
  assert.ok(pushIdx >= 0, 'git push origin の指示がない')
  assert.ok(fetchIdx < pushIdx, 'base fetch が git push より前に現れない')
  assert.ok(mergeIdx < pushIdx, 'git merge が git push より前に現れない')
  assert.ok(prompt.includes('prNumber: 0'), '解消不能時に prNumber: 0 を返す指示がない')
})

test('fixPrompt(pushAfterFix: true): push 行の前に必須 base merge 指示があり、コミット前に位置する', () => {
  mod.__setBoundaryNonceSeedForTest('a'.repeat(64))
  const finding = { summary: 'テスト用の指摘', unresolvedComments: [] }
  const prompt = fixPrompt(item, impl, finding, true)
  const checkoutIdx = prompt.indexOf('git checkout --detach origin/')
  const mergeIdx = prompt.indexOf('git merge --no-edit')
  const abortIdx = prompt.indexOf('git merge --abort')
  const pushIdx = prompt.indexOf('git push origin HEAD:refs/heads/')
  assert.ok(checkoutIdx >= 0, 'detached HEAD 取得の指示がない')
  assert.ok(mergeIdx >= 0, '必須 base merge の指示がない')
  assert.ok(abortIdx >= 0, '解消不能時の git merge --abort 指示がない')
  assert.ok(pushIdx >= 0, 'push 行がない')
  // 修正作業（コミット）より前に base 取り込みが行われることを、checkout 直後・push よりずっと
  // 前に merge 指示が現れる位置関係で確認する（コミット後の abort は作業を失うため禁止 —
  // Issue #435 レビュー時の指摘）。
  assert.ok(checkoutIdx < mergeIdx, 'base merge が checkout より前に現れている（順序異常）')
  assert.ok(mergeIdx < pushIdx, 'base merge が push より後に現れている')
  assert.ok(prompt.includes('必須'), 'base 取り込みが必須実行である旨の文言がない')
})

test('fixPrompt(pushAfterFix: false): push 行も必須 base merge ゲートの文言も含まない（既存契約の維持）', () => {
  mod.__setBoundaryNonceSeedForTest('a'.repeat(64))
  const finding = { summary: 'テスト用の指摘', unresolvedComments: [] }
  const prompt = fixPrompt(item, impl, finding, false)
  assert.ok(!prompt.includes('git push origin HEAD:refs/heads/'), 'push しない Review ループに push 指示が混入している')
  assert.ok(!prompt.includes('push 前 base 最新化ゲート（必須）'), 'push しない Review ループに push 前必須ゲートの文言が混入している')
})

test('monitorPrompt: 手順 1 の取得フィールドに mergeable が含まれる', () => {
  const prompt = monitorPrompt(item, impl, [], true, true)
  assert.ok(prompt.includes('--json state,headRefOid,mergeable'), '手順 1 の --json に mergeable が含まれない')
})

test('monitorPrompt: CONFLICTING を検出したら state: OPEN 限定で needs-fix へルーティングし、UNKNOWN を CONFLICTING と扱わない', () => {
  const prompt = monitorPrompt(item, impl, [], true, true)
  assert.ok(prompt.includes('CONFLICTING'), 'CONFLICTING 判定の記述がない')
  assert.ok(prompt.includes('state が OPEN の場合のみ判定する'), 'OPEN 限定の判定条件がない（MERGED/CLOSED との混線防止）')
  assert.ok(prompt.includes('needs-fix'), 'CONFLICTING 検出時の needs-fix ルーティングがない')
  assert.ok(
    prompt.includes('UNKNOWN を CONFLICTING と扱って fix 予算を空費しない'),
    'UNKNOWN を CONFLICTING と誤判定しない旨の指示がない',
  )
})

test('monitorPrompt: 手順 3e（チェック総数 0 件）が blocked へ進む前に mergeable を再確認する', () => {
  const prompt = monitorPrompt(item, impl, [], true, true)
  const idxE = prompt.indexOf('チェック総数が 0 件の場合は green とみなさず')
  assert.ok(idxE >= 0, '手順 3e の記述が見つからない')
  const sectionE = prompt.slice(idxE, idxE + 1200)
  assert.ok(sectionE.includes('mergeable'), '手順 3e に mergeable 再確認の指示がない')
  assert.ok(sectionE.includes('CONFLICTING の可能性'), '手順 3e の summary 例に CONFLICTING の可能性の言及がない')
})

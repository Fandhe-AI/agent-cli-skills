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

test('prCreatePrompt: push 前 base 最新化ゲートが git push より前に現れ、push は detached HEAD を直接指定する', () => {
  const prompt = prCreatePrompt(item, impl, [])
  const fetchIdx = prompt.indexOf('refs/remotes/origin/')
  const mergeIdx = prompt.indexOf('git merge --no-edit')
  const abortIdx = prompt.indexOf('git merge --abort')
  const pushIdx = prompt.indexOf('git push origin HEAD:refs/heads/')
  assert.ok(fetchIdx >= 0, 'base fetch（保存先明示 refspec）の指示がない')
  assert.ok(mergeIdx >= 0, 'git merge --no-edit の指示がない')
  assert.ok(abortIdx >= 0, '解消不能時の git merge --abort 指示がない')
  assert.ok(pushIdx >= 0, 'git push origin HEAD:refs/heads/<branch> 形式の push 指示がない（ローカルブランチ ref 未更新のまま push origin <branch> すると手順 0 の変更が失われる）')
  assert.ok(fetchIdx < pushIdx, 'base fetch が git push より前に現れない')
  assert.ok(mergeIdx < pushIdx, 'git merge が git push より前に現れない')
  assert.ok(prompt.includes('prNumber: 0'), '解消不能時に prNumber: 0 を返す指示がない')
  // git branch -f はブランチが別 worktree で checkout 済みの場合に失敗し得るため、実行対象
  // コマンドとしては使わない方針（手順 0 は detached HEAD のまま作業し、手順 1 は
  // HEAD:refs/heads/<branch> で直接 push する）。実行コマンド行に登場しないことを確認する
  // （「使わない理由」の説明文中に語として現れるのは許容する）。
  const pushLine = prompt.split('\n').find((l) => l.includes('git push origin HEAD:refs/heads/'))
  assert.ok(pushLine && !pushLine.includes('git branch -f'), 'push 行自体が git branch -f に依存している')
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
  assert.ok(prompt.includes('push 前 base 最新化ゲート（必須）'), 'base 取り込みが必須実行である旨のゲート文言がない')
  // git branch -f への依存を除去した回帰確認: 手順 4 は HEAD:refs/heads/<branch> で push する
  // ため、手順 0〜1 の間でローカルブランチ ref を更新する必要はない（別 worktree checkout 済み
  // 時の git branch -f 失敗を避ける設計。プレフィックス確認で pushAfterFix=false 側の
  // 「コミット後に git branch -f」文言との誤マッチを避ける）。
  assert.ok(!prompt.slice(0, pushIdx).includes('git branch -f'), 'base merge ゲートに不要な git branch -f への依存が残っている')
})

test('fixPrompt(pushAfterFix: true): base merge のみで解消した場合も push を省略しない指示を含む', () => {
  mod.__setBoundaryNonceSeedForTest('a'.repeat(64))
  const finding = { summary: 'mergeable: CONFLICTING（実測値）。base 取り込みとコンフリクト解消が必要。', unresolvedComments: [] }
  const prompt = fixPrompt(item, impl, finding, true)
  assert.ok(
    prompt.includes('この push を省略すると'),
    'base merge のみで完了した場合に push を省略してはならない旨の指示がない（省略すると detached HEAD の解消作業が worktree 破棄で失われる）',
  )
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

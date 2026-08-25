// articles#52（下流同期 PR）の codex P1 に対する回帰テスト: commitlint の rule tuple は
// [severity, when, value] であり、type-enum / scope-enum の列挙値は when が always なら許可リスト、
// never なら拒否リストになる。従来の手順は never を区別せず「候補が尽きたら type-enum 先頭へ
// フォールバック」「scope-enum から scope を選ぶ」としていたため、never 構成では明示的に禁止された
// 値を採用して commit-msg hook に拒否されていた。本テストは commitlintCheckInstruction と
// baseMergeInstruction の両方で、severity 0 の無視・always / never の解釈・never 列挙値への
// フォールバック禁止・never 全候補拒否時の fail-closed 終端が文言として固定されることを検証する。
//
// 読み込み方式は conflict-prepush-gate.test.mjs と同一: __IMPLEMENT_ISSUE_TREE_DRIVER_START__
// マーカーより上（定義部のみ）を一時ファイルへ切り出し、対象へ export を付与して import する。
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
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-commitlint-enum-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
const SLICE_EXPORTS = ['baseMergeInstruction', 'commitlintCheckInstruction']
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const { baseMergeInstruction, commitlintCheckInstruction } = await import(pathToFileURL(slicePath).href)

const merge = baseMergeInstruction('main')

test('構造ガード: baseMergeInstruction / commitlintCheckInstruction が import できる', () => {
  assert.equal(typeof baseMergeInstruction, 'function')
  assert.equal(typeof commitlintCheckInstruction, 'string')
  assert.ok(merge.includes('origin/main'))
})

test('両指示: rule tuple [severity, when, value] の解釈（severity 0 無視・always は許可リスト・never は拒否リスト）を含む', () => {
  for (const [label, text] of [['commitlintCheckInstruction', commitlintCheckInstruction], ['baseMergeInstruction', merge]]) {
    assert.ok(text.includes('[severity, when, value]'), `${label}: rule tuple の解釈がない`)
    assert.ok(text.includes('severity 0 の rule は無視'), `${label}: severity 0（disabled）を無視する指示がない`)
    assert.ok(text.includes('always') && text.includes('許可リスト'), `${label}: always = 許可リストの明記がない`)
    assert.ok(text.includes('never') && text.includes('拒否リスト'), `${label}: never = 拒否リストの明記がない`)
    // never の列挙値を候補に使わない旨（許可リスト扱いの禁止）
    assert.ok(/never の列挙値(を候補にしない|へフォールバックしない)/.test(text), `${label}: never の列挙値を採用しない明記がない`)
    // extends 継承時にプリセット側 rule を同じ規則で読む
    assert.ok(text.includes('extends') && text.includes('プリセット側の rule'), `${label}: extends プリセットの rule 解釈がない`)
  }
})

test('baseMergeInstruction: type-enum 先頭へのフォールバックは always に限定し、never 列挙値へはフォールバックしない', () => {
  const fallbackIdx = merge.indexOf('type-enum の先頭要素へフォールバックする')
  assert.ok(fallbackIdx >= 0, 'type-enum 先頭へのフォールバックがない')
  assert.ok(merge.lastIndexOf('always で全候補が不許可なら', fallbackIdx) >= 0, 'フォールバックの前提が always に限定されていない')
  const after = merge.slice(fallbackIdx, fallbackIdx + 120)
  assert.ok(after.includes('このフォールバックは always に限る'), 'フォールバックが always 限定である旨の文言がない')
  assert.ok(after.includes('never の列挙値へフォールバックしない'), 'never の列挙値へフォールバックしない旨がない')
})

test('baseMergeInstruction: never で全候補が拒否されたら git merge を実行せず (c) と同じ終端へ倒す（fail-closed）', () => {
  const idx = merge.indexOf('never で全候補が拒否されたら git merge を実行せず')
  assert.ok(idx >= 0, 'never 全候補拒否時の指示がない')
  const section = merge.slice(idx, idx + 120)
  assert.ok(section.includes('base merge subject の type を commitlint 設定から決定できない'), 'fail-closed の理由文言がない')
  assert.ok(section.includes('(c) と同じ終端へ倒す'), '(c) と同じ終端へ倒す旨がない')
})

test('baseMergeInstruction: type 候補は chore → build → ci → fix の後に Conventional Commits 標準 type へ続き、always / never の両条件で「許可される」を定義する', () => {
  assert.ok(merge.includes('chore → build → ci → fix → feat → docs → refactor → perf → test → style → revert'), '候補 type の順序が固定されていない')
  assert.ok(merge.includes('always なら列挙値に含まれる値、never なら列挙値に含まれない値'), 'always / never それぞれの「許可される」定義がない')
})

test('baseMergeInstruction: scope-empty は tuple 解釈（never = 必須・always = 禁止・severity 0 = 省略）、scope-enum never は禁止値を除いたフォールバック連鎖を使う', () => {
  assert.ok(merge.includes('scope-empty が [*, "never"]（scope 必須）の場合のみ付け'), 'scope-empty never = 必須の解釈がない')
  assert.ok(merge.includes('[*, "always"]（scope 禁止）・severity 0・未設定なら省略'), 'scope-empty always = 禁止 / 無効時省略の解釈がない')
  assert.ok(merge.includes('scope-enum が always ならそこから最も近い値'), 'scope-enum always 時の選択がない')
  assert.ok(merge.includes('scope-enum が never なら列挙値は禁止値なので'), 'scope-enum never = 禁止値の解釈がない')
  assert.ok(merge.includes('禁止値に該当しないものを使う'), 'フォールバック連鎖から禁止値を除外する指示がない')
  assert.ok(merge.includes('直前の implement / fix コミットの scope を再利用') && merge.includes('base ブランチ名'), '既存のフォールバック連鎖が残っていない')
})

test('commitlintCheckInstruction: scope-empty を tuple 解釈し、scope 必須時は決定連鎖で値を決め、決定できなければ fail-closed でコミットしない', () => {
  // codex P1（PR #438 2 巡目）: 共通指示が scope-empty: [2, "never"]（scope 必須）を考慮せず
  // 「該当する scope が無ければ省略」としていたため、scope-enum 無しで scope 必須のリポでは
  // impl / recover / fix の各コミットが commit-msg hook に必ず拒否されていた。
  const text = commitlintCheckInstruction
  assert.ok(text.includes('scope-empty は [*, "never"]（severity > 0）なら scope 必須'), 'scope-empty never = 必須の解釈がない')
  assert.ok(text.includes('[*, "always"] なら scope 禁止（付けない）'), 'scope-empty always = 禁止の解釈がない')
  assert.ok(text.includes('severity 0・未設定なら任意（該当する scope が無ければ scope を省略する）'), 'severity 0 / 未設定 = 任意（無ければ省略）の解釈がない')
  const chainIdx = text.indexOf('scope 必須のときは')
  assert.ok(chainIdx >= 0, 'scope 必須時の決定連鎖がない')
  const chain = text.slice(chainIdx)
  const enumIdx = chain.indexOf('scope-enum が always なら変更内容に最も近い列挙値')
  const prevIdx = chain.indexOf('直前コミットの scope（never の禁止値は除外）')
  const branchIdx = chain.indexOf('base ブランチ名の英数字以外を - に置換した値')
  assert.ok(enumIdx >= 0 && prevIdx > enumIdx && branchIdx > prevIdx, '決定連鎖（scope-enum always → 直前コミットの scope（never 禁止値除外） → base ブランチ名）の順序が固定されていない')
  assert.ok(chain.includes('^[A-Za-z0-9_-]{1,64}$'), '安全文字集合の検証がない')
  assert.ok(chain.includes('決定できなければコミットせず'), '決定不能時にコミットしない指示がない')
  assert.ok(chain.includes('commitlint の scope-empty が scope を要求するが決定できない'), 'fail-closed の理由文言がない')
  assert.ok(text.includes('scope にイシュー番号を置かない'), '「scope にイシュー番号を置かない」が維持されていない')
})

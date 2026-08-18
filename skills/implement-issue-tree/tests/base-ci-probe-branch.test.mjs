// implement-issue-tree の base CI プローブ（automerge-design.md「補償策の成立確認（base CI
// プローブ）」節）が、既定ブランチ決め打ちではなく **対象（マージ先）ブランチ** を検査すること
// の決定的回帰テスト（Issue #362）。
//
// 背景: プローブは `args.branch` で任意のマージ先（`release/1.0` 等）を指定できる本スキルの
// 補償策成立確認手順であるにもかかわらず、`gh repo view --json defaultBranchRef` で解決した
// 既定ブランチだけを無条件に検査していた。既定ブランチが green であれば、実際のマージ先で
// push CI が起動しない・失敗していても「補償策成立・base 健全」と誤判定する（fail-open 方向の
// 誤り）。修正（案 A 採用）はプローブの引数形式を `owner/repo[@branch]:workflow1,workflow2...`
// へ拡張し、`@branch` 省略時のみ既定ブランチへフォールバックするようにした。
//
// 3 群構成:
//   群 A（構造の固定）: 節内の ```bash ブロックがちょうど 1 個で決定的に抽出できること。
//   群 B（シェル構文の健全性）: 抽出ブロックが `bash -n` を通ること（case/クォートの編集ミス検出）。
//   群 C（契約の固定）: `@<branch>` 明示分岐の存在・`defaultBranchRef` の全出現がフォールバック
//     分岐内にあること・`db`/`db_enc` の残存が無いこと（改名漏れ検出）・jq への対象ブランチ
//     束縛（`--arg b "${branch}"`）・SKILL.md 側の前提条件記述の追随、をそれぞれ固定する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const DESIGN_DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'references', 'automerge-design.md',
)
const SKILL_MD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'SKILL.md',
)

const SECTION_HEADING = '**補償策の成立確認（base CI プローブ）**'
const NEXT_SECTION_HEADING = '- **不成立時の扱い（3 択・順に推奨）**:'

const doc = readFileSync(DESIGN_DOC_PATH, 'utf8')

const sectionStart = doc.indexOf(SECTION_HEADING)
const sectionEnd = doc.indexOf(NEXT_SECTION_HEADING, sectionStart)

test('前提: 節の見出しが両方とも存在する（見出し変更でテストが静かに空振りしないことの保証）', () => {
  assert.ok(sectionStart !== -1, '「補償策の成立確認（base CI プローブ）」見出しが見つからない')
  assert.ok(sectionEnd !== -1, '「不成立時の扱い」見出しが見つからない')
  assert.ok(sectionEnd > sectionStart, '見出しの順序が想定と異なる')
})

const section = doc.slice(sectionStart, sectionEnd)

// ---------------------------------------------------------------------------
// 群 A: 構造の固定 — ```bash ブロックがちょうど 1 個
// ---------------------------------------------------------------------------
const codeBlockMatches = [...section.matchAll(/```bash\n([\s\S]*?)\n {2}```/g)]

test('群A: 節内に bash コードブロックがちょうど 1 個ある', () => {
  assert.equal(
    codeBlockMatches.length,
    1,
    `想定外の bash コードブロック数: ${codeBlockMatches.length}`,
  )
})

const scriptBody = codeBlockMatches[0][1]
  .split('\n')
  .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
  .join('\n')

// ---------------------------------------------------------------------------
// 群 B: シェル構文の健全性 — bash -n
// ---------------------------------------------------------------------------
test('群B: 抽出したプローブスクリプトが bash -n を通る（構文エラーがない）', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'base-ci-probe-'))
  const scriptPath = join(tmpDir, 'probe.sh')
  try {
    writeFileSync(scriptPath, scriptBody, 'utf8')
    // execFileSync は非ゼロ終了で例外を投げるため、成功 = 構文エラーなしの直接証拠になる。
    execFileSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 群 C: 契約の固定
// ---------------------------------------------------------------------------
test('群C: entry を owner/repo[@branch] と workflow 集合へ分解する明示分岐がある', () => {
  assert.match(
    scriptBody,
    /case "\$\{target\}" in\s*\n\s*\*@\*\)\s*repo="\$\{target%%@\*\}";\s*branch="\$\{target#\*@\}"/,
    '`case "${target}" in *@*)` 相当の owner/repo[@branch] 明示分岐が見つからない',
  )
})

test('群C: defaultBranchRef の出現はすべてブランチ省略時のフォールバック分岐内にある', () => {
  const occurrences = [...scriptBody.matchAll(/defaultBranchRef/g)]
  assert.ok(occurrences.length >= 1, 'defaultBranchRef の出現が見つからない')

  // フォールバック分岐（else 節）は `if [ -n "${branch}" ]; then ... else` の else 側にある。
  // 全出現がその else マーカーより後ろにあることを固定する（明示分岐の中に既定ブランチ解決が
  // 紛れ込む退行を検出する。1 出現に固定しないのは、else 節内で JSON フィールド名 (--json
  // defaultBranchRef) と jq フィルタ (.defaultBranchRef.name) の 2 箇所に加え、取得失敗時の
  // エラーメッセージにも同語が出るため、実装として複数回出現するのが正当なケースのため）。
  const elseIndex = scriptBody.indexOf('  else\n    branch=$(gh repo view')
  assert.ok(elseIndex !== -1, 'ブランチ省略時のフォールバック分岐（else）が見つからない')
  for (const occurrence of occurrences) {
    assert.ok(
      occurrence.index > elseIndex,
      `defaultBranchRef の出現（index=${occurrence.index}）がフォールバック分岐より前（明示分岐側）にある`,
    )
  }
})

test('群C: db / db_enc の残存が無い（branch / branch_enc への改名漏れ検出）', () => {
  assert.doesNotMatch(scriptBody, /\bdb\b/, '変数名 db の残存を検出した（branch へ改名すること）')
  assert.doesNotMatch(
    scriptBody,
    /\bdb_enc\b/,
    '変数名 db_enc の残存を検出した（branch_enc へ改名すること）',
  )
})

test('群C: jq への対象ブランチ束縛が --arg b "${branch}" である', () => {
  assert.match(
    scriptBody,
    /--arg b "\$\{branch\}"/,
    '`--arg b "${branch}"` による jq への対象ブランチ束縛が見つからない',
  )
})

test('群C: 引数形式の説明が owner/repo[@branch] 形式を明示する', () => {
  assert.match(section, /owner\/repo\[@branch\]/, '引数形式の説明に owner/repo[@branch] が含まれない')
})

// ---------------------------------------------------------------------------
// SKILL.md 側の前提条件記述の追随
// ---------------------------------------------------------------------------
const skillMd = readFileSync(SKILL_MD_PATH, 'utf8')

test('SKILL.md: 旧文言「defaultBranchRef から既定ブランチを解決するプローブ」が残っていない', () => {
  assert.doesNotMatch(
    skillMd,
    /defaultBranchRef から既定ブランチを解決するプローブ/,
    'SKILL.md に既定ブランチ決め打ちの旧文言が残っている',
  )
})

test('SKILL.md: 参照節名が automerge-design.md の実在見出しと一致する', () => {
  assert.match(
    skillMd,
    /「補償策の成立確認（base CI プローブ）」節/,
    'SKILL.md の参照節名が想定と異なる',
  )
  assert.ok(
    doc.includes('補償策の成立確認（base CI プローブ）'),
    'automerge-design.md 側に対応する見出しが存在しない',
  )
})

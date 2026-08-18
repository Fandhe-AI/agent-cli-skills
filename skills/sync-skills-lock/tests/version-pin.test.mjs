// version-pin.test.mjs — Issue #380 の回帰テスト。
//
// `npx skills add` はバージョン未固定だと npx がレジストリの最新版を確認なしで
// 即実行するため、`skills`（vercel-labs/skills）パッケージが乗っ取られた場合に
// 任意コード実行の経路になる。この実行は Step 5 の差分確認・Step 6 のユーザー
// 承認より前に走るため、source の Fandhe-AI 完全一致検証では防げない。
//
// 固定版の正は scripts/skills-lock-update.sh の SKILLS_CLI_VERSION 変数であり、
// SKILL.md 側フェンスは同一リテラルを記載する契約（SKILL.md の
// 「skills CLI のバージョン固定と更新手順」節参照）。このテストは:
//   1. 両ファイルから固定版を抽出できること
//   2. 両者が exact semver（X.Y.Z。dist-tag・レンジ禁止）であること
//   3. 両者の値が完全一致すること（ドリフト検知）
//   4. どちらのファイルにも「skills@<version>」を伴わない未固定の
//      `npx skills add` が残っていないこと
// を検証する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_PATH = join(SKILL_DIR, 'scripts', 'skills-lock-update.sh')
const SKILL_MD_PATH = join(SKILL_DIR, 'SKILL.md')

const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/

function extractScriptVersion(content) {
  const m = content.match(/^readonly SKILLS_CLI_VERSION="([^"]*)"/m)
  return m ? m[1] : null
}

function extractSkillMdVersions(content) {
  // SKILL.md 内の `SKILLS_CLI_VERSION="X.Y.Z"` 代入をすべて拾う（前提条件の
  // 言及・Step 4 フェンス・更新手順節など複数箇所に登場し得るため全件対象）。
  const matches = [...content.matchAll(/SKILLS_CLI_VERSION="([^"]*)"/g)]
  return matches.map((m) => m[1])
}

test('scripts/skills-lock-update.sh は exact semver の SKILLS_CLI_VERSION を定義する', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf8')
  const version = extractScriptVersion(content)
  assert.ok(version, 'SKILLS_CLI_VERSION の代入行が見つからない')
  assert.match(version, EXACT_SEMVER, `dist-tag・レンジ禁止: ${version}`)
})

test('SKILL.md 内の SKILLS_CLI_VERSION 代入はすべて exact semver で、スクリプトと一致する', () => {
  const scriptVersion = extractScriptVersion(readFileSync(SCRIPT_PATH, 'utf8'))
  const skillMdVersions = extractSkillMdVersions(readFileSync(SKILL_MD_PATH, 'utf8'))
  assert.ok(skillMdVersions.length > 0, 'SKILL.md に SKILLS_CLI_VERSION 代入が見つからない')
  for (const v of skillMdVersions) {
    assert.match(v, EXACT_SEMVER, `dist-tag・レンジ禁止: ${v}`)
    assert.equal(v, scriptVersion, `SKILL.md (${v}) とスクリプト (${scriptVersion}) が不一致`)
  }
})

// 実際にシェルで実行されるコマンド行だけを対象にする。行頭（インデント許容）が
// `npx` で始まる行に限定し、地の文・見出し・インラインコード引用中の「npx skills add」
// 言及（バッククォート囲み等）を誤検出しないようにする。
function extractExecLines(content) {
  return content.split('\n').filter((line) => /^\s*npx\b/.test(line))
}

test('scripts/skills-lock-update.sh に未固定の npx skills add が残っていない', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf8')
  const execLines = extractExecLines(content).filter((line) => /\bskills\b/.test(line))
  assert.ok(execLines.length > 0, 'npx skills 実行行が見つからない（抽出ロジックの破損の可能性）')
  for (const line of execLines) {
    assert.match(line, /skills@\$\{SKILLS_CLI_VERSION\}/, `未固定の npx 実行: ${line}`)
  }
})

test('SKILL.md に未固定の npx skills add が残っていない', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const execLines = extractExecLines(content).filter((line) => /\bskills\b/.test(line))
  assert.ok(execLines.length > 0, 'npx skills 実行行が見つからない（抽出ロジックの破損の可能性）')
  for (const line of execLines) {
    assert.match(line, /skills@\$\{SKILLS_CLI_VERSION\}/, `未固定の npx 実行: ${line}`)
  }
})

test('scripts/skills-lock-update.sh は SKILLS_CLI_VERSION の形式ガードを持つ（fail-closed）', () => {
  const content = readFileSync(SCRIPT_PATH, 'utf8')
  assert.match(
    content,
    /SKILLS_CLI_VERSION.*=~.*\^\[0-9\]/,
    '形式ガード（正規表現チェック）が見つからない'
  )
})

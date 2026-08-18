// version-pin.test.mjs — Issue #393 の回帰テスト。
//
// `npx firebase-tools` はバージョン未固定だと npx がレジストリの最新版を
// 確認なしで即実行するため、`firebase-tools`（firebase/firebase-tools）
// パッケージが乗っ取られた場合に任意コード実行の経路になる。固定版の正は
// SKILL.md の「firebase-tools のバージョン固定と更新手順」節（Step 4・
// Step 6 の両フェンス内の `FIREBASE_TOOLS_VERSION` 代入）であり、実行
// フェンスが独立シェルで実行され得るため両フェンスに代入が必要（#374 P1 R3）。
//
// このテストは:
//   1. SKILL.md 内の全 FIREBASE_TOOLS_VERSION 代入が exact semver（X.Y.Z。
//      dist-tag・レンジ禁止）であり、かつ相互一致すること
//   2. `npx firebase-tools` の実行行がすべて
//      `firebase-tools@${FIREBASE_TOOLS_VERSION}` 形式であり、未固定実行が
//      残っていないこと
//   3. npx 実行行を含むフェンス自体に FIREBASE_TOOLS_VERSION 代入が先行して
//      存在すること
//   4. bootstrap-firebase.sh に npx 実行行が存在しないこと（Firebase 追加・
//      サイト作成は REST API を gcloud のトークンで直接叩く設計のため。
//      将来の混入ガード）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_MD_PATH = join(SKILL_DIR, 'SKILL.md')
const BOOTSTRAP_SCRIPT_PATH = join(SKILL_DIR, 'scripts', 'bootstrap-firebase.sh')

const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/

function extractSkillMdVersions(content) {
  const matches = [...content.matchAll(/FIREBASE_TOOLS_VERSION="([^"]*)"/g)]
  return matches.map((m) => m[1])
}

test('SKILL.md 内の FIREBASE_TOOLS_VERSION 代入はすべて exact semver で、相互に一致する', () => {
  const versions = extractSkillMdVersions(readFileSync(SKILL_MD_PATH, 'utf8'))
  assert.ok(versions.length > 0, 'SKILL.md に FIREBASE_TOOLS_VERSION 代入が見つからない')
  const first = versions[0]
  assert.match(first, EXACT_SEMVER, `dist-tag・レンジ禁止: ${first}`)
  for (const v of versions) {
    assert.match(v, EXACT_SEMVER, `dist-tag・レンジ禁止: ${v}`)
    assert.equal(v, first, `SKILL.md 内で FIREBASE_TOOLS_VERSION の値が不一致: ${first} vs ${v}`)
  }
})

// 実際にシェルで実行されるコマンド行だけを対象にする。行頭（インデント許容）が
// `npx` で始まる行に限定し、地の文・見出し・インラインコード引用中の
// 「npx firebase-tools」言及を誤検出しないようにする。
function extractExecLines(content) {
  return content.split('\n').filter((line) => /^\s*npx\b/.test(line))
}

test('SKILL.md に未固定の npx firebase-tools が残っていない', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const execLines = extractExecLines(content).filter((line) => /\bfirebase-tools\b/.test(line))
  assert.ok(
    execLines.length >= 2,
    'npx firebase-tools 実行行が Step 4 / Step 6 の 2 件に満たない（抽出ロジックの破損の可能性）'
  )
  for (const line of execLines) {
    assert.match(
      line,
      /firebase-tools@\$\{FIREBASE_TOOLS_VERSION\}/,
      `未固定の npx 実行: ${line}`
    )
  }
})

function extractBashFences(content) {
  const fences = []
  const re = /```bash\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(content)) !== null) {
    fences.push(m[1])
  }
  return fences
}

test('SKILL.md: npx firebase-tools 実行行を含むフェンス自体に FIREBASE_TOOLS_VERSION の代入が先行して存在する', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fences = extractBashFences(content)
  const execFences = fences.filter((fence) =>
    fence.split('\n').some((line) => /^\s*npx\b/.test(line) && /\bfirebase-tools\b/.test(line))
  )
  assert.ok(execFences.length >= 2, 'npx firebase-tools 実行行を含むフェンスが 2 件に満たない')
  for (const fence of execFences) {
    const lines = fence.split('\n')
    const execIdx = lines.findIndex(
      (line) => /^\s*npx\b/.test(line) && /\bfirebase-tools\b/.test(line)
    )
    const assignIdx = lines.findIndex((line) => /^\s*FIREBASE_TOOLS_VERSION=/.test(line))
    assert.notEqual(
      assignIdx,
      -1,
      'npx 実行行と同一フェンス内に FIREBASE_TOOLS_VERSION= 代入が無い（フェンス分離による未定義変数の退行リスク）'
    )
    assert.ok(
      assignIdx < execIdx,
      'FIREBASE_TOOLS_VERSION= 代入が npx 実行行より後にある（実行時に未定義になる）'
    )
  }
})

test('bootstrap-firebase.sh に npx 実行行が存在しない（REST API 直叩き設計の混入ガード）', () => {
  const content = readFileSync(BOOTSTRAP_SCRIPT_PATH, 'utf8')
  const execLines = extractExecLines(content)
  assert.equal(
    execLines.length,
    0,
    `bootstrap-firebase.sh に npx 実行行が混入している: ${JSON.stringify(execLines)}`
  )
})

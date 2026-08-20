// errexit-fence.test.mjs — Issue #417 の回帰テスト。
//
// SKILL.md の Step 4 フェンス（npx skills add を含む約1,400行の単一フェンス）は、
// このフェンス自身が errexit 無効なエージェント対話シェルへコピペ実行され得る前提を
// 持つ（コピペ実行の前提は tests/version-pin.test.mjs と同型の教訓）。修正前は
// `npx` の前後で `set +e` → 無条件 `set -e` としており、呼び出し元シェルの errexit
// 状態を保存せず、フェンス実行後に同一シェルで走る後続コマンド（Step 6 の却下フェンス
// 等）へ errexit を新規に有効化してしまっていた。これにより、ガードの無いコマンドが
// 復元処理の途中で非ゼロ終了 abort し得た。
//
// このテストは:
//   1. Step 4 フェンスが `set +e` より前に `$-` を参照する errexit 状態保存を行い、
//      無条件の `set -e` ではなく条件付き復元をしていること（テキスト検証）
//   2. Step 6 の却下フェンス（checker を持たないリポジトリ向けの単純リバート経路）が
//      `revert_in_scope`（SKILL.md 本文の共有関数）と同等のガード（`|| true` /
//      ディレクトリ存在確認）を備えていること（テキスト検証）
//   3. 1. の保存・条件付き復元が実際に呼び出し元シェルの errexit 状態を変えないこと
//      （挙動検証。errexit 無効/有効それぞれで開始した場合の事後状態を実測）
//   4. Step 6 却下フェンスが、lock 未追跡・スキルディレクトリ不在という初回生成相当の
//      状態で `set -e` 下でも abort せず完走すること（挙動検証。修正前は abort する
//      回帰シナリオ）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_MD_PATH = join(SKILL_DIR, 'SKILL.md')

function extractBashFences(content) {
  const fences = []
  const re = /```bash\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(content)) !== null) {
    fences.push(m[1])
  }
  return fences
}

function findStep4Fence(fences) {
  // npx skills add 実行行と PIPESTATUS スナップショット代入を両方含むフェンスを
  // Step 4 フェンスとみなす（version-pin.test.mjs と同じ抽出単位）。
  return fences.find(
    (fence) =>
      /^\s*npx\b.*\bskills\b/m.test(fence) && /PIPE_EXIT_SNAPSHOT=\("\$\{PIPESTATUS\[@\]\}"\)/.test(fence)
  )
}

function findStep6RejectFence(fences) {
  // git clean -fd と git checkout -- skills-lock.json を両方含み、かつ checker 向け
  // PRE_SYNC_TREE 経路（別フェンス）とは異なる単純リバート経路を対象にする。
  return fences.find(
    (fence) =>
      /git clean -fd/.test(fence) &&
      /git checkout -- skills-lock\.json/.test(fence) &&
      !/PRE_SYNC_TREE/.test(fence)
  )
}

test('SKILL.md: Step 4 フェンスは set +e より前に errexit 状態（$-）を保存する', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep4Fence(extractBashFences(content))
  assert.ok(fence, 'Step 4 フェンス（npx 実行 + PIPE_EXIT_SNAPSHOT を含む）が見つからない')
  const lines = fence.split('\n')
  const saveIdx = lines.findIndex((l) => /case \$- in \*e\*\)/.test(l))
  const setPlusEIdx = lines.findIndex((l) => /^set \+e\s*$/.test(l))
  assert.notEqual(saveIdx, -1, 'errexit 状態保存（case $- in *e*)）が見つからない')
  assert.notEqual(setPlusEIdx, -1, 'set +e 行が見つからない')
  assert.ok(saveIdx < setPlusEIdx, 'errexit 状態保存が set +e より後にある')
})

test('SKILL.md: Step 4 フェンスの errexit 復元は条件付きで、無条件 set -e ではない', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep4Fence(extractBashFences(content))
  assert.ok(fence, 'Step 4 フェンスが見つからない')
  const lines = fence.split('\n')
  const snapshotIdx = lines.findIndex((l) => /PIPE_EXIT_SNAPSHOT=\("\$\{PIPESTATUS\[@\]\}"\)/.test(l))
  assert.notEqual(snapshotIdx, -1, 'PIPE_EXIT_SNAPSHOT 代入行が見つからない')
  // スナップショット取得より後に、無条件の `set -e`（行頭・行全体が set -e のみ）が
  // 存在しないことを確認する。条件付き復元（`if [[ ... ]]; then set -e; fi`）は
  // 行全体が `set -e` だけにはならないため検知対象から除外される。
  const laterLines = lines.slice(snapshotIdx + 1)
  const unconditionalSetE = laterLines.find((l) => /^set -e\s*$/.test(l))
  assert.equal(
    unconditionalSetE,
    undefined,
    `スナップショット取得後に無条件の set -e が残っている: ${JSON.stringify(unconditionalSetE)}`
  )
  const conditionalRestore = laterLines.find((l) => /ERREXIT_WAS_ON.*-eq 1.*then set -e; fi/.test(l))
  assert.ok(conditionalRestore, '条件付き復元（ERREXIT_WAS_ON による set -e）が見つからない')
})

test('SKILL.md: Step 6 却下フェンスは lock checkout に || true を持つ', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep6RejectFence(extractBashFences(content))
  assert.ok(fence, 'Step 6 却下フェンス（checker 非経由の単純リバート）が見つからない')
  const lockLine = fence
    .split('\n')
    .find((l) => /git checkout -- skills-lock\.json/.test(l))
  assert.ok(lockLine, 'skills-lock.json の checkout 行が見つからない')
  assert.match(lockLine, /\|\|\s*true/, 'lock checkout 行に || true が無い（初回生成で pathspec エラーにより abort し得る）')
})

test('SKILL.md: Step 6 却下フェンスは git clean -fd の前にディレクトリ存在確認を持つ', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep6RejectFence(extractBashFences(content))
  assert.ok(fence, 'Step 6 却下フェンスが見つからない')
  const lines = fence.split('\n')
  const cleanIdx = lines.findIndex((l) => /git clean -fd/.test(l))
  assert.notEqual(cleanIdx, -1, 'git clean -fd 行が見つからない')
  const guardIdx = lines.findIndex((l, i) => i < cleanIdx && /\[\[ -d ".agents\/skills\/\$\{SKILL_NAME\}" \]\]/.test(l))
  assert.notEqual(guardIdx, -1, 'git clean -fd より前にディレクトリ存在確認（[[ -d ... ]]）が無い（ディレクトリ不在時に非ゼロ終了し abort し得る）')
})

test('挙動: Step 4 フェンスの保存・条件付き復元は呼び出し元の errexit 状態を変えない', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep4Fence(extractBashFences(content))
  assert.ok(fence, 'Step 4 フェンスが見つからない')
  const lines = fence.split('\n')
  const saveIdx = lines.findIndex((l) => /case \$- in \*e\*\)/.test(l))
  const restoreIdx = lines.findIndex((l) => /ERREXIT_WAS_ON.*-eq 1.*then set -e; fi/.test(l))
  assert.ok(saveIdx !== -1 && restoreIdx !== -1, '保存行・復元行の抽出に失敗した')
  let snippet = lines.slice(saveIdx, restoreIdx + 1).join('\n')
  // 実ネットワークの npx 実行を避け、非ゼロ終了する擬似コマンドへ置換する
  // （PIPE_EXIT_SNAPSHOT[0] が非ゼロ捕捉されることも合わせて確認するため）。
  snippet = snippet.replace(/^\s*npx --yes.*$/m, 'false | tee /dev/null')

  // errexit 無効で開始した場合: 実行後も無効のままであること。
  const outDisabled = execFileSync('bash', ['-c', `${snippet}\necho "STATE=$-"\necho "SNAP0=\${PIPE_EXIT_SNAPSHOT[0]}"`], {
    encoding: 'utf8',
  })
  const stateDisabled = outDisabled.match(/STATE=(\S*)/)?.[1] ?? ''
  const snap0Disabled = outDisabled.match(/SNAP0=(\S*)/)?.[1] ?? ''
  assert.ok(!stateDisabled.includes('e'), `errexit 無効開始のはずが有効化された: $-=${stateDisabled}`)
  assert.equal(snap0Disabled, '1', `擬似 npx（false）の非ゼロ終了が捕捉されていない: SNAP0=${snap0Disabled}`)

  // errexit 有効（set -e 前置）で開始した場合: 実行後も有効のままであること
  // （元の状態への復元）。
  const outEnabled = execFileSync(
    'bash',
    ['-c', `set -e\n${snippet}\necho "STATE=$-"\necho "SNAP0=\${PIPE_EXIT_SNAPSHOT[0]}"`],
    { encoding: 'utf8' }
  )
  const stateEnabled = outEnabled.match(/STATE=(\S*)/)?.[1] ?? ''
  assert.ok(stateEnabled.includes('e'), `errexit 有効開始のはずが復元されなかった: $-=${stateEnabled}`)
})

test('挙動: Step 6 却下フェンスは初回生成相当の状態でも set -e 下で abort せず完走する', () => {
  const content = readFileSync(SKILL_MD_PATH, 'utf8')
  const fence = findStep6RejectFence(extractBashFences(content))
  assert.ok(fence, 'Step 6 却下フェンスが見つからない')

  const tmp = mkdtempSync(join(tmpdir(), 'errexit-fence-step6-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp })
    // 初回生成相当: skills-lock.json は未追跡（tracked にしない）、スキル
    // ディレクトリは存在しない。SKILL_NAME はテスト専用の kebab-case 値を使う。
    const script = `set -euo pipefail\ncd '${tmp}'\nSKILL_NAME='test-fence-skill'\n${fence}\necho DONE\n`
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    assert.match(out, /DONE/, 'Step 6 却下フェンスが set -e 下で完走しなかった（abort した可能性）')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

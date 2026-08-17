// implement-issue-tree の Review フェーズにおける diff 比較基準の決定的回帰テスト（Issue #315）。
//
// 背景: Review はローカルの <base-branch> ref を比較基準にしていたため、ローカル base が origin
// より遅れていると無関係な祖先コミットの差分までレビュー対象に混入していた（#297 で diff 417 行中
// 387 行がノイズとなり収束失敗）。修正は比較基準を `origin/<base-branch>...HEAD`（3 点ドット）へ
// 統一し、比較点をブランチの分岐点（merge-base）に固定する。
//
// 3 群構成:
//   群 A（プロンプト契約）: reviewPrompt() の出力が origin/<base> 基準であることを固定する。
//     ハードコード（`origin/main` 直書き）を検出できるよう base 名を 'main' 以外にする。
//   群 B（SKILL.md ↔ script の乖離防止）: 両者の文言が一致することを機械照合する。
//   群 C（git セマンティクス）: 使い捨てリポジトリで 3 点ドット diff の分岐点固定を実測する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'implement-issue-tree.js',
)
const SKILL_MD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'SKILL.md',
)
// マーカー文字列はソース中に 1 回しか現れてはならない（g0-gates.test.mjs が出現回数を固定して
// いる）ため、リテラルを直接書かず分割して組み立てる（他テストと同じ流儀）。
const DRIVER_MARKER = ['__IMPLEMENT', 'ISSUE', 'TREE', 'DRIVER', 'START__'].join('_')

// ---------------------------------------------------------------------------
// 群 A: プロンプト契約（reviewPrompt の比較基準）
// ---------------------------------------------------------------------------
// globalThis.args を先に注入してから import することで、baseBranch が 'main'（既定値）以外の
// 'develop' に解決される。'origin/main' 直書きのハードコード回帰は、この base 名でのみ検出できる
// （base 名を 'main' のままにすると、正しい実装もハードコードも同じ文字列を出力し判別できない）。
// 別の一時ファイル・別の import URL へ切り出すため、args 未定義前提の g0-gates.test.mjs 等とは
// 別モジュール実体になり競合しない（node --test はテストファイルごとに別プロセスで実行される）。
globalThis.args = { parent: 1, branch: 'develop' }

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-reviewbase-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
// 実装スクリプトは Workflow ランタイムの制約により `export const meta` 以外の top-level export を
// 持てない（他に export があると起動時に SyntaxError となりスクリプト全体が実行不能になる）ため、
// 定義部は非 export のまま置き、テスト側で切り出したスライスへ export 文を付与して読み込む。
const SLICE_EXPORTS = ['reviewPrompt']
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const { reviewPrompt } = mod

const item = { number: 315 }
const impl = { branch: 'fix/315-review-diff-base' }
const output = reviewPrompt(item, impl)

test('群A: reviewPrompt は origin/<base> 基準の 3 点ドット diff を指示する', () => {
  assert.equal(typeof reviewPrompt, 'function')
  assert.match(output, /git diff origin\/develop\.\.\.HEAD/)
})

test('群A: reviewPrompt はローカル base 基準（origin/ なし）を含まない（ハードコード検出）', () => {
  // 'git diff develop...' は 'git diff origin/develop...' の部分文字列に一致しないため、
  // 正しい実装ではこの負のアサーションが常に成立する。
  assert.doesNotMatch(output, /git diff develop\.\.\.HEAD/)
})

test('群A: 旧文言「origin/<base> ではなくローカルの base ブランチと比較」を含まない（revert 検出）', () => {
  assert.doesNotMatch(output, /ではなくローカルの.*ブランチと比較/)
})

// ---------------------------------------------------------------------------
// 群 B: SKILL.md ↔ script の乖離防止
// ---------------------------------------------------------------------------
const skillMd = readFileSync(SKILL_MD_PATH, 'utf8')

test('群B: SKILL.md の Review 条件は origin/<base-branch> 基準の 3 点ドット diff を記載する', () => {
  assert.match(skillMd, /git diff origin\/<base-branch>\.\.\.HEAD/)
})

test('群B: SKILL.md はローカル base 基準（origin/ なし）の diff コマンドを含まない', () => {
  assert.doesNotMatch(skillMd, /`git diff <base-branch>\.\.\.HEAD`/)
})

test('群B: SKILL.md は旧文言「origin/<base-branch> ではなくローカルの base ブランチと比較」を含まない', () => {
  assert.doesNotMatch(skillMd, /origin\/<base-branch>\s*ではなくローカルの base ブランチと比較/)
})

// fixPrompt() は Workflow ハーネス依存の駆動部の下にあり import できないため、他テストと同じ
// 流儀（merge-loop-rescan.test.mjs 等）でソース走査により固定する。reviewPrompt と同じ乖離
// （SKILL.md だけ直して script の push 前 fix 分岐が旧文言のまま残る revert）を検出する。
test('群B: fixPrompt の push 前分岐は origin/<base> へ merge する（ローカル base への revert 検出）', () => {
  assert.match(source, /git merge origin\/\$\{baseBranch\}/)
  // \b は使わない — `}` の直後が全角括弧等の非単語文字だと語境界が成立せずマッチしない
  // （実測: 旧文言 `git merge ${baseBranch}（ローカル）` で \b 付きは false になり検出できない）。
  assert.doesNotMatch(source, /git merge \$\{baseBranch\}/)
})

// ---------------------------------------------------------------------------
// 群 C: git セマンティクス（使い捨てリポジトリで A〜D シナリオを実測）
// ---------------------------------------------------------------------------
// ネットワークは使わず、bare リポジトリをローカルパスの remote として使う。
// コミット identity・署名・既定ブランチ名は実行環境のユーザー設定に依存させない。
// 作業ディレクトリは必ず temp 配下（対象リポジトリの working copy には一切触れない）。
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

// #297 の実際の発生順序を再現する: (1) base コミットを push、(2) feature ブランチを作成する
// *前に* 別の PR マージ相当で origin/main を進める（unrelated.yml）、(3) feature は進行後の
// origin/main（Implement フェーズと同じ切り方）から作成する、(4) work 側のローカル main ref は
// 一度も fetch/更新しない（＝「ローカル base が origin より遅れている」状態）。
// このためローカル main は unrelated.yml の祖先であり、merge-base(ローカル main, feature) が
// ローカル main 自身になり、3 点ドット diff でも unrelated.yml が混入する。
function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'implement-issue-tree-diffbase-'))
  const bareDir = join(root, 'origin.git')
  const workDir = join(root, 'work')
  mkdirSync(bareDir)
  mkdirSync(workDir)
  git(bareDir, ['-c', 'init.defaultBranch=main', 'init', '--bare'])
  git(workDir, ['-c', 'init.defaultBranch=main', 'init'])
  git(workDir, ['remote', 'add', 'origin', bareDir])

  writeFileSync(join(workDir, 'base.txt'), 'base\n')
  git(workDir, ['add', 'base.txt'])
  git(workDir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base'])
  git(workDir, ['push', 'origin', 'HEAD:refs/heads/main'])
  // work 側のローカル main はここで固定（以降このまま更新しない＝取り込み忘れの再現）。

  // 別プロセス（別の並列イシューの先行マージ相当）が origin/main を先に進める。
  const bareWorkDir = join(root, 'origin-updater')
  mkdirSync(bareWorkDir)
  git(bareWorkDir, ['clone', bareDir, '.'])
  writeFileSync(join(bareWorkDir, 'unrelated.yml'), 'unrelated\n')
  git(bareWorkDir, ['add', 'unrelated.yml'])
  git(bareWorkDir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'unrelated change on origin/main'])
  git(bareWorkDir, ['push', 'origin', 'HEAD:refs/heads/main'])

  // work 側は origin/main（進行後）を fetch してから、進行後の origin/main を起点に feature を
  // 作成する（Implement フェーズが `git fetch origin && git checkout -B <branch> origin/<base>`
  // で切るのと同じ手順）。ローカル main 自体は更新しないため、ローカル main は origin/main より
  // 遅れたままになる。
  git(workDir, ['fetch', 'origin', 'main'])
  git(workDir, ['checkout', '-b', 'feature', 'origin/main'])
  writeFileSync(join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, ['add', 'feature.txt'])
  git(workDir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'feature'])

  return { workDir, bareDir }
}

test('群C: ローカル main 基準（現行の壊れた挙動）は無関係ファイルを含む（#297 再現）', () => {
  const { workDir } = buildFixture()
  git(workDir, ['checkout', 'feature'])
  const files = git(workDir, ['diff', 'main...HEAD', '--name-only']).split('\n').filter(Boolean)
  assert.ok(files.includes('feature.txt'))
  assert.ok(files.includes('unrelated.yml'), 'ローカル base 基準では origin 側の無関係な変更が混入する')
})

test('群C: origin/main 基準（修正後）は無関係ファイルを含まない（fetch 済みの remote-tracking ref を使用）', () => {
  const { workDir } = buildFixture()
  git(workDir, ['checkout', 'feature'])
  // feature は fetch 済みの origin/main（unrelated.yml 込み）を起点に作成されているため、
  // merge-base(origin/main, feature) は origin/main 自身になり、diff は feature 由来の変更のみ。
  const files = git(workDir, ['diff', 'origin/main...HEAD', '--name-only']).split('\n').filter(Boolean)
  assert.deepEqual(files, ['feature.txt'])
})

test('群C: 先行マージ（別イシューの PR マージ相当）で origin がさらに進行した後・fetch 前後いずれも比較点は不変（受入基準4）', () => {
  const { workDir, bareDir } = buildFixture()
  git(workDir, ['checkout', 'feature'])
  const beforeAnotherMerge = git(workDir, ['diff', 'origin/main...HEAD', '--name-only']).split('\n').filter(Boolean)
  assert.deepEqual(beforeAnotherMerge, ['feature.txt'])

  // parallel >= 2 の別イシューが先に PR をマージし、origin/main がさらに進む（このラン中の
  // 自 worktree は関与しない別プロセスによる更新）。
  const anotherRoot = mkdtempSync(join(tmpdir(), 'implement-issue-tree-diffbase-another-'))
  git(anotherRoot, ['clone', bareDir, '.'])
  writeFileSync(join(anotherRoot, 'another-feature.txt'), 'another\n')
  git(anotherRoot, ['add', 'another-feature.txt'])
  git(anotherRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'another merged PR'])
  git(anotherRoot, ['push', 'origin', 'HEAD:refs/heads/main'])

  // fetch 前: work 側の origin/main remote-tracking ref はまだ古い sha のまま。
  const beforeFetch = git(workDir, ['diff', 'origin/main...HEAD', '--name-only']).split('\n').filter(Boolean)
  assert.deepEqual(beforeFetch, ['feature.txt'], 'fetch 前: 別イシューの先行マージは work 側の origin/main にまだ反映されていない')

  git(workDir, ['fetch', 'origin', 'main'])
  const afterFetch = git(workDir, ['diff', 'origin/main...HEAD', '--name-only']).split('\n').filter(Boolean)
  assert.deepEqual(afterFetch, ['feature.txt'], 'fetch 後: origin/main の remote-tracking ref が別 sha（another-feature.txt 込み）へ更新されても、merge-base(origin/main, feature) は分岐点のまま変わらない')
})

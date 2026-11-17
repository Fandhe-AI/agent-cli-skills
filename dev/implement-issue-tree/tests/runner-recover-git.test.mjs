// ランナー（Codex 版）の回復の段（recover:#N）に足す git の書き込み先を決める recoverGitFor（runner/lib/recover-git.mjs）の回帰テスト
// （Issue #865・#866）。プロンプトの行の読み取りと基本の形は tests/runner-agent-host.test.mjs が確かめている。ここでは照合の綴りを扱う。
//
//   #865  worktree.useRelativePaths=true（git 2.48 以降）で作った worktree は <main>/.git/worktrees/<name>/gitdir に相対パスを持つ。
//         絶対パスとの文字列比較では見つからず、fetch のみ（worktree: null）になって WIP コミットできなかった
//   #866  状態ファイルに記録された旧 worktree のパスが末尾の /・/./・// を含むと fetch のみになった（cleanup-host.mjs は正規化した形で調べる）
//
// gitdir の相対パスは git のバージョンに頼らず手で書く（git 2.48 より古い git では -c worktree.useRelativePaths=true が無視され、
// 絶対パスのまま素通りする偽の合格になるため）。書く形は git 2.54 が useRelativePaths=true で書くものと同じ。
// 返した値はアダプタの検証（adapters/codex.mjs の checkRecoverGit）も通ることを確かめる。
// 末尾の / 等の綴りはプロンプトの行のまま recover-prep.sh にも渡るので、その綴りで WIP コミットまで届くことも実物で確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitEnv, makeRepo } from './lib/worktree-sandbox.mjs'
import { availableBashes } from './lib/signed-output.mjs'
import { recoverGitFor } from '../../../skills/implement-issue-tree/runner/lib/recover-git.mjs'
import { checkRecoverGit } from '../../../skills/implement-issue-tree/runner/adapters/codex.mjs'

const SKILL_DIR = '/x/skill'
const RECOVER_PREP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'implement-issue-tree', 'scripts', 'recover-prep.sh')
const line = (wt) => `bash '${SKILL_DIR}/scripts/run-verified.sh' ${'c'.repeat(64)} recover-prep.sh --base 'main' --worktree '${wt}' --branch 'feat/2-x'`
const recover = (wt, mainRoot) => recoverGitFor('recover:#2', `イシュー #2 の回復\n\`\`\`sh\n${line(wt)}\n\`\`\`\n`, { skillDir: SKILL_DIR, mainRoot })

/** 実 git のメイン worktree と、.claude/worktrees 直下の付属 worktree（ブランチ feat/2-x）。 */
function setup(name = 'old-1') {
  const repo = makeRepo()
  const main = realpathSync(repo.main)
  const wt = join(main, '.claude', 'worktrees', name)
  repo.addWorktree(name, { dir: wt, branch: 'feat/2-x' })
  const gitdir = join(main, '.git', 'worktrees', name)
  const want = { commonDir: join(main, '.git'), worktree: wt, gitdir }
  const fetchOnly = { commonDir: join(main, '.git'), worktree: null, gitdir: null }
  return { repo, main, wt, gitdir, want, fetchOnly }
}

/** git が worktree.useRelativePaths=true で書く形（gitdir は相対の <worktree>/.git、worktree の .git は相対の gitdir）へ書き換える。 */
function makeRelative(s) {
  writeFileSync(join(s.gitdir, 'gitdir'), `${relative(s.gitdir, join(s.wt, '.git'))}\n`)
  writeFileSync(join(s.wt, '.git'), `gitdir: ${relative(s.wt, s.gitdir)}\n`)
  const content = readFileSync(join(s.gitdir, 'gitdir'), 'utf8')
  assert.equal(content, `../../../.claude/worktrees/${s.wt.split('/').pop()}/.git\n`, '前提: gitdir の中身が相対パス')
}

test('#865: 相対パスの gitdir（worktree.useRelativePaths=true の形）でも、旧 worktree と gitdir を返し、アダプタの検証も通る', () => {
  const s = setup()
  makeRelative(s)
  assert.equal(spawnSync('git', ['-C', s.wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: gitEnv(s.repo.root) }).stdout.trim(), s.wt, '前提: git は相対の形を扱える')
  const got = recover(s.wt, s.main)
  assert.deepEqual(got, s.want)
  assert.deepEqual(checkRecoverGit(s.main, got), s.want)
})

test('#865: 相対パスの gitdir でも、別の worktree を指すもの・2 つ以上あるもの・.git/worktrees の外の gitdir は従来どおり足さない', () => {
  // 相対の gitdir が別の worktree を指す
  const a = setup()
  writeFileSync(join(a.gitdir, 'gitdir'), '../../../.claude/worktrees/other/.git\n')
  assert.deepEqual(recover(a.wt, a.main), a.fetchOnly)
  // 同じ worktree を指す gitdir が 2 つ（相対と絶対）
  const b = setup()
  makeRelative(b)
  mkdirSync(join(b.main, '.git', 'worktrees', 'dup'))
  writeFileSync(join(b.main, '.git', 'worktrees', 'dup', 'gitdir'), `${b.wt}/.git\n`)
  assert.deepEqual(recover(b.wt, b.main), b.fetchOnly)
  // 相対の gitdir が .git/worktrees の直下の symlink（実体は外）にある
  const c = setup()
  makeRelative(c)
  const out = join(c.repo.root, 'outside-admin')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out)
  for (const f of ['gitdir', 'HEAD', 'commondir']) writeFileSync(join(out, f), readFileSync(join(c.gitdir, f)))
  rmSync(c.gitdir, { recursive: true })
  symlinkSync(out, c.gitdir)
  writeFileSync(join(out, 'gitdir'), `${relative(c.gitdir, join(c.wt, '.git'))}\n`)
  assert.deepEqual(recover(c.wt, c.main), c.fetchOnly)
})

test('#866: 旧 worktree のパスの末尾の /・/./・//・途中の //・/./ は正規化して照合し、旧 worktree と gitdir を返す', () => {
  const s = setup()
  const spells = [`${s.wt}/`, `${s.wt}/.`, `${s.wt}/./`, `${s.wt}//`, s.wt.replace('/.claude/', '//.claude/'), s.wt.replace('/.claude/worktrees/', '/.claude/./worktrees/')]
  for (const wt of spells) {
    const got = recover(wt, s.main)
    assert.deepEqual(got, s.want, wt)
    assert.deepEqual(checkRecoverGit(s.main, got), s.want, `${wt}: アダプタの検証も通る`)
  }
  // 相対の gitdir と綴りが重なっても同じ
  makeRelative(s)
  assert.deepEqual(recover(`${s.wt}/`, s.main), s.want)
})

test('#866: .. の区間・.claude/worktrees の外・外を指す symlink（末尾の / つきを含む）・.claude/worktrees 自体は従来どおり fetch のみ', () => {
  const s = setup()
  const out = s.repo.addWorktree('outside').path
  const link = join(s.main, '.claude', 'worktrees', 'link-1')
  symlinkSync(out, link)
  const bad = [
    s.wt.replace('/.claude/worktrees/', '/.claude/worktrees/../worktrees/'),
    `${s.wt}/..`,
    `${s.wt}/../old-1`,
    out,
    `${out}/`,
    link,
    `${link}/`,
    `${link}/.`,
    join(s.main, '.claude', 'worktrees'),
    `${join(s.main, '.claude', 'worktrees')}/`,
    `${s.main}/`,
  ]
  for (const wt of bad) assert.deepEqual(recover(wt, s.main), s.fetchOnly, wt)
})

// プロンプトの行の綴りはそのまま recover-prep.sh の --worktree にも渡る（モデルが行を実行する）。正規化した書き込み先を足しても、
// スクリプトがその綴りで worktree を見つけられなければ WIP コミットに届かない
test('#866: 末尾の /・/./・// の綴りのまま recover-prep.sh を実行しても、旧 worktree を見つけて WIP コミットを積む', () => {
  const bash = availableBashes()[0]
  for (const spell of [(w) => `${w}/`, (w) => `${w}/.`, (w) => `${w}//`, (w) => w.replace('/.claude/', '//.claude/')]) {
    const s = setup()
    s.repo.write(s.wt, 'dirty.txt', 'x\n')
    const before = s.repo.head(s.wt)
    const wt = spell(s.wt)
    assert.deepEqual(recover(wt, s.main), s.want, wt)
    const r = spawnSync(bash, [RECOVER_PREP, '--base', 'main', '--worktree', wt, '--branch', 'feat/2-x'], { cwd: s.main, encoding: 'utf8', env: gitEnv(s.repo.root) })
    const m = /^RECOVER_PREP_RESULT (\{.*\})$/m.exec(r.stdout)
    assert.ok(m, `${wt}: ${r.stdout}${r.stderr}`)
    const res = JSON.parse(m[1])
    assert.deepEqual([res.resolved, res.source, res.wip, res.wipCommitted], [true, 'worktree', 'committed', true], `${wt}: ${m[1]}`)
    assert.notEqual(s.repo.head(s.wt), before, `${wt}: WIP コミットが積まれる`)
  }
})

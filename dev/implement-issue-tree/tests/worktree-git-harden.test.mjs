// サンドボックスの外で直接実行されるスクリプト（worktree-remove.sh・recover-prep.sh）が、エージェントの書ける付属 worktree の中で git を呼んだときに、
// 偽の git ディレクトリ・共通ディレクトリの config（core.fsmonitor）経由で任意コマンドを実行させられないことを固定する回帰テスト。
//
// 攻撃の前提: 実装エージェントは自分の worktree と <メイン>/.git/worktrees/<名前>/ を書ける。そこで次のいずれかを仕込むと、素の git は
// 偽の config を読み、core.fsmonitor に置いたコマンド（ここではマーカーファイルを作るだけ）を実行する。
//   commondir       <git ディレクトリ>/commondir を偽の共通ディレクトリへ向ける
//   gitfile         worktree の .git ファイルを偽の git ディレクトリへ向ける（余分な空行つき・相対パスの形も）
//   dotgit-dir      worktree の .git をリポジトリ丸ごと（ディレクトリ）に置き換える
//   dotgit-symlink  worktree の .git を偽のリポジトリへのシンボリックリンクにする
//   config.worktree extensions.worktreeConfig のあるリポジトリで <git ディレクトリ>/config.worktree に置く
//   submodule       実体のある gitlink の .git を偽のリポジトリへ向ける（中へ降りる status が submodule の config〔fsmonitor・clean フィルタ〕を使う）
// 各攻撃のテストは、スクリプトの実行後にマーカーが無い（fail-closed で git を呼ばない・中へ降りない）ことと worktree が消えていないことを確かめ、
// 最後に素の git status でマーカーが作られる（仕込みが本当に効く）ことを陽性対照として確かめる（仕込みが壊れていて素通りする偽の合格を防ぐ）。
// あわせて、管理ディレクトリ（<共通>/worktrees/<名前>）のシンボリックリンクで git worktree prune がリンク先の中身を消さないこと、
// 正規の worktree（相対パスの形を含む）の削除・回復が引き続き通ることを確かめる。利用できる bash（macOS の 3.2 と Homebrew の 5 など）をすべて回す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'
import { gitEnv, makeRepo } from './lib/worktree-sandbox.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'implement-issue-tree', 'scripts')
const WR = join(SCRIPTS, 'worktree-remove.sh')
const RP = join(SCRIPTS, 'recover-prep.sh')
const LIB = join(SCRIPTS, 'lib', 'worktree-remove-lib.sh')

// 素の git（スクリプトの外。利用者の設定を空にした環境）
const plainGit = (repo, cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(repo.root) })
const gitDirOf = (repo, w) => repo.git(w, 'rev-parse', '--absolute-git-dir')

// マーカーを作る fsmonitor を持つ偽のリポジトリ（git ディレクトリの形）を dir に作る。オブジェクト・ref・HEAD・index は本物から写す
function fakeGitDir(repo, w, dir, marker) {
  const g = gitDirOf(repo, w)
  mkdirSync(dir, { recursive: true })
  for (const name of ['objects', 'refs']) cpSync(join(repo.main, '.git', name), join(dir, name), { recursive: true })
  writeFileSync(join(dir, 'HEAD'), readFileSync(join(g, 'HEAD')))
  if (existsSync(join(g, 'index'))) cpSync(join(g, 'index'), join(dir, 'index'))
  writeFileSync(join(dir, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = "touch ${marker}; false"\n`)
  return dir
}

// 攻撃の仕込み。marker はマーカーファイルのパス
const ATTACKS = {
  commondir(repo, w, marker) {
    const fake = fakeGitDir(repo, w, join(repo.root, 'fake-common'), marker)
    writeFileSync(join(gitDirOf(repo, w), 'commondir'), `${fake}\n`)
  },
  gitfile(repo, w, marker) {
    const g = gitDirOf(repo, w)
    const fg = join(repo.root, 'fake-gitdir')
    const fake = fakeGitDir(repo, w, join(repo.root, 'fake-common'), marker)
    mkdirSync(fg, { recursive: true })
    for (const f of ['HEAD', 'index']) cpSync(join(g, f), join(fg, f))
    writeFileSync(join(fg, 'commondir'), `${fake}\n`)
    writeFileSync(join(fg, 'gitdir'), `${join(w, '.git')}\n`)
    // 余分な空行（git は末尾の空白を落として読む）
    writeFileSync(join(w, '.git'), `gitdir: ${fg}\n\n`)
  },
  'gitfile-relative'(repo, w, marker) {
    const g = gitDirOf(repo, w)
    const fg = join(w, '.fakegit')
    const fake = fakeGitDir(repo, w, join(repo.root, 'fake-common'), marker)
    mkdirSync(fg, { recursive: true })
    for (const f of ['HEAD', 'index']) cpSync(join(g, f), join(fg, f))
    writeFileSync(join(fg, 'commondir'), `${fake}\n`)
    writeFileSync(join(w, '.git'), 'gitdir: .fakegit\n')
  },
  'dotgit-dir'(repo, w, marker) {
    const tmp = fakeGitDir(repo, w, join(repo.root, 'fake-repo'), marker)
    rmSync(join(w, '.git'))
    cpSync(tmp, join(w, '.git'), { recursive: true })
  },
  'dotgit-symlink'(repo, w, marker) {
    const fake = fakeGitDir(repo, w, join(repo.root, 'fake-repo'), marker)
    rmSync(join(w, '.git'))
    symlinkSync(fake, join(w, '.git'))
  },
  'config.worktree'(repo, w, marker) {
    // 利用者がメインで worktree 単位の config を有効にしている（メインの設定は信頼する側）。エージェントは自分の git ディレクトリの config.worktree だけを書く
    repo.git(repo.main, 'config', 'extensions.worktreeConfig', 'true')
    writeFileSync(join(gitDirOf(repo, w), 'config.worktree'), `[core]\n\tfsmonitor = "touch ${marker}; false"\n`)
  },
  submodule(repo, w, marker) {
    // 偽の submodule: 実体のあるリポジトリ（コミット 1 つ・fsmonitor と clean フィルタつき）を gitlink の .git が指す。中の f を同じ中身で置き直してあるので、中の status は中身を読み直してフィルタを走らせる
    const src = join(repo.root, 'fake-sub')
    mkdirSync(src, { recursive: true })
    repo.git(src, 'init', '-q', '-b', 'main')
    repo.write(src, 'f', 'f\n')
    repo.git(src, 'add', 'f')
    repo.git(src, 'commit', '-q', '-m', 's')
    const sha = repo.git(src, 'rev-parse', 'HEAD')
    // core.fsmonitor は親の -c core.fsmonitor=false が子の git へ伝わって打ち消されるが、clean フィルタは打ち消されない（中へ降りないことでしか塞げない）
    repo.git(src, 'config', 'core.fsmonitor', `touch ${marker}; false`)
    repo.git(src, 'config', 'filter.x.clean', `touch ${marker}; cat`)
    repo.git(w, 'update-index', '--add', '--cacheinfo', `160000,${sha},evil`)
    mkdirSync(join(w, 'evil'), { recursive: true })
    writeFileSync(join(w, 'evil', '.git'), `gitdir: ${join(src, '.git')}\n`)
    writeFileSync(join(w, 'evil', '.gitattributes'), '* filter=x\n')
    // 同じ大きさ・別の mtime（大きさが違うと git は中身を読まずに変更と判断し、フィルタを通さない）
    writeFileSync(join(w, 'evil', 'f'), 'f\n')
  },
}

// 陽性対照: 仕込みが本当に素の git にコマンドを実行させること
function assertPlantWorks(repo, w, marker, name) {
  rmSync(marker, { force: true })
  plainGit(repo, w, 'status', '--porcelain', '--ignore-submodules=none')
  assert.ok(existsSync(marker), `${name}: 陽性対照（素の git status）でマーカーが作られない。仕込みが効いていない`)
  rmSync(marker, { force: true })
}

for (const bash of availableBashes()) {
  const tag = `[${bash}]`
  const runWR = (repo, args, { cwd = repo.main, input } = {}) => {
    const r = spawnSync(bash, [WR, ...args], { cwd, input, encoding: 'utf8', env: gitEnv(repo.root) })
    const m = /^WORKTREE_REMOVE_RESULT (\{.*\})$/.exec(r.stdout.trim().split('\n').pop() ?? '')
    return { status: r.status, stderr: r.stderr, result: m ? JSON.parse(m[1]) : null }
  }
  const runRP = (repo, args, { cwd = repo.main } = {}) => {
    const r = spawnSync(bash, [RP, ...args], { cwd, encoding: 'utf8', env: gitEnv(repo.root) })
    const m = /^RECOVER_PREP_RESULT (\{.*\})$/.exec(r.stdout.trim().split('\n').pop() ?? '')
    return { status: r.status, stderr: r.stderr, result: m ? JSON.parse(m[1]) : null }
  }

  for (const [name, plant] of Object.entries(ATTACKS)) {
    test(`${tag} worktree-remove.sh: ${name} の仕込みでも git にコマンドを実行させず、worktree を消さない（superseded・discard・sweep）`, () => {
      for (const mode of ['superseded', 'discard', 'sweep']) {
        const repo = makeRepo()
        const w = repo.addWorktree(`w-${mode}`)
        repo.write(w.path, 'u.txt', 'u\n')
        const marker = join(repo.root, 'PWNED')
        plant(repo, w.path, marker)
        if (mode === 'sweep') repo.write(repo.main, '_/issue-trees/1.json', JSON.stringify({ items: {} }))
        const r = mode === 'sweep'
          ? runWR(repo, ['sweep', '--file', '_/issue-trees/1.json'], { input: JSON.stringify([w.path]) })
          : runWR(repo, ['remove', '--mode', mode, '--path', w.path, ...(mode === 'discard' ? ['--branch', w.branch, '--base', 'main'] : [])])
        assert.equal(r.status, 0, `${mode}: ${r.stderr}`)
        assert.ok(!existsSync(marker), `${name}/${mode}: スクリプトが偽の config のコマンドを実行した`)
        assert.ok(existsSync(join(w.path, 'u.txt')), `${name}/${mode}: worktree の中身が消えた`)
        if (mode === 'sweep') {
          assert.deepEqual(r.result.removed, [], `${name}: ${JSON.stringify(r.result)}`)
        } else {
          assert.equal(r.result.retained, true, `${name}/${mode}: ${JSON.stringify(r.result)}`)
          assert.match(r.result.worktree, /^retained-(broken|submodule|dirty)$/, `${name}/${mode}`)
          if (name !== 'submodule') assert.equal(r.result.worktree, 'retained-broken', `${name}/${mode}: 照合に通らないものは retained-broken`)
        }
        if (mode === 'discard') assert.equal(r.result.branch, 'keep', `${name}: ブランチも残す`)
        assertPlantWorks(repo, w.path, marker, `${name}/${mode}`)
      }
    })

    test(`${tag} recover-prep.sh: ${name} の仕込みでも git にコマンドを実行させず、WIP コミットを作らない`, () => {
      const repo = makeRepo()
      const w = repo.addWorktree('w')
      repo.write(w.path, 'u.txt', 'u\n')
      const before = repo.head(repo.main, `refs/heads/${w.branch}`)
      const marker = join(repo.root, 'PWNED')
      plant(repo, w.path, marker)
      const r = runRP(repo, ['--worktree', w.path, '--branch', w.branch, '--base', 'main'])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(!existsSync(marker), `${name}: スクリプトが偽の config のコマンドを実行した`)
      assert.equal(r.result.wipCommitted, false, JSON.stringify(r.result))
      if (name === 'submodule') {
        // 照合には通る（本物の git ディレクトリ）。初期化済み submodule があるので中を観測せず、WIP コミットも作らない（add・commit が中を観測するため）
        assert.equal(r.result.wip, 'submodule', JSON.stringify(r.result))
        assert.equal(repo.head(repo.main, `refs/heads/${w.branch}`), before, 'WIP コミットを作らない')
      } else {
        assert.deepEqual([r.result.resolved, r.result.reason, r.result.wip], [false, 'toplevel-mismatch', 'skipped'], JSON.stringify(r.result))
        assert.equal(repo.head(repo.main, `refs/heads/${w.branch}`), before, 'ブランチを動かさない')
      }
      assertPlantWorks(repo, w.path, marker, name)
    })
  }

  for (const [name, plant] of Object.entries(ATTACKS)) {
    test(`${tag} worktree-remove.sh check-absent: ${name} の仕込みでも git にコマンドを実行させず、不在と言わない`, () => {
      const repo = makeRepo()
      const w = repo.addWorktree('w')
      const marker = join(repo.root, 'PWNED')
      plant(repo, w.path, marker)
      const r = runWR(repo, ['check-absent', '--path', w.path, '--repo-root', repo.main])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(!existsSync(marker), `${name}: スクリプトが偽の config のコマンドを実行した`)
      assert.ok(!['absent', 'prunable'].includes(r.result.worktree), `${name}: ${JSON.stringify(r.result)}`)
      assertPlantWorks(repo, w.path, marker, name)
    })
  }

  test(`${tag} カレントが付属 worktree（ランを付属 worktree で起動したセッション）: 照合に通れば削除・回復が動き、別の worktree への仕込みは塞ぐ。カレント自身の .git が偽なら何もしない`, () => {
    const repo = makeRepo()
    const session = repo.addWorktree('session')
    const a = repo.addWorktree('a')
    repo.write(a.path, 'u.txt', 'u\n')
    const p = runRP(repo, ['--worktree', a.path, '--branch', a.branch, '--base', 'main'], { cwd: session.path })
    assert.deepEqual([p.result.resolved, p.result.wip, p.result.wipCommitted], [true, 'committed', true], JSON.stringify(p.result))
    const d = runWR(repo, ['remove', '--mode', 'discard', '--path', a.path, '--branch', a.branch, '--base', 'main'], { cwd: session.path })
    assert.deepEqual([d.result.worktree, d.result.branch], ['removed', 'deleted'], JSON.stringify(d.result))
    const marker = join(repo.root, 'PWNED')
    const b = repo.addWorktree('b')
    ATTACKS.commondir(repo, b.path, marker)
    const rb = runWR(repo, ['remove', '--mode', 'superseded', '--path', b.path], { cwd: session.path })
    assert.ok(!existsSync(marker), 'スクリプトが偽の config のコマンドを実行した')
    assert.equal(rb.result.worktree, 'retained-broken', JSON.stringify(rb.result))
    // カレント自身の .git の行に余分な行を足すと照合に通らない（git は読めるが、スクリプトは共通ディレクトリを信頼しない）
    const c = repo.addWorktree('c')
    writeFileSync(join(session.path, '.git'), `${readFileSync(join(session.path, '.git'), 'utf8')}\n`)
    const rc = runWR(repo, ['remove', '--mode', 'superseded', '--path', c.path], { cwd: session.path })
    assert.equal(rc.result.worktree, 'retained-broken', JSON.stringify(rc.result))
    assert.ok(existsSync(c.path))
    const pc = runRP(repo, ['--worktree', c.path, '--branch', c.branch, '--base', 'main'], { cwd: session.path })
    assert.deepEqual([pc.result.resolved, pc.result.reason], [false, 'list-failed'], JSON.stringify(pc.result))
  })

  test(`${tag} recover-prep.sh --mode free: 握り手の worktree の照合に通らなければ git を呼ばず解放しない（config.worktree・commondir）`, () => {
    for (const name of ['config.worktree', 'commondir']) {
      const repo = makeRepo()
      const h = repo.addWorktree('holder')
      const marker = join(repo.root, 'PWNED')
      ATTACKS[name](repo, h.path, marker)
      const r = runRP(repo, ['--mode', 'free', '--base', 'main', '--branch', h.branch])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(!existsSync(marker), `${name}: スクリプトが偽の config のコマンドを実行した`)
      assert.equal(r.result.detached, 'in-use', JSON.stringify(r.result))
      assert.equal(repo.git(h.path, 'symbolic-ref', '-q', 'HEAD'), `refs/heads/${h.branch}`, 'HEAD を動かさない')
      assertPlantWorks(repo, h.path, marker, name)
    }
  })

  test(`${tag} worktree-remove.sh: <共通>/worktrees/ の下にシンボリックリンクがあれば remove も prune もしない（リンク先の中身を消さない）`, () => {
    const repo = makeRepo()
    const w = repo.addWorktree('w')
    const victim = join(repo.root, 'victim')
    mkdirSync(victim)
    writeFileSync(join(victim, 'keep.txt'), 'keep\n')
    // prune が『実体の無い登録』と判断する形（gitdir が存在しないパスを指す）
    writeFileSync(join(victim, 'gitdir'), `${join(repo.root, 'nowhere', '.git')}\n`)
    symlinkSync(victim, join(repo.main, '.git', 'worktrees', 'evil'))
    const r = runWR(repo, ['remove', '--mode', 'superseded', '--path', w.path])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual([r.result.worktree, r.result.retained], ['retained-broken', true], JSON.stringify(r.result))
    assert.ok(existsSync(join(victim, 'keep.txt')) && existsSync(join(victim, 'gitdir')), 'リンク先の中身が消えた')
    assert.ok(existsSync(w.path), 'worktree を消さない（fail-closed）')
    // sweep も同じ（何も消さないので prune も呼ばない）
    repo.write(repo.main, '_/issue-trees/1.json', JSON.stringify({ items: {} }))
    const sw = runWR(repo, ['sweep', '--file', '_/issue-trees/1.json'], { input: JSON.stringify([w.path]) })
    assert.equal(sw.status, 0, sw.stderr)
    assert.deepEqual(sw.result.removed, [], JSON.stringify(sw.result))
    assert.ok(existsSync(join(victim, 'keep.txt')) && existsSync(join(victim, 'gitdir')), 'sweep: リンク先の中身が消えた')
  })

  test(`${tag} worktree-remove.sh: 実体の無い登録の管理ディレクトリがシンボリックリンクなら消さずに保持する（リンク先を消さない）`, () => {
    const repo = makeRepo()
    const d = repo.addWorktree('d')
    const admin = join(repo.main, '.git', 'worktrees', 'd')
    const victim = join(repo.root, 'victim')
    cpSync(admin, victim, { recursive: true })
    writeFileSync(join(victim, 'keep.txt'), 'keep\n')
    rmSync(admin, { recursive: true })
    symlinkSync(victim, admin)
    rmSync(d.path, { recursive: true })
    const r = runWR(repo, ['remove', '--mode', 'discard', '--path', d.path])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.result.retained, true, JSON.stringify(r.result))
    assert.ok(existsSync(join(victim, 'keep.txt')), 'リンク先の中身が消えた')
  })

  test(`${tag} 正規の worktree（絶対パス・相対パスの形）は照合に通り、削除と回復が従来どおり動く`, () => {
    const rel = spawnSync('git', ['-c', 'worktree.useRelativePaths=true', 'version'], { encoding: 'utf8' })
    const forms = [['absolute', []]]
    // worktree.useRelativePaths は Git 2.48 以降。add が通らない git では相対の形を飛ばす
    const probe = makeRepo()
    if (rel.status === 0 && spawnSync('git', ['-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', join(probe.root, 'p'), '-b', 'p'], { cwd: probe.main, env: gitEnv(probe.root) }).status === 0) {
      forms.push(['relative', ['-c', 'worktree.useRelativePaths=true']])
    }
    for (const [form, cfg] of forms) {
      const repo = makeRepo()
      const add = (name) => {
        const dir = join(repo.root, 'wts', name)
        mkdirSync(join(repo.root, 'wts'), { recursive: true })
        repo.git(repo.main, ...cfg, 'worktree', 'add', '-q', dir, '-b', `b-${name}`)
        return { path: dir, branch: `b-${name}` }
      }
      const a = add('a')
      if (form === 'relative') assert.match(readFileSync(join(a.path, '.git'), 'utf8'), /^gitdir: \.\./, '前提: 相対パスの形')
      repo.write(a.path, 'u.txt', 'u\n')
      const p = runRP(repo, ['--worktree', a.path, '--branch', a.branch, '--base', 'main'])
      assert.deepEqual([p.result.resolved, p.result.wip, p.result.wipCommitted], [true, 'committed', true], `${form}: ${JSON.stringify(p.result)}`)
      const s = runWR(repo, ['remove', '--mode', 'superseded', '--path', a.path])
      assert.equal(s.result.worktree, 'removed', `${form}: ${JSON.stringify(s.result)}`)
      assert.ok(!existsSync(a.path))
      const b = add('b')
      const d = runWR(repo, ['remove', '--mode', 'discard', '--path', b.path, '--branch', b.branch, '--base', 'main'])
      assert.deepEqual([d.result.worktree, d.result.branch, d.result.ok], ['removed', 'deleted', true], `${form}: ${JSON.stringify(d.result)}`)
      const c = add('c')
      assert.equal(runWR(repo, ['check-absent', '--path', c.path]).result.worktree, 'present', form)
    }
  })

  // wr_gitlink_check の単体: 正規の形は通り、1 か所ずつ崩すと通らない（git を呼ばずにファイルだけで判定する）
  test(`${tag} wr_gitlink_check: 正規の形だけを通し、余分な行・CR・逆向きの不一致・commondir の欠落・config.worktree・管理ディレクトリの外を拒否する`, () => {
    const repo = makeRepo()
    const common = repo.git(repo.main, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const check = (w) => spawnSync(bash, ['-c', '. "$1"; wr_gitlink_check "$2" "$(cd "$3" && pwd -P)" && printf %s "$WR_GITDIR"', 'x', LIB, w, common], { encoding: 'utf8' })
    const ok = repo.addWorktree('ok')
    const r0 = check(ok.path)
    assert.equal(r0.status, 0, r0.stderr)
    assert.equal(r0.stdout, gitDirOf(repo, ok.path))
    const cases = [
      ['.git の 2 行目', (w, g) => writeFileSync(join(w, '.git'), `gitdir: ${g}\nx\n`)],
      ['.git の末尾の空行', (w, g) => writeFileSync(join(w, '.git'), `gitdir: ${g}\n\n`)],
      ['.git の CR', (w, g) => writeFileSync(join(w, '.git'), `gitdir: ${g}\r\n`)],
      ['.git の接頭辞違い', (w, g) => writeFileSync(join(w, '.git'), `gitdir:${g}\n`)],
      ['commondir の 2 行目', (w, g) => writeFileSync(join(g, 'commondir'), '../..\n../..\n')],
      ['commondir の欠落', (w, g) => rmSync(join(g, 'commondir'))],
      ['commondir が別の場所', (w, g) => writeFileSync(join(g, 'commondir'), '..\n')],
      ['commondir がシンボリックリンク', (w, g) => { writeFileSync(join(repo.root, 'cd'), '../..\n'); rmSync(join(g, 'commondir')); symlinkSync(join(repo.root, 'cd'), join(g, 'commondir')) }],
      ['逆向きの gitdir が別のパス', (w, g) => writeFileSync(join(g, 'gitdir'), `${join(repo.root, 'other', '.git')}\n`)],
      ['逆向きの gitdir が .git でない', (w, g) => writeFileSync(join(g, 'gitdir'), `${w}\n`)],
      ['config.worktree がある', (w, g) => writeFileSync(join(g, 'config.worktree'), '')],
      ['git ディレクトリが worktrees の外（写し）', (w, g) => { cpSync(g, join(repo.root, 'copy'), { recursive: true }); writeFileSync(join(w, '.git'), `gitdir: ${join(repo.root, 'copy')}\n`) }],
      ['git ディレクトリがシンボリックリンク経由で worktrees の外', (w, g) => { cpSync(g, join(repo.root, 'copy2'), { recursive: true }); symlinkSync(join(repo.root, 'copy2'), join(common, 'worktrees', 'lnk')); writeFileSync(join(w, '.git'), `gitdir: ${join(common, 'worktrees', 'lnk')}\n`) }],
      ['.git がディレクトリ', (w) => { rmSync(join(w, '.git')); mkdirSync(join(w, '.git')) }],
      ['.git がシンボリックリンク', (w, g) => { writeFileSync(join(repo.root, 'gf'), `gitdir: ${g}\n`); rmSync(join(w, '.git')); symlinkSync(join(repo.root, 'gf'), join(w, '.git')) }],
      ['.git が無い', (w) => rmSync(join(w, '.git'))],
    ]
    // 崩す前に全部作る（崩した管理ディレクトリがあると後の git worktree add が失敗する）
    const wts = cases.map((_, i) => repo.addWorktree(`c${i}`)).map((w) => ({ ...w, gd: gitDirOf(repo, w.path) }))
    cases.forEach(([label, mutate], i) => {
      const w = wts[i]
      mutate(w.path, w.gd)
      const r = check(w.path)
      assert.notEqual(r.status, 0, `${label}: 通ってしまった`)
      assert.equal(r.stdout, '', label)
    })
    // 共通ディレクトリが空（カレントがメインでない）なら何も通さない
    assert.notEqual(spawnSync(bash, ['-c', '. "$1"; wr_gitlink_check "$2" ""', 'x', LIB, ok.path]).status, 0)
    // wr_admin_links: <共通>/worktrees/ の下のシンボリックリンクの数（上で lnk を 1 つ作った）。共通ディレクトリが空なら 1（prune を飛ばす側）
    const links = (c) => spawnSync(bash, ['-c', '. "$1"; wr_admin_links "$2"', 'x', LIB, c], { encoding: 'utf8' }).stdout.trim()
    assert.equal(links(common), '1')
    assert.equal(links(''), '1')
    assert.equal(links(makeRepo().main + '/.git'), '0')
  })
}

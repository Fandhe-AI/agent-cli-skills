// ランナーの worktree 再現（runner/lib/worktree.mjs）の回帰テスト。実 git（bare の origin と clone）で、
// isolation:'worktree' の契約（パス・ブランチ名・起点・lock・失敗時の例外）を確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackTmp } from './lib/tmp-track.mjs'
import { maskUrlCredentials, createSequencer, createWorktree, newRunId, resolveDefaultBranch, resolveMainRoot, verifyWorktreeGitdir, worktreeNames } from '../../../skills/implement-issue-tree/runner/lib/worktree.mjs'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// bare の origin・本体（clone）・もう 1 つの clone（origin を進める役）を作る
function sandbox() {
  const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-wt-'))))
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const main = join(root, 'main')
  git(root, 'clone', '-q', origin, main)
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'init')
  git(main, 'push', '-q', 'origin', 'HEAD:main')
  git(main, 'remote', 'set-head', 'origin', 'main')
  const other = join(root, 'other')
  git(root, 'clone', '-q', origin, other)
  const advance = () => {
    writeFileSync(join(other, `f${Date.now()}${Math.random()}.txt`), 'x\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'advance')
    git(other, 'push', '-q', 'origin', 'HEAD:main')
    return git(other, 'rev-parse', 'HEAD')
  }
  return { root, origin, main, other, advance }
}

test('newRunId は wf_<16 進 8>-<16 進 3> の形で、毎回異なる', () => {
  const ids = new Set(Array.from({ length: 20 }, newRunId))
  assert.equal(ids.size, 20)
  for (const id of ids) assert.match(id, /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/)
})

test('createSequencer: 1 始まりの通し番号で、count は呼んだ回数', () => {
  const s = createSequencer()
  assert.deepEqual([s.next(), s.next(), s.next()], [1, 2, 3])
  assert.equal(s.count, 3)
})

test('worktreeNames: <main>/.claude/worktrees/<runId>-<N> と worktree-<runId>-<N>。不正な runId・番号は例外', () => {
  assert.deepEqual(worktreeNames('/m', 'wf_4b37e3aa-d5b', 7), { path: '/m/.claude/worktrees/wf_4b37e3aa-d5b-7', branch: 'worktree-wf_4b37e3aa-d5b-7' })
  for (const bad of ['', 'wf_x', '../wf_4b37e3aa-d5b', 'wf_4b37e3aa-d5b/..', 'wf_4B37E3AA-D5B']) assert.throws(() => worktreeNames('/m', bad, 1), /runId/, bad)
  for (const n of [0, -1, 1.5, '1', NaN]) assert.throws(() => worktreeNames('/m', 'wf_4b37e3aa-d5b', n), /通し番号/, String(n))
})

test('createWorktree: 最新の origin/<既定> を起点に、規定のパス・ブランチで作る（ローカル HEAD ではない）', () => {
  const sb = sandbox()
  const newest = sb.advance() // ローカルの main は古いまま、origin だけ進める
  const localHead = git(sb.main, 'rev-parse', 'HEAD')
  assert.notEqual(newest, localHead)
  const runId = newRunId()
  const wt = createWorktree({ mainRoot: sb.main, runId, n: 3 })
  assert.equal(wt.path, join(sb.main, '.claude', 'worktrees', `${runId}-3`))
  assert.equal(wt.branch, `worktree-${runId}-3`)
  assert.equal(wt.baseSha, newest)
  assert.equal(git(wt.path, 'rev-parse', 'HEAD'), newest)
  assert.equal(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch)
  // ブランチに upstream を付けない（--no-track）
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', `${wt.branch}@{upstream}`], { cwd: sb.main, env: ENV })
  assert.notEqual(r.status, 0)
  // 台帳（git worktree list）に載る
  assert.ok(git(sb.main, 'worktree', 'list', '--porcelain').includes(`worktree ${wt.path}`))
})

test('createWorktree: lock の理由は Claude Code の形（ホストの worktree-remove.sh が解釈する正規表現に一致）。lock:false では付けない', () => {
  const sb = sandbox()
  const a = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, pid: 4242 })
  const b = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 2, lock: false })
  const porcelain = git(sb.main, 'worktree', 'list', '--porcelain').split('\n\n')
  const blockA = porcelain.find((blk) => blk.includes(`worktree ${a.path}`))
  const blockB = porcelain.find((blk) => blk.includes(`worktree ${b.path}`))
  const reason = /^locked (.*)$/m.exec(blockA)?.[1]
  assert.match(reason, /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/)
  assert.match(reason, /\(pid 4242\)$/)
  assert.ok(!/^locked/m.test(blockB))
})

test('createWorktree: 連続して作っても番号ごとに別の worktree になり、同じ番号の再作成は例外', () => {
  const sb = sandbox()
  const runId = newRunId()
  const a = createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false })
  const b = createWorktree({ mainRoot: sb.main, runId, n: 2, lock: false })
  assert.notEqual(a.path, b.path)
  assert.throws(() => createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false }), /git worktree が失敗/)
})

test('createWorktree: fetch に失敗したら例外（古い起点で隔離を作らない）。fetch:false ならローカルの origin/<既定> を使う', () => {
  const sb = sandbox()
  git(sb.main, 'remote', 'set-url', 'origin', join(sb.root, 'missing.git'))
  assert.throws(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1 }), /git fetch が失敗/)
  const wt = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 2, fetch: false, lock: false })
  assert.equal(wt.baseSha, git(sb.main, 'rev-parse', 'refs/remotes/origin/main'))
})

test('createWorktree: 不正な基点ブランチ名は例外', () => {
  const sb = sandbox()
  for (const bad of ['-x', 'a b', 'a;b', '$(x)', 'a..b', 'a@{1}', '@{-1}', 'a~1', 'x.lock', '/a', 'a//b']) {
    assert.throws(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, baseBranch: bad }), /基点ブランチ名/, bad)
  }
})

test('resolveMainRoot: linked worktree の中から呼んでも本体を返す', () => {
  const sb = sandbox()
  const wt = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
  assert.equal(resolveMainRoot(wt.path), sb.main)
  assert.equal(resolveMainRoot(sb.main), sb.main)
})

test('resolveDefaultBranch: origin/HEAD を優先し、無ければ origin/main・origin/master の順、どれも無ければ例外', () => {
  const sb = sandbox()
  assert.equal(resolveDefaultBranch(sb.main), 'main')
  git(sb.main, 'remote', 'set-head', 'origin', '-d')
  assert.equal(resolveDefaultBranch(sb.main), 'main')
  git(sb.main, 'update-ref', '-d', 'refs/remotes/origin/main')
  assert.throws(() => resolveDefaultBranch(sb.main), /既定ブランチ/)
  git(sb.main, 'update-ref', 'refs/remotes/origin/master', git(sb.main, 'rev-parse', 'HEAD'))
  assert.equal(resolveDefaultBranch(sb.main), 'master')
})

test('createWorktree: メイン worktree が相対パス・pid が整数でないときは例外', () => {
  const sb = sandbox()
  assert.throws(() => createWorktree({ mainRoot: 'rel/main', runId: newRunId(), n: 1 }), /絶対パス/)
  assert.throws(() => worktreeNames('rel', 'wf_4b37e3aa-d5b', 1), /絶対パス/)
  for (const pid of [0, -1, 1.5, '1', NaN, '1; x']) {
    assert.throws(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, pid }), /pid/, String(pid))
  }
})

test('createWorktree: 先頭が - のパスにならない（-- で区切って渡す）', () => {
  const sb = sandbox()
  const wt = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
  assert.ok(wt.path.startsWith('/'))
})

test('maskUrlCredentials: URL の user:pass@ を伏せ、認証情報の無い URL・文は変えない', () => {
  assert.equal(maskUrlCredentials('fatal: unable to access https://user:pa55@github.com/o/r.git/'), 'fatal: unable to access https://***@github.com/o/r.git/')
  assert.equal(maskUrlCredentials('ssh://git:tok@h/x and https://a@b/c'), 'ssh://***@h/x and https://***@b/c')
  assert.equal(maskUrlCredentials('https://github.com/o/r.git'), 'https://github.com/o/r.git')
})

test('git の失敗文に載る URL の認証情報は伏せられる', () => {
  const sb = sandbox()
  git(sb.main, 'remote', 'set-url', 'origin', 'https://user:SECRETPASS@127.0.0.1:1/o/r.git')
  assert.throws(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1 }), (e) => !e.message.includes('SECRETPASS'))
})

test('createWorktree: gitdir は作成直後に git へ問い合わせた <main>/.git/worktrees/<name> の realpath（HIGH-2）', () => {
  const sb = sandbox()
  const runId = newRunId()
  const wt = createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false })
  assert.equal(wt.gitdir, realpathSync(join(sb.main, '.git', 'worktrees', `${runId}-1`)))
})

test('verifyWorktreeGitdir: メインの .git/worktrees/ の直下だけを通す（symlink で外へ向けた値・入れ子・相対パスは例外）', () => {
  const sb = sandbox()
  const wt = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
  assert.equal(verifyWorktreeGitdir(sb.main, wt.gitdir), wt.gitdir)
  const outside = join(sb.root, 'outside')
  mkdirSync(join(outside, 'x'), { recursive: true })
  const link = join(sb.main, '.git', 'worktrees', 'linked')
  symlinkSync(outside, link)
  for (const bad of [outside, link, join(sb.main, '.git'), join(sb.main, '.git', 'worktrees'), join(wt.gitdir, 'logs'), 'rel/x']) {
    assert.throws(() => verifyWorktreeGitdir(sb.main, bad), /git ディレクトリ/, bad)
  }
})

// ランナーの worktree 再現（runner/lib/worktree.mjs）の回帰テスト。実 git（bare の origin と clone）で、
// isolation:'worktree' の契約（パス・ブランチ名・起点・lock・失敗時の例外）を確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackTmp } from './lib/tmp-track.mjs'
import { maskUrlCredentials, createSequencer, createWorktree, newRunId, resolveDefaultBranch, resolveMainRoot, verifyWorktreeGitdir, worktreeNames } from '../../../skills/implement-issue-tree/runner/lib/worktree.mjs'
import * as worktreeMod from '../../../skills/implement-issue-tree/runner/lib/worktree.mjs'

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

test('createWorktree: 最新の origin/<既定> を起点に、規定のパス・ブランチで作る（ローカル HEAD ではない）', async () => {
  const sb = sandbox()
  const newest = sb.advance() // ローカルの main は古いまま、origin だけ進める
  const localHead = git(sb.main, 'rev-parse', 'HEAD')
  assert.notEqual(newest, localHead)
  const runId = newRunId()
  const wt = await createWorktree({ mainRoot: sb.main, runId, n: 3 })
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

test('createWorktree: lock の理由は Claude Code の形（ホストの worktree-remove.sh が解釈する正規表現に一致）。lock:false では付けない', async () => {
  const sb = sandbox()
  const a = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, pid: 4242 })
  const b = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 2, lock: false })
  const porcelain = git(sb.main, 'worktree', 'list', '--porcelain').split('\n\n')
  const blockA = porcelain.find((blk) => blk.includes(`worktree ${a.path}`))
  const blockB = porcelain.find((blk) => blk.includes(`worktree ${b.path}`))
  const reason = /^locked (.*)$/m.exec(blockA)?.[1]
  assert.match(reason, /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/)
  assert.match(reason, /\(pid 4242\)$/)
  assert.ok(!/^locked/m.test(blockB))
})

test('createWorktree: 連続して作っても番号ごとに別の worktree になり、同じ番号の再作成は例外', async () => {
  const sb = sandbox()
  const runId = newRunId()
  const a = await createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false })
  const b = await createWorktree({ mainRoot: sb.main, runId, n: 2, lock: false })
  assert.notEqual(a.path, b.path)
  await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false }), /git worktree が失敗/)
})

test('createWorktree: fetch に失敗したら例外（古い起点で隔離を作らない）。fetch:false ならローカルの origin/<既定> を使う', async () => {
  const sb = sandbox()
  git(sb.main, 'remote', 'set-url', 'origin', join(sb.root, 'missing.git'))
  await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1 }), /git fetch が失敗/)
  const wt = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 2, fetch: false, lock: false })
  assert.equal(wt.baseSha, git(sb.main, 'rev-parse', 'refs/remotes/origin/main'))
})

test('createWorktree: 不正な基点ブランチ名は例外', async () => {
  const sb = sandbox()
  for (const bad of ['-x', 'a b', 'a;b', '$(x)', 'a..b', 'a@{1}', '@{-1}', 'a~1', 'x.lock', '/a', 'a//b']) {
    await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, baseBranch: bad }), /基点ブランチ名/, bad)
  }
})

test('resolveMainRoot: linked worktree の中から呼んでも本体を返す', async () => {
  const sb = sandbox()
  const wt = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
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

test('createWorktree: メイン worktree が相対パス・pid が整数でないときは例外', async () => {
  const sb = sandbox()
  await assert.rejects(() => createWorktree({ mainRoot: 'rel/main', runId: newRunId(), n: 1 }), /絶対パス/)
  assert.throws(() => worktreeNames('rel', 'wf_4b37e3aa-d5b', 1), /絶対パス/)
  for (const pid of [0, -1, 1.5, '1', NaN, '1; x']) {
    await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, pid }), /pid/, String(pid))
  }
})

test('createWorktree: 先頭が - のパスにならない（-- で区切って渡す）', async () => {
  const sb = sandbox()
  const wt = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
  assert.ok(wt.path.startsWith('/'))
})

test('maskUrlCredentials: URL の user:pass@ を伏せ、認証情報の無い URL・文は変えない', () => {
  assert.equal(maskUrlCredentials('fatal: unable to access https://user:pa55@github.com/o/r.git/'), 'fatal: unable to access https://***@github.com/o/r.git/')
  assert.equal(maskUrlCredentials('ssh://git:tok@h/x and https://a@b/c'), 'ssh://***@h/x and https://***@b/c')
  assert.equal(maskUrlCredentials('https://github.com/o/r.git'), 'https://github.com/o/r.git')
})

test('git の失敗文に載る URL の認証情報は伏せられる', async () => {
  const sb = sandbox()
  git(sb.main, 'remote', 'set-url', 'origin', 'https://user:SECRETPASS@127.0.0.1:1/o/r.git')
  await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1 }), (e) => !e.message.includes('SECRETPASS'))
})

test('createWorktree: gitdir は作成直後に git へ問い合わせた <main>/.git/worktrees/<name> の realpath（HIGH-2）', async () => {
  const sb = sandbox()
  const runId = newRunId()
  const wt = await createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false })
  assert.equal(wt.gitdir, realpathSync(join(sb.main, '.git', 'worktrees', `${runId}-1`)))
})

test('verifyWorktreeGitdir: メインの .git/worktrees/ の直下だけを通す（symlink で外へ向けた値・入れ子・相対パスは例外）', async () => {
  const sb = sandbox()
  const wt = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, lock: false })
  assert.equal(verifyWorktreeGitdir(sb.main, wt.gitdir), wt.gitdir)
  const outside = join(sb.root, 'outside')
  mkdirSync(join(outside, 'x'), { recursive: true })
  const link = join(sb.main, '.git', 'worktrees', 'linked')
  symlinkSync(outside, link)
  for (const bad of [outside, link, join(sb.main, '.git'), join(sb.main, '.git', 'worktrees'), join(wt.gitdir, 'logs'), 'rel/x']) {
    assert.throws(() => verifyWorktreeGitdir(sb.main, bad), /git ディレクトリ/, bad)
  }
})

// ---------------------------------------------------------------------------
// 継いだ git の環境変数（#860）・fetch の時間切れ（#861）・lock 失敗の片づけ（#862）
// ---------------------------------------------------------------------------

/** process.env を一時的に書き換えて fn を待つ（undefined は削除）。終わったら元へ戻す。 */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
/** 別のリポジトリ（sandbox の other）を指す git の位置の環境変数。継いだまま起動すると git の対象が cwd でなくなる。 */
const foreignGitEnv = (sb) => ({ GIT_DIR: join(sb.other, '.git'), GIT_WORK_TREE: sb.other, GIT_COMMON_DIR: join(sb.other, '.git'), GIT_INDEX_FILE: join(sb.other, '.git', 'index') })
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
/** 指定の git サブコマンド（"worktree lock" 等）だけ失敗し、ほかは本物の git へ渡す偽 git を置いたディレクトリ。 */
function fakeGitDir(root, failing) {
  const dir = join(root, `fakegit-${failing.length}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir)
  const cases = failing.map((sub) => `  "${sub}") echo "fatal: injected ${sub} failure" >&2; exit 1 ;;`).join('\n')
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$1 $2" in\n${cases}\nesac\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

test('gitLocationFreeEnv: --local-env-vars の一覧・GIT_CONFIG_KEY/VALUE_<n>・探索の範囲を変える変数を外し、ほかは残す（元は変えない）', () => {
  assert.equal(typeof worktreeMod.gitLocationFreeEnv, 'function')
  const local = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', env: ENV }).stdout.split('\n').filter(Boolean)
  assert.ok(local.includes('GIT_DIR'))
  const extra = ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_NAMESPACE', 'GIT_EXEC_PATH']
  const keep = { PATH: '/bin', HOME: '/h', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GH_REPO: 'o/r' }
  const env = { ...keep, ...Object.fromEntries([...local, ...extra].map((k) => [k, 'x'])) }
  assert.deepEqual(worktreeMod.gitLocationFreeEnv(env), keep)
  assert.equal(env.GIT_DIR, 'x', '元の env は変えない')
  // 外す一覧は git 自身の一覧をすべて含む。git の版が上がって一覧に変数が増えたら落ちる（意図した検知: 増えた変数を
  // GIT_LOCATION_ENV_VARS へ足すか、外さない理由を確かめる）。2.40 より前の git が出す GIT_INTERNAL_SUPER_PREFIX も一覧に持つ
  for (const k of local) assert.ok(worktreeMod.GIT_LOCATION_ENV_VARS.includes(k), k)
  assert.deepEqual(worktreeMod.gitSafeEnv(env), { ...keep, GIT_TERMINAL_PROMPT: '0' })
})

test('resolveMainRoot: 別のリポジトリを指す GIT_DIR 等を継いでも cwd のリポジトリのメイン worktree を返す（#860）', async () => {
  const sb = sandbox()
  await withEnv(foreignGitEnv(sb), () => {
    assert.equal(resolveMainRoot(sb.main), sb.main)
    assert.equal(resolveDefaultBranch(sb.main), 'main')
  })
})

test('createWorktree: 別のリポジトリを指す GIT_DIR 等を継いでも、作る先は mainRoot のリポジトリ（#860）', async () => {
  const sb = sandbox()
  const before = git(sb.other, 'worktree', 'list', '--porcelain')
  const runId = newRunId()
  await withEnv(foreignGitEnv(sb), () => createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false }).catch(() => null))
  const { path } = worktreeNames(sb.main, runId, 1)
  assert.equal(git(sb.other, 'worktree', 'list', '--porcelain'), before, '別のリポジトリには作らない')
  assert.ok(git(sb.main, 'worktree', 'list', '--porcelain').includes(`worktree ${path}`), 'mainRoot のリポジトリに作る')
})

test('createWorktree: origin が応答しない fetch の間もイベントループは止まらず、設定した時間切れでプロセスグループを止めて例外にする（#861）', async () => {
  const sb = sandbox()
  const pidFile = join(sb.root, 'ssh.pid')
  git(sb.main, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/o/r.git')
  // ssh の代わりに応答しない処理を起動させる（pid を書いてから 30 秒眠る）
  git(sb.main, 'config', 'core.sshCommand', `echo $$ > ${JSON.stringify(pidFile)}; sleep 30; false`)
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 20)
  const t0 = Date.now()
  try {
    await assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, fetchTimeoutMs: 300 })), /git fetch が 300 ms で時間切れ/)
  } finally {
    clearInterval(timer)
  }
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, `時間切れで戻る（${elapsed} ms）`)
  assert.ok(ticks >= 5, `fetch の間も並行するタイマが発火する（${ticks} 回）`)
  // ssh の代わりの処理（プロセスグループの一員）も止まっている。回収されるまで短く待つ
  assert.ok(existsSync(pidFile), 'sshCommand が起動している')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  let alive = true
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 25)) } catch { alive = false }
  }
  assert.equal(alive, false, 'fetch の孫（sshCommand）が残らない')
  // fetch より後へ進んでいない（worktree を作っていない）
  assert.equal(existsSync(join(sb.main, '.claude', 'worktrees')), false)
})

test('killGitSync: 実行中の fetch のプロセスグループを同期で止め、createWorktree は例外で戻る（ランナーの終了時の後片づけ。LOW-11）', async () => {
  assert.equal(typeof worktreeMod.killGitSync, 'function')
  const sb = sandbox()
  git(sb.main, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/o/r.git')
  const started = join(sb.root, 'started')
  git(sb.main, 'config', 'core.sshCommand', `: > ${JSON.stringify(started)}; sleep 30; false`)
  const p = createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, fetchTimeoutMs: 20_000 })
  p.catch(() => {})
  // sshCommand まで起動したら止める（実時間で長く待たない。上限 5 秒）
  for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(existsSync(started), 'fetch が sshCommand まで進んだ')
  const t0 = Date.now()
  worktreeMod.killGitSync()
  await assert.rejects(p, /git fetch が失敗/)
  assert.ok(Date.now() - t0 < 5000)
})

test('createWorktree: 時間切れの値が正の整数でなければ例外', async () => {
  const sb = sandbox()
  for (const bad of [0, -1, 1.5, '100', NaN]) {
    await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, fetch: false, fetchTimeoutMs: bad }), /fetchTimeoutMs/, String(bad))
    await assert.rejects(() => createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, fetch: false, gitTimeoutMs: bad }), /gitTimeoutMs/, String(bad))
  }
})

test('createWorktree: worktree lock が失敗したら、作った worktree とブランチを片づけてから元の例外を投げる（#862）', async () => {
  const sb = sandbox()
  const list = () => git(sb.main, 'worktree', 'list', '--porcelain')
  const branches = () => git(sb.main, 'branch', '--list', '--format=%(refname)')
  const [wl, br] = [list(), branches()]
  const runId = newRunId()
  const fake = fakeGitDir(sb.root, ['worktree lock'])
  await withEnv({ PATH: `${fake}:${process.env.PATH}` }, () =>
    assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false })), (e) => /git worktree が失敗/.test(e.message) && /injected worktree lock failure/.test(e.message) && !/片づけ/.test(e.message)))
  assert.equal(list(), wl, 'worktree の一覧が作成前と同じ')
  assert.equal(branches(), br, 'ブランチが作成前と同じ')
  assert.equal(existsSync(join(sb.main, '.claude', 'worktrees', `${runId}-1`)), false)
})

test('createWorktree: lock の後の片づけも失敗したら、元の失敗の文面を保ち、残ったパスとブランチを足す（#862）', async () => {
  const sb = sandbox()
  const runId = newRunId()
  const { path, branch } = worktreeNames(sb.main, runId, 1)
  const fake = fakeGitDir(sb.root, ['worktree lock', 'worktree remove'])
  await withEnv({ PATH: `${fake}:${process.env.PATH}` }, () =>
    assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false })), (e) => {
      assert.match(e.message, /^git worktree が失敗した（終了コード 1）: fatal: injected worktree lock failure/)
      assert.ok(e.message.includes(path), e.message)
      assert.ok(e.message.includes(branch), e.message)
      return true
    }))
})

test('createWorktree: add 自体の失敗（同じ番号の衝突）では、既にある worktree とブランチを消さない（#862）', async () => {
  const sb = sandbox()
  const runId = newRunId()
  const first = await createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false, lock: false })
  await assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false, lock: false })), /git worktree が失敗/)
  assert.ok(git(sb.main, 'worktree', 'list', '--porcelain').includes(`worktree ${first.path}`))
  assert.equal(git(sb.main, 'rev-parse', '--verify', '--quiet', `refs/heads/${first.branch}`).length, 40)
})

// ---------------------------------------------------------------------------
// 並列の fetch の直列化・時間切れで止めた add の途中状態の片づけ
// ---------------------------------------------------------------------------

/** fetch の開始と終了を log へ書き、間で少し待ってから本物の git へ渡す偽 git を置いたディレクトリ。 */
function fetchLoggingGitDir(root, log) {
  const dir = join(root, `fakegit-fetchlog-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'git'), `#!/bin/sh
if [ "$1" = fetch ]; then
  echo "start $$" >> ${JSON.stringify(log)}
  sleep 0.15
  ${JSON.stringify(REAL_GIT)} "$@"; s=$?
  echo "end $$" >> ${JSON.stringify(log)}
  exit $s
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

test('createWorktree: 同じ mainRoot へ並列に呼んでも fetch は重ならず、前の呼び出しの失敗で後続は止まらない', async () => {
  const sb = sandbox()
  const log = join(sb.root, 'fetch.log')
  const fake = fetchLoggingGitDir(sb.root, log)
  const runId = newRunId()
  const results = await withEnv({ PATH: `${fake}:${process.env.PATH}` }, () => Promise.allSettled([
    createWorktree({ mainRoot: sb.main, runId, n: 1, lock: false }),
    // origin に無いブランチ。fetch が失敗する（後続の呼び出しを止めないこと）
    createWorktree({ mainRoot: sb.main, runId, n: 2, lock: false, baseBranch: 'nope' }),
    createWorktree({ mainRoot: sb.main, runId, n: 3, lock: false }),
  ]))
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled'], results.map((r) => r.reason?.message).join(' / '))
  assert.match(results[1].reason.message, /git fetch が失敗/)
  const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])
  assert.deepEqual(events, ['start', 'end', 'start', 'end', 'start', 'end'], 'fetch は 1 本ずつ走る')
})

/** post-checkout フックで眠らせ、worktree add が worktree・ブランチを作った後に止まる状態を作る。 */
function hangAfterAdd(sb) {
  const hooks = join(sb.root, `hooks-${Math.random().toString(16).slice(2)}`)
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nsleep 30\n')
  chmodSync(join(hooks, 'post-checkout'), 0o755)
  git(sb.main, 'config', 'core.hooksPath', hooks)
}

test('createWorktree: 時間切れで止めた worktree add の途中状態（今回作った worktree・ブランチ・パス）を片づけてから例外にする', async () => {
  const sb = sandbox()
  const list = () => git(sb.main, 'worktree', 'list', '--porcelain')
  const branches = () => git(sb.main, 'branch', '--list', '--format=%(refname)')
  // 既にある worktree・ブランチ（片づけで触らないこと）
  const keep = await createWorktree({ mainRoot: sb.main, runId: newRunId(), n: 1, fetch: false, lock: false })
  const [wl, br] = [list(), branches()]
  hangAfterAdd(sb)
  const runId = newRunId()
  await assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false, gitTimeoutMs: 1000 })),
    (e) => /git worktree が 1000 ms で時間切れ/.test(e.message) && !/片づけ/.test(e.message))
  assert.equal(list(), wl, 'worktree の一覧が作成前と同じ')
  assert.equal(branches(), br, 'ブランチが作成前と同じ')
  assert.equal(existsSync(join(sb.main, '.claude', 'worktrees', `${runId}-1`)), false)
  assert.ok(existsSync(keep.path))
})

test('createWorktree: 時間切れで止めた add の片づけも失敗したら、残ったパスとブランチを文面に足す', async () => {
  const sb = sandbox()
  hangAfterAdd(sb)
  const runId = newRunId()
  const { path, branch } = worktreeNames(sb.main, runId, 1)
  const fake = fakeGitDir(sb.root, ['worktree remove'])
  await withEnv({ PATH: `${fake}:${process.env.PATH}` }, () =>
    assert.rejects(Promise.resolve().then(() => createWorktree({ mainRoot: sb.main, runId, n: 1, fetch: false, gitTimeoutMs: 1000 })), (e) => {
      assert.match(e.message, /^git worktree が 1000 ms で時間切れ/)
      assert.ok(e.message.includes(path), e.message)
      assert.ok(e.message.includes(branch), e.message)
      return true
    }))
})

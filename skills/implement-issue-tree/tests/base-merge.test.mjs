// scripts/base-merge.sh を実際に実行して確かめる回帰テスト（Issue #603 第 3 弾）。baseMergePrompt に文章で書いていた
// 手順（routing ガード・fetch・checkout・マージ・push 検証）が、スクリプトに移っても同じ意味を保ち、危険側
// （pushed: true の誤報・別リポジトリ / 別ブランチへの push・コンフリクトや hook 拒否のまま push）に倒れないことを固定する。
//
// 実 git: bare の origin と clone を一時ディレクトリに作る（tests/lib/git-sandbox.mjs）。`git remote get-url origin` だけを
// 偽の URL で返すシムと、偽 gh（pr view の応答）を PATH の先頭に置く。シムは呼び出しを記録するので、routing 不一致の
// あとに fetch / checkout / merge / push を一切呼んでいないことを履歴で確かめる。
//
// macOS（BSD userland・/bin/bash は 3.2）と Linux の両方で通る書き方だけを使う。利用できる bash をすべて回す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes, toolExists } from './lib/signed-output.mjs'
import { BASE, BRANCH, MERGE_SUBJECT, PR, REPO, git, makeSandbox } from './lib/git-sandbox.mjs'
import { bundleSha256 } from '../scripts/build-workflow.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'base-merge.sh')
const BASHES = availableBashes()
const jqAvailable = toolExists('jq')
const ARGS = ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', REPO]
const RESULT_KEYS = new Set(['pushed', 'summary', 'worktreePath', 'routingError', 'commitFailed', 'conflict', 'hookRejected'])
const MUTATING = /^(fetch|checkout|merge|push|commit|reset|switch)( |$)/

function run(bash, sb, { args = ARGS, env = {} } = {}) {
  return spawnSync(bash, [SCRIPT, ...args], { cwd: sb.wt, encoding: 'utf8', env: sb.env(env) })
}
// 標準出力は結果の 1 行だけ（git の出力が混ざらない）。キーは BASE_MERGE_SCHEMA の範囲に収まり、pushed は boolean
function result(r) {
  assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `標準出力は結果の 1 行だけ:\n${r.stdout}`)
  assert.match(lines[0], /^BASE_MERGE_RESULT \{/)
  const v = JSON.parse(lines[0].slice('BASE_MERGE_RESULT '.length))
  for (const k of Object.keys(v)) assert.ok(RESULT_KEYS.has(k), `想定外のキー: ${k}`)
  assert.equal(typeof v.pushed, 'boolean')
  assert.equal(typeof v.summary, 'string')
  assert.equal(typeof v.worktreePath, 'string')
  for (const k of ['routingError', 'commitFailed', 'conflict', 'hookRejected']) if (k in v) assert.equal(v[k], true)
  return v
}
const mutatingCalls = (sb) => sb.gitCalls().filter((c) => MUTATING.test(c))

for (const bash of BASHES) {
  const tag = `[${bash}]`
  const t = (name, fn) => test(`${tag} ${name}`, { skip: !jqAvailable }, fn)

  t('正常: base を取り込み、固定 subject のマージコミットをブランチへ push して pushed: true を返す', () => {
    const sb = makeSandbox()
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    assert.ok(!('commitFailed' in v) && !('routingError' in v) && !('conflict' in v) && !('hookRejected' in v))
    const after = sb.remoteSha()
    assert.notEqual(after, before, 'リモートのブランチが進んでいる')
    assert.equal(after, sb.headSha(), 'リモート head はローカル HEAD（マージコミット）と一致する')
    assert.equal(git(sb.origin, 'log', '-1', '--format=%s', after), MERGE_SUBJECT, 'subject は埋め込み定数')
    assert.equal(git(sb.origin, 'rev-list', '--parents', '-n', '1', after).split(' ').length, 3, '親が 2 つのマージコミット')
    assert.equal(git(sb.origin, 'rev-parse', `refs/heads/${BASE}`), git(sb.origin, 'merge-base', after, BASE), 'base の先端が取り込まれている')
    assert.equal(v.worktreePath, sb.wt, 'worktreePath は pwd の結果')
    assert.deepEqual(readdirSync(sb.tmp), [], '一時ファイル（マージ subject）が残らない')
  })

  t('正常: push の refspec は HEAD:refs/heads/<branch> の 1 形で、--force 系・--no-verify・先頭 + を使わない', () => {
    const sb = makeSandbox()
    result(run(bash, sb))
    const pushes = sb.gitCalls().filter((c) => /^push( |$)/.test(c))
    assert.deepEqual(pushes, [`push origin HEAD:refs/heads/${BRANCH}`])
    for (const c of sb.gitCalls()) {
      assert.doesNotMatch(c, /--force|--no-verify|--force-with-lease|--mirror|--delete|(^| )-f( |$)/, c)
    }
  })

  t('正常: git の呼び出し順は routing 照合 → branch fetch → checkout → base fetch → merge → ls-remote → push → ls-remote', () => {
    const sb = makeSandbox()
    result(run(bash, sb))
    const calls = sb.gitCalls()
    const at = (re) => calls.findIndex((c) => re.test(c))
    const order = [
      at(/^remote get-url origin$/), at(new RegExp(`^fetch origin ${BRANCH}:refs/remotes/origin/${BRANCH}$`)), at(/^checkout --detach refs\/remotes\/origin\//),
      at(new RegExp(`^fetch origin ${BASE}:refs/remotes/origin/${BASE}$`)), at(/^merge --no-ff --no-edit -F /), at(/^ls-remote origin /), at(/^push origin /),
    ]
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order))
    assert.deepEqual([...order].sort((a, b) => a - b), order, '順序が崩れている')
    assert.equal(calls.filter((c) => /^ls-remote /.test(c)).length, 2, 'push の前後で 1 回ずつ')
    assert.ok(calls.findIndex((c, i) => /^ls-remote /.test(c) && i > order[6]) > order[6], '2 回目の ls-remote は push のあと')
  })

  t('checkout 後の HEAD が origin のブランチと違う（起点の取り違え）なら commitFailed。merge も push もしない', () => {
    const sb = makeSandbox()
    const baseTip = git(sb.wt, 'rev-parse', `refs/remotes/origin/${BASE}`)
    sb.writeHook(join(sb.wt, '.git'), 'post-checkout', `git update-ref --no-deref HEAD ${baseTip}`)
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.match(v.summary, /checkout 後の HEAD/)
    assert.ok(!('conflict' in v) && !('hookRejected' in v))
    assert.deepEqual(sb.gitCalls().filter((c) => /^(merge|push)( |$)/.test(c)), [], '誤った起点を merge / push しない')
    assert.equal(sb.remoteSha(), before)
  })

  t('正常: URL の形式（ssh 2 種・https・.git の有無・大文字小文字の違い）は同じリポジトリとして受理する', () => {
    for (const url of [
      `git@github.com:${REPO}.git`, `ssh://git@github.com/${REPO}`, `https://github.com/${REPO}`,
      `https://GitHub.com/${REPO.toUpperCase()}.git`, `https://github.com/${REPO.toLowerCase()}.git/`,
    ]) {
      const sb = makeSandbox()
      const v = result(run(bash, sb, { env: { FAKE_REMOTE_URL: url } }))
      assert.equal(v.pushed, true, url)
    }
  })

  t('取り込み不要: ブランチが base をすでに含むなら Already up to date で pushed: false。リモートは動かない', () => {
    const sb = makeSandbox({ branchHasBase: true })
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, false)
    assert.match(v.summary, /^Already up to date/)
    assert.ok(!('commitFailed' in v))
    assert.equal(sb.remoteSha(), before)
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [], 'push しない')
  })

  t('取り込み不要: ブランチに独自コミットが無い（先頭が base に含まれる）なら fast-forward せず何も push しない', () => {
    const sb = makeSandbox({ branchBehindOnly: true })
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, false)
    assert.match(v.summary, /取り込む差分なし/)
    assert.equal(sb.remoteSha(), before, 'base の先端をブランチへ push してしまわない')
    assert.deepEqual(sb.gitCalls().filter((c) => /^(push|merge)( |$)/.test(c)), [])
  })

  t('コンフリクト: 解消せず abort し、conflict + commitFailed で返す。push せず作業ツリーも merge 前に戻る', () => {
    const sb = makeSandbox({ conflict: true })
    const before = sb.remoteSha()
    const pre = git(sb.wt, 'rev-parse', `refs/remotes/origin/${BRANCH}`)
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed, conflict: v.conflict }, { pushed: false, commitFailed: true, conflict: true })
    assert.ok(!('hookRejected' in v) && !('routingError' in v))
    assert.equal(sb.remoteSha(), before)
    assert.equal(sb.headSha(), pre, 'merge を abort して detached HEAD は取り込み前に戻る')
    assert.equal(existsSync(join(sb.wt, '.git', 'MERGE_HEAD')), false)
    assert.equal(git(sb.wt, 'status', '--porcelain'), '')
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [])
  })

  t('commit hook が拒否: hookRejected + commitFailed で返し、abort して push しない', () => {
    const sb = makeSandbox()
    sb.writeHook(join(sb.wt, '.git'), 'commit-msg', 'echo "subject rejected" >&2; exit 1')
    const before = sb.remoteSha()
    const pre = git(sb.wt, 'rev-parse', `refs/remotes/origin/${BRANCH}`)
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed, hookRejected: v.hookRejected }, { pushed: false, commitFailed: true, hookRejected: true })
    assert.ok(!('conflict' in v))
    assert.doesNotMatch(v.summary, /subject rejected/, 'hook の出力（外部由来の文字列）を summary に載せない')
    assert.equal(sb.remoteSha(), before)
    assert.equal(sb.headSha(), pre)
    assert.equal(existsSync(join(sb.wt, '.git', 'MERGE_HEAD')), false)
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [])
  })

  t('push が拒否される（pre-receive 相当）: pushed: false。リモートは動かず、commitFailed / hookRejected を付けない', () => {
    const sb = makeSandbox()
    sb.writeHook(sb.origin, 'pre-receive', 'echo "push denied" >&2; exit 1')
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, false)
    assert.match(v.summary, /push が失敗/)
    assert.ok(!('commitFailed' in v) && !('routingError' in v) && !('hookRejected' in v))
    assert.doesNotMatch(v.summary, /push denied/)
    assert.equal(sb.remoteSha(), before)
  })

  t('push 後にリモート head が書き換わった（並行 push 競合）: push は成功しても pushed: false（race）', () => {
    const sb = makeSandbox()
    // 他者のコミットを refs/heads/other に置き、受理された直後にブランチをそれへ差し替える
    git(sb.seed, 'checkout', '-q', '-b', 'other', `origin/${BRANCH}`)
    writeFileSync(join(sb.seed, 'other.txt'), 'other\n')
    git(sb.seed, 'add', 'other.txt')
    git(sb.seed, 'commit', '-q', '-m', 'other')
    git(sb.seed, 'push', '-q', 'origin', 'other')
    const other = sb.remoteSha('other')
    sb.writeHook(sb.origin, 'post-receive', `while read old new ref; do [ "$ref" = refs/heads/${BRANCH} ] && git update-ref refs/heads/${BRANCH} ${other}; done`)
    const v = result(run(bash, sb))
    assert.equal(v.pushed, false)
    assert.match(v.summary, /並行 push 競合/)
    assert.equal(sb.remoteSha(), other)
    assert.notEqual(sb.headSha(), other)
  })

  t('push 前のリモート head がすでにローカル HEAD と同じ（変更なしの空振り）: push が成功しても pushed: false（noop）', () => {
    const sb = makeSandbox()
    const v = result(run(bash, sb, { env: { FAKE_LS_1: 'head' } }))
    assert.equal(v.pushed, false)
    assert.match(v.summary, /no-op/)
  })

  t('push 前後の ls-remote が失敗して比較できない: push は実行する（作業の保全）が pushed: false（unverified）', () => {
    for (const failing of ['FAKE_LS_1', 'FAKE_LS_2']) {
      const sb = makeSandbox()
      const before = sb.remoteSha()
      const v = result(run(bash, sb, { env: { [failing]: 'fail' } }))
      assert.equal(v.pushed, false, failing)
      assert.match(v.summary, /確認できず/, failing)
      assert.notEqual(sb.remoteSha(), before, `${failing}: push 自体は実行されている`)
      assert.equal(sb.lsCalls(), 2)
    }
  })

  // ---- routing ガード: 不一致なら fetch / checkout / merge / push を一切呼ばない ----
  t('routing: remote の host が github.com でない（同じ owner/repo の別ホスト・非 URL）は routingError。変更系の git を呼ばない', () => {
    for (const url of [
      `git@evil.example:${REPO}.git`, `https://evil.example/${REPO}`, `ssh://git@evil.example/${REPO}`,
      `https://github.com.evil.example/${REPO}`, `https://token@github.com/${REPO}`, `/srv/git/${REPO}`, '',
    ]) {
      const sb = makeSandbox()
      const before = sb.remoteSha()
      const v = result(run(bash, sb, { env: { FAKE_REMOTE_URL: url } }))
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, url)
      assert.match(v.summary, /^worktree routing error:/)
      assert.deepEqual(mutatingCalls(sb), [], `${url}: 変更系の git を呼んでいない`)
      assert.equal(sb.remoteSha(), before)
    }
  })

  t('routing: owner/repo が期待と違う（別リポ・余計なパス・部分一致）は routingError。変更系の git を呼ばない', () => {
    for (const url of [
      'https://github.com/Fandhe-AI/other-repo', 'https://github.com/other-org/agent-cli-skills', `https://github.com/${REPO}/extra`,
      `https://github.com/${REPO}-fork`, 'https://github.com/Fandhe-AI',
    ]) {
      const sb = makeSandbox()
      const v = result(run(bash, sb, { env: { FAKE_REMOTE_URL: url } }))
      assert.equal(v.routingError, true, url)
      assert.equal(v.pushed, false)
      assert.deepEqual(mutatingCalls(sb), [], url)
    }
  })

  t('routing: 期待リポジトリが空（未確定）は常に不一致 = routingError。変更系の git を呼ばない', () => {
    const sb = makeSandbox()
    const v = result(run(bash, sb, { args: ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', ''] }))
    assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true })
    assert.deepEqual(mutatingCalls(sb), [])
  })

  t('routing: PR の headRefName が違う・PR 番号が違う・PR を解決できない（gh 取得失敗）は routingError。変更系の git を呼ばない', () => {
    const cases = {
      headRefName違い: { out: JSON.stringify({ number: PR, headRefName: 'feat/999-other' }) },
      番号違い: { out: JSON.stringify({ number: PR + 1, headRefName: BRANCH }) },
      gh失敗: { out: '{"message":"Not Found"}', exit: 1 },
      空応答: { out: '', exit: 0 },
    }
    for (const [name, spec] of Object.entries(cases)) {
      const sb = makeSandbox()
      sb.stub.set('prview', spec)
      const before = sb.remoteSha()
      const v = result(run(bash, sb))
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, name)
      assert.deepEqual(mutatingCalls(sb), [], `${name}: 変更系の git を呼んでいない`)
      assert.equal(sb.remoteSha(), before, name)
    }
  })

  // ---- 取り込み前の失敗 ----
  t('branch の fetch 失敗（リモートのブランチが無い）は commitFailed。merge も push もしない', () => {
    const sb = makeSandbox()
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.ok(!('conflict' in v) && !('hookRejected' in v))
    assert.deepEqual(sb.gitCalls().filter((c) => /^(merge|push)( |$)/.test(c)), [])
  })

  t('base の fetch 失敗（リモートに base が無い）は commitFailed。merge も push もしない', () => {
    const sb = makeSandbox()
    const before = sb.remoteSha()
    const v = result(run(bash, sb, { args: ['--pr', String(PR), '--branch', BRANCH, '--base', 'no-such-base', '--repo', REPO] }))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.deepEqual(sb.gitCalls().filter((c) => /^(merge|push)( |$)/.test(c)), [])
    assert.equal(sb.remoteSha(), before)
  })

  t('作業ツリーに未コミットの変更がある（clean でない）なら commitFailed。checkout も merge も push もしない', () => {
    const sb = makeSandbox()
    writeFileSync(join(sb.wt, 'a.txt'), 'dirty\n')
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.deepEqual(sb.gitCalls().filter((c) => /^(checkout|merge|push)( |$)/.test(c)), [])
  })

  // ---- 自衛: 引数の再検証 ----
  t('引数: --branch と --base が同じ値・形式不正・未知の引数・欠落は exit 2 で、結果の行も git の変更も出さない', () => {
    const bad = [
      ['--pr', String(PR), '--branch', BASE, '--base', BASE, '--repo', REPO],
      ['--pr', '0', '--branch', BRANCH, '--base', BASE, '--repo', REPO],
      ['--pr', '1x', '--branch', BRANCH, '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', 'a;touch pwned', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', '$(touch pwned)', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', '-x', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', 'a..b', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'a b', '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', 'no-slash'],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', 'a/b/c'],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', '-evil/repo'],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', 'owner/..'],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', REPO, '--force'],
      ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', REPO, '--subject', 'x'],
      ['--pr'],
      [],
    ]
    for (const args of bad) {
      const sb = makeSandbox()
      const r = run(bash, sb, { args })
      assert.equal(r.status, 2, `${JSON.stringify(args)} / ${r.stderr}`)
      assert.doesNotMatch(r.stdout, /BASE_MERGE_RESULT/)
      assert.equal(existsSync(join(sb.wt, 'pwned')), false)
      assert.deepEqual(mutatingCalls(sb), [])
    }
  })
}

// ---- run-verified.sh 経由: スクリプトを実行できない場合は結果の行が出ず、エージェントは fallback で返す ----
// 起動コマンドは run-verified.sh を経由する。ハッシュ不一致（exit 3）・スクリプト欠落（exit 4）では base-merge.sh は動かず、
// 標準出力に BASE_MERGE_RESULT の行が出ない。プロンプトはこのとき pushed: false・commitFailed: true で返させ、ホストは
// 失敗終端する（tests/base-merge-host-flow.test.mjs の fallback）。ここは『動かない』『git に何も触れない』ことを固定する。
const RUN_VERIFIED = join(dirname(SCRIPT), 'run-verified.sh')
function cloneScripts(omit = []) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-bm-launch-'))
  const scripts = join(dir, 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  for (const f of ['run-verified.sh', 'base-merge.sh']) if (!omit.includes(f)) copyFileSync(join(dirname(SCRIPT), f), join(scripts, f))
  for (const f of readdirSync(join(dirname(SCRIPT), 'lib'))) copyFileSync(join(dirname(SCRIPT), 'lib', f), join(scripts, 'lib', f))
  return { dir, scripts }
}

for (const bash of BASHES) {
  const t = (name, fn) => test(`[${bash}] ${name}`, { skip: !jqAvailable }, fn)
  const launch = (sb, scripts, sha) => spawnSync(bash, [join(scripts, 'run-verified.sh'), sha, 'base-merge.sh', ...ARGS], { cwd: sb.wt, encoding: 'utf8', env: sb.env() })

  t('launcher 経由: 期待ハッシュと一致すれば起動して結果の行を出す（ハッシュ定義はビルダーの bundleSha256）', () => {
    const sb = makeSandbox()
    const { dir, scripts } = cloneScripts()
    try {
      const r = launch(sb, scripts, bundleSha256(scripts, 'base-merge.sh'))
      assert.equal(result(r).pushed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  t('launcher 経由: ハッシュ不一致（版ずれ・書き換え）は exit 3 で起動せず、結果の行を出さず、git に何も触れない', () => {
    for (const mutate of ['wrong-sha', 'edit-script', 'edit-lib']) {
      const sb = makeSandbox()
      const { dir, scripts } = cloneScripts()
      try {
        const sha = bundleSha256(scripts, 'base-merge.sh')
        if (mutate === 'edit-script') writeFileSync(join(scripts, 'base-merge.sh'), `${readFileSync(join(scripts, 'base-merge.sh'), 'utf8')}\n# tampered\n`)
        if (mutate === 'edit-lib') writeFileSync(join(scripts, 'lib', 'push-verify.sh'), `${readFileSync(join(scripts, 'lib', 'push-verify.sh'), 'utf8')}\n# tampered\n`)
        const r = launch(sb, scripts, mutate === 'wrong-sha' ? 'a'.repeat(64) : sha)
        assert.equal(r.status, 3, `${mutate}: ${r.stderr}`)
        assert.doesNotMatch(r.stdout, /BASE_MERGE_RESULT/)
        assert.deepEqual(sb.gitCalls(), [], `${mutate}: git に何も触れない`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  t('launcher 経由: スクリプトが無い（同期漏れ）は exit 4 で、結果の行を出さず、git に何も触れない', () => {
    const sb = makeSandbox()
    const { dir, scripts } = cloneScripts(['base-merge.sh'])
    try {
      const r = launch(sb, scripts, 'a'.repeat(64))
      assert.equal(r.status, 4, r.stderr)
      assert.doesNotMatch(r.stdout, /BASE_MERGE_RESULT/)
      assert.deepEqual(sb.gitCalls(), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  t('スクリプトの使い方の誤り（exit 2）も結果の行を出さない。ホストの fallback と同じ経路になる', () => {
    const sb = makeSandbox()
    const r = run(bash, sb, { args: ['--pr', 'x'] })
    assert.equal(r.status, 2)
    assert.doesNotMatch(r.stdout, /BASE_MERGE_RESULT/)
  })
}

test('起動コマンドの SCRIPT_SHA256 に base-merge.sh が登録され、ビルダーが埋め込むハッシュは実スクリプト + lib の bundleSha256 と一致する', () => {
  const scripts = dirname(SCRIPT)
  const dist = readFileSync(join(scripts, 'implement-issue-tree.js'), 'utf8')
  assert.ok(dist.includes(`'base-merge.sh':'${bundleSha256(scripts, 'base-merge.sh')}'`), '生成物のハッシュが実スクリプトと一致しない（node build-workflow.mjs で再生成する）')
  assert.ok(existsSync(RUN_VERIFIED))
})

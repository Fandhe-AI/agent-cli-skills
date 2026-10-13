// scripts/pr-push.sh を実 git で走らせる回帰テスト一式（Issue #603 第 4 弾）。ファイル名が `*.test.mjs` に一致しないため node --test の
// glob には拾われない。tests/pr-push.test.mjs（1 つ目の bash）と tests/pr-push-alt-bash.test.mjs（2 つ目以降）が registerPrPushTests(bash)
// を呼ぶ（base-merge と同じ。node --test はファイル単位で並列に走るので bash を分けると所要が 1/2 になる）。
//
// 判定ロジックの表（起点の決定・PR の分類・番号の取り出し・形式検証）は tests/pr-push-unit.test.mjs が lib を 1 回の起動で検査する。
// ここは『スクリプト全体を実 git で走らせる』代表ケースに絞る: prepare（起点 3 種・中止 4 種・コンフリクト・hook 拒否・routing）、
// push（pushed・noop・no-diff・merge-in-progress・push 拒否・確認不能）、pr（created・reused・不一致・失敗・入力不正）。
// 実 git は tests/lib/git-sandbox.mjs（bare の origin のテンプレートコピー）。`git remote get-url` を偽の URL で返すシムが全呼び出しを
// 記録するので、中止の経路で変更系の git を一切呼んでいないことを履歴で確かめる。gh は pr list / pr create だけの偽物（jq で --jq を適用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolExists } from './signed-output.mjs'
import { BASE, BRANCH, REPO, git, makeSandbox } from './git-sandbox.mjs'

export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'pr-push.sh')
const jqAvailable = toolExists('jq')
const MUTATING = /^(fetch|checkout|merge|push|commit|reset|switch)( |$)/
const TOKEN = 'ghp_SECRETTOKEN0123456789abcdef'
const SUBJECT = 'chore: base ブランチの変更を取り込む'
const GH_STUB = `#!/bin/sh
echo "$*" >> "\${GHPR_LOG:?}"
if [ "$1" = pr ] && [ "$2" = list ]; then
  [ "\${GHPR_LIST_FAIL:-}" = 1 ] && exit 1
  expr=""; prev=""
  for a in "$@"; do [ "$prev" = --jq ] && expr=$a; prev=$a; done
  printf '%s' "\${GHPR_LIST_JSON:-[]}" | jq -r "$expr"
  exit $?
fi
if [ "$1" = pr ] && [ "$2" = create ]; then
  [ "\${GHPR_CREATE_FAIL:-}" = 1 ] && exit 1
  printf '%s\\n' "\${GHPR_CREATE_OUT:-https://github.com/${REPO}/pull/77}"
  exit 0
fi
echo "gh stub: 未定義の呼び出し: $*" >&2
exit 99
`

function ghEnv(sb, extra = {}) {
  const dir = join(sb.root, 'ghpr')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'gh'), GH_STUB)
  chmodSync(join(dir, 'gh'), 0o755)
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) writeFileSync(log, '')
  return sb.env({ PATH: `${dir}:${sb.shimDir}:${process.env.PATH}`, GHPR_LOG: log, ...extra })
}
const ghCalls = (sb) => readFileSync(join(sb.root, 'ghpr', 'calls.log'), 'utf8').split('\n').filter(Boolean)

function run(bash, sb, args, env = {}) {
  return spawnSync(bash, [SCRIPT, ...args], { cwd: sb.wt, encoding: 'utf8', env: ghEnv(sb, env) })
}
// 標準出力は結果の 1 行だけ。値は固定語彙・整数・40 桁 16 進だけで、URL・トークンを出力に含めない
function result(r) {
  assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `標準出力は結果の 1 行だけ:\n${r.stdout}`)
  assert.match(lines[0], /^PR_PUSH_RESULT \{/)
  const v = JSON.parse(lines[0].slice('PR_PUSH_RESULT '.length))
  for (const [k, x] of Object.entries(v)) {
    if (k === 'prNumber') assert.ok(Number.isInteger(x) && x > 0)
    else if (k === 'localSha' || k === 'remoteSha') assert.match(x, /^[0-9a-f]{40}$/)
    else assert.match(String(x), /^[a-z-]+$/, `${k}: 固定語彙だけ`)
  }
  assert.doesNotMatch(r.stdout + r.stderr, /github\.com|ghp_|https?:\/\/|origin\.git/, 'URL・トークンを出力しない')
  return v
}
const mutatingSince = (sb, n) => sb.gitCalls().slice(n).filter((c) => MUTATING.test(c))
const baseArgs = (kind) => ['--mode', 'prepare', '--origin', kind, '--branch', BRANCH, '--base', BASE]
const localBranch = (sb) => git(sb.wt, 'branch', BRANCH, `origin/${BRANCH}`)
const commitOn = (dir, file, msg) => {
  writeFileSync(join(dir, file), `${msg}\n`)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', msg)
}

export function registerPrPushTests(bash) {
  const t = (name, fn) => test(`[${bash}] ${name}`, { skip: !jqAvailable }, fn)
  const prepare = (sb, kind, extra = [], env = {}) => result(run(bash, sb, [...baseArgs(kind), ...extra], env))
  const push = (sb, kind, env = {}) => result(run(bash, sb, ['--mode', 'push', '--origin', kind, '--branch', BRANCH, '--base', BASE], env))

  // ---- prepare: 起点 ----
  t('prepare pr-create: リモートに branch が無い（初回）はローカル起点。base を取り込んだマージコミット（親 2 つ・埋め込み subject）を作り、push はしない', () => {
    const sb = makeSandbox()
    localBranch(sb)
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    const local = git(sb.wt, 'rev-parse', BRANCH)
    const v = prepare(sb, 'pr-create')
    assert.deepEqual(v, { mode: 'prepare', status: 'merged', start: 'local' })
    assert.equal(git(sb.wt, 'log', '-1', '--format=%s'), SUBJECT)
    assert.equal(git(sb.wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3)
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD^1'), local)
    assert.equal(git(sb.wt, 'rev-parse', BRANCH), local, 'ローカルの refs/heads/ は更新しない（detached HEAD のまま）')
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [])
    assert.deepEqual(readdirSync(sb.tmp), [], '一時ファイルが残らない')
  })

  t('prepare pr-create: ローカルとリモートが同一 sha ならリモート起点。リモートがローカルの祖先（local ahead）はローカル起点で続ける', () => {
    const sb = makeSandbox()
    localBranch(sb)
    assert.deepEqual(prepare(sb, 'pr-create'), { mode: 'prepare', status: 'merged', start: 'remote' })
    const sb2 = makeSandbox()
    localBranch(sb2)
    git(sb2.wt, 'checkout', '-q', BRANCH)
    commitOn(sb2.wt, 'local-only.txt', 'local ahead')
    git(sb2.wt, 'checkout', '-q', '--detach')
    assert.deepEqual(prepare(sb2, 'pr-create'), { mode: 'prepare', status: 'merged', start: 'local' })
    assert.equal(existsSync(join(sb2.wt, 'local-only.txt')), true)
  })

  t('prepare fix: リモートの branch を detach して base を取り込む（ローカルの refs/heads/ は不要）。branch が消えていれば止まる', () => {
    const sb = makeSandbox()
    const v = prepare(sb, 'fix')
    assert.deepEqual(v, { mode: 'prepare', status: 'merged', start: 'remote' })
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD^1'), git(sb.wt, 'rev-parse', `refs/remotes/origin/${BRANCH}`))
    const sb2 = makeSandbox()
    git(sb2.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    const n = sb2.gitCalls().length
    assert.equal(prepare(sb2, 'fix').status, 'branch-fetch-failed')
    assert.deepEqual(mutatingSince(sb2, n).filter((c) => /^(checkout |merge |push )/.test(c)), [])
  })

  t('prepare pr-create: remote ahead（第三者の push と区別できない）・diverged・ローカル欠落は中止する。HEAD は動かず merge も push もしない。両 tip の sha を返す', () => {
    // remote ahead: ローカルが古く、リモートが進んでいる
    const sb = makeSandbox()
    localBranch(sb)
    git(sb.seed, 'checkout', '-q', BRANCH)
    commitOn(sb.seed, 'third.txt', 'third party')
    git(sb.seed, 'push', '-q', 'origin', BRANCH)
    const head0 = git(sb.wt, 'rev-parse', 'HEAD')
    const v = prepare(sb, 'pr-create')
    assert.equal(v.status, 'remote-ahead')
    assert.equal(v.localSha, git(sb.wt, 'rev-parse', BRANCH))
    assert.equal(v.remoteSha, sb.remoteSha())
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD'), head0)
    assert.deepEqual(sb.gitCalls().filter((c) => /^(merge |push |checkout --detach)/.test(c)), [])
    // diverged
    const sb2 = makeSandbox()
    localBranch(sb2)
    git(sb2.wt, 'checkout', '-q', BRANCH)
    commitOn(sb2.wt, 'mine.txt', 'mine')
    git(sb2.wt, 'checkout', '-q', '--detach')
    git(sb2.seed, 'checkout', '-q', BRANCH)
    commitOn(sb2.seed, 'theirs.txt', 'theirs')
    git(sb2.seed, 'push', '-q', 'origin', BRANCH)
    assert.equal(prepare(sb2, 'pr-create').status, 'diverged')
    assert.deepEqual(sb2.gitCalls().filter((c) => /^(merge |push )/.test(c)), [])
    // ローカルの refs/heads/ が無い
    const sb3 = makeSandbox()
    assert.equal(prepare(sb3, 'pr-create').status, 'local-missing')
    assert.deepEqual(sb3.gitCalls().filter((c) => /^(merge |push )/.test(c)), [])
  })

  t('prepare: checkout 後の HEAD が起点の sha と違う（隔離 worktree に残っていた無関係な HEAD）なら sha-mismatch。merge も push もしない（旧 Issue #466 の回帰）', () => {
    for (const kind of ['pr-create', 'fix']) {
      const sb = makeSandbox()
      if (kind === 'pr-create') localBranch(sb)
      const baseTip = git(sb.wt, 'rev-parse', `refs/remotes/origin/${BASE}`)
      sb.writeHook(join(sb.wt, '.git'), 'post-checkout', `git update-ref --no-deref HEAD ${baseTip}`)
      const before = sb.remoteSha()
      assert.equal(prepare(sb, kind).status, 'sha-mismatch', kind)
      assert.deepEqual(sb.gitCalls().filter((c) => /^(merge |push )/.test(c)), [], kind)
      assert.equal(sb.remoteSha(), before, kind)
    }
  })

  t('push: push.followTags が有効で注釈付きタグがあっても、タグは origin に出ない（ブランチの 1 ref だけを push する）', () => {
    const sb = makeSandbox()
    assert.equal(prepare(sb, 'fix').status, 'merged')
    git(sb.wt, 'config', 'push.followTags', 'true')
    git(sb.wt, 'tag', '-a', 'v-follow', '-m', 'annotated', 'HEAD')
    assert.equal(push(sb, 'fix').status, 'pushed')
    assert.equal(git(sb.origin, 'for-each-ref', 'refs/tags'), '')
  })

  t('prepare: base の fetch が失敗したら何も動かさず base-fetch-failed（stale な origin/<base> を取り込まない）', () => {
    const sb = makeSandbox()
    localBranch(sb)
    // 以前の処理が残した追跡 ref を再現し、origin の base を消して fetch を失敗させる
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BASE}`)
    const head0 = git(sb.wt, 'rev-parse', 'HEAD')
    const v = prepare(sb, 'pr-create')
    assert.equal(v.status, 'base-fetch-failed')
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD'), head0)
    assert.deepEqual(sb.gitCalls().filter((c) => /^(checkout |merge |push )/.test(c)), [])
    assert.equal(git(sb.wt, 'for-each-ref', `refs/remotes/origin/${BASE}`), '', '失敗した fetch が古い追跡 ref を残さない')
  })

  // ---- prepare: 取り込み ----
  t('prepare: 取り込む差分が無い（base を取り込み済み）は up-to-date、ブランチの先頭が base に含まれるなら no-own-commits。どちらも新しいコミットを作らない', () => {
    const sb = makeSandbox({ branchHasBase: true })
    const v = prepare(sb, 'fix')
    assert.equal(v.status, 'up-to-date')
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD'), sb.remoteSha())
    const sb2 = makeSandbox({ branchBehindOnly: true })
    assert.equal(prepare(sb2, 'fix').status, 'no-own-commits')
    assert.equal(git(sb2.wt, 'rev-parse', 'HEAD'), sb2.remoteSha())
  })

  t('prepare: コンフリクトは解消せずマージを途中のまま残して conflict を返す。その状態で push しようとすると merge-in-progress で止まり、push しない', () => {
    const sb = makeSandbox({ conflict: true })
    const v = prepare(sb, 'fix')
    assert.deepEqual(v, { mode: 'prepare', status: 'conflict', start: 'remote' })
    assert.equal(existsSync(join(sb.wt, '.git', 'MERGE_HEAD')), true, 'MERGE_HEAD が残っている（エージェントが解消する）')
    const before = sb.remoteSha()
    const n = sb.gitCalls().length
    assert.equal(push(sb, 'fix').status, 'merge-in-progress')
    assert.deepEqual(sb.gitCalls().slice(n).filter((c) => /^push( |$)/.test(c)), [])
    assert.equal(sb.remoteSha(), before)
  })

  t('prepare: commit hook が既定 subject を拒否したら abort して hook-rejected。--subject-file で渡した subject なら通り、そのファイルは消さない', () => {
    const sb = makeSandbox()
    sb.writeHook(join(sb.wt, '.git'), 'commit-msg', 'grep -q "^feat(deps): " "$1" || { echo rejected >&2; exit 1; }')
    const v = prepare(sb, 'fix')
    assert.equal(v.status, 'hook-rejected')
    assert.equal(existsSync(join(sb.wt, '.git', 'MERGE_HEAD')), false, 'abort 済み')
    assert.equal(git(sb.wt, 'rev-parse', 'HEAD'), sb.remoteSha(), 'HEAD は起点のまま')
    const f = join(sb.tmp, 'subject.txt')
    writeFileSync(f, 'feat(deps): base を取り込む\n')
    assert.equal(prepare(sb, 'fix', ['--subject-file', f]).status, 'merged')
    assert.equal(git(sb.wt, 'log', '-1', '--format=%s'), 'feat(deps): base を取り込む')
    assert.equal(existsSync(f), true)
    assert.equal(prepare(sb, 'fix', ['--subject-file', join(sb.tmp, 'missing.txt')]).status, 'error')
  })

  // ---- prepare: routing ----
  t('prepare: --repo があり remote が期待と違う（fetch URL・push URL のどちらでも）なら routing-error。fetch・checkout・merge・push を一切呼ばず、URL を出力しない', () => {
    const cases = {
      'fetch URL': (sb) => git(sb.wt, 'remote', 'set-url', 'origin', sb.makeEvil()),
      'push URL': (sb) => git(sb.wt, 'remote', 'set-url', '--push', 'origin', sb.makeEvil()),
      'url の追加': (sb) => git(sb.wt, 'remote', 'set-url', '--add', 'origin', sb.makeEvil()),
    }
    for (const [name, apply] of Object.entries(cases)) {
      const sb = makeSandbox()
      apply(sb)
      const before = sb.remoteSha()
      const r = run(bash, sb, [...baseArgs('fix'), '--repo', REPO])
      assert.equal(result(r).status, 'routing-error', name)
      assert.deepEqual(sb.gitCalls().filter((c) => MUTATING.test(c)), [], name)
      assert.equal(sb.remoteSha(), before, name)
    }
    const sb = makeSandbox()
    assert.equal(prepare(sb, 'fix', ['--repo', 'Other-Org/other-repo']).status, 'routing-error', '期待リポジトリが違う')
    assert.deepEqual(sb.gitCalls().filter((c) => MUTATING.test(c)), [])
    // --repo が無ければ照合しない（ホストが args.repo を持たない Run は従来どおり）
    assert.equal(prepare(makeSandbox(), 'fix', [], { FAKE_REMOTE_URL: `https://x:${TOKEN}@evil.example/o/r` }).status, 'merged')
  })

  // ---- push ----
  t('push pr-create: 差分があれば HEAD:refs/heads/<branch> の 1 形だけで push して pushed。リモート head は HEAD と一致し、force・--no-verify・タグは出ない', () => {
    const sb = makeSandbox()
    localBranch(sb)
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    assert.equal(prepare(sb, 'pr-create').status, 'merged')
    const head = git(sb.wt, 'rev-parse', 'HEAD')
    const r = push(sb, 'pr-create')
    assert.deepEqual(r, { mode: 'push', status: 'pushed' })
    assert.equal(sb.remoteSha(), head)
    const pushes = sb.gitCalls().filter((c) => /^push( |$)/.test(c))
    assert.deepEqual(pushes, [`push --no-follow-tags origin HEAD:refs/heads/${BRANCH}`])
    for (const c of sb.gitCalls()) assert.doesNotMatch(c, /--force|--no-verify|--mirror|--delete|(^| )-f( |$)/, c)
    // 同じ HEAD をもう一度: リモートが既に HEAD なので noop（再入）
    assert.equal(push(sb, 'pr-create').status, 'noop')
  })

  t('push pr-create: base との差分が 0 件（起点の取り違え）は push せず no-diff。fix には差分ゼロ確認を課さない', () => {
    const sb = makeSandbox()
    assert.equal(prepare(sb, 'pr-create', [], {}).status, 'local-missing') // origin/BASE を取得させる
    git(sb.wt, 'checkout', '-q', '--detach', `refs/remotes/origin/${BASE}`)
    const before = sb.remoteSha()
    assert.equal(push(sb, 'pr-create').status, 'no-diff')
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [])
    assert.equal(sb.remoteSha(), before)
  })

  t('push: push が拒否されたら push-failed（リモートは動かない）。push 前後の確認ができなければ push は実行したうえで unverified', () => {
    const sb = makeSandbox()
    localBranch(sb)
    git(sb.wt, 'checkout', '-q', BRANCH)
    commitOn(sb.wt, 'x.txt', 'x')
    sb.writeHook(sb.origin, 'pre-receive', 'echo denied >&2; exit 1')
    const before = sb.remoteSha()
    assert.equal(push(sb, 'fix').status, 'push-failed')
    assert.equal(sb.remoteSha(), before)
    // push 後の ls-remote（2 回目）が失敗: 反映は確認できないので unverified。push 自体は届いている
    const sb2 = makeSandbox()
    localBranch(sb2)
    git(sb2.wt, 'checkout', '-q', BRANCH)
    commitOn(sb2.wt, 'y.txt', 'y')
    assert.equal(push(sb2, 'fix', { FAKE_LS_2: 'fail' }).status, 'unverified')
    assert.equal(sb2.remoteSha(), git(sb2.wt, 'rev-parse', 'HEAD'))
    const sb3 = makeSandbox()
    localBranch(sb3)
    git(sb3.wt, 'checkout', '-q', BRANCH)
    commitOn(sb3.wt, 'z.txt', 'z')
    assert.equal(push(sb3, 'fix', { FAKE_LS_1: 'fail' }).status, 'unverified', 'push 前の確認不能でも push は実行する')
    assert.equal(sb3.remoteSha(), git(sb3.wt, 'rev-parse', 'HEAD'))
  })

  // ---- pr ----
  const prFiles = (sb, { title = 'feat(x): 追加\n', body = 'body\n\nCloses #603\n' } = {}) => {
    const tf = join(sb.tmp, 'title.txt')
    const bf = join(sb.tmp, 'body.md')
    writeFileSync(tf, title)
    writeFileSync(bf, body)
    return ['--title-file', tf, '--body-file', bf, '--issue', '603']
  }
  const prArgs = (files, extra = []) => ['--mode', 'pr', '--branch', BRANCH, '--base', BASE, ...files, ...extra]
  const list = (rows) => JSON.stringify(rows.map(([number, baseRefName, headRefOid]) => ({ number, baseRefName, headRefOid })))

  t('pr: open PR が無ければ gh pr create（-R・--base・--head・--title・--body-file）で作成して prNumber を返す。URL は出力しない', () => {
    const sb = makeSandbox()
    const files = prFiles(sb)
    const v = result(run(bash, sb, prArgs(files, ['--repo', REPO])))
    assert.deepEqual(v, { mode: 'pr', status: 'created', prNumber: 77 })
    const calls = ghCalls(sb)
    assert.equal(calls.length, 2)
    assert.match(calls[0], new RegExp(`^pr list -R ${REPO} --state open --head ${BRANCH} --json number,baseRefName,headRefOid`))
    assert.match(calls[1], new RegExp(`^pr create -R ${REPO} --base ${BASE} --head ${BRANCH} --title feat\\(x\\): 追加 --body-file \\S+body\\.md$`))
    assert.ok(!calls.some((c) => !/^pr (list|create) /.test(c)), 'gh は pr list / pr create だけ（merge・review・close・edit を呼ばない）')
  })

  t('pr: base と head の sha が一致する open PR は再利用（reused）し作成しない。head が動いている・base だけ違う・複数・一覧の失敗は再利用も作成もしない', () => {
    const sb = makeSandbox()
    const files = prFiles(sb)
    const tip = sb.remoteSha()
    const reused = result(run(bash, sb, prArgs(files), { GHPR_LIST_JSON: list([[12, BASE, tip]]) }))
    assert.deepEqual(reused, { mode: 'pr', status: 'reused', prNumber: 12 })
    const cases = [
      [(x) => list([[12, BASE, 'f'.repeat(40)]]), 'head-mismatch', 12],
      [(x) => list([[12, 'develop', x]]), 'base-mismatch', undefined],
      [(x) => list([[12, BASE, x], [13, BASE, x]]), 'ambiguous', undefined],
    ]
    for (const [json, status, prNumber] of cases) {
      const sbx = makeSandbox()
      const v = result(run(bash, sbx, prArgs(prFiles(sbx)), { GHPR_LIST_JSON: json(sbx.remoteSha()) }))
      assert.equal(v.status, status)
      if (prNumber !== undefined) assert.equal(v.prNumber, prNumber)
      assert.ok(!ghCalls(sbx).some((c) => /^pr create/.test(c)), `${status}: 作成しない`)
    }
    const sbf = makeSandbox()
    assert.equal(result(run(bash, sbf, prArgs(prFiles(sbf)), { GHPR_LIST_FAIL: '1' })).status, 'list-failed')
    assert.ok(!ghCalls(sbf).some((c) => /^pr create/.test(c)))
    const sbc = makeSandbox()
    assert.equal(result(run(bash, sbc, prArgs(prFiles(sbc)), { GHPR_CREATE_FAIL: '1' })).status, 'create-failed')
    const sbu = makeSandbox()
    assert.equal(result(run(bash, sbu, prArgs(prFiles(sbu)), { GHPR_CREATE_OUT: 'created something' })).status, 'create-failed')
  })

  t('pr: 入力が不正なら gh を呼ばず止まる（タイトルが空・制御文字、body に「Closes #N」の行が無い・空）。リモート追跡 ref が無ければ no-remote-ref', () => {
    const cases = [
      [{ title: '\n' }, 'title-invalid'],
      [{ title: 'a\u001bb\n' }, 'title-invalid'],
      [{ body: 'no closing line\n' }, 'body-invalid'],
      [{ body: 'Closes #6030\n' }, 'body-invalid'],
      [{ body: '' }, 'body-invalid'],
    ]
    for (const [opts, status] of cases) {
      const sb = makeSandbox()
      assert.equal(result(run(bash, sb, prArgs(prFiles(sb, opts)))).status, status, JSON.stringify(opts))
      assert.deepEqual(ghCalls(sb), [], `${status}: gh を呼ばない`)
    }
    const sb = makeSandbox()
    git(sb.wt, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`)
    assert.equal(result(run(bash, sb, prArgs(prFiles(sb)))).status, 'no-remote-ref')
    assert.deepEqual(ghCalls(sb), [])
  })

  // ---- 引数の検証 ----
  t('引数の検証: 不正な形式・必須の欠落・モード違いの引数・未知の引数は exit 2 で結果の行を出さず、git / gh も動かさない', () => {
    const sb = makeSandbox()
    const files = prFiles(sb)
    const ok = baseArgs('fix')
    const bad = [
      [],
      ['--mode', 'merge', '--branch', BRANCH, '--base', BASE],
      [...ok.slice(0, -2)], // --base が無い
      [...ok, '--unknown', 'x'],
      ['--mode', 'prepare', '--origin', 'other', '--branch', BRANCH, '--base', BASE],
      ['--mode', 'prepare', '--branch', BRANCH, '--base', BASE], // --origin が無い
      ['--mode', 'prepare', '--origin', 'fix', '--branch', 'a b', '--base', BASE],
      ['--mode', 'prepare', '--origin', 'fix', '--branch', '../x', '--base', BASE],
      ['--mode', 'prepare', '--origin', 'fix', '--branch', BASE, '--base', BASE], // 同じ値
      [...ok, '--repo', 'a/b/c'],
      [...ok, '--repo', '-x/y'],
      [...ok, '--subject-file', 'relative.txt'],
      [...ok, '--subject-file', '/tmp/a b'],
      [...ok, ...files],
      ['--mode', 'push', '--origin', 'fix', '--branch', BRANCH, '--base', BASE, '--subject-file', '/tmp/x'],
      ['--mode', 'pr', '--branch', BRANCH, '--base', BASE],
      ['--mode', 'pr', '--branch', BRANCH, '--base', BASE, ...files, '--origin', 'fix'],
      prArgs(files.map((x) => (x.endsWith('title.txt') ? 'rel.txt' : x))),
      prArgs(files.map((x) => (x === '603' ? '0603' : x))),
      ['--mode', 'prepare'],
      ['--branch'],
    ]
    const n = sb.gitCalls().length
    for (const args of bad) {
      const r = run(bash, sb, args)
      assert.equal(r.status, 2, `${JSON.stringify(args)} → exit ${r.status} / ${r.stdout}`)
      assert.equal(r.stdout, '', JSON.stringify(args))
    }
    assert.deepEqual(sb.gitCalls().slice(n).filter((c) => !/^check-ref-format /.test(c)), [])
    assert.deepEqual(ghCalls(sb), [])
  })
}

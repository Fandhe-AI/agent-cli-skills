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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { trackTmp } from './lib/tmp-track.mjs'
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
// URL に埋め込まれ得る認証情報の代用。どの出力にも現れてはならない
const TOKEN = 'ghp_SECRETTOKEN0123456789abcdef'
// タグにしか無いコミットを origin に置く（ブランチや base と同じ名前のタグ）。そのコミットの sha を返す
function plantTag(sb, tag) {
  git(sb.seed, 'checkout', '-q', '-b', 'tag-work', BASE)
  writeFileSync(join(sb.seed, 'tag-only.txt'), 'tag\n')
  git(sb.seed, 'add', 'tag-only.txt')
  git(sb.seed, 'commit', '-q', '-m', 'tag only')
  const sha = git(sb.seed, 'rev-parse', 'HEAD')
  git(sb.seed, 'tag', tag)
  git(sb.seed, 'push', '-q', 'origin', `refs/tags/${tag}`)
  return sha
}

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

  t('正常: push の refspec は HEAD:refs/heads/<branch> の 1 形（--no-follow-tags 付き）で、--force 系・--no-verify・先頭 + を使わない', () => {
    const sb = makeSandbox()
    result(run(bash, sb))
    const pushes = sb.gitCalls().filter((c) => /^push( |$)/.test(c))
    assert.deepEqual(pushes, [`push --no-follow-tags origin HEAD:refs/heads/${BRANCH}`])
    for (const c of sb.gitCalls()) {
      assert.doesNotMatch(c, /--force|--no-verify|--force-with-lease|--mirror|--delete|(^| )-f( |$)/, c)
    }
  })

  // push.followTags=true だと、push するコミットの履歴を指す注釈付きタグが同じ push で origin へ出ていく
  t('push.followTags が有効で注釈付きタグがあっても、push でタグは origin に出ない（ブランチの 1 ref だけを push する）', () => {
    const sb = makeSandbox()
    git(sb.wt, 'config', 'push.followTags', 'true')
    git(sb.wt, 'tag', '-a', 'v-follow', '-m', 'annotated', `refs/remotes/origin/${BRANCH}`)
    assert.equal(git(sb.origin, 'tag', '-l'), '', '前提: origin にタグは無い')
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    assert.equal(git(sb.origin, 'for-each-ref', 'refs/tags'), '', 'origin にタグが作られていない')
    assert.equal(git(sb.wt, 'tag', '-l'), 'v-follow', 'ローカルのタグはそのまま')
  })

  t('正常: git の呼び出し順は routing 照合 → branch fetch → checkout → base fetch → merge → ls-remote → push → ls-remote', () => {
    const sb = makeSandbox()
    result(run(bash, sb))
    const calls = sb.gitCalls()
    const at = (re) => calls.findIndex((c) => re.test(c))
    const order = [
      at(/^remote get-url --all origin$/), at(new RegExp(`^fetch origin refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}$`)), at(/^checkout --detach refs\/remotes\/origin\//),
      at(new RegExp(`^fetch origin refs/heads/${BASE}:refs/remotes/origin/${BASE}$`)), at(/^merge --no-ff --no-edit -F /), at(/^ls-remote origin /), at(/^push --no-follow-tags origin /),
    ]
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order))
    assert.ok(at(/^remote get-url --push --all origin$/) >= 0 && at(/^remote get-url --push --all origin$/) < order[1], 'push 先 URL の照合も fetch より前')
    assert.deepEqual([...order].sort((a, b) => a - b), order, '順序が崩れている')
    assert.equal(calls.filter((c) => /^ls-remote /.test(c)).length, 2, 'push の前後で 1 回ずつ')
    // merge の引数は完全修飾の追跡 ref（短縮形 origin/<base> は同名のタグ refs/tags/origin/<base> に負ける）
    assert.match(calls[order[4]], new RegExp(`^merge --no-ff --no-edit -F \\S+ refs/remotes/origin/${BASE}$`))
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
      `https://github.com.evil.example/${REPO}`, `/srv/git/${REPO}`, '',
      // host の後方一致（github.com で終わる別ホスト）は拒否する
      `https://evilgithub.com/${REPO}`, `https://evil.github.com/${REPO}`, `git@notgithub.com:${REPO}`,
      `ssh://git@evilgithub.com/${REPO}`, `https://x:${TOKEN}@evilgithub.com/${REPO}`,
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

  // push 先だけが別の場所を指す設定の書き換え（隔離 worktree は本体の .git/config を共有するので、先行するエージェントが書ける）。
  // fetch URL（get-url --all）だけを見るガードでは、これらの push が evil 側へ届く。evil は実在する bare で、ref が 1 つも
  // 作られていないこと（= push が届いていない）まで確かめる
  t('routing: push 先だけが別リポジトリを指す（pushurl・pushInsteadOf・url の追加）は routingError。変更系の git を呼ばず、evil 側に ref が作られない', () => {
    const cases = {
      'remote set-url --push': (sb, evil) => git(sb.wt, 'remote', 'set-url', '--push', 'origin', evil),
      'url.<evil>.pushInsteadOf': (sb, evil) => git(sb.wt, 'config', `url.${evil}.pushInsteadOf`, sb.origin),
      'remote set-url --add': (sb, evil) => git(sb.wt, 'remote', 'set-url', '--add', 'origin', evil),
    }
    for (const [name, apply] of Object.entries(cases)) {
      const sb = makeSandbox()
      const evil = sb.makeEvil() // sb.env() の前（= run の前）に呼ぶ。get-url の出力を見せ替える対応表を env に載せるため
      apply(sb, evil)
      const before = sb.remoteSha()
      const r = run(bash, sb)
      const v = result(r)
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, name)
      assert.deepEqual(mutatingCalls(sb), [], `${name}: 変更系の git を呼んでいない`)
      assert.equal(git(evil, 'for-each-ref'), '', `${name}: evil 側に ref が 1 つも作られていない`)
      assert.equal(sb.remoteSha(), before, name)
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(evil.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), `${name}: URL を出力しない`)
    }
  })

  // 逆向き: fetch 元だけが別リポジトリ（push 先は正規）。取り込み元のすり替えで、evil 側のコミットが PR ブランチに入って push される
  t('routing: fetch URL だけが別リポジトリを指す（push 先は正規）は routingError。evil 側の内容を取り込んで push しない', () => {
    const sb = makeSandbox()
    const evil = sb.makeEvil()
    git(sb.seed, 'checkout', '-q', '-b', 'evil-work', BASE)
    writeFileSync(join(sb.seed, 'evil.txt'), 'evil\n')
    git(sb.seed, 'add', 'evil.txt')
    git(sb.seed, 'commit', '-q', '-m', 'evil')
    git(sb.seed, 'push', '-q', evil, `evil-work:refs/heads/${BRANCH}`, `evil-work:refs/heads/${BASE}`)
    git(sb.wt, 'remote', 'set-url', 'origin', evil)
    git(sb.wt, 'remote', 'set-url', '--push', 'origin', sb.origin)
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true })
    assert.deepEqual(mutatingCalls(sb), [])
    assert.equal(sb.remoteSha(), before)
    assert.ok(!existsSync(join(sb.wt, 'evil.txt')))
  })

  t('routing: 実 config の書き換えが get-url に反映されることの対照（書き換えなしなら pushed: true・push 先は origin）', () => {
    const sb = makeSandbox()
    const evil = sb.makeEvil()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    assert.equal(git(evil, 'for-each-ref'), '')
    const calls = sb.gitCalls()
    assert.ok(calls.includes('remote get-url --all origin') && calls.includes('remote get-url --push --all origin'), '両方の照合を呼んでいる')
  })

  // fetch 元を修飾しないと、同名のタグが優先されてタグにしか無いコミットがブランチへ入る
  t('タグ: PR ブランチと同名のタグがあっても refs/heads/ を取り込む（タグにしか無いコミットが push されない）', () => {
    const sb = makeSandbox()
    const tagSha = plantTag(sb, BRANCH)
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    const hist = git(sb.origin, 'rev-list', `refs/heads/${BRANCH}`).split('\n')
    assert.ok(!hist.includes(tagSha), 'タグ側のコミットがブランチ履歴に入っていない')
    assert.ok(!existsSync(join(sb.wt, 'tag-only.txt')))
    assert.equal(git(sb.origin, 'rev-parse', `refs/tags/${BRANCH}`), tagSha, 'タグ自体は動いていない')
  })

  t('タグ: base と同名のタグがあっても refs/heads/ の base を取り込む（タグ側のコミットが入らない）', () => {
    const sb = makeSandbox()
    const tagSha = plantTag(sb, BASE)
    const baseTip = sb.remoteSha(BASE)
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    const hist = git(sb.origin, 'rev-list', `refs/heads/${BRANCH}`).split('\n')
    assert.ok(hist.includes(baseTip), 'base ブランチの先端が取り込まれている')
    assert.ok(!hist.includes(tagSha), 'タグ側のコミットが入っていない')
  })

  // 短縮形 origin/<base> は refs/tags/origin/<base> を refs/remotes/origin/<base> より先に解決する。merge の引数が完全修飾でないと、
  // 同名のタグにしか無いコミットがブランチへ入る
  t('タグ: origin/<base> という名前のタグがローカルにあっても、merge するのは refs/remotes/origin/<base>（タグ側のコミットが入らない）', () => {
    const sb = makeSandbox()
    const tagSha = plantTag(sb, `origin/${BASE}`)
    git(sb.wt, 'fetch', '-q', 'origin', `refs/tags/origin/${BASE}:refs/tags/origin/${BASE}`)
    assert.equal(git(sb.wt, 'rev-parse', `refs/tags/origin/${BASE}`), tagSha, '前提: タグがローカルにある')
    assert.equal(git(sb.wt, 'rev-parse', `origin/${BASE}`), tagSha, '前提: 短縮形はタグへ解決される')
    const baseTip = sb.remoteSha(BASE)
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    const hist = git(sb.origin, 'rev-list', `refs/heads/${BRANCH}`).split('\n')
    assert.ok(hist.includes(baseTip), 'base ブランチの先端が取り込まれている')
    assert.ok(!hist.includes(tagSha), 'タグ側のコミットが入っていない')
    assert.ok(!existsSync(join(sb.wt, 'tag-only.txt')))
  })

  t('追跡 ref: base が force-push で書き換わっても、stale な追跡 ref に引きずられず書き換え後の base を取り込む', () => {
    const sb = makeSandbox()
    const oldBase = sb.remoteSha(BASE)
    git(sb.seed, 'checkout', '-q', '-B', BASE, `origin/${BASE}~1`)
    writeFileSync(join(sb.seed, 'rewritten-base.txt'), 'rewritten base\n')
    git(sb.seed, 'add', 'rewritten-base.txt')
    git(sb.seed, 'commit', '-q', '-m', 'rewritten base')
    git(sb.seed, 'push', '-q', '--force', 'origin', BASE)
    const newBase = sb.remoteSha(BASE)
    assert.notEqual(newBase, oldBase)
    assert.equal(git(sb.wt, 'rev-parse', `refs/remotes/origin/${BASE}`), oldBase, '前提: wt の追跡 ref は書き換え前の base のまま（非 fast-forward になる）')
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true, v.summary)
    const hist = git(sb.origin, 'rev-list', `refs/heads/${BRANCH}`).split('\n')
    assert.ok(hist.includes(newBase), '書き換え後の base が親に含まれている')
    assert.ok(!hist.includes(oldBase), '書き換え前の base は入っていない')
  })

  t('追跡 ref: PR ブランチが force-push で書き換わっても、stale な追跡 ref に引きずられず書き換え後の head を取り込む', () => {
    const sb = makeSandbox()
    git(sb.seed, 'checkout', '-q', '-B', BRANCH, `origin/${BASE}~1`)
    writeFileSync(join(sb.seed, 'rewritten.txt'), 'rewritten\n')
    git(sb.seed, 'add', 'rewritten.txt')
    git(sb.seed, 'commit', '-q', '-m', 'rewritten')
    git(sb.seed, 'push', '-q', '--force', 'origin', BRANCH)
    const rewritten = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.equal(v.pushed, true)
    const hist = git(sb.origin, 'rev-list', `refs/heads/${BRANCH}`).split('\n')
    assert.ok(hist.includes(rewritten), '書き換え後の head が親に含まれている')
  })

  // ---- URL の解析（userinfo・ポート・.git・トークンの非出力） ----
  t('URL: userinfo 付きの https（トークン入り）と標準ポート（https の 443・ssh の 22）は同じリポジトリとして受理する', () => {
    for (const url of [
      `https://x-access-token:${TOKEN}@github.com/${REPO}.git`, `https://${TOKEN}@github.com/${REPO}`, `https://github.com:443/${REPO}`,
      `https://u:p@GitHub.com:443/${REPO}.git/`, `ssh://git@github.com:22/${REPO}.git`,
    ]) {
      const sb = makeSandbox()
      const r = run(bash, sb, { env: { FAKE_REMOTE_URL: url } })
      const v = result(r)
      assert.equal(v.pushed, true, url)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), `${url}: トークンを出力しない`)
    }
  })

  t('URL: userinfo の偽装（https://github.com@evil.example/…）・非標準ポート・.GIT・http・git・ssh の別ユーザー・後方一致は routingError。トークンを出力しない', () => {
    for (const url of [
      `https://github.com@evil.example/${REPO}`, `https://${TOKEN}@evil.example/${REPO}`, `https://x:${TOKEN}@github.com.evil.example/${REPO}`,
      `https://github.com:8443/${REPO}`, `https://${TOKEN}@github.com:8443/${REPO}`, `ssh://git@github.com:2222/${REPO}`,
      `https://github.com/${REPO}.GIT`, `git@github.com:${REPO}.GIT`,
      `http://github.com/${REPO}`, `http://${TOKEN}@github.com/${REPO}`, `git://github.com/${REPO}`,
      `ssh://evil@github.com/${REPO}`, `evil@github.com:${REPO}`, `${TOKEN}@github.com:${REPO}`, `GIT@github.com:${REPO}`,
      `https://github.com/x/${REPO}`, `github.com/x/${REPO}`, `git@github.com:x/${REPO}`, `https://github.com/${REPO}\\evil`,
      `https://github.com/${REPO}?x=${TOKEN}`, `https://github.com/${REPO}#${TOKEN}`,
      // userinfo の中に区切り文字（バックスラッシュ・?・#）を置く偽装。WHATWG 系のパーサは \ ? # で authority を終えるので、本当の host は evil.example
      `https://evil.example\\@github.com/${REPO}`, `https://evil.example?@github.com/${REPO}`, `https://evil.example#@github.com/${REPO}`,
      // authority に @ が 2 つ以上ある（git は接続に失敗するが、エラー文に 2 つ目の userinfo が残る）。トークン中の @ は %40 で書く
      `https://a@evil.example@github.com/${REPO}`, `https://${TOKEN}@evil.example@github.com/${REPO}`, `https://a@b@github.com/${REPO}`, `https://@@github.com/${REPO}`,
    ]) {
      const sb = makeSandbox()
      const before = sb.remoteSha()
      const r = run(bash, sb, { env: { FAKE_REMOTE_URL: url } })
      const v = result(r)
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, url)
      assert.deepEqual(mutatingCalls(sb), [], `${url}: 変更系の git を呼んでいない`)
      assert.equal(sb.remoteSha(), before, url)
      assert.ok(!(r.stdout + r.stderr).includes(TOKEN), `${url}: トークンを出力しない`)
      assert.ok(!(r.stdout + r.stderr).includes('evil.example'), `${url}: URL を出力しない`)
    }
  })

  t('URL: トークンの @ をパーセントエンコード（%40）した userinfo は受理する（@ が 2 つ以上の拒否と区別される）', () => {
    const url = `https://x-access-token:p%40ss${TOKEN}@github.com/${REPO}.git`
    const sb = makeSandbox()
    const r = run(bash, sb, { env: { FAKE_REMOTE_URL: url } })
    assert.equal(result(r).pushed, true)
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN))
  })

  t('URL: 空の --repo は URL が owner/repo を欠く（git@github.com: ・https://github.com/）場合も routingError。変更系の git を呼ばない', () => {
    for (const url of ['git@github.com:', 'https://github.com/', `https://github.com/${REPO}`]) {
      const sb = makeSandbox()
      const v = result(run(bash, sb, { args: ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', ''], env: { FAKE_REMOTE_URL: url } }))
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, url)
      assert.match(v.summary, /期待リポジトリが未確定/, url)
      assert.deepEqual(mutatingCalls(sb), [], url)
    }
  })

  t('URL: git remote get-url が失敗する・空を返す（古い git など）は routingError。fetch URL・push URL のどちらでも変更系の git を呼ばない', () => {
    for (const mode of ['fail-fetch', 'fail-push', 'empty-push']) {
      const sb = makeSandbox()
      const bin = join(sb.root, `getfail-${mode}`)
      mkdirSync(bin, { recursive: true })
      const cond = mode === 'fail-fetch' ? '[ "$3" = --all ]' : '[ "$3" = --push ]'
      const act = mode === 'empty-push' ? 'exit 0' : 'exit 129'
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = remote ] && [ "$2" = get-url ] && ${cond}; then ${act}; fi\nexec "${sb.shimDir}/git" "$@"\n`)
      chmodSync(join(bin, 'git'), 0o755)
      const r = spawnSync(bash, [SCRIPT, ...ARGS], { cwd: sb.wt, encoding: 'utf8', env: { ...sb.env(), PATH: `${bin}:${sb.env().PATH}` } })
      const v = result(r)
      assert.deepEqual({ pushed: v.pushed, routingError: v.routingError }, { pushed: false, routingError: true }, mode)
      assert.deepEqual(mutatingCalls(sb), [], mode)
    }
  })

  // ---- gh pr view は期待リポジトリを -R で明示する ----
  t('gh pr view は -R <期待リポジトリ> を付ける（GH_REPO や gh repo set-default で別リポジトリの PR を引かない）', () => {
    const sb = makeSandbox()
    const v = result(run(bash, sb, { env: { GH_REPO: 'other-org/other-repo' } }))
    assert.equal(v.pushed, true)
    const views = sb.stub.calls().filter((c) => /^pr view /.test(c))
    assert.equal(views.length, 1)
    const tok = views[0].split(' ')
    assert.equal(tok[tok.indexOf('-R') + 1], REPO, views[0])
    assert.ok(!views[0].includes('other-repo'))
    // 呼び出し元が渡した表記（大文字小文字）をそのまま -R に渡す
    const sb2 = makeSandbox()
    result(run(bash, sb2, { args: ['--pr', String(PR), '--branch', BRANCH, '--base', BASE, '--repo', REPO.toUpperCase()] }))
    const tok2 = sb2.stub.calls().find((c) => /^pr view /.test(c)).split(' ')
    assert.equal(tok2[tok2.indexOf('-R') + 1], REPO.toUpperCase())
  })

  // ---- base の fetch 失敗は stale な追跡 ref があっても取り込まない ----
  t('base の fetch 失敗: ローカルに stale な origin/<base> が残っていても、それを merge・push しない（summary は base fetch 失敗）', () => {
    const sb = makeSandbox()
    assert.ok(git(sb.wt, 'rev-parse', `refs/remotes/origin/${BASE}`), '前提: stale な追跡 ref がある')
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BASE}`)
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.match(v.summary, /base fetch 失敗/)
    assert.deepEqual(sb.gitCalls().filter((c) => /^(merge|push)( |$)/.test(c)), [])
    assert.equal(sb.remoteSha(), before)
  })

  t('branch の fetch 失敗: ローカルに stale な origin/<branch> が残っていても、それを checkout・push しない（summary は branch fetch 失敗）', () => {
    const sb = makeSandbox()
    git(sb.origin, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    const v = result(run(bash, sb))
    assert.match(v.summary, /branch fetch 失敗/)
    assert.deepEqual(sb.gitCalls().filter((c) => /^(checkout|merge|push)( |$)/.test(c)), [])
  })

  // ---- サブモジュール ----
  t('サブモジュールの中身が dirty（未コミットの変更）なら clean でないとして commitFailed。checkout も merge も push もしない', () => {
    const sb = makeSandbox({ submodule: true })
    sb.dirtySubmodule()
    const before = sb.remoteSha()
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed }, { pushed: false, commitFailed: true })
    assert.match(v.summary, /clean でない/)
    assert.deepEqual(sb.gitCalls().filter((c) => /^(checkout|merge|push)( |$)/.test(c)), [])
    assert.equal(sb.remoteSha(), before)
  })

  t('サブモジュールが clean なら通常どおり取り込んで push する（対照）', () => {
    const sb = makeSandbox({ submodule: true })
    assert.equal(result(run(bash, sb)).pushed, true)
  })

  t('サブモジュールのポインタ（gitlink）のコンフリクトは自動解消せず conflict + commitFailed。abort して push しない', () => {
    const sb = makeSandbox({ gitlinkConflict: true })
    const before = sb.remoteSha()
    const pre = git(sb.wt, 'rev-parse', `refs/remotes/origin/${BRANCH}`)
    const v = result(run(bash, sb))
    assert.deepEqual({ pushed: v.pushed, commitFailed: v.commitFailed, conflict: v.conflict }, { pushed: false, commitFailed: true, conflict: true })
    assert.equal(sb.remoteSha(), before)
    assert.equal(sb.headSha(), pre, 'abort して取り込み前に戻る')
    assert.equal(existsSync(join(sb.wt, '.git', 'MERGE_HEAD')), false)
    assert.deepEqual(sb.gitCalls().filter((c) => /^push( |$)/.test(c)), [])
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
      ['--pr', '012', '--branch', BRANCH, '--base', BASE, '--repo', REPO],
      ['--pr', '00', '--branch', BRANCH, '--base', BASE, '--repo', REPO],
      ['--pr', '1x', '--branch', BRANCH, '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', 'a;touch pwned', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', '$(touch pwned)', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', '-x', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', 'refs/heads/feat/603-x', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'refs/heads/feat/603-x', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'refs/tags/x', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'refs/tags/x', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'HEAD', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'HEAD', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'main/', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'main/', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'main.lock', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'main.lock', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'a//b', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'a//b', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'a/.b', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'a/.b', '--repo', REPO],
      ['--pr', String(PR), '--branch', 'feat/x.lock', '--base', BASE, '--repo', REPO],
      ['--pr', String(PR), '--branch', BRANCH, '--base', 'feat/x.lock', '--repo', REPO],
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
  const dir = trackTmp(mkdtempSync(join(tmpdir(), 'iit-bm-launch-')))
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

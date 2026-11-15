// scripts/repo-scan.sh（外部チェック App の観測・対象外ラベルの取得）を偽 gh で実行して確かめる回帰テスト一式。
// bash ごとに登録できるよう関数にしてある（tests/repo-scan.test.mjs が 1 つ目の bash、tests/repo-scan-alt-bash.test.mjs が 2 つ目以降。
// fetch-tree-suite と同じ分割）。
//
// 期待する封筒（sha256・inputSha256）は、ホスト・スクリプトの実装とは独立に node:crypto で計算する（signed-output.mjs）。
// 旧コマンド（切り出し前の origin/main がプロンプトへ埋め込んでいた gh + jq の文字列）は fixtures に凍結してあり、同じ偽 gh の応答で
// 実行した結果と新スクリプトの結果を突き合わせる（意味を変えていないことの確認。差が出る入力は『意図した差』として明示する）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeGhRepoScanStub, checkRuns, issueList } from './gh-repo-scan-stub.mjs'
import { expectedSha256, repoScanInputSha256, toolExists } from './signed-output.mjs'
import { importDefinitions } from './stub-run.mjs'
import { bundleSha256 } from '../../scripts/build-workflow.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = join(HERE, '..', '..', 'scripts')
export const SCRIPT = join(SCRIPTS, 'repo-scan.sh')
const RUN_VERIFIED = join(SCRIPTS, 'run-verified.sh')
const FIXTURES = join(HERE, '..', 'fixtures')
const OLD_EXTERNAL = readFileSync(join(FIXTURES, 'repo-scan-old-external-checks-main.txt'), 'utf8')
const OLD_SKIP = readFileSync(join(FIXTURES, 'repo-scan-old-skip-labels-main.txt'), 'utf8').trim()
const NONCE = 'abc123nonce'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const haveJq = toolExists('jq')

const H = await importDefinitions(['verifySignedOutput', 'repoScanInputSha256', 'observedExternalApps', 'collectSkipLabelEntries'], 'repo-scan-suite')

export function run(bash, stub, args, { launcher = false, env = {} } = {}) {
  const argv = launcher ? [RUN_VERIFIED, bundleSha256(SCRIPTS, 'repo-scan.sh'), 'repo-scan.sh', ...args] : [SCRIPT, ...args]
  const r = spawnSync(bash, argv, { env: { ...stub.env(), ...env }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// 成功した実行の封筒（1 行）を検査して返す: 1 行・nonce・独立計算の sha256
function envelopeOf(r) {
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^[^\n]+\n$/, '標準出力は封筒 1 行だけ')
  const e = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(e).sort(), ['nonce', 'payload', 'sha256'])
  assert.equal(e.nonce, NONCE)
  assert.equal(e.sha256, expectedSha256(NONCE, e.payload), 'sha256 は nonce + payload の正規形')
  // 出力の payload は、キー昇順・空白なしの正規形のまま（JSON.stringify と同じバイト列。キー順は実装が昇順で出す）
  assert.ok(r.stdout.includes(`"payload":${JSON.stringify(e.payload)}`), 'payload は正規形')
  return e
}

export function registerRepoScanTests(bash) {
  const T = (name, fn, o = {}) => test(`[${bash}] ${name}`, { skip: !haveJq && 'jq が無い', ...o }, fn)
  const ext = (stub, extra = [], opts = {}) => run(bash, stub, ['--mode', 'external-checks', '--nonce', NONCE, ...extra], opts)
  const skip = (stub, labels, extra = [], opts = {}) => run(bash, stub, ['--mode', 'skip-labels', '--nonce', NONCE, ...extra, '--', ...labels], opts)

  // ---------------- external-checks ----------------

  T('external-checks: GitHub Actions 以外の App の slug を昇順・重複なしで返し、封筒はホストの照合を通る', () => {
    const stub = makeGhRepoScanStub({
      prs: [{ headRefOid: A }, { headRefOid: B }, { headRefOid: C }],
      checkRuns: { [A]: checkRuns(['cursor', 'github-actions', 'codecov']), [B]: checkRuns(['cursor']), [C]: checkRuns([]) },
    })
    const r = ext(stub)
    const e = envelopeOf(r)
    assert.deepEqual(e.payload, { apps: ['codecov', 'cursor'], dropped: 0, errs: 0, inputSha256: repoScanInputSha256('external-checks', ''), prs: 3 })
    // 実スクリプトの標準出力をホストの verifySignedOutput に通す（正準形のずれはスタブ製の封筒では見つからない）
    const signed = H.verifySignedOutput(e, NONCE, H.repoScanInputSha256('external-checks', undefined))
    assert.equal(signed.ok, true, JSON.stringify(signed))
  })

  T('external-checks: gh の呼び出しは pr list 1 回 + 各 PR の check-runs 1 回（ページ送りなし・GET だけ）で、cwd のリポジトリ（{owner}/{repo}）を使う', () => {
    const stub = makeGhRepoScanStub({ prs: [{ headRefOid: A }, { headRefOid: B }], checkRuns: { [A]: checkRuns(['x']), [B]: checkRuns(['y']) } })
    assert.equal(ext(stub).status, 0)
    const calls = stub.calls()
    assert.equal(calls.length, 3)
    assert.match(calls[0], /^pr list --state merged --limit 3 --json headRefOid --jq /)
    assert.ok(!calls[0].includes(' -R '))
    assert.ok(calls[1].startsWith(`api repos/{owner}/{repo}/commits/${A}/check-runs --jq `) && !calls.some((c) => c.includes('--paginate')))
    assert.ok(!calls.some((c) => /-X |-f |-F |--method|--input/.test(c)), '書き込み系の指定がある')
  })

  T('external-checks: --repo は pr list の -R と check-runs のパスと入力の束縛に入る', () => {
    const stub = makeGhRepoScanStub({ prs: [{ headRefOid: A }], checkRuns: { [A]: checkRuns(['cursor']) } })
    const e = envelopeOf(ext(stub, ['--repo', 'Fandhe-AI/target']))
    assert.equal(e.payload.inputSha256, repoScanInputSha256('external-checks', 'Fandhe-AI/target'))
    assert.notEqual(e.payload.inputSha256, repoScanInputSha256('external-checks', ''))
    const calls = stub.calls()
    assert.match(calls[0], /^pr list -R Fandhe-AI\/target --state merged /)
    assert.ok(calls[1].includes('repos/Fandhe-AI/target/commits/'))
    assert.ok(!calls.some((c) => c.includes('{owner}')))
  })

  T('external-checks: slug の形式（小文字英数字とハイフン）でない値・app が null の check-run は apps に入れない（形式不正は dropped に数える）', () => {
    const stub = makeGhRepoScanStub({
      prs: [{ headRefOid: A }],
      checkRuns: { [A]: checkRuns(['cursor', null, 'Bad_Slug', 'a b', '-lead', 'x;rm -rf /', '$(id)', 'UPPER', 'ok-1']) },
    })
    const r = ext(stub)
    const e = envelopeOf(r)
    assert.deepEqual(e.payload.apps, ['cursor', 'ok-1'])
    assert.equal(e.payload.dropped, 6, 'null は jq が落とすので数えない。形式不正の 6 件')
    assert.ok(!r.stdout.includes('rm -rf') && !r.stdout.includes('$(id)') && !r.stderr.includes('rm -rf'), '外部由来の文字列が出力に漏れた')
  })

  T('external-checks: slug が 65 文字以上なら捨てる', () => {
    const stub = makeGhRepoScanStub({ prs: [{ headRefOid: A }], checkRuns: { [A]: checkRuns(['a'.repeat(64), 'a'.repeat(65)]) } })
    const e = envelopeOf(ext(stub))
    assert.deepEqual(e.payload.apps, ['a'.repeat(64)])
    assert.equal(e.payload.dropped, 1)
  })

  T('external-checks: 並びは LC_ALL=C の昇順で、環境のロケールに依存しない', () => {
    const stub = makeGhRepoScanStub({ prs: [{ headRefOid: A }], checkRuns: { [A]: checkRuns(['b-app', 'a1', 'a-app', 'a', '9x']) } })
    const want = ['9x', 'a', 'a-app', 'a1', 'b-app']
    for (const env of [{ LC_ALL: 'C' }, { LC_ALL: 'en_US.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' }]) {
      assert.deepEqual(envelopeOf(ext(stub, [], { env })).payload.apps, want, JSON.stringify(env))
    }
  })

  T('external-checks: merged PR が 0 件なら apps は空・prs は 0（エラーではない）', () => {
    const stub = makeGhRepoScanStub({ prs: [] })
    const e = envelopeOf(ext(stub))
    assert.deepEqual([e.payload.apps, e.payload.prs, e.payload.errs], [[], 0, 0])
  })

  T('external-checks: pr list の失敗は errs に数えて apps: []（旧コマンドと同じく止まらない）', () => {
    for (const prs of [{ exit: 1 }, { raw: '{"message":"boom"}', exit: 1 }]) {
      const stub = makeGhRepoScanStub({ prs })
      const r = ext(stub)
      const e = envelopeOf(r)
      assert.deepEqual([e.payload.apps, e.payload.prs, e.payload.errs], [[], 0, 1])
      assert.ok(!r.stdout.includes('boom'), 'gh のエラー本文が出力に混ざった')
    }
  })

  T('external-checks: 一部の PR の check-runs の取得失敗は errs に数え、取れた分だけを返す', () => {
    const stub = makeGhRepoScanStub({
      prs: [{ headRefOid: A }, { headRefOid: B }, { headRefOid: C }],
      checkRuns: { [A]: checkRuns(['cursor']), [B]: { exit: 1 }, [C]: checkRuns(['codecov']) },
    })
    const e = envelopeOf(ext(stub))
    assert.deepEqual([e.payload.apps, e.payload.prs, e.payload.errs], [['codecov', 'cursor'], 3, 1])
  })

  T('external-checks: sha でない行は errs に数えて check-runs を呼ばない・4 件目以降は見ない', () => {
    const stub = makeGhRepoScanStub({
      prs: [{ headRefOid: 'not-a-sha; echo x' }, { headRefOid: A }, { headRefOid: B }, { headRefOid: C }, { headRefOid: D }],
      checkRuns: { [A]: checkRuns(['one']), [B]: checkRuns(['two']), [C]: checkRuns(['three']), [D]: checkRuns(['four']) },
    })
    const e = envelopeOf(ext(stub))
    assert.deepEqual(e.payload.apps, ['one', 'two'], '先頭 3 行だけを見る（--limit 3 の防御）')
    assert.deepEqual([e.payload.prs, e.payload.errs], [2, 1])
    assert.equal(stub.callsTo('check-runs'), 2)
  })

  T('external-checks: 旧コマンド（凍結）と同じ入力で同じ apps になる', () => {
    const data = {
      prs: [{ headRefOid: A }, { headRefOid: B }, { headRefOid: C }],
      checkRuns: { [A]: checkRuns(['cursor', 'github-actions', 'codecov', 'vercel']), [B]: checkRuns(['cursor', 'github-actions']), [C]: checkRuns([]) },
    }
    const oldStub = makeGhRepoScanStub(data)
    const old = spawnSync(bash, ['-c', OLD_EXTERNAL], { env: oldStub.env(), encoding: 'utf8' })
    assert.equal(old.status, 0, old.stderr)
    const newE = envelopeOf(ext(makeGhRepoScanStub(data)))
    assert.deepEqual(old.stdout.split('\n').filter((l) => l !== ''), newE.payload.apps)
  })

  T('external-checks: 意図した差: check-runs の取得に失敗した PR の HTTP エラー本文（gh は標準出力へ出す）を、旧コマンドは apps に混ぜ、新スクリプトは混ぜない', () => {
    const data = { prs: [{ headRefOid: A }, { headRefOid: B }], checkRuns: { [A]: checkRuns(['cursor']), [B]: { exit: 1 } } }
    const oldStub = makeGhRepoScanStub(data)
    const old = spawnSync(bash, ['-c', OLD_EXTERNAL], { env: oldStub.env(), encoding: 'utf8' })
    assert.ok(old.stdout.includes('"message"'), '旧コマンドはエラー本文を出力に含める（終了コードで判定していない）')
    const e = envelopeOf(ext(makeGhRepoScanStub(data)))
    assert.deepEqual([e.payload.apps, e.payload.errs, e.payload.dropped], [['cursor'], 1, 0])
  })

  T('external-checks: 意図した差: app が null の check-run を、旧コマンドは文字列 null として出し、新スクリプトは落とす', () => {
    const data = { prs: [{ headRefOid: A }], checkRuns: { [A]: checkRuns(['cursor', null]) } }
    const oldStub = makeGhRepoScanStub(data)
    const old = spawnSync(bash, ['-c', OLD_EXTERNAL], { env: oldStub.env(), encoding: 'utf8' })
    assert.deepEqual(old.stdout.split('\n').filter((l) => l !== '').sort(), ['cursor', 'null'])
    assert.deepEqual(envelopeOf(ext(makeGhRepoScanStub(data))).payload.apps, ['cursor'])
  })

  // ---------------- skip-labels ----------------

  T('skip-labels: ラベルごとの open issue 番号を昇順・重複なし・PR を除いて返し、ページ送りを跨ぐ', () => {
    const stub = makeGhRepoScanStub({
      labels: [{ name: 'owner:human' }, { name: 'owner:joint' }],
      issues: {
        'owner:human': { pages: [issueList([5, 3, { number: 4, pr: true }]), issueList([9, 3])] },
        'owner:joint': issueList([]),
      },
    })
    const r = skip(stub, ['owner:human', 'owner:joint'])
    const e = envelopeOf(r)
    assert.deepEqual(e.payload, {
      absent: [],
      entries: [{ i: 1, numbers: [3, 5, 9] }, { i: 2, numbers: [] }],
      failed: [],
      inputSha256: repoScanInputSha256('skip-labels', '', ['owner:human', 'owner:joint']),
    })
    const signed = H.verifySignedOutput(e, NONCE, H.repoScanInputSha256('skip-labels', undefined, ['owner:human', 'owner:joint']))
    assert.equal(signed.ok, true, JSON.stringify(signed))
    const c = H.collectSkipLabelEntries([1, 2], signed.payload, 2)
    assert.deepEqual([[...c.byIndex], c.missing, c.absent], [[[1, [3, 5, 9]], [2, []]], [], []])
  })

  T('skip-labels: gh の呼び出しは GET だけ（-f / -X を使わず、ラベルはクエリ文字列へパーセントエンコードして渡す）', () => {
    const stub = makeGhRepoScanStub({ labels: [{ name: 'a' }], issues: { a: issueList([1]) } })
    assert.equal(skip(stub, ['a']).status, 0)
    const calls = stub.calls()
    assert.deepEqual(calls.map((c) => c.split(' --')[0]), ['api repos/{owner}/{repo}/labels?per_page=100', 'api repos/{owner}/{repo}/issues?state=open&labels=a&per_page=100'])
    assert.ok(calls.every((c) => c.includes('--paginate')))
    assert.ok(!calls.some((c) => /(^| )(-f|-F|-X|--field|--raw-field|--input|--method)( |$)/.test(c)))
  })

  T('skip-labels: 空白・コロン・& # % + \' ? / = ・日本語・絵文字を含むラベルも、エンコードされた 1 つの値として正しいラベルの結果になる', () => {
    const labels = ['good first issue', 'owner:human', 'a&b#c', '100%', 'c++', "it's", 'q?x=1/2', '人手', '🚧 wip', '~._-']
    const issues = Object.fromEntries(labels.map((l, k) => [l, issueList([100 + k])]))
    const stub = makeGhRepoScanStub({ labels: labels.map((name) => ({ name })), issues })
    const e = envelopeOf(skip(stub, labels))
    assert.deepEqual(e.payload.entries, labels.map((_, k) => ({ i: k + 1, numbers: [100 + k] })), '各ラベルが自分の応答（取り違えなし）')
    assert.deepEqual([e.payload.absent, e.payload.failed], [[], []])
    assert.equal(e.payload.inputSha256, repoScanInputSha256('skip-labels', '', labels))
  })

  T('skip-labels: --repo はラベル一覧・issue 一覧の全 gh 呼び出しと入力の束縛に入る', () => {
    const stub = makeGhRepoScanStub({ labels: [{ name: 'a' }], issues: { a: issueList([1]) } })
    const e = envelopeOf(skip(stub, ['a'], ['--repo', 'Fandhe-AI/target']))
    assert.equal(e.payload.inputSha256, repoScanInputSha256('skip-labels', 'Fandhe-AI/target', ['a']))
    const calls = stub.calls()
    assert.ok(calls.length === 2 && calls.every((c) => c.includes('repos/Fandhe-AI/target/')) && !calls.some((c) => c.includes('{owner}')))
  })

  T('skip-labels: 入力の束縛はラベルの並び（添字）を区別する', () => {
    assert.notEqual(repoScanInputSha256('skip-labels', '', ['a', 'b']), repoScanInputSha256('skip-labels', '', ['b', 'a']))
    assert.notEqual(repoScanInputSha256('skip-labels', '', ['a', 'b']), repoScanInputSha256('skip-labels', '', ['a']))
    assert.notEqual(repoScanInputSha256('skip-labels', '', ['a']), repoScanInputSha256('external-checks', '', []))
    const stub = makeGhRepoScanStub({ labels: [{ name: 'a' }, { name: 'b' }], issues: { a: issueList([1]), b: issueList([2]) } })
    const ab = envelopeOf(skip(stub, ['a', 'b'])).payload
    const ba = envelopeOf(skip(stub, ['b', 'a'])).payload
    assert.notEqual(ab.inputSha256, ba.inputSha256)
    assert.deepEqual(ba.entries, [{ i: 1, numbers: [2] }, { i: 2, numbers: [1] }])
  })

  T('skip-labels: ラベル一覧に無いラベルだけ absent（ASCII の大文字小文字は区別しない）。ラベル一覧を取得できなければ absent を判定しない', () => {
    const issues = { 'Owner:Human': issueList([1]), nope: issueList([]), 'ＡＢ': issueList([]) }
    const stub = makeGhRepoScanStub({ labels: [{ name: 'owner:human' }, { name: 'ab' }], issues })
    assert.deepEqual(envelopeOf(skip(stub, ['Owner:Human', 'nope', 'ＡＢ'])).payload.absent, [2, 3], '全角の ＡＢ は ab と同じにしない（ロケール依存の畳み込みをしない）')
    for (const labels of [{ exit: 1 }, { raw: '{"message":"boom"}', exit: 1 }]) {
      const s2 = makeGhRepoScanStub({ labels, issues })
      const e = envelopeOf(skip(s2, ['Owner:Human', 'nope']))
      assert.deepEqual([e.payload.absent, e.payload.failed], [[], []], 'ラベル一覧が取れないときは absent を出さない（待機側へは倒さない）')
      assert.equal(e.payload.entries.length, 2)
    }
  })

  T('skip-labels: ラベル一覧が空（ラベルが 1 件も無いリポジトリ）なら全ラベルが absent', () => {
    const stub = makeGhRepoScanStub({ labels: [], issues: { a: issueList([]), b: issueList([]) } })
    assert.deepEqual(envelopeOf(skip(stub, ['a', 'b'])).payload.absent, [1, 2])
  })

  T('skip-labels: 取得に失敗したラベルは entries に入れず failed に出し（標準エラーは固定語彙と添字だけ）、他のラベルは返る', () => {
    const stub = makeGhRepoScanStub({
      labels: [{ name: 'ok' }, { name: 'ng' }, { name: 'weird' }, { name: 'ok2' }],
      issues: { ok: issueList([2]), ng: { raw: '{"message":"boom secret-token"}', exit: 1 }, weird: { raw: 'abc\n7\n', exit: 0 }, ok2: issueList([]) },
    })
    const r = skip(stub, ['ok', 'ng', 'weird', 'ok2'])
    const e = envelopeOf(r)
    assert.deepEqual(e.payload.entries, [{ i: 1, numbers: [2] }, { i: 4, numbers: [] }])
    assert.deepEqual(e.payload.failed, [2, 3], '番号でない行（想定外の応答）は欠かさず失敗に倒す')
    assert.equal(r.stderr, 'FAILED 2\nFAILED 3\n')
    assert.ok(!r.stdout.includes('boom') && !r.stdout.includes('secret'))
  })

  T('skip-labels: 全ラベルが失敗しても封筒は出る（終了コード 0。判定はホスト）', () => {
    const stub = makeGhRepoScanStub({ labels: [{ name: 'a' }], issues: { a: { exit: 1 } } })
    const e = envelopeOf(skip(stub, ['a']))
    assert.deepEqual([e.payload.entries, e.payload.failed], [[], [1]])
  })

  T('skip-labels: 出力が大きすぎる（封筒が 24000 バイトを超える）なら封筒を出さず exit 7', () => {
    const many = Array.from({ length: 4000 }, (_, k) => 100000 + k)
    const stub = makeGhRepoScanStub({ labels: [{ name: 'big' }], issues: { big: issueList(many) } })
    const r = skip(stub, ['big'])
    assert.equal(r.status, 7)
    assert.equal(r.stdout, '')
    // 収まる大きさなら通る
    const ok = makeGhRepoScanStub({ labels: [{ name: 'big' }], issues: { big: issueList(many.slice(0, 1500)) } })
    assert.equal(envelopeOf(skip(ok, ['big'])).payload.entries[0].numbers.length, 1500)
  })

  T('skip-labels: ロケールに依存しない（番号の並び・absent は LC_ALL が違っても同じ）', () => {
    const issues = { a: issueList([10, 9, 100, 2]), 'Ａ': issueList([1]) }
    const stub = makeGhRepoScanStub({ labels: [{ name: 'a' }], issues })
    const base = skip(stub, ['a', 'Ａ'], [], { env: { LC_ALL: 'C' } }).stdout
    for (const env of [{ LC_ALL: 'en_US.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' }]) assert.equal(skip(stub, ['a', 'Ａ'], [], { env }).stdout, base, JSON.stringify(env))
    assert.deepEqual(JSON.parse(base).payload.entries[0].numbers, [2, 9, 10, 100], '数値順')
  })

  T('skip-labels: 旧コマンド（凍結）と同じ入力で、番号・存在確認・失敗が同じになる', () => {
    const labels = ['owner:human', "It's", 'broken', 'none', 'Mixed Case']
    const data = {
      labels: [{ name: 'Owner:Human' }, { name: "it's" }, { name: 'broken' }, { name: 'mixed case' }],
      issues: {
        'owner:human': { pages: [issueList([9, 3]), issueList([5, 3, { number: 6, pr: true }])] },
        "It's": issueList([4]),
        broken: { raw: '{"message":"boom"}', exit: 1 },
        none: issueList([]),
        'Mixed Case': issueList([8, 1]),
      },
    }
    const q = (l) => `'${l.replace(/'/g, `'\\''`)}'`
    const oldCmd = OLD_SKIP.replace("'__L1__' '__L2__'", labels.map(q).join(' '))
    const oldStub = makeGhRepoScanStub(data)
    const old = spawnSync(bash, ['-c', oldCmd], { env: oldStub.env(), encoding: 'utf8' })
    assert.equal(old.status, 0, old.stderr)
    const oldEntries = old.stdout.trim().split('\n').map((l) => JSON.parse(l))
    const newE = envelopeOf(skip(makeGhRepoScanStub(data), labels))
    assert.deepEqual(newE.payload.entries, oldEntries.map((x) => ({ i: x.i, numbers: x.numbers })))
    assert.deepEqual(newE.payload.absent, oldEntries.filter((x) => x.x === 1).map((x) => x.i))
    assert.match(old.stderr, /FAILED 3/)
    assert.deepEqual(newE.payload.failed, [3])
  })

  T('skip-labels: 起動行の誤り（ラベルなし・11 件・カンマ・空・制御文字・前後空白・長すぎる）は gh を呼ばず exit 2', () => {
    const stub = makeGhRepoScanStub({ labels: [], issues: {} })
    const bad = [
      [],
      Array.from({ length: 11 }, (_, k) => `l${k}`),
      ['a,b'],
      [''],
      ['a\nb'],
      ['a\tb'],
      ['a\u0001b'],
      [' x'],
      ['x '],
      ['a'.repeat(201)],
    ]
    for (const labels of bad) {
      const r = skip(stub, labels)
      assert.equal(r.status, 2, JSON.stringify(labels))
      assert.equal(r.stdout, '')
    }
    assert.equal(stub.calls().length, 0, 'gh を呼んだ')
  })

  // ---------------- 共通の引数検証・launcher ----------------

  T('引数の誤り（モードなし・不明なモード・nonce なし・不正な nonce・不正な repo・--repo の空・重複・未知の引数・external-checks のラベル）は gh を呼ばず exit 2', () => {
    const stub = makeGhRepoScanStub({})
    const cases = [
      [],
      ['--nonce', NONCE],
      ['--mode', 'bogus', '--nonce', NONCE],
      ['--mode', 'external-checks'],
      ['--mode', 'external-checks', '--nonce', 'BAD NONCE'],
      ['--mode', 'external-checks', '--nonce', 'UPPER'],
      ['--mode', 'external-checks', '--nonce', NONCE, '--repo', 'bad repo'],
      ['--mode', 'external-checks', '--nonce', NONCE, '--repo', ''],
      ['--mode', 'external-checks', '--nonce', NONCE, '--repo', 'a/b', '--repo', 'a/b'],
      ['--mode', 'external-checks', '--mode', 'skip-labels', '--nonce', NONCE, '--', 'x'],
      ['--mode', 'external-checks', '--nonce', NONCE, '--bogus'],
      ['--mode', 'external-checks', '--nonce', NONCE, '--', 'label'],
      ['--mode', 'skip-labels', '--nonce', NONCE, '--repo', '--', 'x'],
      ['--mode'],
    ]
    for (const args of cases) {
      const r = run(bash, stub, args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.equal(r.stdout, '', JSON.stringify(args))
    }
    assert.equal(stub.calls().length, 0, 'gh を呼んだ')
  })

  T('run-verified.sh 経由（SHA-256 照合つき）で起動でき、スクリプトのハッシュが違えば起動しない', () => {
    const stub = makeGhRepoScanStub({ prs: [{ headRefOid: A }], checkRuns: { [A]: checkRuns(['cursor']) } })
    const ok = run(bash, stub, ['--mode', 'external-checks', '--nonce', NONCE], { launcher: true })
    assert.deepEqual(envelopeOf(ok).payload.apps, ['cursor'])
    const bad = spawnSync(bash, [RUN_VERIFIED, '0'.repeat(64), 'repo-scan.sh', '--mode', 'external-checks', '--nonce', NONCE], { env: stub.env(), encoding: 'utf8' })
    assert.equal(bad.status, 3)
    assert.equal(bad.stdout, '')
  })
}

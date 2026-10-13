// observe-pr.sh の時間上限・取得失敗の区別・複数ページ・本文の扱いの回帰テスト（PR #612 の codex・独立レビュー指摘）。
//
//   - 個々の gh 呼び出しに時間制限があり、ハングした gh と、その孫プロセスを残さない。1 回の起動の壁時計上限を保証し、
//     次の観測を始める前に残り時間が 1 観測分に満たなければ始めずに pending を返す
//   - 取得失敗時の bound は「不明」（-1）で、unbound（0）と区別できる
//   - 複数ページの応答を合算する（gh api --slurp に依存しない = ページごとの出力を jq 側で合算する）
//   - threads-detail は本文を十分な長さで返し、切ったときは元の長さを示し、全文を取れる。非信頼データは nonce 付きの区切りで囲む
//   - reviews の件数は DISMISSED を含まない。--repo の '.' '..' 要素は拒否する
//
// 偽 gh は tests/lib/gh-observe-stub.mjs（GH_STUB_DELAY・GH_STUB_HANG で遅い・ハングする gh を模す）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes, toolExists } from './lib/signed-output.mjs'
import { createObserveStub } from './lib/gh-observe-stub.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'observe-pr.sh')
const NONCE = 'k3x9a0b1c2d4e5f6g7h8i9j0k1l2'
const SHA = 'a1'.repeat(20)
const BASHES = availableBashes()
const jqAvailable = toolExists('jq')
const FAST = { OBSERVE_PR_POLLS: '3', OBSERVE_PR_SLEEP_SEC: '0', OBSERVE_PR_SETTLE_SEC: '0' }
const prJson = (over = {}) =>
  JSON.stringify({ headRefOid: SHA, state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'fix/7-x', baseRefName: 'main', isCrossRepository: false, closingIssuesReferences: [{ number: 7 }], ...over })
const ERR_BODY = { out: '{"message":"Not Found","status":"404"}', exit: 1 }
const lines = (...pages) => `${pages.map((p) => JSON.stringify(p)).join('\n')}\n`

function run(bash, stub, args, env = {}) {
  return spawnSync(bash, [SCRIPT, '--nonce', NONCE, ...args], { encoding: 'utf8', env: stub.env({ ...FAST, ...env }) })
}
function payloadOf(r) {
  assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
  return JSON.parse(r.stdout).payload
}
// 指定の継続時間（秒）の sleep が残っているか（ps が無い環境では null = 判定できない）
function sleepersOf(seconds) {
  const r = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  return r.stdout.split('\n').filter((l) => new RegExp(`\\bsleep ${seconds}\\b`).test(l)).length
}

for (const bash of BASHES) {
  const t = (name, fn) => test(`[${bash}] ${name}`, { skip: !jqAvailable }, fn)

  // --- 時間上限 ---

  t('遅い gh（呼び出しごとの時間制限を超える）は取得失敗（err=1）として返し、制限を超えて待たない', () => {
    const stub = createObserveStub({ prview: { out: prJson() } })
    const t0 = Date.now()
    const p = payloadOf(run(bash, stub, ['--mode', 'checks', '--pr', '12'], { GH_STUB_DELAY: '3', OBSERVE_PR_GH_TIMEOUT_SEC: '1', OBSERVE_PR_WALL_SEC: '20' }))
    const elapsed = (Date.now() - t0) / 1000
    assert.deepEqual({ err: p.err, o: p.outcome, total: p.total }, { err: 1, o: 'error', total: 0 })
    assert.ok(elapsed < 2.9, `1 回目の gh が時間制限（1 秒）で打ち切られ、遅延（3 秒）を待たない: ${elapsed}s`)
  })

  t('ハングする gh は時間制限で kill され、gh の孫プロセスも残さない。壁時計上限（WALL）を超えない', () => {
    const hang = String(2000 + (process.pid % 900))
    const stub = createObserveStub({ prview: { out: prJson() } })
    const t0 = Date.now()
    const r = run(bash, stub, ['--mode', 'checks', '--pr', '12', '--wait', '--attempt', '1'], {
      GH_STUB_HANG: hang, OBSERVE_PR_GH_TIMEOUT_SEC: '1', OBSERVE_PR_WALL_SEC: '4', OBSERVE_PR_POLLS: '10',
    })
    const elapsed = (Date.now() - t0) / 1000
    const p = payloadOf(r)
    assert.deepEqual({ err: p.err, o: p.outcome }, { err: 1, o: 'error' })
    assert.ok(elapsed <= 4 + 3, `壁時計上限 4 秒 + 後始末の猶予に収まる: ${elapsed}s`)
    const left = sleepersOf(hang)
    if (left !== null) assert.equal(left, 0, 'gh の子・孫の sleep が残っていない')
  })

  t('次の観測を始める前に残り時間が 1 観測分に満たなければ、始めずに pending を返す（窓の判定）', () => {
    const stub = createObserveStub({
      prview: { out: prJson() },
      'check-runs-total': { out: '{"total_count":0,"check_runs":[]}' },
      status: { out: '{"statuses":[]}' },
    })
    // 1 観測 = gh 3 回 × 遅延 1 秒 ≒ 3 秒。壁時計 5 秒では 2 回目の観測を始められない
    const p = payloadOf(run(bash, stub, ['--mode', 'checks', '--pr', '12', '--wait', '--attempt', '1'], {
      GH_STUB_DELAY: '1', OBSERVE_PR_GH_TIMEOUT_SEC: '5', OBSERVE_PR_WALL_SEC: '5', OBSERVE_PR_POLLS: '10',
    }))
    assert.equal(p.outcome, 'pending')
    assert.equal(p.err, 0, '観測は成功しており、取得失敗ではない')
    assert.equal(stub.countOf('prview'), 1, '2 回目の観測を始めていない')
  })

  t('既定の壁時計上限は Bash ツールの既定タイムアウト 120 秒に余裕を持たせた値で、環境変数でも 120 秒以上にできない', () => {
    const sh = spawnSync('grep', ['-E', 'env_int "\\$\\{OBSERVE_PR_(WALL_SEC|GH_TIMEOUT_SEC):-\\}"', SCRIPT], { encoding: 'utf8' }).stdout
    const wall = Number(/OBSERVE_PR_WALL_SEC:-\}" (\d+) (\d+)/.exec(sh)?.[1])
    const wallMax = Number(/OBSERVE_PR_WALL_SEC:-\}" (\d+) (\d+)/.exec(sh)?.[2])
    assert.ok(wall >= 60 && wall <= 100, `既定 ${wall}`)
    assert.ok(wallMax <= 100, `最大 ${wallMax}`)
  })

  // --- bound と err ---

  t('取得失敗時の bound は -1（不明）で、unbound（0）と区別できる。想定外の PR は bound=0', () => {
    for (const out of [ERR_BODY, { out: 'not json' }, { out: prJson({ state: 'WEIRD' }) }]) {
      const stub = createObserveStub({ prview: out })
      const p = payloadOf(run(bash, stub, ['--mode', 'pr', '--pr', '12', '--base', 'main', '--branch', 'fix/7-x', '--issue', '7']))
      assert.deepEqual({ err: p.err, bound: p.bound, state: p.state }, { err: 1, bound: -1, state: '' })
    }
    const mismatch = createObserveStub({ prview: { out: prJson({ headRefName: 'other' }) } })
    assert.equal(payloadOf(run(bash, mismatch, ['--mode', 'pr', '--pr', '12', '--base', 'main', '--branch', 'fix/7-x', '--issue', '7'])).bound, 0)
  })

  // --- 複数ページ（--slurp に依存しない）---

  const reqRule = (...ctx) => [{ type: 'required_status_checks', parameters: { required_status_checks: ctx.map((context) => ({ context })) } }]

  t('required: rules・check-run・statuses が複数ページでも全ページを合算する。gh api --slurp を使わない', () => {
    const stub = createObserveStub({
      prview: { out: prJson() },
      rules: { out: lines(reqRule('a'), reqRule('b', 'c'), [{ type: 'pull_request' }]) },
      'check-runs': { out: lines({ total_count: 3, check_runs: [{ name: 'a' }] }, { total_count: 3, check_runs: [{ name: 'b' }, { name: 'x' }] }) },
      statuses: { out: lines([{ context: 's1' }], [{ context: 'c' }]) },
    })
    const p = payloadOf(run(bash, stub, ['--mode', 'required', '--pr', '12', '--base', 'main']))
    assert.deepEqual({ missing: p.missing, total: p.requiredTotal, err: p.err }, { missing: 0, total: 3, err: 0 })
    assert.ok(stub.calls().every((c) => !c.includes('--slurp')), stub.calls().join('\n'))
    const lacking = createObserveStub({
      prview: { out: prJson() },
      rules: { out: lines(reqRule('a'), reqRule('b', 'c')) },
      'check-runs': { out: lines({ check_runs: [{ name: 'a' }] }, { check_runs: [{ name: 'b' }] }) },
      statuses: { out: lines([], []) },
    })
    assert.equal(payloadOf(run(bash, lacking, ['--mode', 'required', '--pr', '12', '--base', 'main'])).missing, 1, '2 ページ目の c だけが不足')
  })

  const review = (login, commit, state) => ({ user: { login }, commit_id: commit, state })

  t('reviews: レビューと check-run が 2 ページ目にあっても数える（1 ページ目だけを見ない）', () => {
    const stub = createObserveStub({
      prview: { out: prJson() },
      reviews: { out: lines([review('someone', SHA, 'APPROVED')], [review('cursor[bot]', SHA, 'COMMENTED')]) },
      'check-runs': { out: lines({ check_runs: [{ app: { slug: 'other' }, status: 'completed', conclusion: 'failure' }] }, { check_runs: [{ app: { slug: 'cursor' }, status: 'completed', conclusion: 'success' }, { app: { slug: 'cursor' }, status: 'in_progress', conclusion: null }] }) },
    })
    const p = payloadOf(run(bash, stub, ['--mode', 'reviews', '--pr', '12', '--slug', 'cursor']))
    assert.deepEqual({ rv: p.reviews, co: p.commented, ct: p.checkRuns, cp: p.checkRunsPassed, cr: p.checkRunsRunning, cf: p.checkRunsFailed }, { rv: 1, co: 1, ct: 2, cp: 1, cr: 1, cf: 0 })
    assert.ok(stub.calls().every((c) => !c.includes('--slurp')))
  })

  t('reviews: DISMISSED は reviews（到着件数）に含めない（dismissed に別掲）。DISMISSED だけなら到着していない', () => {
    const stub = createObserveStub({
      prview: { out: prJson() },
      reviews: { out: lines([review('cursor[bot]', SHA, 'DISMISSED'), review('cursor[bot]', SHA, 'COMMENTED')]) },
      'check-runs': { out: lines({ check_runs: [] }) },
    })
    const p = payloadOf(run(bash, stub, ['--mode', 'reviews', '--pr', '12', '--slug', 'cursor']))
    assert.deepEqual({ rv: p.reviews, co: p.commented, di: p.dismissed }, { rv: 1, co: 1, di: 1 })
    const only = createObserveStub({ prview: { out: prJson() }, reviews: { out: lines([review('cursor[bot]', SHA, 'DISMISSED')]) }, 'check-runs': { out: lines({ check_runs: [] }) } })
    const q = payloadOf(run(bash, only, ['--mode', 'reviews', '--pr', '12', '--slug', 'cursor', '--wait', '--until', 'review', '--attempt', '1']))
    assert.deepEqual({ rv: q.reviews, di: q.dismissed, o: q.outcome }, { rv: 0, di: 1, o: 'pending' })
  })

  // --- threads-detail ---

  const th = (id, body, resolved = false) => ({ id, isResolved: resolved, path: 'a.js', comments: { nodes: [{ body, url: `https://github.com/o/r/pull/12#discussion_r${id}`, author: { login: 'cursor' } }] } })
  const gql = (nodes) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } })
  const dataLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))

  t('threads-detail: 3000 文字超の本文も全文を返し（旧プロンプトで読めていた範囲を後退させない）、長さを示す。非信頼データは nonce 付きの区切りで囲む', () => {
    const body = `${'あ'.repeat(3331)}`
    const stub = createObserveStub({ graphql: { out: gql([th('T1', body), th('T2', 'short', true)]) } })
    const r = run(bash, stub, ['--mode', 'threads-detail', '--pr', '12'])
    assert.equal(r.status, 0, r.stderr)
    const [d] = dataLines(r.stdout)
    assert.deepEqual({ id: d.threadId, len: d.bodyLength, trunc: d.truncated, same: d.body === body }, { id: 'T1', len: 3331, trunc: false, same: true })
    const out = r.stdout.split('\n')
    assert.ok(out[0].includes(`BEGIN UNTRUSTED`) && out[0].includes(NONCE), out[0])
    assert.ok(out.filter(Boolean).at(-1).includes('END UNTRUSTED') && out.filter(Boolean).at(-1).includes(NONCE))
    assert.ok(!('payload' in d))
  })

  t('threads-detail: 上限を超える本文は切り詰め、truncated と元の長さを明示する。--thread-id で全文を取れる', () => {
    const body = 'x'.repeat(30000)
    const stub = createObserveStub({ graphql: { out: gql([th('T1', body), th('T2', 'other')]) } })
    const [d] = dataLines(run(bash, stub, ['--mode', 'threads-detail', '--pr', '12']).stdout)
    assert.equal(d.truncated, true)
    assert.equal(d.bodyLength, 30000)
    assert.ok(d.body.length >= 6000 && d.body.length < 30000)
    const full = dataLines(run(bash, stub, ['--mode', 'threads-detail', '--pr', '12', '--thread-id', 'T1']).stdout)
    assert.equal(full.length, 1)
    assert.deepEqual({ id: full[0].threadId, trunc: full[0].truncated, len: full[0].body.length }, { id: 'T1', trunc: false, len: 30000 })
  })

  t('threads-detail: --thread-id が threads-detail 以外・不正な形式なら exit 2', () => {
    const stub = createObserveStub({ graphql: { out: gql([]) } })
    for (const args of [['--mode', 'threads', '--pr', '12', '--thread-id', 'T1'], ['--mode', 'threads-detail', '--pr', '12', '--thread-id', 'a b'], ['--mode', 'threads-detail', '--pr', '12', '--thread-id', '$(id)']]) {
      assert.equal(run(bash, stub, args).status, 2, args.join(' '))
    }
  })

  // --- --repo ---

  t('--repo の . と .. の要素は拒否する（exit 2・gh を呼ばない）。名前の途中の .. は許す', () => {
    const stub = createObserveStub({ prview: { out: prJson() }, 'check-runs-total': { out: '{"total_count":1}' }, status: { out: '{"statuses":[]}' } })
    for (const repo of ['a/..', '../x', './x', 'a/.', '../..']) {
      const r = run(bash, stub, ['--mode', 'checks', '--pr', '12', '--repo', repo])
      assert.equal(r.status, 2, repo)
    }
    assert.equal(stub.calls().length, 0)
    assert.equal(run(bash, stub, ['--mode', 'checks', '--pr', '12', '--repo', 'o/a..b']).status, 0)
  })
}

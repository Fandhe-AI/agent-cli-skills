// ランナーの agent-host（skills/implement-issue-tree/runner/lib/agent-host.mjs）の回帰テスト。
//
// 契約（_/local-plans/iit-runner-adapter-contract.md の「agent-host の契約」）:
//   1. 0 行目が実行仕様なら、モデルを介さず run-verified.sh を shell なしで起動する。label の許可表に合わなければ
//      実行せず失敗値。非 0 終了は stdout を見ずに失敗値。envelope / exit-ok / line:X の読み方。
//   2. それ以外は前置き + プロンプト + schema 指示でアダプタへ。不適合なら同じ会話で 1 回だけ修復し、
//      2 回目も不適合・AdapterError は null。throw は schema の不備（と呼び出しの不備）と worktree 作成失敗だけ。
//   3. isolation: 'worktree' は通し番号で worktree を作ってから cwd にする（通し番号は全呼び出しで数える）。
//   4. 並列上限・時間切れ・ログ（meta.json）。 5. allowMerge は merge-exec かつ args.autoMerge === true のときだけ。
// 実時間で待つのは時間切れの 2 件だけ（上限 1 秒の設定で確かめる）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackTmp } from './lib/tmp-track.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { createAgentHost, EXEC_RULES, checkExecRule, interpretExecResult, parseExecSpec } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { AdapterError, KINDS } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { loadConfig, resolveModel } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'
import { buildPreamble, buildSchemaInstruction, SHELL_NOTE } from '../../../skills/implement-issue-tree/runner/lib/preamble.mjs'

const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-host-'))))
const mainRoot = join(root, 'main')
mkdirSync(mainRoot)
const RUN_ID = 'wf_0123abcd-4ef'

// 偽の run-verified.sh: 引数を NUL 区切りで・標準入力・cwd を記録し、control の out.txt を出して code.txt で終わる。
// sleep.txt があれば先に眠る（時間切れの確認用。子の sleep まで止まることを確かめる）
const skillDir = join(root, 'skill')
mkdirSync(join(skillDir, 'scripts'), { recursive: true })
const CTL = join(root, 'ctl')
mkdirSync(CTL)
writeFileSync(join(skillDir, 'scripts', 'run-verified.sh'), [
  '#!/bin/bash',
  `c='${CTL}'`,
  'for a in "$@"; do printf \'%s\\0\' "$a"; done > "$c/rec.argv"',
  'cat > "$c/rec.stdin"',
  'pwd -P > "$c/rec.cwd"',
  '[ -f "$c/sleep.txt" ] && sleep "$(cat "$c/sleep.txt")"',
  'cat "$c/out.txt"',
  'exit "$(cat "$c/code.txt")"',
  '',
].join('\n'))
chmodSync(join(skillDir, 'scripts', 'run-verified.sh'), 0o755)

function control({ out = '', code = 0, sleep } = {}) {
  for (const f of ['rec.argv', 'rec.stdin', 'rec.cwd', 'sleep.txt']) rmSync(join(CTL, f), { force: true })
  writeFileSync(join(CTL, 'out.txt'), out)
  writeFileSync(join(CTL, 'code.txt'), String(code))
  if (sleep !== undefined) writeFileSync(join(CTL, 'sleep.txt'), String(sleep))
}
const recorded = () => existsSync(join(CTL, 'rec.argv'))
  ? { argv: readFileSync(join(CTL, 'rec.argv'), 'utf8').split('\0').slice(0, -1), stdin: readFileSync(join(CTL, 'rec.stdin'), 'utf8'), cwd: readFileSync(join(CTL, 'rec.cwd'), 'utf8').trim() }
  : null

const BASE_CONFIG = loadConfig()
function config(over = {}) {
  const c = structuredClone(BASE_CONFIG)
  c.timeoutsSec.byPhase.Quick = 1
  return Object.assign(c, over)
}

const SCHEMA = { type: 'object', required: ['ok', 'n'], additionalProperties: false, properties: { ok: { type: 'boolean' }, n: { type: 'integer' } } }
const STATE_WRITE = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
const ENVELOPE = { type: 'object', required: ['nonce', 'payload', 'sha256'], properties: { nonce: { type: 'string' }, payload: { type: 'object' }, sha256: { type: 'string' } } }
const CLEANUP = { type: 'object', required: ['ok', 'retained'], properties: { ok: { type: 'boolean' }, retained: { type: 'boolean' } } }
const SWEEP = { type: 'object', required: ['removed'], properties: { removed: { type: 'array', items: { type: 'string' } } } }
const SHA = 'a'.repeat(64)

function makeHost({ reply, cfg = {}, name = 'codex', delayMs = 0 } = {}) {
  const mod = makeFakeAdapterModule({ reply, name, delayMs })
  const adapter = mod.createAdapter({})
  const agent = createAgentHost({ adapter, cfg: { config: config(), skillDir, mainRoot, runId: RUN_ID, ...cfg } })
  return { agent, calls: mod.calls }
}

// src の execSpecLine と同じ形の 0 行目（JSON は 1 行・< > & U+2028 U+2029 を \u エスケープ）
function specLine(spec) {
  const json = JSON.stringify(spec).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `<!-- iit-exec v1 ${json} -->`
}
const withSpec = (spec, body = '本文: このコマンドを実行する') => `${specLine(spec)}\n${body}`
const hex = (s) => Buffer.from(s, 'utf8').toString('hex')

// ---- モデルへ回す段 ----

test('前置きのシェルの注意: zsh の可能性・bash の here-doc で実行・特殊変数名に代入しない を含み、前置きに入る', () => {
  assert.match(SHELL_NOTE, /zsh/)
  assert.ok(SHELL_NOTE.includes("bash <<'EOF'"))
  assert.match(SHELL_NOTE, /`status`/)
  assert.match(SHELL_NOTE, /特殊変数名に代入しない/)
  assert.ok(buildPreamble().split('\n').includes(SHELL_NOTE))
})

test('前置き・元のプロンプト・schema 指示の順に組み、契約どおりの req をアダプタへ渡す', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  const got = await agent('元のプロンプト', { label: 'plan:#2', phase: 'Plan', model: 'sonnet', effort: 'medium', schema: SCHEMA })
  assert.deepEqual(got, { ok: true, n: 1 })
  assert.equal(calls.length, 1)
  const req = calls[0]
  assert.equal(req.prompt, [buildPreamble(), '元のプロンプト', buildSchemaInstruction(SCHEMA)].join('\n\n'))
  const m = resolveModel(BASE_CONFIG, 'codex', { model: 'sonnet', effort: 'medium' })
  assert.equal(req.model, m.model)
  assert.equal(req.effort, 'medium')
  assert.equal(req.cwd, mainRoot)
  assert.equal(req.label, 'plan:#2')
  assert.equal(req.allowMerge, false)
  assert.equal(req.timeoutMs, BASE_CONFIG.timeoutsSec.byPhase.Plan * 1000)
  assert.equal(req.resume, null)
  assert.deepEqual(req.schema, SCHEMA)
})

test('model 省略は config.sessionModel の段。OpenCode は effort の欄に variant を入れる', async () => {
  const c = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  await c.agent('p', { label: 'recover:#2', schema: SCHEMA })
  assert.equal(c.calls[0].model, BASE_CONFIG.models.codex[BASE_CONFIG.sessionModel].model)
  const o = makeHost({ reply: () => ({ ok: true, n: 1 }), name: 'opencode' })
  await o.agent('p', { label: 'plan:#2', model: 'haiku', effort: 'high', schema: SCHEMA })
  assert.equal(o.calls[0].effort, BASE_CONFIG.models.opencode.haiku.variant)
})

// 不正出力の注入。1 回目に不正 → 修復で適合なら修復後の値、2 回とも不正なら null。どの場合も不適合な値はホストへ渡らない
const BAD_OUTPUTS = {
  'JSON でない文字列': 'できました',
  'JSON が複数': '{"ok":true,"n":1}\n補足: {"ok":false,"n":2}',
  '余分なキー': '{"ok":true,"n":1,"extra":"x"}',
  '型違い': '{"ok":"true","n":1}',
  '必須欠落': '{"ok":true}',
  '整数でない数': '{"ok":true,"n":1.5}',
  '配列（オブジェクトを含まない）': '[1,2]',
  'null': 'null',
  '禁止キー': '{"ok":true,"n":1,"__proto__":{"x":1}}',
}
for (const [name, bad] of Object.entries(BAD_OUTPUTS)) {
  test(`不正出力（${name}）: 修復ターンで直れば修復後の値、直らなければ null`, async () => {
    const fixed = makeHost({ reply: (req, { turn }) => (turn === 0 ? bad : '前置きの文章\n```json\n{"ok":false,"n":7}\n```') })
    assert.deepEqual(await fixed.agent('p', { label: 'review:#2', schema: SCHEMA }), { ok: false, n: 7 })
    assert.equal(fixed.calls.length, 2)
    const [first, second] = fixed.calls
    assert.equal(second.resume.sessionRef, 'fake-session-1')
    assert.match(second.resume.message, /適合しなかった/)
    assert.equal(second.prompt, first.prompt, '修復ターンでも同じ req（resume だけが増える）')

    const broken = makeHost({ reply: () => bad })
    assert.equal(await broken.agent('p', { label: 'review:#2', schema: SCHEMA }), null)
    assert.equal(broken.calls.length, 2, '修復は 1 回だけ')
  })
}

test('repairAttempts: 0 なら修復しない', async () => {
  const c = config()
  c.limits.repairAttempts = 0
  const { agent, calls } = makeHost({ reply: () => 'x', cfg: { config: c } })
  assert.equal(await agent('p', { label: 'x', schema: SCHEMA }), null)
  assert.equal(calls.length, 1)
})

for (const kind of KINDS) {
  test(`AdapterError(${kind}) は null（1 回目でも修復ターンでも）`, async () => {
    const a = makeHost({ reply: () => new AdapterError(kind, 'boom', { sessionRef: 's1' }) })
    assert.equal(await a.agent('p', { label: 'impl:#2', schema: SCHEMA }), null)
    assert.equal(a.calls.length, 1)
    const b = makeHost({ reply: (req, { turn }) => (turn === 0 ? 'x' : new AdapterError(kind, 'boom')) })
    assert.equal(await b.agent('p', { label: 'impl:#2', schema: SCHEMA }), null)
    assert.equal(b.calls.length, 2)
  })
}

test('アダプタの想定外の例外（AdapterError 以外）も null', async () => {
  const { agent } = makeHost({ reply: () => new TypeError('bug') })
  assert.equal(await agent('p', { label: 'x', schema: SCHEMA }), null)
})

test('throw: schema の不備・呼び出しの不備（label・model・effort・isolation）はアダプタを呼ぶ前に例外', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  await assert.rejects(agent('p', { label: 'x', schema: { type: 'object', oneOf: [] } }), /未対応の JSON Schema キーワード/)
  await assert.rejects(agent('p', { label: 'x' }), /schema/)
  await assert.rejects(agent('p', { label: '', schema: SCHEMA }), /label/)
  await assert.rejects(agent('p', { label: 'x', schema: SCHEMA, model: 'gpt' }), /未知のモデル名/)
  await assert.rejects(agent('p', { label: 'x', schema: SCHEMA, effort: 'max' }), /未知の effort/)
  await assert.rejects(agent('p', { label: 'x', schema: SCHEMA, isolation: 'remote' }), /isolation/)
  assert.equal(calls.length, 0)
})

test('isolation: worktree は通し番号で作った worktree を cwd にし、前置きでパスを知らせる。作成失敗は例外', async () => {
  const made = []
  const { agent, calls } = makeHost({
    reply: () => ({ ok: true, n: 1 }),
    cfg: { createWorktree: (p) => { made.push(p); return { path: `${p.mainRoot}/.claude/worktrees/${p.runId}-${p.n}` } } },
  })
  await agent('a', { label: 'state:x', schema: SCHEMA })
  await agent(withSpec({ v: 1, script: 'nope.sh', argv: [], ret: 'envelope' }), { label: 'y', schema: SCHEMA })
  await agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' })
  assert.deepEqual(made, [{ mainRoot, runId: RUN_ID, n: 3 }], '通し番号は隔離しない呼び出し・仕様の段も数える')
  const req = calls.at(-1)
  assert.equal(req.cwd, `${mainRoot}/.claude/worktrees/${RUN_ID}-3`)
  assert.ok(req.prompt.includes(`隔離 worktree は ${mainRoot}/.claude/worktrees/${RUN_ID}-3 である`))
  assert.equal(agent.stats.calls, 3)

  const failing = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { createWorktree: () => { throw new Error('git worktree add が失敗した') } } })
  await assert.rejects(failing.agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' }), /git worktree add/)
  assert.equal(failing.calls.length, 0)
})

test('worktreeGitdir（HIGH-2）: 作成関数が返した gitdir を検証した realpath だけを渡し、修復ターンでも同じ値。隔離しない段・gitdir を返さない作成関数は null。メインの .git/worktrees/ 直下でなければ例外', async () => {
  const wtRoot = join(mainRoot, '.git', 'worktrees')
  const gd = join(wtRoot, `${RUN_ID}-x`)
  mkdirSync(gd, { recursive: true })
  let turn = 0
  const { agent, calls } = makeHost({
    reply: () => (turn++ === 0 ? 'not json' : { ok: true, n: 1 }),
    cfg: { createWorktree: (p) => ({ path: `${p.mainRoot}/.claude/worktrees/${p.runId}-${p.n}`, gitdir: gd }) },
  })
  await agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' })
  assert.equal(calls.length, 2)
  for (const r of calls) assert.equal(r.worktreeGitdir, realpathSync(gd), r.resume ? '修復ターンも同じ値' : '初回')
  await agent('a', { label: 'plan:#2', schema: SCHEMA })
  assert.equal(calls.at(-1).worktreeGitdir, null, '隔離しない段は null')

  const noGd = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { createWorktree: (p) => ({ path: `${p.mainRoot}/.claude/worktrees/w` }) } })
  await noGd.agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' })
  assert.equal(noGd.calls[0].worktreeGitdir, null, 'path から推測しない')

  const outside = join(root, 'evil-gitdir')
  mkdirSync(outside, { recursive: true })
  for (const bad of [outside, wtRoot, join(mainRoot, '.git'), join(gd, 'x'), 'rel/x']) {
    if (bad.endsWith('/x') && bad.startsWith('/')) mkdirSync(bad, { recursive: true })
    const h = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { createWorktree: (p) => ({ path: `${p.mainRoot}/.claude/worktrees/w`, gitdir: bad }) } })
    await assert.rejects(h.agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' }), /git ディレクトリ/, bad)
    assert.equal(h.calls.length, 0, `アダプタを呼ばない: ${bad}`)
  }
})

test('並列上限: 同時に走るアダプタ呼び出しは maxParallel を超えない', async () => {
  let running = 0
  let peak = 0
  const { agent } = makeHost({
    cfg: { maxParallel: 2 },
    reply: async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { ok: true, n: 1 }
    },
  })
  const got = await Promise.all(Array.from({ length: 6 }, (_, i) => agent('p', { label: `impl:#${i}`, schema: SCHEMA })))
  assert.equal(got.length, 6)
  assert.equal(peak, 2)
  assert.equal(agent.stats.maxActive, 2)
  assert.equal(agent.stats.active, 0)
})

test('時間切れの保険: アダプタが timeoutMs + 猶予を過ぎても戻らなければ null', async () => {
  const { agent, calls } = makeHost({ reply: () => new Promise(() => {}), cfg: { timeoutGraceMs: 10 } })
  const t0 = Date.now()
  assert.equal(await agent('p', { label: 'x', phase: 'Quick', schema: SCHEMA }), null)
  assert.equal(calls[0].timeoutMs, 1000)
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(agent.stats.active, 0, '枠を返す')
})

test('allowMerge: label が merge-exec で始まり、args.autoMerge が true（真偽値）のときだけ', async () => {
  const cases = [
    ['merge-exec:#5', true, true],
    ['merge-exec:#5:retry', true, true],
    ['merge-exec:#5', false, false],
    ['merge-exec:#5', 'true', false],
    ['merge-exec:#5', undefined, false],
    ['merge-verify:#5', true, false],
    ['merge:#5', true, false],
    ['impl:#5', true, false],
    ['merge-execx', true, false],
  ]
  for (const [label, autoMerge, want] of cases) {
    const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge } } })
    await agent('p', { label, schema: SCHEMA })
    assert.equal(calls[0].allowMerge, want, `${label} / ${String(autoMerge)}`)
  }
})

test('エージェント数の上限（config.limits.maxAgents）を超えた呼び出しは起動せず null', async () => {
  const c = config()
  c.limits.maxAgents = 2
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { config: c } })
  for (let i = 0; i < 2; i++) assert.deepEqual(await agent('p', { label: 'x', schema: SCHEMA }), { ok: true, n: 1 })
  assert.equal(await agent('p', { label: 'x', schema: SCHEMA }), null)
  assert.equal(calls.length, 2)
})

test('ログ: agents/<seq>-<label>/meta.json に label・seq・sessionRef・outcome・kind・時刻を書く', async () => {
  const runDir = join(root, 'run-log')
  const replies = [{ ok: true, n: 1 }, new AdapterError('usage-limit', 'limit', { sessionRef: 'sx' })]
  const { agent } = makeHost({ reply: () => replies.shift() ?? 'x', cfg: { runDir } })
  await agent('p', { label: 'plan:#2', schema: SCHEMA })
  await agent('p', { label: 'impl:#2', schema: SCHEMA })
  control({ out: 'STATE_RESULT {"ok":true}\n' })
  await agent(withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }), { label: 'state:update:#2', schema: STATE_WRITE })
  await assert.rejects(agent('p', { label: 'bad', schema: { oneOf: [] } }))
  const dirs = readdirSync(join(runDir, 'agents')).sort()
  assert.deepEqual(dirs, ['0001-plan_2', '0002-impl_2', '0003-state_update_2', '0004-bad'])
  const meta = dirs.map((d) => JSON.parse(readFileSync(join(runDir, 'agents', d, 'meta.json'), 'utf8')))
  assert.deepEqual(meta.map((m) => [m.label, m.seq, m.outcome]), [['plan:#2', 1, 'ok'], ['impl:#2', 2, 'null'], ['state:update:#2', 3, 'exec-spec'], ['bad', 4, 'throw']])
  assert.equal(meta[0].sessionRef, 'fake-session-1')
  assert.equal(meta[1].kind, 'usage-limit')
  assert.equal(meta[1].sessionRef, 'sx')
  assert.equal(meta[2].sessionRef, null)
  for (const m of meta) assert.ok(Date.parse(m.startedAt) <= Date.parse(m.endedAt))
})

// ---- 実行仕様の直接実行 ----

test('実行仕様 envelope（state:load-verify）: run-verified.sh <sha256> <script> ...argv を mainRoot で起動し、最終行の JSON をそのまま返す', async () => {
  const env = { nonce: 'n1', payload: { keysCount: 0 }, sha256: 'b'.repeat(64) }
  control({ out: `前置きの行\n${JSON.stringify(env)}\n` })
  const { agent, calls } = makeHost()
  const argv = ['--nonce', 'n1', '--file', '_/issue-trees/1.json', 'verify', '--page', '0']
  const got = await agent(withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv, ret: 'envelope', fail: null }), { label: 'state:load-verify', phase: 'State', model: 'haiku', schema: ENVELOPE })
  assert.deepEqual(got, env)
  assert.equal(calls.length, 0, 'モデルを介さない')
  const rec = recorded()
  assert.deepEqual(rec.argv, [SHA, 'state.sh', ...argv])
  assert.equal(rec.stdin, '')
  assert.equal(rec.cwd, mainRoot)
})

test('実行仕様 line:STATE_RESULT（state:update・標準入力つき・接尾辞つき label）', async () => {
  const body = '[{"numbers":[2],"patch":{"note":"x\'y $(id) <!-- iit-exec"}}]\n'
  control({ out: 'STATE_RESULT {"ok":true}\n' })
  const { agent } = makeHost()
  for (const label of ['state:update:#2', 'state:update:#2:fallback-sonnet', 'state:update-batch:1', 'state:init-all', 'state:high-water']) {
    const got = await agent(withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', '_/issue-trees/1.json', 'merge'], ret: 'line:STATE_RESULT', stdinHex: hex(body), fail: { ok: false } }), { label, schema: STATE_WRITE })
    assert.deepEqual(got, { ok: true }, label)
    assert.equal(recorded().stdin, body)
  }
})

test('実行仕様 exit-ok（free:#N・plan:issue-tree-release）: 終了コード 0 で { ok: true }、非 0 で { ok: false }', async () => {
  const { agent } = makeHost()
  const free = withSpec({ v: 1, script: 'recover-prep.sh', sha256: SHA, argv: ['--mode', 'free', '--base', 'main', '--branch', 'feat/2-x'], ret: 'exit-ok', fail: { ok: false } })
  control({ code: 0 })
  assert.deepEqual(await agent(free, { label: 'free:#2', schema: STATE_WRITE }), { ok: true })
  control({ code: 1, out: 'STATE_RESULT {"ok":true}\n' })
  assert.deepEqual(await agent(free, { label: 'free:#2', schema: STATE_WRITE }), { ok: false })
  control({ code: 0 })
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'fetch-tree.sh', sha256: SHA, argv: ['--release', '--dir', '/tmp/x'], ret: 'exit-ok' }), { label: 'plan:issue-tree-release', schema: STATE_WRITE }), { ok: true })
})

test('実行仕様: 非 0 終了なら結果らしい行があっても stdout を見ずに失敗値（fail が無い仕様は ret ごとの既定）', async () => {
  const { agent } = makeHost()
  control({ code: 3, out: 'STATE_RESULT {"ok":true}\n' })
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }), { label: 'state:update:#2', schema: STATE_WRITE }), { ok: false })
  control({ code: 4, out: '{"nonce":"n","payload":{},"sha256":"s"}\n' })
  assert.equal(await agent(withSpec({ v: 1, script: 'repo-scan.sh', sha256: SHA, argv: ['--mode', 'external-checks', '--nonce', 'n', '--repo', 'o/r'], ret: 'envelope' }), { label: 'detect:external-checks', schema: ENVELOPE }), null)
  control({ code: 1, out: 'WORKTREE_REMOVE_RESULT {"ok":true,"retained":false}\n' })
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'worktree-remove.sh', sha256: SHA, argv: ['check-absent', '--path', '/w'], ret: 'line:WORKTREE_REMOVE_RESULT' }), { label: 'worktree:absent:#2', schema: CLEANUP }), { ok: false, retained: true, worktree: '' })
  control({ code: 1, out: 'WORKTREE_REMOVE_RESULT {"ok":true,"removed":["/w"]}\n' })
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'worktree-remove.sh', sha256: SHA, argv: ['sweep', '--file', 'f'], ret: 'line:WORKTREE_REMOVE_RESULT', stdinHex: hex('/w\n') }), { label: 'worktree:sweep', schema: SWEEP }), { removed: [] })
})

test('実行仕様: 結果の行・封筒が無い・schema に合わない出力は失敗値', async () => {
  const { agent } = makeHost()
  const st = withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' })
  for (const out of ['', 'ok\n', 'STATE_RESULT {"ok":true}\n後ろの行\n', 'STATE_RESULT{"ok":true}\n', 'STATE_RESULT {"ok":"yes"}\n', 'STATE_RESULT [1]\n']) {
    control({ out })
    assert.deepEqual(await agent(st, { label: 'state:update:#2', schema: STATE_WRITE }), { ok: false }, JSON.stringify(out))
  }
  const env = withSpec({ v: 1, script: 'measure-free-disk.sh', sha256: SHA, argv: ['--nonce', 'n', '--', '/m'], ret: 'envelope' })
  for (const out of ['', 'not json\n', '{"nonce":"n"}\n', '{"nonce":"n","payload":{},"sha256":"s"}\nnoise\n']) {
    control({ out })
    assert.equal(await agent(env, { label: 'worktree:free-disk-bytes', schema: ENVELOPE }), null, JSON.stringify(out))
  }
  // WORKTREE_REMOVE_RESULT の実際の行（余分なキーつき）は schema（additionalProperties の既定は許可）を通ってそのまま返る
  const line = '{"ok":true,"mode":"discard","worktree":"removed","branch":"","branchSha":"","dirty":false,"unlocked":false,"retained":false}'
  control({ out: `WORKTREE_REMOVE_RESULT ${line}\n` })
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'worktree-remove.sh', sha256: SHA, argv: ['remove', '--mode', 'discard', '--path', '/w'], ret: 'line:WORKTREE_REMOVE_RESULT' }), { label: 'state:cleanup:#2', schema: CLEANUP }), JSON.parse(line))
})

test('実行仕様 run-verified.sh --verify-only（script-hash-precheck）: sha256 なしで launcher に argv をそのまま渡す', async () => {
  const env = { nonce: 'n9', payload: { count: 1 }, sha256: 'c'.repeat(64) }
  control({ out: `${JSON.stringify(env)}\n` })
  const { agent } = makeHost()
  const table = `${SHA} state.sh\n`
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'run-verified.sh', argv: ['--verify-only', '--nonce', 'n9'], ret: 'envelope', stdinHex: hex(table), fail: null }), { label: 'script-hash-precheck', schema: ENVELOPE }), env)
  assert.deepEqual(recorded().argv, ['--verify-only', '--nonce', 'n9'])
  assert.equal(recorded().stdin, table)
})

test('実行仕様 observe-pr.sh（merge:<mode>:#N・optin-record-<k>:#N）', async () => {
  const env = { nonce: 'n', payload: {}, sha256: 's' }
  const { agent } = makeHost()
  for (const [label, mode] of [['merge:added-files:#2', 'added-files'], ['merge:policy-paths:#2', 'policy-paths'], ['optin-record-verify:#2', 'optin-record'], ['optin-record-reverify:#2', 'optin-record']]) {
    control({ out: `${JSON.stringify(env)}\n` })
    assert.deepEqual(await agent(withSpec({ v: 1, script: 'observe-pr.sh', sha256: SHA, argv: ['--mode', mode, '--nonce', 'n', '--pr', '7'], ret: 'envelope', fail: null }), { label, schema: ENVELOPE }), env, label)
  }
})

test('実行仕様: label と script・mode・ret・fail が許可表と合わなければ実行せず失敗値', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true }) })
  const cases = [
    ['script 違い', 'state:update:#2', { script: 'worktree-remove.sh', sha256: SHA, argv: ['remove', '--mode', 'discard'], ret: 'line:STATE_RESULT' }, STATE_WRITE, { ok: false }],
    ['mode 違い（verify を書き込みの label で）', 'state:update:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'verify'], ret: 'line:STATE_RESULT' }, STATE_WRITE, { ok: false }],
    ['mode 違い（書き込みを verify の label で）', 'state:load-verify', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'envelope' }, ENVELOPE, null],
    ['ret 違い', 'state:update:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'exit-ok' }, STATE_WRITE, { ok: false }],
    ['fail 違い', 'state:update:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT', fail: { ok: true } }, STATE_WRITE, { ok: false }],
    ['--mode が 2 つ', 'detect:external-checks', { script: 'repo-scan.sh', sha256: SHA, argv: ['--mode', 'external-checks', '--mode', 'skip-labels'], ret: 'envelope' }, ENVELOPE, null],
    ['表に無い label（判断の段）', 'merge-exec:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT', fail: { ok: false } }, STATE_WRITE, { ok: false }],
    ['表に無い label・fail なし（sweep の形）', 'plan:#2', { script: 'worktree-remove.sh', sha256: SHA, argv: ['sweep'], ret: 'line:WORKTREE_REMOVE_RESULT' }, SWEEP, { removed: [] }],
    ['接頭辞だけ一致する label', 'state:update:#2x', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }, STATE_WRITE, { ok: false }],
  ]
  for (const [name, label, spec, schema, want] of cases) {
    control({ out: 'STATE_RESULT {"ok":true}\n' })
    assert.deepEqual(await agent(withSpec({ v: 1, ...spec }), { label, schema }), want, name)
    assert.equal(recorded(), null, `${name}: 実行していない`)
  }
  assert.equal(calls.length, 0, 'モデルへも回さない')
})

test('実行仕様の形が厳密でない 0 行目は実行せず null（モデルへも回さない）', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true }) })
  const ok = { v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }
  const bad = [
    specLine({ ...ok, extra: 1 }),
    specLine({ ...ok, v: 2 }),
    specLine({ ...ok, script: '../state.sh' }),
    specLine({ ...ok, script: 'State.sh' }),
    specLine({ ...ok, script: 'evil.sh' }),
    specLine({ ...ok, sha256: 'A'.repeat(64) }),
    specLine({ ...ok, sha256: undefined }),
    specLine({ v: 1, script: 'run-verified.sh', sha256: SHA, argv: ['--verify-only'], ret: 'envelope' }),
    specLine({ ...ok, argv: [1] }),
    specLine({ ...ok, argv: ['a\0b'] }),
    specLine({ ...ok, argv: 'x' }),
    specLine({ ...ok, ret: 'line:OTHER' }),
    specLine({ ...ok, stdinHex: 'abc' }),
    specLine({ ...ok, stdinHex: 'ZZ' }),
    specLine(ok).replace('iit-exec', 'IIT-EXEC'),
    specLine(ok).replace('<!-- ', '<!--'),
    ` ${specLine(ok)}`,
    `${specLine(ok).slice(0, -4)}`,
    '<!-- iit-exec v1 {not json} -->',
    '<!-- iit-exec v1 [] -->',
  ]
  control({ out: 'STATE_RESULT {"ok":true}\n' })
  for (const line of bad) {
    assert.equal(await agent(`${line}\n本文`, { label: 'state:update:#2', schema: STATE_WRITE }), null, line.slice(0, 120))
    assert.equal(recorded(), null)
  }
  assert.equal(calls.length, 0)
  // 0 行目でなければ仕様ではない（モデルへ回す）
  assert.deepEqual(await agent(`タイトル\n${specLine(ok)}`, { label: 'state:update:#2', schema: STATE_WRITE }), { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(recorded(), null)
})

test('実行仕様の時間切れ: プロセスグループごと止めて失敗値', async () => {
  control({ out: 'STATE_RESULT {"ok":true}\n', sleep: 30 })
  const { agent } = makeHost()
  const t0 = Date.now()
  assert.deepEqual(await agent(withSpec({ v: 1, script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }), { label: 'state:update:#2', phase: 'Quick', schema: STATE_WRITE }), { ok: false })
  assert.ok(Date.now() - t0 < 10_000)
  rmSync(join(CTL, 'sleep.txt'), { force: true })
})

test('許可表は P6 文書の対象の段をすべて持ち、判断の段（plan:# impl: review: merge:# merge-exec 等）を持たない', () => {
  const want = ['state:update:#2', 'state:high-water', 'state:high-water-set', 'state:init-all', 'state:update-batch:3', 'state:load-verify', 'state:load-verify:p1', 'script-hash-precheck',
    'plan:issue-tree-release', 'free:#2', 'worktree:absent:#2', 'worktree:sweep', 'worktree:residual-bytes', 'worktree:free-disk-bytes', 'detect:external-checks',
    'plan:skip-labels', 'plan:skip-labels-retry', 'merge:added-files:#2', 'merge:policy-paths:#2', 'optin-record-verify:#2', 'optin-record-reverify:#2', 'state:cleanup:#2']
  for (const l of want) assert.ok(EXEC_RULES.some((r) => r.re.test(l)), l)
  const deny = ['plan:#2', 'impl:#2', 'review:#2', 'security-review:#2', 'fix:#2', 'pr-create:#2', 'pr-bind:#2', 'merge:#2', 'merge-exec:#2', 'merge-verify:#2', 'merge:optin-record:#2', 'close:#2', 'recover:#2', 'base-merge:#2',
    'plan:issue-tree', 'plan:issue-tree-page-1', 'plan:declared-deps-1', 'state:load', 'state:load-fill', 'nonce:seed', 'worktree:orphan-scan', 'worktree:head-scan', 'prereq:probe']
  for (const l of deny) assert.ok(!EXEC_RULES.some((r) => r.re.test(l)), l)
})

test('部品: parseExecSpec・checkExecRule・interpretExecResult', () => {
  assert.deepEqual(parseExecSpec('ふつうのプロンプト'), { kind: 'none' })
  assert.deepEqual(parseExecSpec(undefined), { kind: 'none' })
  assert.equal(parseExecSpec(specLine({ v: 1, script: 'state.sh', sha256: SHA, argv: [], ret: 'envelope' })).kind, 'spec')
  assert.equal(checkExecRule('state:load-verify', { script: 'state.sh', sha256: SHA, argv: ['--nonce', 'n', '--file', 'f', 'verify'], ret: 'envelope' }).ok, true)
  assert.equal(interpretExecResult('exit-ok', { code: 0, stdout: '' }).ok, true)
  assert.equal(interpretExecResult('exit-ok', { code: 0, stdout: '', timedOut: true }), undefined)
  assert.deepEqual(interpretExecResult('line:STATE_RESULT', { code: 0, stdout: 'a\nSTATE_RESULT {"ok":false,"reason":"r"}\n\n' }), { ok: false, reason: 'r' })
})

test('writablePaths（MEDIUM-4）: state:load とそのフォールバックだけに <main>/_/issue-trees を渡す（load-fill・load-verify・他の段は空）', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  const want = { 'state:load': true, 'state:load:fallback-sonnet': true, 'state:load-fill': false, 'state:load-fill:fallback-sonnet': false, 'state:load-verify': false, 'state:loader': false, 'plan:issue-tree': false, 'merge-exec:#2': false, 'state:load:retry': false }
  for (const label of Object.keys(want)) await agent('p', { label, schema: SCHEMA })
  for (const r of calls) assert.deepEqual(r.writablePaths, want[r.label] ? [join(mainRoot, '_', 'issue-trees')] : [], r.label)
})

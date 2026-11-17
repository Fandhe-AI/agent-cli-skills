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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { trackTmp } from './lib/tmp-track.mjs'
import { gitEnv, makeRepo } from './lib/worktree-sandbox.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { createAgentHost, EXEC_RULES, checkExecRule, interpretExecResult, killScriptsSync, parseExecSpec, spawnScript } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { AdapterError, KINDS } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { loadConfig, resolveModel } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'
import { buildPreamble, buildSchemaInstruction, SHELL_NOTE } from '../../../skills/implement-issue-tree/runner/lib/preamble.mjs'
import { recoverGitFor } from '../../../skills/implement-issue-tree/runner/lib/recover-git.mjs'
import { checkRecoverGit } from '../../../skills/implement-issue-tree/runner/adapters/codex.mjs'

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

test('model 省略は config.sessionModel の段', async () => {
  const c = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  await c.agent('p', { label: 'recover:#2', schema: SCHEMA })
  assert.equal(c.calls[0].model, BASE_CONFIG.models.codex[BASE_CONFIG.sessionModel].model)
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

test('isolation: worktree の作成関数は非同期（worktree.mjs の createWorktree は Promise を返す）。待ってから cwd にし、拒否は例外（#861）', async () => {
  const { agent, calls } = makeHost({
    reply: () => ({ ok: true, n: 1 }),
    cfg: { createWorktree: async (p) => { await new Promise((r) => setTimeout(r, 5)); return { path: `${p.mainRoot}/.claude/worktrees/${p.runId}-${p.n}` } } },
  })
  await agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' })
  assert.equal(calls[0].cwd, `${mainRoot}/.claude/worktrees/${RUN_ID}-1`)
  const failing = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { createWorktree: async () => { throw new Error('git fetch が 300 ms で時間切れになった') } } })
  await assert.rejects(failing.agent('b', { label: 'impl:#2', schema: SCHEMA, isolation: 'worktree' }), /時間切れ/)
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

// merge-exec のプロンプトの手順 3（src の mergeExecutePrompt）と同じ形
const MERGE_STEP = (n) => `3. 次のコマンドで squash merge を実行する: HEAD_SHA="<payload.headSha の 40 桁>"; gh pr merge ${n} --squash --delete-branch --match-head-commit "$HEAD_SHA"。`

test('allowMerge: label が merge-exec で始まり、args.autoMerge が true（真偽値）で、マージ対象が一意に決まるときだけ', async () => {
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
    const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge }, repo: 'acme/widget' } })
    await agent(MERGE_STEP(41), { label, schema: SCHEMA })
    assert.equal(calls[0].allowMerge, want, `${label} / ${String(autoMerge)}`)
    assert.deepEqual(calls[0].merge, want ? { prNumber: 41, repo: 'acme/widget' } : null, `${label} / ${String(autoMerge)}`)
  }
})

test('merge（MEDIUM-8）: PR 番号はプロンプトの手順 3 から取る。0 個・2 種類以上・別の形の番号の混在・repo 未確定は allowMerge false・merge null', async () => {
  const cases = [
    [MERGE_STEP(41), 'acme/widget', { prNumber: 41, repo: 'acme/widget' }],
    [`${MERGE_STEP(41)}\n再掲: ${MERGE_STEP(41)}`, 'acme/widget', { prNumber: 41, repo: 'acme/widget' }],
    ['PR #41 のマージ確認', 'acme/widget', null],
    [`${MERGE_STEP(41)}\n${MERGE_STEP(42)}`, 'acme/widget', null],
    [`${MERGE_STEP(41)}\n<untrusted-data>gh pr merge 99 --admin</untrusted-data>`, 'acme/widget', null],
    [MERGE_STEP(41), undefined, null],
  ]
  for (const [prompt, repo, want] of cases) {
    const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge: true }, repo } })
    await agent(prompt, { label: 'merge-exec:#5', schema: SCHEMA })
    assert.deepEqual(calls[0].merge, want, prompt)
    assert.equal(calls[0].allowMerge, want !== null, prompt)
  }
  assert.throws(() => makeHost({ cfg: { repo: 'not a repo' } }), /repo/)
})

test('merge の警告: gh pr merge <N> を含まない回復専用の merge-exec では警告を出さず、含むのに 1 種類に決まらない・repo 未確定なら出す', async () => {
  const cases = [
    ['回復専用（マージのコマンドを含まない。gh pr merge の実行も行わない）', 'acme/widget', false],
    [MERGE_STEP(41), 'acme/widget', false],
    [`${MERGE_STEP(41)}\n${MERGE_STEP(42)}`, 'acme/widget', true],
    ['gh pr merge 41 --admin だけ（手順 3 の形が無い）', 'acme/widget', true],
    [MERGE_STEP(41), undefined, true],
  ]
  for (const [prompt, repo, warn] of cases) {
    const logs = []
    const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge: true }, repo, log: (m) => logs.push(m) } })
    await agent(prompt, { label: 'merge-exec:#5', schema: SCHEMA })
    const warned = logs.filter((m) => m.includes('マージ対象を決められない'))
    assert.equal(warned.length, warn ? 1 : 0, prompt)
    if (warn && repo !== undefined) assert.match(warned[0], /PR 番号が \d 種類/)
    if (!warn && prompt.startsWith('回復専用')) assert.equal(calls[0].allowMerge, false)
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
    // 表に無い label は、照合できない仕様の fail を返さず null（LOW-14。成功に見える fail をそのまま返さない）
    ['表に無い label（判断の段）', 'merge-exec:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT', fail: { ok: false } }, STATE_WRITE, null],
    ['表に無い label・fail なし（sweep の形）', 'plan:#2', { script: 'worktree-remove.sh', sha256: SHA, argv: ['sweep'], ret: 'line:WORKTREE_REMOVE_RESULT' }, SWEEP, null],
    ['表に無い label・成功に見える fail', 'plan:#2', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT', fail: { ok: true } }, STATE_WRITE, null],
    ['接頭辞だけ一致する label', 'state:update:#2x', { script: 'state.sh', sha256: SHA, argv: ['--file', 'f', 'merge'], ret: 'line:STATE_RESULT' }, STATE_WRITE, null], // 表に無い label と同じ扱い
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

test('writablePaths（MEDIUM-4）: state:load とそのフォールバックだけに <main>/_/issue-trees を渡す（load-verify・他の段は空。load-fill はモデルへ回らない）', async () => {
  // 状態ファイルが無い初回（mainRoot に _/issue-trees/1.json は無い）: state:load は初期化のためモデルへ回る
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { parent: 1 } } })
  const want = { 'state:load': true, 'state:load:fallback-sonnet': true, 'state:load-fill': null, 'state:load-fill:fallback-sonnet': null, 'state:load-verify': false, 'state:loader': false, 'plan:issue-tree': false, 'merge-exec:#2': false, 'state:load:retry': false }
  for (const label of Object.keys(want)) await agent('p _/issue-trees/1.json', { label, schema: SCHEMA })
  assert.deepEqual(calls.map((r) => r.label), Object.keys(want).filter((l) => want[l] !== null), 'state:load-fill はホストが状態ファイルを読む（lib/state-read.mjs）')
  for (const r of calls) assert.deepEqual(r.writablePaths, want[r.label] ? [join(mainRoot, '_', 'issue-trees')] : [], r.label)
})

test('killScriptsSync（LOW-11）: 実行中の spawnScript のプロセスグループを同期で SIGKILL する', async () => {
  const pidFile = join(root, 'ks-gc.pid')
  const p = spawnScript('bash', ['-c', `sleep 300 & echo $! > '${pidFile}'; wait`], { cwd: root, input: '', timeoutMs: 60000 })
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
  const gc = Number(readFileSync(pidFile, 'utf8'))
  killScriptsSync()
  const r = await p
  assert.notEqual(r.code, 0)
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let i = 0; i < 30 && alive(gc); i++) await new Promise((r2) => setTimeout(r2, 100))
  assert.equal(alive(gc), false)
})

// 孫の pid を書いたファイルを待って読む（孫か spawnScript の子が書く）。書かれなければ null
async function readPid(file) {
  for (let i = 0; i < 100 && !(existsSync(file) && readFileSync(file, 'utf8').trim() !== ''); i++) await new Promise((r) => setTimeout(r, 20))
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const killPid = (pid) => { if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* 既に終了 */ } }

test('spawnScript: 新しいセッションへ抜けた孫が標準出力を握っても、kill の後の猶予を過ぎたら timedOut のまま決着する', async () => {
  // perl の setsid で孫をプロセスグループの外へ出す（macOS に setsid コマンドは無い）。孫は setsid の後に自分の pid を書き、
  // stdout を継いだまま眠る（子が時間切れで先に止められても、孫の pid は残る）
  const pidFile = join(root, `ss-esc-${Math.random().toString(16).slice(2)}.pid`)
  const script = 'if (!fork()) { POSIX::setsid(); open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "sleep", "30" } sleep 30'
  const p = spawnScript('perl', ['-MPOSIX', '-e', script, pidFile], { cwd: root, input: '', timeoutMs: 200, killGraceMs: 200 })
  let timer
  let gc = null
  try {
    gc = await readPid(pidFile)
    assert.ok(gc, '孫が起動しない')
    const deadline = new Promise((r) => { timer = setTimeout(() => r('hung'), 3000) })
    const r = await Promise.race([p, deadline])
    assert.notEqual(r, 'hung', 'close を待ち続けて決着しない')
    assert.equal(r.timedOut, true)
    assert.equal(r.code, null)
    assert.ok(isAlive(gc), '前提: 孫はグループの外にいて SIGKILL が届かない')
  } finally {
    clearTimeout(timer)
    killPid(gc)
  }
})

test('spawnScript: 子が exit 0 で終わったら、標準入出力を閉じて残った孫もプロセスグループごと止める', async () => {
  const pidFile = join(root, `ss-bg-${Math.random().toString(16).slice(2)}.pid`)
  const r = await spawnScript('bash', ['-c', `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`], { cwd: root, input: '', timeoutMs: 10_000 })
  const gc = await readPid(pidFile)
  try {
    assert.ok(gc, '孫が起動しない')
    assert.equal(r.code, 0)
    for (let i = 0; i < 20 && isAlive(gc); i++) await new Promise((r2) => setTimeout(r2, 25))
    assert.equal(isAlive(gc), false, '決着の後も孫が生きている')
  } finally {
    killPid(gc)
  }
})

// ---------------------------------------------------------------------------
// 内容の固定（PR #851 の P0。lib/pins.mjs）: ホストが直接起動する launcher と、照合より前に source される signed-output.sh、
// run.mjs が起動前に固定したファイル（cfg.pins）を、段の起動前（とモデルの段の後）に照合し、食い違えば以降の段を実行しない
// ---------------------------------------------------------------------------

function pinnedSkill() {
  const d = join(root, `pinskill-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(d, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(d, 'scripts', 'run-verified.sh'), readFileSync(join(skillDir, 'scripts', 'run-verified.sh')))
  chmodSync(join(d, 'scripts', 'run-verified.sh'), 0o755)
  writeFileSync(join(d, 'scripts', 'lib', 'signed-output.sh'), '# signed-output\n')
  return d
}
const EXIT_OK = { v: 1, script: 'fetch-tree.sh', sha256: SHA, argv: ['--release', '--dir', '/tmp/x'], ret: 'exit-ok' }

test('固定（P0）: launcher を host の作成後に書き換えると、実行仕様の段を起動せず exec-refused・失敗値。以降の段もすべて止める', async () => {
  const sd = pinnedSkill()
  const runDir = join(root, `pin-run-${Math.random().toString(16).slice(2)}`)
  const { agent, calls } = makeHost({ cfg: { skillDir: sd, runDir }, reply: () => ({ ok: true, n: 1 }) })
  control({ code: 0 })
  assert.deepEqual(await agent(withSpec(EXIT_OK), { label: 'plan:issue-tree-release', phase: 'Quick', model: 'haiku', schema: STATE_WRITE }), { ok: true })
  assert.ok(recorded(), '固定どおりなら起動する')
  // エージェントが launcher を書き換えた想定
  writeFileSync(join(sd, 'scripts', 'run-verified.sh'), '#!/bin/bash\necho pwned > /dev/null\nexit 0\n')
  control({ code: 0 })
  assert.deepEqual(await agent(withSpec(EXIT_OK), { label: 'plan:issue-tree-release', phase: 'Quick', model: 'haiku', schema: STATE_WRITE }), { ok: false })
  assert.equal(recorded(), null, '書き換えた launcher を起動しない')
  const metas = readdirSync(join(runDir, 'agents')).sort().map((d) => JSON.parse(readFileSync(join(runDir, 'agents', d, 'meta.json'), 'utf8')))
  assert.equal(metas[1].status, 'exec-refused')
  assert.match(metas[1].reason, /run-verified\.sh/)
  // 元に戻しても止めたまま（以降のモデルの段もアダプタを呼ばない）
  writeFileSync(join(sd, 'scripts', 'run-verified.sh'), readFileSync(join(skillDir, 'scripts', 'run-verified.sh')))
  assert.deepEqual(await agent(withSpec(EXIT_OK), { label: 'plan:issue-tree-release', phase: 'Quick', model: 'haiku', schema: STATE_WRITE }), { ok: false })
  assert.equal(await agent('P', { label: 'x', phase: 'Quick', schema: SCHEMA }), null)
  assert.equal(calls.length, 0)
})

test('固定（P0）: signed-output.sh・cfg.pins のファイル（ガード等）の書き換え・後から現れたファイルも同じく止める。モデルの段の最中の書き換えは結果を捨てる', async () => {
  // signed-output.sh（--verify-only の枝が照合より前に source する）
  const sd = pinnedSkill()
  const a = makeHost({ cfg: { skillDir: sd } })
  writeFileSync(join(sd, 'scripts', 'lib', 'signed-output.sh'), 'touch /tmp/x\n')
  control({ code: 0 })
  assert.deepEqual(await a.agent(withSpec(EXIT_OK), { label: 'plan:issue-tree-release', phase: 'Quick', model: 'haiku', schema: STATE_WRITE }), { ok: false })
  assert.equal(recorded(), null)
  // cfg.pins（run.mjs が起動前に固定したガード）: モデルの段の前に照合し、アダプタを呼ばない
  const sd2 = pinnedSkill()
  const guard = join(sd2, 'guard.sh')
  writeFileSync(guard, 'exit 0\n')
  const late = join(sd2, 'late.sh')
  const { pinFiles } = await import('../../../skills/implement-issue-tree/runner/lib/pins.mjs')
  const b = makeHost({ cfg: { skillDir: sd2, pins: pinFiles([guard, late]) }, reply: () => ({ ok: true, n: 1 }) })
  assert.deepEqual(await b.agent('P', { label: 'x', phase: 'Quick', schema: SCHEMA }), { ok: true, n: 1 })
  writeFileSync(late, 'echo\n')
  assert.equal(await b.agent('P', { label: 'x', phase: 'Quick', schema: SCHEMA }), null, '固定時に無かったファイルが現れた')
  assert.equal(b.calls.length, 1)
  // モデルの段の最中にガードが書き換えられたら、適合した応答でも返さない
  const sd3 = pinnedSkill()
  const g3 = join(sd3, 'guard.sh')
  writeFileSync(g3, 'exit 0\n')
  const c = makeHost({ cfg: { skillDir: sd3, pins: pinFiles([g3]) }, reply: () => { writeFileSync(g3, 'exit 0 # changed\n'); return { ok: true, n: 1 } } })
  assert.equal(await c.agent('P', { label: 'x', phase: 'Quick', schema: SCHEMA }), null)
})

test('固定（P0）: 食い違いの後の隔離の段は worktree を作らずに null（reason: pin-mismatch）。アダプタも呼ばない', async () => {
  const sd = pinnedSkill()
  const guard = join(sd, 'guard.sh')
  writeFileSync(guard, 'exit 0\n')
  const runDir = join(root, `pin-wt-${Math.random().toString(16).slice(2)}`)
  const { pinFiles } = await import('../../../skills/implement-issue-tree/runner/lib/pins.mjs')
  const made = []
  const { agent, calls } = makeHost({
    cfg: { skillDir: sd, runDir, pins: pinFiles([guard]), createWorktree: (p) => { made.push(p.n); return { path: `${p.mainRoot}/.claude/worktrees/${p.runId}-${p.n}` } } },
    reply: () => ({ ok: true, n: 1 }),
  })
  writeFileSync(guard, 'exit 0 # changed\n')
  for (let i = 0; i < 3; i++) assert.equal(await agent('P', { label: `impl:#${i + 2}`, phase: 'Quick', schema: SCHEMA, isolation: 'worktree' }), null)
  assert.deepEqual(made, [], 'worktree を作らない')
  assert.equal(calls.length, 0)
  const metas = readdirSync(join(runDir, 'agents')).sort().map((d) => JSON.parse(readFileSync(join(runDir, 'agents', d, 'meta.json'), 'utf8')))
  assert.deepEqual(metas.map((m) => [m.outcome, m.reason]), [['null', 'pin-mismatch'], ['null', 'pin-mismatch'], ['null', 'pin-mismatch']])
  assert.match(metas[0].detail, /guard\.sh/)
})

test('readTmpOf（PR #851 の P1）: ツリーのページの段（plan:issue-tree-page-N・-retry）にだけ、それまでのツリーの段（plan:issue-tree・-retry）の logDir を渡す。他の段・runDir 無しは空', async () => {
  const runDir = join(root, `rt-run-${Math.random().toString(16).slice(2)}`)
  const { agent, calls } = makeHost({ cfg: { runDir }, reply: () => ({ ok: true, n: 1 }) })
  for (const label of ['plan:issue-tree-page-1', 'plan:issue-tree', 'plan:issue-tree-retry', 'plan:issue-tree-page-1', 'plan:issue-tree-page-12-retry', 'plan:#2', 'plan:issue-tree-page-0', 'plan:issue-tree-pages', 'impl:#2']) {
    await agent('p', { label, schema: SCHEMA })
  }
  const dirs = [join(runDir, 'agents', '0002-plan_issue-tree'), join(runDir, 'agents', '0003-plan_issue-tree-retry')]
  assert.deepEqual(calls.map((r) => [r.label, r.readTmpOf]), [
    ['plan:issue-tree-page-1', []], // ツリーの段より前
    ['plan:issue-tree', []],
    ['plan:issue-tree-retry', []],
    ['plan:issue-tree-page-1', dirs],
    ['plan:issue-tree-page-12-retry', dirs],
    ['plan:#2', []],
    ['plan:issue-tree-page-0', []],
    ['plan:issue-tree-pages', []],
    ['impl:#2', []],
  ])
  const reqLog = JSON.parse(readFileSync(join(runDir, 'agents', '0004-plan_issue-tree-page-1', 'request.json'), 'utf8'))
  assert.deepEqual(reqLog.readTmpOf, dirs)
  const b = makeHost({ reply: () => ({ ok: true, n: 1 }) })
  await b.agent('p', { label: 'plan:issue-tree', schema: SCHEMA })
  await b.agent('p', { label: 'plan:issue-tree-page-1', schema: SCHEMA })
  assert.deepEqual(b.calls[1].readTmpOf, [])
})

test('recoverGit（PR #851 の P1）: recover:#N にだけ、プロンプトの recover-prep.sh の行（ちょうど 1 つ）の --worktree を検証して渡す。決められなければ base の取得の分だけ、行が無い・2 つ以上なら null', async () => {
  const mr = join(root, `rec-main-${Math.random().toString(16).slice(2)}`)
  const wt = join(mr, '.claude', 'worktrees', 'old-1')
  mkdirSync(wt, { recursive: true })
  mkdirSync(join(mr, '.git', 'worktrees', 'old-1'), { recursive: true })
  writeFileSync(join(mr, '.git', 'worktrees', 'old-1', 'gitdir'), `${wt}/.git\n`)
  mkdirSync(join(mr, '.claude', 'worktrees', 'unreg'), { recursive: true })
  mkdirSync(join(mr, 'outside'), { recursive: true })
  const line = (rest) => `bash '${skillDir}/scripts/run-verified.sh' ${'c'.repeat(64)} recover-prep.sh${rest}`
  const P = (rest, extra = '') => `イシュー #2 の回復\n手順:\n\`\`\`sh\n${line(rest)}\n\`\`\`\n${extra}`
  const { agent, calls } = makeHost({ cfg: { mainRoot: mr }, reply: () => ({ ok: true, n: 1 }) })
  const cases = [
    ['recover:#2', P(` --base 'main' --worktree '${wt}' --branch 'feat/2-x'`), { commonDir: join(mr, '.git'), worktree: wt, gitdir: join(mr, '.git', 'worktrees', 'old-1') }],
    ['recover:#2', P(" --base 'main' --branch 'feat/2-x'"), { commonDir: join(mr, '.git'), worktree: null, gitdir: null }],
    // 未登録・.claude/worktrees の外・実体が無い（dead）は base の取得の分だけ
    ['recover:#2', P(` --base 'main' --worktree '${join(mr, '.claude', 'worktrees', 'unreg')}'`), { commonDir: join(mr, '.git'), worktree: null, gitdir: null }],
    ['recover:#2', P(` --base 'main' --worktree '${join(mr, 'outside')}'`), { commonDir: join(mr, '.git'), worktree: null, gitdir: null }],
    ['recover:#2', P(` --base 'main' --worktree '${join(mr, '.claude', 'worktrees', 'gone')}'`), { commonDir: join(mr, '.git'), worktree: null, gitdir: null }],
    ['recover:#2', P(` --base 'main' --worktree '${mr}'`), { commonDir: join(mr, '.git'), worktree: null, gitdir: null }],
    // タイトル等に同じ形の行が混ざって 2 つになれば何も足さない
    ['recover:#2', P(` --base 'main' --worktree '${wt}'`, line(` --base 'main' --worktree '${join(mr, 'outside')}'`)), null],
    ['recover:#2', 'recover-prep.sh を実行する', null],
    ['recover:#2', P(` --base 'main' --worktree '${wt}'; touch /tmp/x`), null],
    // 回復の段でなければ何も足さない
    ['plan:#2', P(` --base 'main' --worktree '${wt}'`), null],
    ['recover:#2-retry', P(` --base 'main' --worktree '${wt}'`), null],
  ]
  for (const [label, prompt] of cases) await agent(prompt, { label, schema: SCHEMA })
  cases.forEach(([label, , want], i) => assert.deepEqual(calls[i].recoverGit, want, `${i}: ${label}`))
  // .claude/worktrees 自体が symlink（実体が別の場所）なら worktree は足さず base の取得の分だけ（アダプタが拒否する形を渡さない）
  const mr2 = join(root, `rec-main2-${Math.random().toString(16).slice(2)}`)
  const real2 = join(root, `rec-wts-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(real2, 'old-1'), { recursive: true })
  mkdirSync(join(mr2, '.claude'), { recursive: true })
  symlinkSync(real2, join(mr2, '.claude', 'worktrees'))
  mkdirSync(join(mr2, '.git', 'worktrees', 'old-1'), { recursive: true })
  writeFileSync(join(mr2, '.git', 'worktrees', 'old-1', 'gitdir'), `${join(real2, 'old-1')}/.git\n`)
  const h2 = makeHost({ cfg: { mainRoot: mr2 }, reply: () => ({ ok: true, n: 1 }) })
  await h2.agent(P(` --base 'main' --worktree '${join(mr2, '.claude', 'worktrees', 'old-1')}'`), { label: 'recover:#2', schema: SCHEMA })
  assert.deepEqual(h2.calls[0].recoverGit, { commonDir: join(mr2, '.git'), worktree: null, gitdir: null })
})

// PR #851 の Bugbot: mainRoot の途中に symlink がある（macOS の /tmp → /private/tmp 等）と、.claude/worktrees の realpath が
// 解決していない join(mainRoot, …) と一致せず、実体が直下にある worktree でも WIP コミットの書き込みを足さなかった。
// run.mjs は mainRoot を realpath にしてから渡すのでランナーの経路では起きないが、関数の単体でも realpath 同士で比べる。
// アダプタの検証（checkRecoverGit）も同じ基準で受け、.claude/worktrees 自体が symlink なら従来どおり base の取得だけにする
test('recoverGit（PR #851 の Bugbot）: mainRoot の途中に symlink があっても、実体が .claude/worktrees の直下の worktree は足し、アダプタの検証も通る', () => {
  const real = join(root, `rec-real-${Math.random().toString(16).slice(2)}`)
  const link = join(root, `rec-link-${Math.random().toString(16).slice(2)}`)
  const wtReal = join(real, '.claude', 'worktrees', 'old-1')
  mkdirSync(wtReal, { recursive: true })
  mkdirSync(join(real, '.git', 'worktrees', 'old-1'), { recursive: true })
  writeFileSync(join(real, '.git', 'worktrees', 'old-1', 'gitdir'), `${wtReal}/.git\n`)
  symlinkSync(real, link)
  const line = (wt) => `bash '${skillDir}/scripts/run-verified.sh' ${'c'.repeat(64)} recover-prep.sh --base 'main' --worktree '${wt}'`
  const want = { commonDir: join(real, '.git'), worktree: wtReal, gitdir: join(real, '.git', 'worktrees', 'old-1') }
  for (const wt of [join(link, '.claude', 'worktrees', 'old-1'), wtReal]) {
    const got = recoverGitFor('recover:#2', line(wt), { skillDir, mainRoot: link })
    assert.deepEqual(got, want, wt)
    assert.deepEqual(checkRecoverGit(link, got), want, 'アダプタの検証も同じ mainRoot で通る')
  }
  // 解決済みの mainRoot でも同じ結果（従来の経路）
  assert.deepEqual(recoverGitFor('recover:#2', line(wtReal), { skillDir, mainRoot: real }), want)
  // .claude/worktrees 自体が外を指す symlink なら、mainRoot の途中の symlink と重なっても base の取得だけ（801e987 の判定）
  const real3 = join(root, `rec-real3-${Math.random().toString(16).slice(2)}`)
  const out3 = join(root, `rec-out3-${Math.random().toString(16).slice(2)}`)
  const link3 = join(root, `rec-link3-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(out3, 'old-1'), { recursive: true })
  mkdirSync(join(real3, '.claude'), { recursive: true })
  symlinkSync(out3, join(real3, '.claude', 'worktrees'))
  mkdirSync(join(real3, '.git', 'worktrees', 'old-1'), { recursive: true })
  writeFileSync(join(real3, '.git', 'worktrees', 'old-1', 'gitdir'), `${join(out3, 'old-1')}/.git\n`)
  symlinkSync(real3, link3)
  const got3 = recoverGitFor('recover:#2', line(join(link3, '.claude', 'worktrees', 'old-1')), { skillDir, mainRoot: link3 })
  assert.deepEqual(got3, { commonDir: join(real3, '.git'), worktree: null, gitdir: null })
  assert.deepEqual(checkRecoverGit(link3, got3), got3)
})

// ---- Phase 4（実リポジトリでの通し確認）で見つかった 4 件 ----

test('前置き（Phase 4）: マージを許す merge-exec の段は here-doc の指示を外し、手順 3 のマージコマンドを示された 1 行のまま実行させる。他の段・回復専用の merge-exec は従来どおり', async () => {
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge: true }, repo: 'acme/widget' } })
  await agent(MERGE_STEP(41), { label: 'merge-exec:#5', schema: SCHEMA })
  const merge = calls[0]
  assert.equal(merge.allowMerge, true)
  assert.equal(merge.prompt.includes("<<'EOF'"), false, 'here-doc の指示を含まない')
  assert.equal(merge.prompt.includes(SHELL_NOTE), false)
  assert.ok(merge.prompt.includes('示された 1 行のまま'), merge.prompt.slice(0, 800))
  assert.match(merge.prompt, /`status` 等のシェルの特殊変数名に代入しない/, 'zsh の特殊変数の注意は残す')
  await agent('回復専用（マージのコマンドを含まない）', { label: 'merge-exec:#5', schema: SCHEMA })
  await agent('p', { label: 'plan:#2', schema: SCHEMA })
  for (const req of calls.slice(1)) {
    assert.equal(req.allowMerge, false)
    assert.ok(req.prompt.includes(SHELL_NOTE), req.label)
    assert.equal(req.prompt.includes('示された 1 行のまま'), false, req.label)
  }
})

test('worktreePath（Phase 4）: 隔離 worktree の段の値の worktreePath は、ランナーが作ったパスで上書きし、違っていたらログに残す。キーが無い値・隔離しない段は変えない', async () => {
  const WT_SCHEMA = { type: 'object', required: ['pushed'], properties: { pushed: { type: 'boolean' }, worktreePath: { type: 'string' } } }
  const logs = []
  let reply = (req) => ({ pushed: false, worktreePath: `${req.cwd} absolute path?` })
  const { agent } = makeHost({
    reply: (req) => reply(req),
    cfg: { log: (m) => logs.push(m), createWorktree: (p) => ({ path: `${p.mainRoot}/.claude/worktrees/${p.runId}-${p.n}` }) },
  })
  const want = `${mainRoot}/.claude/worktrees/${RUN_ID}-1`
  assert.deepEqual(await agent('fix', { label: 'fix:#5', schema: WT_SCHEMA, isolation: 'worktree' }), { pushed: false, worktreePath: want })
  const warned = logs.filter((m) => m.includes('worktreePath'))
  assert.equal(warned.length, 1, logs.join('\n'))
  assert.match(warned[0], /fix:#5/)
  // 同じ値なら黙って通す
  reply = (req) => ({ pushed: true, worktreePath: req.cwd })
  assert.deepEqual(await agent('fix', { label: 'fix:#5', schema: WT_SCHEMA, isolation: 'worktree' }), { pushed: true, worktreePath: `${mainRoot}/.claude/worktrees/${RUN_ID}-2` })
  assert.equal(logs.filter((m) => m.includes('worktreePath')).length, 1)
  // キーが無い値には足さない
  reply = () => ({ pushed: true })
  assert.deepEqual(await agent('fix', { label: 'fix:#5', schema: WT_SCHEMA, isolation: 'worktree' }), { pushed: true })
  // 隔離しない段は変えない
  reply = () => ({ pushed: false, worktreePath: '/elsewhere' })
  assert.deepEqual(await agent('x', { label: 'merge:#5', schema: WT_SCHEMA }), { pushed: false, worktreePath: '/elsewhere' })
})

test('merge-exec の cwd（Phase 4）: マージを許す段はリポジトリの外の空ディレクトリを cwd にし（gh pr merge がローカルのブランチを見つけない）、終わったら消す。回復専用の merge-exec と他の段は mainRoot', async () => {
  const repo = makeRepo()
  repo.git(repo.main, 'branch', 'feat/5-x')
  const seen = []
  const reply = (req) => {
    const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/5-x'], { cwd: req.cwd, env: gitEnv(repo.root), encoding: 'utf8' })
    seen.push({ label: req.label, cwd: req.cwd, exists: existsSync(req.cwd), branchFound: r.status === 0 })
    return { ok: true, n: 1 }
  }
  const agent = createAgentHost({ adapter: makeFakeAdapterModule({ reply }).createAdapter({}), cfg: { config: config(), skillDir, mainRoot: repo.main, runId: RUN_ID, args: { autoMerge: true }, repo: 'acme/widget' } })
  await agent(MERGE_STEP(41), { label: 'merge-exec:#5', schema: SCHEMA })
  await agent('回復専用（マージのコマンドを含まない）', { label: 'merge-exec:#5', schema: SCHEMA })
  await agent('p', { label: 'merge:#5', schema: SCHEMA })
  const [m, rec, other] = seen
  assert.notEqual(m.cwd, repo.main)
  assert.equal(m.exists, true, '段の間は cwd がある')
  assert.equal(m.branchFound, false, 'cwd の git からはメインのローカルブランチが見えない')
  assert.equal(existsSync(m.cwd), false, '段の後に消す')
  assert.equal(rec.cwd, repo.main, '回復専用（GH_REPO を固定しない）は mainRoot')
  assert.equal(rec.branchFound, true)
  assert.equal(other.cwd, repo.main)
})

test('merge-exec の cwd（Phase 4）: 置き場がリポジトリの中ならマージを許さない（ローカルのブランチ削除で失敗する形にしない）', async () => {
  const repo = makeRepo()
  const logs = []
  const { agent, calls } = makeHost({ reply: () => ({ ok: true, n: 1 }), cfg: { args: { autoMerge: true }, repo: 'acme/widget', mergeCwdParent: repo.main, log: (x) => logs.push(x) } })
  await agent(MERGE_STEP(41), { label: 'merge-exec:#5', schema: SCHEMA })
  assert.equal(calls[0].allowMerge, false)
  assert.equal(calls[0].merge, null)
  assert.equal(calls[0].cwd, mainRoot)
  assert.ok(logs.some((x) => x.includes('リポジトリの外')), logs.join('\n'))
  assert.deepEqual(readdirSync(repo.main).filter((f) => f.startsWith('iit-merge-')), [], '作った置き場は消す')
})

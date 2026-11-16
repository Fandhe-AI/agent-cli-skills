// Codex アダプタ（runner/adapters/codex.mjs・codex-strict.mjs・codex-hook.sh）の検査。
// 偽 codex（tests/lib/fake-codex.mjs）を PATH に置いて起動し、引数・環境・失敗の分類・hook の判定・時間切れ・
// セッション削除を確かめる。実際の codex・ネットワーク・ホームの設定には触れない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { createAdapter, buildProfileArgs, classifyFailure, summarizeEvents, DARWIN_HEREDOC_TMP, platformWritePaths } from '../../../skills/implement-issue-tree/runner/adapters/codex.mjs'
import { decodeStrictText, strictifySchema } from '../../../skills/implement-issue-tree/runner/adapters/codex-strict.mjs'
import { AdapterError } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'lib', 'fake-codex.mjs')
const SKILL_DIR = join(HERE, '..', '..', '..', 'skills', 'implement-issue-tree')
const SHA = 'a'.repeat(40)
const MERGE_EXEC = `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"`
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'

/** 一時ディレクトリ・偽 codex・アダプタを用意する。 */
function setup({ turns, toolConfig = {}, home } = {}) {
  const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-codex-adapter-'))))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  const scenario = join(root, 'scenario.json')
  writeFileSync(scenario, JSON.stringify({ turns }))
  const log = join(root, 'fake.log')
  const mainRoot = join(root, 'main')
  mkdirSync(join(mainRoot, '.git', 'worktrees'), { recursive: true })
  const fakeHome = home ?? join(root, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_LOG: log }
  const runDir = join(root, 'run')
  mkdirSync(runDir)
  const adapter = createAdapter({ skillDir: SKILL_DIR, mainRoot, runDir, toolConfig, guard: {}, env })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const req = (over = {}) => ({
    prompt: 'P', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, model: 'gpt-6.1-sol', effort: 'high',
    cwd: mainRoot, label: 'x', allowMerge: false, timeoutMs: 20000, resume: null, logDir: join(runDir, 'agents', over.name ?? 'a1'), ...over,
  })
  return { root, mainRoot, runDir, fakeHome, adapter, calls, req, env }
}

const okTurn = (over = {}) => ({ threadId: U1, message: '{"ok":true}', ...over })
const argOf = (argv, flag) => argv[argv.indexOf(flag) + 1]
const rejectsKind = async (p, kind) => {
  await assert.rejects(p, (e) => e instanceof AdapterError && e.kind === kind && (assert.ok(e.message), true))
}

// ---------------------------------------------------------------------------
// strict 変換
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    note: { type: 'string' },
    state: { type: 'string', enum: ['a', 'b'] },
    reason: { type: ['string', 'null'] },
    items: { type: 'object', additionalProperties: { type: 'object' } },
    payload: { type: 'object' },
    list: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, tag: { type: 'string' } }, required: ['n'] } },
  },
  required: ['ok', 'payload'],
}

test('strictify: 全 object は additionalProperties:false・required は全キー・任意キーは null 許容', () => {
  const s = strictifySchema(SCHEMA)
  assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.required, ['ok', 'note', 'state', 'reason', 'items', 'payload', 'list'])
  assert.deepEqual(s.properties.ok, { type: 'boolean' })
  assert.deepEqual(s.properties.note.type, ['string', 'null'])
  assert.deepEqual(s.properties.state, { type: ['string', 'null'], enum: ['a', 'b', null] })
  assert.deepEqual(s.properties.reason.type, ['string', 'null'])
  const li = s.properties.list.items
  assert.deepEqual(li.required, ['n', 'tag'])
  assert.deepEqual(li.properties.tag.type, ['string', 'null'])
  assert.equal(li.additionalProperties, false)
  assert.equal(SCHEMA.additionalProperties, undefined, '入力は変更しない')
  assert.deepEqual(SCHEMA.required, ['ok', 'payload'])
})

test('strictify: 自由形式の object は [{key,value}] の配列になる（型付きは値の型、無しは JSON 文字列）', () => {
  const s = strictifySchema(SCHEMA)
  assert.equal(s.properties.payload.type, 'array')
  assert.deepEqual(s.properties.payload.items.properties.value, { type: 'string' })
  assert.equal(s.properties.items.type[0] ?? s.properties.items.type, 'array')
  const typed = s.properties.items.anyOf?.[0] ?? s.properties.items
  assert.equal(typed.type === 'array' || Array.isArray(typed.type), true)
})

test('strictify: oneOf は anyOf になり、additionalProperties:false の空 object は自由形式にしない', () => {
  const s = strictifySchema({ type: 'object', properties: { x: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, e: { type: 'object', additionalProperties: false } }, required: ['x', 'e'] })
  assert.equal(s.properties.x.oneOf, undefined)
  assert.equal(s.properties.x.anyOf.length, 2)
  assert.equal(s.properties.e.type, 'object')
})

test('decode: 任意キーの null は落とす・null を許すキーと required の null は保つ', () => {
  const strictOut = JSON.stringify({ ok: true, note: null, state: null, reason: null, items: [], payload: [], list: [{ n: 1, tag: null }] })
  const back = JSON.parse(decodeStrictText(SCHEMA, strictOut))
  assert.deepEqual(back, { ok: true, reason: null, items: {}, payload: {}, list: [{ n: 1 }] })
})

test('decode: 封筒 payload は JSON 文字列から読み戻し、null を落とさない', () => {
  const out = JSON.stringify({
    ok: true,
    payload: [{ key: 'headSha', value: 'null' }, { key: 'n', value: '3' }, { key: 'obj', value: '{"a":null}' }],
    items: [{ key: 'k', value: { x: 1 } }],
  })
  const back = JSON.parse(decodeStrictText(SCHEMA, out))
  assert.deepEqual(back.payload, { headSha: null, n: 3, obj: { a: null } })
  assert.deepEqual(back.items, { k: { x: 1 } })
})

test('decode: JSON として読めない値は文字列のまま残し、読めない応答は触らない', () => {
  const back = JSON.parse(decodeStrictText(SCHEMA, JSON.stringify({ ok: true, payload: [{ key: 'a', value: 'not json' }] })))
  assert.equal(back.payload.a, 'not json')
  assert.equal(decodeStrictText(SCHEMA, '前置き {"ok":true}'), '前置き {"ok":true}')
})

test('decode: __proto__ キーは own プロパティとして残る（検証側で拒否できるように）', () => {
  const back = JSON.parse(decodeStrictText(SCHEMA, JSON.stringify({ ok: true, payload: [{ key: '__proto__', value: '1' }] })))
  assert.equal(Object.hasOwn(back.payload, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(back.payload), Object.prototype)
})

// ---------------------------------------------------------------------------
// 引数・環境
// ---------------------------------------------------------------------------

test('start: codex が無ければ prereq・agent-guard.sh が無くても prereq', async () => {
  const a = setup({ turns: [okTurn()], toolConfig: { codexBin: 'codex-does-not-exist' } })
  await rejectsKind(a.adapter.start(), 'prereq')
  // 明示の guardScript が無ければ、既定の探索先（init-codex の配布物）に写しがあっても使わず prereq（lib/guard-script.mjs）
  const b = setup({ turns: [okTurn()], toolConfig: { guardScript: '/nonexistent/agent-guard.sh' } })
  const e = await b.adapter.start().then(() => null, (err) => err)
  assert.equal(e?.kind, 'prereq')
  assert.match(e.message, /init-codex か init-opencode を導入する/)
  // 明示しなければ既定の探索先に見つかり、start は成功する
  const c = setup({ turns: [okTurn()] })
  await c.adapter.start()
})

test('run: exec の引数の組み立て（新規）', async () => {
  const t = setup({ turns: [okTurn()] })
  const r = await t.adapter.run(t.req())
  assert.deepEqual(JSON.parse(r.text), { ok: true })
  assert.equal(r.sessionRef, U1)
  assert.deepEqual(r.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 })
  const [c] = t.calls()
  const a = c.argv
  assert.deepEqual(a.slice(0, 2), ['exec', '--json'])
  assert.equal(a.at(-1), '-')
  // 契約: アダプタはプロンプトを加工しない（シェルの注意は共通の前置き側）
  assert.equal(c.stdin, 'P')
  assert.ok(a.includes('--ignore-user-config'))
  assert.equal(argOf(a, '-m'), 'gpt-6.1-sol')
  assert.ok(a.includes('model_reasoning_effort="high"'))
  assert.equal(argOf(a, '-C'), t.mainRoot)
  assert.ok(existsSync(argOf(a, '--output-schema')))
  assert.ok(a.includes('--dangerously-bypass-hook-trust'))
  assert.equal(a.some((x) => x.startsWith('projects=')), false, '既定ではプロジェクトを trusted にしない')
  assert.equal(a.includes('resume'), false)
  const schemaFile = JSON.parse(readFileSync(argOf(a, '--output-schema'), 'utf8'))
  assert.equal(schemaFile.additionalProperties, false)
})

test('run: model が null なら -m を付けず、trustProject で inline の trust を付ける', async () => {
  const t = setup({ turns: [okTurn()], toolConfig: { trustProject: true } })
  await t.adapter.run(t.req({ model: null, effort: null }))
  const a = t.calls()[0].argv
  assert.equal(a.includes('-m'), false)
  assert.equal(a.some((x) => x.startsWith('model_reasoning_effort')), false)
  assert.ok(a.some((x) => x.startsWith('projects={') && x.includes('trust_level="trusted"')))
})

test('環境: TMPDIR・TMPPREFIX と GIT_CONFIG を渡す', async () => {
  const t = setup({ turns: [okTurn()] })
  await t.adapter.run(t.req())
  const { env } = t.calls()[0]
  assert.equal(env.TMPDIR, join(t.runDir, 'tmp'))
  // zsh の here-doc の一時ファイルを TMPDIR（両 profile で書ける）の下へ向ける
  assert.equal(env.TMPPREFIX, join(t.runDir, 'tmp', 'zsh'))
  assert.equal(env.GIT_CONFIG_KEY_0, 'branch.autoSetupMerge')
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false')
  assert.equal(env.GIT_CONFIG_COUNT, '1')
})

test('CODEX_HOME: 呼び出し元の環境変数 → 無ければ ~/.codex を start で 1 回解決し、exec・resume・delete に同じ値を渡す', async () => {
  const t = setup({ turns: [okTurn(), okTurn()], toolConfig: { deleteSessions: true } })
  const ch = join(t.root, 'caller-codex-home')
  const a = createAdapter({ skillDir: SKILL_DIR, mainRoot: t.mainRoot, runDir: t.runDir, toolConfig: { deleteSessions: true }, env: { ...t.env, CODEX_HOME: ch } })
  const r = await a.run(t.req())
  await a.run(t.req({ resume: { sessionRef: r.sessionRef, message: 'm' } }))
  await a.close()
  const cs = t.calls()
  assert.deepEqual(cs.map((c) => c.env?.CODEX_HOME ?? c.env), [ch, ch, ch])
  assert.equal(existsSync(ch), false, 'アダプタは CODEX_HOME を作らない')
  assert.equal(existsSync(join(t.runDir, 'codex-home')), false)
  // 未指定なら ~/.codex（HOME は偽ホーム）。ホームのファイルには何も書かない
  const t2 = setup({ turns: [okTurn()] })
  await t2.adapter.run(t2.req())
  assert.equal(t2.calls()[0].env.CODEX_HOME, join(t2.fakeHome, '.codex'))
  assert.equal(existsSync(join(t2.fakeHome, '.codex')), false)
  assert.deepEqual(readdirSync(t2.fakeHome), [])
  // toolConfig.codexHome が最優先
  const t3 = setup({ turns: [okTurn()], toolConfig: { codexHome: ch } })
  await t3.adapter.run(t3.req())
  assert.equal(t3.calls()[0].env.CODEX_HOME, ch)
})

test('環境: 既存の GIT_CONFIG_COUNT の続きの番号に足す', async () => {
  const t = setup({ turns: [okTurn()] })
  const a2 = createAdapter({ skillDir: SKILL_DIR, mainRoot: t.mainRoot, runDir: t.runDir, toolConfig: {}, env: { ...t.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x.y', GIT_CONFIG_VALUE_0: 'z' } })
  await a2.run(t.req())
  const { env } = t.calls()[0]
  assert.equal(env.GIT_CONFIG_COUNT, '2')
  assert.equal(env.GIT_CONFIG_KEY_0, 'x.y')
  assert.equal(env.GIT_CONFIG_KEY_1, 'branch.autoSetupMerge')
})

test('permission profile: 通常 cwd は read・req.worktreeGitdir があれば impl（gitdir の正確なパスと git の共有領域だけ書ける）', async () => {
  const t = setup({ turns: [okTurn(), okTurn()] })
  await t.adapter.run(t.req())
  const wt = join(t.mainRoot, '.claude', 'worktrees', 'wf_x-1')
  mkdirSync(wt, { recursive: true })
  const gitdir = join(t.mainRoot, '.git', 'worktrees', 'wf_x-1')
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
  await t.adapter.run(t.req({ name: 'a2', cwd: wt, worktreeGitdir: gitdir }))
  const [c1, c2] = t.calls()
  const prof = (c) => c.argv.find((x) => x.startsWith('permissions='))
  const read = prof(c1)
  assert.match(read, /^permissions=\{iit_read=\{extends=":read-only"/)
  assert.match(read, /":workspace_roots"=\{"\."="read"/)
  assert.equal(read.includes('objects'), false)
  // 状態ファイルの置き場は iit_read だけ書ける（state:load の初期化）。iit_impl には足さない
  const stateDir = JSON.stringify(join(t.mainRoot, '_', 'issue-trees'))
  assert.ok(read.includes(`${stateDir}="write"`), 'iit_read は <main>/_/issue-trees を書ける')
  assert.ok(c1.argv.includes('default_permissions="iit_read"'))
  const impl = prof(c2)
  assert.match(impl, /":workspace_roots"=\{"\."="write"/)
  assert.ok(impl.includes(`${JSON.stringify(gitdir)}="write"`))
  for (const p of ['objects', 'refs', 'logs', 'packed-refs', 'packed-refs.lock']) assert.ok(impl.includes(`${JSON.stringify(join(t.mainRoot, '.git', p))}="write"`), p)
  assert.equal(impl.includes(`${JSON.stringify(join(t.mainRoot, '.git'))}=`), false, '.git 全体は書き込み可にしない')
  assert.equal(impl.includes('.git/hooks'), false)
  assert.equal(impl.includes('.git/config'), false)
  assert.equal(impl.includes(stateDir), false, 'iit_impl に状態ファイルの置き場は足さない')
  for (const x of [read, impl]) {
    assert.ok(x.includes('".codex"="read"'))
    assert.ok(x.includes(`${JSON.stringify(join(t.fakeHome, '.codex', 'auth.json'))}="deny"`))
    assert.ok(x.includes('network={enabled=true}'))
  }
  assert.ok(c2.argv.includes('default_permissions="iit_impl"'))
  // CODEX_HOME が ~/.codex と別なら、両方の auth.json を deny する
  const a3 = createAdapter({ skillDir: SKILL_DIR, mainRoot: t.mainRoot, runDir: t.runDir, toolConfig: {}, env: { ...t.env, CODEX_HOME: join(t.root, 'ch') } })
  await a3.run(t.req({ name: 'a3' }))
  const p3 = prof(t.calls().at(-1))
  assert.ok(p3.includes(`${JSON.stringify(join(t.root, 'ch', 'auth.json'))}="deny"`))
  assert.ok(p3.includes(`${JSON.stringify(join(t.fakeHome, '.codex', 'auth.json'))}="deny"`))
  assert.equal(p3.split('"deny"').length - 1, 2)
  assert.equal(read.split('"deny"').length - 1, 1, 'CODEX_HOME が ~/.codex と同じなら deny は 1 つ')
})

test('buildProfileArgs: req.profile で上書きでき、extraWritePaths が加わる', () => {
  const a = buildProfileArgs({ kind: 'impl', cwd: '/w', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, extraWritePaths: ['/origin'] })
  assert.ok(a[1].includes('"/origin"="write"'))
})

test('buildProfileArgs: stateDir は iit_read のときだけ書き込みに加わり、メイン worktree 全体は読み取りのまま', () => {
  const base = { cwd: '/m', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, stateDir: '/m/_/issue-trees' }
  const read = buildProfileArgs({ ...base, kind: 'read' })[1]
  assert.ok(read.includes('"/m/_/issue-trees"="write"'))
  assert.ok(read.includes('":workspace_roots"={"."="read"'))
  assert.equal(read.includes('"/m"='), false)
  assert.equal(buildProfileArgs({ ...base, kind: 'impl' })[1].includes('issue-trees'), false)
  assert.equal(buildProfileArgs({ ...base, kind: 'read', stateDir: null })[1].includes('issue-trees'), false)
})

test('buildProfileArgs: darwin だけ両 profile に /private/var/tmp（bash 3.2 の here-doc の置き場）を足す', () => {
  assert.equal(DARWIN_HEREDOC_TMP, '/private/var/tmp')
  assert.deepEqual(platformWritePaths('darwin'), ['/private/var/tmp'])
  for (const p of ['linux', 'freebsd', 'win32', undefined]) assert.deepEqual(platformWritePaths(p), [], String(p))
  const base = { cwd: '/m', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, stateDir: '/m/_/issue-trees' }
  const vt = '"/private/var/tmp"="write"'
  for (const kind of ['read', 'impl']) {
    assert.ok(buildProfileArgs({ ...base, kind, platform: 'darwin' })[1].includes(vt), `darwin ${kind}`)
    const linux = buildProfileArgs({ ...base, kind, platform: 'linux' })[1]
    assert.equal(linux.includes('var/tmp'), false, `linux ${kind}`)
    // symlink の /var/tmp 自体は書き込み可にしない（実体のパスだけ）
    assert.equal(buildProfileArgs({ ...base, kind, platform: 'darwin' })[1].includes('"/var/tmp"'), false)
  }
})

test('permission profile: createAdapter の cfg.platform が buildProfileArgs まで届く（省略時は process.platform）', async () => {
  const t = setup({ turns: [okTurn(), okTurn(), okTurn()] })
  const prof = (c) => c.argv.find((x) => x.startsWith('permissions='))
  const mk = (platform) => createAdapter({ skillDir: SKILL_DIR, mainRoot: t.mainRoot, runDir: t.runDir, toolConfig: {}, env: t.env, ...(platform ? { platform } : {}) })
  await mk('darwin').run(t.req({ name: 'd' }))
  assert.ok(prof(t.calls().at(-1)).includes('"/private/var/tmp"="write"'))
  await mk('linux').run(t.req({ name: 'l' }))
  assert.equal(prof(t.calls().at(-1)).includes('var/tmp'), false)
  await mk(undefined).run(t.req({ name: 'x' }))
  assert.equal(prof(t.calls().at(-1)).includes('"/private/var/tmp"="write"'), process.platform === 'darwin')
})

// ---------------------------------------------------------------------------
// 最終応答・resume
// ---------------------------------------------------------------------------

test('-o が無ければ JSONL の最後の agent_message を使う・strict の応答は元の形へ戻す', async () => {
  const strictMsg = JSON.stringify({ ok: true, payload: [{ key: 'a', value: '1' }] })
  const t = setup({ turns: [okTurn({ message: strictMsg, noOutputFile: true })] })
  const r = await t.adapter.run(t.req({ schema: SCHEMA }))
  assert.deepEqual(JSON.parse(r.text), { ok: true, payload: { a: 1 } })
  assert.ok(readFileSync(join(t.runDir, 'agents', 'a1', 'final-t1.txt'), 'utf8').includes('"payload"'))
})

test('ログ: JSONL・stderr・最終テキスト・argv が logDir に残る', async () => {
  const t = setup({ turns: [okTurn()] })
  await t.adapter.run(t.req())
  const d = join(t.runDir, 'agents', 'a1')
  for (const f of ['events-t1.jsonl', 'stderr-t1.txt', 'final-t1.txt', 'argv-t1.json', 'hook.log']) assert.ok(existsSync(join(d, f)) || f === 'hook.log', f)
  assert.match(readFileSync(join(d, 'events-t1.jsonl'), 'utf8'), /thread\.started/)
})

test('resume: exec resume に同じ hook・profile を渡し、-C は付けず、セッション ID を末尾の前に置く', async () => {
  const t = setup({ turns: [okTurn(), okTurn({ message: '{"ok":false}' })] })
  const r1 = await t.adapter.run(t.req())
  const r2 = await t.adapter.run(t.req({ resume: { sessionRef: r1.sessionRef, message: '直せ' } }))
  assert.deepEqual(JSON.parse(r2.text), { ok: false })
  const [c1, c2] = t.calls()
  assert.deepEqual(c2.argv.slice(0, 3), ['exec', 'resume', '--json'])
  assert.equal(c2.argv.includes('-C'), false)
  assert.equal(c2.argv.at(-2), U1)
  assert.equal(c2.argv.at(-1), '-')
  assert.equal(c2.stdin, '直せ')
  assert.equal(c2.cwd, t.mainRoot)
  const pick = (c, p) => c.argv.find((x) => x.startsWith(p))
  assert.equal(pick(c2, 'hooks.PreToolUse='), pick(c1, 'hooks.PreToolUse='))
  assert.equal(pick(c2, 'permissions='), pick(c1, 'permissions='))
  assert.ok(c2.argv.includes('--dangerously-bypass-hook-trust'))
  assert.ok(existsSync(join(t.runDir, 'agents', 'a1', 'events-t2.jsonl')))
})

// ---------------------------------------------------------------------------
// 失敗の分類
// ---------------------------------------------------------------------------

const FAILS = [
  ['turn.failed は api', { fail: 'turn.failed' }, 'api'],
  ['turn.failed の UsageLimit は usage-limit', { fail: 'usage-limit' }, 'usage-limit'],
  ['error イベント + 非 0 終了は api', { fail: 'error-exit' }, 'api'],
  ['error イベントの UsageLimit + 非 0 終了は usage-limit', { fail: 'usage-limit-exit' }, 'usage-limit'],
  ['イベント無しの異常終了は exit', { fail: 'exit' }, 'exit'],
  ['最終応答が空は exit', { message: '', noOutputFile: false }, 'exit'],
]
for (const [name, turn, kind] of FAILS) {
  test(`失敗の分類: ${name}`, async () => {
    const t = setup({ turns: [okTurn(turn)] })
    await assert.rejects(t.adapter.run(t.req()), (e) => e instanceof AdapterError && e.kind === kind && (e.sessionRef === U1 || kind === 'exit'))
  })
}

test('失敗の分類: 終了コード 0 の error イベントだけでは失敗にしない（再接続の通知等）', () => {
  const s = summarizeEvents('{"type":"error","message":"Reconnecting... 1/5"}\n{"type":"turn.completed","usage":{}}\n')
  assert.equal(classifyFailure({ exitCode: 0, summary: s }), null)
  assert.equal(classifyFailure({ exitCode: 1, summary: s }).kind, 'api')
  assert.equal(classifyFailure({ exitCode: 1, summary: summarizeEvents('') }).kind, 'exit')
  assert.equal(classifyFailure({ timedOut: true, summary: s }).kind, 'timeout')
  assert.equal(classifyFailure({ spawnError: 'ENOENT', summary: s }).kind, 'exit')
})

test('失敗の分類: codex が無ければ run も prereq', async () => {
  const t = setup({ turns: [okTurn()] })
  await t.adapter.start()
  const t2 = setup({ turns: [okTurn()], toolConfig: { codexBin: join(t.root, 'gone') } })
  await rejectsKind(t2.adapter.run(t2.req()), 'prereq')
})

// ---------------------------------------------------------------------------
// ガード（hook）
// ---------------------------------------------------------------------------

const statuses = (t, name = 'a1', tag = 't1') =>
  readFileSync(join(t.runDir, 'agents', name, `events-${tag}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.type === 'item.completed' && e.item.type === 'command_execution').map((e) => [e.item.command, e.item.status])

test('hook: allowMerge=false ではマージ・承認が止まり、通常のコマンドは通る・全呼び出しがログに残る', async () => {
  const cmds = ['echo hi', MERGE_EXEC, 'gh pr merge 12 --squash', 'gh pr review 12 --approve']
  const t = setup({ turns: [okTurn({ toolCalls: cmds })] })
  await t.adapter.run(t.req())
  assert.deepEqual(statuses(t).map((x) => x[1]), ['completed', 'declined', 'declined', 'declined'])
  const lines = readFileSync(join(t.runDir, 'agents', 'a1', 'hook.log'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 4)
  assert.equal(lines.some((l) => l.includes('gh pr')), false, 'ログにコマンドを含めない')
})

test('hook: allowMerge=true は merge-exec の完全一致の 1 形だけを通す', async () => {
  const cmds = [MERGE_EXEC, `${MERGE_EXEC}; echo x`, `echo a; ${MERGE_EXEC}`, 'gh pr merge 12 --admin', 'gh pr review 12 --approve', `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --admin --delete-branch --match-head-commit "$HEAD_SHA"`]
  const t = setup({ turns: [okTurn({ toolCalls: cmds })] })
  await t.adapter.run(t.req({ allowMerge: true }))
  assert.deepEqual(statuses(t).map((x) => x[1]), ['completed', 'declined', 'declined', 'declined', 'declined', 'declined'])
})

test('hook: コマンド行は `|| exit 2` で終わり timeout を指定せず、allowMerge の有無で --merge-re が切り替わる', async () => {
  const t = setup({ turns: [okTurn(), okTurn()] })
  await t.adapter.run(t.req())
  await t.adapter.run(t.req({ name: 'a2', allowMerge: true }))
  const hookOf = (c) => c.argv.find((x) => x.startsWith('hooks.PreToolUse='))
  const [h1, h2] = t.calls().map(hookOf)
  for (const h of [h1, h2]) {
    assert.match(h, /\|\| exit 2"\}\]\}\]$/)
    assert.equal(h.includes('timeout'), false)
  }
  assert.equal(h1.includes('--merge-re'), false)
  assert.equal(h2.includes('--merge-re'), true)
})

test('hook の欠落: hook が呼ばれていない（ログの行数 < コマンド数）なら denied', async () => {
  const t = setup({ turns: [okTurn({ toolCalls: ['echo a', 'echo b'], skipHook: true })] })
  await assert.rejects(t.adapter.run(t.req()), (e) => e.kind === 'denied' && e.sessionRef === U1)
})

test('hook の欠落: resume の turn でもログの増分で数える（前の turn の行を数えない）', async () => {
  const t = setup({ turns: [okTurn({ toolCalls: ['echo a'] }), okTurn({ toolCalls: ['echo b'], skipHook: true })] })
  const r = await t.adapter.run(t.req())
  await assert.rejects(t.adapter.run(t.req({ resume: { sessionRef: r.sessionRef, message: 'm' } })), (e) => e.kind === 'denied')
})

// ---------------------------------------------------------------------------
// 時間切れ・close
// ---------------------------------------------------------------------------

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('時間切れ: SIGTERM を無視する子と孫のプロセスまで止まり、timeout になる', async () => {
  const t = setup({ turns: [okTurn({ hang: true, grandchild: join(tmpdir(), `iit-gc-${process.pid}`) })], toolConfig: { killGraceMs: 200 } })
  const pidFile = join(tmpdir(), `iit-gc-${process.pid}`)
  trackTmp(pidFile)
  await assert.rejects(t.adapter.run(t.req({ timeoutMs: 800 })), (e) => e.kind === 'timeout' && e.sessionRef === U1)
  const gc = Number(readFileSync(pidFile, 'utf8'))
  for (let i = 0; i < 30 && alive(gc); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(gc), false, '孫の sleep が残っていない')
})

test('close: deleteSessions=true のとき、このアダプタが作ったセッションだけを --force で削除する', async () => {
  const t = setup({ turns: [okTurn({ threadId: U1 }), okTurn({ threadId: U2 }), okTurn({ threadId: U2 })], toolConfig: { deleteSessions: true } })
  await t.adapter.run(t.req())
  await t.adapter.run(t.req({ name: 'a2' }))
  await t.adapter.run(t.req({ name: 'a2', resume: { sessionRef: U2, message: 'm' } }))
  const r = await t.adapter.close()
  assert.deepEqual([...r.deleted].sort(), [U1, U2])
  const dels = t.calls().filter((c) => c.delete)
  assert.deepEqual(dels.map((d) => d.delete).sort(), [U1, U2])
  assert.ok(dels.every((d) => d.force && d.env.CODEX_HOME === join(t.fakeHome, '.codex')))
})

test('close: deleteSessions=false なら削除しない・削除失敗は failed に載せて投げない・UUID 形でない ID は削除しない', async () => {
  const t = setup({ turns: [okTurn()] })
  await t.adapter.run(t.req())
  assert.deepEqual(await t.adapter.close(), { deleted: [], failed: [] })
  assert.equal(t.calls().some((c) => c.delete), false)

  const t2 = setup({ turns: [okTurn({ threadId: 'not-a-uuid; rm -rf /' })], toolConfig: { deleteSessions: true } })
  await assert.rejects(t2.adapter.run(t2.req()), (e) => e instanceof AdapterError)
  assert.deepEqual(await t2.adapter.close(), { deleted: [], failed: [] })
})

test('AdapterError: 未知の kind は拒否し、sessionRef を持てる', () => {
  assert.throws(() => new AdapterError('nope', 'x'), TypeError)
  const e = new AdapterError('api', 'm', { sessionRef: U1 })
  assert.equal(e.name, 'AdapterError')
  assert.equal(e.sessionRef, U1)
  assert.ok(e instanceof Error)
})

// ---------------------------------------------------------------------------
// HIGH-2（監査 e670648）: worktree の .git ファイルの中身で書き込み範囲が広がらない
// ---------------------------------------------------------------------------

test('HIGH-2: 細工した worktree の .git（gitdir: <任意パス>）を読んで書き込み範囲を広げない。gitdir は req.worktreeGitdir だけを使い resume でも読み直さない', async () => {
  const t = setup({ turns: [okTurn(), okTurn(), okTurn()] })
  const prof = (c) => c.argv.find((x) => x.startsWith('permissions='))
  const wt = join(t.mainRoot, '.claude', 'worktrees', 'wf_x-1')
  mkdirSync(wt, { recursive: true })
  const gitdir = join(t.mainRoot, '.git', 'worktrees', 'wf_x-1')
  mkdirSync(gitdir, { recursive: true })
  // 攻撃: .git を任意のパス（例: スキルの scripts/）へ向ける。2 つ上の objects 等も書けるようになっていた
  const evil = join(t.root, 'evil', 'a', 'b')
  writeFileSync(join(wt, '.git'), `gitdir: ${evil}\n`)
  // (1) req.worktreeGitdir 無し: .git を読まない。worktree でも書き込み範囲に evil 系のパスは入らない
  await t.adapter.run(t.req({ name: 'h2a', cwd: wt }))
  const p1 = prof(t.calls().at(-1))
  assert.equal(p1.includes(join(t.root, 'evil')), false, '.git の中身のパスを書き込み可にしない')
  assert.ok(t.calls().at(-1).argv.includes('default_permissions="iit_read"'), 'worktreeGitdir が無ければ impl にしない')
  // (2) req.worktreeGitdir あり: その値だけを使う。resume の前に .git を書き換えても変わらない
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
  const r = await t.adapter.run(t.req({ name: 'h2b', cwd: wt, worktreeGitdir: gitdir }))
  writeFileSync(join(wt, '.git'), `gitdir: ${evil}\n`)
  await t.adapter.run(t.req({ name: 'h2b', cwd: wt, worktreeGitdir: gitdir, resume: { sessionRef: r.sessionRef, message: 'm' } }))
  for (const c of t.calls().slice(-2)) {
    const p = prof(c)
    assert.ok(p.includes(`${JSON.stringify(gitdir)}="write"`))
    assert.equal(p.includes(join(t.root, 'evil')), false, 'resume でも .git を読み直さない')
    assert.ok(c.argv.includes('default_permissions="iit_impl"'))
  }
})

test('HIGH-2: req.worktreeGitdir がメインの .git/worktrees/ の直下でなければ実行しない（denied）', async () => {
  const t = setup({ turns: [okTurn()] })
  for (const bad of [join(t.root, 'evil'), join(t.mainRoot, '.git'), join(t.mainRoot, '.git', 'worktrees'), join(t.mainRoot, '.git', 'worktrees', 'a', 'b'), 'rel/x', `${join(t.mainRoot, '.git', 'worktrees', 'a')}/..`]) {
    await rejectsKind(t.adapter.run(t.req({ name: 'h2c', worktreeGitdir: bad })), 'denied')
  }
  assert.equal(t.calls().length, 0, 'codex を起動しない')
})

// ---------------------------------------------------------------------------
// HIGH-1（監査 e670648）: gitdir を write にしても commondir 等の書き換えで sandbox を抜けられない
// ---------------------------------------------------------------------------

test('HIGH-1: iit_impl は gitdir を write にしたうえで commondir・gitdir・config.worktree と worktree の .git を read に戻す', () => {
  const git = { gitdir: '/m/.git/worktrees/w1', commonDir: '/m/.git' }
  const p = buildProfileArgs({ kind: 'impl', cwd: '/m/.claude/worktrees/w1', codexHome: '/c', tmpDir: '/t', home: '/h', git, platform: 'linux' })[1]
  assert.ok(p.includes('"/m/.git/worktrees/w1"="write"'))
  for (const f of ['commondir', 'gitdir', 'config.worktree']) assert.ok(p.includes(`"/m/.git/worktrees/w1/${f}"="read"`), f)
  assert.ok(p.includes('"/m/.claude/worktrees/w1/.git"="read"'))
  // 書き込みの必要なもの（index・HEAD・logs・rebase-merge/ 等）は列挙せず、gitdir 全体の write に任せる
  assert.equal(/"\/m\/\.git\/worktrees\/w1\/(index|HEAD|logs)"=/.test(p), false)
  // read の profile と git の無い impl には足さない
  const r = buildProfileArgs({ kind: 'read', cwd: '/m', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, platform: 'linux' })[1]
  assert.equal(r.includes('commondir'), false)
  assert.equal(buildProfileArgs({ kind: 'impl', cwd: '/w', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, platform: 'linux' })[1].includes('commondir'), false)
})

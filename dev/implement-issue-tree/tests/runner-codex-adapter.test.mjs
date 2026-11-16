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
import { createAdapter, buildProfileArgs, classifyFailure, summarizeEvents, DARWIN_HEREDOC_TMP, platformWritePaths, stdinWritesOf, blankJsStrings, findRollouts } from '../../../skills/implement-issue-tree/runner/adapters/codex.mjs'
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
  assert.equal(env.TMPDIR, join(t.runDir, 'tmp', 'a1'))
  // zsh の here-doc の一時ファイルを TMPDIR（両 profile で書ける）の下へ向ける
  assert.equal(env.TMPPREFIX, join(t.runDir, 'tmp', 'a1', 'zsh'))
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
  // CODEX_HOME の下にあるのは（偽）codex 自身が書くセッションの記録だけで、アダプタは何も作らない
  assert.deepEqual(readdirSync(ch), ['sessions'], 'アダプタは CODEX_HOME に何も作らない')
  assert.equal(existsSync(join(t.runDir, 'codex-home')), false)
  // 未指定なら ~/.codex（HOME は偽ホーム）。ホームのファイルには何も書かない
  const t2 = setup({ turns: [okTurn()] })
  await t2.adapter.run(t2.req())
  assert.equal(t2.calls()[0].env.CODEX_HOME, join(t2.fakeHome, '.codex'))
  assert.deepEqual(readdirSync(t2.fakeHome), ['.codex'])
  assert.deepEqual(readdirSync(join(t2.fakeHome, '.codex')), ['sessions'])
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
  // 状態ファイルの置き場は常時 write にしない（MEDIUM-4。state:load だけ agent-host が req.writablePaths で渡す）
  const stateDir = JSON.stringify(join(t.mainRoot, '_', 'issue-trees'))
  assert.equal(read.includes(stateDir), false, 'iit_read でも <main>/_/issue-trees を常時は書けない')
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
  // 認証ファイルの deny に加え、<runDir>/tmp の deny が 1 つある（LOW-13）
  assert.equal(p3.split('"deny"').length - 1, 3)
  assert.equal(read.split('"deny"').length - 1, 2, 'CODEX_HOME が ~/.codex と同じなら認証ファイルの deny は 1 つ（+ tmp の deny）')
})

test('buildProfileArgs: req.profile で上書きでき、extraWritePaths が加わる', () => {
  const a = buildProfileArgs({ kind: 'impl', cwd: '/w', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, extraWritePaths: ['/origin'] })
  assert.ok(a[1].includes('"/origin"="write"'))
})

test('buildProfileArgs: writablePaths だけが追加の書き込み可になり、メイン worktree 全体は読み取りのまま（MEDIUM-4）', () => {
  const base = { cwd: '/m', codexHome: '/c', tmpDir: '/t', home: '/h', git: null }
  const read = buildProfileArgs({ ...base, kind: 'read', writablePaths: ['/m/_/issue-trees'] })[1]
  assert.ok(read.includes('"/m/_/issue-trees"="write"'))
  assert.ok(read.includes('":workspace_roots"={"."="read"'))
  assert.equal(read.includes('"/m"='), false)
  assert.equal(buildProfileArgs({ ...base, kind: 'read' })[1].includes('issue-trees'), false, '既定では足さない')
  assert.equal(buildProfileArgs({ ...base, kind: 'read', writablePaths: [] })[1].includes('issue-trees'), false)
})

test('writablePaths（MEDIUM-4）: agent-host の state:load（とフォールバック）だけ iit_read に <main>/_/issue-trees の write が入る（27c90eb の初期化の経路）。不正な値は denied', async () => {
  const t = setup({ turns: [okTurn(), okTurn(), okTurn(), okTurn()] })
  const prof = (c) => c.argv.find((x) => x.startsWith('permissions='))
  const sd = join(t.mainRoot, '_', 'issue-trees')
  const { createAgentHost } = await import('../../../skills/implement-issue-tree/runner/lib/agent-host.mjs')
  const { loadConfig } = await import('../../../skills/implement-issue-tree/runner/lib/models.mjs')
  const host = createAgentHost({ adapter: t.adapter, cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot: t.mainRoot, runId: 'wf_0123abcd-4ef', runDir: t.runDir } })
  const S = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  for (const label of ['state:load', 'state:load:fallback-sonnet', 'state:load-fill', 'plan:issue-tree']) await host('p', { label, schema: S })
  const ps = t.calls().map(prof)
  assert.equal(ps.length, 4)
  assert.ok(ps[0].includes(`${JSON.stringify(sd)}="write"`), 'state:load')
  assert.ok(ps[1].includes(`${JSON.stringify(sd)}="write"`), 'state:load:fallback-sonnet')
  assert.equal(ps[2].includes('issue-trees'), false, 'state:load-fill')
  assert.equal(ps[3].includes('issue-trees'), false, 'plan:issue-tree')
  for (const bad of [['rel/x'], ['/a/../b'], [1], 'x']) await rejectsKind(t.adapter.run(t.req({ name: 'wp', writablePaths: bad })), 'denied')
})

test('buildProfileArgs: darwin だけ両 profile に /private/var/tmp（bash 3.2 の here-doc の置き場）を足す', () => {
  assert.equal(DARWIN_HEREDOC_TMP, '/private/var/tmp')
  assert.deepEqual(platformWritePaths('darwin'), ['/private/var/tmp'])
  for (const p of ['linux', 'freebsd', 'win32', undefined]) assert.deepEqual(platformWritePaths(p), [], String(p))
  const base = { cwd: '/m', codexHome: '/c', tmpDir: '/t', home: '/h', git: null }
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
  await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 12, repo: 'acme/widget' } }))
  assert.deepEqual(statuses(t).map((x) => x[1]), ['completed', 'declined', 'declined', 'declined', 'declined', 'declined'])
})

test('hook（MEDIUM-8）: 許す形は req.merge の PR 番号だけ（別の PR 番号の完全一致の形は止める）。merge 段の子の env に GH_REPO を固定する', async () => {
  const other = MERGE_EXEC.replace('gh pr merge 12 ', 'gh pr merge 13 ')
  const t = setup({ turns: [okTurn({ toolCalls: [MERGE_EXEC, other] }), okTurn({ toolCalls: [MERGE_EXEC] })] })
  await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 12, repo: 'acme/widget' } }))
  assert.deepEqual(statuses(t).map((x) => x[1]), ['completed', 'declined'], 'PR 13 の形は通さない')
  const [c1] = t.calls()
  assert.equal(c1.env.GH_REPO, 'acme/widget')
  const hook = c1.argv.find((x) => x.startsWith('hooks.PreToolUse='))
  assert.ok(hook.includes('gh pr merge 12 --squash'), hook)
  // allowMerge でも merge が無ければ --merge-re を出さない（汎用の形へ倒さない）。GH_REPO も足さない
  await t.adapter.run(t.req({ name: 'a2', allowMerge: true }))
  assert.deepEqual(statuses(t, 'a2').map((x) => x[1]), ['declined'])
  const c2 = t.calls()[1]
  assert.equal(c2.argv.find((x) => x.startsWith('hooks.PreToolUse=')).includes('--merge-re'), false)
  assert.equal(c2.env.GH_REPO, null)
})

test('merge（MEDIUM-8）: 形の不正な req.merge は denied で codex を起動しない。allowMerge でない段では merge を使わない', async () => {
  const t = setup({ turns: [okTurn()] })
  for (const merge of [{ prNumber: 0, repo: 'a/b' }, { prNumber: 1.5, repo: 'a/b' }, { prNumber: '12', repo: 'a/b' }, { prNumber: 12, repo: 'a' }, { prNumber: 12, repo: 'a/b c' }, { prNumber: 12, repo: '-a/b' }, { prNumber: 12, repo: 'a/..' }, 'x']) {
    await rejectsKind(t.adapter.run(t.req({ name: 'bad', allowMerge: true, merge })), 'denied')
  }
  assert.equal(t.calls().length, 0)
  await t.adapter.run(t.req({ name: 'nm', merge: { prNumber: 12, repo: 'acme/widget' } }))
  const c = t.calls()[0]
  assert.equal(c.argv.find((x) => x.startsWith('hooks.PreToolUse=')).includes('--merge-re'), false)
  assert.equal(c.env.GH_REPO, null)
})

test('hook: コマンド行は `|| exit 2` で終わり timeout を指定せず、allowMerge の有無で --merge-re が切り替わる', async () => {
  const t = setup({ turns: [okTurn(), okTurn()] })
  await t.adapter.run(t.req())
  await t.adapter.run(t.req({ name: 'a2', allowMerge: true, merge: { prNumber: 12, repo: 'acme/widget' } }))
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

test('TMPDIR（LOW-13）: エージェントごとに <runDir>/tmp/<logDir の名前>。profile もその場所だけを書け、修復ターン（同じ logDir）は同じ場所を使う', async () => {
  const t = setup({ turns: [okTurn(), okTurn(), okTurn()] })
  const r1 = await t.adapter.run(t.req({ name: '0001-plan_2' }))
  await t.adapter.run(t.req({ name: '0002-impl_2' }))
  await t.adapter.run(t.req({ name: '0001-plan_2', resume: { sessionRef: r1.sessionRef, message: 'fix' } }))
  const [a, b, a2] = t.calls()
  const ta = join(t.runDir, 'tmp', '0001-plan_2')
  const tb = join(t.runDir, 'tmp', '0002-impl_2')
  assert.equal(a.env.TMPDIR, ta)
  assert.equal(b.env.TMPDIR, tb)
  assert.equal(a2.env.TMPDIR, ta, '修復ターンは同じ TMPDIR')
  assert.equal(b.env.TMPPREFIX, join(tb, 'zsh'))
  const prof = (c) => c.argv.find((x) => x.startsWith('permissions='))
  assert.ok(prof(a).includes(`${JSON.stringify(ta)}="write"`))
  assert.equal(prof(a).includes(JSON.stringify(tb)), false, '他のエージェントの TMPDIR は書けない')
  // ラン全体の tmp は deny（他のエージェントの TMPDIR を読めない）。自分の分だけより具体的な write で開ける
  assert.ok(prof(a).includes(`${JSON.stringify(join(t.runDir, 'tmp'))}="deny"`), 'ラン全体の tmp は deny')
  assert.ok(existsSync(ta) && existsSync(tb))
})

test('buildProfileArgs（LOW-13）: tmpRoot を渡すと deny にし、自分の tmpDir は write のまま。渡さなければ足さない', () => {
  for (const kind of ['read', 'impl']) {
    const r = buildProfileArgs({ kind, cwd: '/w', codexHome: '/c', tmpDir: '/r/tmp/a', tmpRoot: '/r/tmp', home: '/h', git: null, platform: 'linux' })[1]
    assert.ok(r.includes('"/r/tmp"="deny"'), kind)
    assert.ok(r.includes('"/r/tmp/a"="write"'), kind)
    assert.ok(r.indexOf('"/r/tmp"="deny"') < r.indexOf('"/r/tmp/a"="write"'), `${kind}: deny を先に書く（実測と同じ並び）`)
  }
  const none = buildProfileArgs({ kind: 'read', cwd: '/w', codexHome: '/c', tmpDir: '/t', home: '/h', git: null, platform: 'linux' })[1]
  assert.equal(none.split('="deny"').length - 1, 2, 'tmpRoot 無しなら deny は認証ファイル 2 件だけ')
})

test('killSync（LOW-11）: 実行中の codex のプロセスグループ（孫まで）を同期で SIGKILL する', async () => {
  const pidFile = join(tmpdir(), `iit-gc-ks-${process.pid}`)
  trackTmp(pidFile)
  const t = setup({ turns: [okTurn({ hang: true, grandchild: pidFile })] })
  assert.equal(typeof t.adapter.killSync, 'function')
  const p = t.adapter.run(t.req({ timeoutMs: 60000 }))
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100))
  const gc = Number(readFileSync(pidFile, 'utf8'))
  t.adapter.killSync()
  await assert.rejects(p)
  for (let i = 0; i < 30 && alive(gc); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(alive(gc), false, '孫の sleep が残っていない')
})

// ---------------------------------------------------------------------------
// MEDIUM-5（監査 e670648）: write_stdin の事後検知
// 記録の形は 2026-11-17 の codex-cli 0.169.0・gpt-6.1-sol の 1 回の実測（code mode の custom_tool_call "exec"）を手で組んだもの
// ---------------------------------------------------------------------------

const rollout = (id, items) => [{ type: 'session_meta', payload: { id } }, ...items.map((payload) => ({ type: 'response_item', payload }))].map((l) => JSON.stringify(l)).join('\n')
const exec = (input) => ({ type: 'custom_tool_call', name: 'exec', call_id: 'c', input })

test('MEDIUM-5 stdinWritesOf: 実測の形。空の chars（poll）は数えず、空でない chars を数える', () => {
  const r = stdinWritesOf(rollout(U1, [
    exec('text(await tools.exec_command({cmd:"bash --noprofile --norc -i",tty:true}));\n'),
    exec('text(await tools.write_stdin({session_id:42023,chars:"",yield_time_ms:1000}));\n'),
    exec('text(await tools.write_stdin({session_id:42023,chars:"echo IIT > /tmp/m\\n"}));\n'),
    exec('text(await tools.write_stdin({session_id:42023,chars:"exit\\n"}));\n'),
  ]))
  assert.deepEqual(r, { writes: 2, sessionIds: [U1], badLines: 0 })
})

test('MEDIUM-5 stdinWritesOf: 直接の function_call（arguments は JSON 文字列・オブジェクト）も同じ規則で数える', () => {
  const fc = (args) => ({ type: 'function_call', name: 'write_stdin', call_id: 'c', arguments: args })
  assert.equal(stdinWritesOf(rollout(U1, [fc('{"session_id":1,"chars":""}'), fc({ session_id: 1 })])).writes, 0)
  assert.equal(stdinWritesOf(rollout(U1, [fc('{"session_id":1,"chars":"ls\\n"}')])).writes, 1)
  assert.equal(stdinWritesOf(rollout(U1, [fc('{not json')])).writes, 1, '解釈できない引数は数える')
  assert.equal(stdinWritesOf(rollout(U1, [fc({ session_id: 1, chars: 5 })])).writes, 1)
  assert.equal(stdinWritesOf(rollout(U1, [{ ...fc('{"chars":"x"}'), name: 'functions.write_stdin' }])).writes, 1)
})

test('MEDIUM-5 stdinWritesOf: tools の別名・計算されたプロパティ・式の引数は解釈できないとして数える。文字列とコメントの中の語は数えない', () => {
  const w = (input) => stdinWritesOf(rollout(U1, [exec(input)])).writes
  for (const input of [
    'const t = tools; await t.write_stdin({session_id:1,chars:"x"})',
    'await tools["write_stdin"]({session_id:1,chars:"x"})',
    'const { write_stdin } = tools; await write_stdin({session_id:1,chars:""})',
    'await tools.write_stdin({session_id:1,chars:c})',
    'await tools.write_stdin({session_id:1,chars:"" + "x"})',
    'await tools.write_stdin({session_id:1,chars:`${x}`})',
    'await tools.write_stdin(args)',
    'const f = tools.write_stdin; await f({session_id:1,chars:"x"})',
  ]) assert.ok(w(input) >= 1, input)
  for (const input of [
    'text(await tools.exec_command({cmd:"ls dev/tools && grep -n write_stdin README.md"}))',
    '// tools[x] と write_stdin はコメント\ntext(await tools.exec_command({cmd:\'echo "tools"\'}))',
    'await tools.write_stdin({ "session_id": 7, "chars": \'\', max_output_tokens: 100, })',
  ]) assert.equal(w(input), 0, input)
  // 名前が exec でない custom_tool_call（apply_patch 等の本文）は見ない
  assert.equal(stdinWritesOf(rollout(U1, [{ type: 'custom_tool_call', name: 'apply_patch', input: 'tools.write_stdin({session_id:1,chars:"x"})' }])).writes, 0)
  // 利用者メッセージの本文は見ない
  assert.equal(stdinWritesOf(rollout(U1, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tools.write_stdin({session_id:1,chars:"x"})' }] }])).writes, 0)
  assert.equal(stdinWritesOf('{"type":"session_meta","payload":{"id":"x"}}\n{broken').badLines, 1)
})

test('MEDIUM-5 stdinWritesOf: 引用符を含む正規表現リテラルで文字列の境界をずらしても、直接の tools.write_stdin は数える', () => {
  const w = (input) => stdinWritesOf(rollout(U1, [exec(input)])).writes
  for (const input of [
    '/"/; await tools.write_stdin({session_id:1,chars:\'gh pr merge 5 --admin\\n\'}); /"/',
    "/'/.test(a); await tools.write_stdin({session_id:1,chars:\"x\"}); /'/",
    '/`/; await tools . write_stdin ( {session_id:1,chars:c} ); /`/',
  ]) assert.ok(w(input) >= 1, input)
  // 同じずらしでも、空の poll だけなら数えない
  assert.equal(w('/"/; await tools.write_stdin({session_id:1,chars:""}); /"/'), 0)
})

test('MEDIUM-5 blankJsStrings: 長さを保って文字列とコメントの中身だけを消す。${} を含むテンプレートは残す', () => {
  const s = 'a("tools\\"x") /* tools */ b(`t${tools}`) // tools'
  const b = blankJsStrings(s)
  assert.equal(b.length, s.length)
  assert.equal((b.match(/tools/g) ?? []).length, 1)
  assert.match(b, /`t\$\{tools\}`/)
})

test('MEDIUM-5: 空でない write_stdin のあるターンは denied（出力を返さない）。空の poll だけなら通る', async () => {
  const t = setup({ turns: [okTurn({ codeMode: ['text(await tools.write_stdin({session_id:3,chars:"gh pr merge 5 --admin\\n"}));'] })] })
  await rejectsKind(t.adapter.run(t.req()), 'denied')
  assert.match(readFileSync(join(t.runDir, 'agents', 'a1', 'stdin-check-t1.txt'), 'utf8'), /write_stdin が 1 件/)
  const t2 = setup({ turns: [okTurn({ codeMode: ['text(await tools.exec_command({cmd:"bash -i",tty:true}));', 'text(await tools.write_stdin({session_id:3,chars:""}));'] })] })
  assert.equal((await t2.adapter.run(t2.req())).text, '{"ok":true}')
})

test('MEDIUM-5: resume のターンでも同じ記録（追記）を見て、前のターンの分を含めて検知する', async () => {
  const t = setup({ turns: [okTurn(), okTurn({ codeMode: ['await tools.write_stdin({session_id:1,chars:"x"})'] })] })
  const r = await t.adapter.run(t.req())
  await assert.rejects(t.adapter.run(t.req({ resume: { sessionRef: r.sessionRef, message: 'm' } })), (e) => e.kind === 'denied' && e.sessionRef === U1)
})

test('MEDIUM-5: 記録が無い・2 つある・session_meta の id が違う場合は denied（fail-closed）', async () => {
  for (const over of [{ noRollout: true }, { extraRollout: true }, { rolloutId: U2 }]) {
    const t = setup({ turns: [okTurn(over)] })
    await rejectsKind(t.adapter.run(t.req()), 'denied')
  }
})

test('MEDIUM-5 findRollouts: 名前の -<id>.jsonl だけで探し、symlink は除く', async () => {
  const t = setup({ turns: [okTurn()] })
  await t.adapter.run(t.req())
  const home = join(t.fakeHome, '.codex')
  assert.equal(findRollouts(home, U1).length, 1)
  assert.deepEqual(findRollouts(home, U2), [])
  const { symlinkSync } = await import('node:fs')
  symlinkSync(findRollouts(home, U1)[0], join(home, 'sessions', `rollout-x-${U2}.jsonl`))
  assert.deepEqual(findRollouts(home, U2), [], 'symlink は記録として読まない')
  assert.deepEqual(findRollouts(join(t.root, 'none'), U1), [])
})

// ---------------------------------------------------------------------------
// write_stdin の事前の封じ（PR #851 の P0。codex-cli 0.169.0 の実測: hook の入力は tool_input.command だけで tty が見えず、
// write_stdin では PreToolUse が呼ばれない。tty の無いセッションの stdin は閉じていて write_stdin が失敗し、
// features.unified_exec_tty=false で exec_command の tty:true が「TTY execution is disabled by config」で拒否される）
// ---------------------------------------------------------------------------

test('P0 write_stdin: exec にも resume にも -c features.unified_exec_tty=false を渡す（hook の前に置く）', async () => {
  const t = setup({ turns: [okTurn(), okTurn()] })
  const r = await t.adapter.run(t.req())
  await t.adapter.run(t.req({ resume: { sessionRef: r.sessionRef, message: 'm' } }))
  for (const c of t.calls()) {
    const i = c.argv.indexOf('features.unified_exec_tty=false')
    assert.ok(i > 0 && c.argv[i - 1] === '-c', c.argv.join(' '))
    assert.ok(i < c.argv.findIndex((x) => x.startsWith('hooks.PreToolUse=')))
  }
})

test('P0 write_stdin: start は同じ CODEX_HOME と -c で `codex features list` を読み、unified_exec_tty が false でなければ prereq で止める', async () => {
  const ok = setup({ turns: [okTurn()] })
  await ok.adapter.start()
  const fl = readFileSync(`${join(ok.root, 'fake.log')}.features`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(fl.length, 1)
  assert.deepEqual(fl[0].argv, ['features', 'list', '-c', 'features.unified_exec_tty=false'])
  assert.equal(fl[0].env.CODEX_HOME, join(ok.fakeHome, '.codex'))
  for (const mode of ['tty-forced', 'no-line', 'fail']) {
    const t = setup({ turns: [okTurn()] })
    const a = createAdapter({ skillDir: SKILL_DIR, mainRoot: t.mainRoot, runDir: t.runDir, toolConfig: {}, env: { ...t.env, FAKE_CODEX_FEATURES: mode } })
    const e = await a.start().then(() => null, (err) => err)
    assert.equal(e?.kind, 'prereq', mode)
    assert.match(e.message, /unified_exec_tty/, mode)
    // 確かめられない環境では codex exec を 1 度も起動しない
    await assert.rejects(a.run(t.req()), (err) => err.kind === 'prereq')
    assert.equal(t.calls().length, 0, mode)
  }
})

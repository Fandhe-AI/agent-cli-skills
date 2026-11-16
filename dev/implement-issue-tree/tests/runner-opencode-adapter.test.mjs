// ランナーの OpenCode アダプタ（runner/adapters/opencode.mjs）の回帰テスト。
// 実の opencode は起動せず、偽 serve（lib/fake-opencode-server.mjs）を起動コマンドとして差し替える。
// 確かめること: 渡す設定（allow-all が無い・deny が入る・allowMerge で merge-exec 用だけ外れる）、SSE での完了、
// SSE の取りこぼし時の突き合わせ、修復ターン（同じセッションへ追記）、ask → denied、時間切れ → interrupt、
// 失敗の分類、close が自分のセッションだけを消し自分の serve だけを止めること。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { MERGE_RES, createAdapter } from '../../../skills/implement-issue-tree/runner/adapters/opencode.mjs'
import { AdapterError } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { MERGE_EXEC_COMMAND, codexRules, opencodeRules } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'

const PLUGIN_DIR = join(SKILL_DIR, 'runner', 'adapters', 'opencode-plugin')
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'fake-opencode-server.mjs')

function setup(extra = {}) {
  const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-oc-adapter-'))))
  const mainRoot = join(root, 'main')
  const runDir = join(root, 'run')
  mkdirSync(mainRoot, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  const log = join(root, 'fake.log')
  const adapter = createAdapter({
    skillDir: SKILL_DIR,
    mainRoot,
    runDir,
    toolConfig: { command: [process.execPath, FAKE], pollMs: 20, startTimeoutMs: 10000, deleteSessions: true, ...extra.toolConfig },
    guard: { codexRules, opencodeRules },
    env: { ...process.env, FAKE_OC_LOG: log, ...extra.env },
  })
  let n = 0
  const req = (over = {}) => {
    n += 1
    const logDir = join(root, `agent-${n}`)
    return { prompt: 'hello', schema: {}, model: null, effort: null, cwd: mainRoot, label: `t${n}`, allowMerge: false, timeoutMs: 10000, resume: null, logDir, ...over }
  }
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { root, mainRoot, runDir, adapter, req, records }
}

const starts = (recs) => recs.filter((r) => r.ev === 'start')
const kindOf = async (p) => { try { await p } catch (e) { return e } throw new Error('失敗するはずが成功した') }

test('設定: allow-all が無く、deny と plugin が入る。allowMerge の run だけ別の serve で merge の deny が外れる', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    let recs = starts(t.records())
    assert.equal(recs.length, 1, 'start では通常用の serve だけ')
    const cfg = recs[0].config
    assert.ok(recs[0].hasPassword)
    assert.equal(JSON.stringify(cfg).includes('"effect":"allow"'), false, 'allow を含まない')
    assert.equal(cfg.permissions.some((r) => r.action === '*'), false)
    assert.ok(cfg.permissions.some((r) => r.effect === 'deny' && r.resource === 'gh pr merge*'))
    assert.ok(cfg.policies.some((r) => r.action === 'tool.use' && r.resource === 'shell:gh pr merge*'))
    assert.equal(cfg.plugins.length, 1)
    const o = cfg.plugins[0].options
    assert.equal(cfg.plugins[0].package, PLUGIN_DIR, 'ランナー専用 plugin（配布物の plugin ではない）')
    assert.ok(existsSync(join(cfg.plugins[0].package, 'index.js')))
    assert.deepEqual(o.mergeRes, [], '通常用は merge の素通しを持たない')
    assert.ok(existsSync(o.guardScript) && /agent-guard\.sh$/.test(o.guardScript))
    assert.match(o.nonce, /^[0-9a-f]{32}$/)
    assert.equal(readFileSync(o.markerPath, 'utf8'), o.nonce, 'plugin が目印を書いた')

    await t.adapter.run(t.req())
    assert.equal(starts(t.records()).length, 1, 'allowMerge でない run では merge 用 serve を起動しない')

    await t.adapter.run(t.req({ allowMerge: true }))
    recs = starts(t.records())
    assert.equal(recs.length, 2)
    const [normal, merge] = recs
    assert.notEqual(normal.port, merge.port)
    assert.equal(merge.config.permissions.some((r) => r.resource === 'gh pr merge*'), false, 'merge 用は gh pr merge の deny が無い')
    assert.equal(merge.config.policies.some((r) => r.resource === 'shell:gh pr merge*'), false)
    assert.ok(merge.config.permissions.some((r) => /gh pr review\*--approve/.test(r.resource)), '承認の deny は残る')
    assert.ok(merge.config.permissions.some((r) => r.resource.includes('--admin')), '--admin の deny は残る')
    assert.equal(JSON.stringify(merge.config).includes('"effect":"allow"'), false)
    assert.deepEqual(merge.config.plugins[0].options.mergeRes, MERGE_RES, 'merge 用だけ MERGE_EXEC_COMMAND を素通しにする')
    assert.deepEqual(MERGE_RES, [MERGE_EXEC_COMMAND.source], '完全一致の 1 形だけ（Codex の --merge-re と同じ）')
    assert.notEqual(merge.config.plugins[0].options.nonce, o.nonce, 'serve ごとに別の nonce')
  } finally { await t.adapter.close() }
})

test('セッション: 親セッションは作らない。model は Ref になり、model が null なら model も variant も送らずログに残す', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    await t.adapter.run(t.req({ model: 'prov/some/model-x', effort: 'low' }))
    const r2 = t.req({ allowMerge: true, model: null, effort: 'low' })
    await t.adapter.run(r2)
    const posts = t.records().filter((r) => r.ev === 'http' && r.method === 'POST' && r.path === '/api/session')
    const child = posts.find((r) => r.body.title === 't1')
    const noModel = posts.find((r) => r.body.title === 't2')
    assert.equal(posts.some((r) => r.body.parentID), false, 'parentID を使わない')
    assert.deepEqual(child.body.model, { providerID: 'prov', id: 'some/model-x', variant: 'low' })
    assert.equal('model' in noModel.body, false)
    assert.match(readFileSync(join(r2.logDir, 'adapter.log'), 'utf8'), /model 未指定/)
    assert.equal(posts.some((r) => 'permissions' in r.body), false, 'セッションに permissions（allow-all）を付けない')
  } finally { await t.adapter.close() }
})

test('toolConfig.defaultModel があれば model が null のときに使う', async () => {
  const t = setup({ toolConfig: { defaultModel: 'bifrost/qwen' } })
  await t.adapter.start()
  try {
    await t.adapter.run(t.req({ effort: 'medium' }))
    const post = t.records().find((r) => r.ev === 'http' && r.method === 'POST' && r.path === '/api/session' && r.body.title === 't1')
    assert.deepEqual(post.body.model, { providerID: 'bifrost', id: 'qwen', variant: 'medium' })
  } finally { await t.adapter.close() }
})

test('SSE の完了で最終テキスト・sessionRef・usage を返し、ログを logDir へ書く', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const r = t.req({ prompt: 'first line\nsecond' })
    const out = await t.adapter.run(r)
    assert.equal(out.text, 'reply-1:first line')
    assert.match(out.sessionRef, /^ses_/)
    assert.deepEqual(out.usage, { input: 10, cached: 5, output: 2, reasoning: 0 })
    assert.equal(readFileSync(join(r.logDir, 'final.txt'), 'utf8'), 'reply-1:first line')
    const ev = readFileSync(join(r.logDir, 'events.jsonl'), 'utf8')
    assert.match(ev, /session\.execution\.succeeded/)
  } finally { await t.adapter.close() }
})

test('SSE の終端イベントを取りこぼしても、active と idle の突き合わせで完了を検知する', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const out = await t.adapter.run(t.req({ prompt: '[[NOSSE]] x' }))
    assert.equal(out.text, 'reply-1:[[NOSSE]] x')
  } finally { await t.adapter.close() }
})

test('修復ターンは同じセッションへ追記する（セッションを作り直さない）', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const first = await t.adapter.run(t.req({ prompt: 'p1' }))
    const second = await t.adapter.run(t.req({ resume: { sessionRef: first.sessionRef, message: 'fix it' } }))
    assert.equal(second.sessionRef, first.sessionRef)
    assert.equal(second.text, 'reply-2:fix it')
    const recs = t.records().filter((r) => r.ev === 'http')
    assert.equal(recs.filter((r) => r.method === 'POST' && r.path === '/api/session' && r.body.title !== 'iit-runner:parent').length, 1)
    assert.equal(recs.filter((r) => r.path === `/api/session/${first.sessionRef}/prompt`).length, 2)
    const e = await kindOf(t.adapter.run(t.req({ resume: { sessionRef: 'ses_unknown', message: 'x' } })))
    assert.equal(e.kind, 'api')
  } finally { await t.adapter.close() }
})

test('ask（許可要求）を検知したら interrupt して denied', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[ASK]]' })))
    assert.ok(e instanceof AdapterError)
    assert.equal(e.kind, 'denied')
    assert.ok(e.sessionRef)
    assert.ok(t.records().some((r) => r.ev === 'http' && r.path === `/api/session/${e.sessionRef}/interrupt`), 'interrupt を送った')
    assert.equal(t.records().some((r) => /\/permission\/.+\/reply$/.test(r.path ?? '')), false, 'reply（reject）は送らない')
  } finally { await t.adapter.close() }
})

test('時間切れは interrupt を送って timeout', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const r = t.req({ prompt: '[[HANG]]', timeoutMs: 300 })
    const e = await kindOf(t.adapter.run(r))
    assert.equal(e.kind, 'timeout')
    assert.ok(t.records().some((x) => x.ev === 'http' && x.path === `/api/session/${e.sessionRef}/interrupt`))
    assert.match(readFileSync(join(r.logDir, 'error.txt'), 'utf8'), /^timeout:/)
  } finally { await t.adapter.close() }
})

test('失敗の分類: failed は api、レート制限は usage-limit、serve の異常終了は exit', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[FAIL]]' })))).kind, 'api')
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[LIMIT]]' })))).kind, 'usage-limit')
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[DIE]]' })))).kind, 'exit')
  } finally { await t.adapter.close() }
})

test('prereq: 起動コマンドが無い・agent-guard.sh が無い・plugin の目印が無い', async () => {
  const a = setup({ toolConfig: { command: ['/nonexistent/opencode-xyz'] } })
  assert.equal((await kindOf(a.adapter.start())).kind, 'prereq')
  await a.adapter.close()

  const noGuard = createAdapter({ skillDir: '/nonexistent/skills/x', mainRoot: a.mainRoot, runDir: a.runDir, toolConfig: { command: [process.execPath, FAKE] }, guard: { codexRules, opencodeRules }, env: process.env })
  assert.equal((await kindOf(noGuard.start())).kind, 'prereq')
  await noGuard.close()

  const c = setup({ env: { FAKE_OC_NOPLUGIN: '1' } })
  const e = await kindOf(c.adapter.start())
  assert.equal(e.kind, 'prereq')
  assert.match(e.message, /plugin/)
  await c.adapter.close()
  assert.ok(c.records().length > 0, 'serve は起動したが、目印が無いので走らせなかった')
})

test('close は自分が作ったセッションだけ削除し、自分の serve だけ止める', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const t = setup({ env: { FAKE_OC_FOREIGN: 'ses_foreign' } })
  try {
    await t.adapter.start()
    const a = await t.adapter.run(t.req())
    const pid = starts(t.records())[0].pid
    await t.adapter.close()
    const deleted = t.records().filter((r) => r.ev === 'delete').map((r) => r.id)
    assert.ok(deleted.includes(a.sessionRef), '自分のセッションを削除した')
    assert.equal(deleted.includes('ses_foreign'), false, '他のセッションは消さない')
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false, 'serve が止まっている')
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), '無関係のプロセスは止めない')
  } finally { bystander.kill('SIGKILL') }
})

test('deleteSessions が false なら削除しない', async () => {
  const t = setup({ toolConfig: { deleteSessions: false } })
  await t.adapter.start()
  await t.adapter.run(t.req())
  await t.adapter.close()
  assert.equal(t.records().some((r) => r.ev === 'delete'), false)
})

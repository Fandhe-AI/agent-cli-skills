// 偽の `opencode`（--version と serve）。OpenCode アダプタのテストが、実の opencode を起動せずに
// 起動コマンドとして差し替える（toolConfig.command = [process.execPath, <このファイル>]）。
//
// 振る舞いは prompt 本文のマーカーで切り替える:
//   [[ASK]]    permission.asked を出して止まる（interrupt で execution.interrupted）
//   [[HANG]]   完了しない（interrupt で execution.interrupted）
//   [[FAIL]]   execution.failed（error.message = boom）
//   [[LIMIT]]  execution.failed（error.message = rate limit exceeded）
//   [[NOSSE]]  完了するが SSE の終端イベントを出さない（突き合わせでしか検知できない）
//   [[DIE]]    serve プロセスが異常終了する
//   [[SHELL:n]]  n 回の shell 呼び出しを、その location に読み込んだ plugin の tool.execute.before に通してから記録する
//               （throw されたら status=error、通れば completed の tool part を assistant のメッセージに入れる）
//   [[SHELL_UNHOOKED:n]]  n 回の shell 呼び出しを、plugin を通さずに completed として記録する（ガードの欠落の再現）
//   上記なし   assistant が `reply-<n>:<prompt の先頭>` と返して execution.succeeded
//
// 記録: 環境変数 FAKE_OC_LOG のファイルへ 1 行 1 JSON で追記する（start・http・delete）。
// FAKE_OC_NOPLUGIN=1 で config の plugin を読み込まない（目印ファイルが書かれない）。FAKE_OC_NOPLUGIN_AT=<文字列> は、
// その文字列を含む location でだけ読み込まない。
// plugin は実機と同じく location ごとに、その location への最初の GET /api/agent（location 省略時は serve の cwd）か prompt で
// 読み込む（実の plugin を import して ctx.location つきで setup を呼び、目印を書かせる。session.create では読み込まない）。
// メッセージ一覧は cursor でページを送れる（cursor.next は末尾でも返る。実機と同じ）。
// FAKE_OC_FOREIGN=<id> を渡すと、アダプタが作っていない既存セッションを 1 つ持つ（削除されないことの確認用）。
// FAKE_OC_GRANDCHILD=<pid ファイル> で、同じプロセスグループに孫（sleep）を起動して pid を書く（killSync の確認用）。
// FAKE_OC_GRANDCHILD_IGNORE_TERM=1 を足すと、孫を SIGTERM を無視するプロセスにする（本体だけが SIGTERM で終わる serve の再現）。
// FAKE_OC_NOLISTEN=1 で待ち受けない（起動待ちの serve の再現）。
// FAKE_OC_HANGS=<名前のカンマ区切り> で、その API が応答を返さない（接続は開いたまま）。名前は prompt・interrupt・delete・active・message。
// FAKE_OC_PARTIAL=<同じ名前の区切り> は、ヘッダと本文の一部だけ返して終わらせない（本文の読み取りが止まる serve の再現）。
// FAKE_OC_RESET=prompt で、prompt を受理して実行を始めた後、応答を返さずに接続を切る（要求が届いたか分からない通信エラーの再現）。
// FAKE_OC_IGNORE_TERM=1 で SIGTERM を無視する（SIGKILL でしか止まらない serve の再現）。
// FAKE_OC_PROMPT_STATUS=<HTTP status> で、prompt にその status を返す。FAKE_OC_PROMPT_STARTED=1 を足すと、実行を始めてから返す
// （受理の後に 200 以外を返す serve の再現）。足さなければ実行を始めない（受理していない拒否の再現）。
// FAKE_OC_HANGS_AFTER_IDLE=<名前のカンマ区切り> は、セッションの実行が終わった後（最後のメッセージが idle）だけ、その API が応答を
// 返さない。名前は message（GET /message）・get（GET /api/session/<id>）。成功の後の件数・本文・usage の取得が止まる serve の再現。
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  console.log('opencode v2.2.7')
  process.exit(0)
}
if (argv[0] !== 'serve') process.exit(64)
const port = Number(argv[argv.indexOf('--port') + 1])
const LOG = process.env.FAKE_OC_LOG
const PASSWORD = process.env.OPENCODE_PASSWORD
const HANGS = new Set((process.env.FAKE_OC_HANGS ?? '').split(',').filter(Boolean))
const PARTIAL = new Set((process.env.FAKE_OC_PARTIAL ?? '').split(',').filter(Boolean))
const RESET = new Set((process.env.FAKE_OC_RESET ?? '').split(',').filter(Boolean))
const HANGS_AFTER_IDLE = new Set((process.env.FAKE_OC_HANGS_AFTER_IDLE ?? '').split(',').filter(Boolean))
const rec = (o) => { if (LOG) appendFileSync(LOG, `${JSON.stringify(o)}\n`) }

rec({ ev: 'start', pid: process.pid, port, hasPassword: Boolean(PASSWORD), config: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null, cwd: process.cwd(), ghRepo: process.env.GH_REPO ?? null })

const pluginEntry = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugins?.[0] : null
const instances = new Map() // location directory -> { before: fn[] }
async function ensurePlugin(directory) {
  if (instances.has(directory)) return instances.get(directory)
  const inst = { before: [] }
  instances.set(directory, inst)
  if (!pluginEntry || process.env.FAKE_OC_NOPLUGIN) return inst
  if (process.env.FAKE_OC_NOPLUGIN_AT && directory.includes(process.env.FAKE_OC_NOPLUGIN_AT)) return inst
  const mod = await import(`${pathToFileURL(join(pluginEntry.package, 'index.js')).href}?loc=${encodeURIComponent(directory)}`)
  await mod.default.setup({
    options: pluginEntry.options,
    location: { directory },
    permission: { hook: async () => {} },
    shell: { hook: async () => {} },
    tool: { hook: async (name, fn) => { if (name === 'execute.before') inst.before.push(fn) } },
  })
  return inst
}

const sessions = new Map() // id -> { id, parentID, title, location, messages, active, seq, timer }
let nextId = 1
let nextMsg = 1
const sseClients = new Set()
if (process.env.FAKE_OC_FOREIGN) sessions.set(process.env.FAKE_OC_FOREIGN, { id: process.env.FAKE_OC_FOREIGN, messages: [], active: false, seq: 0 })

const emit = (type, data) => { for (const res of sseClients) res.write(`data: ${JSON.stringify({ type, data })}\n\n`) }
const mid = () => `msg_${nextMsg++}`

function finish(s, outcome, { sse = true, message = '' } = {}) {
  s.active = false
  s.messages.push({ id: mid(), type: 'idle', outcome })
  if (!sse) return
  if (outcome === 'succeeded') emit('session.execution.succeeded', { sessionID: s.id })
  else if (outcome === 'interrupted') emit('session.execution.interrupted', { sessionID: s.id, reason: 'user' })
  else emit('session.execution.failed', { sessionID: s.id, error: { type: 'provider', message } })
}

async function shellCalls(s, n, hooked) {
  const inst = hooked ? await ensurePlugin(s.location?.directory ?? process.cwd()) : { before: [] }
  const msgId = mid()
  const parts = []
  for (let i = 0; i < n; i++) {
    const ev = { tool: 'shell', sessionID: s.id, agent: 'build', messageID: msgId, id: `call_${msgId}_${i}`, input: { command: `echo fake-${i}` } }
    let status = 'completed'
    for (const f of inst.before) { try { await f(ev) } catch { status = 'error' } }
    parts.push({ type: 'tool', id: ev.id, name: 'shell', executed: false, state: { status, input: ev.input } })
  }
  s.messages.push({ id: msgId, type: 'assistant', content: parts })
}

async function startExecution(s, text) {
  s.active = true
  s.messages.push({ id: mid(), type: 'user', content: [{ type: 'text', text }] })
  emit('session.execution.started', { sessionID: s.id })
  if (text.includes('[[DIE]]')) { setTimeout(() => process.exit(3), 20); return }
  if (text.includes('[[HANG]]')) return
  if (text.includes('[[ASK]]')) {
    s.pendingAsk = { id: `per_${nextMsg++}`, sessionID: s.id, action: 'shell', resources: ['touch x'] }
    emit('permission.asked', s.pendingAsk)
    return
  }
  await ensurePlugin(s.location?.directory ?? process.cwd())
  const sh = /\[\[SHELL:(\d+)\]\]/.exec(text)
  if (sh) await shellCalls(s, Number(sh[1]), true)
  const un = /\[\[SHELL_UNHOOKED:(\d+)\]\]/.exec(text)
  if (un) await shellCalls(s, Number(un[1]), false)
  s.timer = setTimeout(() => {
    if (text.includes('[[FAIL]]')) return finish(s, 'failed', { message: 'boom' })
    if (text.includes('[[LIMIT]]')) return finish(s, 'failed', { message: 'rate limit exceeded' })
    s.seq += 1
    s.messages.push({ id: mid(), type: 'assistant', content: [{ type: 'text', text: `reply-${s.seq}:${text.split('\n')[0].slice(0, 40)}` }] })
    finish(s, 'succeeded', { sse: !text.includes('[[NOSSE]]') })
  }, 30)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const authed = req.headers.authorization === `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { /* 本文なし */ }
    rec({ ev: 'http', method: req.method, path: url.pathname, body, authed, port })
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)) }
    if (!authed) return send(401, { error: 'unauthorized' })
    const p = url.pathname
    const apiName = req.method === 'POST' && /\/prompt$/.test(p) ? 'prompt' : req.method === 'POST' && /\/interrupt$/.test(p) ? 'interrupt' : req.method === 'DELETE' ? 'delete' : p === '/api/session/active' ? 'active' : /\/message$/.test(p) ? 'message' : null
    if (apiName && HANGS.has(apiName)) return
    if (apiName && PARTIAL.has(apiName)) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":'); return }
    if (p === '/api/info') return send(200, { data: { version: '2.2.7' } })
    if (p === '/api/agent') {
      await ensurePlugin(url.searchParams.get('location[directory]') ?? process.cwd())
      return send(200, { data: [] })
    }
    if (p === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`)
      sseClients.add(res)
      res.on('close', () => sseClients.delete(res))
      return
    }
    if (p === '/api/session' && req.method === 'POST') {
      const id = `ses_${port}_${nextId++}`
      sessions.set(id, { id, parentID: body.parentID ?? null, title: body.title, location: body.location, model: body.model ?? null, messages: [], active: false, seq: 0 })
      return send(200, { data: { id, parentID: body.parentID ?? undefined, title: body.title } })
    }
    if (p === '/api/session/active') return send(200, { data: Object.fromEntries([...sessions.values()].filter((s) => s.active).map((s) => [s.id, true])) })
    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(p)
    if (!m) return send(404, { error: 'not found' })
    const s = sessions.get(m[1])
    const sub = m[2] ?? ''
    if (req.method === 'DELETE' && sub === '') {
      if (!s) return send(404, { error: 'not found' })
      for (const c of [...sessions.values()]) if (c.parentID === s.id) sessions.delete(c.id)
      sessions.delete(s.id)
      rec({ ev: 'delete', id: s.id })
      return send(200, { data: true })
    }
    if (!s) return send(404, { error: 'not found' })
    const idle = s.messages.at(-1)?.type === 'idle'
    if (req.method === 'GET' && idle && ((sub === '' && HANGS_AFTER_IDLE.has('get')) || (sub === 'message' && HANGS_AFTER_IDLE.has('message')))) return
    if (req.method === 'GET' && sub === '') return send(200, { data: { id: s.id, parentID: s.parentID ?? undefined, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } } } })
    if (req.method === 'POST' && sub === 'prompt') {
      if (process.env.FAKE_OC_PROMPT_STATUS) {
        if (process.env.FAKE_OC_PROMPT_STARTED) await startExecution(s, body.text)
        return send(Number(process.env.FAKE_OC_PROMPT_STATUS), { error: 'fake' })
      }
      await startExecution(s, body.text)
      if (RESET.has('prompt')) { req.socket.destroy(); return }
      return send(200, { data: { ok: true } })
    }
    if (req.method === 'POST' && sub === 'interrupt') {
      const was = s.active
      clearTimeout(s.timer)
      if (was) finish(s, 'interrupted')
      return send(200, { data: { interrupted: was } })
    }
    if (req.method === 'GET' && sub === 'permission') return send(200, { data: s.active && s.pendingAsk ? [s.pendingAsk] : [] })
    if (req.method === 'GET' && sub === 'form') return send(200, { data: [] })
    if (req.method === 'GET' && sub === 'message') {
      let list = s.messages.filter((x) => !url.searchParams.get('type') || x.type === url.searchParams.get('type'))
      const cur = url.searchParams.get('cursor')
      const { order, at } = cur ? JSON.parse(Buffer.from(cur, 'base64url').toString()) : { order: url.searchParams.get('order') ?? 'asc', at: 0 }
      if (order === 'desc') list = [...list].reverse()
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const data = list.slice(at, at + limit)
      const next = Buffer.from(JSON.stringify({ order, at: at + data.length })).toString('base64url')
      return send(200, { data, cursor: { previous: null, next } })
    }
    return send(404, { error: 'not found' })
  })
})
if (process.env.FAKE_OC_GRANDCHILD) {
  const g = process.env.FAKE_OC_GRANDCHILD_IGNORE_TERM
    ? spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 300000)"], { stdio: 'ignore' })
    : spawn('sleep', ['300'], { stdio: 'ignore' })
  writeFileSync(process.env.FAKE_OC_GRANDCHILD, String(g.pid))
}
if (!process.env.FAKE_OC_NOLISTEN) server.listen(port, '127.0.0.1')
else setInterval(() => {}, 1000)
if (!process.env.FAKE_OC_IGNORE_TERM) process.on('SIGTERM', () => process.exit(0))
else process.on('SIGTERM', () => {})

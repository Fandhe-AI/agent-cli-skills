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
//   上記なし   assistant が `reply-<n>:<prompt の先頭>` と返して execution.succeeded
//
// 記録: 環境変数 FAKE_OC_LOG のファイルへ 1 行 1 JSON で追記する（start・http・delete）。
// FAKE_OC_FOREIGN=<id> を渡すと、アダプタが作っていない既存セッションを 1 つ持つ（削除されないことの確認用）。
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  console.log('opencode v2.2.7')
  process.exit(0)
}
if (argv[0] !== 'serve') process.exit(64)
const port = Number(argv[argv.indexOf('--port') + 1])
const LOG = process.env.FAKE_OC_LOG
const PASSWORD = process.env.OPENCODE_PASSWORD
const rec = (o) => { if (LOG) appendFileSync(LOG, `${JSON.stringify(o)}\n`) }

rec({ ev: 'start', pid: process.pid, port, hasPassword: Boolean(PASSWORD), config: process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : null, cwd: process.cwd() })

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

function startExecution(s, text) {
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
  s.timer = setTimeout(() => {
    if (text.includes('[[FAIL]]')) return finish(s, 'failed', { message: 'boom' })
    if (text.includes('[[LIMIT]]')) return finish(s, 'failed', { message: 'rate limit exceeded' })
    s.seq += 1
    s.messages.push({ id: mid(), type: 'assistant', content: [{ type: 'text', text: `reply-${s.seq}:${text.split('\n')[0].slice(0, 40)}` }] })
    finish(s, 'succeeded', { sse: !text.includes('[[NOSSE]]') })
  }, 30)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const authed = req.headers.authorization === `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { /* 本文なし */ }
    rec({ ev: 'http', method: req.method, path: url.pathname, body, authed, port })
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)) }
    if (!authed) return send(401, { error: 'unauthorized' })
    const p = url.pathname
    if (p === '/api/info') return send(200, { data: { version: '2.2.7' } })
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
    if (req.method === 'GET' && sub === '') return send(200, { data: { id: s.id, parentID: s.parentID ?? undefined, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } } } })
    if (req.method === 'POST' && sub === 'prompt') { startExecution(s, body.text); return send(200, { data: { ok: true } }) }
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
      if (url.searchParams.get('order') === 'desc') list = [...list].reverse()
      return send(200, { data: list.slice(0, Number(url.searchParams.get('limit') ?? 50)) })
    }
    return send(404, { error: 'not found' })
  })
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))

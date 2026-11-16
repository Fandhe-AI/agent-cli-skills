// OpenCode アダプタ: ランナー専用の `opencode serve` を HTTP で操作し、1 エージェント = 1 セッションで実行する。
//
// 役割: 契約（_/local-plans/iit-runner-adapter-contract.md）の createAdapter。schema の検証・再試行・並列制限・
// worktree 作成は agent-host の責務で、ここでは持たない。
//
// 設計（実測の根拠は _/local-plans/iit-runners-phase0.md の 0-3・0-6・0-8）:
//   - serve は自前で空きポートに起動する。通常用と merge-exec 用の 2 つで、merge-exec 用は allowMerge の run が来たときだけ
//     遅延起動する。設定は環境変数 OPENCODE_CONFIG_CONTENT（インライン JSON）で渡し、ホストの設定ファイルには書かない。
//   - 設定は permissions / policies（guard.opencodeRules）の deny と、共通ガードの plugin（agent-guard）の有効化。
//     allow-all は付けない（session.create で付けると config の permissions が打ち消されるため）。
//   - plugin は親セッションを持たない top-level セッションを main とみなしてマージ系を制限しない。そこで通常用の serve では
//     セッションごとに「親セッション」を 1 つ作り、エージェントのセッションをその子（parentID）として作る。
//     plugin はこれをサブエージェントと判定する。merge-exec 用の serve では親を付けない（付けると plugin がマージも拒否する）。
//   - 完了は SSE（session.execution.*）を主とし、取りこぼしに備えて `/api/session/active` とメッセージ末尾の idle で突き合わせる。
//   - ask（許可要求・フォーム）は検知したら interrupt して denied にする（reject すると別の形で続けてしまう）。
//   - 出力は応答テキストだけを返す。JSON の抽出・検証・修復の判断は agent-host。
//   - `/api/model`・`/api/config` は API キーを含み得るので呼ばず、ログにも残さない。
//   - plugin の読み込みは起動時に確かめられない（実機で GET /api/plugin は空、/shell は permission を通らない）。
//     deny の実効は Phase 0 の実測と、ランナー全体の通し確認（Phase 3）で確かめる。
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AdapterError } from '../lib/adapter-error.mjs'

const USAGE_LIMIT_RE = /rate.?limit|quota|usage.?limit|too many requests|\b429\b|insufficient.?(credit|quota|balance)/i
const DENY_ALL = [{ action: '*', resource: '*', effect: 'deny' }]

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

/** `provider/id` を Model.Ref にする。variant があれば付ける。 */
export function parseModelRef(model, variant) {
  const i = typeof model === 'string' ? model.indexOf('/') : -1
  if (i <= 0 || i === model.length - 1) throw new AdapterError('api', `model は provider/id の形で指定する: ${String(model)}`)
  return { providerID: model.slice(0, i), id: model.slice(i + 1), ...(variant ? { variant } : {}) }
}

/**
 * serve へ渡す設定（OPENCODE_CONFIG_CONTENT の中身）。allow-all は含めない。
 * @param {{ rules: { permissions: object[], policies: object[] }, pluginDir: string }} p
 */
export function buildConfigContent({ rules, pluginDir }) {
  return { permissions: rules.permissions, policies: rules.policies, plugins: [pluginDir] }
}

/** 応答メッセージ（assistant）の text 部分をつなぐ。 */
const messageText = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('') : '')

export function createAdapter(cfg) {
  const tc = cfg.toolConfig ?? {}
  const command = Array.isArray(tc.command) ? tc.command : [tc.command ?? 'opencode']
  const pollMs = tc.pollMs ?? 2000
  const startTimeoutMs = tc.startTimeoutMs ?? 30000
  const useParent = tc.subagentParent !== false
  const deleteSessions = tc.deleteSessions === true
  const baseEnv = cfg.env ?? process.env
  const assetsDir = tc.guardAssetsDir ?? join(cfg.skillDir, '..', 'init-opencode', 'assets')
  const guardRoot = join(cfg.runDir, 'opencode-guard')
  // plugin は ../../hooks/agent-guard.sh を自分の位置から解決し、`.opencode/{hooks,plugins}` の編集を拒否する。
  // その配置どおりに `.opencode` を作ると、エージェントから編集できない。
  const pluginDir = join(guardRoot, '.opencode', 'plugins', 'agent-guard')
  const serves = new Map() // kind -> Promise<Serve>
  const sessions = new Map() // sid -> Serve（自分が作ったもの全部。親セッションも含む）
  let closed = false

  function installGuard() {
    const srcPlugin = join(assetsDir, 'opencode', 'plugins', 'agent-guard', 'index.js')
    const srcHook = join(assetsDir, 'hooks', 'agent-guard.sh')
    for (const p of [srcPlugin, srcHook]) {
      if (!existsSync(p)) throw new AdapterError('prereq', `ガードの資産が無い: ${p}（init-opencode スキルが同じ場所にあるか toolConfig.guardAssetsDir を確認する）`)
    }
    mkdirSync(pluginDir, { recursive: true })
    mkdirSync(join(guardRoot, '.opencode', 'hooks'), { recursive: true })
    copyFileSync(srcPlugin, join(pluginDir, 'index.js'))
    copyFileSync(srcHook, join(guardRoot, '.opencode', 'hooks', 'agent-guard.sh'))
  }

  const execVersion = () => new Promise((resolve, reject) => {
    execFile(command[0], [...command.slice(1), '--version'], { env: baseEnv, timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

  async function startServe(kind) {
    const allowMerge = kind === 'merge'
    const rules = cfg.guard.opencodeRules({ allowMerge })
    const port = await freePort()
    const password = randomBytes(16).toString('hex')
    mkdirSync(cfg.runDir, { recursive: true })
    const outFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.out`), 'a')
    const errFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.err`), 'a')
    const env = { ...baseEnv, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfigContent({ rules, pluginDir })) }
    const child = spawn(command[0], [...command.slice(1), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: cfg.mainRoot, env, stdio: ['ignore', outFd, errFd], detached: true })
    closeSync(outFd)
    closeSync(errFd)
    const serve = { kind, allowMerge, child, base: `http://127.0.0.1:${port}`, exited: false, exitInfo: null, subs: new Set(), sseCtrl: null, parents: new Map(), spawnError: null }
    serve.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    child.on('error', (e) => { serve.spawnError = e })
    child.on('exit', (code, signal) => { serve.exited = true; serve.exitInfo = `code=${code} signal=${signal}` })
    serve.api = async (path, init = {}) => {
      let r
      try {
        r = await fetch(serve.base + path, { ...init, headers: { authorization: serve.auth, 'content-type': 'application/json', ...(init.headers ?? {}) } })
      } catch (e) {
        throw new AdapterError(serve.exited ? 'exit' : 'api', `serve への接続に失敗: ${path} ${e.message}${serve.exited ? `（serve が終了: ${serve.exitInfo}）` : ''}`)
      }
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 本文が JSON でない応答は json=null */ }
      return { status: r.status, json, text }
    }

    const deadline = Date.now() + startTimeoutMs
    let up = false
    while (Date.now() < deadline && !serve.exited && !serve.spawnError) {
      try {
        const r = await fetch(`${serve.base}/api/info`, { headers: { authorization: serve.auth } })
        if (r.status === 200) { up = true; break }
      } catch { /* まだ待ち受けていない */ }
      await sleep(100)
    }
    if (!up) {
      stopServe(serve)
      throw new AdapterError('prereq', `opencode serve が起動しない（${serve.spawnError?.message ?? serve.exitInfo ?? '時間切れ'}）`)
    }
    await startSse(serve)
    return serve
  }

  /** SSE を購読し、sessionID 付きのイベントを購読者へ配る。切れたら serve が生きている間は再接続する。 */
  async function startSse(serve) {
    let resolveReady
    const ready = new Promise((r) => { resolveReady = r })
    ;(async () => {
      while (!closed && !serve.exited) {
        const ctrl = new AbortController()
        serve.sseCtrl = ctrl
        try {
          const r = await fetch(`${serve.base}/api/event`, { headers: { authorization: serve.auth }, signal: ctrl.signal })
          resolveReady()
          let buf = ''
          const dec = new TextDecoder()
          for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true })
            let i
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i)
              buf = buf.slice(i + 2)
              const line = block.split('\n').find((l) => l.startsWith('data: '))
              if (!line) continue
              let e
              try { e = JSON.parse(line.slice(6)) } catch { continue }
              const ev = { type: e.type, data: e.data ?? {}, sid: e.data?.sessionID ?? null }
              for (const f of serve.subs) f(ev)
            }
          }
        } catch { /* 切断・中止。下で再接続を判断する */ }
        resolveReady()
        if (!closed && !serve.exited) await sleep(300)
      }
    })()
    await Promise.race([ready, sleep(5000)])
  }

  function stopServe(serve) {
    try { serve.sseCtrl?.abort() } catch { /* 既に切れている */ }
    if (serve.exited) return
    try { process.kill(-serve.child.pid, 'SIGTERM') } catch { try { serve.child.kill('SIGTERM') } catch { /* 既に無い */ } }
  }

  async function waitExit(serve, ms) {
    const end = Date.now() + ms
    while (!serve.exited && Date.now() < end) await sleep(50)
  }

  function getServe(kind) {
    if (!serves.has(kind)) {
      const p = startServe(kind)
      serves.set(kind, p)
      p.catch(() => serves.delete(kind)) // 失敗は次の呼び出しで作り直せる
    }
    return serves.get(kind)
  }

  /** 通常用 serve の親セッション（cwd ごとに 1 つ）。plugin にサブエージェントと判定させるための足場。 */
  async function parentFor(serve, cwd) {
    if (!serve.parents.has(cwd)) {
      serve.parents.set(cwd, (async () => {
        const r = await serve.api('/api/session', { method: 'POST', body: JSON.stringify({ title: 'iit-runner:parent', location: { directory: cwd }, permissions: DENY_ALL }) })
        const id = r.json?.data?.id
        if (r.status !== 200 || typeof id !== 'string') throw new AdapterError('api', `親セッションの作成に失敗: HTTP ${r.status}`)
        sessions.set(id, serve)
        return id
      })())
    }
    return serve.parents.get(cwd)
  }

  async function interrupt(serve, sid) {
    try { await serve.api(`/api/session/${sid}/interrupt`, { method: 'POST' }) } catch { /* 止める努力のみ */ }
  }

  async function pollState(serve, sid) {
    const [a, m] = await Promise.all([
      serve.api('/api/session/active').catch(() => null),
      serve.api(`/api/session/${sid}/message?order=desc&limit=1`).catch(() => null),
    ])
    const active = !!(a?.json?.data && typeof a.json.data === 'object' && sid in a.json.data)
    const tail = m?.json?.data?.[0] ?? null
    return { active, tailId: tail?.id ?? null, tailType: tail?.type ?? null, outcome: tail?.outcome ?? null }
  }

  async function pendingAsk(serve, sid) {
    for (const kind of ['permission', 'form']) {
      const r = await serve.api(`/api/session/${sid}/${kind}`).catch(() => null)
      if (r?.status === 200 && Array.isArray(r.json?.data) && r.json.data.length > 0) return kind
    }
    return null
  }

  /** prompt を送って完了を待つ。戻り値は終了の種類。 */
  async function runTurn(serve, sid, text, deadline, log) {
    const before = await pollState(serve, sid)
    let terminal = null
    let wake
    const woke = new Promise((r) => { wake = r })
    const sub = (ev) => {
      if (ev.sid !== sid) return
      if (!ev.type.endsWith('.delta')) log(ev)
      if (ev.type === 'permission.asked' || ev.type === 'form.created') terminal ??= { kind: 'ask', via: 'sse', what: ev.type }
      else if (ev.type === 'session.execution.succeeded') terminal ??= { kind: 'succeeded', via: 'sse' }
      else if (ev.type === 'session.execution.failed') terminal ??= { kind: 'failed', via: 'sse', message: ev.data?.error?.message ?? ev.data?.message ?? '' }
      else if (ev.type === 'session.execution.interrupted') terminal ??= { kind: 'interrupted', via: 'sse' }
      if (terminal) wake()
    }
    serve.subs.add(sub)
    try {
      const p = await serve.api(`/api/session/${sid}/prompt`, { method: 'POST', body: JSON.stringify({ text }) })
      if (p.status !== 200) throw new AdapterError('api', `prompt が HTTP ${p.status}`, { sessionRef: sid })
      let idleStreak = 0
      while (!terminal) {
        if (Date.now() >= deadline) return { kind: 'timeout' }
        if (serve.exited) throw new AdapterError('exit', `serve が終了した（${serve.exitInfo}）`, { sessionRef: sid })
        await Promise.race([woke, sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))])
        if (terminal) break
        // 取りこぼしの突き合わせ（SSE は再生されない）
        const ask = await pendingAsk(serve, sid)
        if (ask) { terminal = { kind: 'ask', via: 'poll', what: ask }; break }
        const st = await pollState(serve, sid)
        if (!st.active && st.tailType === 'idle' && st.tailId !== before.tailId) {
          idleStreak++
          if (idleStreak >= 2) terminal = { kind: st.outcome === 'succeeded' ? 'succeeded' : st.outcome === 'interrupted' ? 'interrupted' : 'failed', via: 'poll', message: '' }
        } else idleStreak = 0
      }
      return terminal
    } finally {
      serve.subs.delete(sub)
    }
  }

  async function finalText(serve, sid) {
    const r = await serve.api(`/api/session/${sid}/message?type=assistant&order=desc&limit=5`)
    if (r.status !== 200) throw new AdapterError('api', `メッセージ取得が HTTP ${r.status}`, { sessionRef: sid })
    for (const m of r.json?.data ?? []) {
      const t = messageText(m)
      if (t !== '') return t
    }
    return ''
  }

  async function usageOf(serve, sid) {
    const r = await serve.api(`/api/session/${sid}`).catch(() => null)
    const tk = r?.json?.data?.tokens
    return tk ? { input: tk.input ?? 0, cached: tk.cache?.read ?? 0, output: tk.output ?? 0, reasoning: tk.reasoning ?? 0 } : undefined
  }

  return {
    name: 'opencode',

    async start() {
      try { await execVersion() } catch (e) { throw new AdapterError('prereq', `opencode を実行できない: ${e.message}`) }
      installGuard()
      await getServe('normal')
    },

    async run(req) {
      if (closed) throw new AdapterError('api', 'アダプタは close 済み')
      const deadline = Date.now() + req.timeoutMs
      let serve
      let sid
      if (req.resume) {
        sid = req.resume.sessionRef
        serve = sessions.get(sid)
        if (!serve) throw new AdapterError('api', `不明なセッション: ${sid}`, { sessionRef: sid })
      } else {
        serve = await getServe(req.allowMerge ? 'merge' : 'normal')
        const body = { title: req.label, location: { directory: req.cwd } }
        const variant = req.variant ?? req.effort ?? null
        const model = req.model ?? tc.defaultModel ?? null
        if (model) body.model = parseModelRef(model, variant)
        if (useParent && !serve.allowMerge) body.parentID = await parentFor(serve, req.cwd)
        const c = await serve.api('/api/session', { method: 'POST', body: JSON.stringify(body) })
        sid = c.json?.data?.id
        if (c.status !== 200 || typeof sid !== 'string') throw new AdapterError('api', `session.create が HTTP ${c.status}`)
        sessions.set(sid, serve)
      }

      mkdirSync(req.logDir, { recursive: true })
      const logEv = (ev) => { try { appendFileSync(join(req.logDir, 'events.jsonl'), `${JSON.stringify({ t: Date.now(), type: ev.type, data: ev.data })}\n`) } catch { /* ログ失敗で本処理を止めない */ } }
      const fail = (kind, message) => {
        try { appendFileSync(join(req.logDir, 'error.txt'), `${kind}: ${message}\n`) } catch { /* 同上 */ }
        return new AdapterError(kind, message, { sessionRef: sid })
      }

      let t
      try {
        t = await runTurn(serve, sid, req.resume ? req.resume.message : req.prompt, deadline, logEv)
      } catch (e) {
        if (e instanceof AdapterError) { try { appendFileSync(join(req.logDir, 'error.txt'), `${e.kind}: ${e.message}\n`) } catch { /* 同上 */ } }
        throw e
      }
      if (t.kind === 'timeout') {
        await interrupt(serve, sid)
        throw fail('timeout', `時間切れ（${req.timeoutMs} ms）。セッションを interrupt した`)
      }
      if (t.kind === 'ask') {
        await interrupt(serve, sid)
        throw fail('denied', `許可要求（${t.what}）が出たため interrupt した。ask は許可しない`)
      }
      if (t.kind === 'interrupted') throw fail('api', 'セッションが外部から interrupt された')
      if (t.kind === 'failed') {
        const msg = t.message || '実行が failed で終了した（詳細なし）'
        throw fail(USAGE_LIMIT_RE.test(msg) ? 'usage-limit' : 'api', msg)
      }
      const text = await finalText(serve, sid)
      try { writeFileSync(join(req.logDir, 'final.txt'), text) } catch { /* 同上 */ }
      return { text, sessionRef: sid, usage: await usageOf(serve, sid) }
    },

    async close() {
      closed = true
      const all = [...serves.values()]
      const live = (await Promise.all(all.map((p) => p.catch(() => null)))).filter(Boolean)
      if (deleteSessions) {
        // 自分が作ったセッションだけを消す（子 → 親の順）。他のセッションは一覧もしない。
        const ids = [...sessions.keys()].reverse()
        for (const sid of ids) {
          const s = sessions.get(sid)
          if (s && !s.exited) await s.api(`/api/session/${sid}`, { method: 'DELETE' }).catch(() => null)
        }
      }
      for (const s of live) stopServe(s)
      for (const s of live) {
        await waitExit(s, 3000)
        if (!s.exited) { try { process.kill(-s.child.pid, 'SIGKILL') } catch { /* 既に無い */ } }
      }
      serves.clear()
      sessions.clear()
    },
  }
}

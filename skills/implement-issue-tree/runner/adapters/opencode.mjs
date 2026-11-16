// OpenCode アダプタ: ランナー専用の `opencode serve` を HTTP で操作し、1 エージェント = 1 セッションで実行する。
//
// 役割: 契約（_/local-plans/iit-runner-adapter-contract.md）の createAdapter。schema の検証・再試行・並列制限・
// worktree 作成は agent-host の責務で、ここでは持たない。
//
// 設計（実測の根拠は _/local-plans/iit-runners-phase0.md の 0-3・0-6・0-8）:
//   - serve は自前で空きポートに起動する。通常用と merge-exec 用の 2 つで、merge-exec 用は allowMerge の run が来たときだけ
//     遅延起動する。設定は環境変数 OPENCODE_CONFIG_CONTENT（インライン JSON）で渡し、ホストの設定ファイルには書かない。
//   - 設定は permissions / policies（guard.opencodeRules）の deny と、ランナー専用 plugin（opencode-plugin/）の有効化。
//     allow-all は付けない（session.create で付けると config の permissions が打ち消されるため）。
//   - 配布物の plugin は親を持たない top-level セッションを main とみなしてマージ系を制限しない。ランナーのセッションは
//     すべて top-level なので、ランナー専用 plugin が agent-guard.sh を「常に subagent=true」で呼ぶ（Codex の codex-hook.sh と同じ意味）。
//     allowMerge の serve だけ、MERGE_EXEC_COMMAND の完全一致の 1 形を plugin のオプションで素通しにする。
//   - plugin の読み込みは start で確かめる。plugin は初期化時に serve ごとの nonce を目印ファイルへ書き、アダプタがそれを読む
//     （実機で GET /api/plugin は空・/shell は permission を通らず、他に確かめる手段が無い）。確かめられなければ prereq。
//   - 完了は SSE（session.execution.*）を主とし、取りこぼしに備えて `/api/session/active` とメッセージ末尾の idle で突き合わせる。
//   - ask（許可要求・フォーム）は検知したら interrupt して denied にする（reject すると別の形で続けてしまう）。
//   - 出力は応答テキストだけを返す。JSON の抽出・検証・修復の判断は agent-host。
//   - `/api/model`・`/api/config` は API キーを含み得るので呼ばず、ログにも残さない。
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AdapterError } from '../lib/adapter-error.mjs'
import { MERGE_EXEC_COMMAND } from '../lib/guard.mjs'

const USAGE_LIMIT_RE = /rate.?limit|quota|usage.?limit|too many requests|\b429\b|insufficient.?(credit|quota|balance)/i
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'opencode-plugin')

// merge-exec のコマンドは permission の resource が `HEAD_SHA=...` の代入と `gh pr merge ...` に分かれて届く可能性があるため、
// 代入を除いた後半の形も素通しにする（Phase 0-3 の試作と同じ）。前半が見つからない形になったら完全一致だけにする。
const MERGE_TAIL_SOURCE = MERGE_EXEC_COMMAND.source.replace(/^\^HEAD_SHA="\[0-9a-f\]\{40\}"; /, '^')
export const MERGE_RES = Object.freeze([...new Set([MERGE_EXEC_COMMAND.source, MERGE_TAIL_SOURCE])])

/** agent-guard.sh の絶対パス（無ければ null）。探索順は Codex アダプタと同じ。 */
export function findGuardScript({ toolConfig = {}, skillDir, mainRoot }) {
  const cands = [
    toolConfig.guardScript,
    skillDir && join(skillDir, '..', 'init-opencode', 'assets', 'hooks', 'agent-guard.sh'),
    skillDir && join(skillDir, '..', 'init-codex', 'assets', 'hooks', 'agent-guard.sh'),
    mainRoot && join(mainRoot, '.opencode', 'hooks', 'agent-guard.sh'),
    mainRoot && join(mainRoot, '.codex', 'hooks', 'agent-guard.sh'),
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return resolve(c)
  return null
}

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
 * @param {{ rules: { permissions: object[], policies: object[] }, pluginDir: string, options: object }} p
 */
export function buildConfigContent({ rules, pluginDir, options }) {
  return { permissions: rules.permissions, policies: rules.policies, plugins: [{ package: pluginDir, options }] }
}

/** 応答メッセージ（assistant）の text 部分をつなぐ。 */
const messageText = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('') : '')

export function createAdapter(cfg) {
  const tc = cfg.toolConfig ?? {}
  const command = Array.isArray(tc.command) ? tc.command : [tc.command ?? 'opencode']
  const pollMs = tc.pollMs ?? 2000
  const startTimeoutMs = tc.startTimeoutMs ?? 30000
  const deleteSessions = tc.deleteSessions === true
  const baseEnv = cfg.env ?? process.env
  let guardScript = null
  const serves = new Map() // kind -> Promise<Serve>
  const sessions = new Map() // sid -> Serve（自分が作ったもの全部）
  let closed = false

  const execVersion = () => new Promise((resolve, reject) => {
    execFile(command[0], [...command.slice(1), '--version'], { env: baseEnv, timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

  function ensureGuardScript() {
    guardScript ??= findGuardScript({ toolConfig: tc, skillDir: cfg.skillDir, mainRoot: cfg.mainRoot })
    if (!guardScript) throw new AdapterError('prereq', 'agent-guard.sh が見つからない（toolConfig.guardScript か init-opencode / init-codex の assets/hooks/）')
  }

  async function startServe(kind) {
    ensureGuardScript()
    const allowMerge = kind === 'merge'
    const rules = cfg.guard.opencodeRules({ allowMerge })
    const port = await freePort()
    const password = randomBytes(16).toString('hex')
    mkdirSync(cfg.runDir, { recursive: true })
    const outFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.out`), 'a')
    const errFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.err`), 'a')
    const nonce = randomBytes(16).toString('hex')
    const markerPath = join(cfg.runDir, `opencode-plugin-${kind}.marker`)
    const options = { guardScript, log: join(cfg.runDir, `opencode-guard-${kind}.log`), mergeRes: allowMerge ? MERGE_RES : [], markerPath, nonce }
    const env = { ...baseEnv, OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfigContent({ rules, pluginDir: PLUGIN_DIR, options })) }
    const child = spawn(command[0], [...command.slice(1), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: cfg.mainRoot, env, stdio: ['ignore', outFd, errFd], detached: true })
    closeSync(outFd)
    closeSync(errFd)
    const serve = { kind, allowMerge, child, base: `http://127.0.0.1:${port}`, exited: false, exitInfo: null, subs: new Set(), sseCtrl: null, spawnError: null }
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
    // plugin の読み込みの確認。plugin は場所（ディレクトリ）ごとの実行環境が最初に作られるときに読み込まれ、serve の起動直後ではない
    // （実機: 設定済みでも、その場所へ API が来るまで setup が呼ばれない）。参照だけの GET /api/agent で実行環境を作らせて促す。
    const loaded = () => { try { return readFileSync(markerPath, 'utf8') === nonce } catch { return false } }
    await serve.api('/api/agent').catch(() => null)
    const end = Date.now() + 5000
    while (!loaded() && Date.now() < end && !serve.exited) await sleep(50)
    if (!loaded()) {
      stopServe(serve)
      throw new AdapterError('prereq', 'ランナー専用の plugin が読み込まれたことを確かめられない（目印ファイルが無い）。ガード無しでは走らせない')
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
      ensureGuardScript()
      await getServe('normal')
    },

    async run(req) {
      if (closed) throw new AdapterError('api', 'アダプタは close 済み')
      const deadline = Date.now() + req.timeoutMs
      let serve
      let sid
      let modelNote = null
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
        else modelNote = 'model 未指定: serve の既定に任せ、variant も送らない'
        const c = await serve.api('/api/session', { method: 'POST', body: JSON.stringify(body) })
        sid = c.json?.data?.id
        if (c.status !== 200 || typeof sid !== 'string') throw new AdapterError('api', `session.create が HTTP ${c.status}`)
        sessions.set(sid, serve)
      }

      mkdirSync(req.logDir, { recursive: true })
      if (modelNote) { try { appendFileSync(join(req.logDir, 'adapter.log'), `${modelNote}\n`) } catch { /* ログ失敗で止めない */ } }
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

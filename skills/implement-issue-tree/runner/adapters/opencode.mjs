// OpenCode アダプタ: ランナー専用の `opencode serve` を HTTP で操作し、1 エージェント = 1 セッションで実行する。
//
// 役割: 契約（_/local-plans/iit-runner-adapter-contract.md）の createAdapter。schema の検証・再試行・並列制限・
// worktree 作成は agent-host の責務で、ここでは持たない。
//
// 設計（実測の根拠は _/local-plans/iit-runners-phase0.md の 0-3・0-6・0-8）:
//   - serve は自前で空きポートに起動する。通常用と merge-exec 用で、merge-exec 用は allowMerge の run が来たときだけ、PR ごとに
//     遅延起動する（監査 e670648 の MEDIUM-8）。merge 用は、素通しにする形を guard.mergeExecCommandFor(req.merge.prNumber) に
//     絞り、serve の env に GH_REPO=req.merge.repo を固定する。req.merge が null・不正なら allowMerge として扱わない
//     （merge 用 serve を作らず通常用で走らせる。fail-closed）。merge 用 serve は close まで残す。設定は環境変数 OPENCODE_CONFIG_CONTENT（インライン JSON）で渡し、ホストの設定ファイルには書かない。
//   - 設定は permissions / policies（guard.opencodeRules）の deny と、ランナー専用 plugin（opencode-plugin/）の有効化。
//     allow-all は付けない（session.create で付けると config の permissions が打ち消されるため）。
//   - 配布物の plugin は親を持たない top-level セッションを main とみなしてマージ系を制限しない。ランナーのセッションは
//     すべて top-level なので、ランナー専用 plugin が agent-guard.sh を「常に subagent=true」で呼ぶ（Codex の codex-hook.sh と同じ意味）。
//     merge 用の serve だけ、その PR 番号の merge-exec の完全一致の 1 形を plugin のオプションで素通しにする（permission に後半だけが
//     届く版では、plugin が tool.execute.before で全文の一致を確かめた呼び出しにだけ許可を対応づける）。
//   - ガードの置き場（agent-guard.sh・ランナー専用 plugin・OpenCode の利用者設定ディレクトリ・`.opencode/(hooks|plugins?)/`・
//     `opencode.json(c)`・スキルの置き場 cfg.skillDir）への edit を permissions と policies の両方で拒否する（protectRules。guard.opencodeRules の結果に足す）。
//     設定ディレクトリは plugin の options.protectedPaths に渡し、plugin が edit と shell からの書き込みを拒否する（plugin 冒頭の「保護」）。
//     スキルの置き場は options.editOnlyPaths に渡し、edit だけ拒否する（shell は launcher の実行に使うため判定しない。shell からの書き換えは lib/pins.mjs の sha256 の固定で検知する）。
//   - 認証ファイル（gh の設定ディレクトリ・Codex の auth.json・OpenCode の auth.json と opencode.db）への read を
//     permissions と policies で拒否する（credentialReadRules。監査 e670648 の LOW-9）。shell からの読み出しは agent-guard.sh の
//     credential-read が止める。パスは env から決めるだけで、中身は読まない。
//   - plugin の読み込みは目印で確かめる。plugin は setup のたびに serve ごとの nonce と location を目印ファイルへ 1 行書き、
//     アダプタがそれを読む（実機で GET /api/plugin は空・/shell は permission を通らず、他に確かめる手段が無い）。plugin は
//     location ごとに読み込まれる（v2.2.7 の実測: その location への最初の GET /api/agent か prompt で setup が走り、
//     session.create では走らない）ため、start で mainRoot を、各セッションの作成後にその location（worktree）を
//     GET /api/agent?location[directory]=… で読み込ませて確かめる。確かめられなければ prompt を送らずに prereq。
//   - ガードの欠落の検知（監査 e670648 の MEDIUM-7）: plugin は shell の呼び出しごとに sessionID を callLog へ書く。成功で
//     終わったターンの後、セッションの assistant メッセージをすべて読み、shell の tool part の件数が callLog の件数を上回れば
//     denied にする（Codex の hook.log と command_execution の突き合わせと同じ。ガードを通っていない実行の出力を後段へ流さない）。
//   - 完了は SSE（session.execution.*）を主とし、取りこぼしに備えて `/api/session/active` とメッセージ末尾の idle で突き合わせる。
//   - ask（許可要求・フォーム）は検知したら interrupt して denied にする（reject すると別の形で続けてしまう）。
//   - 出力は応答テキストだけを返す。JSON の抽出・検証・修復の判断は agent-host。
//   - `/api/model`・`/api/config` は API キーを含み得るので呼ばず、ログにも残さない。
//   - 後片づけ: close は自分のセッションを消して serve を止める。killSync（契約の任意メソッド）は close を待てない経路
//     （run.mjs のシグナル受信・exit）用で、起動した serve（起動待ちを含む）のプロセスグループを同期で SIGKILL する。
//     serve の本体が終わったとき（SIGTERM で本体だけが終わった・異常終了した）は、その場でプロセスグループへ SIGKILL を送り、
//     同じグループに残った子・孫を止める（本体の終了で children・stopServe・close の対象から外れるため）。
//
// toolConfig のキー（既定値は runner/config/default.json の toolConfig.opencode。コード側の既定も同じ）:
//   deleteSessions（run.mjs が cleanup.deleteSessions から渡す）・command (["opencode"]。serve を起動するコマンドの配列)・
//   pollMs (2000)・startTimeoutMs (30000)・apiTimeoutMs（serve への各要求と本文の読み取りの期限。既定は run.mjs が渡す
//   timeoutsSec.default と 30 秒の小さいほう。run の中の要求は run の残り時間でも打ち切る）・defaultModel（models 表の model が null の段に使う。省略で利用者の既定）・
//   guardScript（agent-guard.sh の絶対パス。既定は lib/guard-script.mjs の探索）
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { AdapterError } from '../lib/adapter-error.mjs'
import { MERGE_EXEC_COMMAND, mergeExecCommandFor } from '../lib/guard.mjs'
import { GUARD_SCRIPT_MISSING, findGuardScript } from '../lib/guard-script.mjs'
import { isMergeTarget } from '../lib/merge-target.mjs'

const USAGE_LIMIT_RE = /rate.?limit|quota|usage.?limit|too many requests|\b429\b|insufficient.?(credit|quota|balance)/i
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'opencode-plugin')

// 一般形の参照（PR 番号を問わない形）。merge 用 serve が実際に渡すのは mergeTarget の mergeExecCommandFor(prNumber) で、
// これより狭い。以下は一般形についての説明で、PR 番号で具体化しても同じ。
// allowMerge の serve で素通しにするのは MERGE_EXEC_COMMAND の完全一致だけ（Codex の codex-hook.sh に渡す --merge-re と
// 同じ 1 形・同じ意味）。後半だけの形（代入を落とした `gh pr merge … "$HEAD_SHA"`）の正規表現は、代入なしの gh pr merge を
// 素通しにするため置かない。OpenCode v2.2.7 の permission には後半だけが届く（Phase 3 の実測）ので、plugin は
// tool.execute.before でこの完全一致を確かめた呼び出しを記録し、同じ呼び出し（source.id 等）の後半だけを通す（plugin 冒頭）。
export const MERGE_RES = Object.freeze([MERGE_EXEC_COMMAND.source])

const MARKER_WAIT_MS = 5000
// halt（時間切れ・ask・prompt の通信エラーの後のセッションの停止）で interrupt の応答を待つ上限。apiTimeoutMs がこれより短ければ
// そちら。halt 全体（これ + killServe の最大 2.5 秒）を agent-host の watchdog の猶予（timeoutMs + 30 秒）に収める（PR #851 の
// Bugbot。apiTimeoutMs を丸ごと待つと猶予を超え、halt の最中に run が見放されて、別の run が使い回し始めた serve を止め得た）
const HALT_INTERRUPT_MS = 5000
const MESSAGE_PAGE = 100
const MESSAGE_PAGE_MAX = 1000 // 100 件 × 1000 ページを超えるセッションは数え切れないものとして拒否する

/**
 * req.merge（契約: null | { prNumber, repo }。allowMerge が true のときだけ入る）を検証する。形の判定は共通層の
 * isMergeTarget（agent-host・Codex アダプタと同じ。repo は owner/repo）。allowMerge でない・merge が無い・不正のときは
 * null（merge 用 serve を使わず通常用で走らせる。マージは通常用 serve の deny と plugin に止められる。fail-closed。
 * Codex アダプタは不正な merge を例外にするが、どちらもマージは起きない）。
 */
export function mergeTarget(req) {
  const m = req?.allowMerge === true ? req.merge : null
  if (!isMergeTarget(m)) return null
  return { prNumber: m.prNumber, repo: m.repo }
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

const realOr = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
const uniq = (xs) => [...new Set(xs)]

/** OpenCode の利用者設定ディレクトリ（plugins・設定）。XDG_CONFIG_HOME・OPENCODE_CONFIG_DIR を反映する。 */
export function opencodeConfigDirs(env) {
  const home = env.HOME || homedir()
  return uniq([join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'), ...(env.OPENCODE_CONFIG_DIR ? [resolve(env.OPENCODE_CONFIG_DIR)] : [])])
}

// 位置を問わない保護の形（配布物の plugin の PROTECTED_EDIT と同じ対象の glob 版。glob の * は / も含む）
const PROTECTED_EDIT_GLOBS = ['*.opencode/hooks/*', '*.opencode/plugin/*', '*.opencode/plugins/*', '*opencode.json', '*opencode.jsonc']

/**
 * ガードの置き場への edit の拒否（permissions と policies）。files は完全一致、dirs は完全一致と配下。
 * パスは書かれたままの形と realpath の両方を入れる（外部のパスは正規化済みの絶対パスで照合される）。
 * @param {{ files: string[], dirs: string[] }} p
 */
export function protectRules({ files, dirs }) {
  const resources = uniq([
    ...files.flatMap((f) => [resolve(f), realOr(f)]),
    ...dirs.flatMap((d) => [resolve(d), realOr(d)]).flatMap((d) => [d, `${d}/*`]),
    ...PROTECTED_EDIT_GLOBS,
  ])
  return {
    permissions: resources.map((resource) => ({ action: 'edit', resource, effect: 'deny' })),
    policies: resources.map((resource) => ({ action: 'tool.use', resource: `edit:${resource}`, effect: 'deny' })),
  }
}

/**
 * 認証ファイルへの read の拒否（permissions と policies）。ディレクトリは完全一致と配下、opencode.db は -wal / -shm も含める。
 * パスは書かれたままの形と realpath の両方（realpath はパスの解決だけで、ファイルの中身は読まない）。
 * @param {Record<string, string | undefined>} env
 */
export function credentialReadRules(env) {
  const home = env.HOME || homedir()
  const ghDir = env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'gh')
  const codexAuth = join(env.CODEX_HOME || join(home, '.codex'), 'auth.json')
  const ocData = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')
  const both = (p) => uniq([resolve(p), realOr(p)])
  const resources = uniq([
    ...both(ghDir).flatMap((d) => [d, `${d}/*`]),
    ...both(codexAuth),
    ...both(join(ocData, 'auth.json')),
    ...both(join(ocData, 'opencode.db')).map((f) => `${f}*`),
    ...(env.OPENCODE_DB ? both(env.OPENCODE_DB).map((f) => `${f}*`) : []),
  ])
  return {
    permissions: resources.map((resource) => ({ action: 'read', resource, effect: 'deny' })),
    policies: resources.map((resource) => ({ action: 'tool.use', resource: `read:${resource}`, effect: 'deny' })),
  }
}

/** permissions / policies を連結する（後勝ちのため、足す側を後ろに置く）。 */
const mergeRules = (...rs) => ({ permissions: rs.flatMap((r) => r.permissions), policies: rs.flatMap((r) => r.policies) })

/** 応答メッセージ（assistant）の text 部分をつなぐ。 */
const messageText = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('') : '')

export function createAdapter(cfg) {
  const tc = cfg.toolConfig ?? {}
  const command = Array.isArray(tc.command) ? tc.command : [tc.command ?? 'opencode']
  const pollMs = tc.pollMs ?? 2000
  const startTimeoutMs = tc.startTimeoutMs ?? 30000
  const apiTimeoutMs = Number.isFinite(tc.apiTimeoutMs) && tc.apiTimeoutMs > 0 ? tc.apiTimeoutMs : Math.min(30000, Number.isFinite(tc.timeoutsSec?.default) && tc.timeoutsSec.default > 0 ? tc.timeoutsSec.default * 1000 : 30000)
  const deleteSessions = tc.deleteSessions === true
  const baseEnv = cfg.env ?? process.env
  let guardScript = null
  const serves = new Map() // kind -> Promise<Serve>
  // 起動した serve すべて（作り直しで serves から外れたものを含む）。close はこちらを止める
  const allServes = new Set()
  const sessions = new Map() // sid -> Serve（自分が作ったもの全部）
  // 起動した serve の子プロセス（起動待ちのものを含む）。killSync が同期で使う（serves は Promise なので同期では引けない）
  const children = new Set()
  let closed = false

  const execVersion = () => new Promise((resolve, reject) => {
    execFile(command[0], [...command.slice(1), '--version'], { env: baseEnv, timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

  function ensureGuardScript() {
    guardScript ??= findGuardScript({ toolConfig: tc, skillDir: cfg.skillDir, mainRoot: cfg.mainRoot })
    if (!guardScript) throw new AdapterError('prereq', GUARD_SCRIPT_MISSING)
  }

  /** kind は 'normal' か `merge-<prNumber>`。merge は merge 用のときの { prNumber, repo }。 */
  async function startServe(kind, merge) {
    ensureGuardScript()
    const allowMerge = merge !== null
    const configDirs = opencodeConfigDirs(baseEnv)
    // スキルの置き場も保護する（実行仕様の launcher `scripts/run-verified.sh` を、エージェントが edit で書き換えて
    // ホストの直接実行を乗っ取るのを防ぐ多層防御。主の対策は agent-host 側の launcher の sha256 固定）。shell からの書き込みは best-effort
    const skillDirs = typeof cfg.skillDir === 'string' && cfg.skillDir !== '' ? [resolve(cfg.skillDir)] : []
    const rules = mergeRules(cfg.guard.opencodeRules({ allowMerge }), protectRules({ files: [guardScript], dirs: [PLUGIN_DIR, ...configDirs, ...skillDirs] }), credentialReadRules(baseEnv))
    const port = await freePort()
    const password = randomBytes(16).toString('hex')
    mkdirSync(cfg.runDir, { recursive: true })
    const outFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.out`), 'a')
    const errFd = openSync(join(cfg.runDir, `opencode-serve-${kind}.err`), 'a')
    const nonce = randomBytes(16).toString('hex')
    const markerPath = join(cfg.runDir, `opencode-plugin-${kind}.marker`)
    const callLog = join(cfg.runDir, `opencode-calls-${kind}.log`)
    const options = { guardScript, log: join(cfg.runDir, `opencode-guard-${kind}.log`), mergeRes: allowMerge ? [mergeExecCommandFor(merge.prNumber).source] : [], markerPath, nonce, protectedPaths: configDirs.map((d) => resolve(d)), editOnlyPaths: skillDirs, callLog }
    const env = { ...baseEnv, ...(allowMerge ? { GH_REPO: merge.repo } : {}), OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfigContent({ rules, pluginDir: PLUGIN_DIR, options })) }
    const child = spawn(command[0], [...command.slice(1), 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: cfg.mainRoot, env, stdio: ['ignore', outFd, errFd], detached: true })
    // 起動待ちの await より前に登録する（起動待ちの間にシグナルで終わっても killSync で止められるように）
    children.add(child)
    closeSync(outFd)
    closeSync(errFd)
    const serve = { kind, allowMerge, repo: merge?.repo ?? null, nonce, markerPath, callLog, locations: new Set(), child, base: `http://127.0.0.1:${port}`, exited: false, exitInfo: null, subs: new Set(), sseCtrl: null, spawnError: null }
    serve.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    allServes.add(serve)
    child.on('error', (e) => { serve.spawnError = e })
    // 本体が終わったら（SIGTERM で本体だけ終わった・異常終了した場合を含む）、同じプロセスグループに残った子・孫をその場で
    // SIGKILL する。本体の終了で止める対象（children・stopServe・close）から外れるため、ここで止めないと残る（PR #851 の codex P1）。
    // 本体の回収直後に送るので、pid の再利用で別のグループを撃つことはない（グループに残りがあれば pgid は再利用されない）
    child.on('exit', (code, signal) => {
      serve.exited = true
      serve.exitInfo = `code=${code} signal=${signal}`
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* グループに残りが無い */ }
      children.delete(child)
    })
    // 各要求と本文の読み取りに期限を付ける（deadline があればその残り時間でも打ち切る）。serve が応答しないと、呼び出し側が
    // run の deadline 判定へ戻れないため。期限切れは timedOut = true の AdapterError で、呼び出し側が止まったかを確かめる
    serve.api = async (path, { deadline, ...init } = {}) => {
      const limit = deadline === undefined ? apiTimeoutMs : Math.max(1, Math.min(apiTimeoutMs, deadline - Date.now()))
      const signal = AbortSignal.timeout(limit)
      let r
      let text
      try {
        r = await fetch(serve.base + path, { ...init, signal, headers: { authorization: serve.auth, 'content-type': 'application/json', ...(init.headers ?? {}) } })
        text = await r.text()
      } catch (e) {
        const err = new AdapterError(serve.exited ? 'exit' : 'api', `serve への接続に失敗: ${path} ${signal.aborted ? `期限切れ（${limit} ms）` : e.message}${serve.exited ? `（serve が終了: ${serve.exitInfo}）` : ''}`)
        if (signal.aborted) err.timedOut = true
        throw err
      }
      let json = null
      try { json = JSON.parse(text) } catch { /* 本文が JSON でない応答は json=null */ }
      return { status: r.status, json, text }
    }

    const deadline = Date.now() + startTimeoutMs
    let up = false
    while (Date.now() < deadline && !serve.exited && !serve.spawnError) {
      try {
        const r = await fetch(`${serve.base}/api/info`, { headers: { authorization: serve.auth }, signal: AbortSignal.timeout(2000) })
        if (r.status === 200) { up = true; break }
      } catch { /* まだ待ち受けていない */ }
      await sleep(100)
    }
    if (!up) {
      stopServe(serve)
      throw new AdapterError('prereq', `opencode serve が起動しない（${serve.spawnError?.message ?? serve.exitInfo ?? '時間切れ'}）`)
    }
    // plugin の読み込みの確認（冒頭）。serve の cwd（mainRoot）の location で確かめる
    if (!(await ensureLocation(serve, cfg.mainRoot))) {
      stopServe(serve)
      throw new AdapterError('prereq', 'ランナー専用の plugin が読み込まれたことを確かめられない（目印ファイルが無い）。ガード無しでは走らせない')
    }
    await startSse(serve)
    return serve
  }

  /** 目印に、この serve の nonce と location（realpath で比較）の組があるか。 */
  function markerHas(serve, want) {
    let lines
    try { lines = readFileSync(serve.markerPath, 'utf8').split('\n') } catch { return false }
    return lines.some((l) => {
      try {
        const m = JSON.parse(l)
        return m?.nonce === serve.nonce && typeof m.directory === 'string' && realOr(m.directory) === want
      } catch { return false }
    })
  }

  /** location に plugin を読み込ませ、目印で確かめる（参照だけの GET /api/agent で、その location の実行環境を作らせる）。 */
  async function ensureLocation(serve, directory) {
    const want = realOr(directory)
    if (serve.locations.has(want)) return true
    await serve.api(`/api/agent?${new URLSearchParams({ 'location[directory]': directory })}`).catch(() => null)
    const end = Date.now() + MARKER_WAIT_MS // setup はその応答の後に走ることがある（実測）ので、目印を待つ
    while (!markerHas(serve, want) && Date.now() < end && !serve.exited) await sleep(50)
    if (!markerHas(serve, want)) return false
    serve.locations.add(want)
    return true
  }

  /** セッションの assistant メッセージ中の shell の tool part の件数（cursor でページを送る）。 */
  async function shellCount(serve, sid) {
    let n = 0
    let q = `type=assistant&order=asc&limit=${MESSAGE_PAGE}`
    for (let page = 0; page < MESSAGE_PAGE_MAX; page++) {
      const r = await serve.api(`/api/session/${sid}/message?${q}`)
      if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new AdapterError('api', `件数の突き合わせでメッセージ取得が HTTP ${r.status}`, { sessionRef: sid })
      for (const m of r.json.data) for (const p of Array.isArray(m?.content) ? m.content : []) if (p?.type === 'tool' && p.name === 'shell') n++
      const next = r.json.cursor?.next
      if (r.json.data.length < MESSAGE_PAGE || typeof next !== 'string' || next === '') return n
      q = `type=assistant&limit=${MESSAGE_PAGE}&cursor=${encodeURIComponent(next)}` // cursor と order は併用しない（API の仕様）
    }
    throw new AdapterError('api', `件数の突き合わせ: メッセージが ${MESSAGE_PAGE * MESSAGE_PAGE_MAX} 件を超えて数え切れない`, { sessionRef: sid })
  }

  /** plugin がこのセッションの shell の呼び出しとして記録した件数。 */
  function hookedCount(serve, sid) {
    try { return readFileSync(serve.callLog, 'utf8').split('\n').filter((l) => l === sid).length } catch { return 0 }
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

  // 終了した（止めた・落ちた）serve は作り直す。作り直しは同じ kind で 1 つにまとめる: await の後に serves を読み直し、
  // 別の呼び出しが既に作り直していればそれを使う（並列の run が同時に終了済みの serve を見て、それぞれ startServe を呼ぶと、
  // 後の serves.set が先の serve を孤児にする。PR #851 の Bugbot）。読み直しから serves.set までは await を挟まない
  async function getServe(merge = null) {
    const kind = merge ? `merge-${merge.prNumber}` : 'normal'
    for (;;) {
      const cur = serves.get(kind)
      if (!cur) break
      const s = await cur // 起動の失敗はそのまま呼び出し側へ返る（下の catch で次の呼び出しは作り直す）
      if (!s.exited) return s
      if (serves.get(kind) === cur) { serves.delete(kind); break }
    }
    if (closed) throw new AdapterError('api', 'アダプタは close 済み')
    const p = startServe(kind, merge)
    serves.set(kind, p)
    p.catch(() => { if (serves.get(kind) === p) serves.delete(kind) }) // 失敗は次の呼び出しで作り直せる
    return p
  }

  /** セッションを interrupt する。止まったと確認できた（2xx）ときだけ true。 */
  async function interrupt(serve, sid, deadline) {
    try {
      const r = await serve.api(`/api/session/${sid}/interrupt`, { method: 'POST', deadline })
      return r.status >= 200 && r.status < 300
    } catch { return false }
  }

  /** serve をプロセスグループごと終了させる（SIGTERM → 待つ → SIGKILL）。 */
  async function killServe(serve) {
    stopServe(serve)
    await waitExit(serve, 1500)
    if (!serve.exited) { try { process.kill(-serve.child.pid, 'SIGKILL') } catch { try { serve.child.kill('SIGKILL') } catch { /* 既に無い */ } } }
    await waitExit(serve, 1000)
  }

  /**
   * セッションを止める。止まったと確認できなければ serve を終了させる（元のセッションが動き続けないように）。
   * interrupt は run の deadline ではなく halt 専用の短い期限で打ち切る（時間切れの後は run の残り時間が無く、
   * 応答する serve まで止めてしまうため）。
   */
  async function haltSession(serve, sid) {
    if (!(await interrupt(serve, sid, Date.now() + Math.min(apiTimeoutMs, HALT_INTERRUPT_MS)))) await killServe(serve)
  }

  async function pollState(serve, sid, deadline) {
    const [a, m] = await Promise.all([
      serve.api('/api/session/active', { deadline }).catch(() => null),
      serve.api(`/api/session/${sid}/message?order=desc&limit=1`, { deadline }).catch(() => null),
    ])
    const active = !!(a?.json?.data && typeof a.json.data === 'object' && sid in a.json.data)
    const tail = m?.json?.data?.[0] ?? null
    return { active, tailId: tail?.id ?? null, tailType: tail?.type ?? null, outcome: tail?.outcome ?? null }
  }

  async function pendingAsk(serve, sid, deadline) {
    for (const kind of ['permission', 'form']) {
      const r = await serve.api(`/api/session/${sid}/${kind}`, { deadline }).catch(() => null)
      if (r?.status === 200 && Array.isArray(r.json?.data) && r.json.data.length > 0) return kind
    }
    return null
  }

  /** prompt を送って完了を待つ。戻り値は終了の種類。 */
  async function runTurn(serve, sid, text, deadline, log) {
    const before = await pollState(serve, sid, deadline)
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
      let p
      try {
        p = await serve.api(`/api/session/${sid}/prompt`, { method: 'POST', body: JSON.stringify({ text }), deadline })
      } catch (e) {
        // 要求が届いたか分からない。セッションが動き続けないよう止め、止まったと確認できなければ serve を終了させる
        if (e?.timedOut) await haltSession(serve, sid)
        throw new AdapterError(e?.timedOut && Date.now() >= deadline ? 'timeout' : (e.kind ?? 'api'), e.message, { sessionRef: sid }) // run の時間を使い切った期限切れは timeout
      }
      if (p.status !== 200) throw new AdapterError('api', `prompt が HTTP ${p.status}`, { sessionRef: sid })
      let idleStreak = 0
      while (!terminal) {
        if (Date.now() >= deadline) return { kind: 'timeout' }
        if (serve.exited) throw new AdapterError('exit', `serve が終了した（${serve.exitInfo}）`, { sessionRef: sid })
        await Promise.race([woke, sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))])
        if (terminal) break
        // 取りこぼしの突き合わせ（SSE は再生されない）
        const ask = await pendingAsk(serve, sid, deadline)
        if (ask) { terminal = { kind: 'ask', via: 'poll', what: ask }; break }
        const st = await pollState(serve, sid, deadline)
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
      await getServe(null)
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
        const merge = mergeTarget(req)
        serve = await getServe(merge)
        if (merge && serve.repo !== merge.repo) throw new AdapterError('api', `PR ${merge.prNumber} の merge 用 serve は ${serve.repo} に固定済みで、${merge.repo} には使えない`)
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
      const failNow = (kind, message) => {
        try { appendFileSync(join(req.logDir, 'error.txt'), `${kind}: ${message}\n`) } catch { /* ログ失敗で止めない */ }
        return new AdapterError(kind, message, { sessionRef: sid })
      }
      // この location（worktree）で plugin が読み込まれたことを、prompt の前に確かめる（冒頭）
      if (!req.resume && !(await ensureLocation(serve, req.cwd))) {
        throw failNow('prereq', `ランナー専用の plugin がこの location で読み込まれたことを確かめられない（${req.cwd}）。プロジェクト設定で無効にされた可能性がある。ガード無しでは走らせない`)
      }
      if (modelNote) { try { appendFileSync(join(req.logDir, 'adapter.log'), `${modelNote}\n`) } catch { /* ログ失敗で止めない */ } }
      const logEv = (ev) => { try { appendFileSync(join(req.logDir, 'events.jsonl'), `${JSON.stringify({ t: Date.now(), type: ev.type, data: ev.data })}\n`) } catch { /* ログ失敗で本処理を止めない */ } }
      const fail = failNow

      let t
      try {
        t = await runTurn(serve, sid, req.resume ? req.resume.message : req.prompt, deadline, logEv)
      } catch (e) {
        if (e instanceof AdapterError) { try { appendFileSync(join(req.logDir, 'error.txt'), `${e.kind}: ${e.message}\n`) } catch { /* 同上 */ } }
        throw e
      }
      if (t.kind === 'timeout') {
        await haltSession(serve, sid)
        throw fail('timeout', `時間切れ（${req.timeoutMs} ms）。セッションを interrupt した`)
      }
      if (t.kind === 'ask') {
        await haltSession(serve, sid)
        throw fail('denied', `許可要求（${t.what}）が出たため interrupt した。ask は許可しない`)
      }
      if (t.kind === 'interrupted') throw fail('api', 'セッションが外部から interrupt された')
      if (t.kind === 'failed') {
        const msg = t.message || '実行が failed で終了した（詳細なし）'
        throw fail(USAGE_LIMIT_RE.test(msg) ? 'usage-limit' : 'api', msg)
      }
      // ガードの欠落の検知（冒頭）。記録より実行が多ければ、ガードを通らずに走った shell がある
      let shells
      try { shells = await shellCount(serve, sid) } catch (e) { throw fail('api', e.message) }
      const hooked = hookedCount(serve, sid)
      if (shells > hooked) throw fail('denied', `ガードの欠落: shell の実行 ${shells} 件に対し plugin の記録は ${hooked} 件。出力を使わない`)
      const text = await finalText(serve, sid)
      try { writeFileSync(join(req.logDir, 'final.txt'), text) } catch { /* 同上 */ }
      return { text, sessionRef: sid, usage: await usageOf(serve, sid) }
    },

    async close() {
      closed = true
      // 起動待ちの serve は起動の結果を待ってから止める。止める対象は serves に残る分ではなく、起動した serve すべて
      await Promise.all([...serves.values()].map((p) => p.catch(() => null)))
      const live = [...allServes]
      if (deleteSessions) {
        // 自分が作ったセッションだけを消す（子 → 親の順）。他のセッションは一覧もしない。
        const ids = [...sessions.keys()].reverse()
        const unresponsive = new Set() // 期限切れになった serve への削除は続けない（serve はこの後止める）
        for (const sid of ids) {
          const s = sessions.get(sid)
          if (s && !s.exited && !unresponsive.has(s)) await s.api(`/api/session/${sid}`, { method: 'DELETE' }).catch((e) => { if (e?.timedOut) unresponsive.add(s); return null })
        }
      }
      for (const s of live) stopServe(s)
      for (const s of live) {
        await waitExit(s, 3000)
        if (!s.exited) { try { process.kill(-s.child.pid, 'SIGKILL') } catch { /* 既に無い */ } }
      }
      serves.clear()
      allServes.clear()
      sessions.clear()
    },

    /**
     * 起動した serve（起動待ちを含む）のプロセスグループを同期で SIGKILL する（契約の任意メソッド。run.mjs がシグナル受信時と
     * exit 時に呼ぶ。close を待てない経路用）。セッションの削除はしない。
     */
    killSync() {
      for (const c of children) {
        try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* 既に無い */ } }
      }
    },
  }
}

// ランナーの Codex アダプタ。1 エージェント = 1 つの `codex exec` プロセス（修復ターンは `codex exec resume`）。
// 契約は _/local-plans/iit-runner-adapter-contract.md、実測と決定は _/local-plans/iit-runners-phase0.md の
// 0-1・0-2・0-3・0-4・0-7・0-8。アダプタは schema の検証・修復・並列制限・worktree 作成をしない（agent-host の責務）。
//
// 起動の形（要点）:
//   codex exec [resume] --json -o <logDir>/final-<tag>.txt --ignore-user-config [-m M] -c model_reasoning_effort="E"
//     [-C cwd（resume では付けない。spawn の cwd が効く）] --output-schema <logDir>/schema-strict.json
//     -c permissions={…} -c default_permissions="iit_read|iit_impl"
//     -c hooks.PreToolUse=[…agent-guard を呼ぶ hook…] --dangerously-bypass-hook-trust [<sessionRef>] -
//   プロンプトは標準入力（`-`）で渡す。
//
// CODEX_HOME: start で 1 回だけ解決し（toolConfig.codexHome → cfg.env.CODEX_HOME → ~/.codex）、exec・resume・delete の
// すべてに同じ値を明示で渡す。アダプタはホームへ何も作らず、認証ファイルを読まない・コピーしない。
// `--ignore-user-config` でホームの config.toml を読まない（-m は必ず明示する）。プロジェクトは trusted にしない
// （trusted にすると worktree の .codex/hooks.json が bypass で動くため。toolConfig.trustProject: true で付けられる）。
//
// toolConfig のキー（既定値は runner/config/default.json の toolConfig.codex。コード側の既定も同じ）:
//   deleteSessions: close でラン中に作ったセッションを `codex delete --force` する（契約どおり）
//   codexBin ("codex")・codexHome（上記）・guardScript（agent-guard.sh の絶対パス。既定は探索）・
//   trustProject (false)・killGraceMs (2000。SIGTERM から SIGKILL までの猶予)・extraWritePaths ([]。push 先のローカル origin 等)
// req の任意の追加: profile ('read' | 'impl'。permission profile の上書き)。
//
// ガード（0-3）: hook は fail-open（スクリプトが無い・exit 1・時間切れで素通し）なので、
//   (1) コマンド行は `bash <hook> … || exit 2`・timeout は指定しない、
//   (2) hook が呼び出しごとに 1 行ログを書き、終了時に「ログの増分 >= command_execution の数」を確かめる
//       （満たさなければ AdapterError('denied')・ガードの欠落）、
//   (3) resume にも同じ hook 引数を渡す（渡さない turn ではマージが通った）。
//   allowMerge は hook のコマンド行へ --merge-re を埋めるかどうかで切り替える。
//
// permission profile は 2 種（:read-only を土台に、ネットワークは有効）:
//   iit_read: worktree ではない cwd（メイン worktree。観測・状態・計画）。cwd は読み取りのみ・TMPDIR だけ書ける。
//   iit_impl: 隔離 worktree。worktree・<main>/.git/{objects,refs,logs,packed-refs,packed-refs.lock}・
//             <main>/.git/worktrees/<name>（正確なパス）・TMPDIR が書ける。.git/hooks と .git/config は読み取りのまま。
//   どちらも .codex は読み取り・認証ファイル（<CODEX_HOME>/auth.json と ~/.codex/auth.json）は deny。
//   既定は cwd の `.git` がファイルなら iit_impl、そうでなければ iit_read。req.profile で上書きできる（契約への任意の追加）。
//
// 時間切れ: プロセスグループへ SIGTERM、猶予後に SIGKILL（孫も止まる。setsid で抜けた孫は止められない）。
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdapterError } from '../lib/adapter-error.mjs'
import { MERGE_EXEC_COMMAND } from '../lib/guard.mjs'
import { decodeStrictText, strictifySchema } from './codex-strict.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const HOOK_SCRIPT = join(HERE, 'codex-hook.sh')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USAGE_LIMIT = /usage[ _-]?limit|UsageLimitExceeded/i

const q = (s) => JSON.stringify(s)
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** 見つかった agent-guard.sh の絶対パス（無ければ null）。 */
export function findGuardScript({ toolConfig = {}, skillDir, mainRoot }) {
  const cands = [
    toolConfig.guardScript,
    skillDir && join(skillDir, '..', 'init-codex', 'assets', 'hooks', 'agent-guard.sh'),
    mainRoot && join(mainRoot, '.codex', 'hooks', 'agent-guard.sh'),
    mainRoot && join(mainRoot, 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh'),
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return resolve(c)
  return null
}

/** cwd が linked worktree なら { gitdir, commonDir }（gitdir は <main>/.git/worktrees/<name>）。違えば null。 */
export function linkedWorktreeGit(cwd) {
  const f = join(cwd, '.git')
  try {
    if (!statSync(f).isFile()) return null
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(f, 'utf8'))
    if (!m) return null
    const gitdir = resolve(cwd, m[1])
    return { gitdir, commonDir: dirname(dirname(gitdir)) }
  } catch {
    return null
  }
}

/**
 * permission profile の `-c` 引数（2 引数 × 2）。純関数。
 * @param {{ kind: 'read'|'impl', cwd: string, codexHome: string, tmpDir: string, home: string, git: null | { gitdir: string, commonDir: string }, extraWritePaths?: string[] }} o
 */
export function buildProfileArgs({ kind, cwd, codexHome, tmpDir, home, git, extraWritePaths = [] }) {
  const name = kind === 'impl' ? 'iit_impl' : 'iit_read'
  const ws = kind === 'impl' ? { '.': 'write' } : { '.': 'read' }
  ws['.codex'] = 'read'
  const fs = { ':minimal': 'read', [tmpDir]: 'write' }
  if (kind === 'impl' && git) {
    for (const p of ['objects', 'refs', 'logs', 'packed-refs', 'packed-refs.lock']) fs[join(git.commonDir, p)] = 'write'
    fs[git.gitdir] = 'write'
  }
  for (const p of extraWritePaths) fs[p] = 'write'
  fs[join(codexHome, 'auth.json')] = 'deny'
  fs[join(home, '.codex', 'auth.json')] = 'deny'
  const entries = (o) => Object.entries(o).map(([k, v]) => `${q(k)}=${q(v)}`).join(', ')
  const prof = `extends=":read-only", filesystem={${entries(fs)}, ":workspace_roots"={${entries(ws)}}}, network={enabled=true}`
  return ['-c', `permissions={${name}={${prof}}}`, '-c', `default_permissions=${q(name)}`]
}

/** hook の `-c` 引数（`--dangerously-bypass-hook-trust` を含む）。 */
export function buildHookArgs({ hookScript, guardScript, hookLog, allowMerge }) {
  const parts = ['bash', shq(hookScript), '--guard', shq(guardScript), '--log', shq(hookLog)]
  if (allowMerge) parts.push('--merge-re', shq(MERGE_EXEC_COMMAND.source))
  const command = `${parts.join(' ')} || exit 2`
  return ['-c', `hooks.PreToolUse=[{matcher="^Bash$", hooks=[{type="command", command=${q(command)}}]}]`, '--dangerously-bypass-hook-trust']
}

/** JSONL（1 行 1 イベント）から必要な情報を集める。純関数。 */
export function summarizeEvents(jsonl) {
  const s = { threadIds: [], commandIds: new Set(), commandAnon: 0, lastAgentMessage: null, turnFailed: null, errors: [], completed: 0, usage: null }
  for (const line of String(jsonl).split('\n')) {
    if (!line.startsWith('{')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') s.threadIds.push(e.thread_id)
    else if (e.type === 'turn.completed') {
      s.completed++
      const u = e.usage ?? {}
      s.usage ??= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }
      for (const k of Object.keys(s.usage)) s.usage[k] += Number(u[k]) || 0
    } else if (e.type === 'turn.failed') s.turnFailed = String(e.error?.message ?? e.message ?? 'turn.failed').slice(0, 500)
    else if (e.type === 'error') s.errors.push(String(e.message ?? e.error?.message ?? 'error').slice(0, 500))
    else if ((e.type === 'item.started' || e.type === 'item.completed') && e.item?.type === 'command_execution') {
      if (typeof e.item.id === 'string') s.commandIds.add(e.item.id)
      else if (e.type === 'item.completed') s.commandAnon++
    } else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') s.lastAgentMessage = e.item.text
  }
  s.commandCount = s.commandIds.size + s.commandAnon
  return s
}

/** 終了状態から失敗の kind を決める。純関数。失敗でなければ null。 */
export function classifyFailure({ timedOut, spawnError, exitCode, signal, summary }) {
  if (timedOut) return { kind: 'timeout', message: '時間切れ' }
  if (spawnError) return { kind: 'exit', message: `codex を起動できない: ${spawnError}` }
  const msg = summary.turnFailed ?? summary.errors.at(-1) ?? null
  const failed = summary.turnFailed !== null || (exitCode !== 0 && summary.errors.length > 0)
  if (failed) return { kind: USAGE_LIMIT.test(msg) ? 'usage-limit' : 'api', message: msg }
  if (exitCode !== 0) return { kind: 'exit', message: `codex が異常終了（終了コード ${exitCode ?? '-'}、signal ${signal ?? '-'}）` }
  return null
}

function execFileP(file, args, opts) {
  return new Promise((res) => execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => res({ err, stdout, stderr })))
}

const killGroup = (pid, sig) => { try { process.kill(-pid, sig) } catch { /* 既に終了 */ } }

/**
 * @param {{ skillDir: string, mainRoot: string, runDir: string, toolConfig?: object, guard?: object, env?: object }} cfg
 */
export function createAdapter(cfg) {
  const tc = cfg.toolConfig ?? {}
  const bin = tc.codexBin ?? 'codex'
    const tmpDir = join(cfg.runDir, 'tmp')
  const baseEnv = { ...(cfg.env ?? process.env) }
  const home = baseEnv.HOME ?? homedir()
  let codexHome = null
  const killGraceMs = tc.killGraceMs ?? 2000
  const sessions = new Set()
  const running = new Set()
  let guardScript = null
  let started = false

  const resolveCodexHome = () => resolve(tc.codexHome ?? baseEnv.CODEX_HOME ?? join(home, '.codex'))

  const childEnv = () => {
    const env = { ...baseEnv, CODEX_HOME: codexHome, TMPDIR: tmpDir }
    // 追跡ブランチの自動設定を止める（0-2）。既存の GIT_CONFIG_* があれば続きの番号へ足す。
    const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0
    env[`GIT_CONFIG_KEY_${n}`] = 'branch.autoSetupMerge'
    env[`GIT_CONFIG_VALUE_${n}`] = 'false'
    env.GIT_CONFIG_COUNT = String(n + 1)
    return env
  }

  async function start() {
    if (started) return
    codexHome = resolveCodexHome()
    const r = await execFileP(bin, ['--version'], { env: childEnv(), timeout: 30000 })
    if (r.err) throw new AdapterError('prereq', `codex を実行できない（${bin}）: ${r.err.code ?? r.err.message}`)
    const j = await execFileP('jq', ['--version'], { env: childEnv(), timeout: 30000 })
    if (j.err) throw new AdapterError('prereq', 'jq が見つからない（Codex の hook が fail-closed になるため必須）')
    guardScript = findGuardScript({ toolConfig: tc, skillDir: cfg.skillDir, mainRoot: cfg.mainRoot })
    if (!guardScript) throw new AdapterError('prereq', 'agent-guard.sh が見つからない（skills/init-codex/assets/hooks/ か toolConfig.guardScript）')
    if (!existsSync(HOOK_SCRIPT)) throw new AdapterError('prereq', 'codex-hook.sh が見つからない')
    mkdirSync(tmpDir, { recursive: true })
    started = true
  }

  const countLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0)

  async function run(req) {
    await start()
    const { prompt, schema, model, effort, cwd, allowMerge = false, timeoutMs, resume = null, logDir } = req
    mkdirSync(logDir, { recursive: true })
    const n = readdirSync(logDir).filter((f) => /^events-t\d+\.jsonl$/.test(f)).length + 1
    const tag = `t${n}`
    const hookLog = join(logDir, 'hook.log')
    const lastPath = join(logDir, `final-${tag}.txt`)
    const git = linkedWorktreeGit(cwd)
    const kind = req.profile ?? (git ? 'impl' : 'read')

    const args = ['exec']
    if (resume) args.push('resume')
    args.push('--json', '-o', lastPath, '--ignore-user-config')
    if (model) args.push('-m', model)
    if (effort) args.push('-c', `model_reasoning_effort=${q(effort)}`)
    if (!resume) args.push('-C', cwd)
    if (tc.trustProject) args.push('-c', `projects={${q(cwd)}={trust_level="trusted"}}`)
    if (schema) {
      const sp = join(logDir, 'schema-strict.json')
      writeFileSync(sp, JSON.stringify(strictifySchema(schema)))
      args.push('--output-schema', sp)
    }
    args.push(...buildProfileArgs({ kind, cwd, codexHome, tmpDir, home, git, extraWritePaths: tc.extraWritePaths }))
    args.push(...buildHookArgs({ hookScript: HOOK_SCRIPT, guardScript, hookLog, allowMerge: Boolean(allowMerge) }))
    if (resume) args.push(resume.sessionRef)
    args.push('-')
    writeFileSync(join(logDir, `argv-${tag}.json`), JSON.stringify(args))

    const hookBefore = countLines(hookLog)
    const input = resume ? resume.message : prompt
    const res = await new Promise((done) => {
      let out = ''
      let err = ''
      let timedOut = false
      let settled = false
      const p = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      running.add(p)
      const termTimer = setTimeout(() => {
        timedOut = true
        killGroup(p.pid, 'SIGTERM')
        setTimeout(() => killGroup(p.pid, 'SIGKILL'), killGraceMs).unref()
        // 子が終了しなくても返す（close を待たない上限）
        setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL' }), killGraceMs + 1000).unref()
      }, timeoutMs)
      const finish = ({ exitCode, signal, spawnError }) => {
        if (settled) return
        settled = true
        clearTimeout(termTimer)
        running.delete(p)
        if (timedOut) killGroup(p.pid, 'SIGKILL')
        done({ out, err, timedOut, exitCode, signal, spawnError })
      }
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('error', (e) => finish({ exitCode: null, spawnError: e.code ?? e.message }))
      p.on('close', (exitCode, signal) => finish({ exitCode, signal }))
      p.stdin.on('error', () => {})
      p.stdin.end(input)
    })

    writeFileSync(join(logDir, `events-${tag}.jsonl`), res.out)
    writeFileSync(join(logDir, `stderr-${tag}.txt`), res.err)
    const summary = summarizeEvents(res.out)
    for (const id of summary.threadIds) if (UUID.test(id)) sessions.add(id)
    const sessionRef = summary.threadIds.find((id) => UUID.test(id)) ?? resume?.sessionRef ?? undefined
    const extra = sessionRef ? { sessionRef } : {}

    const failure = classifyFailure({ ...res, summary })
    if (failure) throw new AdapterError(failure.kind, failure.message, extra)

    const hookLines = countLines(hookLog) - hookBefore
    if (hookLines < summary.commandCount) {
      throw new AdapterError('denied', `ガードの欠落: hook の呼び出し ${hookLines} 件がコマンド実行 ${summary.commandCount} 件より少ない`, extra)
    }
    let text = null
    try { text = readFileSync(lastPath, 'utf8') } catch { /* 下で代替 */ }
    if (text === null || text.trim() === '') text = summary.lastAgentMessage
    if (text === null || text.trim() === '') throw new AdapterError('exit', '最終応答が空', extra)
    writeFileSync(lastPath, text)
    if (!sessionRef) throw new AdapterError('exit', 'セッション ID を得られない（thread.started が無い）')
    return { text: schema ? decodeStrictText(schema, text) : text, sessionRef, ...(summary.usage ? { usage: summary.usage } : {}) }
  }

  async function close() {
    for (const p of running) killGroup(p.pid, 'SIGKILL')
    running.clear()
    const result = { deleted: [], failed: [] }
    if (!(tc.deleteSessions ?? false)) return result
    for (const id of sessions) {
      const r = await execFileP(bin, ['delete', '--force', id], { env: childEnv(), timeout: 60000 })
      ;(r.err ? result.failed : result.deleted).push(id)
    }
    sessions.clear()
    return result
  }

  return { name: 'codex', start, run, close }
}

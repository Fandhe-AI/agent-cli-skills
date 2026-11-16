#!/usr/bin/env node
// implement-issue-tree の Codex / OpenCode 版ランナーの起動口。
//
//   node <skillDir>/runner/run.mjs --tool codex|opencode --args <args.json> [--config <config.json>] [--max-parallel N] [--dry-run] [--no-build-check]
//
// 役割: 生成物（scripts/implement-issue-tree.js）を無変更のまま評価し、agent 引数に agent-host（lib/agent-host.mjs）が
// 作った関数を渡して、Workflow 版と同じホスト判断を Codex / OpenCode のエージェントで動かす。起動前の拒否
// （引数・設定・gh 認証・アダプタの有無・生成物の鮮度）と、結果の保存・アダプタの後片づけ・明示の exit を担う。
//
// 終了コード（計画 C の仕様）:
//   0 ホストが return した
//   1 ホストが例外で終わった
//   2 引数の誤り（CLI・args.json・設定ファイル）
//   3 前提の不足（gh 認証・アダプタの不在・生成物の鮮度・アダプタの start() 失敗）
// 2 / 3 の経路（アダプタの生成・start() の失敗を除く）は _/iit-runner/<runId>/ を作る前に抜ける（何も書かない）。
//
// 出力の形（通し確認の判定器が読む。変えるときは判定器とそろえる）:
//   <mainRoot>/_/iit-runner/<runId>/result.json と stdout（同じ JSON を 1 つ。stdout は 1 行）:
//     { runId, tool, exitCode, workflowSha256, startedAt, endedAt, result, error? }
//     result はホストの return 値そのまま（dryRun なら startable・blocked などの見積りがそのまま入る）。
//     exitCode が 0 以外のとき result は null で、error に理由を入れる。アダプタの生成・start() の失敗（3）でも書く。
//   <mainRoot>/_/iit-runner/<runId>/agents/<seq 4 桁>-<label>/meta.json（agent() 1 回につき 1 つ。lib/agent-host.mjs）:
//     { label, seq, sessionRef, outcome, kind?, startedAt, endedAt, ... }
//     outcome は ok（schema に適合した値を返した。修復ターン後も ok）/ null（未返却）/ exec-spec（実行仕様で
//     直接実行した段。sessionRef は null）/ throw（呼び出しの不備・worktree 作成失敗で例外）。kind は AdapterError の kind。
//     sessionRef は最後に使った会話の参照（修復ターンで同じ値ならそのまま）。status・reason は詳細。
//   <mainRoot>/_/iit-runner/<runId>/host.log はホストの log() と phase()。
//
// 明示の exit: 生成物は setTimeout があれば 5 分の tick を動かす（phase0 0-5）。ホストの return 後もイベントループが
// 残るため、結果を書き切ってから process.exit する。
//
// 鮮度: 生成物の SHA-256 を必ず記録する。開発用チェックアウト（<repo>/dev/implement-issue-tree/scripts/build-workflow.mjs が
// ある）では `build-workflow.mjs --check` も実行する（約 100 秒かかる。--no-build-check で省ける）。配布先には
// ビルダーが無いので SHA-256 の記録だけになる。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentHost } from './lib/agent-host.mjs'
import { isAdapterError } from './lib/adapter-error.mjs'
import { codexRules, opencodeRules } from './lib/guard.mjs'
import { loadWorkflow } from './lib/load-workflow.mjs'
import { loadConfig, TOOLS } from './lib/models.mjs'
import { newRunId, resolveMainRoot } from './lib/worktree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKILL_DIR = dirname(HERE)
export const ADAPTERS_DIR = join(HERE, 'adapters')
const USAGE = '使い方: node run.mjs --tool codex|opencode --args <args.json> [--config <config.json>] [--max-parallel N] [--dry-run] [--no-build-check]'

export class UsageError extends Error {}

/** CLI 引数を読む。誤りは UsageError（終了コード 2）。 */
export function parseCli(argv) {
  const out = { tool: null, argsPath: null, configPath: null, maxParallel: null, dryRun: false, buildCheck: true }
  const value = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} に値が無い`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tool') out.tool = value(i++, a)
    else if (a === '--args') out.argsPath = value(i++, a)
    else if (a === '--config') out.configPath = value(i++, a)
    else if (a === '--max-parallel') {
      const v = value(i++, a)
      if (!/^[1-9][0-9]{0,2}$/.test(v)) throw new UsageError('--max-parallel は 1〜999 の整数')
      out.maxParallel = Number(v)
    } else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-build-check') out.buildCheck = false
    else throw new UsageError(`未知の引数: ${String(a).slice(0, 40)}`)
  }
  if (!TOOLS.includes(out.tool)) throw new UsageError(`--tool は ${TOOLS.join(' / ')}`)
  if (out.argsPath === null) throw new UsageError('--args が無い')
  return out
}

/** args.json を読む。パース済みのオブジェクトで返す（生成物は文字列の args を別の分岐で扱うため）。 */
export function readArgsFile(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new UsageError(`args.json を読めない: ${String(e?.message ?? e).slice(0, 160)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('args.json の最上位はオブジェクト')
  return parsed
}

/** gh の認証確認。失敗は終了コード 3。 */
export function checkGhAuth() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 60_000 })
  return r.status === 0 ? { ok: true } : { ok: false, reason: r.error ? `gh を起動できない（${r.error.code ?? r.error.message}）` : `gh auth status が終了コード ${r.status}` }
}

/** 開発用チェックアウトなら build-workflow.mjs --check を実行する。ビルダーが無ければ照合なし（ok）。 */
export function checkBuild(skillDir) {
  const builder = join(skillDir, '..', '..', 'dev', 'implement-issue-tree', 'scripts', 'build-workflow.mjs')
  if (!existsSync(builder)) return { ok: true, checked: false }
  const r = spawnSync(process.execPath, [builder, '--check'], { encoding: 'utf8', timeout: 600_000 })
  return r.status === 0 ? { ok: true, checked: true } : { ok: false, checked: true, reason: `build-workflow.mjs --check が終了コード ${r.status}` }
}

/** アダプタを読み込む。無い・形が違うときは null（終了コード 3）。 */
export async function importAdapter(tool, dir = ADAPTERS_DIR) {
  const path = join(dir, `${tool}.mjs`)
  if (!existsSync(path)) return null
  const mod = await import(pathToFileURL(path).href)
  return typeof mod.createAdapter === 'function' ? mod : null
}

/**
 * 起動から終了コードまで。テストは deps で外部とのやりとり（gh・アダプタ・生成物・メイン worktree）を差し替える。
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv, deps = {}) {
  const {
    stdout = (s) => new Promise((r) => process.stdout.write(s, () => r())),
    stderr = (s) => { process.stderr.write(s) },
    cwd = process.cwd(),
    ghAuth = checkGhAuth,
    build = checkBuild,
    loadAdapter = importAdapter,
    load = loadWorkflow,
    mainRootOf = resolveMainRoot,
    makeRunId = newRunId,
    env = process.env,
    onSignal = (handler) => { process.once('SIGINT', handler); process.once('SIGTERM', handler) },
  } = deps
  const err = (msg) => stderr(`${msg}\n`)

  // ---- 2: 引数・設定 ----
  let cli, args, config
  try {
    cli = parseCli(argv)
    args = readArgsFile(resolve(cwd, cli.argsPath))
    try {
      config = cli.configPath === null ? loadConfig() : loadConfig(resolve(cwd, cli.configPath))
    } catch (e) {
      throw new UsageError(`設定を読めない: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`ランナー: ${e.message}\n${USAGE}`)
      return 2
    }
    throw e
  }
  if (args.skillDir === undefined) args.skillDir = SKILL_DIR
  if (typeof args.skillDir !== 'string' || !isAbsolute(args.skillDir)) {
    err('ランナー: args.skillDir は絶対パス')
    return 2
  }
  if (cli.dryRun) args.dryRun = true

  // ---- 3: 前提（安い順。どれも _/iit-runner を作る前） ----
  const prereq = (msg) => { err(`ランナー: 前提の不足: ${msg}`); return 3 }
  const gh = ghAuth()
  if (!gh.ok) return prereq(gh.reason ?? 'gh の認証を確認できない')
  let mod
  try {
    mod = await loadAdapter(cli.tool)
  } catch (e) {
    return prereq(`アダプタ ${cli.tool} を読み込めない: ${String(e?.message ?? e).slice(0, 160)}`)
  }
  if (!mod) return prereq(`アダプタ adapters/${cli.tool}.mjs が無い`)
  let workflow
  try {
    workflow = load()
  } catch (e) {
    return prereq(`生成物を読み込めない: ${String(e?.message ?? e).slice(0, 160)}`)
  }
  if (cli.buildCheck) {
    const b = build(SKILL_DIR)
    if (!b.ok) return prereq(`生成物が開発ファイルと一致しない（${b.reason}）`)
  }
  let mainRoot
  try {
    mainRoot = realpathSync(mainRootOf(cwd))
  } catch (e) {
    return prereq(`メイン worktree を特定できない: ${String(e?.message ?? e).slice(0, 160)}`)
  }

  // ---- ラン ----
  const runId = makeRunId()
  const startedAt = new Date().toISOString()
  const runDir = join(mainRoot, '_', 'iit-runner', runId)
  mkdirSync(join(runDir, 'agents'), { recursive: true })
  const hostLog = join(runDir, 'host.log')
  const log = (m) => {
    const line = `${String(m)}\n`
    try { writeFileSync(hostLog, line, { flag: 'a' }) } catch { /* ログの失敗でホストを止めない */ }
    stderr(line)
  }
  const phase = (name) => log(`== phase: ${String(name)}`)
  log(`ランナー: tool=${cli.tool} runId=${runId} workflow=${workflow.sha256} (${workflow.bytes} B)`)

  // finish は result.json と stdout に同じ JSON を書く（形はファイル冒頭の「出力の形」）
  const finish = async (exitCode, result, error) => {
    const body = { runId, tool: cli.tool, exitCode, workflowSha256: workflow.sha256, startedAt, endedAt: new Date().toISOString(), result: result ?? null }
    if (error !== undefined) body.error = error
    try { writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(body, null, 2)}\n`) } catch (e) { log(`⚠️ ランナー: result.json を書けない: ${e?.message ?? e}`) }
    await stdout(`${JSON.stringify(body)}\n`)
    return exitCode
  }
  let adapter
  try {
    adapter = mod.createAdapter({
      skillDir: args.skillDir,
      mainRoot,
      runDir,
      toolConfig: { deleteSessions: config.cleanup.deleteSessions, models: config.models[cli.tool], timeoutsSec: config.timeoutsSec },
      guard: { codexRules, opencodeRules },
      env,
    })
  } catch (e) {
    const why = isAdapterError(e) ? `${e.kind}: ${e.message}` : String(e?.message ?? e)
    prereq(`アダプタを作れない: ${why.slice(0, 400)}`)
    return finish(3, null, `アダプタを作れない: ${why.slice(0, 400)}`)
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await adapter.close()
    } catch (e) {
      log(`⚠️ ランナー: アダプタの後片づけが失敗した: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }

  try {
    await adapter.start()
  } catch (e) {
    await close()
    const why = isAdapterError(e) ? `${e.kind}: ${e.message}` : String(e?.message ?? e)
    prereq(`アダプタの起動に失敗: ${why.slice(0, 400)}`)
    return finish(3, null, `アダプタの起動に失敗: ${why.slice(0, 400)}`)
  }
  // 中断時もアダプタが起動したプロセス・セッションを片づける
  onSignal(() => { close().finally(() => process.exit(130)) })

  const agent = createAgentHost({
    adapter,
    cfg: { config, skillDir: args.skillDir, mainRoot, runId, runDir, args, maxParallel: cli.maxParallel ?? undefined, log },
  })
  let code
  let result = null
  let error
  try {
    result = await workflow.run(args, agent, log, phase)
    code = 0
  } catch (e) {
    code = 1
    error = String(e?.stack ?? e?.message ?? e).slice(0, 4000)
    log(`ランナー: ホストが例外で終わった: ${String(e?.message ?? e).slice(0, 400)}`)
  }
  log(`ランナー: agent() ${agent.stats.calls} 回（アダプタ ${agent.stats.adapterCalls} 回）`)
  await close()
  return finish(code, result, error)
}

// CLI として起動されたときだけ実行する（テストは import して main を呼ぶ）
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  // パイプ先では stdout / stderr の書き込みが非同期になり得るので、空の書き込みの完了（先行分の書き出し後）を待ってから exit する
  const flush = () => Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write('', () => r()))))
  main(process.argv.slice(2)).then(
    (code) => flush().then(() => process.exit(code)),
    (e) => {
      process.stderr.write(`ランナー: 想定外の例外: ${String(e?.stack ?? e)}\n`)
      flush().then(() => process.exit(1))
    },
  )
}

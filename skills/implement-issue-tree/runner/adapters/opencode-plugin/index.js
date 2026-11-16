// iit ランナー専用の OpenCode plugin: shell 実行許可（permission.evaluate）で共通ガード agent-guard.sh を呼ぶ。
// Codex 側の codex-hook.sh と同じ意味にそろえてある。ログの形式（`<epoch 秒>\t<コード>`）・共通のコード（allow・
// allow-mergeform・deny-guard-missing・deny-error・deny-noresult・deny:<理由>）・拒否の文言も codex-hook.sh と同じ
// （runner-guard-parity.test.mjs が縛る）。plugin だけのコードは deny-bad-event・deny-protected-edit・deny-budget。
//
// 配布物の plugin（init-opencode）との違い: ランナーのセッションは親を持たない top-level になり、配布物の plugin は
// それを main とみなしてマージ・承認を制限しない。そのためここでは agent-guard.sh を「常に subagent=true」で呼ぶ。
//
// 設定は config の plugins のオブジェクト形（{ package, options }）で渡る（ctx.options）。エージェントのシェルからは変えられない。
//   guardScript  agent-guard.sh の絶対パス（必須）
//   log          呼び出しごとに 1 行を追記するログ（必須。コマンド文字列は書かない）
//   mergeRes     配列。allowMerge の serve だけに渡される正規表現（source）。1 つでも一致したコマンドは素通し
//                （merge-exec の完全一致の 1 形。正本は runner/lib/guard.mjs の MERGE_EXEC_COMMAND）
//   markerPath   読み込まれた目印を書くファイル。nonce と組で、アダプタが start で確かめる
//   nonce        serve ごとの乱数
//
// fail-closed: 設定の不備・ガードが無い・起動できない・時間切れ・異常終了・結果行なし・契約外の出力はすべて deny。
// ガードとの契約は agent-guard.sh 冒頭が正典: stdin {"command", "subagent"}、stdout 最終行 `AGENT_GUARD_RESULT allow|deny <理由>`。
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

const GUARD_TIMEOUT_MS = 5000
const TOTAL_BLOCK_BUDGET_MS = 10000
const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? 'bash'
const RESULT_LINE = /^AGENT_GUARD_RESULT (allow|deny(?: ([a-z-]+))?)$/

// resources がコマンドでないと分かっている組み込み action。これ以外（名前が変わった shell・MCP・plugin 定義）は
// resources をコマンドとしてガードへ渡す（配布物の plugin と同じ扱い）。
const NON_SHELL_ACTIONS = new Set([
  'read', 'glob', 'grep', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory',
  'browser', 'experimental_image_generate', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource',
])

const deny = (event, message) => { event.effect = 'deny'; event.message = message }

// ガードの判定結果のコード → 拒否の文言（codex-hook.sh の emit_deny と同じ文字列）
const guardDenyMessage = (code) => {
  if (code === 'deny-guard-missing') return 'iit-runner: ガードが見つからないため拒否した'
  if (code === 'deny-error') return 'iit-runner: ガードが異常終了したため拒否した'
  if (code.startsWith('deny:')) return `iit-runner: ガードの判定により拒否した（${code}）`
  return 'iit-runner: ガードの結果を得られないため拒否した'
}

/** 設定を検査して正規化する。不備があれば null（全 deny にする）。 */
function readOptions(options) {
  const o = options && typeof options === 'object' ? options : {}
  if (typeof o.guardScript !== 'string' || o.guardScript === '' || typeof o.log !== 'string' || o.log === '') return null
  let mergeRes = []
  try {
    mergeRes = (Array.isArray(o.mergeRes) ? o.mergeRes : []).map((src) => new RegExp(String(src)))
  } catch {
    return null
  }
  return { guardScript: o.guardScript, log: o.log, mergeRes, markerPath: o.markerPath, nonce: o.nonce }
}

function judge(guardScript, command, timeoutMs) {
  if (!existsSync(guardScript)) return { deny: true, code: 'deny-guard-missing' }
  const r = spawnSync(BASH, [guardScript], { input: JSON.stringify({ command, subagent: true }), encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' })
  if (r.error || r.signal || typeof r.stdout !== 'string') return { deny: true, code: 'deny-error' }
  const lines = r.stdout.split('\n').filter((l) => l !== '')
  const m = RESULT_LINE.exec(lines[lines.length - 1] ?? '')
  if (!m) return { deny: true, code: 'deny-noresult' }
  if (m[1] === 'allow') return r.status === 0 ? { deny: false } : { deny: true, code: 'deny-error' }
  return { deny: true, code: `deny:${m[2] ?? 'unknown'}` }
}

function evaluate(opts, event) {
  const log = (what) => { try { appendFileSync(opts.log, `${Math.floor(Date.now() / 1000)}\t${what}\n`) } catch { /* ログ失敗は判定を変えない */ } }
  if (event.effect === 'deny') return
  const action = event.action
  if (typeof action !== 'string') { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
  if (NON_SHELL_ACTIONS.has(action)) return
  const resources = event.resources
  if (!Array.isArray(resources)) { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
  // 編集系はパスで、ガード本体と plugin の置き場への書き込みだけを拒否する。
  if (action !== 'shell') {
    if (resources.some((r) => typeof r === 'string' && r.includes('opencode-guard'))) { log('deny-protected-edit'); return deny(event, 'iit-runner: ガードの置き場は編集できない') }
    if (action === 'edit') return
  }
  if (resources.length === 0) return
  const deadline = Date.now() + TOTAL_BLOCK_BUDGET_MS
  for (const command of resources) {
    if (typeof command !== 'string') { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
    if (opts.mergeRes.some((re) => re.test(command))) { log('allow-mergeform'); continue }
    const remaining = deadline - Date.now()
    if (remaining <= 0) { log('deny-budget'); return deny(event, 'iit-runner: 判定の時間の上限を超えたため拒否した') }
    const v = judge(opts.guardScript, command, Math.min(GUARD_TIMEOUT_MS, remaining))
    if (v.deny) { log(v.code); return deny(event, guardDenyMessage(v.code)) }
    log('allow')
  }
}

export default {
  id: 'iit-runner-guard',
  async setup(ctx) {
    const opts = readOptions(ctx.options)
    if (opts?.markerPath && opts.nonce) writeFileSync(opts.markerPath, String(opts.nonce))
    await ctx.permission.hook('evaluate', async (event) => {
      try {
        if (!opts) return deny(event, 'iit-runner: plugin の設定が不正なため拒否した')
        evaluate(opts, event)
      } catch (e) {
        try { deny(event, 'iit-runner: 判定中の例外のため拒否した') } catch { throw e }
      }
    })
  },
}

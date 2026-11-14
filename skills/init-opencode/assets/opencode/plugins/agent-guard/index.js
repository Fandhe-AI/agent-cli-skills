// agent-guard plugin: OpenCode の shell 実行許可（permission.evaluate）で、共通ガード
// agent-guard.sh を呼び、deny 判定のコマンドを止める主判定の層。
//
// 配置の前提（対象リポジトリ）:
//   .opencode/plugins/agent-guard/index.js   -- このファイル
//   .opencode/hooks/agent-guard.sh           -- 共通ガード（import.meta.url から ../../hooks/ で解決）
// package.json も @opencode/plugin の import も不要な素の object export（Phase 0 O2 で読み込みを確認）。
//
// ガードとの契約（agent-guard.sh の冒頭が正典）:
//   stdin  {"command": "<文字列>", "subagent": true | false | null}
//   stdout 最後の 1 行が `AGENT_GUARD_RESULT allow`（終了 0）か `AGENT_GUARD_RESULT deny <理由コード>`（終了 2）
//
// 方針は fail-closed。ガードが無い・起動できない・時間切れ・異常終了・結果行なし・契約外の出力は
// すべて deny にする。`ask` は使わない（`opencode run --auto` では ask が自動承認されるため）。
// 位置づけは best-effort の攻撃面削減で承認境界ではない。実強制はサーバー側の branch protection が担う。
//
// API の形が想定と違ったときも deny 側に倒す（fail-closed）。
//   - ctx.session.get の返り値が平らな { id, parentID?, ... } で id が sessionID と一致したときだけ main /
//     サブエージェントを確定する。包まれた形・id の不一致・型違いは「判定不能」（null）としてマージ制限を外さない。
//   - action 名が "shell" から変わっても素通しにしない。shell でないと分かっている組み込み action 以外は、
//     resources をコマンドとしてガードへ渡す（MCP の `*` のようにコマンドでないものはガードが allow する）。
//   - ガード本体・plugin・設定ファイルへの edit は deny する。opencode.jsonc の edit deny は大文字小文字を
//     区別して照合されるため（macOS・Windows のファイルシステムは区別しない）、その取りこぼしをここで塞ぐ。
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { posix } from "node:path"
import { fileURLToPath } from "node:url"

const GUARD_PATH = fileURLToPath(new URL("../../hooks/agent-guard.sh", import.meta.url))
const GUARD_TIMEOUT_MS = 5000
const SESSION_TIMEOUT_MS = 3000
// 1 つの event でガードの同期実行（spawnSync）に使える時間の合計。spawnSync は OpenCode 全体のイベントループを
// 止めるため、resources が多いと「件数 × 5 秒」の間ほかの処理がすべて止まる。合計がこの値に達したら、残りの
// コマンドは実行せず deny にする（fail-closed）。1 回の実行は 5 秒の上限のまま、残りが 5 秒に満たなければ残りまで。
const TOTAL_BLOCK_BUDGET_MS = 10000

// ガードを動かす bash。PATH 先頭に置かれた偽の bash に差し替えられないよう、固定の場所を先に探し、
// どちらも無い環境だけ PATH 探索（"bash"）に落とす。
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p)) ?? "bash"

// 理由コード → ユーザーとモデルに返す固定文。入力のコマンド文字列は一切含めない。
const MESSAGES = {
  "no-verify": "agent-guard: git の --no-verify（および commit の -n）は禁止されている",
  "force-push": "agent-guard: 履歴を書き換える git push（--force / -f / --force-with-lease / --force-if-includes / +refspec）は禁止されている。必要なら人間に依頼すること",
  "merge-guard": "agent-guard: サブエージェントからのマージ・承認・gh の alias / extension 実行は禁止されている",
  "repo-settings": "agent-guard: サブエージェントからのリポジトリ設定・ruleset の変更は禁止されている",
  obfuscated: "agent-guard: 難読化されたコマンド（$'...'・$IFS 展開）は許可されない",
  "nesting-limit": "agent-guard: コマンドの入れ子が深い、または $( ・バッククォート・ヒアドキュメントの閉じを解析できないため拒否した",
  "bad-input": "agent-guard: ガードがコマンドを解釈できなかったため拒否した",
  "no-jq": "agent-guard: jq が見つからないため拒否した（jq を導入すること）",
  "internal-error": "agent-guard: ガードが内部エラーで終了したため拒否した",
}
const MSG_GUARD_MISSING = "agent-guard: .opencode/hooks/agent-guard.sh が見つからないため拒否した"
const MSG_GUARD_FAILED = "agent-guard: ガードの実行に失敗した（異常終了・時間切れ・結果行なし）ため拒否した"
const MSG_BUDGET = "agent-guard: 1 つの shell 実行に含まれるコマンドが多く、判定に使える時間の上限を超えたため拒否した。コマンドを分けて実行すること"
const MSG_INTERNAL = "agent-guard: 判定中に例外が発生したため拒否した"
const MSG_BAD_EVENT = "agent-guard: shell の対象を解釈できなかったため拒否した"
const MSG_PROTECTED_EDIT = "agent-guard: ガード本体・plugin・設定ファイル（.opencode/hooks・.opencode/plugins・opencode.jsonc）はエージェントから編集できない。更新は人間が setup スキル（update-opencode）か端末で行うこと"

// shell ではなく、resources がコマンドでないと分かっている組み込み action（v2.2.7 の実測と参照の Actions 表）。
// これ以外（名前が変わった shell・MCP の `<server>_<tool>`・plugin 定義の action）は resources をガードへ渡す。
// `execute`（Code Mode）は含めない: v2.2.7 の実機では evaluate event が観測できず、呼び出せるツールの範囲も確定できなかったため、
// event が来たときは未知の action と同じに扱う。
const NON_SHELL_ACTIONS = new Set([
  "read", "glob", "grep", "subagent", "skill", "question", "webfetch", "websearch", "external_directory",
  "browser", "experimental_image_generate", "opencode_list_mcp_resources", "opencode_read_mcp_resource",
])

// 編集を許さないパス（互換文字の正規化・大文字小文字の畳み込み・区切りの統一・`./` と `..` の正規化後に照合する）。
// resource は起動ディレクトリからの相対パスで、サブディレクトリから起動すると `../.opencode/hooks/...` の形になる
// （v2.2.7 の実測）ため、先頭固定にしない。`.opencode/plugin/`（単数形）は v2.2.7 の実機で plugins/ と同じく
// 読み込まれて実行された。`.opencode/tool(s)/`・`command(s)/` は読み込まれなかったため含めない。
const PROTECTED_EDIT = [/(^|\/)\.opencode\/(hooks|plugins?)\//, /(^|\/)opencode\.jsonc?$/]

function isProtectedEdit(resource) {
  // NFKC で全角などの互換文字を寄せ、toUpperCase().toLowerCase() で ſ（→ S → s）のような単純な小文字化では
  // 畳み込まれない文字を畳み込む。
  const folded = resource.normalize("NFKC").toUpperCase().toLowerCase()
  const p = posix.normalize(folded.replaceAll("\\", "/"))
  return PROTECTED_EDIT.some((re) => re.test(p))
}

const RESULT_LINE = /^AGENT_GUARD_RESULT (allow|deny(?: ([a-z-]+))?)$/

/**
 * 1 コマンドをガードへ渡して判定する。
 * @returns {{ deny: false } | { deny: true, message: string }}
 */
function judge(command, subagent, timeoutMs) {
  if (!existsSync(GUARD_PATH)) return { deny: true, message: MSG_GUARD_MISSING }

  const r = spawnSync(BASH, [GUARD_PATH], {
    input: JSON.stringify({ command, subagent }),
    encoding: "utf8",
    timeout: timeoutMs,
    // 既定の SIGTERM は無視・遅延され得る。時間切れのときに確実に止めて、同期待ちを timeoutMs で打ち切る。
    killSignal: "SIGKILL",
  })
  // error は起動失敗・時間切れ（ETIMEDOUT）、signal は kill された場合。
  if (r.error || r.signal || typeof r.stdout !== "string") return { deny: true, message: MSG_GUARD_FAILED }

  const lines = r.stdout.split("\n").filter((l) => l !== "")
  const m = RESULT_LINE.exec(lines[lines.length - 1] ?? "")
  if (!m) return { deny: true, message: MSG_GUARD_FAILED }

  // allow は「結果行が allow」かつ「終了コード 0」の両方が揃ったときだけ。
  if (m[1] === "allow") return r.status === 0 ? { deny: false } : { deny: true, message: MSG_GUARD_FAILED }
  return { deny: true, message: MESSAGES[m[2]] ?? MSG_GUARD_FAILED }
}

/**
 * サブエージェント判別。親セッション（parentID）が非空の文字列なら true、main と確定できる形なら false、
 * それ以外は null（ガードはマージ制限について true と同じく扱う）。
 * 返り値の形は v2.2.7 の実測による: 平らな { id, [parentID,] projectID, agent, cost, tokens, time, title, location }。
 * root には parentID が無く、子には親の sessionID が入る。
 * main（false）と確定するのは、id が sessionID と一致し、形を確かめるキー projectID が非空の文字列で、かつ
 * 親を表すキー（parentID・parentId・parent など、名前に parent を含むキー）がどれも無いときだけ。
 * 包まれた形・id 不一致・型違い・別名の親キーなど、parentID を読めていないだけの可能性があるものは null にする。
 * 取得に 3 秒以内に応答しないときも null。agent 名はカスタム agent の命名に左右されるため使わない（Phase 0 O5）。
 */
async function detectSubagent(ctx, sessionID) {
  if (typeof sessionID !== "string" || sessionID === "") return null
  let timer
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SESSION_TIMEOUT_MS) })
    const session = await Promise.race([ctx.session.get({ sessionID }), timeout])
    if (session === null || typeof session !== "object" || session.id !== sessionID) return null
    if (typeof session.parentID === "string" && session.parentID !== "") return true
    if (Object.keys(session).some((k) => /parent/i.test(k))) return null
    return typeof session.projectID === "string" && session.projectID !== "" ? false : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** event を deny にする。 */
function deny(event, message) {
  event.effect = "deny"
  event.message = message
}

/** 1 つの permission.evaluate event を判定し、必要なら deny を書き込む。 */
async function evaluate(ctx, event) {
  // すでに deny のものは他の hook の判断を尊重して変えない。
  if (event.effect === "deny") return
  const action = event.action
  if (typeof action !== "string") return deny(event, MSG_BAD_EVENT)
  if (NON_SHELL_ACTIONS.has(action)) return

  const resources = event.resources
  if (!Array.isArray(resources)) return deny(event, MSG_BAD_EVENT)

  // edit（write・patch を含む）と、名前が変わった・未知の編集系 action（shell 以外）は、resources をパスとして扱う。
  // 保護対象のパスを 1 つでも含めば deny。パスはコマンドではないので edit はガードへ渡さない。
  if (action !== "shell") {
    if (resources.some((r) => typeof r !== "string")) {
      if (action === "edit") return deny(event, MSG_BAD_EVENT)
    } else if (resources.some(isProtectedEdit)) {
      return deny(event, MSG_PROTECTED_EDIT)
    }
    if (action === "edit") return
  }

  // shell、および名前が変わった shell・MCP・plugin 定義などの未知の action は resources をコマンドとして判定する。
  if (resources.length === 0) return

  const subagent = await detectSubagent(ctx, event.sessionID)
  // 同期実行の合計時間を TOTAL_BLOCK_BUDGET_MS までに抑える。使い切ったら残りは実行せず deny にする。
  const deadline = Date.now() + TOTAL_BLOCK_BUDGET_MS
  for (const command of resources) {
    if (typeof command !== "string") return deny(event, MSG_BAD_EVENT)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return deny(event, MSG_BUDGET)
    const verdict = judge(command, subagent, Math.min(GUARD_TIMEOUT_MS, remaining))
    if (verdict.deny) return deny(event, verdict.message)
  }
}

export default {
  id: "agent-guard",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async (event) => {
      try {
        await evaluate(ctx, event)
      } catch (e) {
        // 判定中の例外は deny を試みる。deny を書き込めないとき（event が壊れている等）は例外のまま返す。
        try {
          deny(event, MSG_INTERNAL)
        } catch {
          throw e
        }
      }
    })
  },
}

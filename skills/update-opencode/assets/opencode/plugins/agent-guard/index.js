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
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const GUARD_PATH = fileURLToPath(new URL("../../hooks/agent-guard.sh", import.meta.url))
const GUARD_TIMEOUT_MS = 5000

// 理由コード → ユーザーとモデルに返す固定文。入力のコマンド文字列は一切含めない。
const MESSAGES = {
  "no-verify": "agent-guard: git の --no-verify（および commit の -n）は禁止されている",
  "force-push": "agent-guard: git push の force（--force / -f / +refspec）は禁止されている。--force-with-lease は使える",
  "merge-guard": "agent-guard: サブエージェントからのマージ・承認・gh の alias / extension 実行は禁止されている",
  "repo-settings": "agent-guard: サブエージェントからのリポジトリ設定・ruleset の変更は禁止されている",
  obfuscated: "agent-guard: 難読化されたコマンド（$'...'・$IFS 展開）は許可されない",
  "bad-input": "agent-guard: ガードがコマンドを解釈できなかったため拒否した",
  "no-jq": "agent-guard: jq が見つからないため拒否した（jq を導入すること）",
  "internal-error": "agent-guard: ガードが内部エラーで終了したため拒否した",
}
const MSG_GUARD_MISSING = "agent-guard: .opencode/hooks/agent-guard.sh が見つからないため拒否した"
const MSG_GUARD_FAILED = "agent-guard: ガードの実行に失敗した（異常終了・時間切れ・結果行なし）ため拒否した"
const MSG_BAD_EVENT = "agent-guard: shell の対象を解釈できなかったため拒否した"

const RESULT_LINE = /^AGENT_GUARD_RESULT (allow|deny(?: ([a-z-]+))?)$/

/**
 * 1 コマンドをガードへ渡して判定する。
 * @returns {{ deny: false } | { deny: true, message: string }}
 */
function judge(command, subagent) {
  if (!existsSync(GUARD_PATH)) return { deny: true, message: MSG_GUARD_MISSING }

  const r = spawnSync("bash", [GUARD_PATH], {
    input: JSON.stringify({ command, subagent }),
    encoding: "utf8",
    timeout: GUARD_TIMEOUT_MS,
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
 * サブエージェント判別。親セッション（parentID）を持てば true、持たなければ false、
 * 取得できなければ null（ガードはマージ制限について true と同じく扱う）。
 * agent 名はカスタム agent の命名に左右されるため使わない（Phase 0 O5）。
 */
async function detectSubagent(ctx, sessionID) {
  try {
    const session = await ctx.session.get({ sessionID })
    if (session === null || typeof session !== "object") return null
    return Boolean(session.parentID)
  } catch {
    return null
  }
}

export default {
  id: "agent-guard",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async (event) => {
      // 触るのは shell だけ。すでに deny のものは他の hook の判断を尊重して変えない。
      if (event.action !== "shell" || event.effect === "deny") return

      const resources = event.resources
      if (!Array.isArray(resources)) {
        event.effect = "deny"
        event.message = MSG_BAD_EVENT
        return
      }
      if (resources.length === 0) return

      const subagent = await detectSubagent(ctx, event.sessionID)
      for (const command of resources) {
        const verdict = typeof command === "string" ? judge(command, subagent) : { deny: true, message: MSG_BAD_EVENT }
        if (verdict.deny) {
          event.effect = "deny"
          event.message = verdict.message
          return
        }
      }
    })
  },
}

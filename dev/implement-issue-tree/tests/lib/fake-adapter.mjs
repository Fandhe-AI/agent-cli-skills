// ランナーのテスト用の偽アダプタ。契約（_/local-plans/iit-runner-adapter-contract.md の「アダプタの契約」）どおりの
// createAdapter を持ち、実ツール（codex / opencode）を起動せずに応答を返す。
//
// 応答は reply(req, ctx) が決める。既定は stub-run.mjs の makeDefaultReply（ラベル別の既定応答表）を、
// 完成形のプロンプト（agent-host が前置き・schema 指示を付けたもの）に適用して JSON 文字列にする。
// reply が返したものの扱い:
//   - 文字列: そのまま text として返す（不正な JSON・前後の文章つきなどを注入できる）
//   - Error（AdapterError を含む）: throw する
//   - Promise: 待ってから上と同じ扱い（時間切れの再現に使う）
//   - それ以外: JSON.stringify した文字列を text として返す（null は 'null'）
// 呼び出しは calls に記録する（req そのもの。修復ターンは req.resume が非 null）。
import { makeDefaultReply } from './stub-run.mjs'

/**
 * @param {{ reply?: (req: object, ctx: { turn: number, label: string }) => any, defaults?: { args: object, nodes: object[] }, name?: string, delayMs?: number }} [opts]
 * @returns {{ createAdapter: (cfg: object) => object, calls: object[], instances: object[] }}
 */
export function makeFakeAdapterModule({ reply, defaults, name = 'codex', delayMs = 0 } = {}) {
  const calls = []
  const instances = []
  const fallback = defaults ? makeDefaultReply(defaults) : () => null
  const answer = reply ?? ((req) => fallback(req.prompt, { label: req.label }))
  let sessions = 0
  function createAdapter(cfg) {
    const state = { cfg, started: 0, closed: 0 }
    instances.push(state)
    return {
      name,
      async start() { state.started++ },
      async close() { state.closed++ },
      async run(req) {
        calls.push(req)
        const sessionRef = req.resume ? req.resume.sessionRef : `fake-session-${++sessions}`
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        let out = answer(req, { turn: req.resume ? 1 : 0, label: req.label })
        if (out && typeof out.then === 'function') out = await out
        if (out instanceof Error) throw out
        return { text: typeof out === 'string' ? out : JSON.stringify(out ?? null), sessionRef }
      },
    }
  }
  return { createAdapter, calls, instances }
}

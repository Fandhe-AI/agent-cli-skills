// アダプタ（Codex / OpenCode）が run で投げる失敗の型。契約は _/local-plans/iit-runner-adapter-contract.md。
//
// agent-host が kind で分岐する（timeout・exit・api・denied は修復せず null、usage-limit は待って再試行）。
// クラス名・kind・sessionRef のフィールド名は契約の一部で、変えない。agent-host 側にも同じ形の定義が入るため、
// 統合時にどちらかへ寄せる。
export const ADAPTER_ERROR_KINDS = Object.freeze(['timeout', 'usage-limit', 'exit', 'api', 'denied', 'prereq'])

export class AdapterError extends Error {
  /**
   * @param {'timeout'|'usage-limit'|'exit'|'api'|'denied'|'prereq'} kind
   * @param {string} message
   * @param {{ sessionRef?: string }} [extra] 失敗までに分かったセッション（修復・削除に使う）
   */
  constructor(kind, message, { sessionRef } = {}) {
    super(message)
    if (!ADAPTER_ERROR_KINDS.includes(kind)) throw new TypeError(`未知の AdapterError kind: ${String(kind)}`)
    this.name = 'AdapterError'
    this.kind = kind
    if (sessionRef !== undefined) this.sessionRef = sessionRef
  }
}

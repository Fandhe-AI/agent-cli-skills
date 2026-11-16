// アダプタが agent-host へ返す失敗の型。契約（_/local-plans/iit-runner-adapter-contract.md）の最小定義で、
// クラス名・kind・sessionRef のフィールド名は agent-host 側と同じ。統合時に agent-host 側の定義へ寄せる。
//
// kind: 'timeout' | 'usage-limit' | 'exit' | 'api' | 'denied' | 'prereq'
export const ADAPTER_ERROR_KINDS = Object.freeze(['timeout', 'usage-limit', 'exit', 'api', 'denied', 'prereq'])

export class AdapterError extends Error {
  /**
   * @param {string} kind ADAPTER_ERROR_KINDS のどれか
   * @param {string} message
   * @param {{ sessionRef?: string }} [opts] 失敗時点までに作ったセッション（修復や掃除に使う）
   */
  constructor(kind, message, { sessionRef } = {}) {
    super(message)
    this.name = 'AdapterError'
    this.kind = kind
    this.sessionRef = sessionRef ?? null
  }
}

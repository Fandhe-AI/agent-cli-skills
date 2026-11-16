// エージェントの応答テキストから、最後の JSON オブジェクトを取り出す。
//
// 役割: OpenCode v2 は JSON Schema を強制できないため、応答は前後に文章やコードフェンスが付き得る。
// agent-host が schema 検証へ渡す前の取り出し段で、Codex でも最終出力が壊れたときの保険に使う。
// 取り出した値の正しさは保証しない（適合の判定は schema-validate が行う）。
//
// 対象はオブジェクトだけ（iit の全 schema の最上位は object）。配列・数値だけの応答は取り出さない。
// 文字列リテラルの中の波括弧は数えない。最後に現れた「JSON として読める最も外側のオブジェクト」を返す。
// 入れ子の内側は、外側が JSON として読めたときは別候補にしない（応答全体が 1 つの object のとき内側の
// 部分 object を返さないため）。
const MAX_INPUT = 2 * 1024 * 1024
// 閉じない `{` が大量にある入力での二次の走査を避ける上限（超えたら、そこまでの最後の候補で打ち切る）
const MAX_ATTEMPTS = 1000

function balancedEnd(text, start) {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/**
 * @param {string} text
 * @returns {object | undefined} 見つからなければ undefined
 */
export function extractLastJson(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT) return undefined
  let last
  let attempts = 0
  let i = text.indexOf('{')
  while (i >= 0 && attempts < MAX_ATTEMPTS) {
    attempts++
    const end = balancedEnd(text, i)
    if (end > i) {
      try {
        const v = JSON.parse(text.slice(i, end + 1))
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          last = v
          i = text.indexOf('{', end + 1)
          continue
        }
      } catch { /* JSON として読めない塊は、内側の `{` から探し直す */ }
    }
    i = text.indexOf('{', i + 1)
  }
  return last
}

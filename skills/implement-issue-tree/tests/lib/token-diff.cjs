// build-workflow の変換前後でトークン列（種類・テキスト・開始行）が一致することを、Node 同梱の
// acorn（字句解析器）で検証するヘルパー。acorn は内部モジュール（internal/deps/acorn/...）で、
// `node --expose-internals` を付けた子プロセスでしか読み込めないため、tests/build-workflow.test.mjs
// が spawnSync で本ファイルを起動する（通常の `node --test` は --expose-internals を伝播しない）。
//
// 入力（stdin）: JSON `[{ "name": string, "before": string, "after": string }]`
// 出力（stdout）: JSON `{ "acornVersion": string, "results": [{ "name", "ok", "detail" }] }`
//   ok が true = 変換前後のトークン列が完全一致。tokenizer が例外を投げた場合は ok: false。
'use strict'

const acorn = require('internal/deps/acorn/acorn/dist/acorn')

const tokenize = (code) => {
  const tokens = []
  for (const t of acorn.tokenizer(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })) {
    tokens.push([t.type.label, code.slice(t.start, t.end), t.loc.start.line])
  }
  return tokens
}

const compare = ({ name, before, after }) => {
  let a
  let b
  try {
    a = tokenize(before)
  } catch (e) {
    return { name, ok: false, detail: `変換前の字句解析に失敗: ${e.message}` }
  }
  try {
    b = tokenize(after)
  } catch (e) {
    return { name, ok: false, detail: `変換後の字句解析に失敗: ${e.message}` }
  }
  if (a.length !== b.length) {
    return { name, ok: false, detail: `トークン数が不一致（変換前 ${a.length} / 変換後 ${b.length}）` }
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) {
      return {
        name,
        ok: false,
        detail: `トークン ${i} が不一致: ${JSON.stringify(a[i])} ≠ ${JSON.stringify(b[i])}`,
      }
    }
  }
  return { name, ok: true, detail: `${a.length} トークン一致` }
}

const chunks = []
process.stdin.on('data', (d) => chunks.push(d))
process.stdin.on('end', () => {
  const cases = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  process.stdout.write(JSON.stringify({ acornVersion: acorn.version, results: cases.map(compare) }))
})

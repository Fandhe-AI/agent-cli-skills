// 改名器（scripts/mangle-identifiers.cjs）をテストから 1 プロセスでまとめて呼ぶための駆動役（テスト専用）。
// 改名器は Node 同梱 acorn を使うため node --expose-internals の子プロセスでしか読めない。
// 入力（stdin）: JSON { mode, ... }。出力（stdout）: JSON。
// - mode 'mangle': { texts: string[] } → [{ ok, code?, stats?, error? }]（例外は ok: false で返す）
// - mode 'refswap': { text, count, seed } → [{ at, from, to, kind, text }]。改名済みテキストの参照を 1 か所ずつ
//   (a) その位置から見える別の束縛 (b) 自由なグローバル (c) 未宣言の名前 に書き換えた変異体（決定的）
// - mode 'function-body-starts': { text } → 本体がブロックの関数宣言の `{` の直後の位置と行の範囲
'use strict'
const fs = require('fs')
const path = require('path')
const acorn = require('internal/deps/acorn/acorn/dist/acorn')
const { mangle, analyze } = require(path.join(__dirname, '..', '..', 'scripts', 'mangle-identifiers.cjs'))

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, locations: true }

function refswap({ text, count, seed }) {
  const ast = acorn.parse(text, PARSE_OPTIONS)
  const { bindings } = analyze(ast)
  const declStarts = new Set(bindings.flatMap((b) => b.ids.map((i) => i.start)))
  const shorthand = new Set()
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'Property' && n.shorthand) shorthand.add((n.value.left ?? n.value).start)
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  const refs = bindings.flatMap((b) => b.refs.filter((r) => !declStarts.has(r.id.start) && !shorthand.has(r.id.start)).map((r) => ({ r, b })))
  const resolve = (scope, name) => {
    for (let s = scope; s; s = s.parent) if (s.decls.has(name)) return s.decls.get(name)
    return null
  }
  let x = seed >>> 0
  const rnd = (n) => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    return x % n
  }
  const out = []
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const { r, b } = refs[rnd(refs.length)]
    const kind = ['other-binding', 'free-global', 'undeclared'][out.length % 3]
    let name
    if (kind === 'other-binding') {
      const cands = []
      for (let s = r.scope; s; s = s.parent) for (const [n, c] of s.decls) if (c !== b && resolve(r.scope, n) === c) cands.push(n)
      if (!cands.length) continue
      name = cands[rnd(cands.length)]
    } else name = kind === 'free-global' ? ['JSON', 'Math', 'Object', 'String'][rnd(4)] : 'zzUndeclared'
    out.push({ at: r.id.start, from: r.id.name, to: name, kind, text: text.slice(0, r.id.start) + name + text.slice(r.id.end) })
  }
  return out
}

function functionBodyStarts({ text }) {
  const ast = acorn.parse(text, PARSE_OPTIONS)
  const out = []
  for (const s of ast.body) {
    if (s.type === 'FunctionDeclaration' && s.body.type === 'BlockStatement') {
      out.push({ name: s.id.name, insertAt: s.body.start + 1, startLine: s.loc.start.line, endLine: s.loc.end.line })
    }
  }
  return out
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
let result
if (input.mode === 'mangle') {
  result = input.texts.map((t) => {
    try {
      return { ok: true, ...mangle(t) }
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) }
    }
  })
} else if (input.mode === 'refswap') result = refswap(input)
else if (input.mode === 'function-body-starts') result = functionBodyStarts(input)
else throw new Error(`未知の mode: ${input.mode}`)
process.stdout.write(JSON.stringify(result))

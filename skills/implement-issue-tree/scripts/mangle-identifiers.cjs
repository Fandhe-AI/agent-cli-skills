// 生成物（stage1 = コメント・空白除去済み）の束縛名を一貫して短縮する改名器。
// 正しさの門ではない: 出力が改名だけで元と等価であることは独立の検証器 alpha-verify.cjs が判定する
// （改名器はスコープ解析と走査を自前で持ち、acorn-walk を使わない。パーサは Node 同梱 acorn を共有）。
// 起動: node --expose-internals mangle-identifiers.cjs（acorn は内部モジュールで、この形でしか読めない）。
// 入力（stdin）: stage1 のテキスト。出力（stdout）: JSON { code, stats }。
// 対応外の構文（class・var・ラベル・with・eval・arguments・ブロック内 / switch 内の関数宣言・
// meta 以外の import / export）や想定外のノードは例外で止め、非ゼロ終了・stdout 空にする（fail-closed）。
// 改名を止める・方式を変える引数や環境変数は持たない。
'use strict'
const acorn = require('internal/deps/acorn/acorn/dist/acorn')

// Workflow ランタイムが本体の関数に注入する名前（最上位で宣言すると読み込み時に SyntaxError）
const RUNTIME_INJECTED = ['agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'budget', 'workflow']
// 新しい名前に使わない名前（予約語・文脈依存語・特別な名前・注入名）。元の名前を残す場合は対象外
const RESERVED = new Set([
  ...('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
    'yield let static implements interface package private protected public await async of get set as from target ' +
    'eval arguments undefined NaN Infinity globalThis meta').split(' '),
  ...RUNTIME_INJECTED,
])
const REJECTED_NODES = {
  ImportDeclaration: 'import', ExportDefaultDeclaration: 'export default', ExportAllDeclaration: 'export *',
  ClassDeclaration: 'class', ClassExpression: 'class', WithStatement: 'with', LabeledStatement: 'ラベル',
}
const PARSE_OPTIONS ={ ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }

class Scope {
  constructor(kind, parent) {
    this.kind = kind
    this.parent = parent
    this.decls = new Map()
    this.depth = parent ? parent.depth + 1 : 0
  }
}

function fail(msg, node) {
  throw new Error(`mangle: ${msg}${node ? ` (offset ${node.start})` : ''}`)
}

// スコープ木・束縛・参照を作る。bindings[i].refs は宣言自身を含む出現位置。
// paired は「同じ名前を持てない」スコープの組（引数と関数本体・catch 引数と catch 本体）
function analyze(ast) {
  const bindings = []
  const refs = []
  const paired = []
  const declare = (scope, id, kind) => {
    if (id.type !== 'Identifier') fail('識別子でない宣言', id)
    let b = scope.decls.get(id.name)
    if (!b) {
      b = { name: id.name, scope, ids: [], refs: [], kind, idx: bindings.length }
      scope.decls.set(id.name, b)
      bindings.push(b)
    }
    b.ids.push(id)
  }
  const patternIds = (p, out) => {
    switch (p.type) {
      case 'Identifier': out.push(p); break
      case 'ObjectPattern': for (const pr of p.properties) patternIds(pr.type === 'RestElement' ? pr.argument : pr.value, out); break
      case 'ArrayPattern': for (const el of p.elements) if (el) patternIds(el, out); break
      case 'AssignmentPattern': patternIds(p.left, out); break
      case 'RestElement': patternIds(p.argument, out); break
      default: fail(`パターン ${p.type}`, p)
    }
    return out
  }
  // 文の並びの宣言をそのスコープへ集める（関数宣言の巻き上げを含む）
  const hoist = (stmts, scope) => {
    for (const s of stmts) {
      const d = s.type === 'ExportNamedDeclaration' ? s.declaration : s
      if (!d) continue
      if (d.type === 'FunctionDeclaration') declare(scope, d.id, 'function')
      else if (d.type === 'VariableDeclaration') {
        if (d.kind === 'var') fail('var', d)
        for (const dc of d.declarations) for (const id of patternIds(dc.id, [])) declare(scope, id, d.kind)
      } else if (d.type === 'ClassDeclaration') fail('class', d)
    }
  }
  const rejectNestedFunctions = (stmts, where) => {
    for (const st of stmts) if (st.type === 'FunctionDeclaration') fail(`${where}の関数宣言`, st)
  }
  const blockBody = (stmts, scope) => {
    hoist(stmts, scope)
    for (const st of stmts) visit(st, scope)
  }
  const visit = (node, scope) => {
    if (!node) return
    if (typeof node.type !== 'string') fail('ノードでない値', node)
    if (Object.hasOwn(REJECTED_NODES, node.type)) fail(REJECTED_NODES[node.type], node)
    switch (node.type) {
      case 'ExportNamedDeclaration': {
        const d = node.declaration
        if (scope.kind !== 'program' || !d || node.specifiers.length || d.type !== 'VariableDeclaration' ||
          d.declarations.length !== 1 || d.declarations[0].id.type !== 'Identifier' || d.declarations[0].id.name !== 'meta') {
          fail('meta 以外の export', node)
        }
        visit(d, scope)
        return
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        let outer = scope
        if (node.type === 'FunctionExpression' && node.id) {
          outer = new Scope('fnname', scope)
          declare(outer, node.id, 'fnname')
        }
        if (node.id) refs.push({ id: node.id, scope: outer })
        // 引数スコープと本体スコープを分ける（既定値の式から本体の宣言は見えない）
        const params = new Scope('params', outer)
        for (const p of node.params) for (const id of patternIds(p, [])) declare(params, id, 'param')
        for (const p of node.params) visitPattern(p, params)
        if (node.body.type === 'BlockStatement') {
          const body = new Scope('body', params)
          paired.push([params, body])
          blockBody(node.body.body, body)
        } else visit(node.body, params)
        return
      }
      case 'BlockStatement': {
        rejectNestedFunctions(node.body, 'ブロック内')
        blockBody(node.body, new Scope('block', scope))
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope)
        const s = new Scope('block', scope)
        for (const c of node.cases) {
          rejectNestedFunctions(c.consequent, 'switch 内')
          hoist(c.consequent, s)
        }
        for (const c of node.cases) {
          visit(c.test, s)
          for (const st of c.consequent) visit(st, s)
        }
        return
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const s = new Scope('for', scope)
        const head = node.type === 'ForStatement' ? node.init : node.left
        const decl = head && head.type === 'VariableDeclaration'
        if (decl) hoist([head], s)
        if (node.type === 'ForStatement') {
          visit(node.init, s); visit(node.test, s); visit(node.update, s)
        } else {
          if (decl) visit(head, s)
          else visitPattern(head, s)
          visit(node.right, s)
        }
        visit(node.body, s)
        return
      }
      case 'CatchClause': {
        const s = new Scope('catch', scope)
        if (node.param) {
          for (const id of patternIds(node.param, [])) declare(s, id, 'catch')
          visitPattern(node.param, s)
        }
        rejectNestedFunctions(node.body.body, 'ブロック内')
        const body = new Scope('block', s)
        paired.push([s, body])
        blockBody(node.body.body, body)
        return
      }
      case 'VariableDeclaration':
        if (node.kind === 'var') fail('var', node)
        for (const d of node.declarations) { visitPattern(d.id, scope); visit(d.init, scope) }
        return
      case 'Identifier':
        if (node.name === 'arguments') fail('arguments', node)
        if (node.name === 'eval') fail('eval', node)
        refs.push({ id: node, scope })
        return
      case 'MemberExpression':
        visit(node.object, scope)
        if (node.computed) visit(node.property, scope)
        return
      case 'Property':
        if (node.computed) visit(node.key, scope)
        visit(node.value, scope)
        return
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier' || node.left.type === 'MemberExpression') visit(node.left, scope)
        else visitPattern(node.left, scope)
        visit(node.right, scope)
        return
      case 'BreakStatement': case 'ContinueStatement':
        if (node.label) fail('ラベル', node)
        return
      case 'MetaProperty':
        return
      default:
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
          const v = node[k]
          if (Array.isArray(v)) for (const x of v) visit(x, scope)
          // Literal の regex / value（RegExp）と TemplateElement の value はノードでない値
          else if (v && typeof v === 'object' && !(typeof v.type !== 'string' && (k === 'regex' || k === 'value'))) visit(v, scope)
        }
    }
  }
  // パターン: 束縛の出現も参照として記録する（解決で宣言自身を指す）。既定値の式・計算キーは式として辿る
  const visitPattern = (p, scope) => {
    switch (p.type) {
      case 'Identifier': visit(p, scope); return
      case 'MemberExpression': visit(p, scope); return
      case 'ObjectPattern':
        for (const pr of p.properties) {
          if (pr.type === 'RestElement') visitPattern(pr.argument, scope)
          else {
            if (pr.computed) visit(pr.key, scope)
            visitPattern(pr.value, scope)
          }
        }
        return
      case 'ArrayPattern': for (const el of p.elements) if (el) visitPattern(el, scope); return
      case 'AssignmentPattern': visitPattern(p.left, scope); visit(p.right, scope); return
      case 'RestElement': visitPattern(p.argument, scope); return
      default: fail(`パターン ${p.type}`, p)
    }
  }
  if (ast.type !== 'Program') fail('Program でない')
  const program = new Scope('program', null)
  blockBody(ast.body, program)
  // 参照の解決（内から外へ）。見つからなければ自由変数
  const free = new Map()
  for (const r of refs) {
    let s = r.scope
    while (s && !s.decls.has(r.id.name)) s = s.parent
    if (s) s.decls.get(r.id.name).refs.push(r)
    else free.set(r.id.name, (free.get(r.id.name) || 0) + 1)
  }
  return { bindings, free, program, paired }
}

// 1 文字 → 2 文字 → 3 文字の名前を順に返す
function* nameGen() {
  const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$'
  const rest = first + '0123456789'
  for (const c of first) yield c
  for (const a of first) for (const b of rest) yield a + b
  for (const a of first) for (const b of rest) for (const c of rest) yield a + b + c
}

const fnv1a = (s) => {
  let x = 2166136261
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i)
    x = Math.imul(x, 16777619) >>> 0
  }
  return x
}

// 衝突: 参照 r（スコープ R）が束縛 b（スコープ S_b）を指すとき、R から S_b の手前までの各スコープの束縛は
// b と同じ名前を持てない。組のスコープ（引数と本体など）の束縛どうしも同じ名前を持てない
function conflictSets(bindings, paired) {
  const conflicts = bindings.map(() => new Set())
  const link = (x, y) => {
    if (x === y) return
    conflicts[x.idx].add(y.idx)
    conflicts[y.idx].add(x.idx)
  }
  for (const b of bindings) {
    for (const r of b.refs) {
      for (let s = r.scope; s && s !== b.scope; s = s.parent) for (const c of s.decls.values()) link(b, c)
    }
  }
  for (const [x, y] of paired) for (const a of x.decls.values()) for (const c of y.decls.values()) link(a, c)
  return conflicts
}

// 安定名: 最上位は元の名前のハッシュで 2 文字の表の位置を決め（埋まっていれば次へ）、局所はスコープの深さ →
// 宣言位置の順に衝突しない最短の名前を取る。src の小さな編集が他の名前を玉突きで動かさないための規則
function assignNames(bindings, conflicts, forbidden) {
  const newName = new Array(bindings.length).fill(null)
  const top = []
  for (const b of bindings) {
    // {__proto__} の shorthand は展開すると意味が変わる（プロトタイプの設定になる）ので、この名前は改名しない
    if (b.name === '__proto__') newName[b.idx] = b.name
    if (b.scope.kind !== 'program' || newName[b.idx] !== null) continue
    if (b.name === 'meta' || b.name.length <= 2) newName[b.idx] = b.name
    else top.push(b)
  }
  const two = []
  for (const n of nameGen()) {
    if (n.length === 1) continue
    if (n.length > 2) break
    if (!forbidden.has(n)) two.push(n)
  }
  const used = new Set(newName.filter((n) => n !== null))
  top.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  if (top.length + used.size > two.length) fail('最上位の束縛が 2 文字の表に収まらない')
  for (const b of top) {
    let k = fnv1a(b.name) % two.length
    while (used.has(two[k])) k = (k + 1) % two.length
    newName[b.idx] = two[k]
    used.add(two[k])
  }
  const gen = []
  const nth = nameGen()
  const nameAt = (i) => {
    while (gen.length <= i) {
      const n = nth.next()
      if (n.done) fail('名前の候補が尽きた')
      if (!forbidden.has(n.value)) gen.push(n.value)
    }
    return gen[i]
  }
  const locals = bindings.filter((b) => newName[b.idx] === null)
  locals.sort((x, y) => (x.scope.depth - y.scope.depth) || (x.ids[0].start - y.ids[0].start))
  for (const b of locals) {
    const taken = new Set()
    for (const c of b.scope.decls.values()) if (c !== b && newName[c.idx] !== null) taken.add(newName[c.idx])
    for (const ci of conflicts[b.idx]) if (newName[ci] !== null) taken.add(newName[ci])
    let i = 0
    while (taken.has(nameAt(i))) i++
    const cand = nameAt(i)
    // 元の名前より長くならない限り短い名前へ。元の名前が衝突するなら必ず替える
    newName[b.idx] = cand.length < b.name.length || taken.has(b.name) ? cand : b.name
  }
  return newName
}

// shorthand の値側の識別子の開始位置 → キー名（改名するときは `key:新名` に展開する）
function shorthandKeys(ast) {
  const out = new Map()
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'Property' && n.shorthand) {
      const v = n.value.type === 'AssignmentPattern' ? n.value.left : n.value
      out.set(v.start, n.key.name)
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  return out
}

function mangle(code) {
  if (typeof code !== 'string') fail('入力が文字列でない')
  const ast = acorn.parse(code, PARSE_OPTIONS)
  const { bindings, free, paired } = analyze(ast)
  const forbidden = new Set([...RESERVED, ...free.keys()])
  const newName = assignNames(bindings, conflictSets(bindings, paired), forbidden)
  const shorthand = shorthandKeys(ast)
  const edits = []
  for (const b of bindings) {
    const nn = newName[b.idx]
    if (nn === b.name) continue
    for (const r of b.refs) {
      const key = shorthand.get(r.id.start)
      edits.push({ start: r.id.start, end: r.id.end, text: key === undefined ? nn : `${key}:${nn}` })
    }
  }
  edits.sort((x, y) => x.start - y.start)
  let out = ''
  let pos = 0
  for (const e of edits) {
    if (e.start < pos) fail('置換範囲が重なる', { start: e.start })
    out += code.slice(pos, e.start) + e.text
    pos = e.end
  }
  out += code.slice(pos)
  if (out.split('\n').length !== code.split('\n').length) fail('行数が変わった')
  return {
    code: out,
    stats: {
      bindings: bindings.length,
      renamed: bindings.filter((b) => newName[b.idx] !== b.name).length,
      free: [...free.keys()].sort(),
      edits: edits.length,
    },
  }
}

module.exports = { mangle, analyze, RUNTIME_INJECTED }
if (require.main === module) {
  const chunks = []
  process.stdin.on('data', (d) => chunks.push(d))
  process.stdin.on('end', () => {
    let result
    try {
      result = JSON.stringify(mangle(Buffer.concat(chunks).toString('utf8')))
    } catch (e) {
      process.stderr.write(`${e && e.message ? e.message : e}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(result)
  })
}

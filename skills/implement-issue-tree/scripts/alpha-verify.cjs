// 識別子の改名の前後（before = コメント・空白を除いた生成物 stage1、after = 局所識別子を短縮した生成物）が、
// スコープを尊重した一対一の改名だけで異なることを確かめる α 同値の検証器。ビルダーの照合 2 にあたり、
// 改名器（mangle-identifiers.cjs）とは独立に書いている（走査は acorn-walk の fullAncestor、解決は識別子ごとに
// 祖先列を内から外へたどる。改名器のスコープ表・走査コードは使わない）。
//
// 保証すること（module と script の両ゴールで一致を要求する）:
// - AST の形・リテラル・テンプレートの地の文・演算子・フラグが完全に同じ（プロンプト本文が 1 文字も変わらない）
// - 参照と束縛の対応が同じ（各参照の解決先の宣言が、改名後も同じ位置の宣言になる）・自由変数は同名のまま・
//   参照でない識別子（非計算のキー・メンバー名）は同名のまま・最上位の meta は改名しない・行数が同じ
// - 新しい宣言名が特別な名前でない・関数値を文字列化していない（改名で関数の名前・ソース文字列が変わるため）
// 保証しないこと: パーサは改名器と同じ Node 同梱の acorn なので、acorn が誤った AST を返す共通故障は見えない。
// それは照合 1（token-diff.cjs が src と stage1 のトークン列を照合済み）と CI の V8 バイトコードオラクル
// （tests/lib/v8-bytecode-oracle.cjs）で補う。対応外の構文（var・class・with・ラベル・eval・arguments・
// ブロック内 / switch 内の関数宣言）はスコープ規則を持たないので、両テキストとも拒否する。
//
// CLI: `node --expose-internals alpha-verify.cjs`（acorn は内部モジュールなので --expose-internals が要る）
// 入力（stdin）: JSON `[{ "name": string, "before": string, "after": string }]`
// 出力（stdout）: JSON `{ "acornVersion": string, "results": [{ "name", "ok", "kind", "detail", "stats"? }] }`
//   kind は "match" | "mismatch" | "source-unparsable"（before を読めない = 検査できない）| "artifact-unparsable"。
//   stats は match のときだけ（ゴールごとの識別子数）。入力の形が違う・内部の予期しない例外のときは stdout に
//   何も書かず非ゼロで終了する（呼び出し側が一致と誤読しない）。同じ before の解析結果はケース間で使い回す。
'use strict'

const acorn = require('internal/deps/acorn/acorn/dist/acorn')
const walk = require('internal/deps/acorn/acorn-walk/dist/walk')

// Workflow ランタイムが本体に注入する名前。入力で差し替えさせない（減らされると最上位の衝突を見逃す）
const INJECTED = ['agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'budget', 'workflow']
const SPECIAL_NAMES = new Set([...INJECTED, 'meta', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis'])
const SCRIPT_PREFIX = `(async function(${INJECTED.join(',')}){`

const GOALS = {
  module: { wrap: (c) => c, shift: 0, options: { sourceType: 'module', allowReturnOutsideFunction: true } },
  // ランタイムが評価する形: 先頭の `export ` を外した本体を、注入名を引数に持つ async 関数の本体として読む
  // （token-diff.cjs の toRuntimeBody と同じ規則）。前置きに改行を入れないので行番号は変わらない
  script: {
    wrap: (c) => `${SCRIPT_PREFIX}${c.replace(/^export const meta\b/, 'const meta')}\n})`,
    shift: SCRIPT_PREFIX.length,
    options: { sourceType: 'script' },
  },
}

const POSITION_KEYS = new Set(['start', 'end', 'loc', 'range'])
const STRINGIFY_MEMBERS = new Set(['name', 'toString', 'length'])

class Mismatch extends Error {}

// 不一致の説明に出す値（BigInt でも例外にしない）
const show = (v) => (typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : String(v))

// パターンが束縛する識別子ノード
function boundIds(p, out = []) {
  if (!p) return out
  if (p.type === 'Identifier') out.push(p)
  else if (p.type === 'ObjectPattern') p.properties.forEach((x) => boundIds(x.type === 'RestElement' ? x.argument : x.value, out))
  else if (p.type === 'ArrayPattern') p.elements.forEach((x) => boundIds(x, out))
  else if (p.type === 'AssignmentPattern') boundIds(p.left, out)
  else if (p.type === 'RestElement') boundIds(p.argument, out)
  return out
}

// 文の並びが宣言する名前（関数宣言と let / const。var は対応外として先に拒否している）
function lexicalIds(stmts) {
  const out = []
  for (const s0 of stmts) {
    const s = s0.type === 'ExportNamedDeclaration' ? s0.declaration : s0
    if (!s) continue
    if (s.type === 'FunctionDeclaration') out.push(s.id)
    else if (s.type === 'VariableDeclaration') for (const d of s.declarations) boundIds(d.id, out)
  }
  return out
}

const byName = (ids) => {
  const m = new Map()
  for (const id of ids) if (!m.has(id.name)) m.set(id.name, id)
  return m
}

// scopeNode が（子 child から見て）宣言する名前 → 宣言の識別子。スコープを作らないノードは null
function declaredBy(scopeNode, child, cache) {
  const memo = (make) => {
    if (!cache.has(scopeNode)) cache.set(scopeNode, byName(make()))
    return cache.get(scopeNode)
  }
  switch (scopeNode.type) {
    case 'Program':
    case 'BlockStatement':
      return memo(() => lexicalIds(scopeNode.body))
    case 'SwitchStatement':
      if (child === scopeNode.discriminant) return null
      return memo(() => lexicalIds(scopeNode.cases.flatMap((c) => c.consequent)))
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const d = scopeNode.type === 'ForStatement' ? scopeNode.init : scopeNode.left
      if (!d || d.type !== 'VariableDeclaration') return null
      return memo(() => lexicalIds([d]))
    }
    case 'CatchClause':
      return memo(() => boundIds(scopeNode.param))
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      // 関数の名前は外側（宣言）か名前スコープ（式）で扱う。引数スコープは本体ブロックと別（既定値から本体の let は見えない）
      if (child === scopeNode.id) return null
      return memo(() => scopeNode.params.flatMap((p) => boundIds(p)))
    default:
      return null
  }
}

// 対応外の構文。見つけたら説明を返す（無ければ null）
function unsupported(n, anc) {
  if (n.type === 'VariableDeclaration' && n.kind === 'var') return 'var'
  if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return 'class'
  if (n.type === 'WithStatement') return 'with'
  if (n.type === 'LabeledStatement') return 'ラベル'
  if (n.type === 'Identifier' && (n.name === 'arguments' || n.name === 'eval')) return n.name
  if (n.type === 'FunctionDeclaration') {
    // 関数宣言はプログラム直下か関数本体の直下だけ（ブロック内・switch 内は Annex B で外側にも束縛を作り得る）
    const p = anc[anc.length - 2]
    const gp = anc[anc.length - 3]
    const top = p.type === 'Program' || p.type === 'ExportNamedDeclaration' || (p.type === 'BlockStatement' && gp && gp.body === p && /Function/.test(gp.type))
    if (!top) return 'ブロック内の関数宣言'
  }
  return null
}

// 関数値の文字列化に当たる位置か（手順 6）。当たれば位置の説明、当たらなければ null。
// (c) は String が自由変数のときだけ当たるので、呼び出しの callee も返して解決後に判定する
function stringifySite(id, parent) {
  if (parent.type === 'TemplateLiteral' && parent.expressions.includes(id)) return { why: 'テンプレートの式' }
  if (parent.type === 'BinaryExpression' && parent.operator === '+') return { why: '+ の被演算子' }
  if (parent.type === 'AssignmentExpression' && parent.operator === '+=' && parent.right === id) return { why: '+= の右辺' }
  if (parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'String' && parent.arguments.includes(id)) {
    return { why: 'String() の引数', callee: parent.callee }
  }
  if (parent.type === 'MemberExpression' && !parent.computed && parent.object === id && STRINGIFY_MEMBERS.has(parent.property.name)) {
    return { why: `.${parent.property.name} のオブジェクト` }
  }
  return null
}

// 1 つの AST を 1 回の走査で解析する。res: 識別子 → 宣言の識別子 | 'free'（acorn-walk が辿らない識別子は入らない）
function analyze(ast, goal) {
  const cache = new Map()
  const res = new Map()
  const fnDecls = new Set()
  const sites = []
  let bad = null
  walk.fullAncestor(ast, (n, _s, anc) => {
    if (bad) return
    const why = unsupported(n, anc)
    if (why) {
      bad = { why, start: n.start }
      return
    }
    if (n.type === 'FunctionDeclaration' || (n.type === 'FunctionExpression' && n.id)) fnDecls.add(n.id)
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && (n.init.type === 'FunctionExpression' || n.init.type === 'ArrowFunctionExpression')) fnDecls.add(n.id)
    if (n.type !== 'Identifier') return
    const site = stringifySite(n, anc[anc.length - 2])
    if (site) sites.push({ id: n, ...site })
    for (let i = anc.length - 2; i >= 0; i--) {
      const s = anc[i]
      const m = declaredBy(s, anc[i + 1], cache)
      if (m && m.has(n.name)) {
        res.set(n, m.get(n.name))
        return
      }
      // 名前つき関数式の名前は引数より外側・関数の外より内側のスコープにある
      if (s.type === 'FunctionExpression' && s.id && s.id.name === n.name) {
        res.set(n, s.id)
        return
      }
    }
    res.set(n, 'free')
  })
  const stringified = sites.filter((x) => fnDecls.has(res.get(x.id)) && (!x.callee || res.get(x.callee) === 'free'))
  // 最上位（module は Program、script は包み関数の本体）の meta 宣言
  const top = goal === 'module' ? ast.body : ast.body[0].expression.body.body
  const topMeta = new Set(lexicalIds(top).filter((id) => id.name === 'meta'))
  return { res, bad, stringified, topMeta }
}

// 2 つの AST を同じ形で辿り、識別子の組を集める。位置情報と Property.shorthand 以外の差は不一致
function pairUp(a, b, pairs, owner, key) {
  if (a === b) return
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    throw new Mismatch(`値が不一致（${owner.type}.${key}、offset ${owner.start}）: ${show(a)} ≠ ${show(b)}`)
  }
  if (Array.isArray(a) !== Array.isArray(b)) throw new Mismatch(`形が不一致（${owner.type}.${key}、offset ${owner.start}）`)
  if (Array.isArray(a)) {
    if (a.length !== b.length) throw new Mismatch(`要素数が不一致（${owner.type}.${key}、offset ${owner.start}）: ${a.length} ≠ ${b.length}`)
    for (let i = 0; i < a.length; i++) pairUp(a[i], b[i], pairs, owner, key)
    return
  }
  if (a.type !== b.type) throw new Mismatch(`種類が不一致（offset ${a.start}）: ${a.type} ≠ ${b.type}`)
  if (a.type === 'Identifier') {
    pairs.push([a, b])
    return
  }
  // TemplateElement.value のように type を持たないオブジェクトは、持ち主のノードを説明に使う
  const at = typeof a.type === 'string' ? a : owner
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (POSITION_KEYS.has(k)) continue
    if (k === 'shorthand' && a.type === 'Property') continue
    if (k === 'value' && a.type === 'Literal' && a.regex) continue // 正規表現は regex（pattern・flags）と raw で比べる
    pairUp(a[k], b[k], pairs, at, k)
  }
}

function parse(text, goal) {
  const g = GOALS[goal]
  return acorn.parse(g.wrap(text), { ecmaVersion: 'latest', ...g.options })
}

// before の解析結果（AST と解析表）。AST は書き換えないので、同じ before のケース間で使い回す
const beforeCache = new Map()
function parseBefore(text, goal) {
  const key = `${goal}\0${text}`
  if (!beforeCache.has(key)) {
    let entry
    try {
      const ast = parse(text, goal)
      entry = { ast, info: analyze(ast, goal) }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      entry = { error: e.message }
    }
    beforeCache.set(key, entry)
  }
  return beforeCache.get(key)
}

function verifyGoal(before, after, goal) {
  const tag = `[${goal}]`
  const at = (n) => n.start - GOALS[goal].shift
  const A = parseBefore(before, goal)
  if (A.error !== undefined) return { ok: false, kind: 'source-unparsable', detail: `${tag} 変換前のパースに失敗: ${A.error}` }
  let B
  try {
    const ast = parse(after, goal)
    B = { ast, info: analyze(ast, goal) }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return { ok: false, kind: 'artifact-unparsable', detail: `${tag} 変換後のパースに失敗: ${e.message}` }
  }
  try {
    const sides = [['変換前', A], ['変換後', B]]
    for (const [side, X] of sides) {
      const { bad } = X.info
      if (bad) throw new Mismatch(`${tag} ${side}: 対応外の構文 ${bad.why}（offset ${bad.start - GOALS[goal].shift}）`)
    }
    const pairs = []
    try {
      pairUp(A.ast, B.ast, pairs, A.ast, '')
    } catch (e) {
      if (e instanceof Mismatch) e.message = `${tag} ${e.message}`
      throw e
    }
    const ra = A.info.res
    const rb = B.info.res
    const toAfter = new Map(pairs)
    const seenDecl = new Map() // after の宣言 → before の宣言（単射の確認）
    let bound = 0
    let free = 0
    let nonref = 0
    for (const [x, y] of pairs) {
      const dx = ra.get(x)
      const dy = rb.get(y)
      if (dx === undefined || dy === undefined) {
        // acorn-walk が辿らない識別子 = 参照でも束縛でもない（非計算のキー・メンバー名など）
        if (dx !== dy || x.name !== y.name) throw new Mismatch(`${tag} 参照でない識別子が不一致（offset ${at(x)}）: ${x.name} → ${y.name}`)
        nonref++
        continue
      }
      if (dx === 'free' || dy === 'free') {
        if (dx !== dy || x.name !== y.name) {
          const st = (d) => (d === 'free' ? '自由' : '束縛')
          throw new Mismatch(`${tag} 自由変数の扱いが不一致（offset ${at(x)}）: ${x.name}（${st(dx)}）→ ${y.name}（${st(dy)}）`)
        }
        free++
        continue
      }
      if (A.info.topMeta.has(dx) && y.name !== 'meta') throw new Mismatch(`${tag} 最上位の meta が改名された（offset ${at(x)}）: meta → ${y.name}`)
      if (dy === y && x.name !== y.name && SPECIAL_NAMES.has(y.name)) {
        throw new Mismatch(`${tag} 宣言の新しい名前が特別な名前（offset ${at(x)}）: ${x.name} → ${y.name}`)
      }
      if (toAfter.get(dx) !== dy) {
        throw new Mismatch(`${tag} 束縛の対応が不一致（offset ${at(x)}）: ${x.name}（宣言 offset ${at(dx)}）→ ${y.name}（宣言 offset ${at(dy)}）`)
      }
      const back = seenDecl.get(dy)
      if (back !== undefined && back !== dx) throw new Mismatch(`${tag} 宣言の対応が単射でない（offset ${at(x)}）`)
      seenDecl.set(dy, dx)
      bound++
    }
    // 束縛の対応を確かめた後に見る（変換後だけで当たるのは束縛不一致の症状なので、先に束縛の不一致として報告する）
    for (const [side, X] of sides) {
      const { stringified } = X.info
      if (stringified.length > 0) {
        const s = stringified[0]
        throw new Mismatch(`${tag} ${side}: 関数値の文字列化 ${stringified.length} 件。最初は ${s.id.name} が${s.why}（offset ${at(s.id)}）`)
      }
    }
    return { ok: true, stats: { identifiers: pairs.length, bound, free, nonref } }
  } catch (e) {
    if (e instanceof Mismatch) return { ok: false, kind: 'mismatch', detail: e.message }
    throw e
  }
}

function verifyAlpha(before, after) {
  const stats = {}
  // module を先に見る（最上位 meta の改名は script では export が残ってパースできず、不一致の理由が隠れる）
  for (const goal of Object.keys(GOALS)) {
    const r = verifyGoal(before, after, goal)
    if (!r.ok) return r
    stats[goal] = r.stats
  }
  // 改名は行の中だけを変える（生成物と src の行番号を一致させたままにする）
  const la = before.split('\n').length
  const lb = after.split('\n').length
  if (la !== lb) return { ok: false, kind: 'mismatch', detail: `行数が不一致: ${la} ≠ ${lb}` }
  const d = (s) => `識別子 ${s.identifiers}（束縛 ${s.bound}・自由 ${s.free}・非参照 ${s.nonref}）`
  return { ok: true, kind: 'match', detail: `[module] ${d(stats.module)} / [script] ${d(stats.script)}`, stats }
}

const chunks = []
process.stdin.on('data', (d) => chunks.push(d))
process.stdin.on('end', () => {
  const cases = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(cases)) throw new TypeError('入力は配列でなければならない')
  cases.forEach((c, i) => {
    if (c === null || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.before !== 'string' || typeof c.after !== 'string') {
      throw new TypeError(`入力の ${i} 番目は { name, before, after }（すべて文字列）でなければならない`)
    }
  })
  const results = cases.map((c) => ({ name: c.name, ...verifyAlpha(c.before, c.after) }))
  process.stdout.write(JSON.stringify({ acornVersion: acorn.version, results }))
})

// 識別子の改名の前後（before = コメント・空白を除いた生成物 stage1、after = 局所識別子を短縮した生成物）が、
// スコープを尊重した一対一の改名だけで異なることを確かめる α 同値の検証器。ビルダーの照合 2 にあたり、
// 改名器（mangle-identifiers.cjs）とは独立に書いている（走査は acorn-walk の fullAncestor、解決は識別子ごとに
// 祖先列を内から外へたどる。改名器のスコープ表・走査コードは使わない）。
//
// 保証すること（module と script の両ゴールで一致を要求する）:
// - AST の形・リテラル・テンプレートの地の文・演算子・フラグが完全に同じ（プロンプト本文が 1 文字も変わらない）
// - 参照と束縛の対応が同じ（各参照の解決先の宣言が、改名後も同じ位置の宣言になる）・自由変数は同名のまま・
//   参照でない識別子（非計算のキー・メンバー名）は同名のまま・最上位の meta は改名しない・行数が同じ
// - 新しい宣言名が特別な名前でない
// - 関数の名前・ソース文字列を観測しない（改名で変わるため）。観測の形を 1 つずつ追うと収束しないので、
//   受け手が関数かを追わずに次を一律に拒否する:
//   (i) プロパティ name・toString・toSource を読む構文すべて（非計算メンバー・文字列 / 式なしテンプレートの
//       計算メンバー・optional chaining・分割代入と引数パターンのキー・Reflect.get 等の呼び出しにリテラルで渡すキー）。
//       例外は受け手が構文上必ず数値になる式（数値リテラル・単項 + - ~・算術とビット演算の二項式。括弧つきを含む）だけ
//   (ii) 関数式・アロー関数そのものを String() の引数・テンプレートの式・+ の被演算子・+= の右辺・concat() の引数にする形
//   加えて、宣言・関数式の束縛・既定値・const / 代入による別名で関数値を追い、その束縛の文字列化
//   （String()・テンプレート・+・+=・.length・計算プロパティ・分割代入）を拒否する
// 保証しないこと（残るリスク）:
// - 別名を経た暗黙の文字列化は静的には完全に検出できない。追跡の外の束縛（引数・オブジェクト・配列・戻り値を
//   経た関数値）に対する String(alias)・`${alias}`・alias + '' や、[f].join() などの配列を経た暗黙の変換、
//   追跡外の受け手への動的な計算キー（o[k]・o['na' + 'me']）、キーを持たない反射（Object.getOwnPropertyDescriptors）、
//   Error の stack（関数名を含む）は見えない。改名後の生成物で全テスト（stub-run を含む）を流すことが補償になる
// - パーサは改名器と同じ Node 同梱の acorn なので、acorn が誤った AST を返す共通故障は見えない。
//   それは照合 1（token-diff.cjs が src と stage1 のトークン列を照合済み）と CI の V8 バイトコードオラクル
//   （tests/lib/v8-bytecode-oracle.cjs）で補う
// 対応外の構文（var・class・with・ラベル・eval・arguments・ブロック内 / switch 内の関数宣言）はスコープ規則を
// 持たないので、両テキストとも拒否する。
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
// 関数の名前・ソース文字列を返し得るプロパティ。受け手が関数かを追わず、読む構文を一律に拒否する
const OBSERVED_PROPS = new Set(['name', 'toString', 'toSource'])
// 結果が必ず数値（Number / BigInt）になる二項演算子。`+` は文字列連結にもなるので含めない
const NUMERIC_BINARY = new Set(['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'])

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
  if (parent.type === 'MemberExpression' && parent.object === id) {
    if (!parent.computed && STRINGIFY_MEMBERS.has(parent.property.name)) return { why: `.${parent.property.name} のオブジェクト` }
    // 計算プロパティ（f["name"]・f[k]）はキーを判定しきれないので、関数値に対しては一律に拒否する
    if (parent.computed) return { why: '計算プロパティのオブジェクト' }
  }
  // 分割代入（const {name} = f・({name} = f)）で関数のプロパティを取り出す
  const pattern = (parent.type === 'VariableDeclarator' && parent.init === id && parent.id) ||
    (parent.type === 'AssignmentExpression' && parent.right === id && parent.left)
  if (pattern && pattern.type === 'ObjectPattern') return { why: '分割代入の元' }
  return null
}

// キーの静的な文字列値（非計算の識別子・文字列リテラル・式を持たないテンプレート）。決まらなければ null
function staticKey(key, computed) {
  if (!computed && key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0].value.cooked
  return null
}

// 構文上必ず数値になる式（数値リテラル・単項 + - ~・算術とビット演算の二項式。括弧は AST に残らない）
const isNumeric = (e) => (e.type === 'Literal' && (typeof e.value === 'number' || typeof e.value === 'bigint')) ||
  (e.type === 'UnaryExpression' && (e.operator === '+' || e.operator === '-' || e.operator === '~')) ||
  (e.type === 'BinaryExpression' && NUMERIC_BINARY.has(e.operator))

const isFunctionValue = (e) => e.type === 'FunctionExpression' || e.type === 'ArrowFunctionExpression'

// 関数の名前・ソース文字列を観測し得る構文か（受け手が関数かは追わない）。当たれば固定の語彙の説明、当たらなければ null。
// 説明に入力の文字列は入れない（プロパティ名は OBSERVED_PROPS の 3 語のどれかに限る）
function observeSite(n, parent) {
  if (n.type === 'MemberExpression') {
    const k = n.property.type === 'PrivateIdentifier' ? null : staticKey(n.property, n.computed)
    if (k !== null && OBSERVED_PROPS.has(k) && !isNumeric(n.object)) return `${n.computed ? '計算メンバー' : 'メンバー'}の ${k}`
  }
  if (n.type === 'ObjectPattern') {
    for (const p of n.properties) {
      const k = p.type === 'Property' ? staticKey(p.key, p.computed) : null
      if (k !== null && OBSERVED_PROPS.has(k)) return `分割代入・引数パターンのキー ${k}`
    }
  }
  // Reflect.get(f, 'name')・Object.getOwnPropertyDescriptor(f, 'name') など、キーをリテラルで渡す呼び出し
  if (n.type === 'CallExpression' || n.type === 'NewExpression') {
    for (const a of n.arguments) {
      const k = a.type === 'Literal' || a.type === 'TemplateLiteral' ? staticKey(a, true) : null
      if (k !== null && OBSERVED_PROPS.has(k)) return `呼び出しの引数のキー ${k}`
    }
  }
  // 関数式・アローそのものを文字列にする（別名を経た文字列化は構文では決まらない。冒頭の「保証しないこと」）
  if (isFunctionValue(n) && parent) {
    if (parent.type === 'CallExpression' && parent.arguments.includes(n)) {
      if (parent.callee.type === 'Identifier' && parent.callee.name === 'String') return '関数式を String() の引数にする'
      if (parent.callee.type === 'MemberExpression' && staticKey(parent.callee.property, parent.callee.computed) === 'concat') return '関数式を concat() の引数にする'
    }
    if (parent.type === 'TemplateLiteral' && parent.expressions.includes(n)) return '関数式をテンプレートの式にする'
    if (parent.type === 'BinaryExpression' && parent.operator === '+') return '関数式を + の被演算子にする'
    if (parent.type === 'AssignmentExpression' && parent.operator === '+=' && parent.right === n) return '関数式を += の右辺にする'
  }
  return null
}

// 1 つの AST を 1 回の走査で解析する。res: 識別子 → 宣言の識別子 | 'free'（acorn-walk が辿らない識別子は入らない）
function analyze(ast, goal) {
  const cache = new Map()
  const res = new Map()
  const fnDecls = new Set()
  const sites = []
  const aliases = [] // [別名の宣言 | 代入先の識別子, 値の識別子]（const a = f / a = f）
  const assignedFns = [] // 後から関数式を代入される識別子（let a; a = () => 1）
  const observed = [] // 関数の名前・ソースを観測し得る構文（受け手を問わない一律の拒否）
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
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'Identifier') aliases.push([n.id, n.init])
    else if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && n.right.type === 'Identifier') aliases.push([n.left, n.right])
    else if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'Identifier' && isFunctionValue(n.right)) assignedFns.push(n.left)
    // 既定値が関数の束縛（function f(g = () => 1)・const {g = () => 1} = o）も関数値を受け取り得る
    else if (n.type === 'AssignmentPattern' && n.left.type === 'Identifier' && isFunctionValue(n.right)) assignedFns.push(n.left)
    const seen = observeSite(n, anc[anc.length - 2])
    if (seen) observed.push({ why: seen, start: n.start })
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
  // 関数値を別名へ移した束縛も関数に解決されるものとして扱う（不動点まで。別名の別名を含む）
  const declOf = (id) => (res.get(id) === 'free' ? null : res.get(id) ?? null)
  for (const id of assignedFns) if (declOf(id)) fnDecls.add(declOf(id))
  for (let changed = true; changed;) {
    changed = false
    for (const [target, value] of aliases) {
      const t = declOf(target)
      if (t && !fnDecls.has(t) && fnDecls.has(declOf(value))) {
        fnDecls.add(t)
        changed = true
      }
    }
  }
  const stringified = sites.filter((x) => fnDecls.has(res.get(x.id)) && (!x.callee || res.get(x.callee) === 'free'))
  // 最上位（module は Program、script は包み関数の本体）の meta 宣言
  const top = goal === 'module' ? ast.body : ast.body[0].expression.body.body
  const topMeta = new Set(lexicalIds(top).filter((id) => id.name === 'meta'))
  return { res, bad, stringified, observed, topMeta }
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
    if (k === 'shorthand' && a.type === 'Property') {
      // {__proto__} はデータプロパティ、{__proto__: x} はプロトタイプの設定で意味が違う
      if (a.shorthand !== b.shorthand && !a.computed && (a.key.name ?? a.key.value) === '__proto__') {
        throw new Mismatch(`__proto__ の shorthand が変わった（offset ${a.start}）`)
      }
      continue
    }
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
    // 受け手を追わない一律の拒否。束縛の確認より後に見る（先に見ると、変異体の束縛不一致がこの理由に隠れる）
    for (const [side, X] of sides) {
      const { observed } = X.info
      if (observed.length > 0) {
        const s = observed[0]
        throw new Mismatch(`${tag} ${side}: 関数の名前・ソースを観測し得る構文 ${observed.length} 件。最初は ${s.why}（offset ${at(s)}）`)
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

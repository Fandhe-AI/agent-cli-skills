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
//   次の 2 つで拒否する:
//   (i) 受け手が関数かを追わない一律の拒否。プロパティ name・toString・toSource を読む構文すべて（非計算メンバー・文字列 / 式なしテンプレートの
//       計算メンバー・optional chaining・分割代入と引数パターンのキー・Reflect.get 等の呼び出しにリテラルで渡すキー）。
//       例外は受け手が構文上必ず数値になる式（数値リテラル・単項 + - ~・算術とビット演算の二項式。括弧つきを含む）だけ
//   (ii) 関数値の位置の許可リスト（手順 6）。直接の関数式・アロー関数と、追跡済みの関数束縛（宣言・関数式の束縛・
//       既定値・const / 代入による別名）の参照は、親ノードでの位置が許可リストにあるときだけ通す。許可するのは、
//       宣言・代入・既定値・オブジェクトの値（非計算キー）・return・アローの本体・呼び出しの callee・非計算のメンバーの
//       object（name・toString・toSource・toLocaleString を除く。f.call・f.length 等）・呼び出しの引数。
//       呼び出しの引数も許可リストで、呼び出し先が (a) プログラム内で束縛された識別子（自由変数の別名〔const S = String・
//       const lg = console.log・const {log} = console〕を除く）(b) 既知のコールバックメソッド（map・then・call 等。object が自由変数を根に持つ
//       名前空間なら Array・Promise・Object の直下だけ。call・apply・bind は object が関数値のときだけ。replace /
//       replaceAll は第 2 引数だけ）(c) setTimeout・setInterval・queueMicrotask・new Promise のどれかのときだけ通す。
//       括弧・カンマ式の最後・条件式の枝・論理式は親の位置を引き継ぎ、配列リテラルの要素は配列の位置で判定する
//       （配列を object にしてよいのは length と、第 1 引数が関数式か束縛された関数の反復メソッドだけ。関数値を入れた
//       オブジェクトリテラルは、メンバーの値が関数値そのものになり得るので length を含めてメンバーを読まない）。それ以外の位置
//       （計算キー・in・比較・+・テンプレート・タグ・typeof・自由変数や名前空間の関数の引数など）はすべて拒否する
//       コンテナ: 関数値を入れた配列・入れ子のコンテナを呼び出しの引数に渡す形は、呼び出し先によらず拒否する。例外は、
//       関数値を非計算キーの値として直に入れたオブジェクトリテラルを (a) の局所束縛の呼び出し先へ渡す形
//       （f({ isValid: g })）だけ。局所束縛の呼び出し先へ関数値をそのまま渡す形はもとから許可しており、受け側での文字列化は
//       追跡外の別名として残るリスクに入れてある。オブジェクトの非計算キーに直に入れて渡す形も、受け側を経るという点で
//       同じ種類のリスクで、新しいリスクは増えない（実物の stage1 では runStateAgent(prompt, { ..., isValid }) の 11 件）
//       派生の判定: 自由変数の別名は、束縛を作るすべての形（宣言・代入・引数や分割代入の既定値・入れ子のパターン・
//       for-in / for-of の頭部）について、パターンと値の式の組で判定し、用途で 2 つに分ける。(a) の呼び出し先には広い派生
//       （値の式に自由変数を 1 つでも含めば、パターンが束縛する名前すべてを別名とみなす。偽陽性の側）を使う。(b) の名前空間
//       には狭い派生（値の式の構造だけを見て、自由変数そのもの・メンバー連鎖・配列 / オブジェクトリテラルの要素・条件式の
//       枝が自由変数を根に持つときだけ別名とみなす。呼び出しの結果は別名にしない）を使う。(b) に広い派生を使うと、
//       Object.keys(o) や args.x から作った配列の .map(f) まで名前空間の呼び出しとして拒否してしまう（実物の stage1 で 44 件）
// 保証しないこと（残るリスク）:
// - 直接の関数式と追跡済みの束縛については、許可リスト外の位置をすべて拒否する。残るのは追跡外の別名だけで、
//   束縛された関数の引数・オブジェクトのプロパティ・配列の要素・戻り値を経た関数値（function g(x){return `${x}`}g(f)・
//   o.m = f; String(o.m)・const xs = [f]; xs.join()・局所関数に f({ k: g }) で渡したオブジェクトのプロパティなど）は、
//   その先の文字列化が見えない。引数で受け取った自由変数の
//   関数（function g(S){return S(f)}g(String)）と、呼び出しの結果として返る名前空間（const R = getReflect(); R.get(o, f)。
//   狭い派生は呼び出しの結果を別名にしない）も見えない。キーを持たない反射
//   （Object.getOwnPropertyDescriptors）・Error の stack（関数名を含む）も見えない。改名後の生成物で全テスト
//   （stub-run を含む）を流すことが補償になる
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

// 関数値を文字列化しない（引数として渡す・呼ぶ・束縛する等）と確かめた位置の許可リスト（手順 6）。
// 直接の関数式・アローと、追跡済みの関数束縛の参照について、親ノードでの位置がこのリストに無ければ拒否する
// （計算キー・in・比較・+・テンプレート・タグ・concat・Symbol などを位置の列挙なしにまとめて塞ぐ）。
// 呼び出しの引数に渡せるのは、呼び出し先が次の許可リストに当たるときだけ（引数の位置も許可リストで判定する）:
//   (a) プログラム内で束縛された識別子（自由変数・自由変数の別名〔const S = String 等〕を除く）
//   (b) 非計算のメンバーで、名前が CALLBACK_METHODS にあるもの。object が自由変数（とその別名）を根に持つ名前空間なら
//       許可しない（例外は NAMESPACE_OK の組だけ）。call・apply・bind は object が関数値そのもののときだけ
//   (c) 自由変数の CALLBACK_FREE（setTimeout 等）と、new の呼び出し先の Promise
// 関数を引数に受け取り、文字列化せずに呼ぶ・保持するだけの既知のメソッド。replace / replaceAll は第 2 引数だけ
const CALLBACK_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'reduce', 'reduceRight', 'flatMap', 'sort', 'then', 'catch', 'finally', 'call', 'apply', 'bind', 'replace', 'replaceAll',
  'push', 'unshift', 'set', 'add', 'get', 'has', 'from'])
const SECOND_ARG_ONLY = new Set(['replace', 'replaceAll'])
const SELF_CALL = new Set(['call', 'apply', 'bind'])
// 自由変数の名前空間のうち、CALLBACK_METHODS のメソッドに限って関数値を渡してよいもの（Array.from 等）
const NAMESPACE_OK = new Set(['Array', 'Promise', 'Object'])
const CALLBACK_FREE = new Set(['setTimeout', 'setInterval', 'queueMicrotask'])
// 関数値を要素に持つ配列リテラルを object にしてよい反復メソッド（第 1 引数が関数式か束縛された関数のとき）
const ITERATE_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'reduce', 'reduceRight', 'flatMap', 'sort'])
// 関数値のメンバーで、名前・ソースを返し得るもの（Object.prototype.toLocaleString は this.toString() を呼ぶ）
const SOURCE_MEMBERS = new Set([...OBSERVED_PROPS, 'toLocaleString'])

// anc[i] にある値が許可された位置にあるか。許可されなければ位置の説明（固定の語彙: ノードの型とキー）、許可されれば null。
// 呼び出しの引数と配列の反復は { label, arg | iterate } を返し、解決後に argAllowed / iterateAllowed で判定する。
// mode は 'value'（関数値そのもの）か 'container'（関数値を要素に持つ配列リテラル）
function fnPositionDenied(anc, i, mode, res) {
  const child = anc[i]
  const p = anc[i - 1]
  if (!p) return 'Program'
  const up = (m = mode) => fnPositionDenied(anc, i - 1, m, res)
  const key = Object.keys(p).find((k) => p[k] === child || (Array.isArray(p[k]) && p[k].includes(child))) ?? '?'
  const label = `${p.type}.${key}${mode === 'value' ? '' : '（配列・オブジェクトの要素）'}`
  switch (p.type) {
    // 値を引き継ぐ位置は親の位置で判定する
    case 'ParenthesizedExpression':
      return up()
    case 'SequenceExpression':
      return p.expressions[p.expressions.length - 1] === child ? up() : label
    case 'ConditionalExpression':
      return p.test === child ? label : up()
    case 'LogicalExpression':
      return up()
    case 'ArrayExpression':
      return up('container')
    // 束縛・代入
    case 'VariableDeclarator':
      return null
    case 'AssignmentExpression':
      if (p.operator !== '=') return label
      if (p.left === child) return null
      return p.left.type === 'Identifier' || p.left.type === 'MemberExpression' ? null : label
    case 'AssignmentPattern':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
    case 'CatchClause':
      return null
    case 'ForInStatement':
    case 'ForOfStatement':
      return p.left === child ? null : label
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return p.id === child || p.params.includes(child) ? null : label
    case 'ArrowFunctionExpression':
      return p.body === child || p.params.includes(child) ? null : label
    case 'Property': {
      // オブジェクトリテラルの値は、オブジェクトの位置で判定する。関数値を非計算キーの値として直に入れたものは 'object'、
      // 配列や入れ子のオブジェクトを経たものは 'container'
      const gp = anc[i - 2]
      if (!gp || gp.type !== 'ObjectExpression' || p.value !== child || p.computed) return label
      return fnPositionDenied(anc, i - 2, mode === 'value' ? 'object' : 'container', res)
    }
    case 'ReturnStatement':
    case 'ExportDefaultDeclaration':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return null
    // 呼ぶ・渡す
    case 'CallExpression':
    case 'NewExpression':
      if (p.callee === child) return mode === 'value' ? null : label
      // 関数値を入れた配列・入れ子のコンテナを引数に渡すのは、呼び出し先によらず拒否する（受け側で要素がどう使われるかは
      // 呼び出し先の許可リストでは決まらない: "x".replace(/x/, [f])・Array.from([f], String)）。例外は、関数値を非計算キーの
      // 値として直に入れたオブジェクトリテラル（f({ isValid: g })）を (a) の局所束縛の呼び出し先へ渡す形だけ
      // （関数値をそのまま渡す形と同じく、受け側での文字列化は追跡外の別名として残るリスクに入る。冒頭参照）
      if (mode === 'container') return label
      if (mode === 'object') return { label, arg: { call: p, child, objectArg: true } }
      // 呼び出し先が許可リストに当たるかは、全識別子の解決と関数束縛の追跡の後に判定する
      return { label: `${label}（許可されない呼び出し先）`, arg: { call: p, child } }
    case 'MemberExpression': {
      if (p.object !== child || p.computed) return label
      const k = p.property.type === 'Identifier' ? p.property.name : null
      if (k === null || SOURCE_MEMBERS.has(k)) return label
      if (mode === 'value') return null
      // オブジェクトリテラル: メンバーの値は入れた関数値そのものになり得る（({ length: f }).length・({ k: f }).k）ので、
      // どのメンバーを読んでも拒否する
      if (child.type !== 'ArrayExpression') return label
      // 配列リテラル: 要素数だけを見る length と、反復の呼び出し（第 1 引数のコールバックを解決後に判定）だけを許可する
      if (k === 'length') return null
      const call = anc[i - 2]
      if (ITERATE_METHODS.has(k) && call && call.type === 'CallExpression' && call.callee === p) {
        return { label: `${label}（許可されない反復）`, iterate: call }
      }
      return label
    }
    default:
      return label
  }
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
function observeSite(n) {
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
  const derivedCands = [] // [束縛を作るパターン（識別子・分割代入）, 値の式]（宣言・代入・既定値・for-in / for-of の頭部）
  const observed = [] // 関数の名前・ソースを観測し得る構文（受け手を問わない一律の拒否）
  // script ゴールの包み関数（検証器が足したもの。入力の関数式ではない）
  const wrapper = goal === 'script' ? ast.body[0].expression : null
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
    // 束縛を作るすべての形（宣言・代入・引数や分割代入の既定値・for-in / for-of の頭部）を、パターンと値の式の組で集める。
    // 入れ子の既定値は AssignmentPattern として別に集まる
    if (n.type === 'VariableDeclarator' && n.init) derivedCands.push([n.id, n.init])
    else if (n.type === 'AssignmentExpression' && n.operator === '=') derivedCands.push([n.left, n.right])
    else if (n.type === 'AssignmentPattern') derivedCands.push([n.left, n.right])
    else if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left) {
      derivedCands.push([n.left.type === 'VariableDeclaration' ? n.left.declarations[0].id : n.left, n.right])
    }
    const seen = observeSite(n)
    if (seen) observed.push({ why: seen, start: n.start })
    // 直接の関数式・アローは常に、識別子は関数束縛に解決されたときだけ（解決後に絞る）、許可リスト外の位置を拒否する
    if (isFunctionValue(n) && n !== wrapper) {
      const deny = fnPositionDenied(anc, anc.length - 1, 'value', res)
      if (deny) sites.push({ node: n, direct: true, deny })
    }
    if (n.type !== 'Identifier') return
    const deny = fnPositionDenied(anc, anc.length - 1, 'value', res)
    if (deny) sites.push({ node: n, direct: false, deny })
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
  // 自由変数の派生は用途で 2 つに分ける（冒頭の「派生の判定」）。
  // 広い派生（(a) の呼び出し先の判定にだけ使う）: 値の式に自由変数（または派生した束縛）の識別子が 1 つでも含まれる束縛は、
  // パターンが束縛する名前をすべて自由変数の別名とみなす（const S = String・function f(S = String)・
  // const {String: S} = globalThis・[S] = [String] を (a) で通さない。偽陽性の側に倒す）。関数式・アローの中身は値の式に
  // 数えない（値は新しい関数）
  const derived = new Set()
  const rootOf = (e) => {
    while (e.type === 'MemberExpression') e = e.object
    return e
  }
  const isGlobal = (id) => id.type === 'Identifier' && (res.get(id) === 'free' || derived.has(declOf(id)))
  const valueIds = (e, out) => {
    if (!e || typeof e.type !== 'string' || isFunctionValue(e)) return out
    if (e.type === 'Identifier') out.push(e)
    else if (e.type === 'MemberExpression') {
      valueIds(e.object, out)
      if (e.computed) valueIds(e.property, out)
    } else if (e.type === 'Property') {
      if (e.computed) valueIds(e.key, out)
      valueIds(e.value, out)
    } else {
      for (const k of Object.keys(e)) {
        if (POSITION_KEYS.has(k)) continue
        const v = e[k]
        if (Array.isArray(v)) v.forEach((x) => valueIds(x, out))
        else if (v && typeof v.type === 'string') valueIds(v, out)
      }
    }
    return out
  }
  const cands = derivedCands.map(([pattern, value]) => [boundIds(pattern).map(declOf).filter(Boolean), valueIds(value, [])])
  for (let changed = true; changed;) {
    changed = false
    for (const [decls, ids] of cands) {
      if (decls.every((t) => derived.has(t)) || !ids.some(isGlobal)) continue
      for (const t of decls) derived.add(t)
      changed = true
    }
  }
  // 狭い派生（(b) の名前空間の判定にだけ使う）: 値の式の構造だけを見て、自由変数そのもの・そのメンバー連鎖・配列 /
  // オブジェクトリテラルの要素・条件式 / 論理式の枝・カンマ式の最後が自由変数（または狭く派生した束縛）を根に持つときだけ
  // 名前空間の別名とみなす（const R = Reflect・const {log} = console）。呼び出しの結果などの新しい値は別名にしない
  // （const xs = Object.keys(o); xs.map(f) を名前空間の呼び出しとして拒否しない）
  const nsDerived = new Set()
  const isNs =(id) => id.type === 'Identifier' && (res.get(id) === 'free' || nsDerived.has(declOf(id)))
  const nsRoots = (e, out) => {
    if (!e) return out
    if (e.type === 'Identifier' || e.type === 'MemberExpression') out.push(rootOf(e))
    else if (e.type === 'ArrayExpression') e.elements.forEach((x) => nsRoots(x && x.type === 'SpreadElement' ? x.argument : x, out))
    else if (e.type === 'ObjectExpression') e.properties.forEach((x) => nsRoots(x.type === 'SpreadElement' ? x.argument : x.value, out))
    else if (e.type === 'ConditionalExpression') { nsRoots(e.consequent, out); nsRoots(e.alternate, out) }
    else if (e.type === 'LogicalExpression') { nsRoots(e.left, out); nsRoots(e.right, out) }
    else if (e.type === 'SequenceExpression') nsRoots(e.expressions[e.expressions.length - 1], out)
    return out
  }
  const nsCands = derivedCands.map(([pattern, value]) => [boundIds(pattern).map(declOf).filter(Boolean), nsRoots(value, [])])
  for (let changed = true; changed;) {
    changed = false
    for (const [decls, ids] of nsCands) {
      if (decls.every((t) => nsDerived.has(t)) || !ids.some(isNs)) continue
      for (const t of decls) nsDerived.add(t)
      changed = true
    }
  }
  const isFnValue = (e) => isFunctionValue(e) || (e.type === 'Identifier' && fnDecls.has(res.get(e)))
  // 呼び出しの引数に関数値を渡してよいか（冒頭の (a)〜(c)）
  const argAllowed = ({ call, child, objectArg }) => {
    const c = call.callee
    if (objectArg) return c.type === 'Identifier' && res.get(c) !== 'free' && !derived.has(declOf(c))
    if (c.type === 'Identifier') {
      if (res.get(c) === 'free') return call.type === 'NewExpression' ? c.name === 'Promise' : CALLBACK_FREE.has(c.name)
      return !derived.has(declOf(c))
    }
    if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return false
    const k = c.property.name
    if (!CALLBACK_METHODS.has(k)) return false
    if (SECOND_ARG_ONLY.has(k) && call.arguments[1] !== child) return false
    if (SELF_CALL.has(k)) return isFnValue(c.object)
    if (!isNs(rootOf(c.object))) return true
    return c.object.type === 'Identifier' && res.get(c.object) === 'free' && NAMESPACE_OK.has(c.object.name)
  }
  // 関数値を要素に持つ配列の反復: 第 1 引数が関数式か、束縛された（自由変数の別名でない）識別子のとき
  const iterateAllowed = (call) => {
    const cb = call.arguments[0]
    if (!cb) return false
    if (isFunctionValue(cb)) return true
    return cb.type === 'Identifier' && res.get(cb) !== 'free' && !derived.has(declOf(cb))
  }
  const denied = (x) => {
    if (typeof x.deny === 'string') return true
    if (x.deny.arg) return !argAllowed(x.deny.arg)
    return !iterateAllowed(x.deny.iterate)
  }
  const stringified = sites.filter((x) => (x.direct || fnDecls.has(res.get(x.node))) && denied(x))
    .map((x) => ({ ...x, why: typeof x.deny === 'string' ? x.deny : x.deny.label }))
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
    // 束縛の対応を確かめた後に見る（変換後だけで当たるのは束縛不一致の症状なので、先に束縛の不一致として報告する。
    // 先に見ると、変異体の束縛不一致がこれらの理由に隠れる）。説明は固定の語彙と offset だけ（入力の名前を入れない）
    for (const [side, X] of sides) {
      const { observed } = X.info
      if (observed.length > 0) {
        const s = observed[0]
        throw new Mismatch(`${tag} ${side}: 関数の名前・ソースを観測し得る構文 ${observed.length} 件。最初は ${s.why}（offset ${at(s)}）`)
      }
    }
    for (const [side, X] of sides) {
      const { stringified } = X.info
      if (stringified.length > 0) {
        const s = stringified[0]
        const what = s.direct ? '関数式' : '関数の束縛'
        throw new Mismatch(`${tag} ${side}: 関数値を許可されない位置で使う ${stringified.length} 件。最初は ${what}が ${s.why}（offset ${at(s.node)}）`)
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

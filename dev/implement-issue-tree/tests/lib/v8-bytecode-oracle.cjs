// 改名前後のテキストの等価性を V8 のバイトコードで照合するテスト専用のオラクル（ビルドの門ではない）。
// パーサもスコープ解析も V8 なので、acorn を共有する改名器（mangle-identifiers.cjs）と検証器（alpha-verify.cjs）の
// 共通故障を補う。両テキストを注入 8 名を引数に持つ async 関数で包み、`node --no-lazy --print-bytecode` で
// 全関数のバイトコードを出して関数ごとに比べる。
// - 正規化: アドレス・関数名・ソース位置は捨てる（定数プールの文字列の中身は 16 進表記も含めて捨てない）。ジャンプはバイトオフセットを命令の添字に直す（定数プールの添字が
//   256 を跨ぐと .Wide で命令長が変わるため）。定数プールを指すオペランドは添字ではなく値で比べる。値が違ってよいのは
//   ThrowReferenceErrorIfHole の名前（TDZ エラー文の局所名）だけ
// - fail-closed: 表に無い opcode・命令境界でないオフセット・範囲外の定数・V8 の異常終了は例外（非ゼロ終了）
// - 空振り防止: V8 は参照されない関数をコンパイルしないため、コンパイルされた関数の数が
//   「ソースの関数の数 + 包み 1 + Node 起動処理の固定数（空の包みで実測）」でなければ不一致にする
// - 盲点: オブジェクトリテラルのキー・行番号・意味を変えない改名（ラベル・var・未参照の注入名の影）は見えない
//   （これらは alpha-verify.cjs が見る）。opcode 表は Node 22 / 24 の出力から作った（版が変わると未知の opcode で止まる）
// 起動: node --expose-internals v8-bytecode-oracle.cjs <既存の一時ディレクトリ>（関数の数え上げに同梱 acorn を使う）。
// 入力（stdin）: JSON [{ name, before, after }]。出力（stdout）: JSON { nodeVersion, results: [{ name, ok, detail }] }
'use strict'
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const acorn = require('internal/deps/acorn/acorn/dist/acorn')
const walk = require('internal/deps/acorn/acorn-walk/dist/walk')

const RUNTIME_INJECTED = ['agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'budget', 'workflow']

// 定数プールの添字になるブラケットの位置（ブラケットオペランドの 0 始まりの序数）
const CONST_IDX = {
  LdaConstant: [0], LdaGlobal: [0], LdaGlobalInsideTypeof: [0], StaGlobal: [0], GetNamedProperty: [0], SetNamedProperty: [0],
  DefineNamedOwnProperty: [0], CreateClosure: [0], CreateArrayLiteral: [0], CreateObjectLiteral: [0], CreateRegExpLiteral: [0],
  CreateBlockContext: [0], CreateCatchContext: [0], CreateFunctionContext: [0], GetTemplateObject: [0], JumpConstant: [0],
  JumpIfFalseConstant: [0], JumpIfTrueConstant: [0], JumpIfToBooleanFalseConstant: [0], JumpIfToBooleanTrueConstant: [0],
  JumpIfNullConstant: [0], JumpIfNotNullConstant: [0], JumpIfUndefinedConstant: [0], JumpIfNotUndefinedConstant: [0],
  JumpIfUndefinedOrNullConstant: [0], JumpIfJSReceiverConstant: [0],
  ThrowReferenceErrorIfHole: [0],
}
const LOCAL_NAME = new Set(['ThrowReferenceErrorIfHole'])
// 定数プールを指さないことを確認済みの opcode（ブラケットは帰還スロット・即値・オフセット）
const NO_CONST = new Set(('Add AddSmi BitwiseAnd BitwiseAndSmi BitwiseNot BitwiseOr BitwiseOrSmi BitwiseXor CallProperty ' +
  'CallProperty0 CallProperty1 CallProperty2 CallRuntime CallUndefinedReceiver CallUndefinedReceiver0 CallUndefinedReceiver1 ' +
  'CallUndefinedReceiver2 CallWithSpread SwitchOnSmiNoFeedback SwitchOnGeneratorState CloneObject Construct ' +
  'CreateArrayFromIterable CreateEmptyArrayLiteral CreateEmptyObjectLiteral CreateRestParameter Dec ' +
  'DefineKeyedOwnPropertyInLiteral Div DivSmi GetIterator GetKeyedProperty Inc InvokeIntrinsic Jump JumpIfFalse ' +
  'JumpIfJSReceiver JumpIfNotNull JumpIfNotUndefined JumpIfNull JumpIfToBooleanFalse JumpIfToBooleanTrue JumpIfTrue ' +
  'JumpIfUndefined JumpIfUndefinedOrNull JumpLoop LdaContextSlot LdaCurrentContextSlot LdaFalse LdaImmutableContextSlot ' +
  'LdaImmutableCurrentContextSlot LdaNull Ldar LdaSmi LdaTheHole LdaTrue LdaUndefined LdaZero LogicalNot Mod ModSmi Mov ' +
  'Mul MulSmi PopContext PushContext ResumeGenerator ReThrow Return SetKeyedProperty SetPendingMessage ShiftLeft ' +
  'ShiftLeftSmi ShiftRightLogical ShiftRightLogicalSmi ShiftRightSmi StaContextSlot StaCurrentContextSlot ' +
  'StaInArrayLiteral Star Sub SubSmi SuspendGenerator TestEqual TestEqualStrict TestGreaterThan TestGreaterThanOrEqual ' +
  'TestIn TestLessThan TestLessThanOrEqual TestNull TestReferenceEqual TestTypeOf TestUndefined TestUndetectable Throw ' +
  'ToBooleanLogicalNot ToNumeric ToString').split(' '))

const wrap = (body) => `(async function(${RUNTIME_INJECTED.join(',')}){${body.replace(/^export const meta\b/, 'const meta')}\n})\n`

// 出力はファイルへ受け、latin1（バイトそのまま）で読む。V8 は 2 バイト文字列の一部の文字を下位バイトだけの生の
// バイトで出し、その出し方は実行する機械で変わる（CI では U+300D「」」が生の \r になった）。同じ機械の変換前後は
// 同じ出し方なので比較には使えるが、行の読み方は制御文字に耐える必要がある（parse を参照）。背景タスクも止める
function dump(body, tmpDir) {
  const f = path.join(tmpDir, `oracle-${process.pid}.js`)
  const o = path.join(tmpDir, `oracle-${process.pid}.out`)
  let fd = null
  try {
    fs.writeFileSync(f, wrap(body))
    fd = fs.openSync(o, 'w')
    const r = spawnSync(process.execPath, ['--single-threaded', '--no-lazy', '--print-bytecode', f], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' })
    fs.closeSync(fd)
    fd = null
    if (r.error || r.status !== 0) throw new Error(`V8 のバイトコード出力に失敗: ${r.error ? r.error.message : `status ${r.status}`} ${r.stderr}`)
    return fs.readFileSync(o, 'latin1')
  } finally {
    if (fd !== null) fs.closeSync(fd)
    fs.rmSync(f, { force: true })
    fs.rmSync(o, { force: true })
  }
}

// 関数ごとに、命令のバイト数の合計 = Bytecode length、定数プールの項目 = size を確かめる（出力の欠けを比較の前に止める）
function assertComplete(fn, i) {
  if (fn.len === null || fn.bytes !== fn.len) throw new Error(`V8 の出力が欠けている: 関数 ${i} の命令 ${fn.bytes} B ≠ Bytecode length ${fn.len}`)
  const missing = []
  for (let k = 0; k < (fn.poolSize ?? 0); k++) if (fn.pool[k] === undefined) missing.push(k)
  if (fn.poolSize === null || fn.pool.length !== fn.poolSize || missing.length) {
    // 欠けた添字の前後の生の行を添える（出力の形が想定と違う場合に、形を特定できるように）
    const k = missing[0] ?? 0
    const idx = (l) => {
      const m = /^\s+(\d+)(?:-\d+)?: /.exec(l)
      return m ? +m[1] : null
    }
    const from = fn.poolLines.findLastIndex((l) => idx(l) !== null && idx(l) < k)
    const to = fn.poolLines.findIndex((l) => idx(l) !== null && idx(l) > k)
    const near = fn.poolLines.slice(Math.max(from, 0), to < 0 ? undefined : to + 1).slice(0, 6).map((l) => l.slice(0, 240))
    throw new Error(`V8 の出力が欠けている: 関数 ${i} の定数プール size ${fn.poolSize}・読めた ${fn.pool.length}・欠けた添字 [${missing.slice(0, 5).join(',')}]・前後の行 ${JSON.stringify(near)}`)
  }
}

function parse(text) {
  const out = []
  let cur = null
  let inPool = false
  for (const l of text.split('\n')) {
    if (l.startsWith('[generated bytecode')) {
      cur = { ins: [], pool: [], poolLines: [], last: null, at: new Map(), len: null, bytes: 0, poolSize: null }
      out.push(cur)
      inPool = false
      continue
    }
    if (!cur) continue
    const len = /^Bytecode length: (\d+)$/.exec(l)
    if (len) { cur.len = +len[1]; continue }
    const size = /^Constant pool \(size = (\d+)\)/.exec(l)
    if (size) { cur.poolSize = +size[1]; inPool = true; continue }
    if (/^(Handler Table|Source Position Table)/.test(l)) { inPool = false; continue }
    if (inPool) {
      cur.poolLines.push(l)
      // 同じ値が続く項目は `N-M: 値` にまとめて出力される。文字列の値は生の制御文字（\r・改行）を含み得るので
      // s フラグで読み、項目でない続きの行は直前の項目の値へつなぐ。
      // アドレスを消すのは項目の先頭（次の正規表現で外す）と、文字列でない項目のメタデータ（ボイラープレートが抱える
      // 配列のアドレス等）だけ。文字列の項目は中身がデータなので、"0xdead" のような 16 進表記も含めてそのまま比べる
      const m = l.match(/^\s+(\d+)(?:-(\d+))?: (?:0x[0-9a-f]+ )?(.*)$/s)
      const norm = (v) => (cur.lastIsString ? v : v.replace(/0x[0-9a-f]+/g, '').replace(/<SharedFunctionInfo[^>]*>/, '<SFI>'))
      if (m) {
        cur.last = [+m[1], +(m[2] ?? m[1])]
        cur.lastIsString = m[3].startsWith('<String[')
        for (let k = cur.last[0]; k <= cur.last[1]; k++) cur.pool[k] = norm(m[3])
      } else if (cur.last) {
        for (let k = cur.last[0]; k <= cur.last[1]; k++) cur.pool[k] += `\n${norm(l)}`
      }
      continue
    }
    const m = l.match(/@\s+(\d+) : ((?:[0-9a-f]{2} )+)\s*([A-Z]\S*)(.*)$/)
    if (m) {
      cur.at.set(+m[1], cur.ins.length)
      cur.bytes += m[2].trim().split(' ').length
      cur.ins.push({ op: m[3], args: m[4].replace(/\(0x[0-9a-f]+ @/, '(@').trim() })
    }
    // ハンドラ表（try/catch の範囲）は命令オフセットで比べる
    if (/^\s+\(\s*\d+,\s*\d+\)\s+->/.test(l)) cur.ins.push({ op: '#handler', args: l.trim() })
  }
  out.forEach(assertComplete)
  return out
}

function canon(fn, insn) {
  const raw = insn.op.replace(/\.(Wide|ExtraWide)$/, '')
  // 短縮形 StarN は代入先のレジスタを opcode 名に持つので、レジスタを残して Star と同じ扱いにする
  const star = /^Star(\d+)$/.exec(raw)
  const base = star ? 'Star' : raw
  const idx = (off) => {
    const i = fn.at.get(+off)
    if (i === undefined) throw new Error(`命令境界でないオフセット ${off}`)
    return `#${i}`
  }
  if (insn.op === '#handler') return insn.args.replace(/\d+/g, (n) => (fn.at.has(+n) ? idx(n) : n))
  const args0 = insn.args.replace(/@\s*(\d+)/g, (_a, n) => `@${idx(n)}`)
  const constPos = CONST_IDX[base]
  if (!constPos && !NO_CONST.has(base)) throw new Error(`未知の opcode: ${insn.op}`)
  let k = -1
  const args = args0.replace(/\[(\d+)\]/g, (all, n) => {
    k++
    if (/^Jump/.test(base) && k === 0) return '[<jump>]' // 相対オフセット。飛び先は (@#添字) で比べる
    if (!constPos || !constPos.includes(k)) return all
    if (LOCAL_NAME.has(base)) return '[<local>]'
    const v = fn.pool[+n]
    if (v === undefined) throw new Error(`定数プールの範囲外: ${insn.op} ${insn.args}`)
    return `[=${v}]`
  })
  return `${base}${star ? ` r${star[1]}` : ''} ${args}`
}

function countFunctions(code) {
  let n = 0
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
  walk.full(ast, (x) => { if (/Function/.test(x.type)) n++ })
  return n
}

// 同じテキストのダンプはケース間で使い回す（実物の stage1 を何度も出さない）
const dumped = new Map()
const functionsOf = (code, tmpDir) => {
  if (!dumped.has(code)) dumped.set(code, parse(dump(code, tmpDir)))
  return dumped.get(code)
}

function compareOne(before, after, bootstrap, tmpDir) {
  const A = functionsOf(before, tmpDir)
  const B = functionsOf(after, tmpDir)
  for (const [code, F, tag] of [[before, A, '変換前'], [after, B, '変換後']]) {
    const want = bootstrap + 1 + countFunctions(code)
    if (F.length !== want) return { ok: false, detail: `${tag}: コンパイルされた関数 ${F.length} ≠ 期待 ${want}（参照されない関数があり比較できない）` }
  }
  if (A.length !== B.length) return { ok: false, detail: `関数の数が不一致 ${A.length} ≠ ${B.length}` }
  let n = 0
  for (let i = 0; i < A.length; i++) {
    const a = A[i].ins
    const b = B[i].ins
    if (a.length !== b.length) return { ok: false, detail: `関数 ${i}: 命令数が不一致 ${a.length} ≠ ${b.length}` }
    for (let j = 0; j < a.length; j++) {
      const x = canon(A[i], a[j])
      const y = canon(B[i], b[j])
      if (x !== y) return { ok: false, detail: `関数 ${i} 命令 ${j}: ${x} ≠ ${y}` }
      n++
    }
  }
  return { ok: true, detail: `${A.length} 関数・${n} 命令が一致` }
}

function main() {
  const tmpDir = process.argv[2]
  if (!tmpDir || !fs.statSync(tmpDir).isDirectory()) throw new Error('引数に既存の一時ディレクトリを渡す')
  const cases = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (!Array.isArray(cases)) throw new Error('入力は配列')
  for (const c of cases) if (typeof c.before !== 'string' || typeof c.after !== 'string') throw new Error(`before / after が文字列でない: ${c.name}`)
  // 空の包みで数えた関数から包み自身を引いた数（Node 起動処理とスクリプトの最上位）
  const bootstrap = parse(dump('', tmpDir)).length - 1
  const results = cases.map((c) => ({ name: c.name, ...compareOne(c.before, c.after, bootstrap, tmpDir) }))
  return JSON.stringify({ nodeVersion: process.version, results })
}

module.exports = { parse }
if (require.main === module) {
  let out
  try {
    out = main()
  } catch (e) {
    process.stderr.write(`${e && e.message ? e.message : e}\n`)
    process.exitCode = 1
  }
  if (out !== undefined) process.stdout.write(out)
}

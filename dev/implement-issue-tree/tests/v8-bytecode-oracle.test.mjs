// V8 バイトコードオラクル（tests/lib/v8-bytecode-oracle.cjs）のテスト。CI（Node 22）で毎 PR 走る第 3 の照合。
// 実物の stage1 ↔ 改名器の出力が一致すること、合成の意味変化を止めること、関数の数の検査で空振りを止めることを確かめる。
// opcode 表は Node 22 / 24 の出力から作ったため、手元のそれ以外のメジャー版では理由を明示して飛ばす。
// CI（環境変数 CI がある）では版に関わらず飛ばさない（Node が上がって照合が黙って消えないよう、未知の opcode で止める）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildStage1, mangleText, refswapMutants, v8Oracle, ORACLE_PATH } from './lib/mangle-harness.mjs'

const MAJOR = Number(process.versions.node.split('.')[0])
const SUPPORTED = MAJOR === 22 || MAJOR === 24
const skip = SUPPORTED || process.env.CI ? false : `opcode 表は Node 22 / 24 で作成（実行中は ${process.version}）`

const H = 'export const meta={name:"x"}\n'
// 合成ケースは関数 f・g を返して参照させる（V8 は参照されない関数をコンパイルしないため）
const T = '\nreturn [typeof f==="undefined"?0:f,typeof g==="undefined"?0:g]'

// [名前, 変換前, 変換後, 一致するはずか]
const CASES = [
  ['正しい改名', 'const a=1;function f(){const b=2;return a+b}', 'const c=1;function f(){const d=2;return c+d}', true],
  ['シャドーイングによる捕捉', 'const a=1;function f(){const b=2;return a+b}', 'const a=1;function f(){const a=2;return a+a}', false],
  ['自由変数の捕捉', 'function f(){const x=1;return JSON.stringify(x)}', 'function f(){const JSON=1;return JSON.stringify(JSON)}', false],
  ['自由変数の改名', 'function f(){return foo()}', 'function f(){return bar()}', false],
  ['typeof 未宣言の捕捉', 'function f(){const v=1;return typeof zz}', 'function f(){const zz=1;return typeof zz}', false],
  ['巻き上げの正しい改名', 'function f(){return g();function g(){return 1}}', 'function f(){return h();function h(){return 1}}', true],
  ['巻き上げによる捕捉', 'const k=1;function f(){return k+g();function g(){}}', 'const k=1;function f(){return k+k();function k(){}}', false],
  ['ブロックの正しい影', 'function f(){const a=1;{const b=2;use(b)}return a}', 'function f(){const a=1;{const a=2;use(a)}return a}', true],
  ['ブロックでの捕捉', 'function f(){const a=1;{const b=2;use(a)}}', 'function f(){const a=1;{const a=2;use(a)}}', false],
  ['catch 引数での捕捉', 'function f(){const e=1;try{}catch(x){use(e)}}', 'function f(){const e=1;try{}catch(e){use(e)}}', false],
  ['catch 引数の正しい改名', 'function f(){const e=1;try{}catch(x){use(x,e)}}', 'function f(){const e=1;try{}catch(y){use(y,e)}}', true],
  ['プロパティ名の変更', 'function f(o){return o.foo}', 'function f(o){return o.a}', false],
  ['リテラルの変更', 'function f(){return "x"}', 'function f(){return "y"}', false],
  // 定数プールの文字列の中の 16 進表記はデータ。アドレスとして消すと同じ長さの別の文字列が同一に見える
  ['定数文字列の 16 進表記の変更', 'function f(){return "0xdead"}', 'function f(){return "0xbeef"}', false],
  ['定数文字列の 16 進表記の正しい改名', 'function f(){const a="0xdead";return a}', 'function f(){const b="0xdead";return b}', true],
  ['テンプレートの地の文の変更', 'function f(a){return `a${a}`}', 'function f(b){return `b${b}`}', false],
  ['for-of の TDZ', 'function f(){const x=[1];for(const y of x){use(y)}}', 'function f(){const x=[1];for(const x of x){use(x)}}', false],
  ['名前つき関数式の捕捉', 'function f(){const h=1;return function g(){return h}}', 'function f(){const h=1;return function h(){return h}}', false],
  ['束縛の入れ替え（正しい）', 'function f(){const a=1,b=2;return [a,b]}', 'function f(){const b=1,a=2;return [b,a]}', true],
  ['参照だけの入れ替え', 'function f(){const a=1,b=2;return [a,b]}', 'function f(){const a=1,b=2;return [b,a]}', false],
  ['代入先レジスタの入れ替え', 'function f(){let a,b;a=1;b=2;return a-b}', 'function f(){let a,b;b=1;a=2;return a-b}', false],
  ['注入名の捕捉', 'function f(){const q=1;return agent(q)}', 'function f(){const agent=1;return agent(agent)}', false],
  // 盲点の記録: オブジェクトリテラルのキーは boilerplate に入りバイトコードに出ない（検証器が見る）
  ['盲点: オブジェクトのキー', 'function f(){return {foo:1}}', 'function f(){return {a:1}}', true],
]

test('合成ケース: 意味を変える書き換えを止め、正しい改名を通す', { skip }, async () => {
  const r = await v8Oracle(CASES.map(([name, b, a]) => ({ name, before: H + b + T, after: H + a + T })))
  for (const [name, , , want] of CASES) assert.equal(r.get(name).ok, want, `${name}: ${r.get(name).detail}`)
})

test('関数の数の検査: 参照されずコンパイルされない関数があれば一致としない', { skip }, async () => {
  // f を返さない = f はコンパイルされない。中身が違っても比較が空振りするので、数の検査で止まること
  const r = await v8Oracle([{ name: 'unreferenced', before: H + 'function f(){return 1}', after: H + 'function f(){return 2}' }])
  assert.equal(r.get('unreferenced').ok, false)
  assert.match(r.get('unreferenced').detail, /コンパイルされた関数/)
})

test('実物: stage1 と改名器の出力が V8 で一致し、参照を 1 か所差し替えた変異体は一致しない', { skip }, async () => {
  const stage1 = buildStage1()
  const { code } = await mangleText(stage1)
  const mutants = await refswapMutants(code, 3, 4242)
  assert.equal(mutants.length, 3)
  const r = await v8Oracle([
    { name: 'real', before: stage1, after: code },
    ...mutants.map((m, i) => ({ name: `mutant-${i}`, before: stage1, after: m.text })),
  ])
  assert.equal(r.get('real').ok, true, r.get('real').detail)
  mutants.forEach((m, i) => assert.equal(r.get(`mutant-${i}`).ok, false, `${m.kind} ${m.from}→${m.to} @${m.at}`))
})

// V8 は 2 バイト文字列の一部の文字を生のバイトで出し、出し方は機械で変わる（CI では U+300D が生の \r になり、
// 定数プールの項目が読めなかった）。手元では出ない形なので、合成したダンプで読み方を固定する
test('ダンプの読み方: 定数プールの文字列に生の \\r・改行があっても項目を落とさず、文字列の中の 0x… を残し、欠けは止める', () => {
  // size は項目の添字の最大 + 1（続きの行・`N-M:` のまとめを数えない）
  const slots = (entries) => Math.max(...entries.map((e) => { const m = /^\s+(\d+)(?:-(\d+))?: /.exec(e); return m ? +(m[2] ?? m[1]) + 1 : 0 }))
  const dump = (entries) => [
    '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]',
    'Bytecode length: 3',
    '    0 E> 0x2 @    0 : 13 00             LdaConstant [0]',
    '    1 S> 0x3 @    2 : ae                Return',
    `Constant pool (size = ${slots(entries)})`,
    '0x4: [TrustedFixedArray]',
    ' - map: 0x5 <Map(TRUSTED_FIXED_ARRAY_TYPE)>',
    ` - length: ${slots(entries)}`,
    ...entries,
    'Handler Table (size = 0)',
    'Source Position Table (size = 0)',
  ].join('\n')
  const ok = dump(['           0: 0x6 <String[5]: u#a\rb>', '           1: 0x7 <String[5]: u#c', 'd>', '         2-3: 0x8 <Odd Oddball: uninitialized>',
    '           4: 0x9 <String[8]: #0xdead\r', '0xbeef>', '           5: 0xa <ArrayBoilerplateDescription PACKED_SMI_ELEMENTS, 0xb <FixedArray[3]>>'])
  const missing = dump(['           0: 0x6 <String[1]: #a>', '           2: 0x7 <String[1]: #b>', '           3: 0x7 <String[1]: #c>', '           4: 0x7 <String[1]: #d>'])
  const code = `const { parse } = require(${JSON.stringify(ORACLE_PATH)})
const [ok, missing] = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const fns = parse(ok)
let error = null
try { parse(missing) } catch (e) { error = e.message }
process.stdout.write(JSON.stringify({ pool: fns[0].pool, error }))`
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', code], { input: JSON.stringify([ok, missing]), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  // 文字列の中の 16 進表記は続きの行も含めて残し、文字列でない項目のアドレスだけを消す
  assert.deepEqual(out.pool, ['<String[5]: u#a\rb>', '<String[5]: u#c\nd>', '<Odd Oddball: uninitialized>', '<Odd Oddball: uninitialized>',
    '<String[8]: #0xdead\r\n0xbeef>', '<ArrayBoilerplateDescription PACKED_SMI_ELEMENTS,  <FixedArray[3]>>'])
  assert.match(out.error, /欠けている.*欠けた添字 \[1\]/)
})

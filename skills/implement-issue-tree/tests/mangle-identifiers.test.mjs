// 改名器 scripts/mangle-identifiers.cjs の単体テスト（ビルドには未接続）。
// 変換の形（shorthand の展開・既定値・巻き上げ・catch・for・名前つき関数式・引数と本体の組）・名前の割り当て
// （禁止名・自由変数・meta・最上位の安定名）・決定性・行数・対応外の構文の拒否を確かめる。
// 出力が元と等価であることは独立の検証器（alpha-verify.cjs）で確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mangleBatch, runMangleCli, alphaVerify } from './lib/mangle-harness.mjs'

const H = 'export const meta={name:"x"}\n'
const body = (code) => code.slice(H.length)

// [名前, 入力, 期待する出力]（H の後ろ）。最上位の名前は 2 文字以下にして元のまま残し、局所の割り当てだけを見る
const CONVERSIONS = [
  ['shorthand は key:新名 に展開', 'function f(){const value=1;return {value}}', 'function f(){const a=1;return {value:a}}'],
  ['分割代入の shorthand と既定値', 'function f(o){const {alpha=1}=o;return alpha}', 'function f(o){const {alpha:a=1}=o;return a}'],
  ['引数の既定値は外側を指し本体の同名を指さない', 'const bb=1;function f(param=bb){const bb=2;return param+bb}', 'const bb=1;function f(a=bb){const b=2;return a+b}'],
  ['本体で参照されない引数と本体の宣言は同じ名前にしない', 'function f(longParam){const other=1;return other}', 'function f(a){const b=1;return b}'],
  ['catch 引数と catch 本体の宣言は同じ名前にしない', 'try{}catch(error){const value=1;use(value)}', 'try{}catch(a){const b=1;use(b)}'],
  ['関数宣言の巻き上げ', 'function f(){return inner();function inner(){return 1}}', 'function f(){return a();function a(){return 1}}'],
  ['for-of の束縛', 'function f(xs){for(const item of xs){use(item)}}', 'function f(a){for(const b of a){use(b)}}'],
  // for-in / for-of の本体は頭部と別のスコープ（同名の宣言は早期エラーにならない）。ループ変数を本体・クロージャから
  // 参照するときは衝突として別名になる
  ['for-of の本体の宣言は頭部と同名になり得る（本体はループ変数を参照しない）', 'function f(){for(const item of [1]){const other=2;use(other)}}', 'function f(){for(const a of [1]){const a=2;use(a)}}'],
  ['for-of の本体のクロージャがループ変数と本体の局所を捕まえる', 'function f(xs){const fs=[];for(const item of xs){const other=10;fs.push(()=>item+other)}return fs}', 'function f(a){const b=[];for(const c of a){const a=10;b.push(()=>c+a)}return b}'],
  ['for-in の本体でループ変数と本体の局所を使う', "function f(o){const fs=[];for(const key in o){const other=key+'!';fs.push(()=>[key,other])}return fs}", "function f(o){const a=[];for(const b in o){const c=b+'!';a.push(()=>[b,c])}return a}"],
  ['for の束縛はループの外から見えない（外の同名は自由変数のまま）', 'function f(xs){for(const item of xs){use(item)}return item}', 'function f(a){for(const b of a){use(b)}return item}'],
  ['catch 引数は catch の外から見えない', 'function f(){try{}catch(error){use(error)}return error}', 'function f(){try{}catch(a){use(a)}return error}'],
  ['名前つき関数式は自身の名前スコープ', 'const g=function named(){return named}', 'const g=function a(){return a}'],
  ['テンプレートの式は改名し地の文は不変', 'function f(value){return `value=${value}`}', 'function f(a){return `value=${a}`}'],
  ['非計算のキー・メンバー名は不変、計算キーは参照', 'function f(key){return {[key]:1,key:2}.key+o.key}', 'function f(a){return {[a]:1,key:2}.key+o.key}'],
  ['局所の meta は改名してよい', 'function f(){const meta=1;return meta}', 'function f(){const a=1;return a}'],
  ['自由変数の名前は新しい名前に使わない', 'function f(){const longName=1;return a(longName)}', 'function f(){const b=1;return a(b)}'],
  ['分割代入の代入（宣言でない）の shorthand', 'function f(o){let value;({value}=o);return value}', 'function f(o){let a;({value:a}=o);return a}'],
  ['直下のブロックから外側の束縛を参照（捕捉しない）', 'function f(){const outerName=1;{const innerName=2;use(outerName,innerName)}}', 'function f(){const a=1;{const b=2;use(a,b)}}'],
  ['__proto__ の束縛は改名しない（shorthand を展開するとプロトタイプの設定になる）', 'function f(){const __proto__={x:1};const value=2;return {__proto__,value}}', 'function f(){const __proto__={x:1};const a=2;return {__proto__,value:a}}'],
  ['rest 引数と配列パターン', 'function f(...rest){const [first,,third]=rest;return first+third}', 'function f(...a){const [b,,c]=a;return b+c}'],
]

test('変換の形: 期待どおりの出力になり、独立の検証器で α 同値と判定される', async () => {
  const results = await mangleBatch(CONVERSIONS.map(([, input]) => H + input))
  const verify = await alphaVerify(CONVERSIONS.map(([name, input], i) => ({ name, before: H + input, after: results[i].code ?? '' })))
  CONVERSIONS.forEach(([name, , want], i) => {
    assert.equal(results[i].ok, true, `${name}: ${results[i].error}`)
    assert.equal(body(results[i].code), want, name)
    assert.equal(verify.get(name).ok, true, `${name}: ${verify.get(name).detail}`)
  })
})

test('最上位: meta と 2 文字以下は元のまま、それより長い名前は 2 文字になり禁止名を使わない', async () => {
  const input = H + 'const ab=1\nconst longTopLevel=2\nfunction helperFunction(){return ab+longTopLevel}\nreturn [meta,helperFunction()]'
  const [r] = await mangleBatch([input])
  assert.equal(r.ok, true, r.error)
  const lines = r.code.split('\n')
  assert.equal(lines[0], 'export const meta={name:"x"}')
  assert.equal(lines[1], 'const ab=1')
  const m = /^const (\S+)=2$/.exec(lines[2])
  assert.ok(m && m[1].length === 2 && m[1] !== 'ab', lines[2])
  assert.match(lines[3], /^function (\S{2})\(\)\{return ab\+(\S{2})\}$/)
  assert.ok(lines[4].startsWith('return [meta,'), lines[4])
})

test('最上位の安定名: 名前を 1 つ足しても既存の最上位名の割り当ては（衝突の鎖を除き）変わらない', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `topLevelName${i}`)
  const base = H + names.map((n) => `const ${n}=1`).join('\n') + `\nreturn [${names.join(',')}]`
  const added = base.replace('\nreturn [', '\nconst addedTopLevel=1\nreturn [addedTopLevel,')
  const [a, b] = await mangleBatch([base, added])
  const newNames = (code) => [...code.matchAll(/^const (\S+)=1$/gm)].map((m) => m[1])
  const before = newNames(a.code)
  const after = newNames(b.code).filter((_, i) => i !== names.length) // 足した宣言の行を除く
  const moved = before.filter((n, i) => n !== after[i]).length
  assert.ok(moved <= 1, `動いた最上位名 ${moved} 件`)
})

test('局所の名前が 1 文字を使い切っても予約語・注入名・特別な名前を新しい名前に使わない', async () => {
  // 300 個の局所を内側の関数から参照して互いに衝突させ、2 文字の名前（do・if・in 等を含む範囲）まで割り当てさせる
  const locals = Array.from({ length: 300 }, (_, i) => `localName${i}`)
  const input = H + `function f(){${locals.map((n) => `const ${n}=${JSON.stringify(n)};`).join('')}return ()=>[${locals.join(',')}]}`
  const [r] = await mangleBatch([input])
  assert.equal(r.ok, true, r.error)
  const declared = [...r.code.matchAll(/const ([^=]+)="localName/g)].map((m) => m[1])
  assert.equal(declared.length, 300)
  assert.equal(new Set(declared).size, 300, '同じスコープの名前が重複した')
  const banned = ['do', 'if', 'in', 'of', 'as', 'agent', 'log', 'args', 'phase', 'meta', 'NaN', 'let', 'for', 'new', 'try', 'var', 'get', 'set']
  for (const n of declared) assert.ok(!banned.includes(n), `禁止名 ${n} を使った`)
  assert.ok(declared.some((n) => n.length === 2), '2 文字の名前まで割り当てが進んでいない（検査が空振り）')
  const v = await alphaVerify([{ name: 'many', before: input, after: r.code }])
  assert.equal(v.get('many').ok, true, v.get('many').detail)
})

test('決定性と行数: 同じ入力は同じ出力、改行の数は変わらない', async () => {
  const input = H + 'function f(alpha,\nbeta){\nconst gamma=alpha+\nbeta\nreturn `${gamma}\n`\n}\nreturn f'
  const [a, b] = await mangleBatch([input, input])
  assert.equal(a.code, b.code)
  assert.equal(a.code.split('\n').length, input.split('\n').length)
})

// [名前, 入力, エラー文に含まれる語]（語が null なら module として読めない入力。止まることだけを見る）
const REJECTIONS = [
  ['class 宣言', 'class A{}', 'class'],
  ['class 式', 'const A=class{}', 'class'],
  ['var', 'function f(){var a=1;return a}', 'var'],
  ['ラベル', 'a:for(;;){break a}', 'ラベル'],
  ['with（module では構文エラー）', 'function f(o){with(o){return p}}', null],
  ['eval', 'function f(){const v=1;return eval("v")}', 'eval'],
  ['arguments', 'function f(){return arguments}', 'arguments'],
  ['ブロック内の関数宣言', 'function f(){if(1){function g(){}}}', 'ブロック内の関数宣言'],
  ['switch 内の関数宣言', 'switch(1){case 1:function g(){}}', 'switch 内の関数宣言'],
  ['catch 本体の関数宣言', 'try{}catch(e){function g(){}}', 'ブロック内の関数宣言'],
  ['import', 'import x from "y"', 'import'],
  ['export default', 'export default 1', 'export default'],
  ['meta 以外の export', 'export const other=1', 'meta 以外の export'],
  ['export function', 'export function f(){}', 'meta 以外の export'],
]

test('対応外の構文は例外で止まる', async () => {
  const results = await mangleBatch(REJECTIONS.map(([, input]) => H + input))
  REJECTIONS.forEach(([name, , word], i) => {
    assert.equal(results[i].ok, false, `${name} が止まらなかった`)
    if (word !== null) assert.ok(results[i].error.includes(word), `${name}: ${results[i].error}`)
  })
})

test('CLI: 対応外の構文では非ゼロ終了し stdout は空、正常な入力では JSON { code, stats }', async () => {
  const bad = await runMangleCli(H + 'class A{}')
  assert.notEqual(bad.status, 0)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /class/)
  const good = await runMangleCli(H + 'function f(value){return value}')
  assert.equal(good.status, 0, good.stderr)
  const out = JSON.parse(good.stdout)
  assert.equal(out.code, H + 'function f(a){return a}')
  assert.deepEqual(Object.keys(out.stats).sort(), ['bindings', 'edits', 'free', 'renamed'])
})

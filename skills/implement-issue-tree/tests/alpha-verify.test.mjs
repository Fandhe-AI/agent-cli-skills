// scripts/alpha-verify.cjs（識別子の改名の前後が α 同値であることを確かめる検証器）の回帰テスト。
//
// 検証は次の系統:
//   (a) 合成ケース — 捕捉・自由変数・巻き上げ・ブロック・catch・キー・shorthand・既定値・TDZ・名前つき関数式・
//       注入名・行数・リテラル・最上位 / 局所の meta・関数値の文字列化（手順 6）・対応外の構文・パース不能。
//       全ケースを 1 回の子プロセスで流し、結果を名前で引いて表明する（テスト時間を抑える）
//   (b) CLI の異常系 — 入力の形が違えば非ゼロ終了し、stdout に何も書かない（呼び出し側が一致と誤読しない）
//   (c) 実物 — src から作った stage1 の恒等が一致し（手順 6 が実物で 0 件であることを含む）、
//       実物の規模でも手順 6 が当たること。生成物は次の段で改名済みになるので、コミット済みの生成物は読まない
// acorn は `node --expose-internals` の子プロセスでしか読めないため、検証器は CLI として起動する。
// 件数・バイト数などの実測値は固定しない（main が進むと変わる）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnAsync } from './lib/run-async.mjs'
import { buildArtifact, embedScriptHashes, SRC_PATH } from '../scripts/build-workflow.mjs'

const VERIFIER = fileURLToPath(new URL('../scripts/alpha-verify.cjs', import.meta.url))
const KINDS = new Set(['match', 'mismatch', 'source-unparsable', 'artifact-unparsable'])

const runVerifier = (input) => spawnAsync(process.execPath, ['--expose-internals', VERIFIER], { input })

const verifyCases = async (cases) => {
  const r = await runVerifier(JSON.stringify(cases))
  assert.equal(r.status, 0, `検証器の子プロセスが失敗（status ${r.status}）: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(typeof out.acornVersion, 'string')
  assert.equal(out.results.length, cases.length)
  return new Map(out.results.map((x) => [x.name, x]))
}

// ---------------------------------------------------------------------------
// (a) 合成ケース

// 実物と同じく先頭に `export const meta` を置く（script ゴールで export を外す規則を通すため）
const H = 'export const meta={name:"x"}\n'

// [名前, 変換前, 変換後, ok, kind?, detail の正規表現?]。変換前・変換後には H を前置する
const CASES = [
  // 試作の 42 件（期待値は試作どおり）
  ['shadow-capture', 'const a=1;function f(){const b=2;return a+b}', 'const a=1;function f(){const a=2;return a+a}', false],
  ['ok-rename', 'const a=1;function f(){const b=2;return a+b}', 'const c=1;function f(){const d=2;return c+d}', true],
  ['free-capture', 'function f(){const x=1;return JSON.stringify(x)}', 'function f(){const JSON=1;return JSON.stringify(JSON)}', false],
  ['free-renamed', 'foo()', 'bar()', false],
  ['typeof-undeclared', 'function f(){const v=1;return typeof zz}', 'function f(){const zz=1;return typeof zz}', false],
  ['eval', 'function f(){const v=1;return eval("v")}', 'function f(){const a=1;return eval("v")}', false],
  ['with', 'function f(o){with(o){return p}}', 'function f(a){with(a){return p}}', false],
  ['hoist-inconsistent', 'function f(){return g();function g(){return 1}}', 'function f(){return h();function g(){return 1}}', false],
  ['hoist-ok', 'function f(){return g();function g(){return 1}}', 'function f(){return h();function h(){return 1}}', true],
  ['hoist-capture', 'const k=1;function f(){return k+g();function g(){}}', 'const k=1;function f(){return k+k();function k(){}}', false],
  ['block-ok', 'const a=1;{const b=2;use(b)}use(a)', 'const a=1;{const a=2;use(a)}use(a)', true],
  ['block-capture', 'const a=1;{const b=2;use(a)}', 'const a=1;{const a=2;use(a)}', false],
  ['catch-capture', 'const e=1;try{}catch(x){use(e)}', 'const e=1;try{}catch(e){use(e)}', false],
  ['catch-ok', 'const e=1;try{}catch(x){use(x,e)}', 'const e=1;try{}catch(y){use(y,e)}', true],
  ['class-field', 'class A{x=1;m(){return this.x}}', 'class B{x=1;m(){return this.x}}', false],
  ['prop-key', 'o.foo', 'o.a', false],
  ['obj-key', 'const o={foo:1}', 'const o={a:1}', false],
  ['shorthand-ok', 'const a=1;const o={a}', 'const b=1;const o={a:b}', true],
  ['shorthand-key-changed', 'const a=1;const o={a}', 'const b=1;const o={b}', false],
  ['pattern-shorthand-default-ok', 'const {a=1}=o;use(a)', 'const {a:b=1}=o;use(b)', true],
  ['param-default-vs-body', 'const y=1;function f(x=y){const z=2;return z}', 'const y=1;function f(x=y){const y=2;return y}', true],
  ['block-fn-annexB', 'function f(){if(1){function g(){}}return x}', 'function f(){if(1){function x(){}}return x}', false],
  ['dup-params', 'function f(a,b){return a+b}', 'function f(a,a){return a+a}', false],
  ['runtime-param-conflict', 'const q=1;use(q)', 'const agent=1;use(agent)', false],
  ['runtime-param-capture', 'function f(){const q=1;return agent(q)}', 'function f(){const agent=1;return agent(agent)}', false],
  ['line-count', 'const a=1\nuse(a)', 'const b=1;use(b)', false],
  ['literal', 'use("x")', 'use("y")', false],
  ['template-expr-ok', 'const a=1;use(`${a}`)', 'const b=1;use(`${b}`)', true],
  ['template-text', 'const a=1;use(`a${a}`)', 'const b=1;use(`b${b}`)', false],
  ['arguments', 'function f(){return arguments}', 'function g(){return arguments}', false],
  ['for-of-tdz', 'const x=[1];for(const y of x){use(y)}', 'const x=[1];for(const x of x){use(x)}', false],
  ['fnexpr-name-ok', 'const f=function g(){return g}', 'const f=function f(){return f}', true],
  ['fnexpr-name-capture', 'const h=1;const f=function g(){return h}', 'const h=1;const f=function h(){return h}', false],
  ['label', 'a:for(;;){break a}', 'b:for(;;){break b}', false],
  ['var', 'function f(){var a=1;return a}', 'function f(){var b=1;return b}', false],
  ['swap-bindings', 'const a=1,b=2;use(a,b)', 'const a=2,b=1;use(b,a)', false],
  ['meta-kept', '', '', true],
  ['swap-ok', 'const a=1,b=2;use(a,b)', 'const b=1,a=2;use(b,a)', true],
  ['swap-refs', 'const a=1,b=2;use(a,b)', 'const a=1,b=2;use(b,a)', false],
  ['injected-name-unreferenced-local', 'function f(){const q=1;return q}', 'function f(){const pipeline=1;return pipeline}', false],
  ['injected-name-toplevel', 'const q=1;use(q)', 'const budget=1;use(budget)', false],
  ['undefined-name', 'function f(){const q=1;return q}', 'function f(){const undefined=1;return undefined}', false],

  // meta: 最上位の宣言（とそれに解決される参照）だけ改名を拒否し、局所の同名は改名してよい
  ['meta-local-renamed', 'function f(){const meta=1;return meta}use(f)', 'function f(){const a=1;return a}use(f)', true, 'match'],
  ['meta-local-to-meta', 'function f(){const a=1;return a}use(f)', 'function f(){const meta=1;return meta}use(f)', false, 'mismatch', /特別な名前/],

  // 手順 6: 関数に解決される識別子の文字列化を拒否する。通る例は同名の関数でない局所変数（スコープ解決の証拠）
  ['fnstr-template', 'function f(){}use(`${f}`)', 'function f(){}use(`${f}`)', false, 'mismatch', /関数値の文字列化.*テンプレートの式.*offset \d+/],
  ['fnstr-template-local-ok', 'function f(){}function g(){const f=1;return `${f}`}use(g)', 'function f(){}function g(){const f=1;return `${f}`}use(g)', true, 'match'],
  ['fnstr-template-renamed-ok', 'function fn(){}function g(){const fn=1;return `${fn}`}use(g)', 'function a(){}function b(){const a=1;return `${a}`}use(b)', true, 'match'],
  ['fnstr-plus', 'const f=()=>1;use(f+"")', 'const f=()=>1;use(f+"")', false, 'mismatch', /関数値の文字列化.*\+ の被演算子.*offset \d+/],
  ['fnstr-plus-right', 'const f=()=>1;use(""+f)', 'const f=()=>1;use(""+f)', false, 'mismatch', /関数値の文字列化.*\+ の被演算子/],
  ['fnstr-plus-assign', 'const f=()=>1;let s="";s+=f;use(s)', 'const f=()=>1;let s="";s+=f;use(s)', false, 'mismatch', /関数値の文字列化.*\+= の右辺/],
  ['fnstr-plus-local-ok', 'const f=()=>1;function g(){const f=1;let s="";s+=f;return f+1}use(f,g)', 'const f=()=>1;function g(){const f=1;let s="";s+=f;return f+1}use(f,g)', true, 'match'],
  ['fnstr-String', 'const g=function f(){return String(f)};use(g)', 'const g=function f(){return String(f)};use(g)', false, 'mismatch', /関数値の文字列化.*String\(\) の引数.*offset \d+/],
  ['fnstr-String-local-ok', 'function f(){}function g(f){return String(f)}use(g)', 'function f(){}function g(f){return String(f)}use(g)', true, 'match'],
  ['fnstr-String-bound-ok', 'function f(){}function g(String){return String(f)}use(g)', 'function f(){}function g(String){return String(f)}use(g)', true, 'match'],
  ['fnstr-name', 'const f=function(){};use(f.name)', 'const f=function(){};use(f.name)', false, 'mismatch', /関数値の文字列化.*\.name のオブジェクト.*offset \d+/],
  ['fnstr-toString', 'function f(){}use(f.toString())', 'function f(){}use(f.toString())', false, 'mismatch', /関数値の文字列化.*\.toString のオブジェクト/],
  ['fnstr-length', 'const f=()=>1;use(f.length)', 'const f=()=>1;use(f.length)', false, 'mismatch', /関数値の文字列化.*\.length のオブジェクト/],
  ['fnstr-member-local-ok', 'function f(){}function g(){const f=[1];return f.length+f.name+f.toString()}use(g)', 'function f(){}function g(){const f=[1];return f.length+f.name+f.toString()}use(g)', true, 'match'],
  // 計算プロパティ（文字列キー・動的キー）と、const / 代入で別名へ移した関数値も拒否する
  ['fnstr-computed-string', 'function longName(){}use(longName["name"])', 'function IA(){}use(IA["name"])', false, 'mismatch', /関数値の文字列化.*計算プロパティのオブジェクト/],
  ['fnstr-computed-dynamic', 'function longName(){}use(longName[k])', 'function IA(){}use(IA[k])', false, 'mismatch', /関数値の文字列化.*計算プロパティのオブジェクト/],
  ['fnstr-alias-const', 'function f(){const longValue=()=>1;const alias=longValue;return alias.name}use(f)', 'function f(){const a=()=>1;const b=a;return b.name}use(f)', false, 'mismatch', /関数値の文字列化.*\.name のオブジェクト/],
  ['fnstr-alias-assign', 'function f(){const longValue=()=>1;let alias;alias=longValue;return `${alias}`}use(f)', 'function f(){const a=()=>1;let b;b=a;return `${b}`}use(f)', false, 'mismatch', /関数値の文字列化.*テンプレートの式/],
  ['fnstr-alias-array-ok', 'function f(){const xs=[1];const alias=xs;return alias.length}use(f)', 'function f(){const a=[1];const b=a;return b.length}use(f)', true, 'match'],
  // {__proto__} はデータプロパティ、{__proto__: x} はプロトタイプの設定。shorthand の展開を拒否する
  ['proto-shorthand-expanded', 'function f(){const __proto__={x:1};return {__proto__}}use(f)', 'function f(){const a={x:1};return {__proto__:a}}use(f)', false, 'mismatch', /__proto__ の shorthand/],
  ['proto-shorthand-kept-ok', 'function f(){const __proto__={x:1};return {__proto__}}use(f)', 'function f(){const __proto__={x:1};return {__proto__}}use(f)', true, 'match'],

  // 対応外の構文は改名が無くても（恒等でも）拒否する。with は module では構文エラーなので ok: false だけを表明する
  ['reject-var', 'function f(){var a=1;return a}use(f)', 'function f(){var a=1;return a}use(f)', false, 'mismatch', /対応外の構文 var/],
  ['reject-class-decl', 'class A{}use(A)', 'class A{}use(A)', false, 'mismatch', /対応外の構文 class/],
  ['reject-class-expr', 'const A=class{};use(A)', 'const A=class{};use(A)', false, 'mismatch', /対応外の構文 class/],
  ['reject-with', 'function f(o){with(o){return p}}use(f)', 'function f(o){with(o){return p}}use(f)', false],
  ['reject-label', 'a:for(;;){break a}', 'a:for(;;){break a}', false, 'mismatch', /対応外の構文 ラベル/],
  ['reject-eval', 'function f(){return eval("1")}use(f)', 'function f(){return eval("1")}use(f)', false, 'mismatch', /対応外の構文 eval/],
  ['reject-arguments', 'function f(){return arguments.length}use(f)', 'function f(){return arguments.length}use(f)', false, 'mismatch', /対応外の構文 arguments/],
  ['reject-block-fn', 'function f(){if(1){function g(){}g()}}use(f)', 'function f(){if(1){function g(){}g()}}use(f)', false, 'mismatch', /対応外の構文 ブロック内の関数宣言/],
  ['reject-switch-fn', 'function f(x){switch(x){case 1:function g(){}}}use(f)', 'function f(x){switch(x){case 1:function g(){}}}use(f)', false, 'mismatch', /対応外の構文 ブロック内の関数宣言/],
  // 拒否はメンバー名・キーの同名には及ばない（参照だけを見ている）
  ['member-named-arguments-ok', 'use(o.arguments,o.eval,{arguments:1})', 'use(o.arguments,o.eval,{arguments:1})', true, 'match'],

  // パース不能と、説明の生成が BigInt で落ちないこと
  ['source-unparsable', 'const =', 'const a=1', false, 'source-unparsable'],
  ['artifact-unparsable', 'const a=1,b=2;use(a,b)', 'const a=1,a=2;use(a,a)', false, 'artifact-unparsable'],
  ['bigint-literal', 'use(1n)', 'use(2n)', false, 'mismatch', /1 ≠ 2/],
]

// 最上位の meta の改名。script ゴールでは export が残ってパースできないので、module ゴールが先に mismatch を返す
const META_TOPLEVEL = { name: 'meta-toplevel-renamed', before: 'export const meta={name:"x"}\nreturn meta', after: 'export const m={name:"x"}\nreturn m' }

const SYNTH = verifyCases([...CASES.map(([name, b, a]) => ({ name, before: H + b, after: H + a })), META_TOPLEVEL])

test('合成ケースの名前は重複しない', () => {
  assert.equal(new Set(CASES.map((c) => c[0])).size, CASES.length)
})

for (const [name, , , ok, kind, detail] of CASES) {
  test(`合成: ${name} は ${ok ? '一致' : '不一致'}`, async () => {
    const r = (await SYNTH).get(name)
    assert.ok(r, `結果に ${name} が無い`)
    assert.equal(r.ok, ok, `${name}: ${r.kind} ${r.detail}`)
    assert.ok(KINDS.has(r.kind), `未知の kind: ${r.kind}`)
    assert.equal(r.kind === 'match', ok)
    if (kind) assert.equal(r.kind, kind, `${name}: ${r.detail}`)
    if (detail) assert.match(r.detail, detail)
  })
}

test('合成: 最上位の meta の改名は mismatch', async () => {
  const r = (await SYNTH).get(META_TOPLEVEL.name)
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'mismatch', r.detail)
  assert.match(r.detail, /最上位の meta が改名された/)
})

// ---------------------------------------------------------------------------
// (b) CLI の異常系: 非ゼロ終了かつ stdout が空

const BAD_INPUTS = [
  ['JSON として読めない', '{'],
  ['配列でない', JSON.stringify({ name: 'x', before: '', after: '' })],
  ['before が文字列でない（前の要素は正しい）', JSON.stringify([{ name: 'ok', before: H, after: H }, { name: 'x', before: 1, after: '' }])],
  ['要素が null', JSON.stringify([null])],
]

test('CLI: 入力の形が違えば非ゼロ終了し、stdout に何も書かない', async () => {
  const runs = await Promise.all(BAD_INPUTS.map(([, input]) => runVerifier(input)))
  runs.forEach((r, i) => {
    assert.notEqual(r.status, 0, `${BAD_INPUTS[i][0]}: 終了コードが 0`)
    assert.equal(r.stdout, '', `${BAD_INPUTS[i][0]}: stdout が空でない`)
  })
})

// ---------------------------------------------------------------------------
// (c) 実物

test('実物: stage1 の恒等は一致し（手順 6 は 0 件）、関数値の文字列化を足すと実物の規模でも拒否する', async () => {
  // ビルダーと同じ手順で stage1（コメント・空白を除いた生成物）を作る
  const stage1 = buildArtifact(embedScriptHashes(readFileSync(SRC_PATH, 'utf8'), dirname(SRC_PATH)))
  // 実物に無い名前の関数宣言と、その文字列化を最終行の末尾に足す（行数を変えない）。
  // before = after にして拒否の理由を手順 6 だけにする
  let fn = 'alphaVerifyProbe'
  while (stage1.includes(fn)) fn += '_'
  const lines = stage1.split('\n')
  lines[lines.length - 1] += `;function ${fn}(){}String(${fn})`
  const mutated = lines.join('\n')
  const res = await verifyCases([
    { name: 'identity', before: stage1, after: stage1 },
    { name: 'stringified', before: mutated, after: mutated },
  ])
  const id = res.get('identity')
  assert.equal(id.ok, true, id.detail)
  assert.equal(id.kind, 'match')
  const { module: m, script: s } = id.stats
  assert.ok(m.identifiers > 0 && m.bound > 0, `識別子を数えていない: ${id.detail}`)
  // script ゴールは包み関数の引数（注入名 8 個）の分だけ多い
  assert.equal(s.identifiers, m.identifiers + 8, id.detail)
  const st = res.get('stringified')
  assert.equal(st.kind, 'mismatch', st.detail)
  assert.match(st.detail, new RegExp(`関数値の文字列化 1 件。最初は ${fn} がString\\(\\) の引数`))
})

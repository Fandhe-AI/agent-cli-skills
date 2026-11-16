// scripts/alpha-verify.cjs（識別子の改名の前後が α 同値であることを確かめる検証器）の回帰テスト。
//
// 検証は次の系統:
//   (a) 合成ケース — 捕捉・自由変数・巻き上げ・ブロック・catch・キー・shorthand・既定値・TDZ・名前つき関数式・
//       注入名・行数・リテラル・最上位 / 局所の meta・関数値の文字列化（手順 6）・関数の名前・ソースを観測し得る
//       構文の一律の拒否と数値の受け手の例外・対応外の構文・パース不能。
//       全ケースを 1 回の子プロセスで流し、結果を名前で引いて表明する（テスト時間を抑える）
//   (b) CLI の異常系 — 入力の形が違えば非ゼロ終了し、stdout に何も書かない（呼び出し側が一致と誤読しない）
//   (c) 実物 — src から作った stage1 の恒等が一致し（手順 6 が実物で 0 件であることを含む）、
//       実物の規模でも手順 6 が当たること。生成物は次の段で改名済みになるので、コミット済みの生成物は読まない。
//       一律の拒否に当たる既知の 1 か所（h.toString(36)）は、件数と場所を確かめてから (h>>>0) に置き換えて見る
//       （PR 3 で src を書き換えたら置き換えを外す。tests/lib/mangle-harness.mjs の patchKnownObservation）
// acorn は `node --expose-internals` の子プロセスでしか読めないため、検証器は CLI として起動する。
// 件数・バイト数などの実測値は固定しない（main が進むと変わる）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnAsync } from './lib/run-async.mjs'
import { buildArtifact, embedScriptHashes, SRC_PATH } from '../scripts/build-workflow.mjs'
import { patchKnownObservation } from './lib/mangle-harness.mjs'

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

// 実物と同じく先頭に `export const meta` を置く（script ゴールで export を外す規則を通すため）。
// 合成ケースの値の受け口 use はプログラム内で束縛した関数にする（自由変数の呼び出し先へ関数値を渡すと、
// 引数の位置の許可リストで拒否されるため。use 自身は改名しない 3 文字の最上位の名前）
const H = 'export const meta={name:"x"}\nfunction use(){}'

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
  ['fnstr-template', 'function f(){}use(`${f}`)', 'function f(){}use(`${f}`)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が TemplateLiteral\.expressions（offset \d+）/],
  ['fnstr-template-local-ok', 'function f(){}function g(){const f=1;return `${f}`}use(g)', 'function f(){}function g(){const f=1;return `${f}`}use(g)', true, 'match'],
  ['fnstr-template-renamed-ok', 'function fn(){}function g(){const fn=1;return `${fn}`}use(g)', 'function a(){}function b(){const a=1;return `${a}`}use(b)', true, 'match'],
  ['fnstr-plus', 'const f=()=>1;use(f+"")', 'const f=()=>1;use(f+"")', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が BinaryExpression\.left（offset \d+）/],
  ['fnstr-plus-right', 'const f=()=>1;use(""+f)', 'const f=()=>1;use(""+f)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が BinaryExpression\.right/],
  ['fnstr-plus-assign', 'const f=()=>1;let s="";s+=f;use(s)', 'const f=()=>1;let s="";s+=f;use(s)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が AssignmentExpression\.right/],
  ['fnstr-plus-local-ok', 'const f=()=>1;function g(){const f=1;let s="";s+=f;return f+1}use(f,g)', 'const f=()=>1;function g(){const f=1;let s="";s+=f;return f+1}use(f,g)', true, 'match'],
  ['fnstr-String', 'const g=function f(){return String(f)};use(g)', 'const g=function f(){return String(f)};use(g)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が CallExpression\.arguments（許可されない呼び出し先）（offset \d+）/],
  ['fnstr-String-local-ok', 'function f(){}function g(f){return String(f)}use(g)', 'function f(){}function g(f){return String(f)}use(g)', true, 'match'],
  ['fnstr-String-bound-ok', 'function f(){}function g(String){return String(f)}use(g)', 'function f(){}function g(String){return String(f)}use(g)', true, 'match'],
  ['fnstr-name', 'const f=function(){};use(f.name)', 'const f=function(){};use(f.name)', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は メンバーの name（offset \d+）/],
  ['fnstr-toString', 'function f(){}use(f.toString())', 'function f(){}use(f.toString())', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は メンバーの toString/],
  // .length（引数の数）は改名で変わらないので、関数の束縛のメンバーとして許可する（.call・.apply・.bind も同じ）
  ['fnstr-length-ok', 'const f=()=>1;use(f.length)', 'const f=()=>1;use(f.length)', true, 'match'],
  // .length は関数値の追跡だけで見る（関数でない同名の局所は通る）。.name・.toString は受け手を問わない一律の拒否に当たる
  ['fnstr-member-local-ok', 'function f(){}function g(){const f=[1];return f.length}use(g)', 'function f(){}function g(){const f=[1];return f.length}use(g)', true, 'match'],
  ['fnstr-member-local-name', 'function f(){}function g(){const f=[1];return f.name}use(g)', 'function f(){}function g(){const f=[1];return f.name}use(g)', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの name/],
  // 計算プロパティ（文字列キー・動的キー）と、const / 代入で別名へ移した関数値も拒否する
  ['fnstr-computed-string', 'function longName(){}use(longName["name"])', 'function IA(){}use(IA["name"])', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は 計算メンバーの name/],
  ['fnstr-computed-dynamic', 'function longName(){}use(longName[k])', 'function IA(){}use(IA[k])', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が MemberExpression\.object/],
  ['fnstr-alias-const', 'function f(){const longValue=()=>1;const alias=longValue;return alias.name}use(f)', 'function f(){const a=()=>1;const b=a;return b.name}use(f)', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は メンバーの name/],
  ['fnstr-alias-assign', 'function f(){const longValue=()=>1;let alias;alias=longValue;return `${alias}`}use(f)', 'function f(){const a=()=>1;let b;b=a;return `${b}`}use(f)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が TemplateLiteral\.expressions/],
  ['fnstr-assigned-later', 'function f(){let longName;longName=()=>1;return longName.name}use(f)', 'function f(){let a;a=()=>1;return a.name}use(f)', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は メンバーの name/],
  ['fnstr-destructure-const', 'function f(){const longName=()=>1;const {name}=longName;return name}use(f)', 'function f(){const a=()=>1;const {name}=a;return name}use(f)', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は 分割代入・引数パターンのキー name/],
  ['fnstr-destructure-assign', 'function f(){const longName=()=>1;let name;({name}=longName);return name}use(f)', 'function f(){const a=()=>1;let name;({name}=a);return name}use(f)', false, 'mismatch', /関数の名前・ソースを観測し得る構文 1 件。最初は 分割代入・引数パターンのキー name/],
  ['fnstr-destructure-object', 'function f(){const o={name:1};const {name}=o;return name}use(f)', 'function f(){const a={name:1};const {name}=a;return name}use(f)', false, 'mismatch', /観測し得る構文 1 件。最初は 分割代入・引数パターンのキー name/],
  ['fnstr-alias-array-ok', 'function f(){const xs=[1];const alias=xs;return alias.length}use(f)', 'function f(){const a=[1];const b=a;return b.length}use(f)', true, 'match'],
  // 既定値が関数の束縛（引数・分割代入）も関数値として追う
  ['fnstr-param-default', 'function f(longValue=()=>1){return String(longValue)}use(f)', 'function f(a=()=>1){return String(a)}use(f)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['fnstr-destructure-default', 'function f(){const {longValue=()=>1}={};return `${longValue}`}use(f)', 'function f(){const {longValue:a=()=>1}={};return `${a}`}use(f)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が TemplateLiteral\.expressions/],

  // 関数の名前・ソースを返し得るプロパティ（name・toString・toSource）を読む構文は、受け手を問わず一律に拒否する。
  // レビューで挙がった例（改名器の実際の出力との組）。どれも改名で戻り値が変わる
  ['observe-param-default-name', 'function f(longValue=()=>1){return longValue.name}use(f)', 'function f(a=()=>1){return a.name}use(f)', false, 'mismatch'],
  ['observe-destructure-default-name', 'function f(){const {longValue=()=>1}={};return longValue.name}use(f)', 'function f(){const {longValue:a=()=>1}={};return a.name}use(f)', false, 'mismatch'],
  ['observe-fnexpr-toString', 'function f(){return (function(){const longName=1;return longName}).toString()}use(f)', 'function f(){return (function(){const a=1;return a}).toString()}use(f)', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの toString/],
  ['observe-fnexpr-name', 'use((function longName(){}).name)', 'use((function a(){}).name)', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの name/],
  ['observe-fnexpr-name-self', 'use((function longName(){return longName}).name)', 'use((function a(){return a}).name)', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの name/],
  ['observe-via-argument', 'function readName(value){return value.name}function longName(){}use(readName(longName))', 'function Ly(a){return a.name}function Gu(){}use(Ly(Gu))', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの name/],
  // 書き方の網羅（恒等で拒否されること = 改名の有無によらない）
  ['observe-member-toSource', 'use(o.toSource())', 'use(o.toSource())', false, 'mismatch', /メンバーの toSource/],
  ['observe-computed-string', 'use(o["name"])', 'use(o["name"])', false, 'mismatch', /計算メンバーの name/],
  ['observe-computed-template', 'use(o[`toString`]())', 'use(o[`toString`]())', false, 'mismatch', /計算メンバーの toString/],
  ['observe-optional', 'use(o?.name)', 'use(o?.name)', false, 'mismatch', /メンバーの name/],
  ['observe-optional-computed', 'use(o?.["toSource"])', 'use(o?.["toSource"])', false, 'mismatch', /計算メンバーの toSource/],
  ['observe-pattern-param', 'function f({name}){return name}use(f)', 'function f({name}){return name}use(f)', false, 'mismatch', /分割代入・引数パターンのキー name/],
  ['observe-pattern-string-key', 'const {"toString":t}=o;use(t)', 'const {"toString":t}=o;use(t)', false, 'mismatch', /分割代入・引数パターンのキー toString/],
  ['observe-pattern-computed-key', 'const {["name"]:n}=o;use(n)', 'const {["name"]:n}=o;use(n)', false, 'mismatch', /分割代入・引数パターンのキー name/],
  ['observe-pattern-assign', 'let n;({name:n}=o);use(n)', 'let n;({name:n}=o);use(n)', false, 'mismatch', /分割代入・引数パターンのキー name/],
  ['observe-pattern-nested', 'const [{toSource:s}]=xs;use(s)', 'const [{toSource:s}]=xs;use(s)', false, 'mismatch', /分割代入・引数パターンのキー toSource/],
  ['observe-reflect-get', 'use(Reflect.get(o,"name"))', 'use(Reflect.get(o,"name"))', false, 'mismatch', /呼び出しの引数のキー name/],
  ['observe-descriptor', 'use(Object.getOwnPropertyDescriptor(o,`toString`))', 'use(Object.getOwnPropertyDescriptor(o,`toString`))', false, 'mismatch', /呼び出しの引数のキー toString/],
  ['observe-paren-plus', 'use((a+b).toString())', 'use((a+b).toString())', false, 'mismatch', /メンバーの toString/],
  ['observe-sequence', 'use((0,o).name)', 'use((0,o).name)', false, 'mismatch', /メンバーの name/],
  ['observe-identifier-radix', 'const pad=(h)=>h.toString(36);use(pad)', 'const a=(b)=>b.toString(36);use(a)', false, 'mismatch', /メンバーの toString/],
  // 関数式・アローそのものの文字列化
  ['observe-String-fnexpr', 'use(String(function longName(){}))', 'use(String(function a(){}))', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['observe-template-arrow', 'use(`${(longName)=>longName}`)', 'use(`${(a)=>a}`)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数式が TemplateLiteral\.expressions/],
  ['observe-plus-fnexpr', 'use(""+function(){const longName=1})', 'use(""+function(){const a=1})', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数式が BinaryExpression\.right/],
  ['observe-plus-assign-arrow', 'let s="";s+=()=>1;use(s)', 'let s="";s+=()=>1;use(s)', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数式が AssignmentExpression\.right/],
  ['observe-concat-fnexpr', 'use("".concat(function(){}))', 'use("".concat(function(){}))', false, 'mismatch', /関数値を許可されない位置で使う 1 件。最初は 関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  // 関数値の位置の許可リスト（直接の関数式・追跡済みの関数束縛）。許可リストに無い位置はすべて拒否する。
  // レビューで挙がった 2 例（計算キーの ToPropertyKey・追跡済みの束縛の concat）と、文字列化し得る位置の代表
  ['pos-fn-computed-key', 'function f(){return {[function longName(){}]:1}}use(f)', 'function f(){return {[function a(){}]:1}}use(f)', false, 'mismatch', /関数式が Property\.key（offset \d+）/],
  ['pos-bound-concat', 'function f(){const longValue=()=>1;return "".concat(longValue)}use(f)', 'function f(){const a=()=>1;return "".concat(a)}use(f)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-computed-key', 'function f(){const longValue=()=>1;return {[longValue]:1}}use(f)', 'function f(){const a=()=>1;return {[a]:1}}use(f)', false, 'mismatch', /関数の束縛が Property\.key/],
  ['pos-fn-member-key', 'use(o[function longName(){}])', 'use(o[function a(){}])', false, 'mismatch', /関数式が MemberExpression\.property/],
  ['pos-bound-member-key', 'const longName=()=>1;use(o[longName])', 'const a=()=>1;use(o[a])', false, 'mismatch', /関数の束縛が MemberExpression\.property/],
  ['pos-fn-in', 'use((function longName(){}) in o)', 'use((function a(){}) in o)', false, 'mismatch', /関数式が BinaryExpression\.left/],
  ['pos-bound-in', 'const longName=()=>1;use(longName in o)', 'const a=()=>1;use(a in o)', false, 'mismatch', /関数の束縛が BinaryExpression\.left/],
  ['pos-fn-Symbol', 'use(Symbol(function longName(){}))', 'use(Symbol(function a(){}))', false, 'mismatch', /関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-Symbol', 'const longName=()=>1;use(Symbol(longName))', 'const a=()=>1;use(Symbol(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-fn-tagged', 'use(tag`${function longName(){}}`)', 'use(tag`${function a(){}}`)', false, 'mismatch', /関数式が TemplateLiteral\.expressions/],
  ['pos-bound-tagged', 'const longName=()=>1;use(tag`${longName}`)', 'const a=()=>1;use(tag`${a}`)', false, 'mismatch', /関数の束縛が TemplateLiteral\.expressions/],
  ['pos-fn-compare', 'use((function longName(){})=="")', 'use((function a(){})=="")', false, 'mismatch', /関数式が BinaryExpression\.left/],
  ['pos-bound-compare', 'const longName=()=>1;use(longName=="")', 'const a=()=>1;use(a=="")', false, 'mismatch', /関数の束縛が BinaryExpression\.left/],
  ['pos-fn-join', 'use([function longName(){}].join())', 'use([function a(){}].join())', false, 'mismatch', /関数式が MemberExpression\.object（配列・オブジェクトの要素）（offset/],
  ['pos-bound-join', 'const longName=()=>1;use([longName].join())', 'const a=()=>1;use([a].join())', false, 'mismatch', /関数の束縛が MemberExpression\.object（配列・オブジェクトの要素）/],
  ['pos-fn-new-String', 'use(new String(()=>1))', 'use(new String(()=>1))', false, 'mismatch', /関数式が NewExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-replace-pattern', 'const longName=()=>1;use("x".replace(longName,"y"))', 'const a=()=>1;use("x".replace(a,"y"))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-conditional-template', 'const longName=()=>1;use(`${c?longName:0}`)', 'const a=()=>1;use(`${c?a:0}`)', false, 'mismatch', /関数の束縛が TemplateLiteral\.expressions/],
  ['pos-bound-toLocaleString', 'const longName=()=>1;use(longName.toLocaleString())', 'const a=()=>1;use(a.toLocaleString())', false, 'mismatch', /関数の束縛が MemberExpression\.object/],
  ['pos-bound-typeof', 'const longName=()=>1;use(typeof longName)', 'const a=()=>1;use(typeof a)', false, 'mismatch', /関数の束縛が UnaryExpression\.argument/],
  // 呼び出しの引数も許可リスト。呼び出し先が (a) 束縛された識別子 (b) 名前空間でない object の既知のコールバックメソッド
  // (c) setTimeout 等・new Promise のどれでもなければ拒否する（自由変数の別名・名前空間経由・反射を含む）
  ['pos-bound-globalThis-String', 'function longName(){}use(globalThis.String(longName))', 'function Gu(){}use(globalThis.String(Gu))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-fn-globalThis-String', 'use(globalThis.String(function longName(){}))', 'use(globalThis.String(function a(){}))', false, 'mismatch', /関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-reflect-apply', 'const longName=()=>1;use(Reflect.apply(String,null,[longName]))', 'const a=()=>1;use(Reflect.apply(String,null,[a]))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-fn-reflect-apply', 'use(Reflect.apply(String,null,[()=>1]))', 'use(Reflect.apply(String,null,[()=>1]))', false, 'mismatch', /関数式が CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-bound-map-String', 'const longName=()=>1;use([longName].map(String))', 'const a=()=>1;use([a].map(String))', false, 'mismatch', /関数の束縛が MemberExpression\.object（配列・オブジェクトの要素）（許可されない反復）/],
  ['pos-fn-map-String', 'use([()=>1].map(String))', 'use([()=>1].map(String))', false, 'mismatch', /関数式が MemberExpression\.object（配列・オブジェクトの要素）（許可されない反復）/],
  ['pos-bound-sort-default', 'const longName=()=>1;use([longName,()=>2].sort())', 'const a=()=>1;use([a,()=>2].sort())', false, 'mismatch', /（許可されない反復）/],
  // Function.prototype.toString.call(f) は .toString を読むので一律の拒否が先に当たる。別名を経た形は位置の判定で止まる
  ['pos-bound-fn-proto-toString', 'const longName=()=>1;use(Function.prototype.toString.call(longName))', 'const a=()=>1;use(Function.prototype.toString.call(a))', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの toString/],
  ['pos-fn-fn-proto-toString', 'use(Function.prototype.toString.call(()=>1))', 'use(Function.prototype.toString.call(()=>1))', false, 'mismatch', /観測し得る構文 1 件。最初は メンバーの toString/],
  ['pos-bound-proto-alias-call', 'const ts=Function.prototype.toLocaleString;const longName=()=>1;use(ts.call(longName))', 'const ts=Function.prototype.toLocaleString;const a=()=>1;use(ts.call(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-fn-proto-alias-call', 'const ts=Function.prototype.toLocaleString;use(ts.call(()=>1))', 'const ts=Function.prototype.toLocaleString;use(ts.call(()=>1))', false, 'mismatch', /関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-console-log', 'const longName=()=>1;console.log(longName)', 'const a=()=>1;console.log(a)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-fn-console-log', 'console.log(()=>1)', 'console.log(()=>1)', false, 'mismatch', /関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-String-alias', 'const S=String;const longName=()=>1;use(S(longName))', 'const S=String;const a=()=>1;use(S(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-fn-String-alias', 'const S=String;use(S(()=>1))', 'const S=String;use(S(()=>1))', false, 'mismatch', /関数式が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-member-alias', 'const lg=console.log;const longName=()=>1;lg(longName)', 'const lg=console.log;const a=()=>1;lg(a)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-bound-destructured-global', 'const {log:lg}=console;const longName=()=>1;lg(longName)', 'const {log:lg}=console;const a=()=>1;lg(a)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  // 自由変数の別名は束縛を作るすべての形で判定する（既定値・分割代入・配列の分割代入・入れ子・for-of）
  ['pos-derived-default-param', 'function f(S=String){const longName=()=>1;return S(longName)}use(f)', 'function f(S=String){const a=()=>1;return S(a)}use(f)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-derived-destructure-globalThis', 'const {String:S}=globalThis;const longName=()=>1;use(S(longName))', 'const {String:S}=globalThis;const a=()=>1;use(S(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-derived-array-assign', 'let S;[S]=[String];const longName=()=>1;use(S(longName))', 'let S;[S]=[String];const a=()=>1;use(S(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-derived-object-assign-default', 'let S;({S}={S:String});const longName=()=>1;use(S(longName))', 'let S;({S}={S:String});const a=()=>1;use(S(a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-derived-nested-default', 'const {a:[S=String]=[]}={};const longName=()=>1;use(S(longName))', 'const {a:[S=String]=[]}={};const b=()=>1;use(S(b))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-derived-for-of', 'for(const S of [String]){const longName=()=>1;use(S(longName))}', 'for(const S of [String]){const a=()=>1;use(S(a))}', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  // 名前空間の別名（狭い派生）: const R = Reflect は名前空間。呼び出しの結果から作った配列は名前空間にしない
  ['pos-ns-alias-reflect-get', 'const R=Reflect;const longName=()=>1;use(R.get(o,longName))', 'const R=Reflect;const a=()=>1;use(R.get(o,a))', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  ['pos-ns-call-result-map-ok', 'const xs=Object.keys(o);const longName=(x)=>x;use(xs.map(longName))', 'const xs=Object.keys(o);const a=(b)=>b;use(xs.map(a))', true, 'match'],
  ['pos-bound-alias-of-alias', 'const S=String;const T=S;const longName=()=>1;use(T(longName))', 'const S=String;const T=S;const a=()=>1;use(T(a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-String-call', 'const longName=()=>1;use(String.call(null,longName))', 'const a=()=>1;use(String.call(null,a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-free-String', 'const longName=()=>1;use(String(longName))', 'const a=()=>1;use(String(a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-computed-callee', 'const longName=()=>1;use(o["map"](longName))', 'const a=()=>1;use(o["map"](a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-call-result-callee', 'const longName=()=>1;use(g()(longName))', 'const a=()=>1;use(g()(a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-namespace-chain', 'const longName=()=>1;use(process.argv.map(longName))', 'const a=()=>1;use(process.argv.map(a))', false, 'mismatch', /（許可されない呼び出し先）/],
  ['pos-bound-free-callee', 'const longName=()=>1;foo(longName)', 'const a=()=>1;foo(a)', false, 'mismatch', /関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/],
  // 関数値を入れた配列・入れ子のコンテナを引数に渡すのは、呼び出し先によらず拒否する。例外は、関数値を非計算キーの値として
  // 直に入れたオブジェクトリテラルを局所束縛の呼び出し先へ渡す形だけ
  ['pos-container-replace', 'use("x".replace(/x/,[function longName(){}]))', 'use("x".replace(/x/,[function a(){}]))', false, 'mismatch', /関数式が CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-array-from', 'use(Array.from([function longName(){}],String))', 'use(Array.from([function a(){}],String))', false, 'mismatch', /関数式が CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-local-array', 'function f(x){return x}const longName=()=>1;use(f([longName]))', 'function f(a){return a}const b=()=>1;use(f([b]))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-method-array', 'const longName=()=>1;use(o.map(x,[longName]))', 'const a=()=>1;use(o.map(x,[a]))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-promise-all', 'const longName=()=>1;use(Promise.all([longName]))', 'const a=()=>1;use(Promise.all([a]))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-set-timeout', 'const longName=()=>1;setTimeout([longName])', 'const a=()=>1;setTimeout([a])', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-object-of-array', 'function f(x){return x}const longName=()=>1;use(f({k:[longName]}))', 'function f(a){return a}const b=()=>1;use(f({k:[b]}))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-computed-key', 'function f(x){return x}const longName=()=>1;use(f({[k]:longName}))', 'function f(a){return a}const b=()=>1;use(f({[k]:b}))', false, 'mismatch', /関数の束縛が Property\.value/],
  ['pos-container-object-to-method', 'const longName=()=>1;use(o.m({k:longName}))', 'const a=()=>1;use(o.m({k:a}))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-nested-object', 'function f(x){return x}const longName=()=>1;use(f({a:{k:longName}}))', 'function f(a){return a}const b=()=>1;use(f({a:{k:b}}))', false, 'mismatch', /CallExpression\.arguments（配列・オブジェクトの要素）（offset/],
  ['pos-container-object-to-local-ok', 'function f(x){return x}const longName=()=>1;use(f({k:longName}),f({k:()=>1,isValid:(r)=>r}))', 'function f(a){return a}const b=()=>1;use(f({k:b}),f({k:()=>1,isValid:(c)=>c}))', true, 'match'],
  // オブジェクトリテラルのメンバーは入れた関数値そのものになり得るので、length を含めてどのメンバーを読んでも拒否する。
  // 配列リテラルの length は要素数（数値）なので通す
  ['pos-object-length', 'const longName=()=>1;use(String(({length:longName}).length))', 'const a=()=>1;use(String(({length:a}).length))', false, 'mismatch', /関数の束縛が MemberExpression\.object（配列・オブジェクトの要素）/],
  ['pos-object-member-template', 'const longName=()=>1;use(`${({k:longName}).k}`)', 'const a=()=>1;use(`${({k:a}).k}`)', false, 'mismatch', /関数の束縛が MemberExpression\.object（配列・オブジェクトの要素）/],
  ['pos-fn-object-length', 'use(String(({length:()=>1}).length))', 'use(String(({length:()=>1}).length))', false, 'mismatch', /関数式が MemberExpression\.object（配列・オブジェクトの要素）/],
  ['pos-array-length-ok', 'const longName=()=>1;use([longName].length,[longName].length>0,[()=>1].length)', 'const a=()=>1;use([a].length,[a].length>0,[()=>1].length)', true, 'match'],
  // 許可される呼び出し先（束縛された関数・既知のコールバックメソッド・setTimeout 等・new Promise・Array.from）
  ['pos-args-allowed-ok', 'function pool(list,cb){return list.map(cb)}function run(xs){const longName=(x)=>x;const m=new Map();const st=new Set();xs.map(longName);xs.filter((x)=>x).forEach(longName);xs.reduce((a,b)=>a+b,0);Promise.resolve(1).then(longName).catch(()=>0).finally(()=>0);setTimeout(longName,1);setInterval(()=>0,1);queueMicrotask(()=>0);m.set("k",longName);st.add(longName);xs.push(longName);Array.from(xs,longName);"x".replace(/x/g,longName);[longName].map((g)=>g());[longName].forEach(pool);longName.call(null,longName);pool(xs,longName);return [new Promise((r)=>r(1)),pool(xs,(x)=>x)]}use(run)',
    'function pool(a,b){return a.map(b)}function run(a){const b=(c)=>c;const c=new Map();const d=new Set();a.map(b);a.filter((e)=>e).forEach(b);a.reduce((e,f)=>e+f,0);Promise.resolve(1).then(b).catch(()=>0).finally(()=>0);setTimeout(b,1);setInterval(()=>0,1);queueMicrotask(()=>0);c.set("k",b);d.add(b);a.push(b);Array.from(a,b);"x".replace(/x/g,b);[b].map((e)=>e());[b].forEach(pool);b.call(null,b);pool(a,b);return [new Promise((e)=>e(1)),pool(a,(e)=>e)]}use(run)', true, 'match'],
  ['pos-bound-replace-first-arg', 'const longName=()=>1;use("x".replace(longName,"y"))', 'const a=()=>1;use("x".replace(a,"y"))', false, 'mismatch', /（許可されない呼び出し先）/],

  // 許可される位置（呼ぶ・引数に渡す・代入・return・.call 等・既定値・配列リテラル経由の引数・置換関数）
  ['pos-allowed-ok', 'function f(longCb){return longCb()}const longName=()=>1;let other;other=longName;const o={m:longName,longName};use(f(longName),(()=>2)(),longName.call(null),longName.apply(null,[]),longName.bind(null),longName.length,o,other,[longName].map((g)=>g()),"x".replace(/x/g,()=>"y"),c?longName:null,c||longName);function g(h=()=>1){return h}use(g,function(){return longName})',
    'function f(a){return a()}const b=()=>1;let c0;c0=b;const o={m:b,longName:b};use(f(b),(()=>2)(),b.call(null),b.apply(null,[]),b.bind(null),b.length,o,c0,[b].map((g)=>g()),"x".replace(/x/g,()=>"y"),c?b:null,c||b);function g(h=()=>1){return h}use(g,function(){return b})', true, 'match'],
  ['pos-new-callee-ok', 'const longName=function(){};use(new longName())', 'const a=function(){};use(new a())', true, 'match'],

  // 例外は受け手が構文上必ず数値になる式だけ（数値リテラル・単項 + - ~・算術とビット演算の二項式）
  ['observe-numeric-literal-ok', 'use((255).toString(16),1.5.toString(),5n.toString(2))', 'use((255).toString(16),1.5.toString(),5n.toString(2))', true, 'match'],
  ['observe-numeric-unary-ok', 'const pad=(h)=>(+h).toString(36);const neg=(x)=>(-x).toString(2)+(~x).toString(2);use(pad,neg)', 'const a=(b)=>(+b).toString(36);const c=(d)=>(-d).toString(2)+(~d).toString(2);use(a,c)', true, 'match'],
  ['observe-numeric-binary-ok', 'const hex=(x)=>(x>>>0).toString(16)+(x*2).toString()+(x%7).toString()+(x|0).toString(8);use(hex)', 'const a=(b)=>(b>>>0).toString(16)+(b*2).toString()+(b%7).toString()+(b|0).toString(8);use(a)', true, 'match'],
  // name という束縛・オブジェクトリテラルのキー（定義であって読み取りではない）は対象外
  ['observe-binding-and-key-ok', 'const name=1;const o={name,toString:2,"toSource":3};use(o,name)', 'const a=1;const o={name:a,toString:2,"toSource":3};use(o,a)', true, 'match'],

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

test('合成: 一律の拒否・位置の拒否の説明は固定の語彙と offset だけで、入力の名前を含まない', async () => {
  const res = await SYNTH
  for (const [name, words] of [
    ['observe-via-argument', ['readName', 'longName', 'value', 'Ly', 'Gu']],
    ['observe-String-fnexpr', ['longName']],
    ['observe-pattern-string-key', ['"toString"', 't']],
    ['pos-fn-computed-key', ['longName']],
    ['pos-bound-in', ['longName', 'o']],
  ]) {
    const r = res.get(name)
    assert.match(r.detail, /^\[module\] 変換前: (関数の名前・ソースを観測し得る構文|関数値を許可されない位置で使う) \d+ 件。最初は [^（]+(（許可されない呼び出し先）|（許可されない反復）)?（offset \d+）$/, `${name}: ${r.detail}`)
    const reason = r.detail.replace(/^.*最初は /, '').replace(/（offset \d+）$/, '')
    for (const w of words) assert.ok(!new RegExp(`(^|[^A-Za-z])${w}([^A-Za-z]|$)`).test(reason), `${name}: 説明に入力の ${w} が入っている: ${r.detail}`)
  }
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
  // ビルダーと同じ手順で stage1（コメント・空白を除いた生成物）を作る。一律の拒否に当たる既知の 1 か所は、
  // 件数（ちょうど 1 件）・offset・前後の文字列を確かめてから置き換える。PR 3 で src の該当行を
  // (h>>>0).toString(36) に書き換えると件数が 0 になり patchKnownObservation が落ちるので、そのときこの置き換えを外す
  const stage1 = await patchKnownObservation(buildArtifact(embedScriptHashes(readFileSync(SRC_PATH, 'utf8'), dirname(SRC_PATH))))
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
  assert.match(st.detail, /関数値を許可されない位置で使う 1 件。最初は 関数の束縛が CallExpression\.arguments（許可されない呼び出し先）/)
})

// tests/lib/js-brace-scanner.mjs の単体テスト（Issue #336）。
// 字句分類の全経路（文字列 / テンプレートリテラル / 行コメント / ブロックコメント /
// 正規表現リテラル）を、期待 index を明示して固定する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findMatchingBraceEnd } from './lib/js-brace-scanner.mjs'

// ---------------------------------------------------------------------------
// 基本
// ---------------------------------------------------------------------------

test('基本: 単純ネスト', () => {
  const src = '{ { } }'
  assert.equal(findMatchingBraceEnd(src, 0), 6)
})

test('基本: 空ブロック', () => {
  const src = '{}'
  assert.equal(findMatchingBraceEnd(src, 0), 1)
})

test('基本: 対応先が最終文字', () => {
  const src = 'x = {}'
  assert.equal(findMatchingBraceEnd(src, 4), 5)
})

// ---------------------------------------------------------------------------
// 行コメント
// ---------------------------------------------------------------------------

test('行コメント: 片側 { のみを含むコメントは無視される', () => {
  const src = '{\n// 片側 {\n}'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('行コメント: 片側 } のみを含むコメントは無視される', () => {
  const src = '{\n// 片側 }\n}'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("行コメント: アポストロフィ // don't がコメント内にあっても文字列を開始しない", () => {
  const src = "{\n// don't crash on apostrophe }\n}"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// ブロックコメント
// ---------------------------------------------------------------------------

test('ブロックコメント: /* } */ は無視される', () => {
  const src = '{ /* } */ }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('ブロックコメント: 未閉じクォート " を含んでいても文字列扱いされない', () => {
  const src = '{ /* " 未閉じクォート */ }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('ブロックコメント: 複数行', () => {
  const src = '{ /* line1\nline2 } line3\n*/ }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 文字列
// ---------------------------------------------------------------------------

test("文字列: '}' はコード上の閉じ括弧として数えられない", () => {
  const src = "{ x = '}' }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('文字列: "{" はコード上の開き括弧として数えられない', () => {
  const src = '{ x = "{" }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("文字列: エスケープ '\\\\' の直後の } は本物として数えられる", () => {
  // 'a\\' は 1 文字のエスケープ済みバックスラッシュで終端する文字列。直後の } は本物の閉じ括弧。
  const src = "{ x = 'a\\\\' }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("文字列: '//' はコメント扱いされない", () => {
  const src = "{ x = '//' }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("文字列: '/*' はコメント扱いされない", () => {
  const src = "{ x = '/*' }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// テンプレートリテラル
// ---------------------------------------------------------------------------

test('テンプレート: リテラル部の裸の } は無視される', () => {
  const src = '{ x = `foo } bar` }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('テンプレート: リテラル部の裸の { は無視される', () => {
  const src = '{ x = `foo { bar` }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('テンプレート: ${ JSON.stringify({ a: 1 }) } のネスト', () => {
  const src = '{ x = `${JSON.stringify({ a: 1 })} と地の文` }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('テンプレート: 複数行', () => {
  const src = '{ x = `line1\nline2 } line3\nline4` }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("テンプレート内の ' と \" はクォートとして開始しない", () => {
  const src = "{ x = `it's a \"quote\" }` }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 正規表現リテラル
// ---------------------------------------------------------------------------

test('正規表現側: 代入直後 (=) の /\\}/ は正規表現として扱われる', () => {
  const src = '{ x = /\\}/ }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 関数呼び出し引数の (/\\{/,...) は正規表現として扱われる', () => {
  const src = "{ replace(/\\{/, 'x') }"
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test("正規表現側: return /}/.test(s) は正規表現として扱われる", () => {
  const src = '{ return /}/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 文字クラス /[/{]/ 内の / は終端と誤認されない', () => {
  const src = '{ x = /[/{]/ }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: a / b は正規表現と誤認されない', () => {
  // 除算だと誤認せず正規表現扱いすると `}` を読み飛ばしてしまい範囲が壊れる。
  const src = '{ x = a / b }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: foo() / 2 は正規表現と誤認されない（直前が ")"）', () => {
  const src = '{ x = foo() / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: x[0] / y は正規表現と誤認されない（直前が "]"）', () => {
  const src = '{ x = x[0] / y }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 制御文ヘッダーの閉じ ) の直後の /}/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  // 直前 1 文字だけを見る旧実装は、直前が ')' なら常に除算側と判定していたため、
  // if (...) の後という文位置（正規表現側）を呼び出し/グループ化の ')'（除算側）と
  // 誤分類し、正規表現内の } を対象ブロックの終端として誤って返し得た。
  const src = '{ if (ok) /}/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 制御文ではない呼び出しの ) 直後は除算のまま（対比ケース）', () => {
  const src = '{ if (ok) foo() / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 後置 x++ / y は正規表現と誤認されない（PR #351 codex 指摘）', () => {
  // REGEX_PRECEDING_PUNCTUATION に '+' が含まれるため、旧実装は後置 ++ の末尾文字 '+' を
  // 前置演算子の記号と区別できず正規表現側と誤判定し、未終端エラーになり得た。
  const src = '{ x++ / y }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 前置 ++x の直後に続く演算子位置は変わらない（対比ケース）', () => {
  const src = '{ typeof ++x }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: ブロックコメント直後の /re/ はコメント前の文脈で判定される（Cursor Bugbot 指摘）', () => {
  // 逆走査は空白のみスキップしコメントを読み飛ばさないため、旧実装は '*/' の直後の '/' を
  // 直前文字 '/' から誤って除算側と判定し得た（正規表現内の } を早期に終端と誤認）。
  const src = '{ return /* c */ /}/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: throw /}/.test(x) は正規表現として扱われる（PR #351 codex 指摘）', () => {
  // throw が REGEX_PRECEDING_KEYWORDS に無いと、throw 直後の /}/ を除算側と誤判定し、
  // 正規表現内の } を対象ブロックの終端として誤って返し得た。
  const src = '{ throw /}/.test(x) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// オブジェクトリテラル vs ブロック文（`}` 直後の / 判定）
// ---------------------------------------------------------------------------

test('除算側: オブジェクトリテラル {} の直後の / は正規表現と誤認されない（PR #351 codex 指摘）', () => {
  // 通常コード用 } を無条件 OPERATOR にすると、代入直後のオブジェクトリテラル {} の
  // 直後にある / を正規表現の開始と誤認し、後続の } を早期に終端と誤って返し得た。
  const src = '{ x = {} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 分割代入 const { a } = obj の直後は文位置として扱われる（対比ケース）', () => {
  const src = '{ const { a } = obj; y = a / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: if (c) {} の直後の /re/ は正規表現として扱われる（ブロック文は VALUE を残さない）', () => {
  const src = '{ if (c) {} /re/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: else {} の直後の /re/ は正規表現として扱われる', () => {
  const src = '{ if (c) {} else {} /re/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: アロー関数本体 () => {} の直後の /re/ は正規表現として扱われる', () => {
  const src = '{ const f = () => {}; /re/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: return { a: 1 } の直後の / は正規表現と誤認されない', () => {
  const src = '{ function f() { return { a: 1 } / 2 } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 関数式・アロー関数本体終端後の / の除算/正規表現判定
// （github-actions/codex-review 新規指摘。threadId PRRT_kwDORuXFg86Z7FGO）
// ---------------------------------------------------------------------------
// アロー関数式・関数式はそれ自体が式の値であり、本体ブロック `{}` は BLOCK 種別のまま
// （オブジェクトリテラルではない）だが、対応する `}` の直後は文位置（OPERATOR）ではなく
// 式の値（VALUE）である。旧実装は BLOCK 種別の `}` を無条件で OPERATOR 扱いしていたため、
// `function(){} / 2` の `/` を正規表現の開始と誤認し、正規表現走査が未終端エラーになり得た。

test('除算側: アロー関数式 () => {} の直後（セミコロンなし）の / は正規表現と誤認されない（github-actions 新規指摘）', () => {
  const src = '{ x = () => {} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 関数式 function(){} の直後（セミコロンなし）の / は正規表現と誤認されない（github-actions 新規指摘）', () => {
  const src = '{ x = function(){} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 名前付き関数式 function f(){} の直後の / は正規表現と誤認されない（対比ケース: 式位置なら名前があっても式）', () => {
  const src = '{ x = function f(){} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: async 関数式 async function(){} の直後の / は正規表現と誤認されない（async の statement-start 透過の回帰）', () => {
  const src = '{ x = async function(){} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: async アロー関数 async () => {} の直後の / は正規表現と誤認されない', () => {
  const src = '{ x = async () => {} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 文位置の関数宣言 function foo(){} の直後（セミコロンなし）の /re/ は正規表現として扱われる（対比ケース: 宣言は文位置のまま）', () => {
  const src = '{ function foo(){}\n/re/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: async 関数宣言 async function foo(){} の直後の /re/ は正規表現として扱われる（対比ケース）', () => {
  const src = '{ async function foo(){}\n/re/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 連続する関数宣言 function foo(){} function bar(){} は互いに文位置のまま（対比ケース）', () => {
  const src = '{ function foo(){} function bar(){} y = a / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: switch (x) { case 1: function f(){} } のような文位置の関数宣言も文位置のまま（対比ケース）', () => {
  const src = '{ switch (x) { case 1: function f(){}\n/re/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 制御構文キーワードとプロパティ名の区別（`.catch` 等）
// ---------------------------------------------------------------------------

test('除算側: p.catch(fn) は制御構文と誤分類されない（Cursor Bugbot 指摘）', () => {
  // `(` の直前語のみで制御構文判定すると、`obj.catch(...)` のようなプロパティ呼び出しを
  // catch ヘッダーと誤認し、対応する ) で VALUE ではなく OPERATOR のままになり、
  // 後続の / を正規表現と誤読して } を早期に終端と誤って返し得た。
  const src = '{ p.catch(fn) / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: obj.if(x) は制御構文と誤分類されない（PR #351 codex 指摘）', () => {
  const src = '{ obj.if(x) / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: 本物の catch (e) の直後は文位置のまま（対比ケース）', () => {
  const src = '{ try {} catch (e) { /re/.test(String(e)) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 空白を挟んだ p . catch(fn) もプロパティ呼び出しとして扱われる', () => {
  const src = '{ p . catch(fn) / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// for await / with（PR #351 codex-review 指摘: 制御構文ヘッダーの未網羅）
// ---------------------------------------------------------------------------

test('正規表現側: for await (const x of xs) の直後の /}/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  // 旧実装は CONTROL_KEYWORDS の直前語判定が 'await' になり、'for' が見えなくなるため
  // 対応する ) を呼び出し/グループ化の終端（VALUE）と誤判定していた。
  const src = '{ for await (const x of xs) /}/.test(x) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: with (obj) の直後の /}/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  // 旧実装は CONTROL_KEYWORDS に 'with' が未登録だった。
  const src = '{ with (obj) /}/.test(x) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: Array.prototype.with 呼び出しは制御構文と誤分類されない（.catch と同型の回帰）', () => {
  // 'with' を CONTROL_KEYWORDS へ追加しても、`.` 直後のプロパティ名としての 'with'
  // （`arr.with(0, 1)` 等、ES2023 Array.prototype.with）は afterDot 経路で除外される必要がある。
  const src = '{ arr.with(0, 1) / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 非 ASCII 識別子（PR #351 codex-review 指摘）
// ---------------------------------------------------------------------------

test('除算側: 非 ASCII 識別子 (const π = 1; π / 2) は演算子として誤扱いされない（PR #351 codex 指摘）', () => {
  // 旧実装は識別子判定が [A-Za-z0-9_$] のみで、Unicode 識別子が「その他の記号」分岐に
  // 入り prevSignificant が operator のままになるため、直後の / を正規表現の開始と
  // 誤認し未終端エラーになり得た。
  const src = '{ const π = 1; y = π / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// case / default / ラベル文の {（Cursor Bugbot 指摘）
// ---------------------------------------------------------------------------

test('switch (x) { の直後は文位置として扱われる（sWN の前提条件）', () => {
  const src = '{ switch (x) { case 1: break } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: case 1: { ... } はブロック文として扱われる（Cursor Bugbot 指摘）', () => {
  // 旧実装は ':' を素朴に OPERATOR 扱いするため、直後の { を（switch の case ヘッダーの
  // 直後という文位置にもかかわらず）オブジェクトリテラルと誤分類していた。
  // /}/ を使い、誤分類（block 文脈のはずが LITERAL → 直後の } の prevSignificant が
  // value になり /}/ を除算と誤読）を確実に検出できる形にする（/re/ のように }  を
  // 含まない正規表現では誤分類でも最終結果が一致してしまい検出できない）。
  const src = '{ switch (x) { case 1: { y() } /}/.test(z) break } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: default: { ... } はブロック文として扱われる（Cursor Bugbot 指摘）', () => {
  const src = '{ switch (x) { default: { y() } /}/.test(z) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: ラベル文 outer: { ... } はブロック文として扱われる（Cursor Bugbot 指摘）', () => {
  const src = '{ outer: { y() } /}/.test(z) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 三項演算子 c ? { a: 1 } : {} はオブジェクトリテラルのまま（フレーム跨ぎのコロン誤対応の回帰）', () => {
  // ternary の '?'/':' 対応を単一のグローバルカウンタで数えると、内側のオブジェクトリテラル
  // { a: 1 } の key: value の ':' がこのカウンタを誤って消費してしまい、外側の本物の三項
  // ':' が「消費済み（深さ0）」に見えて文位置のコロンと誤認され得る。誤認されると直後の
  // 空オブジェクト {} が（本来の LITERAL ではなく）BLOCK として push され、pop 後の
  // prevSignificant が value ではなく operator になり、続く `/ 2` の `/` を正規表現の
  // 開始と誤読して閉じる `/` が見つからず未終端エラーを投げる
  // （このソースは 1 行のため、誤読された正規表現走査は改行前に閉じ `/` を発見できない）。
  // ternary の深さをフレーム単位で保持していれば、内側の { a: 1 } は独立した深さ 0 の
  // フレームとして push/pop されるため外側の深さを消費せず、この誤読は起こらない。
  const src = '{ x = c ? { a: 1 } : {} / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: オプショナルチェイニング a?.b は三項演算子として誤カウントされない（コロンを伴う強い canary）', () => {
  // `?.` の直後にコロンを伴わせず division だけを見るケースは、'?' 自体を誤って
  // ternaryDepth++ してしまうバグがあっても両者とも a?.b は正しく処理されるため検出力が
  // 弱い（'?' の 1 文字先読みガードの実装次第では通ってしまう）。ラベル文のコロンを
  // 後続させ、フレームの ternaryDepth が汚染されていないことを直接検証する。
  const src = '{ x = a?.b; outer: {} /}/.test(z) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: nullish 合体 a ?? b はコロン対応を汚染しない（PR #351 codex 指摘の回帰）', () => {
  // `??` は 2 文字の `?` から成るため、1 文字先読み（`text[i+1] !== '?'`）だけで `?.`/`??`
  // を除外しても、走査が最初の '?' をスキップした次のループで 2 個目の '?' に到達すると
  // （今度は隣が空白等で `?.`/`??` 判定に該当しない）誤って ternaryDepth を増やし得る。
  // 増えた深さは後続のラベル文コロンを「三項演算子の対応済みコロン」として誤って消費し、
  // 本来 afterStatementColon になるべきラベルのコロンが消費されないまま通過し、
  // 直後の {} がオブジェクトリテラル（LITERAL）と誤分類され得る。
  const src = '{ x = a ?? b; outer: {} /}/.test(z) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: nullish 代入 a ??= b はコロン対応を汚染しない（PR #351 codex 指摘の回帰）', () => {
  const src = '{ x = a; x ??= b; outer: {} /}/.test(z) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// ASI で終端する文（break/continue/debugger）後の正規表現（PR #351 codex 指摘）
// ---------------------------------------------------------------------------

test('正規表現側: break の直後（改行のみで区切られる ASI）の /re/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  // break はオペランドを取らない文であり、旧実装は break を素朴な識別子として VALUE 扱い
  // していたため、直後の / を除算と誤認し得た（正規表現内の } を早期に終端と誤って返す）。
  const src = '{ while (1) { break\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: continue の直後の /re/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  const src = '{ while (1) { continue\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: debugger の直後の /re/ は正規表現として扱われる（PR #351 codex 指摘）', () => {
  const src = '{ debugger\n/}/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: break outer; のラベルは識別子として通常どおり読める（対比ケース）', () => {
  const src = '{ outer: while (1) { break outer; } y = a / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// ラベル付き break/continue の restricted production（Cursor Bugbot 新規指摘。
// HEAD sha cf55f2e。PR #351 コメント項目 12 参照）
// ---------------------------------------------------------------------------
// `break`/`continue` とラベルの間に LineTerminator が無い場合、ASI は発生せず
// `break outer` 全体が 1 文として完結する。ラベルを素朴な識別子として読み、
// prevSignificant を VALUE にしてしまうと、直後（同一行でもラベルの後にセミコロンが
// 無く直接続く場合）の `/` を除算と誤認し得る。

test('正規表現側: break outer（セミコロンなし、改行なしで /}/ が続く）は正規表現として扱われる（Cursor Bugbot 新規指摘）', () => {
  const src = '{ outer: while (1) { break outer\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('正規表現側: continue outer（セミコロンなし、改行なしで /}/ が続く）は正規表現として扱われる（Cursor Bugbot 新規指摘）', () => {
  const src = '{ outer: while (1) { continue outer\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: break\\nouter（break とラベルの間に改行）は ASI で別文になり通常の識別子として読める（対比ケース）', () => {
  // break と outer の間に LineTerminator があるため restricted production は適用されず、
  // ASI で 'break;' が完結し、'inner' は新しい文（ラベル文 inner: ...）の先頭になる
  // （外側の while と同じ 'outer' ラベルを再宣言すると SyntaxError になるため 'inner' を使う）。
  const src = '{ outer: while (1) { break\ninner: y = a / 2 } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// break/continue/debugger 直後の裸ブロック { } の誤分類（PR #351 Cursor Bugbot 指摘）
// ---------------------------------------------------------------------------
// break/continue/debugger は REGEX_PRECEDING_KEYWORDS に追加済みだが BLOCK_INTRO_KEYWORDS
// には未追加だと、ASI で文が終端した直後に続く裸 `{ ... }`（新しい文としてのブロック）が
// オブジェクトリテラルと誤分類される。誤分類された `{ ... }` の対応する `}` の直後の走査
// 状態が VALUE のままになり、続く正規表現リテラル（`}` を含み得る）を除算と誤認する。

test('ブロック側: break 直後（ASI）の裸 { } はオブジェクトリテラルではなくブロック文として扱われる（PR #351 Cursor Bugbot 指摘）', () => {
  const src = '{ while (1) { break\n{ y }\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('ブロック側: continue 直後（ASI）の裸 { } はオブジェクトリテラルではなくブロック文として扱われる（PR #351 Cursor Bugbot 指摘）', () => {
  const src = '{ while (1) { continue\n{ y }\n/}/.test(s) } }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('ブロック側: debugger 直後（ASI）の裸 { } はオブジェクトリテラルではなくブロック文として扱われる（PR #351 Cursor Bugbot 指摘）', () => {
  const src = '{ debugger\n{ y }\n/}/.test(s) }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// Unicode 識別子の結合文字・ZWNJ/ZWJ・非 BMP 文字（PR #351 codex-review 指摘）
// ---------------------------------------------------------------------------

test('除算側: 結合文字を含む識別子 (á = a + U+0301) は演算子として誤扱いされない（PR #351 codex 指摘）', () => {
  // 'á' を基底文字 'a' + 結合文字 U+0301（COMBINING ACUTE ACCENT）で表す（NFD 分解形）。
  // 結合文字が識別子の継続文字として認識されないと、変数名の途中で走査が切れ、
  // 直後の / を誤って正規表現の開始と判定し得る。
  const combining = '́'
  const src = `{ const a${combining} = 1; y = a${combining} / 2 }`
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: ZWNJ/ZWJ を含む識別子は演算子として誤扱いされない（PR #351 codex 指摘）', () => {
  const zwnj = '‌'
  const zwj = '‍'
  const src = `{ const a${zwnj}b${zwj}c = 1; y = a${zwnj}b${zwj}c / 2 }`
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 非 BMP 文字を含む識別子 (𝒜 = U+1D49C) は演算子として誤扱いされない（PR #351 codex 指摘）', () => {
  // U+1D49C（MATHEMATICAL SCRIPT CAPITAL A）はサロゲートペア（2 UTF-16 コード単位）。
  // コード単位単位の走査だと上位/下位サロゲートを個別にテストしてしまい、
  // いずれの Unicode プロパティにも一致せず識別子として認識できない。
  const astral = '\u{1D49C}'
  const src = `{ const ${astral} = 1; y = ${astral} / 2 }`
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

test('除算側: 非 BMP 文字を含む識別子直後に } が続いても正しく走査できる（サロゲート境界の回帰）', () => {
  const astral = '\u{1D49C}'
  const src = `{ const ${astral} = {}; y = ${astral} / 2 }`
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 数値リテラル先頭文字（識別子判定の Unicode 拡張との対称性）
// ---------------------------------------------------------------------------

test('除算側: 数値リテラル 10 / 2 は識別子拡張後も正しく除算として扱われる（PR #351 レビュー回帰）', () => {
  // 識別子の開始文字判定を Unicode 拡張する際、開始文字集合から ASCII 数字 [0-9] を
  // 落とすと、数値リテラルの先頭文字が識別子分岐にすら入らず「その他の記号」分岐に
  // 落ちて prevSignificant が operator のままになり、直後の / を正規表現の開始と
  // 誤認し得る（isNumberLike 判定は識別子分岐の内部にしか無いため、分岐に入らなければ
  // 意味を持たない）。開始文字集合と継続文字集合は対称（同じ文字集合 + Unicode 拡張）に
  // 保つ必要がある。
  const src = '{ const n = 10 / 2 }'
  assert.equal(findMatchingBraceEnd(src, 0), src.length - 1)
})

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

test('契約: 閉じない場合は -1 を返す', () => {
  const src = '{ x = 1'
  assert.equal(findMatchingBraceEnd(src, 0), -1)
})

test('契約: 未終端文字列は throw する', () => {
  const src = "{ x = 'unterminated\n }"
  assert.throws(() => findMatchingBraceEnd(src, 0), /未終端の文字列リテラル/)
})

test('契約: 未終端ブロックコメントは throw する', () => {
  const src = '{ /* unterminated'
  assert.throws(() => findMatchingBraceEnd(src, 0), /未終端のブロックコメント/)
})

test('契約: 未終端テンプレートリテラルは throw する', () => {
  const src = '{ x = `unterminated'
  assert.throws(() => findMatchingBraceEnd(src, 0), /未終端のテンプレートリテラル/)
})

test('契約: openBraceIndex が "{" でないとき TypeError を投げる', () => {
  const src = '{ x = 1 }'
  assert.throws(() => findMatchingBraceEnd(src, 1), TypeError)
})

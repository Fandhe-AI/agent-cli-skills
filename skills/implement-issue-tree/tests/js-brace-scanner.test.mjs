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

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

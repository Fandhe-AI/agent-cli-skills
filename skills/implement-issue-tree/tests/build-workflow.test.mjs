// scripts/build-workflow.mjs（開発ファイル → 実行ファイルのコメント除去ビルダー）の回帰テスト。
//
// 検証は 2 系統:
//   (a) lexer の固定ケース — 文字列・テンプレートリテラル・正規表現の内部にある `//` を
//       コメントと誤認して削らないこと（本スクリプトはプロンプト用の巨大テンプレートに
//       コード例を含み得るため、ここが壊れると生成物が静かに破損する）
//   (b) 鮮度ゲート — リポジトリの実行ファイル（implement-issue-tree.js）が開発ファイル
//       （implement-issue-tree.src.js）から再生成した内容と byte 一致すること。生成物の
//       直接編集・ビルド忘れの双方をここで fail させる（CI がこのスイートを実行する）。
//   (d) 空白除去 — トークン間の不要な半角スペースを詰める後段パス（squeezeSpaces）の許可リスト・
//       固定ケース・性質（行数保持・冪等・リテラル不変）と、Node 同梱 acorn による変換前後の
//       トークン列一致（実ファイル + 固定ケース）。
// 生成物のサイズ・パースゲートは workflow-loadability.test.mjs が担う（対象は実行ファイル）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripComments, squeezeSpaces, shouldSqueezeSpace, buildArtifact, SRC_PATH, DIST_PATH,
} from '../scripts/build-workflow.mjs'

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/build-workflow.mjs', import.meta.url))
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TOKEN_DIFF_HELPER = fileURLToPath(new URL('./lib/token-diff.cjs', import.meta.url))

// ---------------------------------------------------------------------------
// (a) lexer 固定ケース
// ---------------------------------------------------------------------------

test('行コメントのみの行は空行になる（改行保持・行番号維持）', () => {
  assert.equal(stripComments('const a = 1\n// comment\nconst b = 2\n'), 'const a = 1\n\nconst b = 2\n')
})

test('trailing コメントは直前の行内空白ごと除去される（trim_trailing_whitespace 準拠）', () => {
  assert.equal(stripComments('const a = 1  // comment\n'), 'const a = 1\n')
})

test('文字列リテラル内の // は保持される', () => {
  assert.equal(stripComments("const u = 'http://example.com' // c\n"), "const u = 'http://example.com'\n")
})

test('テンプレートリテラル内の行頭 // 行（プロンプト内コード例）は保持される', () => {
  const src = 'const p = `手順:\n// この行はコード例\ncode()\n`\n'
  assert.equal(stripComments(src), src)
})

test('テンプレート ${} 内の文字列に } を含んでもテンプレート境界を見失わない', () => {
  const src = "const t = `a${foo('}')}b` // c\n"
  assert.equal(stripComments(src), "const t = `a${foo('}')}b`\n")
})

test('ネストしたテンプレートリテラルを正しく追跡する', () => {
  const src = 'const t = `x${cond ? `in//ner${y}` : z}w`\n// comment\n'
  assert.equal(stripComments(src), 'const t = `x${cond ? `in//ner${y}` : z}w`\n\n')
})

test('${} 内のオブジェクトリテラル（{} ネスト）でテンプレートへ早期復帰しない', () => {
  const src = 'const t = `v=${JSON.stringify({ a: { b: 1 } })} // not comment`\n'
  assert.equal(stripComments(src), src)
})

test('正規表現リテラル内の // をコメントと誤認しない（キーワード直後の regex）', () => {
  const src = 'if (x) return /a[/][/]b/.test(s)\n'
  assert.equal(stripComments(src), src)
})

test('. 直後のキーワード同名プロパティ直後の除算に続く trailing コメントを除去する', () => {
  assert.equal(stripComments('const a = obj.in / 2 // c\n'), 'const a = obj.in / 2\n')
})

test('. 直後のキーワード同名プロパティ直後の除算行の後続文字列を書き換えない', () => {
  assert.equal(
    stripComments("const b = x.return / y + 'http://keep' // c\n"),
    "const b = x.return / y + 'http://keep'\n",
  )
})

test('末尾ドット数値直後のキーワード（1. in /re/）をプロパティ名と誤判定せず regex を保持する', () => {
  assert.equal(stripComments('const r = 1. in /x[/]y/ // c\n'), 'const r = 1. in /x[/]y/\n')
})

test('数値へのプロパティアクセス（1 .in）直後の除算行で後続文字列を書き換えず trailing コメントを除去する', () => {
  assert.equal(
    stripComments("const a = 1 .in / 2 + 'http://keep' // c\n"),
    "const a = 1 .in / 2 + 'http://keep'\n",
  )
})

// Issue #455（Bugbot 連鎖指摘 5 巡目）の回帰固定: dotAfterDigit が「. の直前 1 文字が数字か」
// という字句隣接のみで判定していたため、数字終わり識別子（foo1）・完了済み数値リテラル
// （1e10・0x10）へのプロパティアクセス直後の `.` を末尾ドット数値（`1.`）と誤同一視し、
// keywordProperty が false になって後続の `/` を regex 開始と誤読していた。
test('数字終わり識別子直後のプロパティアクセス（foo1.in）を末尾ドット数値と誤同一視しない', () => {
  assert.equal(
    stripComments("const a = foo1.in / 2 + 'http://keep' // c\n"),
    "const a = foo1.in / 2 + 'http://keep'\n",
  )
})

test('指数表記リテラル直後のプロパティアクセス（1e10.in）を末尾ドット数値と誤同一視しない', () => {
  assert.equal(
    stripComments("const a = 1e10.in / 2 + 'http://keep' // c\n"),
    "const a = 1e10.in / 2 + 'http://keep'\n",
  )
})

test('符号付き指数表記リテラル直後のプロパティアクセス（1e+10.in）を末尾ドット数値と誤同一視しない（Issue #455 Bugbot）', () => {
  assert.equal(
    stripComments("const a = 1e+10.in / 2 + 'http://keep' // c\n"),
    "const a = 1e+10.in / 2 + 'http://keep'\n",
  )
})

test('負符号付き指数表記リテラル直後のプロパティアクセス（1e-5.in）を末尾ドット数値と誤同一視しない（Issue #455 Bugbot）', () => {
  assert.equal(
    stripComments("const a = 1e-5.in / 2 + 'http://keep' // c\n"),
    "const a = 1e-5.in / 2 + 'http://keep'\n",
  )
})

test('末尾ドット仮数の符号付き指数表記リテラル直後のプロパティアクセス（1.e+10.in）を末尾ドット数値と誤同一視しない（Bugbot 指摘）', () => {
  assert.equal(
    stripComments("const a = 1.e+10.in / 2 + 'http://keep' // c\n"),
    "const a = 1.e+10.in / 2 + 'http://keep'\n",
  )
  assert.equal(
    stripComments("const a = 1.E-5.in / 2 + 'http://keep' // c\n"),
    "const a = 1.E-5.in / 2 + 'http://keep'\n",
  )
})

test('末尾ドット仮数の符号付き指数表記リテラル（1.e+10）を含む除算行の trailing コメント除去は従来通り機能する', () => {
  assert.equal(
    stripComments("const a = 1.e+10 / 2 // c\n"),
    "const a = 1.e+10 / 2\n",
  )
})

test('末尾ドット数値直後の識別子 e へ続く二項 + は指数部符号と扱わず、後続の regex を保持する', () => {
  // `1. e` は数値リテラルではない（空白を挟む）ため、`e` は識別子。`+` は二項演算子
  assert.equal(
    stripComments("const r = 1. e +10. in /x[/]y/ // c\n"),
    "const r = 1. e +10. in /x[/]y/\n",
  )
})

test('符号付き指数表記リテラル（1e+10）を含む式の除算判定・trailing コメント除去は従来通り機能する', () => {
  assert.equal(
    stripComments("const a = 1e+10 / 2 // c\n"),
    "const a = 1e+10 / 2\n",
  )
  assert.equal(
    stripComments("const b = 1e-5 / 2 // c\n"),
    "const b = 1e-5 / 2\n",
  )
})

test('16 進リテラル直後のプロパティアクセス（0x10.in）を末尾ドット数値と誤同一視しない', () => {
  assert.equal(
    stripComments("const a = 0x10.in / 2 + 'http://keep' // c\n"),
    "const a = 0x10.in / 2 + 'http://keep'\n",
  )
})

test('小数リテラル直後のプロパティアクセス（1.5.in）を末尾ドット数値と誤同一視しない', () => {
  assert.equal(
    stripComments("const a = 1.5.in / 2 + 'http://keep' // c\n"),
    "const a = 1.5.in / 2 + 'http://keep'\n",
  )
})

test('先頭ドット小数リテラル直後のプロパティアクセス（.5.in）を末尾ドット数値と誤同一視しない', () => {
  assert.equal(
    stripComments("const a = .5.in / 2 + 'http://keep' // c\n"),
    "const a = .5.in / 2 + 'http://keep'\n",
  )
})

// Issue #455 codex P1（PR #456 レビュー指摘）の回帰固定: 数字終わり識別子直後の `.` 判定
// （wordPrevRaw のチェック）が \p{L}\p{Nl}_$ のみを識別子継続文字として認識しており、
// 結合文字（Mn/Mc。分解形の á = 'a' + U+0301 等）・ZWNJ（U+200C）・ZWJ（U+200D）・
// 非 BMP 識別子文字（サロゲートペア）を継続文字と判定できず、それらに隣接する数字を
// 末尾ドット数値（`1.`）と誤同一視していた。誤同一視すると `.` 後続のプロパティアクセス
// （`in`）が keywordProperty=false になり、後続 `/` が regex と誤読されて閉じ `/` 探索が
// 文字列リテラル内の `/`（`http://`）を飲み込み、trailing コメントが除去されない
// （コメント除去契約違反）。
test('結合文字（分解形 á = a + U+0301）に隣接する数字直後のプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = á1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = á1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

test('ZWNJ（U+200C）に隣接する数字直後のプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = a‌1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = a‌1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

test('ZWJ（U+200D）に隣接する数字直後のプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = a‍1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = a‍1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

test('非 BMP 識別子文字（サロゲートペア。数学用太字大文字 A U+1D400）に隣接する数字直後のプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = \u{1D400}1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = \u{1D400}1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

// Issue #455 codex P1（PR #456 レビュー指摘・2 巡目）の回帰固定: wordPrevRaw は「識別子中に
// 実際に出現した文字」のみを見ており、ECMAScript の Unicode コードポイントエスケープ
// （`\u{H...}` / `\uHHHH`）で書かれた識別子文字は認識できなかった。エスケープは `\` `{` `}`
// を含み isWordChar（ASCII のみ）が単語境界と誤認するため、`\u{1D400}1` の `1` が新規単語
// 開始と誤認され、直後の `.` が末尾ドット数値と誤同一視されていた（上のサロゲートペア回帰は
// 実際の非 BMP 文字が直接書かれたソースのみをカバーしており、エスケープ表記は未カバーだった）
test('Unicode コードポイントエスケープ（\\u{H...}）で書かれた識別子直後の数字とプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = \\u{1D400}1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = \\u{1D400}1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

test('Unicode コードポイントエスケープ（\\uHHHH 固定4桁）で書かれた識別子直後の数字とプロパティアクセスを末尾ドット数値と誤同一視しない', () => {
  const src = "const x = \\u0041\\u0042" + "1.in / 2 + 'http://keep' // c\n"
  const expected = "const x = \\u0041\\u0042" + "1.in / 2 + 'http://keep'\n"
  assert.equal(stripComments(src), expected)
})

test('Unicode コードポイントエスケープの識別子は {} 深度カウントの対象にならない（エスケープ内の { } はブロック境界ではない）', () => {
  const src = 'function f() { const \\u{1D400} = 1; return \\u{1D400} }\n'
  assert.equal(stripComments(src), src)
})

test('キーワード本体（in）直後の regex は保持される', () => {
  const src = 'for (const k in /x[/]y/.source) {}\n'
  assert.equal(stripComments(src), src)
})

test('エスケープされたスラッシュを含む regex を保持する', () => {
  const src = 'const re = /https:\\/\\/[a-z]+/\n'
  assert.equal(stripComments(src), src)
})

test('除算を regex と誤認して後続の trailing コメントを取り逃さない', () => {
  assert.equal(stripComments('const x = a / b // comment\n'), 'const x = a / b\n')
})

test('regex フラグ直後の除算も正しく除算として扱う', () => {
  assert.equal(stripComments('const x = /a/g // c\n'), 'const x = /a/g\n')
})

// PR #452 codex P2 / Bugbot Medium の回帰固定: `}` や後置 `++` / `--` の直後の `/` を
// regex 開始と誤認すると、(a) 後続の行コメントの先頭 `/` を regex の閉じとして素通しして
// コメントが生成物に残留し、(b) 最悪は閉じ `/` 探索が行内の文字列開始を飲み込んで
// 非コメントのコードを書き換える。これらを除算として扱うことを固定する。
test('} 直後の除算に続く trailing コメントを除去する', () => {
  assert.equal(stripComments('const x = {} / 2 // remove me\n'), 'const x = {} / 2\n')
})

test('後置 ++ / -- 直後の除算に続く trailing コメントを除去する', () => {
  assert.equal(stripComments('const y = x++ / 2 // remove me\n'), 'const y = x++ / 2\n')
  assert.equal(stripComments('const z = x-- / 2 // remove me\n'), 'const z = x-- / 2\n')
})

test('} 直後の除算行にある後続文字列を書き換えない（regex 誤読でクォートを飲み込まない）', () => {
  assert.equal(
    stripComments("const x = {} / 2 + 'http://keep' // c\n"),
    "const x = {} / 2 + 'http://keep'\n",
  )
})

test('ブロックコメントは内部の改行を保持して除去される（行番号維持）', () => {
  assert.equal(stripComments('const a = 1\n/*\n block\n*/\nconst b = 2\n'), 'const a = 1\n\n\n\nconst b = 2\n')
})

test('ブロックコメント除去でトークンが連結しない', () => {
  assert.equal(stripComments('const/*x*/y = 1\n'), 'const y = 1\n')
})

// PR #452 codex P1 の回帰固定: 空白挿入を単語文字同士に限ると、演算子連結（`x+/*c*/+y` →
// `x++y` は加算がインクリメントへ変わる）や数値と `.` の連結（`1/*c*/.toString()` →
// `1.toString()` は構文エラー）で「コメントのみを除去する」契約が破れる。ブロックコメントは
// 常に空白 1 個へ置換して全トークン境界を保持することを固定する。
test('ブロックコメント除去で演算子が連結しない（+ /*c*/ + がインクリメントにならない）', () => {
  assert.equal(stripComments('const z = x+/*c*/+y\n'), 'const z = x+ +y\n')
})

test('ブロックコメント除去で数値と . が連結しない（1/*c*/.toString() の構文破壊防止）', () => {
  assert.equal(stripComments('const s = 1/*c*/.toString()\n'), 'const s = 1 .toString()\n')
})

test('行末ブロックコメントの置換空白は行末に残らない（trim_trailing_whitespace 準拠）', () => {
  assert.equal(stripComments('const a = 1 /* c */\nconst b = 2\n'), 'const a = 1\nconst b = 2\n')
})

test('末尾ドット数値直後の除算に続く trailing コメントを除去する', () => {
  assert.equal(stripComments('const a = 1. / 2 // c\n'), 'const a = 1. / 2\n')
})

test('末尾ドット数値直後の除算行の後続文字列を書き換えない（regex 誤読でクォートを飲み込まない）', () => {
  assert.equal(
    stripComments("const a = 1. / 2 + 'http://keep' // c\n"),
    "const a = 1. / 2 + 'http://keep'\n",
  )
})

test('spread `...` 直後の regex は保持される（末尾ドット数値の除算判定に巻き込まない）', () => {
  const src = 'const r = [.../a[/]b/.exec(s)]\n'
  assert.equal(stripComments(src), src)
})

test('ブロックコメント直後の識別子が直前の単語と連結して keyword 判定を壊さない', () => {
  assert.equal(stripComments('const b = x/*c*/in /[/]/ // note\n'), 'const b = x in /[/]/\n')
})

// コード行の先頭インデント除去（サイズ予算確保。改行は触らず行番号を保つ）
test('インデントされたコード行は先頭の空白が除去される', () => {
  assert.equal(stripComments('function f() {\n  if (x) {\n    y()\n  }\n}\n'), 'function f() {\nif (x) {\ny()\n}\n}\n')
})

test('タブインデントも除去される', () => {
  assert.equal(stripComments('a()\n\t\tb()\n \t c()\n'), 'a()\nb()\nc()\n')
})

test('コメントだけの行・インデント付きコメントだけの行は完全な空行になる', () => {
  assert.equal(stripComments('a()\n    // c\n  /* d */\nb()\n'), 'a()\n\n\nb()\n')
})

test('複数行ブロックコメントは完全な空行になり、閉じ後のコードの先頭にも空白が残らない', () => {
  assert.equal(stripComments('a()\n  /* x\n     y\n  */ b()\n'), 'a()\n\n\nb()\n')
})

test('インデント + 行末コメントは先頭・末尾とも空白が残らない', () => {
  assert.equal(stripComments('    const a = 1  // c\n'), 'const a = 1\n')
})

test('空白だけの行は完全な空行になる', () => {
  assert.equal(stripComments('a()\n    \n\t\nb()\n'), 'a()\n\n\nb()\n')
})

test('複数行テンプレートリテラルの継続行（インデント付き）は 1 バイトも変わらない', () => {
  const src = 'const p = `\n  line1\n\tline2\n    bash:\n      echo hi\n`\n'
  assert.equal(stripComments(src), src)
})

test('テンプレート閉じ直後の行のインデントは除去される（モード復帰）', () => {
  assert.equal(stripComments('const p = `\n  a\n`\n  next()\n'), 'const p = `\n  a\n`\nnext()\n')
})

test('テンプレート ${} 内で改行した行頭インデントも保守側で除去しない（テンプレート内は一切不変）', () => {
  const src = 'const p = `a ${\n    foo(\n      1)\n  } b\n  c`\n  after()\n'
  assert.equal(stripComments(src), 'const p = `a ${\n    foo(\n      1)\n  } b\n  c`\nafter()\n')
})

test('ネストしたテンプレートの継続行も不変', () => {
  const src = 'const p = `x ${cond ? `\n   in\n` : z}\n   tail`\n'
  assert.equal(stripComments(src), src)
})

test('エスケープされたバッククォートでテンプレートが閉じたと誤認しない', () => {
  const src = 'const p = `a \\`\n   still template \\` x\n`\n  after()\n'
  assert.equal(stripComments(src), 'const p = `a \\`\n   still template \\` x\n`\nafter()\n')
})

test('シングルクォート文字列内のバッククォートでテンプレートが開いたと誤認しない', () => {
  assert.equal(stripComments("const a = '`a'\n  b()\n    c()\n"), "const a = '`a'\nb()\nc()\n")
})

test('文字列リテラルの \\ 改行継続の継続行は除去しない', () => {
  const src = "const s = 'abc\\\n    def'\n  after()\n"
  assert.equal(stripComments(src), "const s = 'abc\\\n    def'\nafter()\n")
})

test('正規表現リテラル直後の行のインデントは除去される', () => {
  assert.equal(stripComments('const r = /a b/\n    r.test(s)\n'), 'const r = /a b/\nr.test(s)\n')
})

test('入力と出力の行数（改行数）が同一', () => {
  const src = [
    'function f() {', '  // c', '  /* a', '     b */ g()', '  const p = `', '    keep', '  `', '\tx()', '',
  ].join('\n')
  const out = stripComments(src)
  assert.equal(out.split('\n').length, src.split('\n').length)
})

test('冪等性: インデント除去後の出力へ再適用しても不変', () => {
  const once = stripComments('f(() => {\n    const t = `\n  a\n`\n  /* c */ g()\n})\n')
  assert.equal(stripComments(once), once)
})

test('冪等性: 除去済みソースへ再適用しても不変', () => {
  const once = stripComments("const a = 1 // c\nconst u = 'http://x'\n")
  assert.equal(stripComments(once), once)
})

// ---------------------------------------------------------------------------
// (d) 空白除去（squeezeSpaces）
// ---------------------------------------------------------------------------

test('許可リスト: 詰めてよい組（括弧・区切り・引用符の隣、単語と演算子の隣、一部の演算子同士）', () => {
  const squeezable = [
    ['a', '('], [')', 'b'], ['(', 'x'], ['x', ')'], [',', 'y'], [';', 'z'], ['{', 'k'], ['}', 'else'], ['t', '['],
    ['a', '='], ['=', 'b'], ['a', '+'], ['+', 'b'], ['a', '?'], ['?', 'b'], ['b', ':'], [':', 'c'], ['a', '<'],
    ['return', '"'], ['"', 'in'], ["'", 'x'], ['`', 'x'], ['=', '`'], ['=', '!'], ['&', '!'], ['=', '-'], ['+', '!'],
    [',', '.'], ['(', '.'], ['"', '.'], ['}', '.'],
  ]
  for (const [prev, next] of squeezable) {
    assert.equal(shouldSqueezeSpace(prev, next), true, `${prev} ${next} は詰めてよい`)
  }
})

test('許可リスト: 詰めてはいけない組（連結すると別トークンになる・意味が変わる・判断できない）', () => {
  const kept = [
    ['a', 'b'], ['1', 'a'], ['_', '$'], // 単語文字同士
    ['+', '+'], ['+', '-'], ['-', '-'], ['-', '+'], // `+ +` `+ ++` `- --` の先頭 2 文字
    ['*', '*'], ['&', '&'], ['|', '|'], ['?', '?'], ['<', '<'], ['>', '>'], ['=', '='], ['=', '>'], ['!', '='],
    ['<', '!'], // `<!--`
    ['?', '.'], // `?.5`
    ['1', '.'], ['a', '.'], ['.', '5'], ['.', 'a'], ['+', '.'], ['=', '.'], // `.` の前後
    ['a', '/'], ['/', 'a'], [')', '/'], ['/', '/'], ['*', '/'], ['/', '*'], // `/` の前後
    ['é', 'a'], ['a', 'é'], ['\\', 'a'], ['a', '\\'], ['#', 'a'], ['@', 'a'], // 分類なし
    ['', 'a'], ['a', ''], [undefined, 'a'], ['a', undefined],
  ]
  for (const [prev, next] of kept) {
    assert.equal(shouldSqueezeSpace(prev, next), false, `${prev} ${next} は詰めない`)
  }
})

test('空白除去: 括弧・区切り・演算子の隣の空白を詰める', () => {
  assert.equal(squeezeSpaces('const a = 1\n'), 'const a=1\n')
  assert.equal(squeezeSpaces('f(a, b)\n'), 'f(a,b)\n')
  assert.equal(squeezeSpaces('if (x) { y() } else { z() }\n'), 'if(x){y()}else{z()}\n')
  assert.equal(squeezeSpaces('const o = { a: 1, b: -1 }\n'), 'const o={a:1,b:-1}\n')
  assert.equal(squeezeSpaces('const f = (a) => a + 1\n'), 'const f=(a)=>a+1\n')
  assert.equal(squeezeSpaces('const v = c ? b : d\n'), 'const v=c?b:d\n')
  assert.equal(squeezeSpaces('const w = a && !b || ~c\n'), 'const w=a&&!b||~c\n')
  assert.equal(squeezeSpaces("switch (k) { case 'a': return -1 }\n"), "switch(k){case'a':return-1}\n")
})

test('空白除去: 単語文字同士の空白は残す', () => {
  assert.equal(squeezeSpaces('const x = a in o\n'), 'const x=a in o\n')
  assert.equal(squeezeSpaces('return typeof x\n'), 'return typeof x\n')
})

test('空白除去: 連続する空白・タブは詰めるか 1 個に畳む', () => {
  assert.equal(squeezeSpaces('const   x  =\t1\n'), 'const x=1\n')
  assert.equal(squeezeSpaces('return \t x\n'), 'return x\n')
})

test('空白除去: 連結すると別トークンになる組は詰めない（+ + / + ++ / - - / - --）', () => {
  assert.equal(squeezeSpaces('const a = b + +c\n'), 'const a=b+ +c\n')
  assert.equal(squeezeSpaces('const a = b + ++c\n'), 'const a=b+ ++c\n')
  assert.equal(squeezeSpaces('const a = b - -c\n'), 'const a=b- -c\n')
  assert.equal(squeezeSpaces('const a = b - --c\n'), 'const a=b- --c\n')
  assert.equal(squeezeSpaces('const a = b++ + c\n'), 'const a=b++ +c\n')
})

test('空白除去: <!-- を作らない（< と ! の間は詰めない）', () => {
  const out = squeezeSpaces('const a = b < !--c\n')
  assert.equal(out, 'const a=b< !--c\n')
  assert.ok(!out.includes('<!--'))
})

test('空白除去: / の前後は詰めない（除算・正規表現・コメント開始の誤生成防止）', () => {
  assert.equal(squeezeSpaces('const q = a / b\n'), 'const q=a / b\n')
  assert.equal(squeezeSpaces('const r = /ab/ .test(s)\n'), 'const r= /ab/ .test(s)\n')
  assert.equal(squeezeSpaces('const t = a * /b/.source.length\n'), 'const t=a* /b/.source.length\n')
})

test('空白除去: 除算（または除算と誤読された正規表現）がある行は残りの空白を詰めない', () => {
  // `if (x)` 直後の `/` は除算側に倒される（`)` `}` 直後の曖昧さ）。実際は正規表現でも、
  // その内部の空白（`a (b)`）を詰めて正規表現を壊さない
  assert.equal(squeezeSpaces('if (x) /a (b)/.test(s)\n'), 'if(x) /a (b)/.test(s)\n')
  // 次の行は影響を受けず詰める
  assert.equal(squeezeSpaces('if (x) /a (b)/.test(s)\nconst z = 1\n'), 'if(x) /a (b)/.test(s)\nconst z=1\n')
})

test('空白除去: 数値の後の . は詰めない（1 .toString()）、? . 数値（a ? .5 : b）も ?.5 にしない', () => {
  assert.equal(squeezeSpaces('const s = 1 .toString()\n'), 'const s=1 .toString()\n')
  const out = squeezeSpaces('const n = a ? .5 : b\n')
  assert.equal(out, 'const n=a? .5:b\n')
  assert.ok(!out.includes('?.5'))
})

test('空白除去: spread の ... は直前が区切りのときだけ詰める', () => {
  assert.equal(squeezeSpaces('const a = [x, ...y]\n'), 'const a=[x,...y]\n')
  assert.equal(squeezeSpaces('f(...args, ...more)\n'), 'f(...args,...more)\n')
})

test('空白除去: 文字列リテラル内の空白は 1 バイトも変えない', () => {
  assert.equal(squeezeSpaces(`const s = 'a  +  b' + "x  (y)  =  z"\n`), `const s='a  +  b'+"x  (y)  =  z"\n`)
})

test('空白除去: テンプレートリテラル（本文・${} 式内・ネスト）は 1 バイトも変えない', () => {
  const t = 'const t = `a  b ${ c  +  d } e  ${ f ? `g  h ${ i  +  j }` : k }  l`\n'
  assert.equal(squeezeSpaces(t), 'const t=`a  b ${ c  +  d } e  ${ f ? `g  h ${ i  +  j }` : k }  l`\n')
})

test('空白除去: テンプレートリテラルの直後の空白は詰める（モード復帰）', () => {
  assert.equal(squeezeSpaces('const t = `a  b` + c  + `d`\n'), 'const t=`a  b`+c+`d`\n')
})

test('空白除去: 正規表現リテラル内の空白とエスケープは 1 バイトも変えない', () => {
  assert.equal(squeezeSpaces('const r = /a  (b)  \\//g.test(s)\n'), 'const r= /a  (b)  \\//g.test(s)\n')
  assert.equal(squeezeSpaces('const r = [x, /a  [ ]  b/]\n'), 'const r=[x, /a  [ ]  b/]\n')
})

test('空白除去: 行末の空白は残らず、改行と行数は保持される', () => {
  const src = 'foo(a)  \nbar( b )\n\n  baz()\n'
  const out = squeezeSpaces(src)
  assert.equal(out, 'foo(a)\nbar(b)\n\nbaz()\n')
  assert.equal(out.split('\n').length, src.split('\n').length)
})

test('空白除去: Unicode エスケープ識別子の閉じ } と単語文字を連結しない', () => {
  assert.equal(squeezeSpaces('const x = \\u{61} in o\n'), 'const x= \\u{61} in o\n')
  assert.equal(squeezeSpaces('const y = {} in o\n'), 'const y={}in o\n') // 通常の } は詰める
})

test('空白除去: 非 ASCII 識別子の隣は詰めない（return é が returné にならない）', () => {
  assert.equal(squeezeSpaces('return é\n'), 'return é\n')
  assert.equal(squeezeSpaces('const x = é + 1\n'), 'const x= é +1\n')
})

test('空白除去: 数値の指数部になる並び（1e +2）は詰めない', () => {
  assert.equal(squeezeSpaces('const a = 1e + 2\n'), 'const a=1e +2\n')
  assert.equal(squeezeSpaces('const b = e + 2\n'), 'const b=e+2\n')
})

test('空白除去: ブロックコメントの置換空白が詰め残しにならず冪等', () => {
  const out = squeezeSpaces('foo(/*c*/ x, /* d */ y)\n')
  assert.equal(out, 'foo(x,y)\n')
  assert.equal(squeezeSpaces(out), out)
})

test('空白除去: stripComments は既定では空白を詰めない（既存契約を変えない）', () => {
  assert.equal(stripComments('const a = f(b, c)\n'), 'const a = f(b, c)\n')
})

test('空白除去: 冪等（再適用しても不変）', () => {
  const src = [
    'function f(a, b) {',
    '  const t = `x  ${ a  +  b }`',
    '  if (a < !--b) return a + +b - --a',
    '  return /a  (b)/.test(t) ? 1 .toString() : "s  s"',
    '}',
    '',
  ].join('\n')
  const once = squeezeSpaces(src)
  assert.equal(squeezeSpaces(once), once)
  assert.equal(stripComments(once, { squeezeSpaces: true }), once)
})

test('空白除去: 行数（改行数）を保持する', () => {
  const src = 'a ( 1 )\n\n/* x\n y */ b ( 2 )\n`t\n  u`\n  c ( 3 )'
  assert.equal(squeezeSpaces(src).split('\n').length, src.split('\n').length)
})

// acorn（Node 同梱の字句解析器）で、変換前後のトークン列（種類・テキスト・開始行）が一致する
// ことを検証する。acorn は `node --expose-internals` の子プロセスでしか読めないため
// tests/lib/token-diff.cjs 経由で呼ぶ。読み込めない環境でも skip せず fail する（fail-closed:
// 検証が静かに無効化されて「トークン列一致」の保証が消えるのを防ぐ）
const compareTokensWithAcorn = (cases) => {
  const r = spawnSync(process.execPath, ['--expose-internals', TOKEN_DIFF_HELPER], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  assert.equal(r.status, 0, `acorn によるトークン比較の子プロセスが失敗（status ${r.status}）: ${r.stderr}`)
  const { results } = JSON.parse(r.stdout)
  assert.equal(results.length, cases.length)
  return results
}

test('トークン列一致（acorn）: 固定ケースで変換前後のトークンの種類・値・行が一致する', () => {
  const snippets = [
    'const a = 1\n',
    'if (x) { y() } else { z() }\n',
    'const o = { a: 1, b: -1, ...c }\n',
    'const f = (a) => a + 1\n',
    'const v = c ? b : d\n',
    'const n = a ? .5 : b\n',
    'const s = 1 .toString()\n',
    'const q = a / b / c\n',
    'const r = /a  (b)  \\//g.test(s) + 1\n',
    'const a = b + +c - -d + ++e - --f\n',
    'const a = b++ + c-- - d\n',
    'const z = b < !--c\n',
    'const w = a && !b || ~c ?? d\n',
    'const e1 = e + 2\n',
    "switch (k) { case 'a': return -1; default: return +x }\n",
    'const s = \'a  +  b\' + "x  (y)  =  z"\n',
    'const t = `a  b ${ c  +  d } e  ${ f ? `g  h ${ i  +  j }` : k }  l`\n',
    'const t = `a  b` + c  + `d`\n',
    'const x = \\u{61} in o\n',
    'for (const k of [1, 2]) { sum += k * 2 ** 3 }\n',
    'a = b ? c : d ? e : f\n',
    'x = a ? -1 : +1\n',
    'async function g() { await h(); return typeof (await i) }\n',
    'class A extends B { static #p = 1; get x() { return this.#p } }\n',
    'label: for (;;) { break label }\n',
    'x = y\n  ? z\n  : w\n',
    'foo(/*c*/ x, /* d */ y) // tail\n',
  ]
  const cases = snippets.map((code) => ({ name: JSON.stringify(code), before: code, after: squeezeSpaces(code) }))
  const failed = compareTokensWithAcorn(cases).filter((r) => !r.ok)
  assert.deepEqual(failed, [])
})

test('トークン列一致（acorn）: 実ファイル implement-issue-tree.src.js と生成物の全トークンが一致する', () => {
  const src = readFileSync(SRC_PATH, 'utf8')
  const dist = readFileSync(DIST_PATH, 'utf8')
  // before は生の src（acorn はコメントを読み飛ばす）なので、コメント除去・インデント除去・
  // 空白除去の全体が「トークン列と各トークンの開始行を変えない」ことを独立実装で検証する
  const [result] = compareTokensWithAcorn([{ name: 'implement-issue-tree', before: src, after: dist }])
  assert.equal(result.ok, true, result.detail)
})

// ---------------------------------------------------------------------------
// (b) 鮮度ゲート（リポジトリ実体の検証）
// ---------------------------------------------------------------------------

test('実行ファイルは開発ファイルからの再生成結果と byte 一致する（ビルド忘れ・直接編集の検出）', () => {
  const src = readFileSync(SRC_PATH, 'utf8')
  const dist = readFileSync(DIST_PATH, 'utf8')
  // buildArtifact は行数保持・先頭 meta 宣言・冪等性の検証込み（失敗時は throw）
  const rebuilt = buildArtifact(src)
  assert.ok(
    rebuilt === dist,
    '実行ファイル implement-issue-tree.js が開発ファイル implement-issue-tree.src.js と同期していない。' +
      '編集は .src.js に対して行い、node skills/implement-issue-tree/scripts/build-workflow.mjs で再生成すること' +
      '（実行ファイルの直接編集は次のビルドで消える）',
  )
})

test('開発ファイルと実行ファイルの行数が一致する（スタックトレース行番号の突き合わせ契約）', () => {
  const src = readFileSync(SRC_PATH, 'utf8')
  const dist = readFileSync(DIST_PATH, 'utf8')
  assert.equal(src.split('\n').length, dist.split('\n').length)
})

// ---------------------------------------------------------------------------
// (c) CLI ガード（symlink 経由・相対パス起動でも実行部が動くこと）
// ---------------------------------------------------------------------------

test('symlink 経由で起動しても CLI ガードを通過して --check が実行される（無言 no-op の防止）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-workflow-link-'))
  try {
    const link = join(dir, 'build-workflow.mjs')
    symlinkSync(SCRIPT_PATH, link)
    const r = spawnSync(process.execPath, [link, '--check'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /鮮度 ok/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('相対パスで起動しても CLI ガードを通過して --check が実行される', () => {
  const r = spawnSync(
    process.execPath,
    ['skills/implement-issue-tree/scripts/build-workflow.mjs', '--check'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /鮮度 ok/)
})

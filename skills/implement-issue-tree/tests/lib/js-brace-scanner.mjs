// merge-loop-rescan.test.mjs（および将来ソース走査を行う他テスト）が実装スクリプトの
// ループ範囲を求めるために使う、字句を区別する波括弧対応位置検出の唯一の実装。
//
// 対象バグ（Issue #336）: 旧実装はソース中のすべての `{` / `}` を文字列・コメント・
// テンプレートリテラル・正規表現リテラルの区別なくカウントしていた。対象ループが
// テンプレートリテラル・日本語コメントを多用するため、片側だけの波括弧を含む
// 文字列・コメントが 1 行入るだけで境界判定が実体と乖離し得た。本モジュールは
// 文字列 / テンプレートリテラル（`${...}` 展開含む） / 行コメント / ブロックコメント /
// 正規表現リテラルを字句として認識してスキップすることで、この誤判定のクラスを構造的に
// なくす。
//
// 追加バグ（PR #351 レビュー指摘）: 正規表現 vs 除算の判定を「`/` の直前 1 文字だけ」を
// 逆走査して決める heuristic は、次の 3 クラスを構造的に誤判定する。
//   1. 制御文ヘッダーの閉じ `)`（`if (c) /re/` 等）と、呼び出し/グループ化の閉じ `)`
//      （`foo() / 2` 等）はどちらも直前文字が `)` だが意味が逆（前者は正規表現側、
//      後者は除算側）であり、1 文字の逆走査では区別できない。
//   2. 逆走査は空白のみスキップしコメントを読み飛ばさないため、ブロックコメント直後
//      （`/* c */ /re/` の `*/` の `/`）を誤って除算側と判定し得る。
//   3. 後置 `++`/`--`（`x++ / y`）の末尾文字 `+`/`-` は前置演算子の記号と区別が付かず、
//      正規表現側と誤判定し得る。
// 本モジュールは「`/` の直前 1 文字を逆走査する」のをやめ、メインループが前進走査で
// 通過する各トークンごとに「直前の意味のあるトークンが式の値（VALUE: 識別子・数値・
// 文字列・テンプレート・呼び出し/グループの `)`・`]`・後置 `++`/`--` 等）か、
// 値を期待する演算子/文位置（OPERATOR: 二項演算子・制御文ヘッダーの `)`・前置 `++`/`--`
// 等）か」を状態として持ち回る（`prevSignificant`）。コメントは元々読み飛ばすだけで
// この状態を更新しないため 2. は構造的に発生しない。`(` を push する際に直前語が
// if/while/for/switch/catch かどうかを記録し、対応する `)` で当該情報を pop して
// VALUE/OPERATOR を判定することで 1. を解消する。`++`/`--` は直前が VALUE なら後置
// （結果は VALUE）、そうでなければ前置（依然 OPERATOR）として分岐することで 3. を解消する。
//
// 追加バグ その2（PR #351 codex-review / Cursor Bugbot 指摘）: 前進トークン追跡版でも
// 次の 3 クラスが残っていた。
//   4. `throw` が REGEX_PRECEDING_KEYWORDS に無く、`throw /}/.test(x)` のような式文で
//      `/}/`  内の `}` を誤ってブロック終端と扱い得た。
//   5. 通常コード用 `}`（テンプレート `subst` 以外）を無条件に OPERATOR 扱いしていたため、
//      `x = {} / 2` のようなオブジェクトリテラル直後の `/` を正規表現の開始と誤認し得た。
//      ブロック文の `}`（VALUE を期待しない文位置）とオブジェクトリテラルの `}`
//      （式の値=VALUE）は区別が必要。
//   6. `(` の直前トークンが制御キーワード（if/while/for/switch/catch）と同じ綴りの
//      「メソッド名」（`obj.catch(...)`・`obj.if(...)` 等のプロパティアクセス直後の
//      呼び出し）を、`lastWord` の文字列一致だけで区別できず制御文ヘッダーと誤分類し
//      得た。対応する `)` で `prevSignificant` が VALUE ではなく OPERATOR のままになり、
//      後続の `/` を正規表現と誤読する（`Promise.prototype.catch` 等の一般的な API で
//      発生する）。
// 4. は `throw` を REGEX_PRECEDING_KEYWORDS に追加して解消する。5. は `{` を push する
// 時点の文脈（直前が制御文ヘッダーの `)` か・`else`/`do` か・`=>` 直後か・OPERATOR/VALUE
// のどちらだったか）からブロック文とオブジェクトリテラルを判定し、フレームに種別を
// 記録して対応する `}` で VALUE/OPERATOR を出し分けることで解消する。6. は `.` 直後の
// 識別子を「メンバー名」として扱い、制御キーワード/正規表現先行キーワードの判定対象
// から除外する（`afterDot` で追跡）ことで解消する。
//
// 追加バグ その3（PR #351 codex-review 未解決スレッド）:
//   7. `with` が CONTROL_KEYWORDS に無く、`with (obj) /}/.test(x)` の `)` が呼び出し/
//      グループ化の終端（VALUE）と誤判定され得た。`for await (const x of xs) /}/.test(x)`
//      も同様に、直前語判定が `await`（`for` ではない）になるため誤判定され得た。
//   8. 識別子判定が `[A-Za-z0-9_$]` の ASCII 限定だったため、`const π = 1; π / 2` のような
//      非 ASCII 識別子（Unicode IdentifierPart）が「その他の記号」分岐に落ち、
//      prevSignificant が OPERATOR のままになって `/` を正規表現の開始と誤認し得た。
//   9. 通常コードの `:`（`case`/`default`/ラベル文の文位置コロン）を無条件 OPERATOR
//      扱いしていたため、直後の `{` が「値を期待する位置」の判定経路に入り、ブロック文
//      であるべき `case 1: { ... }` をオブジェクトリテラルと誤分類し得た。
// 7. は CONTROL_KEYWORDS に `with` を追加し、識別子読み取り時に直前語が `for` かつ今回の
// 語が `await` なら `lastWord` を `for` のまま保持する（`afterDot` が false の場合のみ。
// `arr.with(0, 1)` のようなメンバー呼び出しは afterDot 経由で除外済みのため影響しない）
// ことで解消する。8. は識別子先頭・継続の文字判定を Unicode プロパティエスケープ
// （`\p{L}`（文字）・`\p{Nl}`（文字として扱う数）・`\p{Nd}`（10 進数字。継続文字のみ）・
// `_`・`$`）へ拡張して解消する。数値リテラル判定（`isNumberLike`）は元の ASCII `[0-9]`
// 判定のまま変更しない（JS の数値リテラル構文自体が ASCII 限定のため）。
// 9. は「文位置のコロン」（case/default/ラベル文）と「式位置のコロン」（オブジェクト
// リテラルの key: value・三項演算子の `? :`）を区別する。三項演算子の深さ（`?` の
// 個数 − 対応する `:` の個数）を**現在のフレームに紐付けて**保持する
// （`x = c ? { a: 1 } : {}` のように三項演算子の分岐内にオブジェクトリテラルが入れ子に
// なる場合、そのリテラルの `{`/`}` で新しいフレームが push/pop されるため、深さを
// グローバル 1 変数で数えると内側の `key: value` の `:` が外側の三項演算子のカウントを
// 誤って消費してしまう。フレーム単位にすることで両者が独立して数えられる）。
// 現在のフレームの三項深度が 0 のときに読む `:` は、フレームが `code`/`BLOCK` 種別
// （＝現在オブジェクトリテラル/分割代入パターンの内部にいない）なら文位置のコロンと
// 判定し、直後の `{` を常にブロックとして扱う（JS の文法上、文位置の裸 `{` は常に
// ブロック文であり、式としてのオブジェクトリテラルは文位置には現れ得ないため）。
//
// 追加バグ その4（PR #351 codex-review 未解決スレッド。8. の残課題と新規指摘）:
//   10. `break` / `continue` / `debugger` は（`case`/`default` ラベル以外の）オペランドを
//       取らない文であり、ASI（自動セミコロン挿入）でその場の文が終端し得る
//       （`break\n/re/.test(s)` のように改行のみで区切られるケース）。8. までの実装は
//       これらを REGEX_PRECEDING_KEYWORDS にも `else` 分岐にも含めておらず、素朴な
//       識別子読み取り経路（else 分岐）に落ちて prevSignificant が VALUE になっていた。
//       文の終端後という文位置（OPERATOR）であるべきところが VALUE のままになるため、
//       直後の `/` を正規表現の開始ではなく除算と誤認し得た。
//   11. 8. の Unicode 拡張は `\p{L}`（文字）・`\p{Nl}`・`\p{Nd}` のみを対象にしており、
//       次の 2 点が未対応だった。
//       a. 結合文字（`\p{Mn}`（Nonspacing_Mark）・`\p{Mc}`（Spacing_Mark））・ZWNJ
//          （U+200C）・ZWJ（U+200D）は ECMAScript の IdentifierPart に含まれる継続文字
//          だが、開始文字判定にも継続文字判定にも入っておらず「その他の記号」分岐に
//          落ちて prevSignificant が OPERATOR のままになり得た（結合文字直後の `/` を
//          正規表現の開始と誤認）。
//       b. 走査が UTF-16 コード単位単位（`text[i]` 1 文字ずつ）だったため、非 BMP の
//          `\p{L}` 文字（サロゲートペア。例: 数学用英字アルファベット U+1D49C）は
//          上位/下位サロゲートを個別に正規表現テストしてしまい、単独のサロゲートは
//          いずれの Unicode プロパティにも一致しないため識別子として認識されなかった
//          （`/u` フラグを付けても、テスト対象の文字列自体が完全なコードポイントを
//          成していなければ意味を持たない）。
// 10. は `break`・`continue`・`debugger` を REGEX_PRECEDING_KEYWORDS に追加して解消する
// （これらの語の後は次の式が独立した新しい文の可能性があるため、意味的な理由は
// 「値を期待する語の直後」ではなく「文が終端し得る位置」だが、求める走査状態
// （prevSignificant = OPERATOR）は同じであるため同じ集合で表現できる）。
// 11-a は継続文字専用の追加集合 `IDENT_EXTRA_CONT_RE`（`\p{Mn}\p{Mc}` + ZWNJ/ZWJ）を
// 定義し、`\p{Mn}\p{Mc}` は ECMAScript の IdentifierStart に含まれないため開始文字判定
// には加えず、継続文字判定にのみ合成する。11-b は識別子の読み取りを UTF-16 コード単位
// ではなく `String.prototype.codePointAt` によるコードポイント単位に変更する
// （`readCodePointAt` ヘルパー。サロゲートペアを 1 文字として `IDENT_START_RE`/
// `IDENT_CONT_RE` へ渡し、一致した場合はコードポイントの UTF-16 長（1 または 2）だけ
// 前進する）。
//
// ファイル名が `*.test.mjs` に一致しないため `node --test` の glob には拾われない
// （tests/lib/workflow-script-contract.mjs と同じ配置規約）。
//
// このモジュールは渡された文字列を「解析するだけ」で「実行しない」。`eval` / `new Function` /
// `new AsyncFunction` / `vm` のいずれも使わない純粋な文字走査であり、
// tests/lib/workflow-script-contract.mjs が行う構文木構築（解析のみ・実行しない）よりも
// さらに実行面がない（OWASP A03）。

// フレームスタックの要素種別。
// - 'code': 波括弧に対応する通常のコードブロック（走査開始位置の `{` もこの種別で push する）。
// - 'subst': テンプレートリテラル内の `${` に対応する式展開ブロック。閉じ `}` で
//   pop されるとテンプレート走査へ復帰する（バッククォート探索を再開する）。
const FRAME_CODE = 'code'
const FRAME_SUBST = 'subst'

// 直後の `/` を正規表現リテラルの開始と判定するキーワード（直前の意味のあるトークンが
// これらの語のとき、走査状態は OPERATOR = 値を期待する位置になる）。
// 例: `return /}/.test(s)` の `/` は除算ではなく正規表現の開始。
// `break`/`continue`/`debugger` はオペランドを取らない文であり、ASI により
// その場で文が終端し得る（`break\n/re/.test(s)` 等）。求める走査状態
// （prevSignificant = OPERATOR）は他の語と同じであるため同じ集合に含める
// （上記コメント項目 10 参照）。
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
  'break', 'continue', 'debugger',
])

// 開き `(` の直前語がこれらの制御構文キーワードのとき、対応する閉じ `)` は
// 「制御文ヘッダーの終端」（例: `if (cond)` の後は文位置 = OPERATOR 状態）であり、
// `foo(...)` のような呼び出し/グループ化の閉じ `)`（結果は式の値 = VALUE 状態）とは
// 区別しなければならない。両者は直前 1 文字だけを見る旧実装では区別不能だった。
// ただし `obj.catch(...)`・`obj.if(...)` のようにこれらと同じ綴りのプロパティ/メソッド名
// が `.` の直後に来た場合は制御構文ではない（`afterDot` で判定し除外する）。
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with'])

// `{` の直前語がこれらのとき、対応する `{` は常にブロック文（`else { ... }` /
// `do { ... } while (...)`）であり、オブジェクトリテラルではない。`else`/`do` は
// REGEX_PRECEDING_KEYWORDS にも含まれるため `{` 到達時点で prevSignificant が
// OPERATOR になっており、素朴な「OPERATOR ならリテラル」判定だとオブジェクトリテラル
// と誤分類してしまう。
// `break`/`continue`/`debugger` も同じ理由でここに必要（PR #351 Cursor Bugbot 指摘）:
// これらは ASI でその場の文が終端し得るオペランドなしの文であり、REGEX_PRECEDING_KEYWORDS
// にも含まれるため、直後に改行だけを挟んでブロック文の裸 `{`（`break\n{ y }` のように
// break の文が ASI で終端し、新しい文として続くブロック）が来ると、`lastWord` が
// break/continue/debugger のまま prevSignificant が OPERATOR になっている状態で `{` へ
// 到達する。この 3 語を欠いたままだと素朴な「OPERATOR ならリテラル」判定でオブジェクト
// リテラルと誤分類し、対応する `}` の直後を VALUE（本来は文位置 = OPERATOR であるべき）
// にしてしまう。結果として後続の正規表現リテラル（`}` を含み得る）を除算と誤認し、
// 内部の `}` を早期にブロック終端として数える/正規表現走査自体が未終端エラーになり得る。
const BLOCK_INTRO_KEYWORDS = new Set(['else', 'do', 'break', 'continue', 'debugger'])

// 通常コードの `{` に対応する `}` を通過した直後の走査状態。
// - 'block': ブロック文の終端。直後は文位置（OPERATOR）。
// - 'literal': オブジェクトリテラル/分割代入パターンの終端。直後は式の値（VALUE）。
const BRACE_KIND_BLOCK = 'block'
const BRACE_KIND_LITERAL = 'literal'

// 識別子の先頭・継続文字判定。ASCII の `[A-Za-z_$]` に加え、Unicode の「文字」
// （`\p{L}`）・「文字として扱う数」（`\p{Nl}`。ローマ数字等）を許容する
// （PR #351 codex-review 指摘: `const π = 1` のような非 ASCII 識別子）。
// 先頭文字と継続文字は旧実装（ASCII `[A-Za-z0-9_$]`）と対称に同じ文字集合を使う
// （旧実装は先頭・継続とも同一の正規表現だった）。ASCII 数字を開始文字集合から落とすと
// 数値リテラルの先頭文字が識別子分岐に入らず「その他の記号」分岐に落ち、prevSignificant
// が operator のままになって直後の `/` を正規表現の開始と誤認し得る
// （`isNumberLike` 判定は識別子分岐の内部にしか無く、分岐に入らなければ意味を持たない）。
// 数値リテラル構文自体は ASCII 限定のため `isNumberLike` 判定（`/^[0-9]/`）は変更しない。
const IDENT_START_RE = /[A-Za-z0-9_$\p{L}\p{Nl}\p{Nd}]/u

// 継続文字にのみ許容する追加集合（PR #351 codex-review 指摘、上記コメント項目 11-a）。
// `\p{Mn}`（Nonspacing_Mark）・`\p{Mc}`（Spacing_Mark。結合文字）・U+200C（ZWNJ）・
// U+200D（ZWJ）は ECMAScript の IdentifierPart に含まれるが IdentifierStart には
// 含まれないため、開始文字集合（IDENT_START_RE）には加えず継続文字集合にのみ合成する。
const IDENT_CONT_RE = /[A-Za-z0-9_$\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\u200C\u200D]/u

/**
 * `text[i]` を起点とする 1 コードポイント分の文字列を返す（サロゲートペアなら 2
 * UTF-16 コード単位、それ以外は 1 コード単位）。`text[i]` を直接正規表現テストすると
 * 非 BMP 文字（サロゲートペア）の上位/下位サロゲートが個別にテストされてしまい、
 * いずれの Unicode プロパティにも一致しないため識別子として認識できない
 * （上記コメント項目 11-b 参照）。`i` が `text.length` 以上、または非 UTF-16 データ等で
 * `codePointAt` が `undefined` を返す場合は空文字列を返す（呼び出し側は空文字列を
 * どの文字集合にも一致しないものとして扱えばよい）。
 *
 * @returns {string} 1 コードポイント分の文字列（0〜2 UTF-16 コード単位）。
 */
function readCodePointAt(text, i) {
  const codePoint = text.codePointAt(i)
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint)
}

/**
 * `text[openBraceIndex]` を起点として、対応する閉じ波括弧の index を字句認識つきで求める。
 *
 * @param {string} text 走査対象ソース全体（またはその断片）。
 * @param {number} openBraceIndex `text[openBraceIndex] === '{'` でなければならない。
 * @returns {number} 対応する `}` の index。text の終端まで閉じなければ `-1`。
 * @throws {TypeError} `text[openBraceIndex]` が `{` でない場合。
 * @throws {Error} 未終端の文字列・テンプレートリテラル・ブロックコメント・正規表現リテラルを
 *   検出した場合（構造破壊であり、範囲を返せない `-1` とは区別して呼び出し側に伝える）。
 */
export function findMatchingBraceEnd(text, openBraceIndex) {
  if (text[openBraceIndex] !== '{') {
    throw new TypeError(`openBraceIndex=${openBraceIndex} は '{' を指していない（実際: ${JSON.stringify(text[openBraceIndex])}）`)
  }

  // 通常コードのフレームは種別（'block' か 'literal'）を持つ。走査開始位置の `{` は
  // 呼び出し側が「コードブロックの範囲」を求める用途で使う想定のため 'block' で push する
  // （既存呼び出し元との後方互換: 対応する `}` の直後は常に文位置 = OPERATOR だった）。
  // ternaryDepth はフレーム単位で保持する（三項演算子 `?` の未対応個数）。オブジェクト
  // リテラル・ブロックの `{`/`}` で新しいフレームが push/pop されるたび独立してリセット
  // されるため、`c ? { a: 1 } : {}` のように三項演算子の分岐にオブジェクトリテラルが
  // 入れ子になっても、内側の `key: value` の `:` が外側の三項演算子の対応関係を誤って
  // 消費しない（グローバル 1 変数で数えるとこの誤消費が起こり得る）。
  const stack = [{ type: FRAME_CODE, kind: BRACE_KIND_BLOCK, ternaryDepth: 0 }]
  let i = openBraceIndex + 1

  // 直前の意味のあるトークンの分類。'operator'（値を期待する位置。走査開始直後の
  // 文位置もここに含める）または 'value'（式の値が確定した直後の位置）。
  let prevSignificant = 'operator'
  // `(` の対応関係を追跡するスタック。各要素は対応する `)` が「制御文ヘッダーの終端」
  // なら 'control'、「呼び出し/グループ化の終端（値）」なら 'value'。
  const parenStack = []
  // 直近に読み取った識別子/キーワード（`(` が制御構文キーワード直後かの判定に使う）。
  // 識別子/キーワード以外のトークンを読むたびに null へリセットする。
  let lastWord = null
  // 直前に読み取った意味のあるトークンが `.`（メンバーアクセス演算子）かどうか。
  // true の間に読む次の識別子は「プロパティ/メソッド名」であり、制御構文キーワード・
  // 正規表現先行キーワードの判定対象から除外する（`obj.catch(...)` 等）。
  // 空白・コメントは意味のあるトークンではないため、この状態をまたいで保持する
  // （`obj . catch(` のような書き方でも正しく判定できる）。
  let afterDot = false
  // 直前に読み取った意味のあるトークンが `=>`（アロー関数）かどうか。true の間に読む
  // 次の `{` は常にアロー関数本体のブロックであり、オブジェクトリテラルではない
  // （`() => {}` は常にブロック。リテラルにするには呼び出し元が `() => ({})` と
  // 明示的に括弧で包む必要があり、その場合は `(` を経由するため通常のリテラル判定
  // 経路（prevSignificant === 'operator'）でカバーされる）。
  let afterArrow = false
  // 直前に読み取った意味のあるトークンが「制御文ヘッダーを終端する `)`」かどうか。
  // true の間に読む次の `{` は常にブロック文（`if (c) {` 等）。
  let afterControlParen = false
  // 直前に読み取った意味のあるトークンが「文位置のコロン」（`case`/`default`/ラベル文の
  // `:`。三項演算子の `:` ではない）かどうか。true の間に読む次の `{` は常にブロック文
  // （JS の文法上、文位置の裸 `{` は常にブロック文であり、式としてのオブジェクトリテラルは
  // 文位置には現れ得ないため）。
  let afterStatementColon = false

  while (i < text.length) {
    const ch = text[i]

    // 空白はトークン境界に影響しないため、走査状態を一切更新せず読み飛ばす。
    if (/\s/.test(ch)) {
      i++
      continue
    }

    // 行コメント。次の改行まで読み飛ばす。改行なしで EOF に達しても未終端エラーにはしない
    // （行コメントは改行または EOF のどちらでも正当に終端する）。走査状態は更新しない
    // （コメント前の直前トークンがそのまま「意味のある直前トークン」であり続ける）。
    if (ch === '/' && text[i + 1] === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // ブロックコメント。`*/` まで読み飛ばす。未検出なら未終端として throw。
    // 走査状態は更新しない（`/* c */ /re/` の 2 個目の `/` はコメント直前ではなく
    // コメントより前の直前トークンで判定する）。
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) {
        throw new Error(`未終端のブロックコメント（開始位置 ${i}）`)
      }
      i = end + 2
      continue
    }

    // 文字列リテラル（' または "）。同種クォートまで読み飛ばす。
    // `\` エスケープの消費を改行判定より先に行う: `'foo\` + 改行 + `bar'` は正当な行継続で
    // あり、先に生の改行で throw すると正当な文字列を誤って未終端扱いしてしまう。
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let terminated = false
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2 // エスケープされた1文字（改行含む）を無条件で消費
          continue
        }
        if (text[j] === quote) {
          terminated = true
          j++
          break
        }
        if (text[j] === '\n') break // エスケープされていない生の改行 = 未終端
        j++
      }
      if (!terminated) {
        throw new Error(`未終端の文字列リテラル（開始位置 ${i}）`)
      }
      i = j
      prevSignificant = 'value'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // テンプレートリテラル。開始 `` ` `` の直後から地の文（リテラル部）を読み飛ばし、
    // `${` に遭遇したら 'subst' フレームを push してメインループへ制御を戻す
    // （以降の `{`/`}` は通常のコードとして数えられ、閉じ `}` を pop したら
    // skipTemplateLiteralPart で地の文の読み飛ばしへ戻る）。
    if (ch === '`') {
      i = skipTemplateLiteralPart(text, i + 1, stack)
      prevSignificant = 'value'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // 正規表現リテラル / 除算演算子（コメント判定は上で済んでいるため、ここに来る `/` は
    // コメントではない）。直前の意味のあるトークンが OPERATOR 位置（値を期待する位置）
    // なら正規表現の開始、VALUE 位置（値が確定した直後）なら除算演算子。
    if (ch === '/') {
      if (prevSignificant === 'operator') {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < text.length) {
          if (text[j] === '\\') {
            j += 2
            continue
          }
          if (text[j] === '\n') break // 未終端（正規表現リテラルは改行をまたがない）
          if (text[j] === '[') {
            inClass = true
            j++
            continue
          }
          if (text[j] === ']') {
            inClass = false
            j++
            continue
          }
          if (text[j] === '/' && !inClass) {
            closed = true
            j++
            break
          }
          j++
        }
        if (!closed) {
          throw new Error(`未終端の正規表現リテラル（開始位置 ${i}）`)
        }
        // フラグ文字（例: /re/g の 'g'）は通常のコード文字として扱ってよいため読み飛ばし不要。
        i = j
        prevSignificant = 'value'
        lastWord = null
        afterDot = false
        afterArrow = false
        afterControlParen = false
        afterStatementColon = false
        continue
      }
      // 除算演算子。演算子自身の直後は値を期待する位置に戻る。
      i++
      prevSignificant = 'operator'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // 識別子・キーワード・数値リテラル。旧実装の逆走査（readWordBackward）と同じ文字集合
    // （ASCII 英数字・`_`・`$` に加え、Unicode の文字・文字扱いの数・結合文字・ZWNJ/ZWJ を
    // 許容する IDENT_START_RE/IDENT_CONT_RE。PR #351 codex 指摘の非 ASCII 識別子対応）の
    // 連続を 1 トークンとして前進読み取りする。先頭が数字ならキーワード判定はせず数値
    // リテラル（常に VALUE）として扱う。開始・継続とも `readCodePointAt` でコードポイント
    // 単位に読み取る（上記コメント項目 11-b。UTF-16 コード単位単位のテストでは非 BMP
    // 文字のサロゲートペアを個別にテストしてしまい識別子として認識できないため）。
    const startCp = readCodePointAt(text, i)
    if (IDENT_START_RE.test(startCp)) {
      let j = i + startCp.length
      for (;;) {
        const contCp = readCodePointAt(text, j)
        if (contCp === '' || !IDENT_CONT_RE.test(contCp)) break
        j += contCp.length
      }
      const word = text.slice(i, j)
      const isNumberLike = /^[0-9]/.test(word)
      i = j
      if (afterDot) {
        // `.` 直後の識別子はプロパティ/メソッド名であり、綴りが制御構文キーワード・
        // 正規表現先行キーワードと一致していても文法上の意味は持たない
        // （`obj.catch(...)`・`obj.if(...)`・`arr.with(...)` 等）。常に VALUE として扱い、
        // `lastWord` も設定しない（後続の `(` が制御構文と誤認されないようにするため）。
        prevSignificant = 'value'
        lastWord = null
      } else if (lastWord === 'for' && word === 'await') {
        // `for await (const x of xs)` の特別扱い（PR #351 codex 指摘）。`await` 自体は
        // CONTROL_KEYWORDS に含まれないため、`lastWord` をそのまま `await` に更新すると
        // 続く `(` の isControl 判定で `for` が見えなくなる。直前語が `for`（かつ afterDot
        // でない = メンバーアクセス経由ではない）のときに限り `lastWord` を `for` のまま
        // 保持し、`for await (` 全体を `for (` と同様に制御文ヘッダーとして扱う。
        prevSignificant = 'operator'
        // lastWord は 'for' のまま変更しない。
      } else if (!isNumberLike && REGEX_PRECEDING_KEYWORDS.has(word)) {
        prevSignificant = 'operator'
        lastWord = word
      } else {
        prevSignificant = 'value'
        lastWord = isNumberLike ? null : word
      }
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    if (ch === '(') {
      const isControl = lastWord !== null && CONTROL_KEYWORDS.has(lastWord)
      parenStack.push(isControl ? 'control' : 'value')
      i++
      prevSignificant = 'operator' // 括弧の中は値を期待する位置から始まる
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    if (ch === ')') {
      const kind = parenStack.length > 0 ? parenStack.pop() : 'value'
      i++
      // 制御文ヘッダーの終端なら文位置（OPERATOR）、呼び出し/グループ化の終端なら値（VALUE）。
      prevSignificant = kind === 'control' ? 'operator' : 'value'
      lastWord = null
      afterDot = false
      afterArrow = false
      // 直後の `{` がブロック文かどうかの判定に使う。`if (c) {` のように制御文ヘッダーを
      // 終端した直後の `{` は常にブロック（`lastWord` は既に null にリセット済みで
      // 判定に使えないため、この専用フラグで引き継ぐ）。
      afterControlParen = kind === 'control'
      afterStatementColon = false
      continue
    }

    if (ch === '[') {
      i++
      prevSignificant = 'operator' // 添字/配列リテラルの中は値を期待する位置
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    if (ch === ']') {
      i++
      prevSignificant = 'value' // 添字アクセス・配列リテラルの結果は値
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // 前置/後置の `++` / `--`。直前が VALUE なら後置（結果は依然 VALUE）、
    // そうでなければ前置（オペランドはこの後に続くため依然 OPERATOR）。
    if ((ch === '+' && text[i + 1] === '+') || (ch === '-' && text[i + 1] === '-')) {
      i += 2
      prevSignificant = prevSignificant === 'value' ? 'value' : 'operator'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // メンバーアクセス演算子 `.`。次に読む識別子がプロパティ/メソッド名であることを
    // 覚えておく（`afterDot`）。数値リテラルの小数点（`1.5`）は数字読み取り分岐が
    // 先に `[A-Za-z0-9_$]` にマッチしないため通常ここには来ない点に注意
    // （整数部読み取り後にここへ来ても、次が数字なら isNumberLike 判定は識別子分岐側の
    // 話であり、`afterDot` はプロパティ名判定にのみ使うため小数点でも実害はない）。
    if (ch === '.') {
      i++
      prevSignificant = 'operator' // プロパティ名という値を期待する位置
      lastWord = null
      afterDot = true
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // アロー関数 `=>`。直後の `{` が常にアロー関数本体のブロックであることを覚えておく。
    if (ch === '=' && text[i + 1] === '>') {
      i += 2
      prevSignificant = 'operator' // 本体（式 or ブロック）という値を期待する位置
      lastWord = null
      afterDot = false
      afterArrow = true
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    if (ch === '{') {
      // オブジェクトリテラル/分割代入パターンか、ブロック文かを判定する。
      // 優先順位: 1) 制御文ヘッダー直後 → ブロック、2) アロー関数直後 → ブロック、
      // 3) `else`/`do`/`break`/`continue`/`debugger` 直後 → ブロック（これらは
      // REGEX_PRECEDING_KEYWORDS にも含まれ prevSignificant が OPERATOR になるため
      // 4) より先に判定する必要がある。break/continue/debugger は ASI で文が終端し
      // 得るため、直後に改行だけを挟んで続く裸 `{` は新しい文のブロックであり得る。
      // PR #351 Cursor Bugbot 指摘）、
      // 4) 文位置のコロン（`case`/`default`/ラベル文の `:`）直後 → ブロック（JS の文法上、
      // 文位置の裸 `{` は常にブロック文であり、式としてのオブジェクトリテラルは文位置には
      // 現れ得ないため。三項演算子の `:` はこの分岐に来ない — 下記 `:` 分岐参照）、
      // 5) 値を期待する位置（OPERATOR。`=` `,` `(` `[` `return` `?`/三項演算子の `:` 等の
      // 直後）→ オブジェクトリテラル、6) それ以外（VALUE。`function foo() {` の `)` 直後や
      // 識別子直後などの文位置）→ ブロック（安全側のデフォルト）。
      const kind =
        afterControlParen ||
        afterArrow ||
        afterStatementColon ||
        (lastWord !== null && BLOCK_INTRO_KEYWORDS.has(lastWord))
          ? BRACE_KIND_BLOCK
          : prevSignificant === 'operator'
            ? BRACE_KIND_LITERAL
            : BRACE_KIND_BLOCK
      stack.push({ type: FRAME_CODE, kind, ternaryDepth: 0 })
      i++
      prevSignificant = 'operator' // ブロック/オブジェクトリテラルの中は値を期待する位置
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    if (ch === '}') {
      const popped = stack.pop()
      if (popped.type === FRAME_SUBST) {
        // テンプレートの式展開ブロックを閉じただけ。テンプレート走査へ戻る必要があるが、
        // ここでは深さを追っているだけなので、次の文字からメインループを継続すれば
        // 次の '`' 判定で自然にテンプレート本体（リテラル部）の走査に戻る。
        // ただし現在地点は依然としてテンプレートのリテラル部の途中であり、`` ` `` 分岐の
        // 外側にいる。そのためテンプレートのリテラル部を専用に読み飛ばす必要がある。
        i++
        i = skipTemplateLiteralPart(text, i, stack)
        prevSignificant = 'value'
        lastWord = null
        afterDot = false
        afterArrow = false
        afterControlParen = false
        afterStatementColon = false
        continue
      }
      if (stack.length === 0) {
        return i
      }
      i++
      // ブロック文の終端なら文位置（OPERATOR）、オブジェクトリテラル/分割代入パターンの
      // 終端なら式の値（VALUE）。
      prevSignificant = popped.kind === BRACE_KIND_LITERAL ? 'value' : 'operator'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // nullish 合体 `??`・nullish 代入 `??=`。三項演算子ではないため深さを増やさない。
    // 2 文字トークンをここで丸ごと消費することが必須: 1 文字先読みで `?` 単体の分岐へ
    // 進ませてしまうと、走査が 1 個目の '?' を「三項演算子ではない」と判定してスキップ
    // した次のループで 2 個目の '?' に到達し、その時点の 1 文字先読み（隣が空白等）では
    // `?.`/`??` に該当しないため誤って ternaryDepth を増やしてしまう
    // （`a ?? b` の 2 個目の '?' がこの誤判定の対象になり得る）。
    if (ch === '?' && text[i + 1] === '?') {
      i += text[i + 2] === '=' ? 3 : 2
      prevSignificant = 'operator'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // 三項演算子 `?`。オプショナルチェイニング `?.` は三項演算子ではないため深さを
    // 増やさない（`a?.b` を誤カウントしない）。`??`/`??=` は上の分岐で既に消費済みの
    // ためここには来ない。現在のフレーム（stack の最上段。code フレーム・subst フレーム
    // いずれも ternaryDepth を持つ）の深さを増やすことで、対応する `:` をこのフレーム内で
    // 独立して数える（フレーム跨ぎで消費されないようにする。上記コメント項目 9 参照）。
    if (ch === '?' && text[i + 1] !== '.') {
      stack[stack.length - 1].ternaryDepth++
      i++
      prevSignificant = 'operator' // 三項演算子の then 節という値を期待する位置
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = false
      continue
    }

    // コロン `:`。現在のフレームに未対応の `?` が残っていれば（ternaryDepth > 0）三項
    // 演算子の else 節を導くコロンであり、対応する `?` を 1 個消費する（式位置のまま。
    // 直後の `{` は通常どおり prevSignificant === 'operator' を根拠に判定される）。
    // 残っていなければ、オブジェクトリテラルの `key: value` かどうかをフレーム種別で
    // 判定する: 現在のフレームが code フレームかつ種別が BLOCK（＝オブジェクトリテラル/
    // 分割代入パターンの内部ではなく文位置にいる）なら、このコロンは `case`/`default`/
    // ラベル文の文位置コロンであり、直後の `{` は常にブロック文として扱う
    // （`afterStatementColon` で引き継ぐ。上記コメント項目 9 参照）。
    // それ以外（LITERAL フレーム内の key: value・subst フレーム直下等）は通常どおり
    // 「値を期待する位置」として扱う（既存の素朴な OPERATOR 判定と同じ挙動を維持）。
    if (ch === ':') {
      const frame = stack[stack.length - 1]
      let isStatementColon = false
      if (frame.ternaryDepth > 0) {
        frame.ternaryDepth--
      } else if (frame.type === FRAME_CODE && frame.kind === BRACE_KIND_BLOCK) {
        isStatementColon = true
      }
      i++
      prevSignificant = 'operator'
      lastWord = null
      afterDot = false
      afterArrow = false
      afterControlParen = false
      afterStatementColon = isStatementColon
      continue
    }

    // 上記以外の記号（二項演算子 `+ - * % < > 等`、`, ; = ! & | ~ ^` 等）。
    // いずれも直後に値を期待する OPERATOR 位置として扱う。
    i++
    prevSignificant = 'operator'
    lastWord = null
    afterDot = false
    afterArrow = false
    afterControlParen = false
    afterStatementColon = false
  }

  return -1
}

/**
 * `${...}` の式展開ブロックを閉じた直後、次の `` ` `` または次の `${` に達するまで
 * テンプレートのリテラル部（バッククォートで囲まれた地の文）を読み飛ばす。
 * 地の文中の `{` `}` は字句上ただの文字であり、深さに影響してはならない
 * （Issue #336 が固定する不変条件の中心）。
 *
 * @returns 次に処理すべき index。呼び出し元のメインループへ制御を返す。
 */
function skipTemplateLiteralPart(text, i, stack) {
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === '`') {
      return i + 1 // テンプレート全体の終端。stack は subst pop 済みで code フレームへ復帰。
    }
    if (text[i] === '$' && text[i + 1] === '{') {
      // subst フレームにも ternaryDepth を持たせる（`${a ? b : c}` のように `${...}` 直下に
      // 三項演算子が現れ得るため。code フレームと同様に独立してカウントする必要がある）。
      stack.push({ type: FRAME_SUBST, ternaryDepth: 0 })
      return i + 2 // 次の式展開ブロックへ。メインループが '{'/'}' を通常どおり数える。
    }
    if (text[i] === '\n') {
      i++
      continue // テンプレートは複数行を許すため改行では未終端にしない
    }
    i++
  }
  throw new Error('未終端のテンプレートリテラル')
}

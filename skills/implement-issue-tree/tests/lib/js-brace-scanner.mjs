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
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
])

// 開き `(` の直前語がこれらの制御構文キーワードのとき、対応する閉じ `)` は
// 「制御文ヘッダーの終端」（例: `if (cond)` の後は文位置 = OPERATOR 状態）であり、
// `foo(...)` のような呼び出し/グループ化の閉じ `)`（結果は式の値 = VALUE 状態）とは
// 区別しなければならない。両者は直前 1 文字だけを見る旧実装では区別不能だった。
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch'])

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

  const stack = [FRAME_CODE]
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
        continue
      }
      // 除算演算子。演算子自身の直後は値を期待する位置に戻る。
      i++
      prevSignificant = 'operator'
      lastWord = null
      continue
    }

    // 識別子・キーワード・数値リテラル。旧実装の逆走査（readWordBackward）と同じ文字集合
    // `[A-Za-z0-9_$]` の連続を 1 トークンとして前進読み取りする。先頭が数字ならキーワード
    // 判定はせず数値リテラル（常に VALUE）として扱う。
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++
      const word = text.slice(i, j)
      const isNumberLike = /^[0-9]/.test(word)
      i = j
      if (!isNumberLike && REGEX_PRECEDING_KEYWORDS.has(word)) {
        prevSignificant = 'operator'
        lastWord = word
      } else {
        prevSignificant = 'value'
        lastWord = isNumberLike ? null : word
      }
      continue
    }

    if (ch === '(') {
      const isControl = lastWord !== null && CONTROL_KEYWORDS.has(lastWord)
      parenStack.push(isControl ? 'control' : 'value')
      i++
      prevSignificant = 'operator' // 括弧の中は値を期待する位置から始まる
      lastWord = null
      continue
    }

    if (ch === ')') {
      const kind = parenStack.length > 0 ? parenStack.pop() : 'value'
      i++
      // 制御文ヘッダーの終端なら文位置（OPERATOR）、呼び出し/グループ化の終端なら値（VALUE）。
      prevSignificant = kind === 'control' ? 'operator' : 'value'
      lastWord = null
      continue
    }

    if (ch === '[') {
      i++
      prevSignificant = 'operator' // 添字/配列リテラルの中は値を期待する位置
      lastWord = null
      continue
    }

    if (ch === ']') {
      i++
      prevSignificant = 'value' // 添字アクセス・配列リテラルの結果は値
      lastWord = null
      continue
    }

    // 前置/後置の `++` / `--`。直前が VALUE なら後置（結果は依然 VALUE）、
    // そうでなければ前置（オペランドはこの後に続くため依然 OPERATOR）。
    if ((ch === '+' && text[i + 1] === '+') || (ch === '-' && text[i + 1] === '-')) {
      i += 2
      prevSignificant = prevSignificant === 'value' ? 'value' : 'operator'
      lastWord = null
      continue
    }

    if (ch === '{') {
      stack.push(FRAME_CODE)
      i++
      prevSignificant = 'operator' // ブロック/オブジェクトリテラルの中は値を期待する位置
      lastWord = null
      continue
    }

    if (ch === '}') {
      const popped = stack.pop()
      if (popped === FRAME_SUBST) {
        // テンプレートの式展開ブロックを閉じただけ。テンプレート走査へ戻る必要があるが、
        // ここでは深さを追っているだけなので、次の文字からメインループを継続すれば
        // 次の '`' 判定で自然にテンプレート本体（リテラル部）の走査に戻る。
        // ただし現在地点は依然としてテンプレートのリテラル部の途中であり、`` ` `` 分岐の
        // 外側にいる。そのためテンプレートのリテラル部を専用に読み飛ばす必要がある。
        i++
        i = skipTemplateLiteralPart(text, i, stack)
        prevSignificant = 'value'
        lastWord = null
        continue
      }
      if (stack.length === 0) {
        return i
      }
      i++
      prevSignificant = 'operator' // コードブロックを閉じた直後は文位置
      lastWord = null
      continue
    }

    // 上記以外の記号（二項演算子 `+ - * % < > 等`、`, ; : = ! & | ? ~ ^ .` 等）。
    // いずれも直後に値を期待する OPERATOR 位置として扱う。
    i++
    prevSignificant = 'operator'
    lastWord = null
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
      stack.push(FRAME_SUBST)
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

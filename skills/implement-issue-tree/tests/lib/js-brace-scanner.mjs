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

// 正規表現リテラルの直前に来ると「正規表現」側と判定する予約語。
// これらの直後の `/` は除算ではなく正規表現の開始（例: `return /}/.test(s)`）。
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
])

// 正規表現リテラルの直前に来ると「正規表現」側と判定する記号（列挙した文字そのもの、または
// 走査開始位置）。除算のオペランド（識別子・数値・`)`・`]`・文字列/テンプレート終端）の後は
// 除算側と判定する。
const REGEX_PRECEDING_PUNCTUATION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '~', '^', '<', '>',
])

/**
 * text[i] から始まる識別子/キーワードトークンを後方に読み取る（直前トークン判定用）。
 * text[i] が識別子構成文字でなければ null を返す。
 */
function readWordBackward(text, i) {
  let end = i
  while (end >= 0 && /[A-Za-z0-9_$]/.test(text[end])) end--
  if (end === i) return null
  return text.slice(end + 1, i + 1)
}

/**
 * `/` の直前の有意トークン（空白を除く）から、この `/` が正規表現リテラルの開始か
 * 除算演算子かを判定する。コメント開始判定（`//` `/*`）は呼び出し側で先に済ませてある前提。
 */
function isRegexContext(text, slashIndex) {
  let i = slashIndex - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i < 0) return true // 走査開始位置（先頭）は正規表現側
  const ch = text[i]
  const word = readWordBackward(text, i)
  if (word !== null) {
    // 識別子・数値の直後は原則除算。ただし正規表現前置キーワードは例外。
    return REGEX_PRECEDING_KEYWORDS.has(word)
  }
  if (ch === ')' || ch === ']') return false // 除算のオペランド
  if (REGEX_PRECEDING_PUNCTUATION.has(ch)) return true
  // 上記以外（未知の記号）は安全側として除算に倒す。
  return false
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

  const stack = [FRAME_CODE]
  let i = openBraceIndex + 1

  while (i < text.length) {
    const ch = text[i]

    // 行コメント。次の改行まで読み飛ばす。改行なしで EOF に達しても未終端エラーにはしない
    // （行コメントは改行または EOF のどちらでも正当に終端する）。
    if (ch === '/' && text[i + 1] === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // ブロックコメント。`*/` まで読み飛ばす。未検出なら未終端として throw。
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
      continue
    }

    // テンプレートリテラル。開始 `` ` `` の直後から地の文（リテラル部）を読み飛ばし、
    // `${` に遭遇したら 'subst' フレームを push してメインループへ制御を戻す
    // （以降の `{`/`}` は通常のコードとして数えられ、閉じ `}` を pop したら
    // skipTemplateLiteralPart で地の文の読み飛ばしへ戻る）。
    if (ch === '`') {
      i = skipTemplateLiteralPart(text, i + 1, stack)
      continue
    }

    // 正規表現リテラル（コメント判定は上で済んでいるため、ここに来る `/` はコメントではない）。
    if (ch === '/' && isRegexContext(text, i)) {
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
      continue
    }

    if (ch === '{') {
      stack.push(FRAME_CODE)
      i++
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
        continue
      }
      if (stack.length === 0) {
        return i
      }
      i++
      continue
    }

    i++
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

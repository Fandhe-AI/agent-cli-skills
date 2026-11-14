#!/usr/bin/env node
// opencode.jsonc へ、このスキルが配る deny 規則だけを追補するマージスクリプト。
// update-opencode が対象リポジトリで実行する（node 単体・依存パッケージ無し）。
//
//   node opencode-config-merge.mjs --target <設定ファイル> --template <assets/opencode/opencode.jsonc> [--check]
//
// 境界: 対象リポジトリの設定ファイルのうち、`permissions` / `policies` 配列の末尾への追加
// だけを担う。それ以外のキー・利用者が足した規則・配列内の順序は一切変えない。
//
// 識別規則: template の `permissions` / `policies` の各要素（オブジェクト）を「自分の規則」とし、
// 「キー順に依らない深い等価」で照合する。自分の規則が既存とみなされるのは、target の同じ配列で
// 「自分の規則以外の全要素より後ろ」に等価な要素があるときだけ（= 最後の利用者の規則より後ろ）。
// 利用者の規則（包括的な allow 等）が自分の deny の後ろにあれば、その deny は効かないため不足
// 扱いにして、配列の末尾へ template の順で再追加する（同じ規則が前にも残る重複は許容。末尾の
// 1 件が効く）。既存の要素は位置を動かさず削除もしない。
//
// 末尾に置く理由: OpenCode の permissions / policies は「最後に一致した規則が勝つ」。利用者が
// 後から足した allow が、自分の deny に勝ってしまわないよう、deny は必ず末尾にする。
//
// コメント付き・末尾カンマ付きのファイルを自動編集しない理由: JSON.parse で読んで書き戻すと
// コメントが消える。書き戻しをやめて、追加すべき規則を JSON で stdout へ出し、利用者に手で
// 貼らせる（needs-manual）。実機では OpenCode は未知キーを黙って捨てるため、壊れた設定は
// 気づかれない。壊すくらいなら止める。
//
// 結果語彙（最後の 1 行 `OPENCODE_CONFIG_MERGE_RESULT <語彙>`）と終了コード:
//   created                 0  target が無く、template をそのまま作成した
//   merged                  0  不足していた規則を末尾へ追加して書いた
//   unchanged               0  追加すべき規則が無い（書かない・mtime も不変）
//   needs-manual            3  コメント / 末尾カンマがあり不足規則あり。書かず JSON を stdout へ
//   error-usage             2  引数の誤り
//   error-invalid-json      1  target または template が JSON として読めない
//   error-not-array         1  permissions / policies が配列でない（template 側を含む）
//   error-not-object        1  JSON の最上位がオブジェクトでない
//   error-symlink           1  target が symlink（リンク先を書き換えない）
//   error-not-file          1  target が通常ファイルでない
//   error-io                1  読み書きの失敗
//   error-changed           1  読み込んだあとに target が書き換えられた（target が無いと見て作る間に他者が
//                              作った場合を含む）。他者の更新を上書きしないため書かずに止める。置換
//                              （rename）の直前に target を読み直して読み込んだ内容と比べる。比べてから
//                              rename までの短い間は排他しない。再実行すれば最新の内容から作り直す
// 親ディレクトリがシンボリックリンクのときは、リンク先の実体のディレクトリへ書くことを stderr に警告する
// （止めない。target 自体の symlink は error-symlink）。`--` 始まりの値は引数として受け付けない
// （error-usage）。このスクリプトはシェルのコマンドへパスを渡さず fs API だけを使うため、`-` 始まりの
// 相対パスがオプションとして解釈されることは無い。一時ファイルは置換の直前に作り、失敗時は消す。
// SIGKILL は捕捉できないが、作ってから rename までは同期処理で数ミリ秒のため、残り得る
// `.<名前>.tmp-*` は人が消す（target は無傷）。
// `--check` は書かずに同じ語彙（created / merged は「そうなる」意味）と終了コードを返す。
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const RESULT = 'OPENCODE_CONFIG_MERGE_RESULT'
const KEYS = ['permissions', 'policies']
const EXIT = { 'needs-manual': 3, 'error-usage': 2 }

function finish(word) {
  console.log(`${RESULT} ${word}`)
  process.exit(word in EXIT ? EXIT[word] : word.startsWith('error-') ? 1 : 0)
}

function fail(word, msg) {
  console.error(msg)
  finish(word)
}

// 文字列リテラルの外にあるコメントと末尾カンマを走査して除去した本文を返す。
// hasComment / hasTrailingComma は「元の本文にあったか」の検出結果（自動編集を止める判断に使う）。
// 文字列内の `//`（例: $schema の URL）や `,}` は対象外。
export function stripJsonc(text) {
  let out = ''
  let hasComment = false
  let hasTrailingComma = false
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && text[i + 1] === '/') {
      hasComment = true
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      hasComment = true
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
      continue
    }
    out += c
  }
  // コメント除去後の本文で、`,` の次の非空白が `}` / `]` なら末尾カンマ。文字列は飛ばして数える。
  let res = ''
  inStr = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inStr) {
      res += c
      if (c === '\\') res += out[++i] ?? ''
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; res += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') { hasTrailingComma = true; continue }
    }
    res += c
  }
  return { text: res, hasComment, hasTrailingComma }
}

// キー順に依らない深い等価。規則の同一性判定（識別規則）の実体。
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

// target の各配列に対して不足している自分の規則を { permissions: [...], policies: [...] } で返す。
// 配列でないものは null を返して呼び出し側に型エラーとして扱わせる。
export function missingRules(targetObj, templateObj) {
  const missing = {}
  for (const key of KEYS) {
    const own = templateObj[key]
    if (own === undefined) { missing[key] = []; continue }
    if (!Array.isArray(own)) return { error: `template の ${key} が配列でない` }
    const current = targetObj[key]
    if (current !== undefined && !Array.isArray(current)) return { error: `target の ${key} が配列でない` }
    const cur = current ?? []
    // 自分の規則以外の最後の要素の位置。これより後ろにある自分の規則だけが、利用者の規則に負けない。
    let lastForeign = -1
    cur.forEach((r, i) => { if (!own.some((rule) => deepEqual(r, rule))) lastForeign = i })
    missing[key] = own.filter((rule) => !cur.some((r, i) => i > lastForeign && deepEqual(r, rule)))
  }
  return { missing }
}

function parseArgs(argv) {
  const a = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--check') a.check = true
    else if (v === '--target' || v === '--template') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return null
      a[v.slice(2)] = argv[++i]
    } else return null
  }
  return a.target && a.template ? a : null
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) fail('error-usage', '使い方: node opencode-config-merge.mjs --target <設定ファイル> --template <opencode.jsonc> [--check]')
  const target = resolve(args.target)

  let templateRaw
  try { templateRaw = readFileSync(args.template, 'utf8') } catch (e) { fail('error-io', `template を読めない: ${e.code ?? e.message}`) }
  let templateObj
  try { templateObj = JSON.parse(stripJsonc(templateRaw).text) } catch { fail('error-invalid-json', 'template が JSON として読めない') }
  if (typeof templateObj !== 'object' || templateObj === null || Array.isArray(templateObj)) fail('error-not-object', 'template の最上位がオブジェクトでない')
  for (const key of KEYS) {
    if (templateObj[key] !== undefined && !Array.isArray(templateObj[key])) fail('error-not-array', `template の ${key} が配列でない`)
  }

  let st = null
  try { st = lstatSync(target) } catch (e) { if (e.code !== 'ENOENT') fail('error-io', `target を調べられない: ${e.code}`) }

  warnSymlinkParent(target)

  if (st === null) {
    if (!args.check) {
      mkdirSync(dirname(target), { recursive: true })
      atomicWrite(target, templateRaw.endsWith('\n') ? templateRaw : `${templateRaw}\n`, 0o644, null)
    }
    finish('created')
  }
  if (st.isSymbolicLink()) fail('error-symlink', 'target が symlink。リンク先を書き換えないため中止')
  if (!st.isFile()) fail('error-not-file', 'target が通常ファイルでない')

  let raw
  try { raw = readFileSync(target, 'utf8') } catch (e) { fail('error-io', `target を読めない: ${e.code}`) }
  const stripped = stripJsonc(raw)
  let obj
  try { obj = JSON.parse(stripped.text) } catch { fail('error-invalid-json', 'target が JSON として読めない') }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) fail('error-not-object', 'target の最上位がオブジェクトでない')

  const r = missingRules(obj, templateObj)
  if (r.error) fail('error-not-array', r.error)
  const total = KEYS.reduce((n, k) => n + r.missing[k].length, 0)
  if (total === 0) finish('unchanged')

  if (stripped.hasComment || stripped.hasTrailingComma) {
    // 自動編集するとコメントを失う。追加すべき規則だけを出して人手に委ねる。
    const out = {}
    for (const k of KEYS) if (r.missing[k].length > 0) out[k] = r.missing[k]
    console.log(JSON.stringify(out, null, 2))
    finish('needs-manual')
  }

  for (const k of KEYS) if (r.missing[k].length > 0) obj[k] = [...(obj[k] ?? []), ...r.missing[k]]
  if (!args.check) atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`, st.mode & 0o777, raw)
  finish('merged')
}

// target の親ディレクトリがシンボリックリンクなら、実体のディレクトリへ書くことを警告する。
function warnSymlinkParent(target) {
  const parent = dirname(target)
  try {
    if (lstatSync(parent).isSymbolicLink()) console.error(`警告: target の親ディレクトリ（${parent}）はシンボリックリンク。リンク先の実体のディレクトリへ書く`)
  } catch { /* 親が無いときは後続の mkdir・読み込みが扱う */ }
}

// 同一ディレクトリの一時ファイルへ書いてから rename する。途中で失敗しても target は
// 元のまま（半端なファイルを残さない）。original は読み込んだときの target の内容で、rename の直前に
// target を読み直して一致を確かめる（他者の更新を上書きしない）。null は「target が無い」の意味。
function atomicWrite(path, content, mode, original) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode })
    chmodSync(tmp, mode)
    if (!unchangedSince(path, original)) {
      try { unlinkSync(tmp) } catch { /* 消せなくても下の fail で止める */ }
      fail('error-changed', '読み込んだあとに target が書き換えられた。他の更新を上書きしないため書かない（再実行する）')
    }
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 作れていなければ消すものは無い */ }
    fail('error-io', `書き込みに失敗: ${e.code ?? e.message}`)
  }
}

// 置換の直前の確認。original が null なら target がまだ無いこと、文字列ならその内容のままであること。
function unchangedSince(path, original) {
  if (original === null) {
    try { lstatSync(path) } catch (e) { return e.code === 'ENOENT' }
    return false
  }
  try { return readFileSync(path, 'utf8') === original } catch { return false }
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

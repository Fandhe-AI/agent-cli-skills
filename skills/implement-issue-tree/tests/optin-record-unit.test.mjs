// scripts/lib/optin-record-lib.sh（observe-pr.sh の optin-record モードの判定だけの純関数）を、表で単体検査する回帰テスト（Issue #603）。
//
// 宣言コマンドの許可形（optin_cmd_valid）、本文の正規化（CRLF・行頭行末の空白）、マーカー行の件数（sha・結果・コマンドの完全一致。
// 古い sha・別コマンド・接頭辞だけ一致する行は数えない）を、git・gh を呼ばずに 1 回の bash 起動で表の全ケースに当てる。
// 利用できる bash（macOS の 3.2 と Homebrew の 5 など）をすべて回す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'optin-record-lib.sh')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const marker = (sha, result, cmd) => `<!-- optin-test-record: ${sha} ${result} ${cmd} -->`

// 入力は 1 行 1 ケース（種別 TAB 引数…）。引数は \\ \n \r \t の綴りへ直して渡し、ドライバが printf %b で戻す。出力は 1 行 1 ケースの `<rc> [<出力>]`
const DRIVER = `
set -u
LC_ALL=C
export LC_ALL
. "$1" || exit 9
TAB=$(printf '\\t')
unesc() { [ "$1" = @empty ] || printf '%b' "$1"; }
while IFS="$TAB" read -r kind a b c d; do
  rc=0
  out=""
  case "$kind" in
    valid) optin_cmd_valid "$(unesc "$a")" || rc=$? ;;
    norm) out=$(unesc "$a" | optin_record_normalize | tr '\\n\\r\\t' '|CT') || rc=$? ;;
    count) body=$(unesc "$a" | optin_record_normalize); out=$(optin_record_count "$body" "$b" "$c" "$d") || rc=$? ;;
    counts) body=$(unesc "$a" | optin_record_normalize); out=$(optin_record_counts "$body" "$b" "$c") || rc=$? ;;
  esac
  printf '%s [%s]\\n' "$rc" "$out"
done
`
// 空文字は TAB 区切りの read が欄を詰めてしまうので @empty の綴りで渡す
const enc = (s) => s === '' ? '@empty' : s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')

// [名前, 種別, 引数の配列, 期待 rc, 期待出力]
const CASES = [
  // optin_cmd_valid（ホストの OPTIN_TEST_COMMAND_RE と同じ形）
  ['許可形: make e2e', 'valid', ['make e2e'], 0, ''],
  ['許可形: 記号 _./:=@+,-', 'valid', ['cargo test -p a_b --features x=1,y -- --ignored'], 0, ''],
  ['200 文字は許可', 'valid', ['a'.repeat(200)], 0, ''],
  ['201 文字は拒否', 'valid', ['a'.repeat(201)], 1, ''],
  ['空は拒否', 'valid', [''], 1, ''],
  ['先頭が記号は拒否', 'valid', ['-x'], 1, ''],
  ['先頭が空白は拒否', 'valid', [' make'], 1, ''],
  ['単一引用符は拒否', 'valid', ["make 'x'"], 1, ''],
  ['二重引用符は拒否', 'valid', ['make "x"'], 1, ''],
  ['$ は拒否', 'valid', ['make $(x)'], 1, ''],
  ['バッククォートは拒否', 'valid', ['make `x`'], 1, ''],
  ['バックスラッシュは拒否', 'valid', ['make a\\b'], 1, ''],
  ['セミコロン・パイプ・& は拒否', 'valid', ['make a;b'], 1, ''],
  ['改行を含むと拒否（grep -F のパターンが複数行に化ける）', 'valid', ['make a\nmake b'], 1, ''],
  ['CR を含むと拒否', 'valid', ['make a\rb'], 1, ''],
  ['TAB を含むと拒否', 'valid', ['make a\tb'], 1, ''],
  ['非 ASCII は拒否', 'valid', ['make テスト'], 1, ''],
  ['グロブ文字 * ? [ は拒否', 'valid', ['make *'], 1, ''],
  // optin_record_normalize
  ['正規化: CRLF の CR を落とす', 'norm', ['a\r\nb\r\n'], 0, 'a|b|'],
  ['正規化: 行の途中の CR も落とす（sed の空白除去は行頭・行末だけなので tr が要る）', 'norm', ['a\rb\r\n'], 0, 'ab|'],
  ['正規化: 行頭・行末の空白と TAB を落とす', 'norm', ['  a b \t\n\t c\n'], 0, 'a b|c|'],
  // optin_record_count（行全体の固定文字列一致）
  ['pass 行 1 件', 'count', [marker(SHA_A, 'pass', 'make e2e'), SHA_A, 'pass', 'make e2e'], 0, '1'],
  ['行頭の空白・CRLF 付きでも数える', 'count', [`   ${marker(SHA_A, 'pass', 'make e2e')}\r\n`, SHA_A, 'pass', 'make e2e'], 0, '1'],
  ['同じ行が 2 件なら 2', 'count', [`${marker(SHA_A, 'pass', 'make e2e')}\n${marker(SHA_A, 'pass', 'make e2e')}`, SHA_A, 'pass', 'make e2e'], 0, '2'],
  ['別の sha の行は数えない（古い HEAD の記録）', 'count', [marker(SHA_A, 'pass', 'make e2e'), SHA_B, 'pass', 'make e2e'], 0, '0'],
  ['別のコマンドの行は数えない', 'count', [marker(SHA_A, 'pass', 'make other'), SHA_A, 'pass', 'make e2e'], 0, '0'],
  ['コマンドが前方一致するだけの行は数えない', 'count', [marker(SHA_A, 'pass', 'make e2e-extra'), SHA_A, 'pass', 'make e2e'], 0, '0'],
  ['コマンドが後方一致するだけの行は数えない', 'count', [marker(SHA_A, 'pass', 'x make e2e'), SHA_A, 'pass', 'make e2e'], 0, '0'],
  ['行の途中に埋め込まれたマーカーは数えない（行全体の一致）', 'count', [`text ${marker(SHA_A, 'pass', 'make e2e')} tail`, SHA_A, 'pass', 'make e2e'], 0, '0'],
  ['結果の語が違う行は数えない', 'count', [marker(SHA_A, 'fail', 'make e2e'), SHA_A, 'pass', 'make e2e'], 0, '0'],
  ['正規表現の記号を含むコマンドも固定文字列として扱う（. は任意の 1 文字ではない）', 'count', [marker(SHA_A, 'pass', 'make aXb'), SHA_A, 'pass', 'make a.b'], 0, '0'],
  ['本文が空なら 0', 'count', ['', SHA_A, 'pass', 'make e2e'], 0, '0'],
  // optin_record_counts（pass と pass 以外 = fail + not-run）
  ['pass 1・pass 以外 0', 'counts', [marker(SHA_A, 'pass', 'make e2e'), SHA_A, 'make e2e'], 0, '1 0'],
  ['pass 1・fail 1 は pass 以外 1', 'counts', [`${marker(SHA_A, 'pass', 'make e2e')}\n${marker(SHA_A, 'fail', 'make e2e')}`, SHA_A, 'make e2e'], 0, '1 1'],
  ['fail と not-run は pass 以外へ合算', 'counts', [`${marker(SHA_A, 'fail', 'make e2e')}\n${marker(SHA_A, 'not-run', 'make e2e')}`, SHA_A, 'make e2e'], 0, '0 2'],
  ['新旧 2 つの sha が併存しても現在の sha の分だけ', 'counts', [`${marker(SHA_A, 'pass', 'make e2e')}\n${marker(SHA_B, 'fail', 'make e2e')}`, SHA_B, 'make e2e'], 0, '0 1'],
  ['記録なしは 0 0', 'counts', ['ただの本文', SHA_A, 'make e2e'], 0, '0 0'],
]

for (const bash of availableBashes()) {
  test(`[${bash}] optin-record-lib: 許可形・正規化・マーカー行の件数を表で検査する`, () => {
    const lines = CASES.map(([, kind, args]) => [kind, ...args.map(enc)].join('\t')).join('\n') + '\n'
    const r = spawnSync(bash, ['-c', DRIVER, 'driver', LIB], { input: lines, encoding: 'utf8' })
    assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
    const out = r.stdout.split('\n').filter((l) => l !== '')
    assert.equal(out.length, CASES.length, r.stdout)
    CASES.forEach(([name, , , rc, expected], i) => {
      assert.equal(out[i], `${rc} [${expected}]`, name)
    })
  })

  test(`[${bash}] optin-record-lib: 二重 source は無害で、関数以外の状態を壊さない`, () => {
    const r = spawnSync(bash, ['-c', '. "$1" && . "$1" && optin_cmd_valid "make e2e" && echo ok', 'x', LIB], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'ok')
  })
}

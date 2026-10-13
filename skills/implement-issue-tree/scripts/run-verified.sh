#!/usr/bin/env bash
# run-verified.sh — 同じディレクトリのスクリプトを、実行前に SHA-256 を照合してから起動する
#
# 使い方:
#   bash "<skillDir>/scripts/run-verified.sh" <期待する sha256> <スクリプト名> [引数...]
#
# 役割: ビルダー（build-workflow.mjs）が生成物 implement-issue-tree.js へ埋め込んだハッシュと、
#       いま置かれているスクリプトの内容が一致するときだけ起動する。配布の版ずれ（Workflow だけ新しく
#       スクリプトが古い、またはその逆）や、スクリプトの書き換えを、実行前に fail-closed で止める。
# ハッシュの対象: <スクリプト名> のバイト列の後ろに、同じ scripts/lib/ の *.sh（バイト順）を連結した
#       もの。lib を書き換えるとそれを読み込む全スクリプトのハッシュが変わる。build-workflow.mjs の
#       bundleSha256 と同じ定義（tests/ が両者の一致を検証する）。
# 解決: スクリプトはこのファイルと同じディレクトリから名前だけで解決する（パス区切りと .. を含む名前は
#       拒否）。エージェントが渡せるのは名前だけで、実行する場所は変えられない。
# 終了コード:
#   2  使い方の誤り（引数不足・スクリプト名の形式不正・期待ハッシュの形式不正）
#   3  ハッシュ不一致（起動しない）。標準エラーへ期待値と実測値を出す
#   4  スクリプトが無い・読めない・ハッシュを計算できない（sha256sum / shasum が無い等）
#   それ以外  起動したスクリプト自身の終了コード（標準入力・標準出力はそのまま引き継ぐ）
#
# 限界: ハッシュを照合してから起動するまでの間にファイルを差し替える競合（TOCTOU）は防がない。
#       この launcher 自身も照合の対象外である。信頼の根はスキルディレクトリそのものであり、
#       そこへ書き込める者に対する防御ではない（references/script-trust-model.md）。

set -u
LC_ALL=C
export LC_ALL

usage() {
  echo "使い方: run-verified.sh SHA256 SCRIPT-NAME.sh [ARGS...]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
expected=$1
name=$2
shift 2

case "${expected}" in
  '' | *[!0-9a-f]*) usage ;;
esac
[ "${#expected}" -eq 64 ] || usage

# 先頭は英数字、使える文字は英小文字・数字・ハイフン・ドット、末尾は .sh。スラッシュと .. は含められない
case "${name}" in
  *.sh) ;;
  *) usage ;;
esac
case "${name}" in
  '' | *[!a-z0-9.-]* | [!a-z0-9]* | *..*) usage ;;
esac

dir=$(cd "$(dirname "$0")" && pwd -P) || exit 4
target="${dir}/${name}"
[ -f "${target}" ] && [ -r "${target}" ] || {
  echo "run-verified: スクリプトが無い・読めない: ${target}" >&2
  exit 4
}

# スクリプト本体の後ろに lib/*.sh を連結する。lib が無ければ glob に一致せず文字列が残るので -f で除く
actual=$(
  {
    cat -- "${target}"
    for lib in "${dir}"/lib/*.sh; do
      [ -f "${lib}" ] || continue
      cat -- "${lib}"
    done
  } | {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256
    else
      exit 1
    fi
  }
) || actual=""
actual=${actual%%[[:space:]]*}
case "${actual}" in
  '' | *[!0-9a-f]*)
    echo "run-verified: ハッシュを計算できない（sha256sum / shasum が無い、または読み出しに失敗）" >&2
    exit 4
    ;;
esac
[ "${#actual}" -eq 64 ] || {
  echo "run-verified: ハッシュを計算できない" >&2
  exit 4
}

if [ "${actual}" != "${expected}" ]; then
  echo "run-verified: ハッシュ不一致のため起動しない（${name}）。期待=${expected} 実測=${actual}" >&2
  echo "run-verified: Workflow とスキルディレクトリの版が揃っていない可能性がある。スキルを同期し直す" >&2
  exit 3
fi

# 起動中の bash 自身で実行する（PATH 上の別の bash に化けない。$BASH が無い環境では PATH の bash）
exec "${BASH:-bash}" "${target}" "$@"

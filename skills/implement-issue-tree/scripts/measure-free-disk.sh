#!/usr/bin/env bash
# measure-free-disk.sh — 指定パスが属するファイルシステムの実空き容量（KiB）を測る読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash measure-free-disk.sh --nonce <nonce> -- '/abs/path'
#
# 入力: 引数に絶対パス 1 件（-- の後ろ）。パスはデータであり、シェルへ再評価させない。
# 出力: 標準出力に 1 行の封筒（lib/signed-output.sh）。payload は {"err":N,"freeKib":N}
#       - freeKib  df -Pk の 2 行目・第 4 列（Available、KiB）。POSIX の -P で 1 ファイルシステム 1 行
#                  に固定され、GNU 専用の -B 等は使わない。err が 1 のときは 0 を入れる
#       - err      0 = 測定成功、1 = 測定失敗（パスが許可文字集合外・実在しない、df の非 0 終了、
#                  出力が数値でない）。取得失敗を freeKib=0 に畳み込まず、ホストは err が 0 のときだけ
#                  freeKib を採用する（空き 0 KiB の実測と区別できる）
# 許可文字集合（ホストの sanitizeWorktreePath と同じ）: 絶対パス、英数字・/・-・_・.・半角スペースのみ、
#       .. を含まない。
# 終了コード:
#   0  封筒を出力した（測定の成否は payload.err で判断する）
#   2  使い方の誤り（--nonce が無い・形式不正・パスが 1 件でない・未知の引数）。封筒は出力しない
#   3  封筒を作れなかった（sha256sum / shasum が無い等）。封筒は出力しない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。
# 副作用: なし（一時ファイルも作らない）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3

usage() {
  echo "使い方: measure-free-disk.sh --nonce NONCE -- 絶対パス1件" >&2
  exit 2
}

nonce=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nonce)
      [ $# -ge 2 ] || usage
      nonce=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) usage ;;
  esac
done
so_valid_nonce "${nonce}" || usage
[ $# -eq 1 ] || usage
p=$1

sp=' '
err=1
free=0
case "${p}" in
  '' | / | /[!A-Za-z0-9]* | *..* | *[!A-Za-z0-9/_.${sp}-]*) ;;
  /*)
    if [ -e "${p}" ] && dfout=$(df -Pk -- "${p}" 2>/dev/null); then
      avail=$(printf '%s\n' "${dfout}" | awk 'NR==2{print $4}')
      case "${avail}" in
        '' | *[!0-9]*) ;;
        *)
          free=${avail}
          err=0
          ;;
      esac
    fi
    ;;
esac

so_emit "${nonce}" "$(printf '{"err":%d,"freeKib":%d}' "${err}" "${free}")" || {
  echo "measure-free-disk: 出力封筒を作れなかった（sha256sum / shasum が無い等）" >&2
  exit 3
}

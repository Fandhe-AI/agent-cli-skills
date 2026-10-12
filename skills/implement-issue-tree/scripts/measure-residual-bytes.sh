#!/usr/bin/env bash
# measure-residual-bytes.sh — 残置 worktree のディスク使用量（KiB）を測る読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash measure-residual-bytes.sh --nonce <nonce> <<'EOF'
#   /abs/path/one
#   /abs/path/two
#   EOF
#
# 入力: 標準入力に絶対パスを 1 行 1 件。パスはデータであり、シェルへ再評価させない（eval なし・変数は
#       すべてクォート・du には -- で区切って渡す）。空行も 1 件として数える（欠落を黙って捨てない）。
# 出力: 標準出力に 1 行の封筒（lib/signed-output.sh）。payload は {"count":N,"err":N,"kib":N,"missing":N}
#       - count   処理した行数（ホストは送った件数と一致することを検証する）
#       - kib     実在したパス全件に du -sk を実行した第 1 列の合計（存在しないパスは 0 として加算）
#       - missing 測定時点で存在しなかった（test -e が偽の）件数。並行 cleanup との競合で消えたパスを
#                 測定失敗にしない既存の契約。「0 KiB だった」とは区別して返す
#       - err     測定失敗の件数: du の非 0 終了・出力欠損・許可文字集合外のパス・相対パス。
#                 取得失敗を kib=0 に畳み込まない。ホストは err が 0 のときだけ kib を採用する
# 許可文字集合（ホストの sanitizeWorktreePath と同じ）: 絶対パス、英数字・/・-・_・.・半角スペースのみ、
#       先頭は英数字の 1 文字目から始まり、.. を含まない。外れたパスは du に渡さず err に数える。
# 終了コード:
#   0  封筒を出力した（測定の成否は payload.err で判断する）
#   2  使い方の誤り（--nonce が無い・形式不正・未知の引数）。封筒は出力しない
#   3  封筒を作れなかった（sha256sum / shasum が無い等）。封筒は出力しない
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。du -sk は両方にあり、paste・bc・GNU 専用
#       フラグ・mapfile は使わない。集計はシェルの整数演算。
# 副作用: なし（一時ファイルも作らない）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3

nonce=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nonce)
      [ $# -ge 2 ] || { echo "使い方: measure-residual-bytes.sh --nonce NONCE（パスは標準入力）" >&2; exit 2; }
      nonce=$2
      shift 2
      ;;
    *)
      echo "使い方: measure-residual-bytes.sh --nonce NONCE（パスは標準入力。未知の引数: $1）" >&2
      exit 2
      ;;
  esac
done
so_valid_nonce "${nonce}" || { echo "measure-residual-bytes: --nonce は小文字英数字 1〜64 文字で指定する" >&2; exit 2; }

sp=' '
total=0
missing=0
err=0
count=0
while IFS= read -r p || [ -n "${p}" ]; do
  count=$((count + 1))
  case "${p}" in
    '' | / | /[!A-Za-z0-9]* | *..* | *[!A-Za-z0-9/_.${sp}-]*)
      err=$((err + 1))
      continue
      ;;
    /*) ;;
    *)
      err=$((err + 1))
      continue
      ;;
  esac
  if [ ! -e "${p}" ]; then
    missing=$((missing + 1))
    continue
  fi
  # du の終了状態は if 条件で検査する（パイプ直結だと後段の終了状態に化けて失敗が消える）
  if duout=$(du -sk -- "${p}" 2>/dev/null); then
    sz=${duout%%[[:space:]]*}
    case "${sz}" in
      '' | *[!0-9]*) err=$((err + 1)) ;;
      *) total=$((total + sz)) ;;
    esac
  else
    err=$((err + 1))
  fi
done

so_emit "${nonce}" "$(printf '{"count":%d,"err":%d,"kib":%d,"missing":%d}' "${count}" "${err}" "${total}" "${missing}")" || {
  echo "measure-residual-bytes: 出力封筒を作れなかった（sha256sum / shasum が無い等）" >&2
  exit 3
}

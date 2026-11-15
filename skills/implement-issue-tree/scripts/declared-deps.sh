#!/usr/bin/env bash
# declared-deps.sh — イシュー本文の依存宣言（Depends on #N 等）を機械抽出する
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、依存抽出エージェントが 1 回実行する）:
#   bash declared-deps.sh --numbers N,N,… [--repo OWNER/REPO] [--table JSON]
#   bash declared-deps.sh --rate-limit
#   bash declared-deps.sh --print-filter [--table JSON]
#
# 役割: プロンプトに埋め込まれていた gh api + jq の長いコマンドを、スクリプトへ切り出したもの。エージェントが 3.9〜4.9 KB の
#       コマンドを転記する際にバックスラッシュが半減する事故（`\\b` → `\b`。jq ではエラーにならずバックスペースとして通り、単語境界の判定が
#       黙って false になる）を、フィルタ本体を lib/declared-deps-lib.sh に置いてハッシュで固定することで防ぐ。フィルタの意味は
#       切り出し前と同一（tests/declared-deps-script.test.mjs が、切り出し前の文字列との文字単位の一致を固定する）。
# モード:
#   --numbers N,N,…   各イシューの本文を `gh api repos/<repo>/issues/<N>`（REST の core 枠。GraphQL 枠を消費しない）で 1 件ずつ読み、
#                     jq で整数だけに正規化した 1 行の JSON を標準出力へ出す: {"number": N, "deps": [...], "sig": S}。
#                     sig は number と deps から計算した検査値（ホストが deps から同じ式で再計算して照合する）。成功した
#                     イシューの行だけを出し、gh か jq が失敗したイシューは行を出さず標準エラーへ `FAILED #N` を出す
#                     （失敗を空の宣言と取り違えないため。欠落はホストの全件照合が検出して再試行する）。gh の標準エラーはそのまま通す。
#                     本文そのもの（非信頼データ）は出力しない。--repo を省くと gh が現在のリポジトリを使う（{owner}/{repo}）。
#                     --table は兄弟のタスク ID の表（ホストの siblingTaskTableFor。省くと表なし = 従来の抽出だけ）。
#   --rate-limit      gh api rate_limit の core 枠を読み、{"remaining":…,"resetAt":"…","waitSeconds":…} を 1 行で出す。
#                     抽出が rate limit で失敗したときの復帰時刻の確認用。待機はホストが行う。
#   --print-filter    --numbers で使う jq フィルタをそのまま標準出力へ出す（ネットワークを使わない。確認とテスト用）。
# 終了コード: 0 完了（--numbers は一部が FAILED でも 0。判定はホストが全件照合で行う）/ 2 使い方の誤り / 3 gh が無い
#             --rate-limit は gh の終了コードをそのまま返す。
# 自衛: gh api の GET（REST）だけ。書き込み・マージ・設定変更は含まない。ファイルを作らない。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 3
# shellcheck source=lib/declared-deps-lib.sh
. "${script_dir}/lib/declared-deps-lib.sh" || exit 3

usage() {
  echo "使い方: declared-deps.sh --numbers N,N,… [--repo OWNER/REPO] [--table JSON] | --rate-limit | --print-filter [--table JSON]" >&2
  [ $# -eq 0 ] || echo "declared-deps: $1" >&2
  exit 2
}

numbers=""
repo=""
table=""
have_table=0
mode=""
set_mode() {
  [ -z "${mode}" ] || usage "モードは 1 つだけ（--numbers / --rate-limit / --print-filter）"
  mode=$1
}
while [ $# -gt 0 ]; do
  case "$1" in
    --numbers | --repo | --table)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --numbers)
          [ -z "${numbers}" ] || usage "--numbers は 1 回だけ"
          numbers=$2
          set_mode fetch
          ;;
        --repo)
          [ -z "${repo}" ] || usage "--repo は 1 回だけ"
          repo=$2
          ;;
        --table)
          [ "${have_table}" -eq 0 ] || usage "--table は 1 回だけ"
          table=$2
          have_table=1
          ;;
      esac
      shift 2
      ;;
    --rate-limit)
      set_mode rate-limit
      shift
      ;;
    --print-filter)
      set_mode print-filter
      shift
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done
[ -n "${mode}" ] || usage "モードが無い"
if [ "${have_table}" -eq 0 ]; then table=${DD_EMPTY_TABLE}; fi

case "${mode}" in
  rate-limit)
    [ -z "${repo}" ] && [ "${have_table}" -eq 0 ] || usage "--rate-limit は他の引数を取らない"
    ;;
  print-filter)
    [ -z "${repo}" ] || usage "--print-filter は --repo を取らない"
    dd_valid_table "${table}" || usage "--table が表の形式（{\"f\":{…},\"n\":{…}}）でない"
    printf '%s\n' "$(dd_filter "${table}")"
    exit 0
    ;;
  fetch)
    dd_valid_numbers "${numbers}" || usage "--numbers は正の整数のカンマ区切り（重複なし・1〜${DD_NUMBERS_MAX} 個）で指定する"
    if [ -n "${repo}" ]; then dd_valid_repo "${repo}" || usage "--repo は OWNER/REPO の形で指定する"; fi
    dd_valid_table "${table}" || usage "--table が表の形式（{\"f\":{…},\"n\":{…}}）でない"
    ;;
esac

command -v gh >/dev/null 2>&1 || { echo "declared-deps: gh が無い" >&2; exit 3; }

if [ "${mode}" = rate-limit ]; then
  gh api rate_limit --jq "${DD_RATE_LIMIT_JQ}"
  exit $?
fi

filter=$(dd_filter "${table}")
if [ -n "${repo}" ]; then repo_path=${repo}; else repo_path='{owner}/{repo}'; fi
oldifs=${IFS}
IFS=,
# shellcheck disable=SC2086  # dd_valid_numbers が数字とカンマだけと確かめた値の意図した単語分割
set -- ${numbers}
IFS=${oldifs}
for n in "$@"; do
  # 成功したイシューの行だけを標準出力へ出す。失敗した分は行を出さず FAILED を標準エラーへ出す
  out=$(gh api "repos/${repo_path}/issues/${n}" --jq "${filter}") && printf '%s\n' "${out}" || echo "FAILED #${n}" >&2
done
exit 0

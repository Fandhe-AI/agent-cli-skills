#!/usr/bin/env bash
# repo-scan.sh — Tree フェーズの読み取り専用の観測 2 つ（外部チェック App の観測・対象外ラベルの open issue の取得）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立てる）:
#   bash repo-scan.sh --mode external-checks --nonce <nonce> [--repo <owner/repo>]
#   bash repo-scan.sh --mode skip-labels --nonce <nonce> [--repo <owner/repo>] -- <ラベル> [<ラベル> ...]
#
# 役割: プロンプトに埋め込まれていた gh + jq のコマンド（`detect:external-checks` はバックスラッシュ 5 か所の xargs + sh -c、
#       `plan:skip-labels` は単一引用符・`\n`・jq を含む for ループ）を、スクリプトへ切り出したもの。エージェントが転記する際に
#       バックスラッシュが半減する・`\n` が `n` になる・引用符が欠ける事故で結果が黙って変わる経路をなくす。内容は run-verified.sh の
#       ハッシュで固定され、エージェントが書き写すのは起動行と出力の封筒だけになる。
# 出力: どちらも成功時は封筒 {nonce, payload, sha256}（lib/signed-output.sh）の 1 行だけを標準出力へ出す。ホストが封筒を照合してから payload を使う。
#   external-checks   payload {"apps":[…],"dropped":N,"errs":N,"inputSha256":"…","prs":N}
#         - apps          直近 3 件の merged PR の head の check-runs にある GitHub Actions 以外の App の slug（昇順・重複なし・形式検査済み）
#         - prs           head の sha を得られた PR の件数（0〜3）
#         - errs          gh の失敗の件数（PR 一覧の失敗 1 件 + check-runs の取得失敗。個々の失敗は無視して部分結果を返す = 旧コマンドと同じ）
#         - dropped       形式が slug でないため捨てた値の件数
#         - inputSha256   sha256("repo-scan\nexternal-checks\n" + repo)
#   skip-labels       payload {"absent":[i,…],"entries":[{"i":i,"numbers":[…]},…],"failed":[i,…],"inputSha256":"…"}
#         - i             ラベルの 1 始まりの添字（引数の順。ホストは添字だけでラベルを引き、スクリプトが返した文字列は使わない）
#         - entries       取得できたラベルごとの open issue の番号（昇順・重複なし・PR を除く）。0 件でも行は出る
#         - absent        リポジトリにラベルが存在しない添字（typo・未作成。ラベル一覧を取得できなかったときは判定しない）
#         - failed        取得に失敗した添字（entries に含めない。ホストが欠落として再取得し、それでも取れなければ全 open ノードを待たせる）
#         - inputSha256   sha256("repo-scan\nskip-labels\n" + repo + 各ラベルを "\n" で連結)。ラベルの並びを束縛する（添字がラベルの意味を決める）
# 終了コード:
#   0  封筒を出力した（個々の gh の失敗は payload の errs / failed に出る）
#   2  使い方の誤り（引数の欠落・形式不正・未知の引数・モードに合わない引数）
#   3  gh・jq・sha256sum / shasum が無い、または封筒を作れない
#   7  出力が大きすぎる（封筒が 1 回の Bash 出力に収まらない。ホストは取得できなかったものとして扱う）
#   標準エラーには固定語彙と添字だけを出す（ラベル名・slug など外部由来の文字列は出さない）。
# 自衛: gh pr list と gh api の GET（REST）だけ。書き込み・マージ・設定変更は含まない。ファイルを作らない。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU）。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3
# shellcheck source=lib/base-merge-lib.sh
. "${script_dir}/lib/base-merge-lib.sh" || exit 3
# shellcheck source=lib/repo-scan-lib.sh
. "${script_dir}/lib/repo-scan-lib.sh" || exit 3

# 封筒 1 行の上限。Bash ツールの 1 回の出力（約 30000 文字）を超えると中央が欠けて静かに壊れるので、収まる範囲で止める
MAX_OUT_BYTES=24000

usage() {
  echo "使い方: repo-scan.sh --mode external-checks --nonce NONCE [--repo OWNER/REPO] | --mode skip-labels --nonce NONCE [--repo OWNER/REPO] -- LABEL [LABEL ...]" >&2
  [ $# -eq 0 ] || echo "repo-scan: $1" >&2
  exit 2
}

mode=""
nonce=""
repo=""
have_repo=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) [ $# -ge 2 ] || usage "--mode に値が無い"; [ -z "${mode}" ] || usage "--mode は 1 回だけ"; mode=$2; shift 2 ;;
    --nonce) [ $# -ge 2 ] || usage "--nonce に値が無い"; [ -z "${nonce}" ] || usage "--nonce は 1 回だけ"; nonce=$2; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage "--repo に値が無い"; [ "${have_repo}" -eq 0 ] || usage "--repo は 1 回だけ"; repo=$2; have_repo=1; shift 2 ;;
    --) shift; break ;;
    *) usage "未知の引数" ;;
  esac
done
case "${mode}" in
  external-checks) [ $# -eq 0 ] || usage "external-checks はラベルを取らない" ;;
  skip-labels)
    [ $# -ge 1 ] && [ $# -le "${RS_LABELS_MAX}" ] || usage "ラベルは 1〜${RS_LABELS_MAX} 件"
    for l in "$@"; do rs_valid_label "${l}" || usage "ラベルの形式が不正（空・制御文字・カンマ・前後の空白・長さ超過）"; done
    ;;
  *) usage "--mode は external-checks か skip-labels" ;;
esac
so_valid_nonce "${nonce}" || usage "--nonce の形式が不正"
# --repo '' は省略と同じ扱いにしない（空のまま gh が現在のリポジトリへ倒れるのを防ぐ）
if [ "${have_repo}" -eq 1 ]; then valid_repo "${repo}" || usage "--repo は OWNER/REPO の形で指定する"; fi

command -v gh >/dev/null 2>&1 || { echo "repo-scan: gh が無い" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "repo-scan: jq が無い" >&2; exit 3; }
input_sha=$(rs_input_sha "${mode}" "${repo}" "$@") || { echo "repo-scan: 入力のハッシュを計算できない（sha256sum / shasum が無い等）" >&2; exit 3; }

if [ "${have_repo}" -eq 1 ]; then base="repos/${repo}"; else base='repos/{owner}/{repo}'; fi

# 封筒を出す。大きすぎれば exit 7
emit() {
  local env
  env=$(so_emit "${nonce}" "$1") || { echo "repo-scan: 出力封筒を作れなかった" >&2; exit 3; }
  [ "${#env}" -le "${MAX_OUT_BYTES}" ] || { echo "repo-scan: 出力が大きすぎる（${#env} バイト > ${MAX_OUT_BYTES}）" >&2; exit 7; }
  printf '%s\n' "${env}"
}

if [ "${mode}" = external-checks ]; then
  errs=0
  prs=0
  raw=""
  # 直近 3 件の merged PR の head。失敗は errs に数えて続行する（旧コマンドは失敗を空の出力として扱い、apps: [] へ倒れていた）
  if [ "${have_repo}" -eq 1 ]; then
    shas=$(gh pr list -R "${repo}" --state merged --limit 3 --json headRefOid --jq '.[].headRefOid' 2>/dev/null </dev/null) || { errs=$((errs + 1)); shas=""; }
  else
    shas=$(gh pr list --state merged --limit 3 --json headRefOid --jq '.[].headRefOid' 2>/dev/null </dev/null) || { errs=$((errs + 1)); shas=""; }
  fi
  seen=0
  while IFS= read -r s; do
    [ -n "${s}" ] || continue
    seen=$((seen + 1))
    [ "${seen}" -le 3 ] || break
    if ! rs_valid_sha "${s}"; then errs=$((errs + 1)); continue; fi
    prs=$((prs + 1))
    # check-runs はページ送りなし（旧コマンドと同じ。1 ページ目の 30 件）。取得できなかった PR は無視して続ける
    if out=$(gh api "${base}/commits/${s}/check-runs" --jq "${RS_APPS_JQ}" 2>/dev/null </dev/null); then
      raw="${raw}${out}
"
    else
      errs=$((errs + 1))
    fi
  done <<RS_EOF
${shas}
RS_EOF
  rs_collect_apps "${raw}"
  emit "$(rs_payload_external "$(rs_json_slugs "${RS_APPS}")" "${prs}" "${errs}" "${RS_DROPPED}" "${input_sha}")"
  exit 0
fi

# skip-labels: ラベルごとにリポジトリ全体の open issue 番号を列挙する（labels= はカンマで AND になるためラベルごとに呼ぶ）。
# ラベル一覧は存在確認用で、取得できなければ absent を判定しない（旧コマンドの k=0）。
if names=$(gh api "${base}/labels?per_page=100" --paginate --jq "${RS_NAMES_JQ}" 2>/dev/null </dev/null); then names_ok=1; else names_ok=0; fi
i=0
entries=""
absent=""
failed=""
for l in "$@"; do
  i=$((i + 1))
  enc=$(jq -rn --arg l "${l}" '$l | @uri') || enc=""
  out=""
  nums=""
  if [ -n "${enc}" ] \
    && out=$(gh api "${base}/issues?state=open&labels=${enc}&per_page=100" --paginate --jq "${RS_ISSUES_JQ}" 2>/dev/null </dev/null) \
    && nums=$(rs_sorted_numbers "${out}"); then
    entries="${entries}${entries:+,}{\"i\":${i},\"numbers\":[${nums}]}"
    if [ "${names_ok}" -eq 1 ]; then
      rc=0
      rs_label_listed "${l}" "${names}" || rc=$?
      if [ "${rc}" -eq 1 ]; then absent="${absent}${absent:+,}${i}"; fi
    fi
  else
    echo "FAILED ${i}" >&2
    failed="${failed}${failed:+,}${i}"
  fi
done
emit "$(rs_payload_skip "[${absent}]" "[${entries}]" "[${failed}]" "${input_sha}")"
exit 0

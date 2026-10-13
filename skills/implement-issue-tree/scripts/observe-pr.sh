#!/usr/bin/env bash
# observe-pr.sh — PR の CI・レビュー・スレッドの観測と有界の待機を行う読み取り専用スクリプト
#
# 使い方（通常は run-verified.sh 経由。ホストが nonce 入りのコマンドを組み立てる）:
#   bash observe-pr.sh --nonce N --mode MODE --pr NUM [--repo OWNER/REPO] [--base BRANCH] [--branch BRANCH]
#                      [--issue NUM] [--slug APP] [--until review|settled|started] [--wait --attempt K]
#
# 役割: monitor エージェントのプロンプトに書いていた gh / jq の観測コマンド列と、その分類規則を持つ（Issue #603
#       第 2 弾）。入力と出力を定義できる部分だけを切り出したもので、「ready にしてよいか」の判断は呼び出し側
#       （monitor）に残る。出力は助言的判定の材料であり、マージ・クローズ・push・削除の可否には使われない
#       （マージ可否は merge-exec が自分で再取得して判定する。references/script-trust-model.md）。
# モード（--mode）:
#   pr        PR の state・HEAD sha・mergeable と、想定した PR かどうか（bound）。--base --branch --issue が必須。
#             --wait は mergeable が UNKNOWN の間だけ有界に再取得する（GitHub 側の算出待ち）
#   checks    HEAD sha に対するチェック総数 = check-run の total_count + combined status の件数
#             （gh pr checks・merge-exec と同じ集計定義）。--wait は 1 件以上になるまで
#   required  ベースブランチ（--base 必須）の ruleset の required context のうち HEAD sha 上に無いものの件数。
#             context 名は出力せず件数だけを返す。--wait は不足 0 になるまで
#   reviews   --slug の App（<slug>[bot]）の HEAD sha に対するレビュー件数と、その App の check-run の状態別件数。
#             --wait は --until の条件になるまで（review = レビューが 1 件以上、settled = 未完了の check-run が 0 件、
#             started = check-run かレビューが 1 件以上）
#   threads   未解決のレビュースレッド数（GraphQL をページングして全件走査する）
#   threads-detail
#             未解決スレッドの内容を 1 行 1 件の JSON で出す。封筒ではなく、外部由来の自由文を含む非信頼データ。
#             件数の判断には使わない（件数は threads の封筒）
# 出力: 標準出力に 1 行の封筒 {nonce, payload, sha256}（lib/signed-output.sh）。payload は整数と ASCII の固定語彙・
#       40 桁 16 進だけで、PR のコメント本文・チェック名・context 名のような外部由来の文字列は含めない。共通キー:
#       - mode         実行したモード
#       - inputSha256  入力（mode・pr・repo・base・branch・issue・slug・until を改行で連ねたもの）の SHA-256。
#                      ホストは自分が組み立てた引数から同じ値を再計算して照合する
#       - err          取得失敗 = 1。失敗を「0 件」「不足 0」へ畳み込まない（件数は 0 を入れるが err を見ること）
#       - outcome      observed（待機なしで取得できた）/ met / pending（条件未成立。--attempt を 1 増やして同じコマンドを
#                      再実行する）/ exhausted（--attempt が上限に達しても未成立）/ error（取得に失敗）
#       - attempt, maxAttempts  --wait の何回目か・上限（待機なしは 0）
# 待機: 1 回の起動は有界で、内部の sleep を含めて最大およそ 90 秒に収める（OBSERVE_PR_POLLS 回まで観測し、観測の間に
#       OBSERVE_PR_SLEEP_SEC 秒眠る。OBSERVE_PR_WINDOW_SEC 秒を超えたら打ち切る）。長い foreground sleep は
#       ハーネスに拒否されるため 1 回を短くし、呼び出し側が「pending なら再実行」を最大 maxAttempts 回繰り返す。
#       上限は --attempt で強制する（範囲外は exit 2）。
# 環境変数（テストが待機を短縮するために使う。範囲外は既定値へ戻す）:
#       OBSERVE_PR_POLLS（既定 6・最大 10）、OBSERVE_PR_SLEEP_SEC（既定 15・最大 30）、
#       OBSERVE_PR_WINDOW_SEC（既定 85・最大 90）、OBSERVE_PR_MAX_ATTEMPTS（既定 7・最大 20）、
#       OBSERVE_PR_SETTLE_SEC（pr の --wait の再取得間隔。既定 25・最大 30。最大 4 回観測）
# 終了コード:
#   0  封筒を出力した（観測の成否は payload.err / outcome で判断する）。threads-detail は取得できたとき 0
#   2  使い方の誤り（引数不足・形式不正・未知の引数・--wait で --attempt が範囲外）。封筒は出力しない
#   3  封筒を作れなかった（jq・sha256sum / shasum が無い等）。threads-detail は取得失敗でも 3
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。paste・bc・GNU 専用フラグ・mapfile・連想配列は
#       使わず、件数の合算は jq で行う。gh api の成否は終了コードで判定する（gh api は HTTP エラーの本文も標準出力に
#       出すため、出力の有無では判定しない）。取得した JSON は jq で型を検査してから数える。
# 副作用: なし（読み取りのみ。一時ファイルも作らない。gh pr comment・gh run rerun・mutation は実行しない）。

set -u
LC_ALL=C
export LC_ALL

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 2
# shellcheck source=lib/signed-output.sh
. "${script_dir}/lib/signed-output.sh" || exit 3

usage() {
  echo "使い方: observe-pr.sh --nonce N --mode pr|checks|required|reviews|threads|threads-detail --pr NUM [--repo O/R] [--base B] [--branch B] [--issue N] [--slug S] [--until review|settled|started] [--wait --attempt K]" >&2
  [ $# -eq 0 ] || echo "observe-pr: $1" >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || { echo "observe-pr: jq が無い" >&2; exit 3; }

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 9 ] && [ "$1" -ge 1 ]
}
# 環境変数の整数（$1 = 値、$2 = 既定、$3 = 最大、$4 = 最小）。範囲外・数字以外は既定値
env_int() {
  case "$1" in
    '' | *[!0-9]*) printf '%s' "$2"; return ;;
  esac
  if [ "${#1}" -gt 4 ] || [ "$1" -gt "$3" ] || [ "$1" -lt "$4" ]; then printf '%s' "$2"; return; fi
  printf '%s' "$((10#$1))"
}
valid_repo() {
  case "$1" in
    */*/* | */ | /* | -* | '' | *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  case "$1" in */*) ;; *) return 1 ;; esac
  [ "${#1}" -le 140 ]
}
valid_ref() {
  case "$1" in
    '' | *..* | [!A-Za-z0-9]* | *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  [ "${#1}" -le 200 ]
}
valid_slug() {
  case "$1" in
    '' | [!a-z0-9]* | *[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#1}" -le 39 ]
}

nonce=""
mode=""
pr=""
repo=""
base=""
branch=""
issue=""
slug=""
until_cond=""
wait=0
attempt=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait=1; shift ;;
    --nonce | --mode | --pr | --repo | --base | --branch | --issue | --slug | --until | --attempt)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --nonce) nonce=$2 ;;
        --mode) mode=$2 ;;
        --pr) pr=$2 ;;
        --repo) repo=$2 ;;
        --base) base=$2 ;;
        --branch) branch=$2 ;;
        --issue) issue=$2 ;;
        --slug) slug=$2 ;;
        --until) until_cond=$2 ;;
        --attempt) attempt=$2 ;;
      esac
      shift 2
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done

so_valid_nonce "${nonce}" || usage "--nonce は小文字英数字 1〜64 文字で指定する"
case "${mode}" in
  pr | checks | required | reviews | threads | threads-detail) ;;
  *) usage "--mode が不正: ${mode}" ;;
esac
is_uint "${pr}" || usage "--pr は正の整数で指定する"
[ -z "${repo}" ] || valid_repo "${repo}" || usage "--repo は OWNER/REPO 形式で指定する"
[ -z "${base}" ] || valid_ref "${base}" || usage "--base の形式が不正"
[ -z "${branch}" ] || valid_ref "${branch}" || usage "--branch の形式が不正"
[ -z "${issue}" ] || is_uint "${issue}" || usage "--issue は正の整数で指定する"
[ -z "${slug}" ] || valid_slug "${slug}" || usage "--slug の形式が不正"
case "${until_cond}" in
  '' | review | settled | started) ;;
  *) usage "--until が不正: ${until_cond}" ;;
esac
case "${mode}" in
  pr) [ -n "${base}" ] && [ -n "${branch}" ] && [ -n "${issue}" ] || usage "pr には --base --branch --issue が必要" ;;
  required) [ -n "${base}" ] || usage "required には --base が必要" ;;
  reviews)
    [ -n "${slug}" ] || usage "reviews には --slug が必要"
    [ "${wait}" -eq 0 ] || [ -n "${until_cond}" ] || usage "reviews の --wait には --until が必要"
    ;;
esac
[ "${wait}" -eq 0 ] || case "${mode}" in checks | required | reviews | pr) ;; *) usage "${mode} は --wait を取らない" ;; esac

max_attempts=0
if [ "${wait}" -eq 1 ] && [ "${mode}" != pr ]; then
  max_attempts=$(env_int "${OBSERVE_PR_MAX_ATTEMPTS:-}" 7 20 1)
  is_uint "${attempt}" && [ "${attempt}" -le "${max_attempts}" ] || usage "--wait には 1 以上 ${max_attempts} 以下の --attempt が必要"
  attempt=$((10#${attempt}))
else
  attempt=0
fi

polls=$(env_int "${OBSERVE_PR_POLLS:-}" 6 10 1)
sleep_sec=$(env_int "${OBSERVE_PR_SLEEP_SEC:-}" 15 30 0)
window=$(env_int "${OBSERVE_PR_WINDOW_SEC:-}" 85 90 0)
if [ "${mode}" = pr ]; then
  polls=4
  sleep_sec=$(env_int "${OBSERVE_PR_SETTLE_SEC:-}" 25 30 0)
fi
[ "${wait}" -eq 1 ] || polls=1

nl='
'
input_text="observe-pr${nl}${mode}${nl}${pr}${nl}${repo}${nl}${base}${nl}${branch}${nl}${issue}${nl}${slug}${nl}${until_cond}"
input_sha=$(printf '%s' "${input_text}" | so_sha256) || {
  echo "observe-pr: 入力のハッシュを計算できなかった（sha256sum / shasum が無い等）" >&2
  exit 3
}

if [ -n "${repo}" ]; then
  repo_path="repos/${repo}"
else
  repo_path='repos/{owner}/{repo}'
fi

# ---- gh の薄いラッパー。成否は終了コードで判定し、標準出力（成功時のみ使う）を OUT へ入れる ----
OUT=""
gh_pr_view() {
  if [ -n "${repo}" ]; then
    OUT=$(gh pr view "${pr}" -R "${repo}" "$@" 2>/dev/null)
  else
    OUT=$(gh pr view "${pr}" "$@" 2>/dev/null)
  fi
}
gh_api() {
  OUT=$(gh api "$@" 2>/dev/null)
}
fail() {
  echo "observe-pr: 取得に失敗した（${1}）" >&2
  return 1
}

# HEAD sha（40 桁小文字 16 進）を HEAD に入れる
HEAD=""
resolve_head() {
  HEAD=""
  gh_pr_view --json headRefOid --jq '.headRefOid' || { fail "gh pr view headRefOid"; return 1; }
  case "${OUT}" in
    '' | *[!0-9a-f]*) fail "headRefOid の形式"; return 1 ;;
  esac
  [ "${#OUT}" -eq 40 ] || { fail "headRefOid の桁数"; return 1; }
  HEAD=${OUT}
}

# ---- モードごとの 1 回分の観測。結果をグローバル変数へ入れ、失敗は return 1（err=1）----
O_STATE=""; O_MERGEABLE=""; O_BOUND=0
observe_pr() {
  O_STATE=""; O_MERGEABLE=""; O_BOUND=0; HEAD=""
  gh_pr_view --json state,headRefOid,mergeable,headRefName,baseRefName,closingIssuesReferences,isCrossRepository || { fail "gh pr view"; return 1; }
  local row
  row=$(printf '%s' "${OUT}" | jq -r --arg br "${branch}" --arg bs "${base}" --argjson n "${issue}" '
    if (type == "object" and (.headRefOid | type) == "string" and (.state | type) == "string") then
      [ .state, .headRefOid, (.mergeable // ""),
        (if (.headRefName == $br and .baseRefName == $bs and .isCrossRepository == false
             and ((.closingIssuesReferences // []) | (length == 0 or any(.[]; .number == $n)))) then "1" else "0" end) ]
      | join(" ")
    else empty end' 2>/dev/null) || { fail "gh pr view の JSON"; return 1; }
  # shellcheck disable=SC2086
  set -- ${row}
  [ $# -eq 4 ] || [ $# -eq 3 ] || { fail "gh pr view の形式"; return 1; }
  case "$1" in OPEN | MERGED | CLOSED) O_STATE=$1 ;; *) fail "state の語彙"; return 1 ;; esac
  case "$2" in '' | *[!0-9a-f]*) fail "headRefOid の形式"; return 1 ;; esac
  [ "${#2}" -eq 40 ] || { fail "headRefOid の桁数"; return 1; }
  HEAD=$2
  if [ $# -eq 4 ]; then
    O_MERGEABLE=$3
    O_BOUND=$4
  else
    O_MERGEABLE=""
    O_BOUND=$3
  fi
  case "${O_MERGEABLE}" in MERGEABLE | CONFLICTING | UNKNOWN) ;; *) O_MERGEABLE="UNKNOWN" ;; esac
  return 0
}
met_pr() { [ "${O_MERGEABLE}" != UNKNOWN ] || [ "${O_STATE}" != OPEN ]; }

O_RUNS=0; O_STATUSES=0; O_TOTAL=0
observe_checks() {
  O_RUNS=0; O_STATUSES=0; O_TOTAL=0
  resolve_head || return 1
  gh_api "${repo_path}/commits/${HEAD}/check-runs?per_page=1" || { fail "check-runs"; return 1; }
  local runs sts
  runs=$(printf '%s' "${OUT}" | jq -er '.total_count | numbers | floor' 2>/dev/null) || { fail "check-runs の total_count"; return 1; }
  gh_api "${repo_path}/commits/${HEAD}/status" || { fail "combined status"; return 1; }
  sts=$(printf '%s' "${OUT}" | jq -er '.statuses | arrays | length' 2>/dev/null) || { fail "combined status の statuses"; return 1; }
  case "${runs}${sts}" in *[!0-9]*) fail "件数の形式"; return 1 ;; esac
  O_RUNS=$((10#${runs})); O_STATUSES=$((10#${sts})); O_TOTAL=$((O_RUNS + O_STATUSES))
}
met_checks() { [ "${O_TOTAL}" -ge 1 ]; }

O_MISSING=0; O_REQTOTAL=0
observe_required() {
  O_MISSING=0; O_REQTOTAL=0
  resolve_head || return 1
  local enc req cr st have
  enc=$(jq -rn --arg b "${base}" '$b | @uri') || { fail "ブランチ名のエンコード"; return 1; }
  gh_api --paginate --slurp "${repo_path}/rules/branches/${enc}" || { fail "rules/branches"; return 1; }
  req=$(printf '%s' "${OUT}" | jq -ec '[.[][] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique' 2>/dev/null) || { fail "required context の形式"; return 1; }
  gh_api --paginate --slurp "${repo_path}/commits/${HEAD}/check-runs" || { fail "check-runs"; return 1; }
  cr=$(printf '%s' "${OUT}" | jq -ec '[.[].check_runs[].name]' 2>/dev/null) || { fail "check-runs の形式"; return 1; }
  gh_api --paginate --slurp "${repo_path}/commits/${HEAD}/statuses" || { fail "statuses"; return 1; }
  st=$(printf '%s' "${OUT}" | jq -ec '[.[][].context]' 2>/dev/null) || { fail "statuses の形式"; return 1; }
  have=$(jq -nc --argjson a "${cr}" --argjson b "${st}" '$a + $b') || { fail "context の結合"; return 1; }
  O_MISSING=$(jq -n --argjson r "${req}" --argjson h "${have}" '[$r[] | select(. as $c | ($h | index($c)) | not)] | length') || { fail "不足件数の算出"; return 1; }
  O_REQTOTAL=$(printf '%s' "${req}" | jq 'length') || { fail "required 件数"; return 1; }
  case "${O_MISSING}${O_REQTOTAL}" in *[!0-9]*) fail "件数の形式"; return 1 ;; esac
}
met_required() { [ "${O_MISSING}" -eq 0 ]; }

O_APPROVED=0; O_CHANGES=0; O_COMMENTED=0; O_PENDINGREV=0; O_DISMISSED=0; O_REVIEWS=0
O_CR_TOTAL=0; O_CR_PASSED=0; O_CR_RUNNING=0; O_CR_FAILED=0
observe_reviews() {
  O_APPROVED=0; O_CHANGES=0; O_COMMENTED=0; O_PENDINGREV=0; O_DISMISSED=0; O_REVIEWS=0
  O_CR_TOTAL=0; O_CR_PASSED=0; O_CR_RUNNING=0; O_CR_FAILED=0
  resolve_head || return 1
  local rv cr
  gh_api --paginate --slurp "${repo_path}/pulls/${pr}/reviews" || { fail "pulls/reviews"; return 1; }
  rv=$(printf '%s' "${OUT}" | jq -r --arg l "${slug}[bot]" --arg h "${HEAD}" '
    [.[][] | select(.user.login == $l and .commit_id == $h) | .state] as $s
    | [ ($s | length),
        ($s | map(select(. == "APPROVED")) | length),
        ($s | map(select(. == "CHANGES_REQUESTED")) | length),
        ($s | map(select(. == "COMMENTED")) | length),
        ($s | map(select(. == "PENDING")) | length),
        ($s | map(select(. == "DISMISSED")) | length) ] | join(" ")' 2>/dev/null) || { fail "レビューの形式"; return 1; }
  # shellcheck disable=SC2086
  set -- ${rv}
  [ $# -eq 6 ] || { fail "レビュー件数の形式"; return 1; }
  O_REVIEWS=$1; O_APPROVED=$2; O_CHANGES=$3; O_COMMENTED=$4; O_PENDINGREV=$5; O_DISMISSED=$6
  gh_api --paginate --slurp "${repo_path}/commits/${HEAD}/check-runs" || { fail "check-runs"; return 1; }
  cr=$(printf '%s' "${OUT}" | jq -r --arg s "${slug}" '
    [.[].check_runs[] | select(.app.slug == $s) | (.conclusion // .status)] as $v
    | [ ($v | length),
        ($v | map(select(. == "success" or . == "neutral" or . == "skipped")) | length),
        ($v | map(select(. == "queued" or . == "in_progress" or . == "waiting" or . == "pending" or . == "requested")) | length),
        ($v | map(select(. != "success" and . != "neutral" and . != "skipped" and . != "queued" and . != "in_progress"
                         and . != "waiting" and . != "pending" and . != "requested")) | length) ] | join(" ")' 2>/dev/null) || { fail "check-run の形式"; return 1; }
  # shellcheck disable=SC2086
  set -- ${cr}
  [ $# -eq 4 ] || { fail "check-run 件数の形式"; return 1; }
  O_CR_TOTAL=$1; O_CR_PASSED=$2; O_CR_RUNNING=$3; O_CR_FAILED=$4
  case "${O_REVIEWS}${O_APPROVED}${O_CHANGES}${O_COMMENTED}${O_PENDINGREV}${O_DISMISSED}${O_CR_TOTAL}${O_CR_PASSED}${O_CR_RUNNING}${O_CR_FAILED}" in
    *[!0-9]*) fail "件数の形式"; return 1 ;;
  esac
}
met_reviews() {
  case "${until_cond}" in
    review) [ "${O_REVIEWS}" -ge 1 ] ;;
    settled) [ "${O_CR_RUNNING}" -eq 0 ] ;;
    started) [ "${O_CR_TOTAL}" -ge 1 ] || [ "${O_REVIEWS}" -ge 1 ] ;;
    *) return 0 ;;
  esac
}

# shellcheck disable=SC2016  # GraphQL の $変数は gh に渡す文字列であり、シェルで展開しない
THREADS_QUERY='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved path comments(last:1){nodes{body url author{login}}}}pageInfo{hasNextPage endCursor}}}}}'
O_THREADS=0; O_UNRESOLVED=0; DETAIL_LINES=""
observe_threads() {
  O_THREADS=0; O_UNRESOLVED=0; DETAIL_LINES=""
  local owner name cursor="" pages=0 page cnt has end
  if [ -n "${repo}" ]; then
    owner=${repo%%/*}
    name=${repo#*/}
  else
    owner='{owner}'
    name='{repo}'
  fi
  while :; do
    pages=$((pages + 1))
    # 5000 スレッドを超える PR は想定外。無限ループを避けて失敗として扱う
    [ "${pages}" -le 50 ] || { fail "スレッドのページ数が多すぎる"; return 1; }
    if [ -z "${cursor}" ]; then
      gh_api graphql -f query="${THREADS_QUERY}" -F owner="${owner}" -F name="${name}" -F number="${pr}" || { fail "reviewThreads"; return 1; }
    else
      gh_api graphql -f query="${THREADS_QUERY}" -F owner="${owner}" -F name="${name}" -F number="${pr}" -F cursor="${cursor}" || { fail "reviewThreads"; return 1; }
    fi
    page=$(printf '%s' "${OUT}" | jq -ec '.data.repository.pullRequest.reviewThreads | select((.nodes | type) == "array" and (.pageInfo.hasNextPage | type) == "boolean")' 2>/dev/null) || { fail "reviewThreads の形式"; return 1; }
    cnt=$(printf '%s' "${page}" | jq -r '[(.nodes | length), (.nodes | map(select(.isResolved == false)) | length)] | join(" ")') || { fail "件数の算出"; return 1; }
    # shellcheck disable=SC2086
    set -- ${cnt}
    case "${1:-}${2:-}" in '' | *[!0-9]*) fail "件数の形式"; return 1 ;; esac
    O_THREADS=$((O_THREADS + $1))
    O_UNRESOLVED=$((O_UNRESOLVED + $2))
    if [ "${mode}" = threads-detail ]; then
      DETAIL_LINES="${DETAIL_LINES}$(printf '%s' "${page}" | jq -c '.nodes[] | select(.isResolved == false)
        | {threadId: .id, path: (.path // ""), url: (.comments.nodes[0].url // ""), author: (.comments.nodes[0].author.login // ""), body: ((.comments.nodes[0].body // "")[0:600])}')${nl}"
    fi
    has=$(printf '%s' "${page}" | jq -r '.pageInfo.hasNextPage')
    [ "${has}" = true ] || break
    end=$(printf '%s' "${page}" | jq -r '.pageInfo.endCursor // empty')
    [ -n "${end}" ] || { fail "endCursor が無い"; return 1; }
    cursor=${end}
  done
}

# ---- 観測ループ。--wait なしは 1 回だけ観測する ----
run_observe() {
  case "${mode}" in
    pr) observe_pr ;;
    checks) observe_checks ;;
    required) observe_required ;;
    reviews) observe_reviews ;;
    threads | threads-detail) observe_threads ;;
  esac
}
run_met() {
  case "${mode}" in
    pr) met_pr ;;
    checks) met_checks ;;
    required) met_required ;;
    reviews) met_reviews ;;
    *) return 0 ;;
  esac
}

start=$(date +%s)
err=0
outcome=observed
i=0
while :; do
  i=$((i + 1))
  err=0
  run_observe || err=1
  if [ "${wait}" -eq 0 ]; then
    [ "${err}" -eq 0 ] || outcome=error
    break
  fi
  if [ "${err}" -eq 0 ] && run_met; then
    outcome=met
    break
  fi
  now=$(date +%s)
  if [ "${i}" -ge "${polls}" ] || [ $((now - start + sleep_sec)) -ge "${window}" ]; then
    if [ "${err}" -ne 0 ]; then
      outcome=error
    elif [ "${mode}" = pr ]; then
      outcome=pending
    elif [ "${attempt}" -ge "${max_attempts}" ]; then
      outcome=exhausted
    else
      outcome=pending
    fi
    break
  fi
  sleep "${sleep_sec}"
done

if [ "${mode}" = threads-detail ]; then
  [ "${err}" -eq 0 ] || exit 3
  printf '%s' "${DETAIL_LINES}"
  exit 0
fi

# 失敗した観測の値は信用しない（件数は 0、語彙は空にして err で判別させる）
if [ "${err}" -ne 0 ]; then
  HEAD=""
  O_STATE=""; O_MERGEABLE=""; O_BOUND=0; O_RUNS=0; O_STATUSES=0; O_TOTAL=0; O_MISSING=0; O_REQTOTAL=0
  O_APPROVED=0; O_CHANGES=0; O_COMMENTED=0; O_PENDINGREV=0; O_DISMISSED=0; O_REVIEWS=0
  O_CR_TOTAL=0; O_CR_PASSED=0; O_CR_RUNNING=0; O_CR_FAILED=0; O_THREADS=0; O_UNRESOLVED=0
fi

case "${mode}" in
  pr)
    payload=$(jq -cnS --arg m "${mode}" --arg is "${input_sha}" --arg oc "${outcome}" --arg hs "${HEAD}" --arg st "${O_STATE}" --arg mg "${O_MERGEABLE}" \
      --argjson e "${err}" --argjson b "${O_BOUND}" --argjson a "${attempt}" --argjson ma "${max_attempts}" \
      '{mode: $m, inputSha256: $is, outcome: $oc, err: $e, attempt: $a, maxAttempts: $ma, headSha: $hs, state: $st, mergeable: $mg, bound: $b}')
    ;;
  checks)
    payload=$(jq -cnS --arg m "${mode}" --arg is "${input_sha}" --arg oc "${outcome}" --arg hs "${HEAD}" \
      --argjson e "${err}" --argjson a "${attempt}" --argjson ma "${max_attempts}" --argjson r "${O_RUNS}" --argjson s "${O_STATUSES}" --argjson t "${O_TOTAL}" \
      '{mode: $m, inputSha256: $is, outcome: $oc, err: $e, attempt: $a, maxAttempts: $ma, headSha: $hs, checkRuns: $r, statuses: $s, total: $t}')
    ;;
  required)
    payload=$(jq -cnS --arg m "${mode}" --arg is "${input_sha}" --arg oc "${outcome}" --arg hs "${HEAD}" \
      --argjson e "${err}" --argjson a "${attempt}" --argjson ma "${max_attempts}" --argjson mi "${O_MISSING}" --argjson rt "${O_REQTOTAL}" \
      '{mode: $m, inputSha256: $is, outcome: $oc, err: $e, attempt: $a, maxAttempts: $ma, headSha: $hs, missing: $mi, requiredTotal: $rt}')
    ;;
  reviews)
    payload=$(jq -cnS --arg m "${mode}" --arg is "${input_sha}" --arg oc "${outcome}" --arg hs "${HEAD}" \
      --argjson e "${err}" --argjson a "${attempt}" --argjson ma "${max_attempts}" \
      --argjson rv "${O_REVIEWS}" --argjson ap "${O_APPROVED}" --argjson ch "${O_CHANGES}" --argjson co "${O_COMMENTED}" --argjson pe "${O_PENDINGREV}" --argjson di "${O_DISMISSED}" \
      --argjson ct "${O_CR_TOTAL}" --argjson cp "${O_CR_PASSED}" --argjson cr "${O_CR_RUNNING}" --argjson cf "${O_CR_FAILED}" \
      '{mode: $m, inputSha256: $is, outcome: $oc, err: $e, attempt: $a, maxAttempts: $ma, headSha: $hs, reviews: $rv, approved: $ap, changesRequested: $ch, commented: $co, pendingReviews: $pe, dismissed: $di, checkRuns: $ct, checkRunsPassed: $cp, checkRunsRunning: $cr, checkRunsFailed: $cf}')
    ;;
  threads)
    payload=$(jq -cnS --arg m "${mode}" --arg is "${input_sha}" --arg oc "${outcome}" \
      --argjson e "${err}" --argjson a "${attempt}" --argjson ma "${max_attempts}" --argjson t "${O_THREADS}" --argjson u "${O_UNRESOLVED}" \
      '{mode: $m, inputSha256: $is, outcome: $oc, err: $e, attempt: $a, maxAttempts: $ma, threads: $t, unresolved: $u}')
    ;;
esac
[ -n "${payload:-}" ] || { echo "observe-pr: payload を組み立てられなかった" >&2; exit 3; }

so_emit "${nonce}" "${payload}" || {
  echo "observe-pr: 出力封筒を作れなかった（sha256sum / shasum が無い等）" >&2
  exit 3
}

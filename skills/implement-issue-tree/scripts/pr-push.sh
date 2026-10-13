#!/usr/bin/env bash
# pr-push.sh — pr-create と fix の「base 取り込み・push・push の確認・PR 作成」を決定的に行う（Issue #603 第 4 弾）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、隔離 worktree のエージェントが実行する）:
#   bash pr-push.sh --mode prepare --origin pr-create|fix --branch B --base BASE [--repo O/R] [--subject-file FILE]
#   bash pr-push.sh --mode push    --origin pr-create|fix --branch B --base BASE
#   bash pr-push.sh --mode pr      --branch B --base BASE --title-file FILE --body-file FILE --issue N [--repo O/R]
#
# 役割: prCreatePrompt / fixPrompt に文章で書いていた手順（起点の確立・push 前の base 最新化・差分ゼロ確認・push と反映の確認・
#       既存 open PR の検出・PR 作成）を、判断を挟まない決定的なコマンド列として持つ。エージェントに残るのは判断だけである:
#       base とのコンフリクトの解消・コミット subject の決定・opt-in テストの実行・PR のタイトルと本文の文面・既存 PR 本文の追記。
#       レビュー指摘の修正・スレッドの resolve・マージ・クローズは行わない。
#   prepare  1. --repo があれば remote の fetch / push URL の全行を照合する（lib の routing_check_remotes。base-merge.sh と共有）
#            2. base の fetch（refs/heads/ 修飾・保存先を明示）。失敗なら何もせず止まる（stale な origin/<base> を取り込まない）
#            3. 起点を決めて detached HEAD にする。
#               pr-create: リモートの branch の有無・sha・祖先関係から lib の pp_decide_origin が決める（ローカル起点 / リモート起点 /
#                          remote-ahead・diverged・local-missing で中止）。HEAD が起点の sha と一致することを確かめる
#               fix:       リモートの branch を fetch して refs/remotes/origin/<branch> を detach する
#            4. base を取り込む。ブランチの先頭が base の祖先なら取り込む差分が無いので止まる（no-own-commits）。
#               subject は --subject-file（エージェントが commitlint 等に合わせて決めたもの）か、無ければ埋め込み定数。
#               コンフリクトは解消せず、マージを『途中のまま残して』conflict を返す（エージェントが解消し、git add のあと
#               git commit -F <subject ファイル> で確定する）。commit hook が拒否したときは abort して hook-rejected を返す
#               （エージェントが subject を決めて --subject-file つきで再実行する）
#   push     MERGE_HEAD が残っていれば止まる。pr-create は origin/<base>..HEAD の先行コミット数が 0 なら push せず止まる（no-diff）。
#            HEAD:refs/heads/<branch> を push し、前後のリモート head の突き合わせで結果を決める（lib/push-verify.sh）
#   pr       open PR を検出し（gh pr list --head）、base と head の sha が一致する PR は再利用、無ければ --title-file / --body-file で作成する
#            （body に「Closes #N」があることを確かめる）。base だけ違う・head が動いている PR は再利用も新規作成もしない
# 出力: 標準出力の最後の 1 行が `PR_PUSH_RESULT {…}` の 1 行 JSON。値は固定語彙・整数・40 桁 16 進の sha だけで、hook の出力・gh の
#       出力・URL・ブランチ名のような外部由来の文字列を入れない（診断は標準エラーへ。URL は標準エラーにも出さない）。
#       結果を出せたときは、失敗の status を含めて exit 0。ホストは結果を『進捗』にしか使わず、マージ・クローズ・削除の可否には
#       使わない（references/script-trust-model.md）。
#         prepare: status = merged | up-to-date | conflict | hook-rejected | no-own-commits | routing-error | base-fetch-failed |
#                  branch-fetch-failed | local-missing | remote-ahead | diverged | checkout-failed | sha-mismatch | merge-failed | error
#                  start（ok のとき）= local | remote。remote-ahead・diverged は localSha・remoteSha を添える
#         push:    status = pushed | noop | race | unverified | push-failed | no-diff | merge-in-progress | error
#         pr:      status = created | reused | head-mismatch | base-mismatch | ambiguous | no-remote-ref | list-failed | create-failed |
#                  body-invalid | title-invalid | error。prNumber（整数）を添えることがある
# 終了コード: 0 結果の行を出力した / 2 使い方の誤り（引数不足・形式不正・未知の引数）/ 3 実行できる前提が無い（git・gh が無い等）
# 自衛: push の refspec は HEAD:refs/heads/<branch> の 1 形だけ（--no-follow-tags 付き）。--force 系・--no-verify は使わない（hook を通す）。
#       merge・approve・設定変更・クローズは実行しない。gh は pr list / pr create だけ。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。paste・bc・mapfile・GNU 専用フラグを使わない。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT
GIT_MERGE_AUTOEDIT=no
export GIT_MERGE_AUTOEDIT

command -v git >/dev/null 2>&1 || { echo "pr-push: git が無い" >&2; exit 3; }
script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 3
# shellcheck source=lib/push-verify.sh
. "${script_dir}/lib/push-verify.sh" || exit 3
# shellcheck source=lib/base-merge-lib.sh
. "${script_dir}/lib/base-merge-lib.sh" || exit 3
# shellcheck source=lib/pr-push-lib.sh
. "${script_dir}/lib/pr-push-lib.sh" || exit 3

# マージコミットの subject の既定（base-merge.sh と同じ文字列）。commitlint 等が拒否するリポでは hook-rejected で返り、
# エージェントが --subject-file で決めた subject を渡して再実行する
MERGE_SUBJECT='chore: base ブランチの変更を取り込む'

usage() {
  echo "使い方: pr-push.sh --mode prepare|push|pr --branch B --base BASE [--origin pr-create|fix] [--repo O/R] [--subject-file F] [--title-file F --body-file F --issue N]" >&2
  [ $# -eq 0 ] || echo "pr-push: $1" >&2
  exit 2
}

mode=""
origin_kind=""
branch=""
base=""
repo=""
subject_file=""
title_file=""
body_file=""
issue=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode | --origin | --branch | --base | --repo | --subject-file | --title-file | --body-file | --issue)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --mode) mode=$2 ;;
        --origin) origin_kind=$2 ;;
        --branch) branch=$2 ;;
        --base) base=$2 ;;
        --repo) repo=$2 ;;
        --subject-file) subject_file=$2 ;;
        --title-file) title_file=$2 ;;
        --body-file) body_file=$2 ;;
        --issue) issue=$2 ;;
      esac
      shift 2
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done
case "${mode}" in
  prepare | push | pr) ;;
  *) usage "--mode は prepare / push / pr のいずれか" ;;
esac
pv_valid_branch "${branch}" || usage "--branch の形式が不正"
pv_valid_branch "${base}" || usage "--base の形式が不正"
[ "${branch}" != "${base}" ] || usage "--branch と --base は同じ値にできない"
[ -z "${repo}" ] || valid_repo "${repo}" || usage "--repo は OWNER/REPO 形式で指定する"
case "${mode}" in
  prepare | push)
    case "${origin_kind}" in
      pr-create | fix) ;;
      *) usage "--origin は pr-create / fix のいずれか" ;;
    esac
    [ -z "${title_file}${body_file}${issue}" ] || usage "--title-file / --body-file / --issue は pr モード専用"
    ;;
  pr)
    [ -z "${origin_kind}${subject_file}" ] || usage "--origin / --subject-file は prepare / push モード専用"
    pp_valid_path "${title_file}" || usage "--title-file は絶対パスで指定する"
    pp_valid_path "${body_file}" || usage "--body-file は絶対パスで指定する"
    pp_is_uint "${issue}" || usage "--issue は正の整数で指定する"
    ;;
esac
if [ -n "${subject_file}" ]; then
  [ "${mode}" = prepare ] || usage "--subject-file は prepare モード専用"
  pp_valid_path "${subject_file}" || usage "--subject-file は絶対パスで指定する"
fi

msgfile=""
# shellcheck disable=SC2329  # trap 経由で呼ばれる
cleanup() {
  [ -z "${msgfile}" ] || rm -f "${msgfile}"
  msgfile=""
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT HUP

# 結果を出して終了する。$1 = status（固定語彙）、残り = key=value（value は整数か 40 桁 16 進だけを通す）。
# mode に応じた先頭項目 "mode" を付ける
emit() {
  local status=$1 extra="" kv k v
  shift
  for kv in "$@"; do
    k=${kv%%=*}
    v=${kv#*=}
    if pp_is_sha "${v}"; then
      extra="${extra},\"${k}\":\"${v}\""
    elif pp_is_uint "${v}"; then
      extra="${extra},\"${k}\":${v}"
    fi
  done
  [ -z "${res_start}" ] || extra="${extra},\"start\":\"${res_start}\""
  printf 'PR_PUSH_RESULT {"mode":"%s","status":"%s"%s}\n' "${mode}" "${status}" "${extra}"
  exit 0
}
# 診断を標準エラーへ出してから結果を出す（診断に URL・外部由来の文字列を入れない）
fail() {
  local status=$1 note=$2
  shift 2
  echo "pr-push: ${note}" >&2
  emit "${status}" "$@"
}

# gh の -R は ${repo:+-R "${repo}"} で付ける（bash 3.2 は set -u で空配列の展開がエラーになるため配列を使わない）
res_start=""

base_ref="refs/remotes/origin/${base}"
branch_ref="refs/remotes/origin/${branch}"

# ============================ prepare ============================
do_prepare() {
  local remote_sha="" local_sha="" l_in_r=- r_in_l=- lsrc rc head_now want anc pre_merge post_merge unmerged has_merge_head subject

  # ---- 1. routing ガード（--repo があるときだけ。ホストが期待リポジトリを持たない Run では従来どおり照合しない） ----
  if [ -n "${repo}" ]; then
    want=$(lower "${repo}")
    rc=0
    routing_check_remotes "${want}" || rc=$?
    case "${rc}" in
      0) ;;
      1) fail routing-error "remote の ${RM_FAILED} URL が許可ホスト・期待リポジトリと不一致" ;;
      *) fail routing-error "origin の URL（${RM_FAILED}）を取得できない" ;;
    esac
  fi

  # ---- 2. base の取得（失敗したら何もしない） ----
  git update-ref -d "${base_ref}" >/dev/null 2>&1 || true
  git fetch origin "refs/heads/${base}:${base_ref}" >/dev/null 2>&1 || fail base-fetch-failed "base の fetch が失敗した"
  pv_is_sha "$(git rev-parse -q --verify "${base_ref}" 2>/dev/null)" || fail base-fetch-failed "base の追跡 ref を読めない"

  # ---- 3. 起点の確立 ----
  # リモートの branch の有無は ls-remote --exit-code で見分ける（0 = あり、2 = なし、それ以外 = 確認不能）
  rc=0
  git ls-remote --exit-code origin "refs/heads/${branch}" >/dev/null 2>&1 || rc=$?
  case "${rc}" in
    0)
      git update-ref -d "${branch_ref}" >/dev/null 2>&1 || true
      git fetch origin "refs/heads/${branch}:${branch_ref}" >/dev/null 2>&1 || fail branch-fetch-failed "branch の fetch が失敗した"
      remote_sha=$(git rev-parse -q --verify "${branch_ref}" 2>/dev/null) || remote_sha=""
      pv_is_sha "${remote_sha}" || fail branch-fetch-failed "branch の追跡 ref を読めない"
      ;;
    2) remote_sha="" ;;
    *) fail branch-fetch-failed "リモートの branch の有無を確認できない" ;;
  esac
  if [ "${origin_kind}" = fix ]; then
    # fix: リモートの branch が起点。無ければ（PR のブランチが消えている）止まる
    [ -n "${remote_sha}" ] || fail branch-fetch-failed "リモートに branch が無い"
    git checkout --detach "${branch_ref}" >/dev/null 2>&1 || fail checkout-failed "branch の checkout が失敗した"
    lsrc=remote
    head_now=${remote_sha}
  else
    local_sha=$(git rev-parse -q --verify "refs/heads/${branch}" 2>/dev/null) || local_sha=""
    if [ -n "${local_sha}" ] && ! pv_is_sha "${local_sha}"; then local_sha=""; fi
    if [ -n "${remote_sha}" ] && [ -n "${local_sha}" ] && [ "${remote_sha}" != "${local_sha}" ]; then
      l_in_r=0
      git merge-base --is-ancestor "refs/heads/${branch}" "${branch_ref}" >/dev/null 2>&1 || l_in_r=$?
      r_in_l=0
      git merge-base --is-ancestor "${branch_ref}" "refs/heads/${branch}" >/dev/null 2>&1 || r_in_l=$?
    fi
    if ! pp_decide_origin "${remote_sha}" "${local_sha}" "${l_in_r}" "${r_in_l}"; then
      case "${PP_ORIGIN}" in
        remote-ahead | diverged) fail "${PP_ORIGIN}" "ローカルとリモートの branch の関係が ${PP_ORIGIN}" "localSha=${local_sha}" "remoteSha=${remote_sha}" ;;
        local-missing) fail local-missing "リモートに branch があるがローカルの refs/heads/ に無い" ;;
        *) fail error "branch の祖先関係を判定できない" ;;
      esac
    fi
    if [ "${PP_ORIGIN}" = remote ]; then
      git checkout --detach "${branch_ref}" >/dev/null 2>&1 || fail checkout-failed "branch の checkout が失敗した"
      lsrc=remote
      head_now=${remote_sha}
    else
      [ -n "${local_sha}" ] || fail local-missing "ローカルの refs/heads/ に branch が無い"
      git checkout --detach "refs/heads/${branch}" >/dev/null 2>&1 || fail checkout-failed "branch の checkout が失敗した"
      lsrc=local
      head_now=${local_sha}
    fi
  fi
  # 起点の実体の確認: HEAD が決めた sha と一致すること（隔離 worktree に残っていた無関係な HEAD をそのまま取り込み・push しない）
  res_start=${lsrc}
  [ "$(git rev-parse HEAD 2>/dev/null)" = "${head_now}" ] || fail sha-mismatch "checkout 後の HEAD が起点の sha と一致しない"

  # ---- 4. base の取り込み ----
  anc=0
  git merge-base --is-ancestor HEAD "${base_ref}" >/dev/null 2>&1 || anc=$?
  case "${anc}" in
    0) fail no-own-commits "ブランチの先頭は base に含まれている（取り込む差分なし）" ;;
    1) ;;
    *) fail error "base との祖先関係を判定できない" ;;
  esac
  if [ -n "${subject_file}" ]; then
    [ -f "${subject_file}" ] && [ -r "${subject_file}" ] && [ -s "${subject_file}" ] || fail error "--subject-file を読めない"
    [ "$(wc -c <"${subject_file}")" -le 4000 ] || fail error "--subject-file が大きすぎる"
    subject=${subject_file}
  else
    msgfile=$(mktemp "${TMPDIR:-/tmp}/pr-push-msg.XXXXXX") || fail error "一時ファイルを作れない"
    printf '%s\n' "${MERGE_SUBJECT}" >"${msgfile}" || fail error "一時ファイルへ書けない"
    subject=${msgfile}
  fi
  pre_merge=$(git rev-parse HEAD 2>/dev/null) || pre_merge=""
  rc=0
  git merge --no-ff --no-edit -F "${subject}" "${base_ref}" >/dev/null 2>&1 || rc=$?
  if [ "${rc}" -ne 0 ]; then
    unmerged=$(git diff --name-only --diff-filter=U 2>/dev/null) || unmerged=""
    has_merge_head=0
    git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && has_merge_head=1
    if [ -n "${unmerged}" ]; then
      # 途中のまま残す: エージェントが解消する。解消できないときは git merge --abort
      echo "pr-push: base とのコンフリクトを検出した（マージは途中のまま残してある）" >&2
      emit conflict
    fi
    git merge --abort >/dev/null 2>&1 || true
    if [ "${has_merge_head}" -eq 1 ]; then
      fail hook-rejected "マージコミットが hook 等に拒否された（abort した）"
    fi
    fail merge-failed "git merge が失敗した（コンフリクト・hook 拒否以外。abort した）"
  fi
  post_merge=$(git rev-parse HEAD 2>/dev/null) || post_merge=""
  pv_is_sha "${post_merge}" || fail error "マージ後の HEAD を読めない"
  if [ "${post_merge}" = "${pre_merge}" ]; then
    emit up-to-date
  fi
  emit merged
}

# ============================ push ============================
do_push() {
  local count
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    fail merge-in-progress "マージが途中のまま残っている（コンフリクトの解消コミットが無い）"
  fi
  if [ "${origin_kind}" = pr-create ]; then
    # 差分ゼロの確認（起点の取り違えへの最終防御）。数えられないときも push しない
    count=$(git rev-list --count "${base_ref}..HEAD" 2>/dev/null) || count=""
    case "${count}" in
      '' | *[!0-9]*) fail error "先行コミット数を数えられない" ;;
    esac
    [ "${count}" -gt 0 ] || fail no-diff "base との差分が 0 件（push 対象コミットなし）"
  fi
  pv_push_verified "${branch}" || fail error "push の前提（ブランチ名）が不正"
  case "${PV_OUTCOME}" in
    pushed | noop | race | unverified | push-failed) emit "${PV_OUTCOME}" ;;
    *) fail error "push の結果を判定できない" ;;
  esac
}

# ============================ pr ============================
do_pr() {
  local remote_sha title rows out rc
  command -v gh >/dev/null 2>&1 || { echo "pr-push: gh が無い" >&2; exit 3; }
  [ -f "${title_file}" ] && [ -r "${title_file}" ] || fail title-invalid "--title-file を読めない"
  [ -f "${body_file}" ] && [ -r "${body_file}" ] && [ -s "${body_file}" ] || fail body-invalid "--body-file を読めない・空"
  IFS= read -r title <"${title_file}" || true
  pp_valid_title "${title}" || fail title-invalid "タイトルが空・長すぎる・制御文字を含む"
  # 「Closes #N」の行（インデントや行末の空白は許す。#6030 のような桁の続きは別の番号なので許さない。issue は正の整数に検証済み）
  grep -qE "^[[:space:]]*Closes #${issue}([^0-9]|$)" "${body_file}" || fail body-invalid "body に「Closes #${issue}」の行が無い"
  # push した先端 sha は、push が自動更新するリモート追跡 ref から解決する（ローカルの refs/heads/ は更新していないため使わない）
  remote_sha=$(git rev-parse -q --verify "${branch_ref}" 2>/dev/null) || remote_sha=""
  pv_is_sha "${remote_sha}" || fail no-remote-ref "リモート追跡 ref を解決できない"
  rows=$(gh pr list ${repo:+-R "${repo}"} --state open --head "${branch}" --json number,baseRefName,headRefOid \
    --jq '.[] | "\(.number) \(.baseRefName) \(.headRefOid)"' 2>/dev/null) || fail list-failed "gh pr list が失敗した"
  rc=0
  pp_classify_pr "${base}" "${remote_sha}" "${rows}" || rc=$?
  case "${PP_PR_STATUS}" in
    reuse) emit reused "prNumber=${PP_PR_NUMBER}" ;;
    none) ;;
    head-mismatch | base-mismatch | ambiguous) fail "${PP_PR_STATUS}" "既存の open PR は再利用も新規作成もできない（${PP_PR_STATUS}）" "prNumber=${PP_PR_NUMBER}" ;;
    *) fail error "gh pr list の出力を分類できない" ;;
  esac
  out=$(gh pr create ${repo:+-R "${repo}"} --base "${base}" --head "${branch}" --title "${title}" --body-file "${body_file}" 2>/dev/null) \
    || fail create-failed "gh pr create が失敗した"
  pp_pr_number_from_output "${out}" || fail create-failed "gh pr create の出力から PR 番号を取り出せない"
  emit created "prNumber=${PP_PR_NUMBER}"
}

case "${mode}" in
  prepare) do_prepare ;;
  push) do_push ;;
  pr) do_pr ;;
esac

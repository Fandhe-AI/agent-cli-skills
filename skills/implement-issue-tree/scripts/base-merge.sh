#!/usr/bin/env bash
# base-merge.sh — PR のブランチへ base ブランチを取り込んで push する（コンフリクトは解消せず報告する）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、隔離 worktree のエージェントが 1 回実行する）:
#   bash base-merge.sh --pr NUM --branch BRANCH --base BASE --repo OWNER/REPO
#
# 役割: baseMergePrompt（Issue #441）に文章で書いていた手順 0〜3 を、判断を挟まない決定的なコマンド列として持つ
#       （Issue #603 第 3 弾）。レビュー指摘の修正・スレッドの resolve・PR 本文編集・マージ・クローズは行わない。
#       担当するのは次だけである。
#         0. worktree routing ガード: origin の host が github.com、owner/repo が --repo と完全一致（大文字小文字を
#            区別しない）し、gh pr view の number と headRefName が --pr / --branch と一致すること。1 つでも外れたら
#            fetch・checkout・merge・push を一切実行しない
#         1. 対象ブランチの fetch → detached checkout → HEAD と origin のブランチの sha 照合
#         2. base の fetch → 埋め込み subject でマージ。コンフリクトは解消せず abort して報告する
#         3. push 前後のリモート head の突き合わせ（lib/push-verify.sh。pushed になるのは二条件を満たしたときだけ）
# 入力: 引数は検証済みの値だけを渡す。--branch と --base は同じ値にできない（base 自身への push の防止）。--repo は
#       小文字化して比較する。空の --repo は「期待リポジトリが未確定」として routingError で返す（常に不一致 = fail-closed）。
# 出力: 標準出力の最後の 1 行が `BASE_MERGE_RESULT {…}` の 1 行 JSON（キーは BASE_MERGE_SCHEMA と同じ: pushed / summary /
#       worktreePath、該当時だけ routingError / commitFailed / conflict / hookRejected が true）。summary は固定の語彙だけ
#       で、hook の出力・gh の出力・URL・ブランチ名のような外部由来の文字列を入れない（診断は標準エラーへ出す）。
#       結果を出せたときは、取り込み失敗・routing 不一致を含めて exit 0。ホストは pushed を『進捗』にしか使わない
#       （マージ・push・削除の可否には使わない。references/script-trust-model.md）。
# 終了コード:
#   0  結果の行を出力した（成否は JSON の内容で判断する）
#   2  使い方の誤り（引数不足・形式不正・未知の引数・--branch と --base が同じ）。結果の行は出力しない
#   3  実行できる前提が無い（git が無い等）。結果の行は出力しない
# 自衛: push の refspec は HEAD:refs/heads/<branch> の 1 形だけ。--force 系・--no-verify は使わない（hook を通す）。
#       マージの subject は下の埋め込み定数を一時ファイルに書いて -F で渡す（commitlint 設定やコミット履歴を読まない =
#       未信頼の読み取りを自動 base 取り込みの経路から排除する。PR #443 codex P0）。一時ファイルは trap で必ず消す。
#       --no-ff でマージするため、merge.ff などの利用者設定でマージコミットの有無が変わらない。
# 副作用: この worktree の detached HEAD を動かし、対象ブランチへ push する。それ以外のリポジトリ設定は変更しない。
# 互換: macOS（BSD userland・bash 3.2）と Linux（GNU・busybox）。paste・bc・mapfile・GNU 専用フラグを使わない。

set -u
unset POSIXLY_CORRECT
LC_ALL=C
export LC_ALL
# 認証情報の入力待ちでハングしない（非対話の fail-closed）
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT
GIT_MERGE_AUTOEDIT=no
export GIT_MERGE_AUTOEDIT

script_dir=$(cd "$(dirname "$0")" && pwd -P) || exit 3
# shellcheck source=lib/push-verify.sh
. "${script_dir}/lib/push-verify.sh" || exit 3

# マージコミットの subject（ホストの固定値と同じ文字列。commitlint が拒否するリポでは hookRejected で返り、
# ホストが commitlint 対応の subject を決められる fix 経路へ委譲する）
MERGE_SUBJECT='chore: base ブランチの変更を取り込む'
# 許可するリモートのホスト。Fandhe-AI は GitHub.com 運用のため固定値とする（owner/repo だけを比較すると、同じ
# owner/repo を持つ別ホストを一致とみなして別ホストへ push しうる。PR #443 codex P0）
ALLOWED_REMOTE_HOST='github.com'

usage() {
  echo "使い方: base-merge.sh --pr NUM --branch BRANCH --base BASE --repo OWNER/REPO" >&2
  [ $# -eq 0 ] || echo "base-merge: $1" >&2
  exit 2
}

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 9 ] && [ "$1" -ge 1 ]
}
# OWNER/REPO の形式（ホストの REPO_SLUG_RE と同じ厳格さ）。owner は英数字とハイフン・先頭末尾ハイフン不可・1〜39 文字、
# repo は先頭がハイフン以外の英数字 . _ で . と .. だけは不可・1〜100 文字
valid_repo() {
  local owner name
  case "$1" in
    */*/* | */ | /* | '') return 1 ;;
  esac
  case "$1" in */*) ;; *) return 1 ;; esac
  owner=${1%%/*}
  name=${1#*/}
  case "${owner}" in
    '' | -* | *- | *[!A-Za-z0-9-]*) return 1 ;;
  esac
  [ "${#owner}" -le 39 ] || return 1
  case "${name}" in
    '' | . | .. | [!A-Za-z0-9._]* | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "${#name}" -le 100 ]
}
lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

pr=""
branch=""
base=""
repo=""
repo_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr | --branch | --base | --repo)
      [ $# -ge 2 ] || usage "$1 に値が無い"
      case "$1" in
        --pr) pr=$2 ;;
        --branch) branch=$2 ;;
        --base) base=$2 ;;
        --repo) repo=$2; repo_given=1 ;;
      esac
      shift 2
      ;;
    *) usage "未知の引数: $1" ;;
  esac
done
is_uint "${pr}" || usage "--pr は正の整数で指定する"
pv_valid_branch "${branch}" || usage "--branch の形式が不正"
pv_valid_branch "${base}" || usage "--base の形式が不正"
[ "${branch}" != "${base}" ] || usage "--branch と --base は同じ値にできない"
[ "${repo_given}" -eq 1 ] || usage "--repo が無い"
[ -z "${repo}" ] || valid_repo "${repo}" || usage "--repo は OWNER/REPO 形式で指定する"
command -v git >/dev/null 2>&1 || { echo "base-merge: git が無い" >&2; exit 3; }

msgfile=""
# shellcheck disable=SC2329  # trap 経由で呼ばれる
cleanup() {
  [ -z "${msgfile}" ] || rm -f "${msgfile}"
  msgfile=""
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT HUP

# 結果を出して終了する。$1 = pushed（true / false）、$2 = summary（固定語彙）、$3 以降 = true にするフラグ名。
# worktreePath は pwd -P。ホストの許可文字（英数字・/・-・_・.・半角スペース）と ".." 以外は JSON を壊し得るので空にする
emit() {
  local pushed=$1 summary=$2 extra="" f wt
  shift 2
  for f in "$@"; do
    extra="${extra},\"${f}\":true"
  done
  wt=$(pwd -P 2>/dev/null) || wt=""
  case "${wt}" in
    '' | *..* | [!/]* | /[!A-Za-z0-9]* | *[!A-Za-z0-9/._\ -]*) wt="" ;;
  esac
  printf 'BASE_MERGE_RESULT {"pushed":%s,"summary":"%s","worktreePath":"%s"%s}\n' "${pushed}" "${summary}" "${wt}" "${extra}"
  exit 0
}
fail_routing() {
  echo "base-merge: routing ガード不成立（${1}）" >&2
  emit false "worktree routing error: ${2}" routingError
}
fail_commit() {
  echo "base-merge: ${1}" >&2
  emit false "$2" commitFailed
}

# ---- 0. worktree routing ガード ----
[ -n "${repo}" ] || fail_routing "期待リポジトリが空" "期待リポジトリが未確定（--repo が空）"
want=$(lower "${repo}")
url=$(git remote get-url origin 2>/dev/null) || fail_routing "git remote get-url origin が失敗" "origin の URL を取得できない"
url=${url%/}
url=${url%.git}
case "${url}" in
  ssh://git@*) rest=${url#ssh://git@}; got_host=${rest%%/*}; got_path=${rest#*/} ;;
  git@*:*) rest=${url#git@}; got_host=${rest%%:*}; got_path=${rest#*:} ;;
  https://*) rest=${url#https://}; got_host=${rest%%/*}; got_path=${rest#*/} ;;
  *) got_host=""; got_path="" ;;
esac
got_host=$(lower "${got_host}")
got_path=$(lower "${got_path}")
if [ "${got_host}" != "${ALLOWED_REMOTE_HOST}" ]; then
  fail_routing "remote の host=${got_host:-（解釈できない形式）}" "remote の host が許可ホストと不一致"
fi
if [ "${got_path}" != "${want}" ]; then
  fail_routing "remote の owner/repo=${got_path} が期待 ${want} と不一致" "remote の owner/repo が期待リポジトリと不一致"
fi
pr_row=$(gh pr view "${pr}" --json number,headRefName --jq '[(.number | tostring), .headRefName] | join(" ")' 2>/dev/null) \
  || fail_routing "gh pr view が失敗" "PR を解決できない（gh 取得失敗）"
if [ "${pr_row}" != "${pr} ${branch}" ]; then
  fail_routing "PR の number / headRefName が対象と不一致" "PR の number または headRefName が対象と不一致"
fi

# ---- 1. 対象ブランチの取得 ----
# 作業ツリーに未コミットの変更があるとマージコミットへ混入し得る。隔離 worktree は clean のはず（clean でなければ中止）
dirty=$(git status --porcelain --untracked-files=no 2>/dev/null) || fail_commit "git status が失敗" "worktree の状態を確認できない"
[ -z "${dirty}" ] || fail_commit "作業ツリーに未コミットの変更がある" "worktree が clean でない"
git fetch origin "${branch}:refs/remotes/origin/${branch}" >/dev/null || fail_commit "branch の fetch が失敗" "branch fetch 失敗"
git checkout --detach "refs/remotes/origin/${branch}" >/dev/null 2>&1 || fail_commit "branch の checkout が失敗" "branch checkout 失敗"
head_now=$(git rev-parse HEAD 2>/dev/null) || head_now=""
remote_tip=$(git rev-parse "refs/remotes/origin/${branch}" 2>/dev/null) || remote_tip=""
if ! pv_is_sha "${head_now}" || [ "${head_now}" != "${remote_tip}" ]; then
  fail_commit "checkout 後の HEAD が origin のブランチと不一致" "checkout 後の HEAD が origin/<branch> と不一致"
fi

# ---- 2. base の取得とマージ ----
git fetch origin "${base}:refs/remotes/origin/${base}" >/dev/null || fail_commit "base の fetch が失敗" "base fetch 失敗"
base_ref="refs/remotes/origin/${base}"
# ブランチの先頭が base に含まれている（独自のコミットが無い）なら、マージは fast-forward になり base の先端をそのまま
# ブランチへ push してしまう。取り込む差分が無いので何もしない
anc=0
git merge-base --is-ancestor HEAD "${base_ref}" 2>/dev/null || anc=$?
case "${anc}" in
  0) emit false "ブランチの先頭は base に含まれている（取り込む差分なし）" ;;
  1) ;;
  *) fail_commit "git merge-base が失敗" "base との祖先関係を確認できない" ;;
esac
msgfile=$(mktemp "${TMPDIR:-/tmp}/base-merge-msg.XXXXXX") || fail_commit "一時ファイルを作れない" "マージ subject の一時ファイルを作れない"
printf '%s\n' "${MERGE_SUBJECT}" >"${msgfile}" || fail_commit "一時ファイルへ書けない" "マージ subject の一時ファイルへ書けない"
pre_merge=${head_now}
merge_rc=0
git merge --no-ff --no-edit -F "${msgfile}" "${base_ref}" >/dev/null || merge_rc=$?
if [ "${merge_rc}" -ne 0 ]; then
  unmerged=$(git diff --name-only --diff-filter=U 2>/dev/null) || unmerged=""
  has_merge_head=0
  git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && has_merge_head=1
  git merge --abort >/dev/null 2>&1 || true
  if [ -n "${unmerged}" ]; then
    echo "base-merge: base とのコンフリクトを検出した（解消せず abort した）" >&2
    emit false "base コンフリクト解消不能（内容編集の権限なし。fix/implement へ委譲要）" commitFailed conflict
  fi
  if [ "${has_merge_head}" -eq 1 ]; then
    echo "base-merge: マージコミットが hook 等に拒否された（abort した）" >&2
    emit false "base merge コミット拒否（commit-msg / pre-commit hook 等）" commitFailed hookRejected
  fi
  fail_commit "git merge が失敗した（コンフリクト・MERGE_HEAD なし）" "base merge が失敗した（コンフリクト・hook 拒否以外）"
fi
post_merge=$(git rev-parse HEAD 2>/dev/null) || post_merge=""
if ! pv_is_sha "${post_merge}"; then
  fail_commit "マージ後の HEAD を読めない" "マージ後の HEAD を確認できない"
fi
if [ "${post_merge}" = "${pre_merge}" ]; then
  emit false "Already up to date（GitHub 側の mergeable 算出待ちの可能性）"
fi

# ---- 3. push と反映の確認 ----
pv_push_verified "${branch}" || fail_commit "push を実行できなかった" "push の前提（ブランチ名）が不正"
case "${PV_OUTCOME}" in
  pushed) emit true "base を取り込み push した" ;;
  noop) emit false "変更なしのため push は no-op" ;;
  race) emit false "リモート head がローカル HEAD と不一致（並行 push 競合の可能性）" ;;
  push-failed) emit false "push が失敗した（拒否・通信エラー等）" ;;
  *) emit false "push 前後のリモート head を確認できず pushed: false として返す" ;;
esac

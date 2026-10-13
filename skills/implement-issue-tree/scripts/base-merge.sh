#!/usr/bin/env bash
# base-merge.sh — PR のブランチへ base ブランチを取り込んで push する（コンフリクトは解消せず報告する）
#
# 使い方（通常は run-verified.sh 経由。ホストがコマンドを組み立て、隔離 worktree のエージェントが 1 回実行する）:
#   bash base-merge.sh --pr NUM --branch BRANCH --base BASE --repo OWNER/REPO
#
# 役割: baseMergePrompt（Issue #441）に文章で書いていた手順 0〜3 を、判断を挟まない決定的なコマンド列として持つ
#       （Issue #603 第 3 弾）。レビュー指摘の修正・スレッドの resolve・PR 本文編集・マージ・クローズは行わない。
#       担当するのは次だけである。
#         0. worktree routing ガード: origin の fetch URL と push 先 URL の『全行』（git remote get-url --all / --push
#            --all）が host github.com・owner/repo が --repo と完全一致（大文字小文字を区別しない）し、gh pr view -R の
#            number と headRefName が --pr / --branch と一致すること。1 つでも外れたら fetch・checkout・merge・push を
#            一切実行しない（git 2.7 以降。取得できない git では routingError に倒れる）
#         1. 対象ブランチの fetch（refs/heads/ 修飾）→ detached checkout → HEAD と origin のブランチの sha 照合
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
# 自衛: push の refspec は HEAD:refs/heads/<branch> の 1 形だけ（--no-follow-tags 付き。利用者設定 push.followTags でタグが
#       origin へ出ない）。--force 系・--no-verify は使わない（hook を通す）。
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

command -v git >/dev/null 2>&1 || { echo "base-merge: git が無い" >&2; exit 3; }
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

# 正の整数（先頭ゼロは拒否: 012 を 12 と読み替えない。gh の応答との文字列比較が偶然止めるのに頼らない）
is_uint() {
  case "$1" in
    '' | *[!0-9]* | 0*) return 1 ;;
  esac
  [ "${#1}" -le 9 ]
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
# remote の URL を照合する。fetch URL（`git remote get-url --all`）と push 先 URL（`--push --all`）の『全行』が、許可ホストと
# 期待 owner/repo に一致しなければならない。先頭 1 件だけを見ると、pushurl・pushInsteadOf・複数 url の追加で push だけが別の
# リポジトリへ届く（隔離 worktree は本体の .git/config を共有するので、先行するエージェントが書ける位置にある）。
# 許す形: https://[userinfo@]github.com[:443]/<owner>/<repo>[.git]、ssh://git@github.com[:22]/<owner>/<repo>[.git]、
# git@github.com:<owner>/<repo>[.git]。userinfo は authority の最後の @ までを捨てて host を取り出す
# （https://github.com@evil.example/… の host は evil.example）。authority に @ が 2 つ以上ある URL は拒否する
# （https://a@evil.example@github.com/… は git が接続に失敗しても、エラー文に 2 つ目の userinfo が残る。トークン中の @ は
# %40 にエンコードされる）。URL はトークンを含み得るので、どの出力にも出さない。
# `.git` の除去は小文字の `.git` だけ（`.GIT` は別名になり得るので受理しない）。owner/repo の比較は大文字小文字を区別しない
url_allowed() {
  local u=$1 want_slug=$2 scheme rest hostport host port path
  case "${u}" in
    '' | *[!A-Za-z0-9._~:/@%+-]*) return 1 ;;
  esac
  u=${u%/}
  u=${u%.git}
  case "${u}" in
    ssh://git@*)
      rest=${u#ssh://git@}
      case "${rest}" in */*) ;; *) return 1 ;; esac
      hostport=${rest%%/*}
      path=${rest#*/}
      case "${hostport}" in *@*) return 1 ;; esac
      scheme=ssh
      ;;
    git@*:*)
      rest=${u#git@}
      hostport=${rest%%:*}
      path=${rest#*:}
      scheme=scp
      ;;
    https://*)
      rest=${u#https://}
      case "${rest}" in */*) ;; *) return 1 ;; esac
      hostport=${rest%%/*}
      case "${hostport}" in *@*@*) return 1 ;; esac
      hostport=${hostport##*@}
      path=${rest#*/}
      scheme=https
      ;;
    *) return 1 ;;
  esac
  case "${hostport}" in
    *:*) host=${hostport%%:*}; port=${hostport#*:} ;;
    *) host=${hostport}; port="" ;;
  esac
  # 標準ポートだけ許す（https の 443、ssh:// の 22）。scp 形式にポートは無い
  case "${scheme}:${port}" in
    ssh: | ssh:22 | https: | https:443 | scp:) ;;
    *) return 1 ;;
  esac
  host=$(lower "${host}")
  path=$(lower "${path}")
  [ "${host}" = "${ALLOWED_REMOTE_HOST}" ] && [ -n "${path}" ] && [ "${path}" = "${want_slug}" ]
}
# $1 = ラベル（fetch / push）、残り = git remote get-url への追加オプション。0 = 全行が許可、1 = 1 行でも外れた、2 = 取得できない
check_remote_urls() {
  local label=$1 out line n=0
  shift
  out=$(git remote get-url "$@" origin 2>/dev/null) || return 2
  [ -n "${out}" ] || return 2
  while IFS= read -r line; do
    n=$((n + 1))
    url_allowed "${line}" "${want}" || { echo "base-merge: ${label} URL の ${n} 行目が許可ホスト・期待リポジトリと一致しない" >&2; return 1; }
  done <<EOF
${out}
EOF
  return 0
}

[ -n "${repo}" ] || fail_routing "期待リポジトリが空" "期待リポジトリが未確定（--repo が空）"
want=$(lower "${repo}")
for spec in "fetch:--all" "push:--push --all"; do
  rc=0
  # shellcheck disable=SC2086
  check_remote_urls "${spec%%:*}" ${spec#*:} || rc=$?
  case "${rc}" in
    0) ;;
    1) fail_routing "remote の ${spec%%:*} URL が不一致" "remote の URL（fetch / push）が許可ホスト・期待リポジトリと不一致" ;;
    *) fail_routing "git remote get-url（${spec%%:*}）が失敗または空" "origin の URL（fetch / push）を取得できない" ;;
  esac
done
# -R で期待リポジトリを明示する（GH_REPO や gh repo set-default で別リポジトリの PR を引かない）
pr_row=$(gh pr view "${pr}" -R "${repo}" --json number,headRefName --jq '[(.number | tostring), .headRefName] | join(" ")' 2>/dev/null) \
  || fail_routing "gh pr view が失敗" "PR を解決できない（gh 取得失敗）"
if [ "${pr_row}" != "${pr} ${branch}" ]; then
  fail_routing "PR の number / headRefName が対象と不一致" "PR の number または headRefName が対象と不一致"
fi

# ---- 1. 対象ブランチの取得 ----
# 作業ツリーに未コミットの変更があるとマージコミットへ混入し得る。隔離 worktree は clean のはず（clean でなければ中止）
dirty=$(git status --porcelain --untracked-files=no 2>/dev/null) || fail_commit "git status が失敗" "worktree の状態を確認できない"
[ -z "${dirty}" ] || fail_commit "作業ツリーに未コミットの変更がある" "worktree が clean でない"
# fetch 元は refs/heads/ で修飾する（修飾しないと同名のタグが優先され、タグにしか無いコミットがブランチへ入る）。
# 失敗した fetch が古い追跡 ref を残して、stale な内容を merge しないよう、先に追跡 ref を消す
git update-ref -d "refs/remotes/origin/${branch}" >/dev/null 2>&1 || true
git fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}" >/dev/null || fail_commit "branch の fetch が失敗" "branch fetch 失敗"
git checkout --detach "refs/remotes/origin/${branch}" >/dev/null 2>&1 || fail_commit "branch の checkout が失敗" "branch checkout 失敗"
head_now=$(git rev-parse HEAD 2>/dev/null) || head_now=""
remote_tip=$(git rev-parse "refs/remotes/origin/${branch}" 2>/dev/null) || remote_tip=""
if ! pv_is_sha "${head_now}" || [ "${head_now}" != "${remote_tip}" ]; then
  fail_commit "checkout 後の HEAD が origin のブランチと不一致" "checkout 後の HEAD が origin/<branch> と不一致"
fi

# ---- 2. base の取得とマージ ----
git update-ref -d "refs/remotes/origin/${base}" >/dev/null 2>&1 || true
git fetch origin "refs/heads/${base}:refs/remotes/origin/${base}" >/dev/null || fail_commit "base の fetch が失敗" "base fetch 失敗"
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

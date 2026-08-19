#!/usr/bin/env bash
# skills-lock-update.sh — skills-lock.json の computedHash を npx skills add で更新する
#
# 使い方（リポジトリルートから実行）:
#   skills/sync-skills-lock/scripts/skills-lock-update.sh <skill-name> <source-repo>
#   （インストール先からは .agents/skills/sync-skills-lock/scripts/skills-lock-update.sh）
# 例:
#   skills/sync-skills-lock/scripts/skills-lock-update.sh github-docs Fandhe-AI/agent-reference-skills
#
# このスクリプトは sync-skills-lock スキルが使用する実例コマンド集。
# リポジトリルートから実行すること。

set -euo pipefail

# skills CLI (vercel-labs/skills) の固定実行バージョン。
# exact 版のみ許可（dist-tag・レンジ禁止）。npx はバージョン未固定だと
# ローカルキャッシュに無い場合レジストリの最新版を確認なしで即実行するため、
# レジストリ乗っ取り時に任意コード実行を許す経路になる。この実行は
# skills-lock.json の差分確認・ユーザー承認より前に走るため、source の
# Fandhe-AI 完全一致検証（下記）では防げない。exact 版固定が信頼アンカー。
# 更新手順は SKILL.md の「skills CLI のバージョン固定と更新手順」節を参照。
# SKILL.md 側のフェンスと同時更新し、tests/version-pin.test.mjs が両者の
# 一致を検証する。
readonly SKILLS_CLI_VERSION="1.5.22"   # 実装時に latest を再確認して確定（npm view skills version）

# dist-tag（latest 等）・レンジ指定（^, ~ 等）の混入をコード上でも防ぐ形式ガード。
# 不一致時は最新版へ暗黙フォールバックせず fail-closed で停止する。
if [[ ! "${SKILLS_CLI_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "エラー: SKILLS_CLI_VERSION は exact semver（X.Y.Z）のみ許可: ${SKILLS_CLI_VERSION}" >&2
  exit 1
fi

SKILL_NAME="${1:-}"
SOURCE_REPO="${2:-}"

if [[ -z "$SKILL_NAME" || -z "$SOURCE_REPO" ]]; then
  echo "使い方: $0 <skill-name> <source-repo>"
  echo "例: $0 github-docs Fandhe-AI/agent-reference-skills"
  exit 1
fi

# SKILL_NAME バリデーション: 小文字 kebab-case のみ許可（パストラバーサル防止）
if [[ ! "$SKILL_NAME" =~ ^[a-z][a-z0-9-]+$ ]]; then
  echo "エラー: SKILL_NAME は小文字 kebab-case のみ許可されています: ${SKILL_NAME}" >&2
  exit 1
fi

# source の安全弁: Fandhe-AI org の単一リポジトリのみ許可（完全一致検証）
# 前方一致では `../` を含む値が通過し、clone 時の URL パス正規化で
# 組織外リポジトリを対象にできるため、OWNER/REPO へ正規化後に厳密検証する
REPO_SLUG="${SOURCE_REPO#https://github.com/}"
REPO_SLUG="${REPO_SLUG%.git}"
if [[ ! "$REPO_SLUG" =~ ^Fandhe-AI/[A-Za-z0-9._-]+$ ]] \
  || [[ "$REPO_SLUG" == "Fandhe-AI/." || "$REPO_SLUG" == "Fandhe-AI/.." ]]; then
  echo "エラー: 想定外の source: $SOURCE_REPO — Fandhe-AI/<repo> の完全一致のみ許可されています" >&2
  exit 1
fi

# skills-lock.json に source があれば SOURCE_REPO と照合する（誤 upstream 同期防止）。
# jq 不在時にこの照合ブロックごと skip すると、lockfile の source 安全弁を経由せず
# 任意のリポジトリを SOURCE_REPO として通過させられてしまうため、skills-lock.json が
# 存在するのに jq が無い場合は照合を省略せず fail-closed で中止する。
if [[ -f skills-lock.json ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "エラー: jq が見つかりません。skills-lock.json の source 照合に jq の導入が必要です。中止します。" >&2
    exit 1
  fi
  LOCK_SOURCE=$(jq -r ".skills[\"${SKILL_NAME}\"].source // empty" skills-lock.json 2>/dev/null)
  if [[ -n "${LOCK_SOURCE}" ]]; then
    norm_lock="${LOCK_SOURCE#https://github.com/}"; norm_lock="${norm_lock%.git}"
    norm_arg="${SOURCE_REPO#https://github.com/}"; norm_arg="${norm_arg%.git}"
    if [[ "${norm_lock}" != "${norm_arg}" ]]; then
      echo "エラー: 指定された source (${SOURCE_REPO}) が skills-lock.json の source (${LOCK_SOURCE}) と一致しません。中止します。" >&2
      exit 1
    fi
  fi
fi

# gh CLI の認証確認
if ! gh auth status &>/dev/null; then
  echo "エラー: gh CLI が認証されていません。gh auth login を実行してください。" >&2
  exit 1
fi

echo "==> skills-lock.json を更新中: ${SKILL_NAME} (source: ${SOURCE_REPO})"
echo ""

# 更新前の computedHash を表示
echo "変更前の computedHash:"
SKILL_NAME_VAR="${SKILL_NAME}" python3 - <<'PYEOF'
import json, os, sys
skill = os.environ['SKILL_NAME_VAR']
try:
    with open('skills-lock.json') as f:
        lock = json.load(f)
    skills = lock.get('skills', {})
    if skill in skills:
        print(skills[skill].get('computedHash', '(computedHash なし)'))
    else:
        print('(未登録)')
except FileNotFoundError:
    print('(skills-lock.json が見つかりません)', file=sys.stderr)
    sys.exit(1)
PYEOF

echo ""

# skills-lock.json の clean チェック（sync 由来以外の変更の混入を防ぐ）
# git diff 系は untracked を検出しないため porcelain を使う
if [[ -n "$(git status --porcelain -- skills-lock.json)" ]]; then
  echo "エラー: skills-lock.json に未コミットの変更があります。コミットまたは退避してから再実行してください。" >&2
  exit 1
fi

# 当該スキルの install ツリーの clean チェック（npx による WIP 上書きを防ぐ）
# git diff 系は untracked を検出しないため porcelain を使う（未追跡 WIP も保護対象）
if [[ -n "$(git status --porcelain -- ".agents/skills/${SKILL_NAME}/")" ]]; then
  echo "エラー: .agents/skills/${SKILL_NAME}/ に未コミット変更（未追跡含む）があります。npx の上書きで失われるため中止します。コミットまたは退避してから再実行してください。" >&2
  exit 1
fi

# 消費側リポジトリが vendored skill へ commit 済み local patch を適用している場合
# (台帳: .agents/skills/LOCAL-PATCHES.md)、commit 済み patch は上の clean チェックを
# 通過してしまうため、npx より前に repository-owned checker(無引数 = check mode)を
# 必須にし、npx 後は stage より前に再適用(apply) + 最終検証を行う。
# checker 非 0、および台帳があるのに checker が無い状態は fail-closed で停止する
LOCAL_PATCH_GUARD=false
if [[ -f scripts/check-skill-local-patches.sh ]]; then
  LOCAL_PATCH_GUARD=true
  # checker は導入先リポジトリが配置する実行可能コードであり、「存在するだけ」で実行しては
  # ならない(未信頼な checkout・未レビュー PR の任意コードが、差分提示・承認より前に
  # ユーザー権限で走る経路になる)。実行は次の両方を満たす場合に限る(fail-closed):
  #   (1) HEAD に commit 済みで、worktree の内容が HEAD の blob と一致する
  #       (未追跡・未コミット変更の checker は拒否 = レビューを経ていないコードを実行しない)
  #   (2) ユーザーが由来(git log -1)と内容(git show)をレビューし、その blob hash を
  #       CHECKER_APPROVED_HASH で明示承認している(承認は hash 単位。内容が変われば再承認)
  # なお checker 自体は契約範囲外 path のため、apply がこれを書き換えた場合は
  # outside_state の前後 digest 比較でも fail-closed に検出される
  CHECKER_WORKTREE_HASH="$(git hash-object -- scripts/check-skill-local-patches.sh)"
  CHECKER_HEAD_HASH="$(git rev-parse HEAD:scripts/check-skill-local-patches.sh 2>/dev/null || true)"
  if [[ -z "${CHECKER_HEAD_HASH}" || "${CHECKER_WORKTREE_HASH}" != "${CHECKER_HEAD_HASH}" ]]; then
    echo "エラー: scripts/check-skill-local-patches.sh が HEAD に commit 済みの内容と一致しません(未 commit・未追跡・未コミット変更)。任意コード実行を防ぐため同期を開始しません(fail-closed)。" >&2
    exit 1
  fi
  if [[ "${CHECKER_APPROVED_HASH:-}" != "${CHECKER_WORKTREE_HASH}" ]]; then
    echo "エラー: checker はユーザーがレビュー・承認した内容のみ実行できます。由来と内容を確認のうえ、blob hash を明示して再実行してください(fail-closed):" >&2
    echo "  git log -1 -- scripts/check-skill-local-patches.sh   # 由来(最終 commit)の確認" >&2
    echo "  git show HEAD:scripts/check-skill-local-patches.sh   # 実行される内容の確認" >&2
    echo "  CHECKER_APPROVED_HASH=${CHECKER_WORKTREE_HASH} $0 ${SKILL_NAME} ${SOURCE_REPO}" >&2
    exit 1
  fi
elif [[ -f .agents/skills/LOCAL-PATCHES.md ]]; then
  echo "エラー: .agents/skills/LOCAL-PATCHES.md があるのに scripts/check-skill-local-patches.sh がありません。local patch を検証できないため同期を開始しません(fail-closed)。" >&2
  exit 1
fi

if [[ "${LOCAL_PATCH_GUARD}" == true ]]; then
  # durable patch 置き場は承認時に directory ごと stage し、却下時に index からの復元 +
  # git clean の対象になるため、未 stage の WIP・未追跡ファイルが残っていると巻き込まれて
  # 失われる。staged のみの変更(= 呼び出し元ループで承認済みに積み上がった分)は許容する。
  # producer(git status)を grep -q へ直接 pipe すると、-q の早期終了による SIGPIPE で
  # pipefail 下のパイプラインが偽になり WIP を見逃し得るため、一旦変数へ取得してから判定する
  LOCAL_PATCHES_STATUS="$(git status --porcelain -- scripts/local-patches/)"
  if grep -q '^.[^ ]' <<<"${LOCAL_PATCHES_STATUS}"; then
    echo "エラー: scripts/local-patches/ に未 stage の変更・未追跡ファイルがあります。承認・却下経路が巻き込むため同期を開始しません(fail-closed)。" >&2
    exit 1
  fi
  # 契約範囲(skills-lock.json / 当該スキル / durable patch)外の状態 digest。
  # worktree 側は「HEAD を基底にした一時 index へ範囲外のみ git add -A」した tree hash で
  # 捉える(未追跡・削除を含む全ファイルが実 blob hash で比較され、diff の表示文字列に
  # 依存しない = dirty なバイナリの上書きも検出する。範囲内は HEAD のまま固定されるため
  # 同期による正当な変更では digest が動かない)。index 側は ls-files -s の blob hash で捉える。
  # 基準(PRE_OUTSIDE)は checker の初回実行(同期前 check)より前に取得する。check の後に
  # 取得すると、check mode が行った範囲外変更が基準へ取り込まれ検出できなくなる。
  #
  # 【検出範囲の限界(重要)】この digest は Git が追跡・列挙できる対象(非 ignore の
  # worktree / index)に限られる。.gitignore 対象・.git/ 配下(config・hooks 等)・
  # リポジトリ外への書き込みは検出できない。同一権限で任意コードを実行した後の
  # tree 比較は書き込み制限の「保証」にはならず、信頼アンカーはあくまで実行前の
  # ユーザーによる checker 内容レビュー + blob hash 承認である。本検証はその上に
  # 重ねる best-effort の追加防御(defense-in-depth)として扱うこと
  OUTSIDE_PATHSPEC=(. ":(exclude)skills-lock.json" ":(exclude).agents/skills/${SKILL_NAME}" ":(exclude)scripts/local-patches")
  outside_state() {
    local tmp_index_dir wt_tree idx_digest
    tmp_index_dir="$(mktemp -d)"
    GIT_INDEX_FILE="${tmp_index_dir}/index" git read-tree HEAD
    GIT_INDEX_FILE="${tmp_index_dir}/index" git add -A -- "${OUTSIDE_PATHSPEC[@]}"
    wt_tree="$(GIT_INDEX_FILE="${tmp_index_dir}/index" git write-tree)"
    rm -rf "${tmp_index_dir}"
    idx_digest="$(git ls-files -s -z -- "${OUTSIDE_PATHSPEC[@]}" | git hash-object --stdin)"
    echo "${wt_tree}:${idx_digest}"
  }
  PRE_OUTSIDE="$(outside_state)"

  # checker の「すべての」実行(同期前 check / apply / 最終 check)の直後に、実行結果に
  # 関わらず範囲外 digest と checker 自身の blob hash を再検証する。範囲外を書き換えて
  # 非 0 終了するケース・checker 自身を未承認コードへ置換するケースを、次の実行より前に
  # fail-closed で検出するため。範囲外の破壊は契約範囲用の復元手順では戻らないため、
  # 手動復旧の案内を出す
  verify_outside_and_checker() {
    if [[ "$(git hash-object -- scripts/check-skill-local-patches.sh 2>/dev/null || echo missing)" != "${CHECKER_APPROVED_HASH}" ]]; then
      echo "エラー: checker 自身が書き換えられました。未承認コードのため以後実行しません(fail-closed)。" >&2
      return 1
    fi
    if [[ "$(outside_state)" != "${PRE_OUTSIDE}" ]]; then
      echo "エラー: checker が契約範囲外の path を変更しました(fail-closed)。" >&2
      echo "git status --porcelain で範囲外の変更を特定し、tracked は git restore -- <path> / index は git restore --staged -- <path> で手動復旧してください(契約範囲用の復元手順では範囲外は戻りません)。checker 側の修正も必要です。" >&2
      return 1
    fi
    return 0
  }

  # checker の「初回実行より前」に index snapshot を取得する。同期前 check(check mode)も
  # 契約上、契約範囲(当該スキル / skills-lock.json / durable patch)を変更・stage し得るため、
  # npx 失敗時はこの snapshot で契約範囲全体を同期開始前へ戻す
  PRE_SYNC_TREE="$(git write-tree)"

  echo "==> 同期前の local patch 検証(check)"
  pre_check_rc=0
  bash scripts/check-skill-local-patches.sh || pre_check_rc=$?
  if ! verify_outside_and_checker; then
    echo "(npx は実行していません)" >&2
    exit 1
  fi
  if [[ "${pre_check_rc}" -ne 0 ]]; then
    echo "エラー: 同期前の local patch 検証に失敗しました。状態を修復してから再実行してください(fail-closed。npx は実行していません)。" >&2
    exit 1
  fi
fi

# npx skills add で CLI に computedHash を更新させる
# --yes（1つ目）は npx 自体のインストール確認プロンプトを非対話でスキップする
# ものであり、skills CLI へ渡す --yes（末尾）とは別物（位置で区別される）。
# skills@${SKILLS_CLI_VERSION} で exact 版のみ解決させ、該当版が存在しない・
# レジストリ到達不能の場合は npx が非ゼロ終了する（fail-closed。最新版への暗黙
# フォールバック経路は存在しない）。local patch guard 時は、同期前 check が契約範囲を
# 変更・stage していた可能性があるため、失敗時に PRE_SYNC_TREE で契約範囲全体を
# 同期開始前へ復元してから停止する（部分書き込み・checker 由来の stage の残留防止）
npx --yes "skills@${SKILLS_CLI_VERSION}" add "${SOURCE_REPO}" --skill "${SKILL_NAME}" --yes || {
  if [[ "${LOCAL_PATCH_GUARD}" == true ]]; then
    # snapshot 未設定のまま read-tree すると「現 index からの誤復元」になるため空値は弾く。
    # skills-lock.json は必須の追跡ファイルであり、checkout 失敗は実復元漏れなので握り潰さない
    : "${PRE_SYNC_TREE:?同期開始前 snapshot が未設定のため復元できません}"
    git read-tree "${PRE_SYNC_TREE}"
    git checkout -- skills-lock.json
    git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
    git checkout -- scripts/local-patches/ 2>/dev/null || true
    git clean -fd ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
    echo "エラー: npx skills add が失敗したため、契約範囲を同期開始前(PRE_SYNC_TREE=${PRE_SYNC_TREE})へ復元して停止します(fail-closed)。" >&2
  else
    echo "エラー: npx skills add が失敗しました(fail-closed)。部分書き込みが残っている場合は skills-lock.json と .agents/skills/${SKILL_NAME}/ をリバートしてください。" >&2
  fi
  exit 1
}

echo ""
echo "==> 更新完了。変更内容:"
# install ツリーの上書きも確認するため、skills-lock.json と当該スキルの install ツリー両方を diff する。
# git diff は未追跡ファイルを表示しない。スクリプト冒頭の clean ガード（porcelain）により
# npx 実行前の install ツリーは必ず clean のため、npx が新規作成したファイルは
# 例外なく未追跡になる。tracked diff だけでは upstream 側のファイル増加を一切見せずに
# 承認判断（呼び出し元の git add）へ進んでしまうため、未追跡分を別途列挙・表示する。
git diff -- skills-lock.json ".agents/skills/${SKILL_NAME}/"

# 承認（呼び出し元の git add、-f なし）が新規に取り込む集合、拒否（git clean -fd、-x なし）が
# 削除する集合と同一のもの（.gitignore 対象を除く非追跡ファイル）を列挙し、
# 中身が見えないまま承認 / 拒否のどちらか一方だけが通過する非対称を無くす。
# git ls-files の既定出力は改行区切りのため、ファイル名自体に改行を含む
# 未追跡ファイルがあると 1 パスが複数の存在しないパスへ分割される。分割後の
# 各 git diff は失敗し || true で握り潰される一方、後続の git add は実ファイルを
# そのまま取り込むため、内容を表示しないまま承認できてしまう（-z / NUL 区切りで防ぐ）。
# 未追跡ファイルのプレビュー(列挙 + 内容表示)。引数の pathspec 群を対象に実行する。
# 通常プレビュー(当該スキルのみ)と、local patch guard 時の最終確認(当該スキル +
# scripts/local-patches/)の両方から呼ばれ、同一の表示・fail-closed 挙動を共有する。
UNTRACKED_LIST_FILE=""
# 変数が空(初回呼び出し前)のまま rm へ渡すと、-f でも「空の operand」エラーで
# 非 0 終了し set -e で停止するため、空値は rm 自体を実行しない
trap '[[ -z "${UNTRACKED_LIST_FILE}" ]] || rm -f "${UNTRACKED_LIST_FILE}"' EXIT
preview_untracked() {
UNTRACKED_COUNT=0
echo ""
# git ls-files をプロセス置換（`< <(...)`）へ直接つなぐと、`set -euo pipefail` は
# その終了コードを検査しない。`git ls-files` が失敗（破損 index・権限エラー等）しても
# while は単に0回実行され UNTRACKED_COUNT=0 のまま「新規（未追跡）ファイル: なし」と
# 誤表示し、実際には存在する未追跡ファイルの内容を確認しないまま呼び出し元が
# git add で承認してしまう（このスクリプトが防ごうとしている非対称そのもの）。
# 通常のコマンド置換で一時ファイルへ書き出し、`if ! ...` で明示的に終了コードを検査する
# ことで fail-closed にする。
if [[ -n "${UNTRACKED_LIST_FILE}" ]]; then rm -f "${UNTRACKED_LIST_FILE}"; fi
UNTRACKED_LIST_FILE="$(mktemp)"
if ! git ls-files -z --others --exclude-standard -- "$@" > "${UNTRACKED_LIST_FILE}"; then
  echo "エラー: git ls-files が失敗し、未追跡ファイルの一覧化を確認できません。内容未確認のまま承認できてしまうため中止します。" >&2
  exit 1
fi
while IFS= read -r -d '' f; do
  if [[ "${UNTRACKED_COUNT}" -eq 0 ]]; then
    echo "==> 新規（未追跡）ファイル — 承認時に git add で取り込まれる集合:"
  fi
  UNTRACKED_COUNT=$((UNTRACKED_COUNT + 1))
  # 空ファイルは git diff --no-index が差分を出力しないため、diff の見出しだけでは
  # どのファイルが追加されるか分からない。先に printf でファイル名自体を明示してから
  # 内容の diff を表示する（0 byte のファイルでも名前は必ず見える）。
  printf '%s\n' "--- ${f} ---"
  # バイナリファイルは git diff --no-index が "Binary files ... differ" としか出力せず、
  # 追加される中身を一切提示しない。numstat の追加/削除行数が両方 "-" になる出力で
  # バイナリ判定し、内容の代わりに種別・サイズ・ハッシュを明示することで、中身を
  # 確認できないまま承認（git add）だけが通ってしまう非対称を防ぐ。
  NUMSTAT="$(git diff --no-index --numstat -- /dev/null "${f}" 2>/dev/null || true)"
  if [[ "${NUMSTAT}" == -$'\t'-$'\t'* ]]; then
    FILE_SIZE="$(wc -c < "${f}" | tr -d '[:space:]')"
    if command -v file >/dev/null 2>&1; then
      FILE_TYPE="$(file -b -- "${f}" 2>/dev/null || echo "unknown")"
    else
      FILE_TYPE="file コマンド未検出"
    fi
    FILE_HASH="$(git hash-object -- "${f}")"
    # object format は repository 設定依存（既定 sha1 / 拡張 sha256）で出力桁数が変わる
    # （sha1: 40 桁 / sha256: 64 桁）。固定表記 "git-blob-sha1" だと sha256 リポジトリで
    # 実際のアルゴリズムと表示が食い違うため、表記自体をアルゴリズム非依存にする。
    OBJECT_FORMAT="$(git rev-parse --show-object-format 2>/dev/null || echo unknown)"
    printf '%s\n' "==> バイナリファイル（内容は表示されません）: type=${FILE_TYPE} size=${FILE_SIZE}bytes git-blob-hash(${OBJECT_FORMAT})=${FILE_HASH}"
  else
    # --no-index は index を変更しない（git add -N は使わない。呼び出し元の拒否経路が
    # index からの git checkout -- で承認済み他スキルの hash を復元する設計に依存しており、
    # intent-to-add エントリを混入させるとその復元設計と干渉するため）。
    # 差分ありのとき exit 1 を返す仕様のため、表示専用のこの呼び出しに限り || true で
    # set -e の中断を避ける（clean ガード等の fail-closed 判定には影響しない）。
    git diff --no-index -- /dev/null "${f}" || true
  fi
done < "${UNTRACKED_LIST_FILE}"
if [[ "${UNTRACKED_COUNT}" -eq 0 ]]; then
  echo "==> 新規（未追跡）ファイル: なし"
fi
}

preview_untracked ".agents/skills/${SKILL_NAME}/"

if [[ "${LOCAL_PATCH_GUARD}" == true ]]; then
  # 却下・失敗時の復元は「checker 初回実行より前」に取得済みの PRE_SYNC_TREE(同期開始前の
  # index snapshot)を使う。npx 後にここで snapshot を取り直すと、復元先が「raw upstream +
  # 同期前 check の stage」になり、「同期前へ戻す」という契約に反する(local patch が外れた
  # 状態が残る)。PRE_SYNC_TREE への read-tree は、この同期(pre-check・npx・apply)で生じた
  # 契約範囲の index 変更だけを取り除き、承認済みの他スキル分は snapshot に含まれるため保持される

  # 却下・失敗時の復元手順(stdout へ出す。エラー経路では >&2 で呼ぶ)。
  # PRE_SYNC_TREE は本 process 終了後に環境から消えるため、値そのものを展開して案内する
  restore_help() {
    echo "同期前へ戻すには(index を同期開始前 snapshot へ復元し、worktree を index から戻す):"
    echo "  git read-tree ${PRE_SYNC_TREE}"
    echo "  git checkout -- skills-lock.json"
    echo "  git checkout -- \".agents/skills/${SKILL_NAME}/\" 2>/dev/null || true"
    echo "  git checkout -- scripts/local-patches/ 2>/dev/null || true"
    echo "  git clean -fd \".agents/skills/${SKILL_NAME}/\" scripts/local-patches/"
  }

  echo ""
  echo "==> local patch を再適用(--3way fallback や index 復元により対象 file・durable patch が stage されることがある)"
  apply_rc=0
  bash scripts/check-skill-local-patches.sh apply || apply_rc=$?
  if ! verify_outside_and_checker; then
    restore_help >&2
    exit 1
  fi
  if [[ "${apply_rc}" -ne 0 ]]; then
    echo "エラー: local patch の再適用に失敗しました。stage・commit へ進まないでください(fail-closed)。" >&2
    restore_help >&2
    exit 1
  fi
  echo ""
  echo "==> 再適用後の最終検証"
  check_rc=0
  bash scripts/check-skill-local-patches.sh || check_rc=$?
  if ! verify_outside_and_checker; then
    restore_help >&2
    exit 1
  fi
  if [[ "${check_rc}" -ne 0 ]]; then
    echo "エラー: 再適用後の最終検証に失敗しました。stage・commit へ進まないでください(fail-closed)。" >&2
    restore_help >&2
    exit 1
  fi

  echo ""
  echo "==> 更新完了。commit 候補の最終差分(upstream 更新 + local patch 再適用。durable patch を含む):"
  git diff HEAD -- skills-lock.json ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
  echo ""
  echo "==> 契約範囲内の未追跡ファイル(git diff HEAD には表示されない。apply が新規作成した durable patch 等を含めて内容まで提示する):"
  preview_untracked ".agents/skills/${SKILL_NAME}/" scripts/local-patches/
  echo ""
  echo "却下する場合(当該スキルと durable patch を同期前へ戻す。他スキルの stage 済み変更には影響しない):"
  restore_help
fi

echo ""
echo "コミットするには:"
echo "  git add skills-lock.json"
echo "  git add .agents/skills/${SKILL_NAME}/  # 上記の未追跡ファイルもここで取り込まれる"
if [[ "${LOCAL_PATCH_GUARD}" == true && -d scripts/local-patches/ ]]; then
  echo "  git add scripts/local-patches/  # 承認対象に含めた durable patch の変更も同じ承認単位で stage する"
fi
echo "  git commit -m 'chore(skills-lock): ${SKILL_NAME} の computedHash を upstream と同期'"

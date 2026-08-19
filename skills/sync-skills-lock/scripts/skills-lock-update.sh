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

# git status --porcelain -z の1レコード（"XY PATH\0"）からスコープ内（skills-lock.json /
# .agents/skills/${SKILL_NAME}/ 配下）を除いたレコードだけを NUL 区切りで書き出す。
# これは Step 4 実行前後のスナップショット差分（scope-guard）専用のフィルタで、
# 未追跡ファイルのプレビュー表示（既存の git ls-files -z 経路。下部で継続使用）とは別物。
# ステータス文字の後の空白1文字を含む固定長プレフィックス（3文字）を切り落とすことで
# パスを取り出す。C-quote（改行等を含むパスのダブルクォート化）の影響を受けない。
filter_out_of_scope() {
  local infile="$1" outfile="$2" record path
  : > "${outfile}"
  while IFS= read -r -d '' record; do
    path="${record:3}"
    if [[ "${path}" == "skills-lock.json" || "${path}" == ".agents/skills/${SKILL_NAME}/"* ]]; then
      continue
    fi
    printf '%s\0' "${record}" >> "${outfile}"
  done < "${infile}"
}

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

# 一時ファイルは npx 実行前後のスナップショット比較に使うため、npx を呼ぶより前に
# すべて用意し、単一の trap へまとめて登録する（trap は後勝ちのため、複数箇所に
# 分散させると先に登録した分の掃除が消える）。UNTRACKED_LIST_FILE はこの後の
# 未追跡ファイル一覧化（プレビュー表示）でも使うため、ここでまとめて確保する。
SNAP_BEFORE="$(mktemp)"
SNAP_AFTER="$(mktemp)"
SNAP_FILTERED_BEFORE="$(mktemp)"
SNAP_FILTERED_AFTER="$(mktemp)"
NPX_OUTPUT_FILE="$(mktemp)"
UNTRACKED_LIST_FILE="$(mktemp)"
trap 'rm -f "${SNAP_BEFORE}" "${SNAP_AFTER}" "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}" "${NPX_OUTPUT_FILE}" "${UNTRACKED_LIST_FILE}"' EXIT

# npx 実行前のリポジトリ全体スナップショット（スコープ外書き込み検出の起点）。
# -z は改行等を含むパスでも1レコード1件を保つため、後段の filter_out_of_scope が
# C-quote に影響されず判定できる。-uall は新規ディレクトリの collapse
# （`?? .agents/` のような1行への丸め）を防ぐために必須（丸められると
# ディレクトリ配下の個々のパスがスコープ判定の対象に現れない）。
# status.renames=false で rename 検出を明示的に無効化し、2フィールド
# （新パス + 旧パス）のレコードが混入しない形にそろえる（既定でも通常は無効だが、
# ユーザー環境の git config 依存にしない）。
if ! git -c status.renames=false status --porcelain -z -uall > "${SNAP_BEFORE}"; then
  echo "エラー: npx 実行前の git status 取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

# npx skills add で CLI に computedHash を更新させる
# --yes（1つ目）は npx 自体のインストール確認プロンプトを非対話でスキップする
# ものであり、skills CLI へ渡す --yes（末尾）とは別物（位置で区別される）。
# skills@${SKILLS_CLI_VERSION} で exact 版のみ解決させ、該当版が存在しない・
# レジストリ到達不能の場合は npx が非ゼロ終了し set -euo pipefail で即停止する
# （fail-closed。最新版への暗黙フォールバック経路は存在しない）。
# --agent universal は書き込み先を union ストア（.agents/skills/<name>/）+
# skills-lock.json のみに限定する一次防御。個別 agent 指定（claude-code 等）は
# .agents/skills を経由せず .claude/skills/ 等へ直接コピーしレイアウトを変えるため
# 使わない（実測: スクラッチリポジトリで --agent universal のみ .agents/skills/
# 以外へ書き込みが無いことを確認済み）。npx の出力は tee で NPX_OUTPUT_FILE へも
# 保存し、後段の「Invalid agents」no-op 検出に使う。パイプの非ゼロ終了は
# `set -euo pipefail` の pipefail によりそのままスクリプト全体を停止させる
# （fail-closed。この行を `if` 条件に入れると errexit がこの行では働かなくなるため、
# npx 呼び出し自体は bare のまま1行を維持する。tests/version-pin.test.mjs の静的抽出
# も行頭 npx の1物理行を前提にしているため、バックスラッシュ継続で複数行に分けない）。
npx --yes "skills@${SKILLS_CLI_VERSION}" add "${SOURCE_REPO}" --skill "${SKILL_NAME}" --agent universal --yes 2>&1 | tee "${NPX_OUTPUT_FILE}"

# CLI がバージョン更新等で --agent universal を認識できなくなった場合、
# エラー表示のうえ exit 0 の no-op になる（実測: skills@1.5.22 で確認済み）。
# 検知せず先へ進むと「同期したつもりで何も更新されていない」まま完了扱いに
# なるため、明示的にエラー化する。
if grep -q "Invalid agents" "${NPX_OUTPUT_FILE}"; then
  echo "エラー: skills CLI が --agent universal を認識せず、何も実行していません（exit 0 の no-op）。SKILLS_CLI_VERSION 更新時は SKILL.md の「skills CLI のバージョン固定と更新手順」節に従い universal の有効性を再確認してください。" >&2
  exit 1
fi

# npx 実行後のスナップショット。前後のスコープ外差分を見るため、取得条件は
# SNAP_BEFORE と完全に揃える。
if ! git -c status.renames=false status --porcelain -z -uall > "${SNAP_AFTER}"; then
  echo "エラー: npx 実行後の git status 取得に失敗しました。スコープ外書き込みの検出ができないため中止します。" >&2
  exit 1
fi

filter_out_of_scope "${SNAP_BEFORE}" "${SNAP_FILTERED_BEFORE}"
filter_out_of_scope "${SNAP_AFTER}" "${SNAP_FILTERED_AFTER}"

# フィルタ後（スコープ外のみ）のスナップショットが前後で一致しなければ、
# --agent universal が抑止しているはずのスコープ外書き込みが発生したことになる
# （一次防御を突破した場合の多層防御）。git の porcelain -z 出力順は決定的なため
# ソート不要で cmp -s のバイト列比較のみで判定できる。
if ! cmp -s "${SNAP_FILTERED_BEFORE}" "${SNAP_FILTERED_AFTER}"; then
  echo "エラー: npx skills add がスコープ外（skills-lock.json / .agents/skills/${SKILL_NAME}/ 以外）へ書き込みました。" >&2
  echo "==> 実行前のスコープ外状態:" >&2
  while IFS= read -r -d '' rec; do printf '  %s\n' "${rec}" >&2; done < "${SNAP_FILTERED_BEFORE}"
  echo "==> 実行後のスコープ外状態:" >&2
  while IFS= read -r -d '' rec; do printf '  %s\n' "${rec}" >&2; done < "${SNAP_FILTERED_AFTER}"
  echo "スコープ内（skills-lock.json / .agents/skills/${SKILL_NAME}/）の変更はこれからリバートします。" >&2
  echo "スコープ外は既存の WIP を巻き込む恐れがあるため自動リバートしません。" >&2
  echo "上記パスの内容を git status / git diff で確認し、必要なら手動で" >&2
  echo "  git checkout -- <path>   （変更前が clean だった追跡ファイルの場合）" >&2
  echo "  git clean -fd <path>     （変更前に存在しなかった未追跡ファイルの場合）" >&2
  echo "を実行してください。" >&2
  # スコープ内リバート。git checkout -- は「対象なし」で失敗し得る（初回具現化・
  # 未追跡のみの書き込み時）ため || true で許容する。git clean -fd はディレクトリが
  # 存在しない場合に非ゼロ終了するため、存在確認してから呼ぶ（set -e 下で無条件に
  # 呼ぶとこのエラーメッセージより先にスクリプトが停止し得る）。
  git checkout -- skills-lock.json 2>/dev/null || true
  git checkout -- ".agents/skills/${SKILL_NAME}/" 2>/dev/null || true
  if [[ -d ".agents/skills/${SKILL_NAME}/" ]]; then
    git clean -fd ".agents/skills/${SKILL_NAME}/" || true
  fi
  exit 1
fi

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
UNTRACKED_COUNT=0
echo ""
# git ls-files をプロセス置換（`< <(...)`）へ直接つなぐと、`set -euo pipefail` は
# その終了コードを検査しない。`git ls-files` が失敗（破損 index・権限エラー等）しても
# while は単に0回実行され UNTRACKED_COUNT=0 のまま「新規（未追跡）ファイル: なし」と
# 誤表示し、実際には存在する未追跡ファイルの内容を確認しないまま呼び出し元が
# git add で承認してしまう（このスクリプトが防ごうとしている非対称そのもの）。
# 通常のコマンド置換で一時ファイルへ書き出し、`if ! ...` で明示的に終了コードを検査する
# ことで fail-closed にする。UNTRACKED_LIST_FILE 自体は npx 実行前のスナップショット
# 取得と同時に mktemp 済み（単一 trap にまとめるため）。
if ! git ls-files -z --others --exclude-standard -- ".agents/skills/${SKILL_NAME}/" > "${UNTRACKED_LIST_FILE}"; then
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

echo ""
echo "コミットするには:"
echo "  git add skills-lock.json"
echo "  git add .agents/skills/${SKILL_NAME}/  # 上記の未追跡ファイルもここで取り込まれる"
echo "  git commit -m 'chore(skills-lock): ${SKILL_NAME} の computedHash を upstream と同期'"

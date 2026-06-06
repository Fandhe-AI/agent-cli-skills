#!/usr/bin/env bash
# gh-issue.sh — gh issue create + sub-issues 紐付けの実例
#
# 使い方: ./script/gh-issue.sh <owner> <repo>
# 元スキル: skills/create-issue/SKILL.md（Step 2〜4）
#           skills/project-create-issues/SKILL.md（Step 3: 親 Issue を作成、Step 6: sub-issue 紐付け）
#
# 前提条件:
#   - gh CLI がインストールされ認証済みであること
#   - 対象リポジトリへの Issues 書き込み権限があること

set -euo pipefail

OWNER="${1:?第1引数 owner が必要です (例: Fandhe-AI)}"
REPO="${2:?第2引数 repo が必要です (例: agent-cli-skills)}"

# ----------------------------------------------------------------
# 親 Issue を作成する
# ----------------------------------------------------------------
# 返り値: 作成された Issue 番号（stdout）
create_parent_issue() {
  local title="$1"

  local issue_url
  issue_url=$(gh issue create \
    --repo "${OWNER}/${REPO}" \
    --title "${title}" \
    --body "$(cat <<'EOF'
## 概要

このトラッキング Issue の目的を記述する。

## 背景

なぜこの作業が必要か。

## 受け入れ条件

- [ ] 条件1
- [ ] 条件2

## 関連

- Figma: （あれば記載）
- 関連 Issue: #（あれば記載）
EOF
)" \
    --json url -q '.url')

  echo "${issue_url}"
}

# ----------------------------------------------------------------
# 子 Issue を作成する
# ----------------------------------------------------------------
# 返り値: 作成された Issue 番号（stdout）
create_child_issue() {
  local title="$1"
  local body="$2"

  local issue_url
  issue_url=$(gh issue create \
    --repo "${OWNER}/${REPO}" \
    --title "${title}" \
    --body "${body}" \
    --json url -q '.url')

  echo "${issue_url}"
}

# ----------------------------------------------------------------
# Issue のノード ID を取得する（sub_issue_id に必要）
# ----------------------------------------------------------------
get_issue_node_id() {
  local issue_number="$1"
  gh issue view "${issue_number}" \
    --repo "${OWNER}/${REPO}" \
    --json id -q '.id'
}

# ----------------------------------------------------------------
# Sub-issue として親 Issue に紐付ける
# ----------------------------------------------------------------
# 元スキル: create-issue/SKILL.md Step 4、project-create-issues/SKILL.md Step 6
add_sub_issue() {
  local parent_number="$1"
  local child_node_id="$2"

  gh api \
    --method POST \
    "repos/${OWNER}/${REPO}/issues/${parent_number}/sub_issues" \
    -f "sub_issue_id=${child_node_id}"
}

# ----------------------------------------------------------------
# Issue 番号を URL から抽出するヘルパー
# ----------------------------------------------------------------
extract_issue_number() {
  local issue_url="$1"
  # URL 末尾の数字を取り出す（例: .../issues/42 → 42）
  echo "${issue_url##*/}"
}

# ----------------------------------------------------------------
# メイン: 親 Issue + 子 Issue 2件 + sub-issues 紐付けのデモ
# ----------------------------------------------------------------
main() {
  echo "[INFO] 親 Issue を作成中..."
  local parent_url
  parent_url=$(create_parent_issue "feat: 認証機能の実装")
  local parent_number
  parent_number=$(extract_issue_number "${parent_url}")
  echo "[INFO] 親 Issue 作成完了: #${parent_number} (${parent_url})"

  echo "[INFO] 子 Issue 1 を作成中..."
  local child1_url
  child1_url=$(create_child_issue \
    "feat(auth): ソーシャルログイン実装" \
    "OAuth2 を使用した Google/GitHub ログインを実装する。")
  local child1_number
  child1_number=$(extract_issue_number "${child1_url}")
  echo "[INFO] 子 Issue 1 作成完了: #${child1_number}"

  echo "[INFO] 子 Issue 2 を作成中..."
  local child2_url
  child2_url=$(create_child_issue \
    "feat(auth): パスワードリセット機能を追加" \
    "メール経由のパスワードリセットフローを実装する。")
  local child2_number
  child2_number=$(extract_issue_number "${child2_url}")
  echo "[INFO] 子 Issue 2 作成完了: #${child2_number}"

  echo "[INFO] Sub-issue として紐付け中..."

  local child1_node_id
  child1_node_id=$(get_issue_node_id "${child1_number}")
  add_sub_issue "${parent_number}" "${child1_node_id}"
  echo "[INFO] #${child1_number} を #${parent_number} の sub-issue として登録"

  local child2_node_id
  child2_node_id=$(get_issue_node_id "${child2_number}")
  add_sub_issue "${parent_number}" "${child2_node_id}"
  echo "[INFO] #${child2_number} を #${parent_number} の sub-issue として登録"

  echo ""
  echo "=== 作成完了 ==="
  echo "  親 Issue: #${parent_number} ${parent_url}"
  echo "  子 Issue: #${child1_number} ${child1_url}"
  echo "  子 Issue: #${child2_number} ${child2_url}"
}

main "$@"

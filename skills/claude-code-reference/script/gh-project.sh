#!/usr/bin/env bash
# gh-project.sh — GitHub Projects v2 の実コマンド集
#
# 使い方: ./script/gh-project.sh <owner> <project-number>
# 元スキル: skills/project-add-items/SKILL.md（Step 3〜5）
#           skills/project-create-issues/SKILL.md（Step 5: item-add, item-edit, item-delete）
#           skills/project-update-items/SKILL.md（Step 2〜5）
#           skills/project-archive-done/SKILL.md（アーカイブ操作）
#
# 前提条件:
#   - gh CLI がインストールされ認証済みであること（project スコープ付き）
#   - gh auth status で project スコープがあることを確認

set -euo pipefail

OWNER="${1:?第1引数 owner が必要です (例: Fandhe-AI)}"
PROJECT_NUMBER="${2:?第2引数 project-number が必要です (例: 1)}"

# ----------------------------------------------------------------
# プロジェクト ID を取得する
# ----------------------------------------------------------------
get_project_id() {
  gh project view "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --format json \
    -q '.id'
}

# ----------------------------------------------------------------
# フィールド一覧とオプション ID を取得する（jq でパース）
# ----------------------------------------------------------------
# 元スキル: project-add-items/SKILL.md Step 3、project-update-items/SKILL.md Step 2
get_field_list() {
  gh project field-list "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --format json
}

# フィールド名→フィールド ID を解決する例（jq を使用）
# 例: get_field_id_by_name "Status"
get_field_id_by_name() {
  local field_name="$1"
  get_field_list | python3 -c "
import sys, json
data = json.load(sys.stdin)
fields = data.get('fields', [])
for f in fields:
    if f.get('name') == '${field_name}':
        print(f['id'])
        break
"
}

# フィールドのオプション名→オプション ID を解決する例
# 例: get_option_id_by_name "Status" "In Progress"
get_option_id_by_name() {
  local field_name="$1"
  local option_name="$2"
  get_field_list | python3 -c "
import sys, json
data = json.load(sys.stdin)
fields = data.get('fields', [])
for f in fields:
    if f.get('name') == '${field_name}':
        for opt in f.get('options', []):
            if opt.get('name') == '${option_name}':
                print(opt['id'])
                break
"
}

# ----------------------------------------------------------------
# アイテム一覧を取得する
# ----------------------------------------------------------------
# 元スキル: project-update-items/SKILL.md Step 3、project-create-issues/SKILL.md Step 1
list_items() {
  gh project item-list "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --format json \
    --limit 999
}

# DraftIssue のみを抽出する例
list_draft_items() {
  list_items | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
for item in items:
    if item.get('type') == 'DraftIssue':
        print(json.dumps(item, ensure_ascii=False))
"
}

# ----------------------------------------------------------------
# アイテムを作成する（DraftIssue）
# ----------------------------------------------------------------
# 元スキル: project-add-items/SKILL.md Step 4
create_draft_item() {
  local title="$1"
  local body="${2:-}"

  gh project item-create "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --title "${title}" \
    --body "${body}" \
    --format json
}

# ----------------------------------------------------------------
# アイテムにフィールド値を設定する
# ----------------------------------------------------------------
# 元スキル: project-add-items/SKILL.md Step 5、project-update-items/SKILL.md Step 5

# SINGLE_SELECT フィールドの設定例（Status / Priority / Size）
set_single_select_field() {
  local item_id="$1"
  local project_id="$2"
  local field_id="$3"
  local option_id="$4"

  gh project item-edit \
    --id "${item_id}" \
    --field-id "${field_id}" \
    --project-id "${project_id}" \
    --single-select-option-id "${option_id}"
}

# TEXT フィールドの設定例
set_text_field() {
  local item_id="$1"
  local project_id="$2"
  local field_id="$3"
  local text_value="$4"

  gh project item-edit \
    --id "${item_id}" \
    --field-id "${field_id}" \
    --project-id "${project_id}" \
    --text "${text_value}"
}

# NUMBER フィールドの設定例
set_number_field() {
  local item_id="$1"
  local project_id="$2"
  local field_id="$3"
  local number_value="$4"

  gh project item-edit \
    --id "${item_id}" \
    --field-id "${field_id}" \
    --project-id "${project_id}" \
    --number "${number_value}"
}

# DATE フィールドの設定例（YYYY-MM-DD 形式）
set_date_field() {
  local item_id="$1"
  local project_id="$2"
  local field_id="$3"
  local date_value="$4"  # 例: 2026-06-30

  gh project item-edit \
    --id "${item_id}" \
    --field-id "${field_id}" \
    --project-id "${project_id}" \
    --date "${date_value}"
}

# ----------------------------------------------------------------
# Issue をプロジェクトに追加する（DraftIssue → 実 Issue 変換後に使用）
# ----------------------------------------------------------------
# 元スキル: project-create-issues/SKILL.md Step 5
add_issue_to_project() {
  local issue_url="$1"

  gh project item-add "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --url "${issue_url}" \
    --format json
}

# ----------------------------------------------------------------
# DraftIssue アイテムを削除する
# ----------------------------------------------------------------
# 元スキル: project-create-issues/SKILL.md Step 5
delete_draft_item() {
  local item_id="$1"

  gh project item-delete "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --id "${item_id}"
}

# ----------------------------------------------------------------
# アイテムをアーカイブする（Done 状態のアイテムをアーカイブ等）
# ----------------------------------------------------------------
# 元スキル: skills/project-archive-done/SKILL.md
archive_item() {
  local item_id="$1"

  gh project item-archive "${PROJECT_NUMBER}" \
    --owner "${OWNER}" \
    --id "${item_id}"
}

# ----------------------------------------------------------------
# メイン: 動作確認用のデモ（実際には各関数を用途に合わせて呼び出す）
# ----------------------------------------------------------------
main() {
  echo "[INFO] プロジェクト情報を確認中..."
  local project_id
  project_id=$(get_project_id)
  echo "[INFO] プロジェクト ID: ${project_id}"

  echo "[INFO] フィールド一覧を取得中..."
  get_field_list | python3 -m json.tool | head -40

  echo ""
  echo "[INFO] アイテム一覧を取得中..."
  list_items | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
print(f'合計 {len(items)} 件')
for item in items[:5]:
    print(f'  - {item.get(\"title\", \"(タイトルなし)\")} [{item.get(\"type\")}]')
"

  echo ""
  echo "[INFO] 使用例（コメントアウトを外して使用）:"
  echo "  create_draft_item \"feat: 新機能タイトル\" \"本文説明\""
  echo "  set_single_select_field \"\$item_id\" \"\$project_id\" \"\$status_field_id\" \"\$in_progress_option_id\""
}

main "$@"

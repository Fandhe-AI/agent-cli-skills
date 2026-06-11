#!/usr/bin/env bash
# preview-tree.sh — 親イシューの配下を post-order DFS で実行順序プレビューする（実装は行わない）
#
# 使い方:
#   ./preview-tree.sh <親イシュー番号>
#
# 前提:
#   - gh CLI がインストールされ認証済みであること
#   - カレントディレクトリがリポジトリ内であること

set -euo pipefail

PARENT="${1:-}"
if [[ -z "${PARENT}" ]]; then
  echo "使い方: $0 <親イシュー番号>" >&2
  exit 1
fi

if ! [[ "${PARENT}" =~ ^[0-9]+$ ]]; then
  echo "エラー: イシュー番号は正の整数で指定してください（例: $0 42）" >&2
  exit 1
fi

if ! command -v gh &> /dev/null; then
  echo "エラー: gh CLI がインストールされていません" >&2
  exit 1
fi

if ! gh auth status &> /dev/null; then
  echo "エラー: gh CLI が認証されていません。gh auth login を実行してください" >&2
  exit 1
fi

# post-order DFS でイシュー番号を収集する（子をすべて列挙してから親を追加）
declare -a POSTORDER=()
declare -A HAS_CHILDREN=()

collect_postorder() {
  local issue_number="$1"

  # まず子を再帰取得（post-order: 子が先、親が後）
  local sub_issues
  sub_issues=$(gh api "repos/{owner}/{repo}/issues/${issue_number}/sub_issues?per_page=100" --jq '.[].number' 2>/dev/null || true)
  if [[ -n "${sub_issues}" ]]; then
    HAS_CHILDREN["${issue_number}"]=1
    while IFS= read -r child_number; do
      collect_postorder "${child_number}"
    done <<< "${sub_issues}"
  fi

  # 子の後に自身を追加（post-order）
  POSTORDER+=("${issue_number}")
}

echo "=== 実行順序プレビュー（post-order DFS）: #${PARENT} ==="
echo ""
echo "ツリーを取得中..."
collect_postorder "${PARENT}"
echo ""
printf "%-5s %-8s %-10s %s\n" "順序" "番号" "種別" "タイトル [状態]"
echo "------------------------------------------------------------"

for i in "${!POSTORDER[@]}"; do
  issue="${POSTORDER[$i]}"
  info=$(gh api "repos/{owner}/{repo}/issues/${issue}" --jq '"#\(.number) [\(.state)] \(.title)"' 2>/dev/null || echo "#${issue} [取得失敗]")

  if [[ -n "${HAS_CHILDREN[${issue}]:-}" ]]; then
    kind="verify-close"
  else
    kind="implement"
  fi

  printf "%-5d %-10s %s\n" "$((i + 1))" "${kind}" "${info}"
done

echo ""
echo "合計 ${#POSTORDER[@]} 件"
echo "（このスクリプトは表示のみ行います。実装は implement-issue-tree workflow を使用してください）"

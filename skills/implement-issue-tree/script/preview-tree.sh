#!/usr/bin/env bash
# preview-tree.sh — 親イシューの配下を post-order DFS で表示する（実装は行わない）
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

if ! command -v gh &> /dev/null; then
  echo "エラー: gh CLI がインストールされていません" >&2
  exit 1
fi

if ! gh auth status &> /dev/null; then
  echo "エラー: gh CLI が認証されていません。gh auth login を実行してください" >&2
  exit 1
fi

# イシュー情報を取得して表示
fetch_subtree() {
  local issue_number="$1"
  local depth="$2"
  local indent=""
  for ((i = 0; i < depth; i++)); do indent+="  "; done

  local info
  info=$(gh api "repos/{owner}/{repo}/issues/${issue_number}" --jq '"\(.number) [\(.state)] \(.title)"' 2>/dev/null || echo "${issue_number} [取得失敗]")
  echo "${indent}#${info}"

  # サブイシューを再帰取得
  local sub_issues
  sub_issues=$(gh api "repos/{owner}/{repo}/issues/${issue_number}/sub_issues?per_page=100" --jq '.[].number' 2>/dev/null || true)
  if [[ -n "${sub_issues}" ]]; then
    while IFS= read -r child_number; do
      fetch_subtree "${child_number}" "$((depth + 1))"
    done <<< "${sub_issues}"
  fi
}

echo "=== イシューツリープレビュー: #${PARENT} ==="
echo ""
fetch_subtree "${PARENT}" 0
echo ""
echo "（このスクリプトは表示のみ行います。実装は implement-issue-tree workflow を使用してください）"

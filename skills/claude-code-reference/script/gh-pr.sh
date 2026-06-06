#!/usr/bin/env bash
# gh-pr.sh — gh pr create の実例（body を HEREDOC で安全に渡す）
#
# 使い方: ./script/gh-pr.sh
# 元スキル: skills/create-pr/SKILL.md（Step 5: PR を作成する）
#           skills/contribute-skill/SKILL.md（Step 10: push と PR 作成）
#
# 前提条件:
#   - gh CLI がインストールされ認証済みであること（gh auth status で確認）
#   - 現在のブランチがベースブランチからフォークされていること
#   - セキュリティチェック（OWASP Top 10・シークレット確認）を事前に実施済みであること

set -euo pipefail

# ----------------------------------------------------------------
# 変数（呼び出し元で設定するか引数で渡す）
# ----------------------------------------------------------------
BASE_BRANCH="${1:-main}"
PR_TITLE="${2:-feat(scope): subject を記入してください}"

# ----------------------------------------------------------------
# 事前確認
# ----------------------------------------------------------------
preflight_check() {
  # gh CLI の認証確認
  if ! gh auth status &>/dev/null; then
    echo "[ERROR] gh CLI が認証されていません。gh auth login を実行してください。" >&2
    exit 1
  fi

  # ベースブランチとの差分確認
  echo "[INFO] ベースブランチ (${BASE_BRANCH}) との差分:"
  git log "${BASE_BRANCH}..HEAD" --oneline
  echo ""
  git diff "${BASE_BRANCH}...HEAD" --stat
  echo ""
}

# ----------------------------------------------------------------
# PR 作成（body は HEREDOC で渡す）
# ----------------------------------------------------------------
create_pr() {
  local title="$1"
  local base="$2"

  gh pr create \
    --base "${base}" \
    --title "${title}" \
    --body "$(cat <<'EOF'
## Summary

- 変更内容の箇条書き1
- 変更内容の箇条書き2

## Test plan

- [ ] 動作確認手順1
- [ ] 動作確認手順2
- [ ] エッジケース確認

## Design

- Figma: （あれば記載）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
}

# ----------------------------------------------------------------
# Draft PR の例（ユーザー確認後に --draft を付ける）
# ----------------------------------------------------------------
create_draft_pr() {
  local title="$1"
  local base="$2"

  gh pr create \
    --draft \
    --base "${base}" \
    --title "${title}" \
    --body "$(cat <<'EOF'
## Summary

WIP: 作業中の変更。

## Test plan

- [ ] 未完了

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
}

# ----------------------------------------------------------------
# PR に reviewers / labels を追加する例
# ----------------------------------------------------------------
create_pr_with_options() {
  local title="$1"
  local base="$2"
  local reviewer="${3:-}"   # GitHub username（任意）
  local label="${4:-}"      # ラベル名（任意）

  gh pr create \
    --base "${base}" \
    --title "${title}" \
    ${reviewer:+--reviewer "${reviewer}"} \
    ${label:+--label "${label}"} \
    --body "$(cat <<'EOF'
## Summary

- ...

## Test plan

- [ ] ...

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
}

# ----------------------------------------------------------------
# メイン
# ----------------------------------------------------------------
main() {
  preflight_check

  # 通常の PR 作成例
  # create_pr "${PR_TITLE}" "${BASE_BRANCH}"

  # Draft PR 作成例
  # create_draft_pr "${PR_TITLE}" "${BASE_BRANCH}"

  # reviewer / label 付き PR 作成例
  # create_pr_with_options "${PR_TITLE}" "${BASE_BRANCH}" "<reviewer-username>" "enhancement"

  echo "[INFO] PR_TITLE と BASE_BRANCH を設定し、関数呼び出しのコメントを外して実行してください。"
  echo "  PR_TITLE 例: feat(auth): ソーシャルログイン機能を追加"
}

main "$@"

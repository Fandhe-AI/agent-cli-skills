#!/usr/bin/env bash
# git-commit.sh — Conventional Commits 形式でのコミット実例
#
# 使い方: ./script/git-commit.sh
# 元スキル: skills/create-commit/SKILL.md（Step 5: コミットを実行する）
#           skills/contribute-skill/SKILL.md（Step 9: ブランチ作成・コミット）
#           .claude/rules/conventional-commits.md（コミット実行パターン）
#
# 重要:
#   - --no-verify は絶対に使用しない（pre-commit フック回避禁止）
#   - body に HEREDOC を使うと特殊文字・シングルクォートを安全に扱える
#   - .env や認証情報ファイルが staged に含まれる場合はコミットを中止する

set -euo pipefail

# ----------------------------------------------------------------
# シークレット混入チェック
# ----------------------------------------------------------------
check_no_secrets() {
  local secret_files
  secret_files=$(git diff --cached --name-only | grep -E '(\.env|credentials\.json|\.pem|\.key|id_rsa)' || true)

  if [[ -n "$secret_files" ]]; then
    echo "[ERROR] シークレットが含まれる可能性のあるファイルが staged に含まれています:" >&2
    echo "$secret_files" >&2
    echo "[ERROR] git restore --staged <ファイル名> でステージングを解除してください。" >&2
    exit 1
  fi
}

# ----------------------------------------------------------------
# staged 変更の確認
# ----------------------------------------------------------------
check_staged() {
  local staged
  staged=$(git diff --cached --name-only)

  if [[ -z "$staged" ]]; then
    echo "[INFO] staged な変更がありません。git add でファイルをステージングしてください。"
    git status
    exit 1
  fi

  echo "[INFO] staged ファイル:"
  git diff --cached --name-only
  echo ""
}

# ----------------------------------------------------------------
# コミット実行（HEREDOC を使って特殊文字を安全に渡す）
# ----------------------------------------------------------------
# 引数: TYPE SCOPE SUBJECT [BODY]
#   TYPE:    Conventional Commits の type（feat, fix, docs, refactor, test, chore, ...）
#   SCOPE:   スコープ（省略可。省略する場合は "" を渡す）
#   SUBJECT: コミットメッセージの件名（72文字以内、命令形・現在形）
#   BODY:    コミットメッセージの本文（任意）
do_commit() {
  local type="${1:?TYPE が必要です}"
  local scope="${2:-}"
  local subject="${3:?SUBJECT が必要です}"
  local body="${4:-}"

  # scope がある場合は括弧付きで結合
  local scope_part=""
  if [[ -n "$scope" ]]; then
    scope_part="(${scope})"
  fi

  # 件名の長さチェック
  local full_subject="${type}${scope_part}: ${subject}"
  if [[ ${#full_subject} -gt 72 ]]; then
    echo "[WARN] 件名が 72 文字を超えています (${#full_subject} 文字): ${full_subject}" >&2
  fi

  if [[ -n "$body" ]]; then
    git commit -m "$(cat <<EOF
${type}${scope_part}: ${subject}

${body}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
  else
    git commit -m "$(cat <<EOF
${type}${scope_part}: ${subject}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
  fi
}

# ----------------------------------------------------------------
# 使用例（実際の引数は書き換えて使う）
# ----------------------------------------------------------------
main() {
  check_staged
  check_no_secrets

  # 例 1: feat(auth): ソーシャルログイン機能を追加
  # do_commit "feat" "auth" "ソーシャルログイン機能を追加"

  # 例 2: fix(api): レスポンスのエラーハンドリングを修正（本文付き）
  # do_commit "fix" "api" "レスポンスのエラーハンドリングを修正" "500 エラー時に詳細メッセージを返すよう修正。\nRefs #42"

  # 例 3: chore(skills): symlink を作成（scope なし）
  # do_commit "chore" "" "symlink を作成"

  # 例 4: Breaking Change
  # do_commit "feat!" "auth" "認証 API の仕様を変更" "BREAKING CHANGE: レスポンス形式が v1 と互換性なし。移行手順は docs/ 参照。"

  echo "[INFO] 使用例をコメントアウトから選択して実行してください。"
  echo "       型: feat fix docs refactor test chore style build ci perf"
}

main "$@"

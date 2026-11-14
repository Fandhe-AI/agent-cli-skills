#!/usr/bin/env bash
# codex-session-start.sh: Codex の SessionStart hook。stdout はセッションの追加コンテキストに
# なるため、短いリマインダーだけを出す。入力（stdin）は使わない。
cat >/dev/null 2>&1 || true
cat <<'MSG'
- 日本語でやりとりする
- コミットは Conventional Commits（type(scope): subject）。--no-verify と force push は禁止
- 実装は計画をユーザーが承認してから始める
- サブエージェントによるマージ・承認・リポジトリ設定変更は hook が拒否する
MSG

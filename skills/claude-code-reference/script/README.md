# script/ — 実行可能コマンド集

このリポジトリで Claude が実際に使っているコマンドを、動作するシェルスクリプトとして整備したリファレンス集。
各スクリプトは「どのスキルのどのステップが元ネタか」を冒頭コメントに記載している。

## スクリプト一覧

| ファイル | 用途 | 元スキル |
|---------|------|---------|
| `git-commit.sh` | Conventional Commits 形式でのコミット（HEREDOC、シークレット混入チェック） | `create-commit`, `contribute-skill`, `conventional-commits.md` |
| `gh-pr.sh` | `gh pr create` の実例（body を HEREDOC で渡す、Draft PR、reviewer/label 付き） | `create-pr`, `contribute-skill` |
| `gh-issue.sh` | `gh issue create` + sub-issues 紐付け（`gh api .../sub_issues`） | `create-issue`, `project-create-issues` |
| `gh-project.sh` | `gh project item-create` / `item-edit` / `item-delete` / `item-archive` など Projects v2 の実コマンド | `project-add-items`, `project-create-issues`, `project-update-items` |
| `skills-sync.sh` | symlink 作成（`ln -s ../../skills/<name> .claude/skills/<name>`）と skills-lock.json の状態確認 | `contribute-skill`, `sync-skills-lock`, `skill-authoring.md` |
| `frontmatter-check.sh` | 全 SKILL.md / agent / rule の frontmatter 必須項目と symlink リンク切れを検査（読み取り専用） | `frontmatter-linter` agent |

## 使い方

```bash
# スクリプトに実行権限を付与
chmod +x skills/claude-code-reference/script/*.sh

# コミットのヘルパーを確認
./skills/claude-code-reference/script/git-commit.sh

# PR 作成の確認
./skills/claude-code-reference/script/gh-pr.sh main "feat(auth): ソーシャルログイン機能を追加"

# Issue 作成と sub-issues 紐付け
./skills/claude-code-reference/script/gh-issue.sh <owner> <repo>

# GitHub Projects v2 の操作
./skills/claude-code-reference/script/gh-project.sh <owner> <project-number>

# symlink 作成（新スキル追加後）
./skills/claude-code-reference/script/skills-sync.sh <skill-name>

# 全スキルの状態確認（symlink + symlink 切れ）
./skills/claude-code-reference/script/skills-sync.sh

# frontmatter 全チェック
./skills/claude-code-reference/script/frontmatter-check.sh --all

# SKILL.md のみチェック
./skills/claude-code-reference/script/frontmatter-check.sh --skills
```

## 設計原則

全スクリプト共通で以下の規約に従っている:

1. **冒頭に `#!/usr/bin/env bash` と `set -euo pipefail`** — エラーで即座に停止し、未定義変数・パイプ失敗を検出する
2. **変数は必ずダブルクォートで囲む** — コマンドインジェクション対策（`"$var"` 形式）
3. **プレースホルダは `<owner>` `<repo>` `<number>` 形式** — 実際の値に置き換えて使用
4. **破壊的操作なし** — `rm -rf`・`git push --force`・`git commit --no-verify` は含まない
5. **読み取り専用スクリプトは副作用なし** — `frontmatter-check.sh` はファイルを変更しない

## 注意事項

- 各スクリプトはデモ用の「使用例」。実際の引数・タイトルは書き換えて使用すること
- GitHub 操作（`gh` コマンド）は `gh auth status` で認証済みであることを確認してから実行
- sandbox 環境では `GIT_SSL_NO_VERIFY=1` の併用が必要な場合がある（`docs/sandbox-tls.md` 参照）

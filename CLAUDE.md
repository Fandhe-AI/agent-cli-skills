# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code 向けの CLI ワークフロースキル集。コミット・PR・Issue・レビューなどの開発ワークフローを Conventional Commits 準拠で自動化する。インストールは [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用。

## Repository Structure

```
skills/                           -- スキル本体（各ディレクトリに SKILL.md）
.claude/
  agents/plan-verifier.md         -- 計画検証 Agent（読み取り専用, Sonnet）
  rules/dotclaude-via-temp.md     -- .claude/ 操作時の一時ディレクトリルール
  skills/                         -- skills/ へのシンボリックリンク
```

## Current Skills (17)

### 開発ワークフロー (8)

create-commit, create-issue, create-plan, create-pr, implement-issue, implement-review, implement-review-pr, update-docs

### GitHub Projects 管理 (7)

project-init, project-add-items, project-create-issues, project-view-status, project-update-items, project-sync-issues, project-archive-done

### 上流貢献 (2)

contribute-skill, sync-skills-lock

## Conventions

### Conventional Commits

全スキルで `type(scope): subject` 形式を徹底。

- **Types:** feat, fix, docs, refactor, test, chore, style, build, ci, perf
- **Subject:** 72 文字以下、命令形/現在形、日本語可
- **Breaking Changes:** `!` 接尾辞 or body に `BREAKING CHANGE:`

### .claude/ ディレクトリ操作

`.claude/` 配下のファイル作成・編集は `_/dotclaude/` で一時作業し、完了後に `mv` で移動する。`rm -rf _/dotclaude` は禁止（共有ディレクトリのため `rmdir` で空ディレクトリのみ削除）。

### セキュリティレビュー

create-pr, implement-issue, implement-review, implement-review-pr で OWASP Top 10・ハードコードされた秘密情報・XSS・入力バリデーション・認証認可を必須チェック。セキュリティ問題がある場合はマージをブロック。

### ユーザー承認フロー

implement-issue は計画作成後にユーザー承認を必須とする。承認なしで実装を開始してはならない。

### 日本語出力

全スキルの出力・レポートは日本語で記述する。

## Skill Anatomy

各スキルは `skills/<name>/SKILL.md` に YAML frontmatter + 手順を記述する。`.claude/skills/` からシンボリックリンクで参照される。

```yaml
---
name: <skill-name>
description: <one-line description>
---
```

## Adding a New Skill

1. `skills/<name>/SKILL.md` を作成（frontmatter + 手順）
2. `.claude/skills/<name>` にシンボリックリンクを作成: `ln -s ../../skills/<name> .claude/skills/<name>`
3. `update-docs` スキルで CLAUDE.md のスキル一覧・構成を更新

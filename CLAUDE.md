# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code 向けの CLI ワークフロースキル集。コミット・PR・Issue・レビューなどの開発ワークフローを Conventional Commits 準拠で自動化する。インストールは [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用。

## Repository Structure

```
skills/                               -- スキル本体（各ディレクトリに SKILL.md）
  create-commit/
  create-issue/
  create-plan/
  create-pr/
  implement-issue/
  implement-issue-tree/
    sample/                           -- 引数例・ツリー例
    script/                           -- preview-tree.sh（ツリー確認用）
  implement-review/
  implement-review-pr/
  update-docs/
  claude-code-reference/
    reference/                        -- 公式仕様要約
    sample/                           -- 実例
    script/                           -- 実行可能コマンド集
  project-init/
  project-add-items/
  project-create-issues/
  project-view-status/
  project-update-items/
  project-sync-issues/
  project-archive-done/
  contribute-skill/
  sync-skills-lock/
.claude/
  agents/
    research/
      skill-explorer.md               -- skills/ 横断調査・読み取り専用（Sonnet）
      sub-investigator.md             -- gh/git/CLI/hook 失敗調査（Sonnet）
      reference-researcher.md         -- 公式ドキュメント調査（Sonnet）
    author/
      skill-author.md                 -- skills/<name>/SKILL.md 作成編集（Sonnet）
      agent-author.md                 -- .claude/agents 作成編集（Sonnet）
      rules-author.md                 -- .claude/rules 作成編集（Sonnet）
      docs-writer.md                  -- CLAUDE.md/README 一覧・ツリー更新（Haiku）
    quality/
      skill-reviewer.md               -- SKILL.md 品質レビュー・読み取り専用（Sonnet）
      security-auditor.md             -- OWASP 監査・読み取り専用（Sonnet）
      frontmatter-linter.md           -- frontmatter/symlink 機械検証（Haiku）
      plan-verifier.md                -- 計画検証・読み取り専用（Sonnet）
  rules/
    delegation.md                     -- 委譲の原則（調査・設計フェーズ）
    delegation-impl.md                -- 委譲マッピング（作成・編集フェーズ）
    skill-authoring.md                -- スキル著作規約
    agent-authoring.md                -- エージェント著作規約
    conventional-commits.md           -- Conventional Commits 詳細規約
    security.md                       -- セキュリティチェック規約
    japanese-style.md                 -- 日本語スタイルガイド
    dotclaude-via-temp.md             -- .claude/ 操作時の一時ディレクトリルール
    description-style.md              -- description 著作スタイル
    reference-template.md             -- reference 型スキルの書式規約
  skills/                             -- skills/ へのシンボリックリンク（一部実ディレクトリ）
    create-skill/                     -- リポジトリ管理スキル（実ディレクトリ）
    create-agent/                     -- リポジトリ管理スキル（実ディレクトリ）
    update-reference/                 -- リポジトリ管理スキル（実ディレクトリ）
    github-docs                       -- 参照スキル（symlink）
    (他 create-commit 等は skills/ への symlink)
  workflows/
    implement-issue-tree.js           -- イシューツリー自動開発 Workflow
  settings.local.json                 -- ローカル権限設定（git 管理対象外）
  settings.json                       -- hooks 設定（SessionStart リマインダー）
```

## 委譲方針（必読）

main の役割は **対話・計画・委譲・報告** に徹する。token を消費する作業（調査・ファイル作成・編集・レビュー）は専門サブエージェントへ委譲する。

### パスベースの目安

| 操作対象パス | モード | 適用ルール |
|------------|--------|-----------|
| `_/`・`docs/`・`.claude/` の**閲覧のみ** | 調査・設計モード | `.claude/rules/delegation.md` |
| `skills/`・`.claude/agents/`・`.claude/rules/`・`CLAUDE.md` の**作成・編集** | 作成・編集モード | `.claude/rules/delegation-impl.md` |

### model 配分戦略

| 用途 | model |
|------|-------|
| 判定・生成（スキル著作・レビュー・調査） | Sonnet |
| 機械的・集計処理（frontmatter lint・ドキュメント更新） | Haiku |
| 複雑な計画立案 | Opus |

### 並列化

独立タスクは**同一メッセージ内で複数 Agent を起動**して並列実行する。依存関係がある場合のみ逐次実行。

例: 「skill-explorer で横断調査」と「reference-researcher で外部仕様確認」は並列起動可。

## Sub-agents

サブエージェントは `.claude/agents/` 配下に `subagent_type: <name>` frontmatter を持つ。`subagent_type: <name>` で呼び出す。

### research/ — 調査系（読み取り専用）

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-explorer` | Sonnet | skills/ 横断調査・仕様把握 |
| `sub-investigator` | Sonnet | gh/git/CLI/hook 失敗の調査 |
| `reference-researcher` | Sonnet | 公式ドキュメント・外部仕様の調査 |

### author/ — 作成・編集系

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-author` | Sonnet | `skills/<name>/SKILL.md` の作成・編集 |
| `agent-author` | Sonnet | `.claude/agents/` の作成・編集（dotclaude-via-temp 準拠） |
| `rules-author` | Sonnet | `.claude/rules/` の作成・編集（dotclaude-via-temp 準拠） |
| `docs-writer` | Haiku | `CLAUDE.md`・`README.md` の一覧・ツリー更新 |

### quality/ — 品質・検証系（読み取り専用）

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-reviewer` | Sonnet | SKILL.md の品質レビュー |
| `security-auditor` | Sonnet | OWASP Top 10 セキュリティ監査 |
| `frontmatter-linter` | Haiku | frontmatter・symlink の機械検証 |
| `plan-verifier` | Sonnet | 計画ファイルの完了検証 |

## Rules

| ファイル | 対象 | 概要 |
|---------|------|------|
| `delegation.md` | main | 調査・設計フェーズの委譲原則 |
| `delegation-impl.md` | main / author 系 Agent | 作成・編集フェーズの委譲マッピング |
| `skill-authoring.md` | skill-author / skill-reviewer | スキル著作フォーマット・品質基準 |
| `agent-authoring.md` | agent-author | エージェント著作フォーマット・品質基準 |
| `conventional-commits.md` | create-commit / create-pr 等 | Conventional Commits 詳細規約 |
| `security.md` | security-auditor / create-pr 等 | OWASP Top 10 セキュリティチェック基準 |
| `japanese-style.md` | 全 Agent | 日本語スタイルガイド |
| `dotclaude-via-temp.md` | agent-author / rules-author | `.claude/` 操作時の一時ディレクトリルール |
| `description-style.md` | skill-author / agent-author / skill-reviewer / reference-researcher | description 著作スタイル（発火率・長さ・YAML 落とし穴） |
| `reference-template.md` | reference-researcher / skill-author | reference 型スキルの reference/*.md と README 索引の書式規約 |

## Current Skills (19)

### 開発ワークフロー (9)

create-commit, create-issue, create-plan, create-pr, implement-issue, implement-issue-tree, implement-review, implement-review-pr, update-docs

### スキル著作・リファレンス (1)

claude-code-reference

### GitHub Projects 管理 (7)

project-init, project-add-items, project-create-issues, project-view-status, project-update-items, project-sync-issues, project-archive-done

### 上流貢献 (2)

contribute-skill, sync-skills-lock

### リポジトリ管理スキル（.claude/skills/ に配置）

create-skill, create-agent, update-reference

### 参照スキル（.claude/skills/ に配置）

github-docs

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

## hooks（settings.json）

`.claude/settings.json` に SessionStart hook を設定する。セッション開始時に以下のリマインダーを echo で出力する:

- 日本語でやりとりする
- 作業は subagent へ委譲し main の token 消費を抑える（delegation.md / delegation-impl.md）
- `.claude/` 配下の編集は `_/dotclaude/` 経由（dotclaude-via-temp）
- Conventional Commits 厳守（`--no-verify` 禁止）
- implement-issue は計画承認後に実装

## Skill Anatomy

各スキルは `skills/<name>/SKILL.md` に YAML frontmatter + 手順を記述する。`.claude/skills/` からシンボリックリンクで参照される。

```yaml
---
name: <skill-name>
description: <one-line description>
---
```

## Adding a New Skill

1. `create-skill` スキルを呼び出す（scaffold・symlink・update-docs まで自動化）。
   または手動で行う場合:
   1. `skills/<name>/SKILL.md` を作成（frontmatter + 手順）
   2. `.claude/skills/<name>` にシンボリックリンクを作成:
      `ln -s ../../skills/<name> .claude/skills/<name>`
   3. `update-docs` スキルで CLAUDE.md のスキル一覧・構成を更新

## Adding a New Agent

1. `create-agent` スキルを呼び出す（dotclaude-via-temp 準拠で scaffold）。
   または手動で行う場合:
   1. `_/dotclaude/agents/<category>/<name>.md` に frontmatter + 手順を作成
   2. `mv` で `.claude/agents/<category>/<name>.md` に移動
   3. `update-docs` スキルで CLAUDE.md の Sub-agents 一覧を更新

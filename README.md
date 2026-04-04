# Agent CLI Skills

Claude Code 向けの CLI ワークフロースキル集です。コミット作成、PR 作成、Issue 管理、コードレビューなど、日常的な開発ワークフローを Conventional Commits 準拠で自動化します。

インストールには [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用します。

## 使い方 — スキルの追加

```bash
# スキル一覧を表示
npx skills add Fandhe-AI/agent-cli-skills --list

# 特定のスキルを追加（例: create-commit）
npx skills add Fandhe-AI/agent-cli-skills --skill create-commit

# 複数のスキルを追加
npx skills add Fandhe-AI/agent-cli-skills --skill create-commit --skill create-pr --skill implement-review

# 全スキルを追加
npx skills add Fandhe-AI/agent-cli-skills --all
```

デフォルトではシンボリックリンクとして `.claude/skills/` に追加されます。`--copy` でファイルコピー、`-g` でグローバル (`~/.claude/skills/`) にインストールできます。

## リポジトリ構成

```
.claude/
  agents/
    plan-verifier.md              -- 計画ファイルの検証 Agent（読み取り専用）
  rules/
    dotclaude-via-temp.md         -- .claude ディレクトリ操作ルール
  skills/                         -- シンボリックリンク（skills/ → .claude/skills/）
skills/
  create-commit/
    SKILL.md                      -- Conventional Commits 形式でコミット作成
  create-issue/
    SKILL.md                      -- GitHub Issue を親子構造で作成
  create-plan/
    SKILL.md                      -- 実装計画ファイルを作成
  create-pr/
    SKILL.md                      -- Conventional Commits 形式で PR 作成
  implement-issue/
    SKILL.md                      -- Issue を読み込み計画・実装
  implement-review/
    SKILL.md                      -- コード変更の品質・セキュリティレビュー
  implement-review-pr/
    SKILL.md                      -- PR の CI・品質・規約レビュー
  project-init/
    SKILL.md                      -- GitHub Project v2 作成・フィールド設定
  project-add-items/
    SKILL.md                      -- 要件ドキュメントからアイテム一括作成
  project-create-issues/
    SKILL.md                      -- ドラフト→Issue 変換・sub-issue 紐付け
  project-view-status/
    SKILL.md                      -- 進捗状況の集計・レポート生成
  project-update-items/
    SKILL.md                      -- フィールド値の一括更新
  project-sync-issues/
    SKILL.md                      -- Issue 状態とプロジェクトの同期
  project-archive-done/
    SKILL.md                      -- 完了アイテムのアーカイブ
  update-docs/
    SKILL.md                      -- コード変更に基づく CLAUDE.md 更新
```

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| **create-commit** | `git diff` を分析し、Conventional Commits 形式でコミットメッセージを生成・実行する |
| **create-issue** | タスクを分析し、GitHub Issue を親子構造（sub-issues）で作成する |
| **create-plan** | コードベースを調査し、実装計画を `_/local-plans/` に作成する |
| **create-pr** | 変更内容のセキュリティチェック後、Conventional Commits 形式で PR を作成する |
| **implement-issue** | GitHub Issue を取得し、計画作成 → ユーザー承認 → 実装 → テストの流れで開発する |
| **implement-review** | コード変更に対して品質・アーキテクチャ・セキュリティの読み取り専用レビューを行う |
| **implement-review-pr** | PR の CI ステータス・タイトル規約・コード品質・セキュリティを包括的にレビューする |
| **update-docs** | コード変更差分に基づいて CLAUDE.md のスキル一覧やリポジトリ構成を更新する |

### GitHub Projects 管理

| スキル | 説明 |
|--------|------|
| **project-init** | GitHub Project v2 を作成し、標準フィールド（Status/Priority/Size）を設定する |
| **project-add-items** | 要件ドキュメントやタスクリストからプロジェクトアイテムを一括作成する |
| **project-create-issues** | プロジェクトのドラフトアイテムを GitHub Issue に変換し、sub-issue として紐付ける |
| **project-view-status** | プロジェクトの進捗状況をステータス別に集計・レポートする |
| **project-update-items** | プロジェクトアイテムのフィールド値（ステータス・優先度等）を一括更新する |
| **project-sync-issues** | GitHub Issue の状態変更をプロジェクトのフィールドに同期する |
| **project-archive-done** | 完了済みプロジェクトアイテムをアーカイブしてボードを整理する |

## Agent

| Agent | 説明 |
|-------|------|
| **plan-verifier** | 計画ファイルに基づいて作業が正しく完了しているかを検証する。ファイル存在確認・フォーマット検証・整合性チェックを行い、構造化レポートを出力する。読み取り専用で破壊的操作は行わない |

## 特徴

- **Conventional Commits 準拠** — コミット・PR タイトルは `type(scope): subject` 形式を徹底
- **セキュリティファースト** — 実装・PR 作成・レビューの各段階で OWASP Top 10 を含むセキュリティチェックを実施
- **ユーザー承認フロー** — `implement-issue` は計画段階でユーザー承認を必須とし、意図しない実装を防止
- **並列実行対応** — レビュースキルは品質チェックとセキュリティチェックを Agent に委譲し並列実行
- **GitHub Projects 統合** — Project v2 の作成・アイテム管理・Issue 変換・進捗レポート・同期を一貫サポート
- **日本語対応** — 全スキルの出力・レポートは日本語

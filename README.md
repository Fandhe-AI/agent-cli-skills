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

Claude Code の Claude Skills として使用するスキルは、原則として `skills/` 配下に実体があり、`.claude/skills/` からシンボリックリンクで参照されます。例外が 2 種あります: リポジトリ管理スキル（create-skill / create-agent）は `.claude/skills/` 内の実ディレクトリで `skills/` 側に対応物を持たず、参照スキル（github-docs / anthropic-claude-code / anthropic-claude-code-extend）は `.agents/skills/` に実体を持ちます。Agents・Rules・その他ディレクトリツリーの詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| **comment-code** | コードにコメント・ドキュメンテーションコメント（JSDoc / docstring 等）を追加・補強する。パッケージ・サービス視点での役割境界、呼び出し元・呼び出し先の前提と契約、他ファイル・他サービスからの文脈を記述 |
| **create-commit** | `git diff` を分析し、Conventional Commits 形式でコミットメッセージを生成・実行する |
| **create-issue** | タスクを分析し、GitHub Issue を親子構造（sub-issues）で作成する |
| **create-issue-tree** | タスク要件を Phase 分割して GitHub Issue ツリーを新規作成（4h 粒度分解・Phase 階層化） |
| **create-plan** | コードベースを調査し、実装計画を `_/local-plans/` に作成する |
| **create-pr** | 変更内容のセキュリティチェック後、Conventional Commits 形式で PR を作成する |
| **implement-issue** | GitHub Issue を取得し、計画作成 → ユーザー承認 → 実装 → テストの流れで開発する |
| **implement-issue-tree** | Issue ツリーを post-order DFS で自動開発（並列実行対応・Phase 自動消化） |
| **implement-review** | コード変更に対して品質・アーキテクチャ・セキュリティの読み取り専用レビューを行う |
| **implement-review-pr** | PR の CI ステータス・タイトル規約・コード品質・セキュリティを包括的にレビューする |
| **update-docs** | コード変更差分に基づいて CLAUDE.md のスキル一覧やリポジトリ構成を更新する |
| **update-issue-tree** | 既存 Issue ツリーを棚卸し・整理（closed 親下の付け替え・孤児再配置・phase ラベル同期） |

**注記:** `create-html-report` / `setup-firebase-hosting` は [Fandhe-AI/agent-util-skills](https://github.com/Fandhe-AI/agent-util-skills) へ移設しました。

### リポジトリ管理スキル（.claude/skills/ に配置）

| スキル | 説明 |
|--------|------|
| **create-skill** | 新規スキルを scaffold し、symlink 作成・update-docs 実行まで自動化する（skill-explorer/skill-author/skill-reviewer/frontmatter-linter へ委譲） |
| **create-agent** | 新規サブエージェントを scaffold する（agent-author へ委譲、dotclaude-via-temp 準拠） |

### Claude Code セットアップ

| スキル | 説明 |
|--------|------|
| **init-claude** | 任意のリポジトリに Claude Code の `.claude/` 体系（Agents・Rules・Skills・hooks）を初期セットアップ |
| **update-claude** | 既存の `.claude/` 体系を診断し、理想形との差分を提示・追補する（破壊なし） |
| **setup-repo-guards** | 対象リポジトリへ組織標準の CI ガード一式（codex-review / AGENTS.md / 必須チェック集約ジョブ / branch protection ruleset）を導入する |

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

### 上流貢献

| スキル | 説明 |
|--------|------|
| **contribute-skill** | `skills-lock.json` の `source` が `Fandhe-AI/*` のスキルを手元で改修した後、upstream リポジトリへ PR を作成する |
| **sync-skills-lock** | `skills-lock.json` の `computedHash` を upstream の最新と同期する（submodule 配下は対象外） |

### 参照スキル（.claude/skills/ に配置）

| スキル | 説明 |
|--------|------|
| **github-docs** | GitHub CLI（`gh`）の公式ドキュメント・リファレンス |
| **anthropic-claude-code** | Claude Code CLI 本体のリファレンス（settings・env-vars・cli-reference・sessions 等） |
| **anthropic-claude-code-extend** | Claude Code 拡張リファレンス（Agent Skills・slash commands・subagents・hooks・plugins・MCP 設定等） |

## 関連リポジトリ

このリポジトリはスキル集の本体です。関連リポジトリは以下の通り。

- **[Fandhe-AI/agent-reference-skills](https://github.com/Fandhe-AI/agent-reference-skills)** — 公式ドキュメント参照スキル（GitHub CLI・Claude Code 拡張等）
- **[Fandhe-AI/agent-util-skills](https://github.com/Fandhe-AI/agent-util-skills)** — ユーティリティスキル集（HTML レポート生成・Firebase Hosting デプロイ等）
- **[Fandhe-AI/template-skills](https://github.com/Fandhe-AI/template-skills)** — 新規スキル配布リポの雛形。`gh repo create <org>/<name> --template Fandhe-AI/template-skills` で作成可能

Agents・Rules・ディレクトリツリーの詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## 特徴

- **委譲設計による main 消費削減** — main は対話・計画・委譲・報告に徹し、11体の専門サブエージェントへ並列委譲することで token 消費を最小化
- **Conventional Commits 準拠** — コミット・PR タイトルは `type(scope): subject` 形式を徹底
- **セキュリティファースト** — 実装・PR 作成・レビューの各段階で OWASP Top 10 を含むセキュリティチェックを実施
- **ユーザー承認フロー** — `implement-issue` は計画段階でユーザー承認を必須とし、意図しない実装を防止
- **並列実行対応** — 独立した調査・作成タスクを同一メッセージ内で複数 Agent に並列委譲
- **GitHub Projects 統合** — Project v2 の作成・アイテム管理・Issue 変換・進捗レポート・同期を一貫サポート
- **日本語対応** — 全スキルの出力・レポートは日本語

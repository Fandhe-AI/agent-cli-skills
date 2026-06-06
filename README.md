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
    research/
      skill-explorer.md              -- skills/ 横断調査（読み取り専用）
      sub-investigator.md            -- gh/git/CLI/hook 失敗調査（読み取り専用）
      reference-researcher.md        -- 公式ドキュメント調査（読み取り専用）
    author/
      skill-author.md                -- skills/<name>/SKILL.md 作成編集
      agent-author.md                -- .claude/agents 作成編集
      rules-author.md                -- .claude/rules 作成編集
      docs-writer.md                 -- CLAUDE.md/README 一覧・ツリー更新
    quality/
      skill-reviewer.md              -- SKILL.md 品質レビュー（読み取り専用）
      security-auditor.md            -- OWASP 監査（読み取り専用）
      frontmatter-linter.md          -- frontmatter/symlink 機械検証
      plan-verifier.md               -- 計画ファイル検証（読み取り専用）
  rules/
    delegation.md                    -- 委譲の原則（調査・設計フェーズ）
    delegation-impl.md               -- 委譲マッピング（作成・編集フェーズ）
    skill-authoring.md               -- スキル著作規約
    agent-authoring.md               -- エージェント著作規約
    conventional-commits.md          -- Conventional Commits 詳細規約
    security.md                      -- セキュリティチェック規約
    japanese-style.md                -- 日本語スタイルガイド
    dotclaude-via-temp.md            -- .claude/ 操作時の一時ディレクトリルール
    description-style.md             -- description 著作スタイル
    reference-template.md            -- reference 型スキルの書式規約
  skills/                            -- シンボリックリンク（skills/ → .claude/skills/）
  settings.json                      -- SessionStart hook（リマインダー）
skills/
  create-commit/
    SKILL.md                         -- Conventional Commits 形式でコミット作成
  create-issue/
    SKILL.md                         -- GitHub Issue を親子構造で作成
  create-plan/
    SKILL.md                         -- 実装計画ファイルを作成
  create-pr/
    SKILL.md                         -- Conventional Commits 形式で PR 作成
  implement-issue/
    SKILL.md                         -- Issue を読み込み計画・実装
  implement-review/
    SKILL.md                         -- コード変更の品質・セキュリティレビュー
  implement-review-pr/
    SKILL.md                         -- PR の CI・品質・規約レビュー
  update-docs/
    SKILL.md                         -- コード変更に基づく CLAUDE.md 更新
  create-skill/
    SKILL.md                         -- 新規スキルを scaffold・symlink・update-docs まで自動化
  create-agent/
    SKILL.md                         -- 新規サブエージェントを scaffold（dotclaude-via-temp 準拠）
  claude-code-reference/
    SKILL.md                         -- Claude Code 本体の公式仕様リファレンス
    reference/                       -- 公式仕様要約
    sample/                          -- 実例
    script/                          -- 実行可能コマンド集
  update-reference/
    SKILL.md                         -- claude-code-reference の更新確認・再取得
  project-init/
    SKILL.md                         -- GitHub Project v2 作成・フィールド設定
  project-add-items/
    SKILL.md                         -- 要件ドキュメントからアイテム一括作成
  project-create-issues/
    SKILL.md                         -- ドラフト→Issue 変換・sub-issue 紐付け
  project-view-status/
    SKILL.md                         -- 進捗状況の集計・レポート生成
  project-update-items/
    SKILL.md                         -- フィールド値の一括更新
  project-sync-issues/
    SKILL.md                         -- Issue 状態とプロジェクトの同期
  project-archive-done/
    SKILL.md                         -- 完了アイテムのアーカイブ
  contribute-skill/
    SKILL.md                         -- skills-lock.json の source に応じた upstream への PR 作成
  sync-skills-lock/
    SKILL.md                         -- skills-lock.json の computedHash を upstream と同期
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

### スキル著作・リファレンス

| スキル | 説明 |
|--------|------|
| **create-skill** | 新規スキルを scaffold し、symlink 作成・update-docs 実行まで自動化する（skill-explorer/skill-author/skill-reviewer/frontmatter-linter へ委譲） |
| **create-agent** | 新規サブエージェントを scaffold する（agent-author へ委譲、dotclaude-via-temp 準拠） |
| **claude-code-reference** | Claude Code 本体（Skills/Subagents/Hooks/settings/slash-commands/MCP/memory）の公式仕様リファレンス |
| **update-reference** | `claude-code-reference/reference/` の更新確認・再取得を行う（reference-researcher へ委譲） |

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

## Agents（サブエージェント）

サブエージェントは `.claude/agents/` 配下に配置され、`subagent_type: <name>` で呼び出す。main は対話・計画・委譲・報告に徹し、token を消費する作業はサブエージェントへ委譲する。

### research/ — 調査系（読み取り専用）

| Agent | model | 説明 |
|-------|-------|------|
| **skill-explorer** | Sonnet | skills/ 横断調査・仕様把握。大量ファイルの逐次 Read を代替する |
| **sub-investigator** | Sonnet | gh/git/CLI/hook 失敗の調査・原因特定 |
| **reference-researcher** | Sonnet | 公式ドキュメント・外部仕様の調査（WebFetch 対応） |

### author/ — 作成・編集系

| Agent | model | 説明 |
|-------|-------|------|
| **skill-author** | Sonnet | `skills/<name>/SKILL.md` の新規作成・編集。skill-authoring.md に準拠 |
| **agent-author** | Sonnet | `.claude/agents/` の新規作成・編集。dotclaude-via-temp 準拠 |
| **rules-author** | Sonnet | `.claude/rules/` の新規作成・編集。dotclaude-via-temp 準拠 |
| **docs-writer** | Haiku | `CLAUDE.md`・`README.md` のスキル一覧・ツリー更新 |

### quality/ — 品質・検証系（読み取り専用）

| Agent | model | 説明 |
|-------|-------|------|
| **skill-reviewer** | Sonnet | SKILL.md の品質レビュー。skill-authoring.md 基準で評価 |
| **security-auditor** | Sonnet | OWASP Top 10 セキュリティ監査。問題があれば PR 作成をブロック |
| **frontmatter-linter** | Haiku | frontmatter・symlink の機械検証（必須フィールド確認等） |
| **plan-verifier** | Sonnet | 計画ファイルに基づいて作業の完了状況を検証 |

## Rules

| ルール | 概要 |
|--------|------|
| **delegation.md** | 調査・設計フェーズの委譲原則（main がやること/やってはいけないこと） |
| **delegation-impl.md** | 作成・編集フェーズの委譲マッピング（対象パス → subagent_type） |
| **skill-authoring.md** | スキル著作フォーマット・品質基準 |
| **agent-authoring.md** | エージェント著作フォーマット・品質基準 |
| **conventional-commits.md** | Conventional Commits 詳細規約（type/scope/subject/breaking） |
| **security.md** | OWASP Top 10 セキュリティチェック基準 |
| **japanese-style.md** | 日本語スタイルガイド |
| **dotclaude-via-temp.md** | `.claude/` 操作時の一時ディレクトリルール（`_/dotclaude/` 経由） |
| **description-style.md** | description 著作スタイル（発火率・長さ・YAML 落とし穴） |
| **reference-template.md** | reference 型スキルの reference/*.md と README 索引の書式規約 |

## 特徴

- **委譲設計による main 消費削減** — main は対話・計画・委譲・報告に徹し、11体の専門サブエージェントへ並列委譲することで token 消費を最小化
- **Conventional Commits 準拠** — コミット・PR タイトルは `type(scope): subject` 形式を徹底
- **セキュリティファースト** — 実装・PR 作成・レビューの各段階で OWASP Top 10 を含むセキュリティチェックを実施
- **ユーザー承認フロー** — `implement-issue` は計画段階でユーザー承認を必須とし、意図しない実装を防止
- **並列実行対応** — 独立した調査・作成タスクを同一メッセージ内で複数 Agent に並列委譲
- **GitHub Projects 統合** — Project v2 の作成・アイテム管理・Issue 変換・進捗レポート・同期を一貫サポート
- **日本語対応** — 全スキルの出力・レポートは日本語

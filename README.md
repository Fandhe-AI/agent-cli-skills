# Agent CLI Skills

Claude Code・Codex・OpenCode 向けの CLI ワークフロースキル集です。コミット作成、PR 作成、Issue 管理、コードレビューなど、日常的な開発ワークフローを Conventional Commits 準拠で自動化します。

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

デフォルトではシンボリックリンクとして `.claude/skills/`（Claude Code 向け）に追加されます。Codex・OpenCode 向けの配置は次節を参照してください。`--copy` でファイルコピー、`-g` でグローバル (`~/.claude/skills/`) にインストールできます。

## Claude Code・Codex・OpenCode での使い方

スキルは 3 ツールのどれで読んでも同じ手順で動くように書いている（規約は [tool-neutral-skills.md](./.claude/rules/tool-neutral-skills.md)）。違うのは配置場所・起動の仕方・引数の渡し方・承認の書き方だけである。

| 項目 | Claude Code | Codex | OpenCode |
|------|-------------|-------|----------|
| 配置場所 | `.claude/skills` | `.agents/skills` | `.opencode/skills`・`.claude/skills`・`.agents/skills`（同名は後者ほど優先） |
| `npx skills add` の指定 | 既定 | `-a codex -a opencode`（どちらも `.agents/skills` に置かれる） | 同左 |
| 起動 | `/name` | `$name`（説明に合う依頼なら暗黙にも起動） | 依頼文に `@name`、または説明に合う依頼での自動選択 |
| 非対話実行 | `claude -p` | `codex exec` | `opencode run` |

Codex と OpenCode へ入れるときは `npx skills add Fandhe-AI/agent-cli-skills --skill create-commit -a codex -a opencode -y` のように指定する（`.agents/skills` に置かれ、`.claude/skills` には触れない）。体系ごと整える場合は次のセットアップスキルを使う。

| ツール | 初期セットアップ | 既存の更新 |
|--------|------------------|------------|
| Claude Code | `init-claude` | `update-claude` |
| Codex | `init-codex` | `update-codex` |
| OpenCode | `init-opencode` | `update-opencode` |

### 引数

引数は置換されず、起動時の文字列としてそのまま渡る（Codex・OpenCode で実機確認済み。Claude Code では `$ARGUMENTS` を持たないスキルに `ARGUMENTS: <値>` が追記される）。スキルは「起動時に渡された文字列を引数とする」と読み、無ければ確認する。

```text
/implement-issue 123          # Claude Code
$implement-issue 123          # Codex
@implement-issue 123          # OpenCode（依頼文の中に書く）
```

### 起動時の承認の書き方

- 確認を省きたいときは、起動時の指示に「確認なしでコミットまで進めてよい」「この計画で実装してよい」のように書く。書かずに非対話で実行すると、スキルは書き込み前の確認で止まり、確認事項を報告して終わる。
- 起動を頼むこと自体（「コミットして」「Issue を実装して」）は承認にならない。
- 非対話で Closes 付きの PR を作る（`create-pr`）ときは、milestone の扱いを起動時の指示に書いておく（例: 「milestone は割り当てずに進めてよい」「milestone v1 を割り当ててよい」）。書かないと、Codex の `codex exec` では Closes 対象の Issue に milestone が無い場合に、承認が無いまま milestone の確認で止まることがある。
- 安全上の確認（秘密情報の検出、削除・公開範囲・保護設定の変更のような元に戻せない操作）は、起動時の指示では省けない。Codex では、`init-codex` が配る `.codex/rules` が該当コマンド（`gh project item-delete`・`gh project edit`・`gh api` の書き込み系）を拒否する。ルールで止められない形が残るため、確認は利用者側でも見ること。

### 非対話での実行例

```bash
# Codex: trust をフラグで渡す。commit するスキルは .git を書き込み可にした permissions も要る
TRUST="projects={\"$PWD\"={trust_level=\"trusted\"}}"
PERM='permissions={gitwrite={extends=":workspace", filesystem={":minimal"="read", ":workspace_roots"={"."="write", ".git"="write", ".codex"="read", ".agents"="read"}}}}'
codex exec -C "$PWD" -c "$TRUST" -c "$PERM" -c 'default_permissions="gitwrite"' \
  '$create-commit staged の変更を、確認なしでコミットまで進めてよい'

# OpenCode: 承認を求める操作は --auto で許可する。使い捨ての環境か信頼できる環境だけで使う
opencode run --standalone --auto '@create-commit staged の変更を、確認なしでコミットまで進めてよい'

# Claude Code: ツールの許可は --allowedTools 等で別に渡す
claude -p '/create-commit staged の変更を、確認なしでコミットまで進めてよい'
```

Codex の既定 sandbox は `.git`・`.agents`・`.codex` を読み取り専用にする。`codex exec` では昇格の要求が出ないため、`.git` に書くスキルは上の permissions で実行する。サブエージェントへ委譲するスキルは、Codex では `--ephemeral` を付けると委譲せず自分で実行する。

## リポジトリ構成

Claude Code では、スキルは原則として `skills/` 配下に実体があり、`.claude/skills/` からシンボリックリンクで参照されます。例外が 2 種あります: リポジトリ管理スキル（create-skill / create-agent / sweep-sync-prs）は `.claude/skills/` 内の実ディレクトリで `skills/` 側に対応物を持たず、参照スキル（github-docs / anthropic-claude-code / anthropic-claude-code-extend / openai-codex / opencode-usage / opencode-build）は `.agents/skills/` に実体を持ちます。Codex・OpenCode へは `init-codex` / `init-opencode`（既存体系は `update-codex` / `update-opencode`）で `.agents/skills/` に導入します。Agents・Rules・その他ディレクトリツリーの詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。

## スキル一覧

### 開発ワークフロー

| スキル | 説明 |
|--------|------|
| **comment-code** | コードにコメント・ドキュメンテーションコメント（JSDoc / docstring 等）を追加・補強する。パッケージ・サービス視点での役割境界、呼び出し元・呼び出し先の前提と契約、他ファイル・他サービスからの文脈を記述 |
| **create-commit** | `git diff` を分析し、Conventional Commits 形式でコミットメッセージを生成・実行する |
| **create-issue** | タスクを分析し、GitHub Issue を親子構造（sub-issues）で作成する |
| **create-issue-tree** | タスク要件を Phase 分割して GitHub Issue ツリーを新規作成（既定 2h 粒度分解（--granularity で変更可）・Phase 階層化） |
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
| **sweep-sync-prs** | Fandhe-AI 組織のスキル同期 PR を棚卸しし、詰まりの類型ごとに対処して全件マージまで見届ける（下流へは配布しない） |

### エージェントセットアップ

| スキル | 説明 |
|--------|------|
| **init-claude** | 任意のリポジトリに Claude Code の `.claude/` 体系（Agents・Rules・Skills・hooks）を初期セットアップ |
| **update-claude** | 既存の `.claude/` 体系を診断し、理想形との差分を提示・追補する（破壊なし） |
| **setup-repo-guards** | 対象リポジトリへ組織標準の CI ガード一式（ai-review / AGENTS.md / 必須チェック集約ジョブ / branch protection ruleset）を導入する |
| **init-codex** | 任意のリポジトリに OpenAI Codex の体系（AGENTS.md・.codex の hooks / rules / agents・ワークフロースキル 9 件）を初期セットアップ |
| **update-codex** | 既存の Codex 体系を診断し、ギャップを表で提示して承認後に追補する（利用者の設定は消さない） |
| **init-opencode** | 任意のリポジトリに OpenCode の体系（opencode.jsonc・.opencode の agents / plugin ガード・AGENTS.md・ワークフロースキル 9 件）を初期セットアップ |
| **update-opencode** | 既存の OpenCode 体系を診断し、差分を承認後に追補する（利用者の規則・agent は消さない） |

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
| **openai-codex** | OpenAI Codex リファレンス（AGENTS.md・config.toml・hooks・subagents・sandbox・Codex skills 等） |
| **opencode-usage** | OpenCode v2 利用リファレンス（opencode.jsonc・agents・permissions・skills・commands・MCP 等） |
| **opencode-build** | OpenCode v2 拡張開発リファレンス（server plugin hooks・@opencode/plugin・SDK・HTTP API 等） |

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

---
name: init-claude
description: >
  任意の対象リポジトリに Claude Code の .claude/ 体系（CLAUDE.md・Agents・Rules・Skills・hooks）を
  初期セットアップする。「claude セットアップして」「.claude 作って」「CLAUDE.md 初期化」「Agent 整備して」
  「claude-code セットアップ」などで使用。既存 .claude/ の差分充実は update-claude を使用。
  implement-issue-tree が動く前提（gh auth / sub_issues / workflow js）の整備まで含む。
model: opus
user-invocable: true
argument-hint: "<対象リポジトリのパス（省略時はカレントディレクトリ）>"
---

# init-claude

任意のリポジトリに Claude Code の `.claude/` 体系を初期セットアップする。
日本語運用・目的別 Agent（カテゴリ分割）・Rules 整備・スキル導入・委譲による main 消費抑制・
model 配分・SessionStart hooks・implement-issue-tree の動作前提まで一括構成する。

既存の `.claude/` が存在するリポジトリには `update-claude` を使用する。

## 使い方

```
init-claude [対象リポジトリのパス]
```

パスを省略した場合はカレントディレクトリを対象とする。

## 前提条件

- `gh` CLI がインストールされ、認証済みであること（`gh auth status` で確認）
- 対象リポジトリで `git` が初期化済みであること
- `npx` が使用できること（`npx skills add` によるスキル導入に使用）

## フロー

### Step 1: 対象リポジトリを調査する

対象ディレクトリのルートを特定し、以下を把握する。

```bash
# 言語・フレームワーク検出
ls <target-repo>/
cat <target-repo>/package.json 2>/dev/null || true
cat <target-repo>/Cargo.toml 2>/dev/null || true
cat <target-repo>/pyproject.toml 2>/dev/null || true

# ディレクトリ構成（最大深度 3）
find <target-repo> -maxdepth 3 -not -path '*/.git/*' -not -path '*/node_modules/*' | head -80

# ビルド・テストコマンドの確認
cat <target-repo>/Makefile 2>/dev/null | head -40 || true
cat <target-repo>/.github/workflows/*.yml 2>/dev/null | head -60 || true
```

調査で把握する情報:
- 主要言語・フレームワーク（Rust / TypeScript / Python など）
- ディレクトリ構成（crates/ / src/ / packages/ など）
- ビルドコマンド（`cargo build` / `npm run build` / `make` など）
- テストコマンド（`cargo test` / `npm test` / `pytest` など）
- 既存の `.claude/` ディレクトリの有無

既存の `.claude/` がある場合は `update-claude` スキルへ誘導して処理を中断する。

### Step 2: 構成案を設計してユーザーに提示・承認を得る

調査結果をもとに以下の構成案を設計する。

#### Agents 設計方針

技術レイヤ別の builder Agent と横断サポート Agent を組み合わせる。

| カテゴリ | Agent 例 | model |
|---------|---------|-------|
| research | explorer（コードベース横断調査）, reference-researcher（外部仕様調査） | sonnet |
| implement | 技術レイヤ別 builder（例: api-builder, web-builder, core-builder） | sonnet |
| testing | test-runner, e2e-runner | sonnet |
| quality | reviewer, security-auditor, linter | haiku / sonnet |
| docs | docs-writer | haiku |

- 実装系 Agent はリポの技術レイヤに合わせてカスタマイズする
  （例: Rust workspace → クレート別 builder / TypeScript monorepo → パッケージ別 builder）
- 複雑な横断判断・アーキテクチャ設計は opus または fable（fable は Opus 上位の最上位 tier。特に大規模設計や複雑な横断判断が必要な場面に限定する）
- 調査・生成・レビューは sonnet
- 機械的集計・frontmatter lint・ドキュメント更新は haiku

#### Rules 設計方針

以下を標準として生成し、リポ特性に応じて追加する。

| ファイル | 内容 |
|---------|------|
| `delegation.md` | 調査・設計フェーズの委譲原則・パスベース切り替え |
| `delegation-impl.md` | 作成・編集フェーズの委譲マッピング |
| `coding-<lang>.md` | 言語別コーディング規約（Rust / TypeScript / Python 等） |
| `security.md` | OWASP Top 10・秘密情報混入防止 |
| `japanese-style.md` | 日本語出力スタイル |
| `conventional-commits.md` | Conventional Commits 詳細規約 |

#### Skills 設計方針

`npx skills add Fandhe-AI/agent-cli-skills` で以下を導入する。

- `create-commit` — Conventional Commits コミット作成
- `create-pr` — PR 作成
- `create-issue` — Issue 作成
- `implement-issue` — Issue 単体実装
- `implement-issue-tree` — Issue ツリー並列実装
- `implement-review` — レビュー対応
- `implement-review-pr` — PR レビュー対応
- `update-docs` — CLAUDE.md 更新

#### hooks 設計方針

- **SessionStart**: 日本語・委譲・Conventional Commits・`--no-verify` 禁止のリマインダー
- **PostToolUse**: 言語に応じた自動整形（Rust: `rustfmt` / TypeScript: `biome` または `prettier` / Python: `ruff` など）

#### model 配分表（CLAUDE.md に記載）

| 用途 | model |
|------|-------|
| 複雑な横断判断・アーキテクチャ設計 | opus または fable（fable は特に大規模設計・横断判断の最上位 tier） |
| 調査・生成・実装・レビュー | sonnet |
| 機械的集計・lint・ドキュメント更新 | haiku |

上記の構成案（Agent 一覧・Rules 一覧・model 配分・hooks・Skills）を**ユーザーに提示し承認を得てから**次の Step に進む。

### Step 3: .claude/ 一式を生成する

承認後、以下の順で生成する。対象リポに `dotclaude-via-temp` ルール（`_/dotclaude/` 経由）がない場合は
対象リポの `.claude/` へ直接書き込んで良い。

サブステップの実行順は **3-1（CLAUDE.md）→ 3-2（agents/）→ 3-3（rules/）→ 3-4（settings.json）→ 3-5（スキル導入）** の順とする。CLAUDE.md は Agent・Rules・Skills の一覧を参照するため、それらの生成後に最終調整する。

#### 3-1. CLAUDE.md を生成する

対象リポのルートに `CLAUDE.md` を作成する。以下のセクションを含める。

```markdown
# CLAUDE.md

## Overview
リポジトリの概要（調査結果から生成）

## Repository Structure
ディレクトリ構成ツリー（3〜4階層）

## 委譲方針（必読）
main の役割・パスベース切り替え表・model 配分表

## Sub-agents
カテゴリ別 Agent 一覧（subagent_type / model / 概要の表）

## Rules
ルールファイル一覧（ファイル名 / 対象 / 概要の表）

## Current Skills
導入済みスキル一覧

## Conventions
Conventional Commits・セキュリティレビュー・日本語出力・ユーザー承認フローなど

## hooks（settings.json）
SessionStart / PostToolUse の説明
```

#### 3-2. agents/ を生成する

Step 2 で設計した Agent を `.claude/agents/<category>/<name>.md` に作成する。
各 Agent は以下の frontmatter を持つ。

```yaml
---
subagent_type: <name>
description: "<役割の説明>"
model: <haiku|sonnet|opus>
tools: [必要最小限のツール]
---
```

#### 3-3. rules/ を生成する

Step 2 で設計したルールを `.claude/rules/` に作成する。
`delegation.md`・`delegation-impl.md` は本リポの実例（Fandhe-AI/agent-cli-skills）を参考に
対象リポのパス構成に合わせてカスタマイズする。

#### 3-4. settings.json を生成する

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '<リポ名>: 日本語でやりとり / 作業は subagent へ委譲し main 消費を抑える (delegation.md, delegation-impl.md) / Conventional Commits 厳守 (--no-verify 禁止) / implement-issue は計画承認後に実装'"
          }
        ]
      }
    ]
  }
}
```

言語に応じた PostToolUse 自動整形フックを提案し、ユーザーが希望する場合は追加する。

セキュリティ注意事項:
- `command` の値に API キー・トークン・パスワードを埋め込まない
- ユーザー入力をそのまま `command` に展開しない

#### 3-5. スキルを導入する

```bash
cd <target-repo>
npx skills add Fandhe-AI/agent-cli-skills
```

`skills-lock.json` が生成されることを確認する。

### Step 4: implement-issue-tree の動作前提を確認する

```bash
# gh auth と sub_issues API の確認
gh auth status
gh api --method GET /repos/<owner>/<repo>/sub_issues 2>&1 | head -5

# workflow js の参照確認
ls <target-repo>/.claude/workflows/implement-issue-tree.js 2>/dev/null || \
  echo "workflow js が存在しない場合は implement-issue-tree スキルの手順に従い配置する"
```

不足がある場合は対処方法をユーザーに案内する。

### Step 5: 生成結果を報告する

報告項目:
- 生成したファイル一覧（CLAUDE.md・Agents・Rules・settings.json）
- 導入したスキル一覧（`npx skills add` の結果）
- implement-issue-tree の動作前提の充足状況
- ユーザーへの次のアクション案内（PostToolUse hooks の追加・Agent のカスタマイズなど）

## 検証

```bash
# 生成ファイルの一覧確認
find <target-repo>/.claude -type f | sort

# CLAUDE.md の存在確認
ls <target-repo>/CLAUDE.md

# skills-lock.json の存在確認
ls <target-repo>/skills-lock.json

# implement-issue-tree の前提確認
gh auth status
ls <target-repo>/.claude/workflows/implement-issue-tree.js 2>/dev/null || echo "workflow js: 未配置"
```

## 注意事項

- 既存の `.claude/` がある場合は処理を中断して `update-claude` を案内する
- ユーザーの構成案承認なしに `.claude/` の生成を開始しない
- `settings.json` の `command` にトークン・シークレットをハードコードしない
- `--no-verify` を含むコマンドを hooks に仕込まない
- `npx skills add` が失敗した場合はエラーメッセージを表示してユーザーに手動手順を案内する
- 言語別 PostToolUse 整形フック（rustfmt / biome / prettier / ruff）は対象リポのツール存在確認後に提案する
- Agent の `tools` リストは最小権限原則に従い必要なもののみ列挙する

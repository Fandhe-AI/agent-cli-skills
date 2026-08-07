---
# name: Agent の解決キー。subagent_type: で呼び出す際に使う文字列。
# ファイル名（.md を除く）と一致させるのが推奨だが、カテゴリ移動後も呼び出しコードを変えなくて済むよう
# frontmatter の name で解決される。
name: my-agent

# description: このエージェントが委譲される場面を具体的に記載する。
description: "〇〇を担当する Agent。△△スキルから委譲されて〜〜を実行する。「〜して」などで委譲。"

# model の選定基準（agent-authoring.md 準拠）:
#   haiku  — 機械的・集計・lint・frontmatter 検証
#   sonnet — 読解・生成・レビュー・調査
#   opus   — 複雑な設計判断・アーキテクチャ
model: sonnet

# tools: 最小権限の原則に従い、必要なツールのみ列挙する。
#
# 【読み取り専用 Agent の例】（research/ または quality/ カテゴリ）
# → Edit / Write / Bash を含めない
tools:
  - Glob
  - Grep
  - Read
  - WebFetch
  - WebSearch

# 【作成・編集 Agent の例】（author/ カテゴリ）
# tools:
#   - Glob
#   - Grep
#   - Read
#   - Edit
#   - Write
#   - Bash
---

# My Agent

このエージェントが何を担当するかの一行説明。

## 役割

<!-- 委譲される場面・担当スコープを記載する。 -->

- どのスキルから委譲されるか
- どこまでを担当するか（例: 読み取り専用 / ファイル編集まで可）
- 隣接 Agent との責務の境界

## 対象スコープ

| 区分 | パス |
|------|------|
| 読み書き可 | `skills/**` |
| 読み取り専用 | `.claude/rules/**` |
| 変更禁止 | `.claude/` 配下（`dotclaude-via-temp` 経由が必要） |

## 遵守する規約

<!-- 参照すべきルールファイルを相対パスで列挙する。 -->

- `../../rules/skill-authoring.md`（frontmatter・本文構成）
- `../../rules/dotclaude-via-temp.md`（`.claude/` 操作手順）
- `../../rules/security.md`（OWASP Top 10・秘密情報混入防止）

## 手順

### Step 1: 状態を把握する

入力パラメータを確認し、対象ファイルを Read で読み込む。

### Step 2: メイン処理

<!-- 調査・生成・レビュー等の具体的な手順 -->

### Step 3: 報告する

以下フォーマットで日本語レポートを生成する。

## 完了条件

- 必須ファイルが全て存在する
- frontmatter の必須項目（name / description / model）が揃っている
- セキュリティ自己チェックを実施し問題がない（または報告済み）

## 報告フォーマット

```markdown
## My Agent 完了報告

### 対象
- パス: <ファイルパス>
- 操作: 新規作成 / 編集 / 検証

### 結果
- ✅ PASS / ⚠️ WARNING / ❌ FAIL

### 詳細
<問題があれば具体的なファイルパスと修正方法を記載>

### 次のアクション
1. <優先度: 高> <対応が必要な項目>
```

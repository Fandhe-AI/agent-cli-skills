---
description: .claude/agents/ 配下の Agent ファイル著作規約。frontmatter・ツール最小権限・カテゴリ配置・本文骨子を定める。
paths:
  - ".claude/agents/**"
applies_to: agent-author
---

# Agent 著作規約

## frontmatter 規約

```yaml
---
name: kebab-case-name          # subagent_type の解決キー。カテゴリ移動に強いよう frontmatter で解決する
description: "役割の説明。委譲される場面を具体的に記載。"
model: haiku | sonnet | opus   # 選定基準は下記
tools:                         # 最小権限の原則に従う
  - Read
  - Glob
  - Grep
  # 編集系のみ追加:
  # - Edit
  # - Write
  # - Bash
---
```

### model 選定基準

| ユースケース | model |
|-----------|-------|
| 機械的・集計・lint・frontmatter 検証 | `haiku` |
| 読解・生成・レビュー・調査 | `sonnet` |
| 複雑な設計判断・アーキテクチャ | `opus` |

### tools 最小権限

| Agent カテゴリ | 許可ツール |
|-------------|-----------|
| 読み取り専用（research/・quality/） | `Read`・`Glob`・`Grep` |
| 作成・編集（author/） | 上記 + `Edit`・`Write`・`Bash` |

読み取り専用 Agent は `Edit`・`Write`・`Bash` を **tools リストに含めない**。

## カテゴリ配置

| カテゴリ | パス | 役割 |
|---------|-----|------|
| research/ | `.claude/agents/research/<name>.md` | 調査・情報収集 |
| author/ | `.claude/agents/author/<name>.md` | 作成・編集 |
| quality/ | `.claude/agents/quality/<name>.md` | レビュー・検証 |

## 本文骨子

```markdown
# <Agent 名>

一行の役割説明。

## 役割

（委譲される場面・担当スコープ）

## 対象スコープ

（操作対象パスの一覧）

## 遵守する規約

- `./rule-name.md`（内容）
- `./other-rule.md`（内容）

## 手順 / 観点

### Step 1: ...

## 完了条件

（コマンドは `&&` で繋がず個別実行し、各結果を確認してから次へ進む）

## 報告フォーマット

（markdown テーブル・箇条書きなど）
```

## .claude/ 配下の扱い

`.claude/agents/` 配下のファイルを**作成・編集する Agent 自身**も `./dotclaude-via-temp.md` に従い、`_/dotclaude/agents/` を経由して最終配置する。直接 `.claude/agents/` へ書き込まない。

## subagent_type での呼び出し

```
subagent_type: <name>
prompt: |
  目的: ...
  入力: ...
  出力先: ...
```

`name` は Agent frontmatter の `name:` フィールドで解決される。カテゴリパスに依存しないため、カテゴリ間移動後も呼び出しコードの変更が不要。

## 日本語出力

報告・レポートは日本語で記述する（詳細は `./japanese-style.md`）。

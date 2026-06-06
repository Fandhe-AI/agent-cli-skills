---
name: update-reference
description: "skills/claude-code-reference/reference/*.md の各ファイル冒頭の source URL を読み、公式ドキュメントの最新版を取得して差分を確認し、変更があれば要約を更新するスキル。「リファレンス更新」「公式ドキュメントの更新確認」「claude-code-reference を最新化」などで使用。"
model: sonnet
user-invocable: true
argument-hint: "[reference-name] (省略時は全件)"
---

# update-reference

`skills/claude-code-reference/reference/*.md` の各ファイルを公式ドキュメントと照合し、変更があれば要約と `最終確認日` を更新します。

## 使い方

```
/update-reference              # 全ファイルを対象
/update-reference skills       # skills.md のみ更新
/update-reference hooks,mcp    # 複数指定（カンマ区切り）
```

引数を省略した場合は `reference/` 配下の全 `.md` を対象にします。

## フロー

### Step 1: 対象ファイルと source URL を列挙する

引数がある場合は指定された `reference/<name>.md` のみ、省略時は以下で全件取得する。

```bash
ls skills/claude-code-reference/reference/*.md
```

各ファイルの先頭行から `<!-- source: <URL> -->` と `<!-- 最終確認日: YYYY-MM-DD -->` を読み取り、
URL と最終確認日のマッピングを作成する。

**除外対象**: `sample/` および `script/` は実コマンド集のため手動メンテとし、本スキルの対象外とする。

### Step 2: reference-researcher Agent に委譲して差分を確認する

**reference-researcher（subagent_type: reference-researcher）**に委譲して以下を実行させる。

委譲プロンプト例:

```
subagent_type: reference-researcher
prompt: |
  目的: 以下の URL から公式ドキュメントを取得し、現行の reference/*.md と比較して差分を報告する。
  入力:
    - 対象 URL とファイルパスのマッピング（Step 1 で取得）
    - 各 reference/*.md の現行内容
  処理:
    1. 各 URL を WebFetch で取得する
    2. 現行要約と最新ドキュメントを比較して差分を特定する
    3. 変更があった項目の差分サマリーを返す
    4. 破壊的変更・削除された API・廃止予定機能を特に強調する
  出力フォーマット:
    - ファイルごとの差分サマリー（変更なし / 軽微な変更 / 重要な変更 / 破壊的変更 の4段階）
    - 変更が検出されたファイルの具体的な変更点リスト
```

### Step 3: 変更があった reference/*.md を更新する

Step 2 の結果を受け、変更が検出されたファイルのみ更新する。

更新内容:
- 要約・説明文を最新ドキュメントの内容に合わせて書き直す
- ファイル冒頭の `<!-- 最終確認日: YYYY-MM-DD -->` を実行時の日付に更新する（例: `2026-06-06`）
- `<!-- ✅ 取得済み -->` コメントが存在する場合はそのまま保持する

**変更なしのファイル**: `最終確認日` の更新のみ行い、本文は変更しない。

### Step 4: 変更サマリーを報告する

以下の形式で結果を日本語で報告する。

```
## update-reference 実行結果

更新対象: N ファイル
更新済み: X ファイル
変更なし: Y ファイル

### 変更があったファイル

| ファイル | 変更の種類 | 主な変更点 |
|---------|----------|----------|
| reference/hooks.md | 重要な変更 | PreToolUse の新フィールド `decision` が追加 |
| reference/mcp.md   | 軽微な変更 | URL の記載を更新 |

### ⚠️ 破壊的変更・削除された API

（該当がある場合のみ記載）

### 変更なしのファイル

reference/skills.md, reference/settings.md, ...
```

## 検証

1. 更新された各ファイルの冒頭で `<!-- 最終確認日 -->` が今日の日付になっていることを確認する
2. 変更サマリーに破壊的変更があれば、関連するスキル（create-skill, create-agent 等）への影響を確認する
3. `git diff skills/claude-code-reference/reference/` で変更内容を最終確認する

## 注意事項

- **sample/ と script/ は対象外**: 実コマンド集であるため手動でメンテナンスする
- **破壊的変更の扱い**: 廃止された API や設定が検出された場合は報告を強調し、関連スキルの修正を案内する
- **WebFetch の失敗**: ネットワークエラーや 404 の場合は該当ファイルをスキップし、ログに記録する
- **最終確認日の形式**: `YYYY-MM-DD`（ISO 8601 日付形式）を使用する
- **部分実行**: 引数指定で特定ファイルのみ更新する場合、他のファイルの `最終確認日` は変更しない

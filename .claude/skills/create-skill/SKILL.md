---
name: create-skill
description: "新規スキルを scaffold する。命名・配置の重複確認、SKILL.md 作成、symlink 設定、品質チェックまでを一貫して自動化。「スキル作って」「新しいスキルを追加」「create-skill」などで使用。"
model: sonnet
user-invocable: true
argument-hint: "<skill-name> (例: create-skill summarize-pr)"
---

# create-skill

新規スキルを `skills/<name>/SKILL.md` として scaffold し、symlink と品質チェックまで自動化します。

## 使い方

```
/create-skill summarize-pr        # スキルを新規作成
/create-skill                     # 引数省略時はスキル名をインタラクティブに確認
```

スキルの雛形は `skills/claude-code-reference/sample/SKILL.sample.md` を参照します。

## フロー

### Step 1: 既存スキルの重複確認（skill-explorer に委譲）

**skill-explorer（subagent_type: skill-explorer）**に委譲して以下を確認させる。

```
subagent_type: skill-explorer
prompt: |
  目的: 指定された名前のスキルが既に存在しないか確認する
  入力:
    - 作成予定のスキル名: <skill-name>
    - 検索対象: skills/ 配下の全ディレクトリ、.claude/skills/ 配下の symlink
  確認観点:
    1. skills/<skill-name>/ が既に存在するか
    2. 類似名（例: kebab-case 変形や別表記）のスキルが存在するか
    3. 既存スキルで同等の機能が提供されていないか
  出力: 重複なし / 重複あり（ファイルパスと既存スキルの概要）
```

重複が見つかった場合はユーザーに通知し、新規作成か既存スキルの更新かを確認してから続行する。

### Step 2: frontmatter・本文の設計と SKILL.md 作成（skill-author に委譲）

**skill-author（subagent_type: skill-author）**に委譲して `SKILL.md` を作成させる。

委譲プロンプトには以下を含める:

```
subagent_type: skill-author
prompt: |
  目的: <skill-name> の SKILL.md を新規作成する
  入力:
    - スキル名: <skill-name>
    - ユーザーから受け取った役割説明・要件（あれば）
    - 雛形: skills/claude-code-reference/sample/SKILL.sample.md
    - 既存スキルの参考例: skills/contribute-skill/SKILL.md, skills/update-docs/SKILL.md
  出力先: skills/<skill-name>/SKILL.md
  適用ルール:
    - .claude/rules/skill-authoring.md（frontmatter・本文構成・model 選定・セキュリティ self-check）
    - .claude/rules/delegation-impl.md（委譲設計が必要な場合）
  必須項目:
    - frontmatter: name（ディレクトリ名と一致）, description（発火トリガー語を含む）, model, user-invocable
    - 本文: ## 使い方 → ## フロー（Step N）→ ## 検証 → ## 注意事項
    - description に # を含む場合はクォートで囲む
    - 作業を委譲する設計の場合は subagent_type を明記する
```

### Step 3: symlink を作成する

`skill-author` の完了後、シンボリックリンクを作成する。

```bash
ln -s ../../skills/<skill-name> .claude/skills/<skill-name>
```

symlink 作成後に以下で確認する。

```bash
ls -la .claude/skills/<skill-name>
```

### Step 4: 品質チェック（skill-reviewer と frontmatter-linter に委譲）

**skill-reviewer（subagent_type: skill-reviewer）**と **frontmatter-linter（subagent_type: frontmatter-linter）**に並列委譲して検証させる。

skill-reviewer の観点:
- `skill-authoring.md` 規約への準拠（frontmatter 項目、本文構成）
- セキュリティ self-check（APIキーのハードコード、フック回避コマンドの不在）
- トリガー語・引数ヒントの適切さ

frontmatter-linter の観点:
- `name` がディレクトリ名と一致しているか
- `model` が規定値（haiku/sonnet/opus）のいずれかか
- `user-invocable` の有無と symlink の整合性
- `description` 内の `#` がクォートで囲まれているか

レビュー結果に問題があれば `skill-author` に差し戻して修正させる。

### Step 5: update-docs での CLAUDE.md 更新を案内する

スキル追加が完了したら以下を案内する。

```
✅ skills/<skill-name>/SKILL.md を作成しました。
✅ .claude/skills/<skill-name> → ../../skills/<skill-name> の symlink を作成しました。

CLAUDE.md のスキル一覧・構造ツリーを更新するには:
  /update-docs
を実行してください。
```

## 検証

1. `ls skills/<skill-name>/SKILL.md` でファイルが存在することを確認する
2. `ls -la .claude/skills/<skill-name>` で symlink が正しいリンク先を指すことを確認する
3. `head -10 skills/<skill-name>/SKILL.md` で frontmatter が正しく記述されていることを確認する

## 注意事項

- **symlink の相対パス**: `.claude/skills/<name>` からの相対パスは `../../skills/<name>` とする（絶対パス不可）
- **ディレクトリ名と name の一致**: frontmatter の `name:` はディレクトリ名と完全一致させる
- **`#` を含む description**: YAML コメント扱いを防ぐためクォートで囲む（規約 e83e1bb 参照）
- **update-docs の実行**: スキル追加後は必ず `/update-docs` で `CLAUDE.md` を最新化する
- **委譲の連鎖**: `skill-author` が別の Agent をさらに委譲する場合がある。承認フローが必要なスキルは事前に要件を確認する

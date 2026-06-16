---
description: SKILL.md の著作規約。frontmatter・本文構成・model 選定・セキュリティ・symlink 手順を定める。skill-author と skill-reviewer が参照する。
paths:
  - "skills/**"
  - ".claude/skills/**"
applies_to: skill-author, skill-reviewer
---

# スキル著作規約

## frontmatter 規約

```yaml
---
name: kebab-case-name          # ディレクトリ名と一致させる（必須）
description: "役割の説明。「〜して」「〜作って」など発火トリガー語を含める。関連スキルへの導線も記載。"
model: haiku | sonnet | opus   # 下記の選定基準に従う
user-invocable: true           # ユーザーが直接呼び出す場合（任意）
argument-hint: "<引数説明>"    # 引数を取る場合（任意）
tools: [Bash, Read, Write]     # 使用するツールを明示する場合（任意）
---
```

### user-invocable の既定値

`user-invocable` を省略した場合は `true`（ユーザーが直接呼び出せる）として扱われる。ユーザーから直接呼び出させない内部専用スキルのみ `user-invocable: false` を明示する（本リポでは `claude-code-reference` が該当）。

### tools フィールドの扱い

`tools` は任意フィールドで、省略した場合はデフォルトのツールセットが利用可能となる。明示する場合は最小権限の原則に従い、スキルの実行に必要なツールのみを列挙する。

### sandbox 節の定型文

複数のスキルが「sandbox 環境での実行」を注意事項に持つ場合、文言を以下の定型文に統一して揺れを排除する:

```
このスキルは sandbox 環境では実行できない。ネットワークアクセス・ファイルシステムへの書き込みが必要なため、通常の Claude Code セッションで実行すること。
```

### model 選定基準

| ユースケース | model |
|-----------|-------|
| 機械的・集計・一覧生成・frontmatter 更新 | `haiku` |
| 判定・生成・レビュー・複数ファイル読解 | `sonnet` |
| 複雑な計画立案・アーキテクチャ設計 | `opus` |

### description の注意事項

description の書き方の詳細は `./description-style.md` を参照する。
ここでは最重要の YAML 落とし穴のみ記載する。

- `description:` 値に `#` を含める場合は**必ずクォートで囲む**（YAML コメント扱いを防ぐ）
  - 悪い例: `description: 変更をコミット # 詳細は create-commit`
  - 良い例: `description: "変更をコミット # 詳細は create-commit"`
  - 参考: コミット e83e1bb（YAML description 内の `#` をコメント扱いから保護）
- `:` の後にスペース+テキストが続く場合も語順変更で回避する（詳細は `./description-style.md`）

### reference 型スキルの書式

`reference/`・`references/` 配下のページと README 索引の書式は `./reference-template.md` を参照する。

## 本文構成

```markdown
# <skill-name>

一行の概要説明。

## 使い方

（引数・前提条件があれば記載）

## フロー

### Step 1: <ステップ名>

（具体的な手順）

### Step 2: ...

## 検証  ← 準必須（特別な理由がない限り全スキルに記載する）

（完了確認方法。`./verification.md` の5段階ゲートに沿った確認手順を記述する）

## 注意事項

（制約・禁止事項・エッジケース）
```

`## 検証` は**準必須**セクションとして扱う。スキルが自動実行・生成・修正を行う場合は「どのコマンドで・何を確認すれば完了とみなせるか」を必ず記載する。詳細は `./verification.md` を参照。

### 推奨任意セクション

以下のセクションは省略可だが、該当するスキルでは積極的に追加する。

#### `## Core Pattern`（Before/After の対比）

判断・生成を伴うスキル（commit メッセージ生成・PR 作成・コードレビュー等）で推奨。変換前後の具体例をコードブロックで示す。

```markdown
## Core Pattern

Before（修正前）:

（問題のある入力例）

After（修正後）:

（正しい出力例）
```

#### `## よくある失敗`（Common Mistakes）

実装・生成系スキルで推奨。問題と回避策の対で記述する。

```markdown
## よくある失敗

| 問題 | 回避策 |
|------|--------|
| （失敗パターン） | （正しいアプローチ） |
```

## セキュリティ self-check

SKILL.md を作成・編集した後、以下を確認する（詳細は `./security.md`）:

- [ ] API キー・トークンのハードコードがないか
- [ ] シェルコマンドの引数が適切にクォートされているか
- [ ] `--no-verify` など、フック回避のコマンドが含まれていないか
- [ ] セキュリティ問題を検出した場合に処理を中止する旨が記載されているか

## Conventional Commits 連携

コミット・PR を生成するスキルでは `./conventional-commits.md` を参照する旨を注意事項に記載する。

## 新スキル追加手順

1. `skills/<name>/SKILL.md` を作成（本規約に従う）
2. `.claude/skills/<name>` へ symlink を作成:
   ```bash
   ln -s ../../skills/<name> .claude/skills/<name>
   ```
3. `update-docs` スキルを実行して `CLAUDE.md` のスキル一覧・ツリーを更新

## 日本語出力

スキル本文・出力メッセージ・レポートは日本語で記述する（詳細は `./japanese-style.md`）。

## 関連ルール

| ファイル | 概要 |
|---------|------|
| `./verification.md` | 完了ゲート規約。`## 検証` セクションの記述基準 |
| `./debugging.md` | 根本原因デバッグ規約。実装系スキルのデバッグ手順 |
| `./description-style.md` | description フィールドの書き方・発火率最適化 |
| `./security.md` | セキュリティ self-check の詳細基準 |
| `./conventional-commits.md` | コミット・PR 生成スキルの記述規約 |
| `./japanese-style.md` | 日本語出力スタイルガイド |
| `./reference-template.md` | reference 型スキルの書式規約 |

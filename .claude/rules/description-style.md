---
description: skill/agent の description フィールドの書き方ガイド。発見可能性と簡潔さを両立するための規約。
applies_to: skill-author, agent-author, skill-reviewer, reference-researcher
---

# description 書き方ガイド

SKILL.md・Agent ファイルの `description` フィールドの書き方。`npx skills add` 検索ヒット率と Claude の自動発火ヒット率を高めながら、管理可能な長さに収める。

## 目的

`npx skills add` はキーワード検索で対象スキルを絞り込む。description の語の密度がヒット率に直結する。
Claude の自動発火（コンテキストマッチ）でも同様に description が参照される。
一方、過長な description は読み取りコストが高く管理も困難になる。両立が必須。

## ルール

- 発火トリガー語を含める（「〜して」「〜作って」「〜レビューして」「〜調べて」等、ユーザーが実際に言う表現）
- 役割を簡潔に名詞列挙しても良い（文章で説明しない）
- 定着した別名・略語を含める
  - 例: `Conventional Commits` → CC
  - 例: `GitHub Projects v2` → Projects v2
  - 例: `create-commit` → コミット作成
- 英語 API 名・コマンド名はそのまま英語で記載する（`gh pr create`・`git commit` 等）
- 冗長な助詞・繋ぎ言葉を避け、語の密度を上げる
- 関連スキルへの導線を記載する（例: 「別リポへの貢献は contribute-skill」）
- 長さの目安: 全角200字程度（`description` + `when_to_use` の合計は 1,536 文字上限）

## YAML の書き方

### ブロックスカラー vs クォート文字列

複数行・長い説明には `>` ブロックスカラーを使うと折り返せて管理しやすい。
短い1行説明は `"..."` クォート文字列で簡潔に書ける。

```yaml
# ブロックスカラー（複数行・長い場合）
description: >
  Conventional Commits (CC) 形式でコミットを作成。「コミットして」「変更をまとめて」で使用。
  feat / fix / docs / chore 等の type 自動選定。co-author 付与。

# クォート文字列（短い1行）
description: "PR を作成して GitHub へ push する。「PR 作って」「レビュー依頼して」で使用。"
```

## YAML の落とし穴（重要）

### `#` を含む場合は必ずクォート保護

`#` を含む語・`#` で始まる語はそのままだと YAML コメント扱いになり、`#` 以降の内容が消える。
**必ずクォートで囲むか、表現を変えて保護する**（本リポの教訓: コミット e83e1bb）。

```yaml
# 悪い例 — `#` 以降がコメントになり内容が消える
description: Issue を作成。GitHub Issues # タスク管理に使用。

# 良い例（クォートで保護）
description: "Issue を作成。GitHub Issues タスク管理に使用。"

# 良い例（表現を変えて回避）
description: >
  Issue を作成。GitHub Issues によるタスク管理。
```

ブロックスカラー（`>`）内でも `#` を含む行はコメント扱いされる場合があるため、
ブロックスカラー内でも `#` を含む語はクォートするか表現を変える。

### `:` の連続に注意

`:` の後にスペース+テキストが続くと YAML の値と誤認されることがある。語順変更で回避する。

```yaml
# 悪い例 — `:` の連続で値と誤認
description: >
  対応: commit, pr, issue の自動化

# 良い例 — 語順変更で回避
description: >
  commit / pr / issue の自動化対応
```

## 良い例 / 悪い例

```yaml
# 悪い例 — 文章調で冗長、トリガー語なし、語の密度が低い
description: >
  このスキルはコミットメッセージを Conventional Commits 形式で
  作成するためのものです。

# 良い例 — トリガー語含む、略語 CC 含む、名詞列挙、密度が高い
description: >
  Conventional Commits (CC) 形式でコミットを作成。「コミットして」「変更をまとめて」で使用。
  type 自動選定（feat / fix / docs / chore 等）、co-author 付与、--no-verify 禁止。
```

```yaml
# 悪い例 — 関連スキルへの導線がなく、略語もない
description: >
  GitHub に別リポジトリとして公開されているスキルを
  このリポジトリに取り込むためのスキルです。

# 良い例 — 導線あり、別名・略語含む
description: >
  上流リポジトリ（vercel-labs/skills）への貢献スキル。「contribute-skill して」「OSSに貢献したい」で使用。
  fork / PR 作成・upstream sync を自動化。sync-skills-lock も参照。
```

## 関連

- `./skill-authoring.md`
- `./agent-authoring.md`
- `./japanese-style.md`

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
---
```

### model 選定基準

| ユースケース | model |
|-----------|-------|
| 機械的・集計・一覧生成・frontmatter 更新 | `haiku` |
| 判定・生成・レビュー・複数ファイル読解 | `sonnet` |
| 複雑な計画立案・アーキテクチャ設計 | `opus` |

### description の注意事項

- 役割を一文で表現し、発火トリガー語（「〜して」「〜作って」「〜レビューして」等）を含める
- 関連スキルがあれば「詳細は contribute-skill」のように導線を記載
- `description:` 値に `#` を含める場合は**必ずクォートで囲む**（YAML コメント扱いを防ぐ）

  悪い例: `description: 変更をコミット # 詳細は create-commit`
  良い例: `description: "変更をコミット # 詳細は create-commit"`

  参考: コミット e83e1bb（YAML description 内の `#` をコメント扱いから保護）

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

## 検証

（完了確認方法）

## 注意事項

（制約・禁止事項・エッジケース）
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

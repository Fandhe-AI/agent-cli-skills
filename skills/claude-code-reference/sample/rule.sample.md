---
# paths: このルールを適用するファイル glob パターン。
# Claude がこのパターンに一致するファイルを編集しようとした際に自動的に参照される。
# paths を省略すると全コンテキストで常時参照される（グローバルルール）。
paths:
  - "skills/**"
  - ".claude/skills/**"

# description: ルールの目的を一行で記述する。
# Rule ファイルには description フィールドを使う（スキルと同様に YAML frontmatter）。
description: このルールが何を規定するかの一文説明。

# applies_to: このルールを参照する Agent 名・スキル名をカンマ区切りで列挙する（任意）。
# 検索・フィルタリングの手がかりとして使用する。
applies_to: skill-author, skill-reviewer
---

# ルール名（見出し）

<!-- ルールの目的を 1〜2 段落で説明する。 -->

このルールは〇〇を操作する際の規約を定める。

## 適用範囲

<!-- どのパス・どの操作に適用されるかを明記する。 -->

- `paths` に列挙されたファイルを編集するすべての Agent
- `applies_to` に列挙されたスキルが参照する

## 規約内容

### 基本的なフロー

1. 〇〇をする前に△△を確認する
2. ××の操作は直接行わず、一時ディレクトリを経由する（→ dotclaude-via-temp 参照）

### コマンド例

```bash
# 安全なコマンド例（変数は必ずクォート）
mv "${TMPDIR}/foo.md" ".claude/rules/foo.md"

# 空ディレクトリのみ削除（rm -rf は禁止）
rmdir "${TMPDIR}" 2>/dev/null
```

### paths vs applies_to の使い分け

| フィールド | 用途 |
|-----------|------|
| `paths` | ファイルパス glob で「編集時に自動参照」させる |
| `applies_to` | Agent 名・スキル名で「参照者を明示」する（自動参照は行われない） |

`paths` を省略すると、Claude は常にこのルールを参照する（グローバルルール）。
特定ファイルにのみ関係するルールは `paths` で限定することを推奨する。

## 禁止事項

- `rm -rf` による一括削除は禁止
- 変数をクォートせずにシェルコマンドへ渡すこと（インジェクションリスク）
- `--no-verify` によるフック回避

## 関連ルール

- `./dotclaude-via-temp.md` — `.claude/` 配下の操作手順
- `./security.md` — OWASP Top 10・秘密情報混入防止

---
description: リファレンス型スキルの個別ページと README 索引の書式規約。reference-researcher と skill-author が参照する。
paths:
  - "skills/*/reference/**"
  - "skills/*/references/**"
applies_to: reference-researcher, skill-author
---

# リファレンスファイル書式

`skills/<name>/reference/`（または `references/`）配下の個別ページと README 索引の書式規約。
`update-reference` スキルが本書式を前提にドキュメントを再取得・更新する。

## 個別ページの書式

各ファイルの先頭に出典コメント3行を必ず付ける。

```markdown
<!-- source: https://docs.example.com/api/foo -->
<!-- 最終確認日: YYYY-MM-DD -->
<!-- 取得状況: ✅ 取得済み | ⚠️ オンライン未検証 -->

# 名称

概要を1〜2行で。

## Signature / Usage

\`\`\`ts
functionName(param: Type): ReturnType
\`\`\`

## Options / Props

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| option | string | — | 説明 |

## Notes

- 重要な挙動・制約・バージョン差異

## Related

- [RelatedName](../other-category/related-page.md)
```

### 出典コメントの使い方

| フィールド | 値 | 用途 |
|-----------|---|------|
| `source` | 取得元 URL | `update-reference` が再取得する際の起点 |
| `最終確認日` | `YYYY-MM-DD` | 鮮度判定。古い場合は再取得を検討 |
| `取得状況` | `✅ 取得済み` / `⚠️ オンライン未検証` | 手書きか WebFetch 取得かを区別 |

### セクション規約

- 空セクションは省略する（`## Notes` に書くことがなければ丸ごと削除）
- `## Signature / Usage` には最小1つ以上のコード例を必ず含める
- `## Options / Props` が存在する場合は**必ず表形式**。散文で書かない
- `## Related` のリンクは相対パスを使用する（`./` または `../` 始まり）

### 本文の言語

| 要素 | 言語 |
|-----|------|
| `## Signature / Usage` のコード | 原文（英語等）のまま |
| `## Options / Props` の表 | Name/Type/Default は英語のまま。Description は日本語可 |
| `## Notes` | 日本語推奨 |
| `## Related` のリンクテキスト | 英語のまま（識別子） |
| ファイル先頭の概要1〜2行 | 日本語推奨 |

## README 索引の書式

カテゴリ直下の `README.md` は索引表のみ。説明文・見出し・散文は不要。
パスは `./` 始まりの相対パスで記述する。

```markdown
| 項目 | 説明 | パス |
| --- | --- | --- |
| functionName | One-line description（日本語可） | [functionName.md](./functionName.md) |
```

悪い例（散文・見出しを含む）:

```markdown
# Hooks カテゴリ

このカテゴリには Claude Code のフック関連 API が含まれます。

| 項目 | 説明 | パス |
...
```

良い例（索引表のみ）:

```markdown
| 項目 | 説明 | パス |
| --- | --- | --- |
| useSession | セッション取得フック | [useSession.md](./useSession.md) |
| useConfig | 設定読み込みフック | [useConfig.md](./useConfig.md) |
```

## 鮮度管理

`最終確認日` が古い場合（目安: 3ヶ月以上）は `update-reference` スキルで再取得を検討する。
`⚠️ オンライン未検証` のファイルは手書きのため、公式ドキュメントとの差異に注意する。

## 関連

- `./skill-authoring.md`
- `./japanese-style.md`

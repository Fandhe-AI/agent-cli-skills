---
name: project-view-status
description: プロジェクトの進捗をステータス別・優先度別・サイズ別に集計してレポートを生成する。完了率と未完了の優先度内訳を表形式で出力する読み取り専用スキル。「進捗を見せて」「プロジェクトレポート」「完了率は？」「ステータス別の件数」などで使用。
model: haiku
user-invocable: true
---

# project-view-status

プロジェクトの進捗状況をステータス別・優先度別に集計し、レポートを生成します。

## 前提条件

- 対象の GitHub Project が存在すること
- `gh` CLI がインストールされ、認証済みであること（`project` スコープ付き）
- 集計は `gh` の `--jq`（組み込み jq）で行うため、別途 `jq` のインストールは不要

## フロー

### Step 1: プロジェクト情報を取得する

```bash
gh project view <number> --owner <owner> --format json
```

プロジェクトのタイトル・説明・URL を取得する。

### Step 2: 全アイテムを取得する

`--limit` の固定値（例: 999）は、アイテムが上限を超えるプロジェクトで残りを無視し総件数・内訳・完了率を誤らせる。先に `totalCount` を取得し、その件数を `--limit` に渡して全件取得する。

```bash
total=$(gh project item-list <number> --owner <owner> --limit 1 --format json --jq '.totalCount')
[[ "${total}" =~ ^[0-9]+$ ]] || { echo "totalCount の取得に失敗した。中止する" >&2; exit 1; }
[ "${total}" -eq 0 ] && { echo "アイテム 0 件"; exit 0; }
```

以降の集計（Step 4）では `${total}` を `--limit` にそのまま渡す。各集計クエリは出力に `total`（`.totalCount`）と `n`（`.items | length`）を含め、その場で一致を確認する。一致しない場合は不完全な集計として扱わず、処理を停止してユーザーへ報告する（`--limit` の再指定や原因調査は報告後の対応とする）。

### Step 3: フィールド定義を取得する

```bash
gh project field-list <number> \
  --owner <owner> \
  --format json
```

Status, Priority, Size フィールドの定義とオプション値を取得する。

### Step 4: ステータス別・優先度別に集計する

件数と割合は `gh` の `--jq`（組み込み jq）で算出する（手で数えない、standalone の `jq` インストールは不要）。例:

```bash
gh project item-list <number> --owner <owner> --limit "${total}" --format json \
  --jq '{total: .totalCount, n: (.items | length), by_status: ([.items[] | .status // "(未設定)"] | group_by(.) | map({key: .[0], count: length}))}'
```

優先度別・ステータス × 優先度も同様に `--jq` の `group_by` で求め、完了率は Done 件数 ÷ 全件で計算する。集計ごとに再取得するため、クエリの出力には毎回 `total` と `n` を含めてその場で一致を確認する。一致しない出力は集計に使わない（不完全な集計を返さず停止してユーザーへ報告する）。モデルは算出結果を表に整形し、目立つ偏りがあればコメントする。

### Step 5: レポートを生成する

以下の形式でレポートを出力:

```markdown
## プロジェクト進捗レポート: <タイトル>

**更新日時:** YYYY-MM-DD HH:MM

### 全体進捗
- 総アイテム数: N 件
- 完了率: XX% (N/M)
- 進行中: N 件
- レビュー中: N 件
- 未着手: N 件

### ステータス別

| ステータス | 件数 | 割合 |
|-----------|------|------|
| Done | N | XX% |
| In Review | N | XX% |
| In Progress | N | XX% |
| Todo | N | XX% |

### 優先度別（未完了のみ）

| 優先度 | 件数 | In Progress | Todo |
|--------|------|------------|------|
| High | N | N | N |
| Medium | N | N | N |
| Low | N | N | N |

### サイズ別（未完了のみ）

| サイズ | 件数 |
|--------|------|
| XL | N |
| L | N |
| M | N |
| S | N |
| XS | N |
```

## 注意事項

- `--limit` は固定値ではなく `totalCount`（Step 2 で取得した `${total}`）を渡し、ページネーション切り捨てを防ぐ
- 読み取り専用の操作のため、プロジェクトに変更を加えない
- フィールドが存在しない場合は該当セクションをスキップする
- アイテムが 0 件の場合はその旨を報告する
- ネットワークを要する（読み取りのみ。後述の「sandbox 環境での実行」節を参照）

## 検証

Step 5 のレポート出力に以下が含まれていれば完了:
- 総アイテム数・完了率が表示されている
- ステータス別・優先度別の件数が集計されている

プロジェクトに変更は加わらない（読み取り専用）。

## sandbox 環境での実行

Step 1〜3 の `gh project view` / `gh project item-list` / `gh project field-list` はいずれも GitHub API への読み取りであり、ネットワークを要する。該当コマンド単位で sandbox 無効にして実行する。本スキルは書き込みを一切行わない（プロジェクトへの変更なし・ワークスペース外への書き込みなし）。Step 4〜5 の集計・レポート生成はローカル処理であり、ネットワークを要しない。

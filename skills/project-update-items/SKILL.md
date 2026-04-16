---
name: project-update-items
description: プロジェクトアイテムのフィールド値（ステータス・優先度等）を一括更新する。
---

# project-update-items

プロジェクトアイテムのフィールド値を一括で更新します。ステータス変更、優先度変更、サイズ設定などに対応します。

## 前提条件

- 対象の GitHub Project にアイテムが存在すること
- `gh` CLI がインストールされ、認証済みであること（`project` スコープ付き）

## フロー

### Step 1: 更新対象と更新内容を確認する

ユーザーから以下を確認:
- **対象の指定方法:**
  - クエリフィルタ（例: `status:Todo`, `label:bug`, `assignee:@me`）
  - アイテム番号の直接指定
  - 全件
- **更新するフィールド:** Status, Priority, Size, またはカスタムフィールド
- **新しい値:** 例: Status → "In Progress", Priority → "High"

### Step 2: フィールドメタデータを取得する

```bash
# プロジェクト ID を取得
gh project view <number> --owner <owner> --format json -q '.id'

# フィールド ID とオプション ID を取得
gh project field-list <number> --owner <owner> --format json
```

`jq` で対象フィールドの ID と、更新先の値に対応するオプション ID を解決する。

### Step 3: 対象アイテムを検索する

```bash
gh project item-list <number> \
  --owner <owner> \
  --format json \
  --limit 999
```

ユーザー指定の条件でアイテムをフィルタする。`--query` パラメータが使える場合はそちらを優先:

```bash
gh project item-list <number> \
  --owner <owner> \
  --query "status:Todo" \
  --format json
```

### Step 4: ユーザーに更新内容を確認する

更新対象と変更内容を一覧表示:

```
以下の N 件のアイテムを更新します:
- #1: ソーシャルログイン — Status: Todo → In Progress
- #2: パスワードリセット — Status: Todo → In Progress

実行しますか？
```

### Step 5: フィールド値を一括更新する

各アイテムに対してフィールド値を更新:

```bash
gh project item-edit \
  --id <item-id> \
  --field-id <field-id> \
  --project-id <project-id> \
  --single-select-option-id <option-id>
```

フィールドタイプに応じて適切なフラグを使用:
- SINGLE_SELECT: `--single-select-option-id`
- TEXT: `--text`
- NUMBER: `--number`
- DATE: `--date`（YYYY-MM-DD 形式）

### Step 6: 更新結果を報告する

更新されたアイテムの一覧を表示:

| # | タイトル | フィールド | 旧値 | 新値 |
|---|---------|----------|------|------|
| 1 | ソーシャルログイン | Status | Todo | In Progress |
| 2 | パスワードリセット | Status | Todo | In Progress |

## 注意事項

- バッチ更新前に必ずユーザーの確認を得る
- オプション値がプロジェクトのフィールド定義に存在しない場合はエラーを報告する
- 複数フィールドを同時に更新する場合は、フィールドごとに `item-edit` を実行する
- GitHub API レート制限に注意し、大量更新時はバッチサイズを調整する
- **sandbox 環境での `GIT_SSL_NO_VERIFY=1` 併用**：詳細は後述の「sandbox 環境での実行」節を参照

## sandbox 環境での実行

sandbox では中間 TLS 証明書の検証に通らない場合があります。ネットワーク越しの GitHub 操作には `GIT_SSL_NO_VERIFY=1` の併用を検討してください（ホスト側で allow 済みが前提）。

| 対象 | `GIT_SSL_NO_VERIFY=1` の要否 | コマンド例 |
|------|-----------------------------|-----------|
| リモート取得 | 要 | `gh repo clone`, `git clone`, `git fetch`, `git pull`, `git ls-remote` |
| リモート書き込み | 要（本スキルは主に API 経由） | `git push` |
| GitHub API 操作 | 要 | `gh auth`, `gh api`, `gh pr ...`, `gh issue ...`, `gh project ...`, `gh label ...` |
| ローカル操作 | 不要 | `git log`, `git diff`, `git status`, `git add`, `git commit`, `git switch`, ファイル I/O |

`GIT_SSL_NO_VERIFY=1` は TLS 検証を無効にするだけで、認証自体は別途必要です（`gh auth login` 済み OAuth トークン / SSH 鍵 / PAT）。信頼できないネットワーク下では使用しないでください。

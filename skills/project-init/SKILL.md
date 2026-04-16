---
name: project-init
description: GitHub Project v2 を作成し、標準フィールド・ビルトインワークフローを設定する。
---

# project-init

GitHub Project v2 を新規作成し、標準フィールドを設定してリポジトリにリンクします。ビルトインワークフロー（自動ステータス変更・自動追加・自動アーカイブ）の設定もガイドします。

## 前提条件

- `gh` CLI がインストールされ、認証済みであること
- `project` スコープが付与されていること（`gh auth status` で確認）

## フロー

### Step 1: プロジェクト情報を確認する

ユーザーから以下を確認:
- プロジェクトタイトル
- オーナー（ユーザー or Organization）
- 可視性（PUBLIC / PRIVATE）
- 説明文（任意）

オーナーが未指定の場合は自動検出:

```bash
gh repo view --json owner -q '.owner.login'
```

### Step 2: プロジェクトを作成する

```bash
gh project create \
  --owner <owner> \
  --title "<タイトル>" \
  --format json
```

出力からプロジェクト番号を取得する。

### Step 3: リポジトリにリンクする

```bash
gh project link <number> --owner <owner>
```

### Step 4: 標準フィールドを作成する

以下のフィールドを順次作成する:

```bash
# Status（デフォルトで存在する場合はスキップ）
gh project field-create <number> \
  --owner <owner> \
  --name "Status" \
  --data-type "SINGLE_SELECT" \
  --single-select-options "Todo,In Progress,In Review,Done"

# Priority
gh project field-create <number> \
  --owner <owner> \
  --name "Priority" \
  --data-type "SINGLE_SELECT" \
  --single-select-options "High,Medium,Low"

# Size
gh project field-create <number> \
  --owner <owner> \
  --name "Size" \
  --data-type "SINGLE_SELECT" \
  --single-select-options "XS,S,M,L,XL"
```

> **Note:** Status フィールドは GitHub が自動作成する場合がある。エラーが出た場合は既存フィールドをそのまま使用する。

### Step 5: プロジェクトの説明を設定する

```bash
gh project edit <number> \
  --owner <owner> \
  --description "<説明文>" \
  --visibility <PUBLIC|PRIVATE>
```

### Step 6: ビルトインワークフローを設定する

GitHub Projects v2 にはコード不要のビルトインワークフローがある。プロジェクト設定画面でユーザーに以下の有効化をガイドする。

設定 URL: `https://github.com/orgs/<owner>/projects/<number>/workflows`
（個人プロジェクトの場合: `https://github.com/users/<owner>/projects/<number>/workflows`）

#### 推奨するビルトインワークフロー

| ワークフロー | 動作 | デフォルト状態 | 推奨 |
|---|---|---|---|
| Item closed | Issue/PR がクローズされたら Status → Done | **有効** | そのまま維持 |
| Pull request merged | PR がマージされたら Status → Done | **有効** | そのまま維持 |
| Item reopened | Issue が再オープンされたら Status → Todo | 無効 | **有効化を推奨** |
| Item added to project | アイテム追加時に Status → Todo | 無効 | **有効化を推奨** |
| Auto-add to project | フィルタに一致する Issue/PR を自動追加 | 無効 | **有効化を推奨** |
| Auto-archive items | Done から N 日後に自動アーカイブ | 無効 | 任意 |
| Auto-close issue | ボードで Done にすると Issue を自動クローズ | **無効** | **有効化を強く推奨** |

> **重要:** Auto-close を有効にしないと、ボード上で Status を Done にしても Issue は自動クローズ**されない**。双方向同期には必須。

#### Auto-add フィルタ例

```
is:issue,pr is:open repo:<owner>/<repo>
```

ラベルで絞り込む場合:
```
is:issue,pr is:open label:sprint-1 repo:<owner>/<repo>
```

### Step 7: 継続的自動同期の案内

ビルトインワークフローではカバーできない PR ライフサイクル連動（opened→In Progress, review_requested→In Review）などの高度な同期が必要な場合は、`project-sync-issues` スキルで GitHub Actions ワークフローを生成できることを案内する。

### Step 8: 作成結果を報告する

以下の情報を表示:
- プロジェクト URL
- プロジェクト番号
- 作成されたフィールド一覧
- リンクされたリポジトリ
- ビルトインワークフロー設定 URL
- 推奨設定のチェックリスト

## 注意事項

- Status のオプション値はユーザーの要望に応じてカスタマイズ可能
- フィールド作成でエラーが発生した場合（既に存在する等）はスキップして続行する
- Organization プロジェクトの場合、適切な権限が必要
- ビルトインワークフローは CLI/API では設定できないため、Web UI での設定が必要
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

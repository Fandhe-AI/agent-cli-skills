---
name: project-sync-issues
description: GitHub Actions ワークフローを生成して Issue/PR とプロジェクトの自動同期を設定する。
---

# project-sync-issues

GitHub Actions ワークフローファイルを生成し、Issue/PR の状態変更をプロジェクトの Status フィールドに自動同期します。手動での一括補正モードも提供します。

## 前提条件

- 対象の GitHub Project がリポジトリにリンクされていること
- `gh` CLI がインストールされ、認証済みであること（`project` スコープ付き）

## フロー

ユーザーに実行モードを確認する:
- **自動同期セットアップ** — GitHub Actions ワークフローを生成（初回推奨）
- **手動一括補正** — 現在の不整合を一括修正（スポット実行用）

---

## モード A: 自動同期セットアップ

### Step A-1: プロジェクト情報を取得する

```bash
# オーナーを取得
gh repo view --json owner -q '.owner.login'

# プロジェクト番号を確認
gh project list --owner <owner> --format json
```

ユーザーに対象プロジェクトの番号を確認する。

### Step A-2: 認証シークレットを案内する

GitHub Actions から Projects API にアクセスするには `GITHUB_TOKEN` では不足するため、以下のいずれかが必要:

**方法 1: Personal Access Token（個人/小規模向け）**

1. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. 必要なスコープ: `project`（読み書き）+ `issues`（読み書き）+ `pull_requests`（読み書き）
3. リポジトリの Settings → Secrets and variables → Actions → `PROJECT_TOKEN` として登録

**方法 2: GitHub App トークン（Organization 向け・推奨）**

1. GitHub App を作成し、Organization に `Projects: Read and write` 権限を付与
2. ワークフロー内で `actions/create-github-app-token` を使用してトークンを生成

### Step A-3: GitHub Actions ワークフローを生成する

`.github/workflows/project-sync.yml` を生成する:

```yaml
name: Project Sync

on:
  issues:
    types: [opened, closed, reopened]
  pull_request:
    types: [opened, closed, ready_for_review, review_requested]

env:
  PROJECT_NUMBER: <number>
  PROJECT_OWNER: <owner>

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Generate token
        id: token
        # 方法 1: PAT を使用する場合
        # env.GH_TOKEN に PROJECT_TOKEN シークレットを設定
        run: echo "token=${{ secrets.PROJECT_TOKEN }}" >> "$GITHUB_OUTPUT"

        # 方法 2: GitHub App を使用する場合（推奨）
        # uses: actions/create-github-app-token@v2
        # with:
        #   app-id: ${{ vars.APP_ID }}
        #   private-key: ${{ secrets.APP_PRIVATE_KEY }}
        #   owner: ${{ env.PROJECT_OWNER }}

      - name: Get project metadata
        id: meta
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          # プロジェクト ID を取得
          PROJECT_ID=$(gh project view ${{ env.PROJECT_NUMBER }} \
            --owner ${{ env.PROJECT_OWNER }} \
            --format json -q '.id')
          echo "project_id=$PROJECT_ID" >> "$GITHUB_OUTPUT"

          # Status フィールドの ID とオプション ID を取得
          FIELDS=$(gh project field-list ${{ env.PROJECT_NUMBER }} \
            --owner ${{ env.PROJECT_OWNER }} \
            --format json)

          STATUS_FIELD_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name == "Status") | .id')
          echo "status_field_id=$STATUS_FIELD_ID" >> "$GITHUB_OUTPUT"

          TODO_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Todo") | .id')
          IN_PROGRESS_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "In Progress") | .id')
          IN_REVIEW_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "In Review") | .id')
          DONE_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Done") | .id')

          echo "todo_id=$TODO_ID" >> "$GITHUB_OUTPUT"
          echo "in_progress_id=$IN_PROGRESS_ID" >> "$GITHUB_OUTPUT"
          echo "in_review_id=$IN_REVIEW_ID" >> "$GITHUB_OUTPUT"
          echo "done_id=$DONE_ID" >> "$GITHUB_OUTPUT"

      - name: Add item to project
        id: add
        if: >-
          (github.event_name == 'issues' && github.event.action == 'opened') ||
          (github.event_name == 'pull_request' && github.event.action == 'opened')
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          ITEM_URL="${{ github.event.issue.html_url || github.event.pull_request.html_url }}"
          ITEM_ID=$(gh project item-add ${{ env.PROJECT_NUMBER }} \
            --owner ${{ env.PROJECT_OWNER }} \
            --url "$ITEM_URL" \
            --format json -q '.id')
          echo "item_id=$ITEM_ID" >> "$GITHUB_OUTPUT"

      - name: Get existing item ID
        id: existing
        if: steps.add.outcome == 'skipped'
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          CONTENT_URL="${{ github.event.issue.html_url || github.event.pull_request.html_url }}"
          ITEMS=$(gh project item-list ${{ env.PROJECT_NUMBER }} \
            --owner ${{ env.PROJECT_OWNER }} \
            --format json --limit 999)
          ITEM_ID=$(echo "$ITEMS" | jq -r \
            --arg url "$CONTENT_URL" \
            '.items[] | select(.content.url == $url) | .id')
          echo "item_id=$ITEM_ID" >> "$GITHUB_OUTPUT"

      - name: Determine target status
        id: status
        run: |
          EVENT="${{ github.event_name }}"
          ACTION="${{ github.event.action }}"
          MERGED="${{ github.event.pull_request.merged }}"

          if [ "$EVENT" = "issues" ]; then
            case "$ACTION" in
              opened)   echo "option_id=${{ steps.meta.outputs.todo_id }}" >> "$GITHUB_OUTPUT" ;;
              closed)   echo "option_id=${{ steps.meta.outputs.done_id }}" >> "$GITHUB_OUTPUT" ;;
              reopened) echo "option_id=${{ steps.meta.outputs.todo_id }}" >> "$GITHUB_OUTPUT" ;;
            esac
          elif [ "$EVENT" = "pull_request" ]; then
            case "$ACTION" in
              opened)           echo "option_id=${{ steps.meta.outputs.in_progress_id }}" >> "$GITHUB_OUTPUT" ;;
              ready_for_review) echo "option_id=${{ steps.meta.outputs.in_review_id }}" >> "$GITHUB_OUTPUT" ;;
              review_requested) echo "option_id=${{ steps.meta.outputs.in_review_id }}" >> "$GITHUB_OUTPUT" ;;
              closed)
                if [ "$MERGED" = "true" ]; then
                  echo "option_id=${{ steps.meta.outputs.done_id }}" >> "$GITHUB_OUTPUT"
                else
                  echo "option_id=${{ steps.meta.outputs.todo_id }}" >> "$GITHUB_OUTPUT"
                fi
                ;;
            esac
          fi

      - name: Update status
        if: steps.status.outputs.option_id != ''
        env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
        run: |
          ITEM_ID="${{ steps.add.outputs.item_id || steps.existing.outputs.item_id }}"
          if [ -n "$ITEM_ID" ]; then
            gh project item-edit \
              --id "$ITEM_ID" \
              --field-id "${{ steps.meta.outputs.status_field_id }}" \
              --project-id "${{ steps.meta.outputs.project_id }}" \
              --single-select-option-id "${{ steps.status.outputs.option_id }}"
          fi
```

### Step A-4: ステータスマッピングを確認する

生成するワークフローのデフォルトマッピング:

| イベント | アクション | Status |
|---------|----------|--------|
| Issue | opened | Todo |
| Issue | closed | Done |
| Issue | reopened | Todo |
| PR | opened | In Progress |
| PR | ready_for_review | In Review |
| PR | review_requested | In Review |
| PR | closed (merged) | Done |
| PR | closed (not merged) | Todo |

ユーザーの要望に応じてマッピングをカスタマイズする。

### Step A-5: ワークフローファイルを配置する

```bash
mkdir -p .github/workflows
# ワークフローファイルを .github/workflows/project-sync.yml に書き出す
```

ユーザーにコミット・プッシュを案内する。

---

## モード B: 手動一括補正

プロジェクトと Issue/PR の現在の状態を比較し、不整合を一括修正する。自動同期セットアップ後の初回補正や、手動変更の反映に使用する。

### Step B-1: プロジェクトアイテムを取得する

```bash
gh project item-list <number> \
  --owner <owner> \
  --format json \
  --limit 999
```

### Step B-2: Issue/PR の現在状態を確認する

Issue/PR タイプのアイテムに対して現在の状態を確認:

```bash
gh issue view <issue-url> --json state,labels,assignees
gh pr view <pr-url> --json state,isDraft,reviewRequests,merged
```

### Step B-3: 状態の不一致を検出する

以下の不一致パターンを検出:
- **Issue が closed だがプロジェクトの Status が Done でない** → Done に更新
- **Issue が open だがプロジェクトの Status が Done** → Todo に更新
- **PR がマージ済みだが Status が Done でない** → Done に更新
- **PR にレビューリクエストがあるが Status が In Review でない** → In Review に更新

### Step B-4: リポジトリの未追加 Issue/PR を検出する

```bash
gh issue list --state open --json number,url,title --limit 999
gh pr list --state open --json number,url,title --limit 999
```

プロジェクトのアイテム URL と比較して未追加分を特定する。

### Step B-5: ユーザーに同期内容を確認する

検出結果を表示:

```
## 同期内容

### ステータス更新（N 件）
- #42: ソーシャルログイン — Status: In Progress → Done（Issue closed）
- #45: バグ修正 — Status: Done → Todo（Issue reopened）
- #50: リファクタリング PR — Status: In Progress → In Review（レビュー依頼済み）

### 新規追加（M 件）
- #55: 新機能リクエスト (Issue)
- #56: ドキュメント更新 PR

実行しますか？
```

### Step B-6: 同期を実行する

```bash
# フィールドメタデータを取得
gh project field-list <number> --owner <owner> --format json

# ステータス更新
gh project item-edit \
  --id <item-id> \
  --field-id <status-field-id> \
  --project-id <project-id> \
  --single-select-option-id <option-id>

# 新規追加
gh project item-add <number> \
  --owner <owner> \
  --url <issue-or-pr-url> \
  --format json
```

### Step B-7: 同期結果を報告する

| 操作 | 件数 |
|------|------|
| ステータス更新 | N 件 |
| 新規追加 | M 件 |
| 変更なし | K 件 |

## 注意事項

- **認証:** GitHub Actions から Projects API へのアクセスには `GITHUB_TOKEN` では不足。PAT または GitHub App トークンが必要
- **ビルトインワークフローとの併用:** `project-init` でビルトインワークフロー（closed→Done, merged→Done）を有効化済みの場合、Actions ワークフローと二重に発火するが、同じ値への更新なので実害はない
- **PR ライフサイクル:** ビルトインワークフローは closed/merged のみ対応。opened→In Progress, review_requested→In Review は Actions でのみ自動化可能
- 手動補正モードは同期前に必ずユーザーの確認を得る
- DraftIssue タイプのアイテムは同期対象外（実 Issue が存在しないため）

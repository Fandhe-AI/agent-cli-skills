---
name: implement-issue-tree
description: >
  親イシュー配下のサブイシュー（孫含む）を post-order DFS で自動実装・レビュー・PR 作成・CI 監視・squash merge まで一括自動化。
  「イシューツリーを自動開発」「配下のサブイシューを順番に実装」「ツリー全体を実装して」「イシュー階層をまとめて実装」で使用。
  単一イシューの実装は implement-issue、PR レビューは implement-review-pr を参照。
model: opus
user-invocable: true
argument-hint: "<親イシュー番号> [マージ先ブランチ（省略時 main）]"
---

# implement-issue-tree

親イシュー番号を指定し、配下のサブイシュー（孫含む）を post-order DFS（子をすべて終えてから親）で自動実装・レビュー・PR 作成・CI 監視・squash merge まで自動化する Workflow を起動する。

## 前提条件

- `gh` CLI がインストールされ、認証済みであること（`gh auth status` で確認）
- git working tree が clean であること（`git status` で確認）
- マージ先ブランチが CI green の状態であること
- 対象リポジトリへの書き込み権限があること

## 使い方

Workflow ツールで以下のように起動する:

```json
{
  "scriptPath": ".claude/workflows/implement-issue-tree.js",
  "args": {
    "parent": "<親イシュー番号>",
    "branch": "<マージ先ブランチ（省略時 main）>"
  }
}
```

例: 親イシュー `#42` の配下を `main` にマージする場合:

```json
{
  "scriptPath": ".claude/workflows/implement-issue-tree.js",
  "args": { "parent": 42, "branch": "main" }
}
```

## フロー

### Step 1: ツリーを取得して実行キューを構築する（Plan）

gh CLI の sub-issues API で親イシュー配下の全ツリーを再帰取得し、post-order DFS で実行キューを構築する。

```bash
# 親イシューのサブイシューを取得
gh api repos/{owner}/{repo}/issues/<parent>/sub_issues

# 再帰的に孫以下も取得してツリーを構築
# post-order DFS: 同一親内はリスト順、子をすべて終えてから親を処理
```

実行キューの構築ルール:
- 同一親内のサブイシューはリスト順（上から）に処理する
- 子イシューがすべて完了してから親イシューを処理する（post-order）
- closed 済みイシューは自動でスキップする

### Step 2: 各イシューを独立したサブエージェントで実装する（Implement）

実行キューの各イシューを独立したサブエージェントで処理する。同一階層の子イシューは**直列処理**（post-order DFS の性質上、子が完了するまで次の子には進まない）。

処理内容:
1. 指定ブランチ（デフォルト: `main`）から作業ブランチを作成する
2. `implement-issue` フローでコードを実装する（**本ワークフローではユーザー承認を省略**）
3. 実装後に OWASP Top 10 観点でセキュリティチェックを実施する（API キーのハードコード・インジェクション等）。問題が見つかった場合は修正してから次へ進む
4. `implement-review` の指摘を重要度問わずすべて修正する
5. `create-pr` で PR を作成する（body に `Closes #N`、base: 指定ブランチ）

```bash
# 作業ブランチ作成例
git checkout -b feat/issue-<N>-<slug> <base-branch>

# PR 作成例（Closes でイシューと紐付け）
gh pr create \
  --base <branch> \
  --title "feat: イシュータイトル" \
  --body "$(cat <<'EOF'
## Summary
- 実装内容の要約

Closes #<N>
EOF
)"
```

### Step 3: CI 監視・レビューコメント解決確認・squash merge する（Merge）

`gh pr checks --watch` で CI を監視し、全チェック green になったら **レビューコメントが全て解決済み**であることを確認してから squash merge する。

```bash
# CI 監視
gh pr checks <pr-number> --watch --interval 60

# レビュースレッドの解決確認（GraphQL）— 100 件超はページネーションで全件取得する
# after: $cursor を使い pageInfo.hasNextPage が false になるまでループする
gh api graphql -f query='
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes { isResolved comments(last: 1) { nodes { body author { login } } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }' -F owner="{owner}" -F name="{repo}" -F number=<pr-number> -F cursor=""

# 全解決済みの場合のみ squash merge
gh pr merge <pr-number> --squash --delete-branch
```

未解決のレビュースレッドがある場合は修正エージェントが指摘内容を反映して再監視する（最大 6 ラウンド）。6 ラウンド以内に解決できない場合はそのイシューで停止し、最終レポートに記録する。

### Step 4: 親イシューを検証してクローズする

子を持つノード（親イシュー）は、配下のすべての子イシューが完了した時点で以下を確認してクローズする。

```bash
# 1. 全子イシューが closed か確認
gh api repos/{owner}/{repo}/issues/<parent>/sub_issues --jq '.[].state'

# 2. 受入基準・チェックリストを読む
gh issue view <parent-number>

# 3. 受入基準を満たしていればクローズ
gh issue close <parent-number> --comment "配下のサブイシューがすべて実装・マージ完了。受入基準を確認してクローズ。"
```

open のサブイシューが残っている場合、または受入基準が未達の場合はクローズせずに停止し、最終レポートに残課題を記録する。

### Step 5: 最終レポートを生成する

全イシューの処理結果をまとめてレポートを出力する。

```
## implement-issue-tree 完了レポート

### 処理結果サマリー
- 完了: N 件
- スキップ（closed 済み）: N 件
- 停止: N 件

### 完了イシュー
- #N: タイトル — PR #M (squash merged)
...

### 停止イシュー（要確認）
- #N: タイトル — 停止理由（CI 失敗 / レビュー未解決等）
```

## 検証

最終レポートの「完了イシュー」に全対象イシューが列挙され、「停止イシュー」が空であることを確認する。

```bash
# 対象イシューが全て closed になっているか確認
gh api repos/{owner}/{repo}/issues/<parent>/sub_issues --jq '.[].state'

# PR が全て squash merge されているか確認
gh pr list --state merged --search "Closes #<parent>"
```

## モデル割り当て

| 処理 | model |
|------|-------|
| 実装系（implement-issue フロー） | opus |
| 監視・検証系（CI 監視・受入基準確認） | sonnet |

## 注意事項

- **ユーザー承認なしで PR 作成・merge まで自動実行する**ため、事前に親イシュー番号・ブランチを慎重に確認する
- 大規模ツリー（数百件）はサブ親単位で複数回に分けて実行する（1 ワークフローのエージェント上限は 1,000）
- 中断・失敗からの再開:
  - 同一セッション内なら `resumeFromRunId` を使用する
  - セッションを跨ぐ場合は同じ `args` で再実行すれば closed 済みイシューは自動でスキップされる
- `--no-verify` は絶対に使用しない（pre-commit フック回避禁止）
- シェルコマンドの変数は必ず `"${var}"` でクォートする（コマンドインジェクション対策）
- いずれかのイシューでマージに到達できない場合はそこで停止し、最終レポートに記録する
- マージ前に **レビューコメントが全て解決済みであること**を確認する（未解決コメントがある場合はマージしない）

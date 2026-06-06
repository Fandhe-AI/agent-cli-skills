---
# name: スキルのディレクトリ名と完全一致させる（必須）。kebab-case のみ使用可。
# 例: skills/my-new-skill/ であれば name: my-new-skill
name: my-new-skill

# description: ユーザーが「〜して」「〜作って」と言ったときに発火するトリガー語を含める。
# 関連スキルへの導線もここに書く。
# 重要: description の値に # を含む場合は必ずダブルクォートで囲む（YAML コメント扱いを防ぐ）。
#   NG 例: description: コミットを作成 # create-commit 参照
#   OK 例: description: "コミットを作成。詳細は create-commit 参照"
description: "このスキルが何をするかの一文説明。「〜して」「〜作って」「〜確認して」などのトリガー語を含める。"

# model の選定基準:
#   haiku  — 機械的・集計・一覧生成・frontmatter 更新など判断不要な処理
#   sonnet — 判定・生成・レビュー・複数ファイル読解など
#   opus   — 複雑な計画立案・アーキテクチャ設計
model: sonnet

# user-invocable: ユーザーが「/my-new-skill」と直接呼ぶ場合のみ true にする（任意）
# user-invocable: true

# argument-hint: スキルが引数を受け取る場合のみ記載（任意）
# argument-hint: "<対象スキル名> (例: my-new-skill foo-bar)"
---

# my-new-skill

このスキルが何をするかの一文説明。

## 前提条件

<!-- ツール・権限・認証状態などを列挙する。不要なら削除可。 -->

- `gh` CLI がインストールされ、認証済みであること（`gh auth status` で確認）
- 対象リポジトリへの書き込み権限があること

## フロー

### Step 1: 状態を確認する

<!-- 各 Step は「目的 + コマンド例」の構成にする。 -->

```bash
git status
git diff --staged
```

説明文。何を確認するのか、結果をどう解釈するかを書く。

### Step 2: メイン処理を実行する

```bash
gh api \
  --method POST \
  repos/{owner}/{repo}/issues \
  -f title="タイトル" \
  -f body="本文"
```

変数は必ずダブルクォートで囲む（コマンドインジェクション対策）。

### Step 3: 結果を確認してユーザーに返す

処理結果の URL・番号などをユーザーに提示する。

## 検証

<!-- 完了確認の方法を記載する。 -->

- 作成されたリソースの URL を確認する
- `gh issue view <number>` 等で内容を再確認する

## 注意事項

<!-- 制約・禁止事項・エッジケース -->

- `--no-verify` は絶対に使用しない（pre-commit フック回避禁止）
- `.env` や認証情報ファイルが含まれる場合は警告してコミットを中止する
- 破壊的操作（削除等）の前は必ずユーザーの確認を得る
- **sandbox 環境での `GIT_SSL_NO_VERIFY=1` 併用**：詳細は `docs/sandbox-tls.md` を参照

---
name: create-issue
description: GitHub Issue を親子構造 (sub-issues) で作成する。
---

# create-issue

GitHub Issue を親子構造で作成します。

## 前提条件

- `gh` CLI がインストールされ、認証済みであること
- `gh auth status` で確認できる

## フロー

### Step 1: タスク内容を分析する

ユーザーの説明から以下を抽出:
- 機能・修正の概要
- 背景・モチベーション
- 受け入れ条件
- 個別タスクへの分解

### Step 2: 親 Issue を作成する

```bash
gh issue create \
  --title "feat: 機能名" \
  --body "$(cat <<'EOF'
## 概要
...

## 背景
...

## 受け入れ条件
- [ ] 条件1
- [ ] 条件2

## 関連
- Figma: ...
- 関連 Issue: #...
EOF
)"
```

タイトルは Conventional Commits 形式: `feat:`, `fix:`, `chore:` 等。

### Step 3: 子 Issue を作成する

各個別タスクを子 Issue として作成:

```bash
gh issue create \
  --title "feat: タスク名" \
  --body "..."
```

### Step 4: Sub-issues として紐付ける

`gh api` を使用して子 Issue を親の sub-issues に追加:

```bash
gh api \
  --method POST \
  repos/{owner}/{repo}/issues/{parent_number}/sub_issues \
  -f sub_issue_id={child_number}
```

### Step 5: Issue URL を返す

作成した親 Issue と子 Issue の URL を一覧表示する。

## 注意事項

- Issue タイトルは Conventional Commits 形式を推奨
- 子 Issue は独立して完了できる粒度にする
- ラベル・マイルストーンが必要な場合はユーザーに確認する
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

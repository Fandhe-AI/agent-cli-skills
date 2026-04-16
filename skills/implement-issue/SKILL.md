---
name: implement-issue
description: GitHub Issue を読み込み、計画作成後にコードを実装する。
---

# implement-issue

GitHub Issue を読み込み、計画確認後にコードを実装します。

## フロー

### Step 1: Issue を取得する

Issue URL または番号から内容を取得:

```bash
gh issue view <url-or-number>
```

### Step 2: コードベースを調査して実装計画を作成する

Issue の内容をもとに関連コードを調査し、`_/local-plans/` に詳細な計画ファイルを作成する。

#### 2-1. 関連コードを調査する

以下を並行して調査:
- 変更対象ファイルの現状（Glob / Grep / Read）
- 再利用可能な既存コンポーネント・ユーティリティ
- 該当 API エンドポイント
- 同様の実装パターン

#### 2-2. 計画ファイルを `_/local-plans/` に保存する

ファイル名: `<issue-number>-<issue-slug>.md`（例: `_/local-plans/42-add-auth.md`）

計画の必須セクション:

```markdown
# [Issue タイトル]

## Context
Issue の背景・目的・なぜこの変更が必要か。

## Approach
実装方針。選択肢がある場合は採用理由も記述。

## File Changes

| ファイルパス | 変更内容 |
|-------------|---------|
| `src/...` | 〜を追加 |
| `lib/...` | 〜を修正 |

## Reuse
再利用する既存実装のパスと用途。

## Test Plan
- [ ] 動作確認手順
- [ ] エッジケース確認
```

### Step 3: ユーザーに計画を提示して承認を待つ

作成した計画ファイルの内容を表示し、ユーザーの承認を得てから実装を開始する。
**承認なしに実装を開始してはならない。**

### Step 4: コードを実装する

CLAUDE.md やプロジェクトの規約に従って実装する。
広範な変更の場合は `isolation: "worktree"` を使用して安全に実施。

### Step 5: セキュリティレビュー（必須）

Agent ツールでセキュリティ確認を行う。

確認項目:
- OWASP Top 10
- API キー・シークレットのハードコーディング
- 入力バリデーション
- XSS の可能性

問題が見つかった場合は修正してから次のステップに進む。

### Step 6: テストを実行する

プロジェクトのテストコマンドを実行する。テストが失敗した場合は修正する。

### Step 7: コミットを作成する

`create-commit` スキルを使用して Conventional Commits 形式でコミットを作成する。

## 注意事項

- ユーザーの承認なしに実装を開始しない
- セキュリティ問題が未解決のままコミットしない
- 大きな変更はステップを分けてコミットする
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

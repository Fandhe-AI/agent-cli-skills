---
name: create-pr
description: Conventional Commits 形式で GitHub PR を作成する。
---

# create-pr

変更内容を分析してセキュリティチェック後に GitHub PR を作成します。

## 前提条件

- `gh` CLI がインストールされ、認証済みであること
- 現在のブランチがベースブランチからフォークされていること

## フロー

### Step 1: 変更内容を分析する

```bash
git log main..HEAD --oneline
git diff main...HEAD --stat
```

ベースブランチはリポジトリの規約に従う（`main` / `develop` 等）。

### Step 2: セキュリティチェック（必須）

Agent ツールでセキュリティ確認を行う。

確認項目:
- 認証・認可の実装漏れ
- API キー・シークレットのハードコーディング
- XSS の可能性
- 入力バリデーションの欠如
- OWASP Top 10

問題が見つかった場合はユーザーに警告し、対処後に PR 作成を再試行するよう案内する。

### Step 3: PR タイトルを生成する

Conventional Commits 形式: `type(scope): subject`

例:
```
feat(auth): ソーシャルログイン機能を追加
fix(api): レスポンスのエラーハンドリングを修正
```

### Step 4: PR body を生成する

```markdown
## Summary

- 変更内容の箇条書き

## Test plan

- [ ] 動作確認手順1
- [ ] 動作確認手順2
- [ ] エッジケース確認

## Design

- Figma: （あれば記載）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### Step 5: PR を作成する

```bash
gh pr create \
  --base main \
  --title "type(scope): subject" \
  --body "$(cat <<'EOF'
...
EOF
)"
```

ユーザーに PR URL を返す。

## 注意事項

- ベースブランチはリポジトリの規約に従う
- セキュリティ問題が未解決の場合は PR 作成を中止する
- Draft PR を作成する場合は `--draft` フラグを追加する（ユーザーに確認）
- **sandbox 環境での `GIT_SSL_NO_VERIFY=1` 併用**：詳細は後述の「sandbox 環境での実行」節を参照

## sandbox 環境での実行

sandbox では中間 TLS 証明書の検証に通らない場合があります。ネットワーク越しの GitHub 操作には `GIT_SSL_NO_VERIFY=1` の併用を検討してください（ホスト側で allow 済みが前提）。

| 対象 | `GIT_SSL_NO_VERIFY=1` の要否 | コマンド例 |
|------|-----------------------------|-----------|
| リモート取得 | 要 | `gh repo clone`, `git clone`, `git fetch`, `git pull`, `git ls-remote` |
| リモート書き込み | 要 | `git push` |
| GitHub API 操作 | 要 | `gh auth`, `gh api`, `gh pr ...`, `gh issue ...`, `gh project ...`, `gh label ...` |
| ローカル操作 | 不要 | `git log`, `git diff`, `git status`, `git add`, `git commit`, `git switch`, ファイル I/O |

`GIT_SSL_NO_VERIFY=1` は TLS 検証を無効にするだけで、認証自体は別途必要です（`gh auth login` 済み OAuth トークン / SSH 鍵 / PAT）。信頼できないネットワーク下では使用しないでください。

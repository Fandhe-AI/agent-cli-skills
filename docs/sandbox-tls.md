# sandbox 環境での GitHub 操作

sandbox 環境（App Sandbox、企業 proxy、自己署名証明書環境など）では、中間 TLS 証明書の検証に通らない場合があります。ネットワーク越しの GitHub 操作には `GIT_SSL_NO_VERIFY=1` の併用を検討してください（ホスト側で allow 済みが前提）。

## コマンド分類と要否

| 対象 | `GIT_SSL_NO_VERIFY=1` の要否 | コマンド例 |
|------|-----------------------------|-----------|
| リモート取得 | 要 | `gh repo clone`, `git clone`, `git fetch`, `git pull`, `git ls-remote` |
| リモート書き込み | 要 | `git push` |
| GitHub API 操作 | 要 | `gh auth`, `gh api`, `gh pr ...`, `gh issue ...`, `gh project ...`, `gh label ...` |
| ローカル操作 | 不要 | `git log`, `git diff`, `git status`, `git add`, `git commit`, `git switch`, ファイル I/O |

## 使用例

```bash
# sandbox で clone する場合
GIT_SSL_NO_VERIFY=1 gh repo clone Fandhe-AI/agent-cli-skills /tmp/work

# push する場合
GIT_SSL_NO_VERIFY=1 git push -u origin feat/my-change

# API 経由で PR を作る場合
GIT_SSL_NO_VERIFY=1 gh pr create --draft --base main
```

## 注意事項

- `GIT_SSL_NO_VERIFY=1` は **TLS 検証を無効にするだけ** で、認証自体は別途必要です（`gh auth login` 済み OAuth トークン / SSH 鍵 / PAT）
- 信頼できないネットワーク下では使用しないでください（中間者攻撃のリスク）
- 本オプションを恒常的に有効にせず、sandbox 環境下でのワークアラウンドとしてのみ使用してください
- `.claude/settings.local.json` の許可リストに `GIT_SSL_NO_VERIFY=1 gh ...` 等を明示的に allow しておくと、Claude Code からの呼び出しが通ります

## 各スキルでの扱い

各スキルの SKILL.md 末尾「sandbox 環境での実行」節で、そのスキル固有の主なリモート操作と「リモート書き込み」判定（要 / 要（本スキルは read-only）/ 要（本スキルは主に API 経由））が記述されています。

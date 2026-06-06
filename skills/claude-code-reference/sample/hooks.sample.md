# hooks 設定 実例集

`settings.json` の `hooks` セクションで定義する自動実行フックの実例。
Claude が特定のアクション（セッション開始・ツール実行後など）を起こしたとき、指定したシェルコマンドを自動実行する。

## フックの種類

| hook 名 | 発火タイミング |
|---------|-------------|
| `SessionStart` | Claude Code セッション開始時 |
| `PostToolUse` | ツール実行完了後（Edit / Write / Bash など） |
| `PreToolUse` | ツール実行前（確認・ガード用） |

---

## 実例 1: SessionStart — 日本語リマインダーを表示する

セッション開始時に規約のリマインダーを echo する。チームの作業規約を毎回表示したい場合に有効。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '=== Claude Code セッション開始 ==='; echo '重要な規約:'; echo '  - Conventional Commits 形式でコミット (type(scope): subject)'; echo '  - --no-verify は使用禁止'; echo '  - .claude/ 配下は _/dotclaude/ 経由で編集'; echo '  - シークレット (.env 等) を含むファイルはコミット禁止'; echo '================================'"
          }
        ]
      }
    ]
  }
}
```

---

## 実例 2: PostToolUse（Edit） — .md 編集後に通知する

`Edit` ツールでファイルが更新された後、Markdown ファイルであれば通知を出す。
`CLAUDE_TOOL_RESULT` 環境変数に Edit ツールの出力 JSON が格納される。

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "FILE_PATH=$(echo \"$CLAUDE_TOOL_RESULT\" | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d.get('file_path',''))\" 2>/dev/null || true); if [[ \"$FILE_PATH\" == *.md ]]; then echo \"[hook] Markdown ファイルが更新されました: $FILE_PATH\"; fi"
          }
        ]
      }
    ]
  }
}
```

### 解説

- `matcher: "Edit"` — Edit ツール実行後のみ発火する
- `python3 -c "import sys,json; ..."` — JSON を安全にパースして `file_path` を取り出す
- `|| true` — python3 のエラーを無視してフック自体が失敗しないようにする
- `[[ "$FILE_PATH" == *.md ]]` — 変数はダブルクォートで囲む（コマンドインジェクション対策）

---

## 実例 3: PostToolUse（Bash） — git commit 後にハッシュを記録する

Bash ツールで `git commit` が実行された後、最新コミットハッシュをログに記録する。

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "type": "command",
        "matcher": "Bash",
        "command": "TOOL_INPUT=$(echo \"$CLAUDE_TOOL_INPUT\" | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d.get('command',''))\" 2>/dev/null || true); if echo \"$TOOL_INPUT\" | grep -q 'git commit'; then HASH=$(git rev-parse --short HEAD 2>/dev/null || true); echo \"[hook] コミット完了: $HASH\"; fi"
      }
    ]
  }
}
```

### 解説

- `CLAUDE_TOOL_INPUT` — ツールへの入力 JSON（コマンド文字列を含む）
- `grep -q 'git commit'` — コマンド文字列に git commit が含まれるかを確認
- `git rev-parse --short HEAD` — コミット後の最新ハッシュを取得
- `|| true` — git コマンド失敗時もフックが止まらないようにする

---

## 実例 4: PreToolUse（Bash） — rm -rf をガードする

Bash ツールが `rm -rf` を含むコマンドを実行しようとしたとき、警告を出して中止させる。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "CMD=$(echo \"$CLAUDE_TOOL_INPUT\" | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d.get('command',''))\" 2>/dev/null || true); if echo \"$CMD\" | grep -qE 'rm\\s+-rf\\s+\\.claude'; then echo '[BLOCKED] .claude への rm -rf は禁止されています'; exit 2; fi"
          }
        ]
      }
    ]
  }
}
```

### 解説

- `exit 2` を返すとツール実行をブロックする（`exit 1` は非ブロッキング）
- `grep -qE 'rm\\s+-rf\\s+\\.claude'` — `.claude` を対象とした rm -rf のみを検出

---

## settings.json への配置場所

| ファイル | 用途 |
|---------|------|
| `.claude/settings.json` | プロジェクト共有（チームに適用） |
| `.claude/settings.local.json` | 個人専用（git ignore 推奨） |

permissions の `allow` / `deny` と hooks は同一 JSON に併記できる:

```json
{
  "permissions": {
    "allow": ["Bash(git add:*)"],
    "deny": ["Bash(git commit --no-verify:*)"]
  },
  "hooks": {
    "SessionStart": [...]
  }
}
```

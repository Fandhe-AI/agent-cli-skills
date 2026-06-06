<!-- source: https://code.claude.com/docs/en/hooks -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->

# Hooks リファレンス

## 概要

Hooks は Claude Code のライフサイクルの特定時点で実行されるシェルコマンド/HTTP リクエスト/MCP ツール呼び出し。ツール実行のブロック・許可・変更、環境変数の注入、外部システムへの通知などに使用する。

**重要:** CLAUDE.md の指示はソフトガイダンス（Claude が従うかどうかは判断次第）。フックは確定的に実行される。強制が必要な動作にはフックを使う。

---

## フックイベント一覧

### セッションフック

| イベント | 説明 | ブロック可能 |
|--------|-----|-----------|
| `SessionStart` | セッション開始・再開時。matcher: `startup`/`resume`/`clear`/`compact` | No |
| `Setup` | `--init-only`/`--init`/`--maintenance` フラグ起動時。matcher: `init`/`maintenance` | No |
| `SessionEnd` | セッション終了時 | No |

### ターンフック

| イベント | 説明 | ブロック可能 |
|--------|-----|-----------|
| `UserPromptSubmit` | Claude がプロンプトを処理する前（30秒タイムアウト） | Yes |
| `UserPromptExpansion` | コマンドがプロンプトに展開される時 | Yes |
| `Stop` | Claude が応答を終了した時 | Yes |
| `StopFailure` | API エラーでターン終了 | No |

### エージェントループフック

| イベント | 説明 | ブロック可能 |
|--------|-----|-----------|
| `PreToolUse` | ツール実行前（ブロック可能） | Yes |
| `PostToolUse` | ツール成功後 | No |
| `PostToolUseFailure` | ツール失敗後 | No |
| `PostToolBatch` | 並列ツール呼び出しの完了後 | Yes |
| `PermissionRequest` | 許可ダイアログ表示時 | Yes |
| `PermissionDenied` | ツール呼び出し拒否時 | No |

### 非同期イベント（ノンブロッキング）

| イベント | matcher の対象 |
|--------|-------------|
| `FileChanged` | リテラルファイル名（監視ファイル） |
| `CwdChanged` | — |
| `ConfigChange` | `user_settings`/`project_settings`/`local_settings`/`policy_settings`/`skills` |
| `Notification` | `permission_prompt`/`auth_success`/`elicitation_dialog` |
| `MessageDisplay` | — |

### エージェント・タスクフック

| イベント | matcher の対象 |
|--------|-------------|
| `SubagentStart` | エージェント名（`general-purpose`/`Explore`/カスタム名） |
| `SubagentStop` | エージェント名 |
| `TeammateIdle` | — |
| `TaskCreated` | — |
| `TaskCompleted` | — |

### 命令・ワークスペースフック

| イベント | matcher の対象 |
|--------|-------------|
| `InstructionsLoaded` | `session_start`/`nested_traversal`/`path_glob_match`/`include`/`compact` |
| `PreCompact` | `manual`/`auto` |
| `PostCompact` | — |
| `WorktreeCreate` | — |
| `WorktreeRemove` | — |

### MCP・Elicitation フック

| イベント | matcher の対象 |
|--------|-------------|
| `Elicitation` | MCP サーバー名 |
| `ElicitationResult` | MCP サーバー名 |

---

## 設定ファイル構造

### 配置場所と優先度

1. Managed policy settings（組織管理者、最高優先度）
2. Plugin `hooks/hooks.json`
3. `.claude/settings.local.json`（プロジェクト、非共有）
4. `.claude/settings.json`（プロジェクト、共有）
5. `~/.claude/settings.json`（ユーザー）
6. スキル/エージェントの frontmatter（コンポーネントスコープ）

すべてのレベルのフックがマージされる（上位が下位を上書きしない）。

### 基本設定スキーマ

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/validate.sh",
            "timeout": 30,
            "statusMessage": "バリデーション中..."
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/load-context.sh"
          }
        ]
      }
    ]
  },
  "disableAllHooks": false
}
```

---

## matcher パターン

| matcher 値 | 評価方法 | 例 |
|-----------|--------|--|
| `"*"`・`""`・省略 | 全マッチ | 常に発火 |
| 文字・数字・`_`・`\|` のみ | 文字列または `\|` 区切りリスト | `Bash` または `Edit\|Write` |
| その他の文字を含む | JavaScript 正規表現 | `^Notebook`・`mcp__memory__.*` |

**MCP ツールのパターン:** `mcp__<server>__<tool>`

```json
{"matcher": "mcp__memory__.*"}   // memory サーバーの全ツール
{"matcher": "mcp__.*__write.*"}  // 全サーバーの write 系ツール
```

---

## フックハンドラータイプ

### 1. Command フック（最も一般的）

```json
{
  "type": "command",
  "command": "/path/to/script.sh",
  "args": ["arg1"],
  "timeout": 30,
  "statusMessage": "処理中...",
  "if": "Bash(rm *)",
  "once": false,
  "shell": "bash"
}
```

**パスプレースホルダー（自動置換）:**
- `${CLAUDE_PROJECT_DIR}` ── プロジェクトルート
- `${CLAUDE_PLUGIN_ROOT}` ── プラグインインストールディレクトリ
- `${CLAUDE_PLUGIN_DATA}` ── プラグイン永続データディレクトリ

**環境変数（フック内で利用可能）:**
- `CLAUDE_PROJECT_DIR`
- `CLAUDE_ENV_FILE` ── `SessionStart` 等で環境変数を永続化するファイルパス（append モード）
- `CLAUDE_EFFORT` ── effort レベル
- `CLAUDE_CODE_REMOTE` ── リモート Web の場合 `"true"`

### 2. HTTP フック

```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/validate",
  "headers": {"Authorization": "Bearer $API_TOKEN"},
  "allowedEnvVars": ["API_TOKEN"],
  "timeout": 30
}
```

2xx レスポンスを処理。非 2xx はノンブロッキングエラー（実行継続）。

### 3. MCP Tool フック

```json
{
  "type": "mcp_tool",
  "server": "security_server",
  "tool": "scan_file",
  "input": {"file_path": "${tool_input.file_path}"},
  "timeout": 60
}
```

### 4. Prompt フック

```json
{
  "type": "prompt",
  "prompt": "このコマンドは安全ですか？引数: $ARGUMENTS",
  "model": "claude-opus-4-1",
  "timeout": 30
}
```

### 5. Agent フック（実験的）

```json
{
  "type": "agent",
  "prompt": "この操作のセキュリティを検証する: $ARGUMENTS",
  "timeout": 60
}
```

### 共通フィールド

| フィールド | 型 | 説明 |
|---------|---|-----|
| `type` | string | 必須: `command`/`http`/`mcp_tool`/`prompt`/`agent` |
| `if` | string | 条件（ツールイベントのみ）: `Bash(git *)`/`Edit(*.ts)` 等 |
| `timeout` | number | タイムアウト秒数 |
| `statusMessage` | string | スピナーメッセージ |
| `once` | boolean | セッションで一度だけ実行（スキル/エージェント限定） |

---

## フック入力フォーマット（stdin / HTTP body）

すべてのフックが受け取る共通フィールド:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "effort": {"level": "high"},
  "agent_id": "subagent-id",
  "agent_type": "Explore"
}
```

**イベント別の追加フィールド:**

```json
// PreToolUse / PostToolUse
{"tool_name": "Bash", "tool_input": {"command": "npm test"}}

// UserPromptSubmit
{"prompt": "ファクトリアルを計算する関数を書いて"}

// SessionStart
{"source": "startup|resume|clear|compact", "model": "claude-sonnet-4-6"}
```

---

## exit code と出力

| コード | 意味 | JSON 処理 |
|------|-----|---------|
| `0` | 成功 | stdout の JSON を解析 |
| `2` | ブロッキングエラー | JSON 無視、stderr 表示、アクションをブロック |
| その他 | ノンブロッキングエラー | stderr をトランスクリプトに表示、継続 |

**stdout は JSON のみ（周囲のテキスト不可）:**

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "警告: 危険な操作",
  "decision": "block",
  "reason": "ブロック理由",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "DB への書き込みは禁止",
    "additionalContext": "Claude への追加情報"
  }
}
```

**PreToolUse での決定コントロール:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "監査ログメッセージ",
    "updatedInput": {"command": "修正されたコマンド"}
  }
}
```

---

## 最小例

### 危険なコマンドをブロック

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh"
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
# block-rm.sh
COMMAND=$(jq -r '.tool_input.command')
if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "rm -rf はブロック"
    }
  }'
else
  exit 0
fi
```

### 書き込み後にリント

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/lint.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### SessionStart で環境変数を永続化

```bash
#!/bin/bash
# load-context.sh
BRANCH=$(git branch --show-current)
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export CURRENT_BRANCH=$BRANCH" >> "$CLAUDE_ENV_FILE"
fi
jq -nc \
  --arg branch "$BRANCH" \
  '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "現在のブランチ: \($branch)",
      sessionTitle: $branch
    }
  }'
```

### スキル/エージェント frontmatter でのフック定義

```yaml
---
name: secure-bash
description: セキュリティチェック付き bash 実行
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
          timeout: 30
---
```

---

## よくある落とし穴

1. **stdout に JSON 以外が混じる** → シェルプロファイルの出力や `echo` が混入すると JSON パースが失敗する。
2. **exit code 2 で意図せずブロック** → `PostToolUse` はブロック不可（既に実行済み）。
3. **matcher が効かない** → `/hooks` で設定を確認。文字列リストに使えない文字があると正規表現として解釈される。
4. **フックが無効化されている** → `"disableAllHooks": true` が settings に設定されていないか確認。
5. **managed フックは上書き不可** → 組織管理者が設定したフックはローカルで無効化できない。

---

## このリポでの使い方

```
.claude/settings.json          # プロジェクト共有フック設定
.claude/settings.local.json    # 個人用フック設定（gitignore）
~/.claude/settings.json        # ユーザー全体のフック設定
```

**`.claude/` 配下の編集:** `dotclaude-via-temp.md` ルールに従い `_/dotclaude/` 経由で作業する。

**デバッグ:** セッション内で `/hooks` を実行すると全フック設定を閲覧できる（読み取り専用）。

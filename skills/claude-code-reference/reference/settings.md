<!-- source: https://code.claude.com/docs/en/settings -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->
<!-- 取得状況: ✅ 取得済み -->

# settings.json リファレンス

## 概要

Claude Code の動作を `settings.json` / `settings.local.json` で制御する。permissions のルール、モデル・環境変数・フック・MCP サーバー等を設定できる。

---

## 設定ファイルの種類と優先度

| スコープ | ファイルパス | 共有 | 優先度 |
|---------|-----------|-----|-------|
| Managed | `/etc/claude-code/` (Linux) / `/Library/Application Support/ClaudeCode/` (macOS) | 組織全体 | 1（最高） |
| Command Line | CLI 引数 | — | 2 |
| Local | `.claude/settings.local.json` | No（gitignore 推奨） | 3 |
| Project | `.claude/settings.json` | Yes（git commit） | 4 |
| User | `~/.claude/settings.json` | No | 5（最低） |

**マージ動作:** 同一キーは高優先度が勝つ。`permissions.allow`/`deny` はスコープをまたいでマージされる（上書きでない）。

---

## JSON スキーマ参照

オートコンプリートを有効にするには先頭に追加:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json"
}
```

---

## 主要フィールド

### permissions（最重要）

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test *)",
      "Read(~/.zshrc)",
      "Bash(git *)"
    ],
    "deny": [
      "Bash(curl *)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)"
    ],
    "ask": [
      "Bash(*)"
    ]
  }
}
```

**ルールの書き方:**
- `Bash(npm run lint)` ── 完全一致
- `Bash(npm run test *)` ── ワイルドカード
- `Read(~/.zshrc)` ── ファイルパス
- `Skill(commit)` ── スキル名
- `Skill(review-pr *)` ── プレフィックスマッチ
- `ToolSearch` ── ツール名（MCP tool search）

### model

```json
{
  "model": "claude-sonnet-4-6",
  "availableModels": ["claude-sonnet-4-6", "claude-haiku-4-5"],
  "effortLevel": "high"
}
```

### env（環境変数）

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "NODE_ENV": "production",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

セッションと全サブプロセスに適用される。

### hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/validate.sh"
          }
        ]
      }
    ]
  },
  "disableAllHooks": false
}
```

フックの詳細は [reference/hooks.md](hooks.md) を参照。

### MCP サーバー関連

```json
{
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["github", "sentry"],
  "disabledMcpjsonServers": ["experimental-server"],
  "allowedHttpHookUrls": ["http://localhost:*"],
  "httpHookAllowedEnvVars": ["API_TOKEN", "GITHUB_TOKEN"]
}
```

`.mcp.json` のサーバー名で指定する。

### Skills 関連

```json
{
  "skillListingBudgetFraction": 0.02,
  "maxSkillDescriptionChars": 1536,
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  },
  "disableSkillShellExecution": false
}
```

`skillOverrides` の値: `"on"`/`"name-only"`/`"user-invocable-only"`/`"off"`

### メモリ関連

```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "~/.claude/memory",
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/user/monorepo/other-team/.claude/rules/**"
  ]
}
```

### 動作・表示

```json
{
  "editorMode": "vim",
  "viewMode": "default",
  "tui": "fullscreen",
  "showTurnDuration": true,
  "syntaxHighlightingDisabled": false,
  "language": "japanese"
}
```

### Agents & Workflows

```json
{
  "agent": "my-custom-agent",
  "disableAgentView": false,
  "disableWorkflows": false
}
```

### 更新・バージョン管理

```json
{
  "autoUpdatesChannel": "stable",
  "minimumVersion": "2.1.0"
}
```

---

## ホットリロード可能な設定

**再起動不要:**
- `permissions`
- `hooks`
- `apiKeyHelper`

**再起動が必要:**
- `model`
- `outputStyle`（`/clear` で再構築）

---

## 最小例

### プロジェクト設定（`.claude/settings.json`）

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(npm run *)",
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)"
    ],
    "deny": [
      "Bash(git push --force *)",
      "Read(.env)",
      "Read(.env.*)"
    ]
  },
  "env": {
    "NODE_ENV": "development"
  }
}
```

### 個人設定（`.claude/settings.local.json`）

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run dev)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/my-context.sh"
          }
        ]
      }
    ]
  }
}
```

---

## よくある落とし穴

1. **`permissions.deny` が `allow` より優先** → deny ルールがあると allow ルールを上書きする。
2. **`settings.local.json` を gitignore していない** → 個人設定が誤って共有される。プロジェクト初期化時に追加を忘れずに。
3. **Managed 設定は上書き不可** → 組織管理者の設定はローカルで変更できない。`allowManagedPermissionRulesOnly: true` の場合は managed 以外のルールが無効。
4. **`env` の変数はインターフェイス色に影響しない** → `NO_COLOR`/`FORCE_COLOR` は起動前のシェルで設定する必要がある。
5. **スキーマが最新に追従しない** → `$schema` の検証警告は最新フィールドでは出ることがある。設定は有効。

---

## このリポでの使い方

```
.claude/settings.json          # プロジェクト共有設定（git 管理）
.claude/settings.local.json    # 個人設定（.gitignore に追加済み）
~/.claude/settings.json        # 全プロジェクト共通の個人設定
```

**`.claude/` 配下の編集:** `dotclaude-via-temp.md` ルールに従い `_/dotclaude/` 経由で作業し、完了後に `mv` で移動する。

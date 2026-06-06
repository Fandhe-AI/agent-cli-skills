<!-- source: https://code.claude.com/docs/en/mcp -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->
<!-- 取得状況: ✅ 取得済み -->

# MCP サーバー連携 リファレンス

## 概要

MCP（Model Context Protocol）は Claude Code を外部ツール・データソースに接続するオープン標準。MCP サーバーによってツール・データベース・API へのアクセスが可能になる。

---

## MCP ツールの命名規則

MCP ツールは以下の形式で参照される:

```
mcp__<server>__<tool>
mcp__github__create_issue
mcp__memory__search
mcp__sentry__get_errors
```

フックの matcher でも同様の形式:
```json
{"matcher": "mcp__memory__.*"}      // memory サーバーの全ツール
{"matcher": "mcp__.*__write.*"}     // 全サーバーの write 系ツール
```

---

## インストール方法

### Option 1: リモート HTTP サーバー（推奨）

```bash
# 基本
claude mcp add --transport http <name> <url>

# 例: Notion
claude mcp add --transport http notion https://mcp.notion.com/mcp

# Bearer トークン付き
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer YOUR_GITHUB_PAT"
```

### Option 2: ローカル stdio サーバー

```bash
# 基本構文（-- で Claude のオプションとサーバーコマンドを分離）
claude mcp add [options] <name> -- <command> [args...]

# 例: Airtable
claude mcp add --env AIRTABLE_API_KEY=YOUR_KEY --transport stdio airtable \
  -- npx -y airtable-mcp-server
```

**stdio サーバーでの `--` の役割:** `--` の前は Claude のオプション（`--transport`/`--env`/`--scope`）、後はサーバーコマンドと引数。

### Option 3: SSE サーバー（非推奨、代わりに HTTP を使用）

```bash
claude mcp add --transport sse asana https://mcp.asana.com/sse
```

### Option 4: WebSocket サーバー

```bash
claude mcp add-json events-server \
  '{"type":"ws","url":"wss://mcp.example.com/socket","headers":{"Authorization":"Bearer TOKEN"}}'
```

### JSON で直接追加

```bash
claude mcp add-json weather-api \
  '{"type":"http","url":"https://api.weather.com/mcp","headers":{"Authorization":"Bearer token"}}'
```

### サーバー管理コマンド

```bash
claude mcp list          # サーバー一覧
claude mcp get <name>    # 詳細表示
claude mcp remove <name> # 削除
/mcp                     # セッション内でステータス確認
```

---

## `.mcp.json` フォーマット（プロジェクトスコープ）

プロジェクトルートに配置し、git commit して チームと共有する:

```json
{
  "mcpServers": {
    "shared-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    },
    "local-tool": {
      "command": "${CLAUDE_PROJECT_DIR}/scripts/mcp-server.sh",
      "args": ["--config", "${CLAUDE_PROJECT_DIR}/config.json"],
      "env": {
        "DEBUG": "true"
      }
    },
    "core-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "alwaysLoad": true
    }
  }
}
```

**環境変数展開:**
- `${VAR}` ── 環境変数 VAR の値
- `${VAR:-default}` ── VAR が未設定の場合は `default` を使用

展開可能な場所: `command`・`args`・`env`・`url`・`headers`

---

## スコープ（--scope フラグ）

| スコープ | 保存先 | 適用範囲 |
|---------|-------|---------|
| `local`（デフォルト） | `~/.claude.json`（プロジェクトパス下） | 当該プロジェクトのみ、個人 |
| `project` | `.mcp.json`（プロジェクトルート） | チーム共有、git 管理 |
| `user` | `~/.claude.json` | 全プロジェクト、個人 |

```bash
# プロジェクトスコープで追加（チーム共有）
claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp

# ユーザースコープで追加（全プロジェクト）
claude mcp add --transport http hubspot --scope user https://mcp.hubspot.com/mcp
```

**優先度:** local > project > user > plugin > claude.ai connector

---

## settings.json での MCP 設定

```json
{
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["github", "sentry"],
  "disabledMcpjsonServers": ["experimental"],
  "allowedHttpHookUrls": ["http://localhost:*"],
  "httpHookAllowedEnvVars": ["API_TOKEN"]
}
```

---

## OAuth 認証

```bash
# HTTP サーバー追加後に認証
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
/mcp  # ブラウザで OAuth フロー完了
```

**固定 OAuth コールバックポート（登録済み redirect URI が必要な場合）:**

```bash
claude mcp add --transport http \
  --callback-port 8080 \
  my-server https://mcp.example.com/mcp
```

**事前設定済み OAuth 認証情報:**

```bash
claude mcp add --transport http \
  --client-id your-client-id --client-secret --callback-port 8080 \
  my-server https://mcp.example.com/mcp
```

---

## 動的ヘッダー（カスタム認証）

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.internal.example.com",
      "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
    }
  }
}
```

スクリプトは JSON オブジェクト（文字列キー・値ペア）を stdout に出力する。タイムアウトは 10 秒。

---

## Tool Search（コンテキスト最適化）

デフォルトで有効。MCP ツールの定義をオンデマンドでロードし、コンテキスト使用量を削減する。

```bash
ENABLE_TOOL_SEARCH=true   # 全 MCP ツールを遅延ロード
ENABLE_TOOL_SEARCH=auto   # コンテキスト窓の 10% を超えたら遅延ロード
ENABLE_TOOL_SEARCH=false  # 全ツールを事前ロード
```

**常時ロード（特定サーバーのみ）:**
```json
{"alwaysLoad": true}
```

---

## MCP リソースの参照

`@` メンション構文で MCP リソースを参照:

```
@github:issue://123 を分析して
@docs:file://api/authentication を確認して
```

---

## MCP プロンプト（コマンドとして使用）

```
/mcp__github__list_prs
/mcp__github__pr_review 456
/mcp__jira__create_issue "バグ報告" high
```

---

## 出力制限

- 警告閾値: 10,000 トークン
- デフォルト最大: 25,000 トークン
- `MAX_MCP_OUTPUT_TOKENS` 環境変数で調整可能

```bash
export MAX_MCP_OUTPUT_TOKENS=50000
claude
```

---

## 最小例

### PostgreSQL 接続

```bash
claude mcp add --transport stdio db -- npx -y @bytebase/dbhub \
  --dsn "postgresql://readonly:pass@prod.db.com:5432/analytics"
```

### GitHub 接続

```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer YOUR_GITHUB_PAT"
```

### プロジェクト共有（`.mcp.json`）

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

---

## よくある落とし穴

1. **`--` なしで stdio サーバーを追加** → サーバーのフラグが Claude のオプションとして解釈される。
2. **`CLAUDE_PROJECT_DIR` の参照** → `.mcp.json` の `command`/`args` での `${CLAUDE_PROJECT_DIR}` はプラグイン以外では `${CLAUDE_PROJECT_DIR:-.}` のようにデフォルト値が必要。
3. **プロジェクトスコープの承認** → `.mcp.json` のサーバーは初回使用時に承認が必要（セキュリティ）。
4. **`workspace` という名前** → 予約済み。使用不可。
5. **claude.ai connectors と重複** → 同じ URL の場合、手動追加サーバーが優先される。
6. **WebSocket の使い所** → イベントプッシュが必要な場合のみ。通常は HTTP を使用。

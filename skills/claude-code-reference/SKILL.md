---
name: claude-code-reference
description: >
  Claude Code 本体（Agent Skills / Subagents / Hooks / settings.json / スラッシュコマンド / MCP / メモリ）の公式仕様リファレンス。skill・agent・rule・hook・settings を著作・編集する際に参照する。「SKILL.md の書き方」「hook の設定」「subagent の frontmatter」「settings.json の permissions」などで使用。
model: sonnet
user-invocable: false
---

# claude-code-reference

Claude Code 本体の公式仕様を要約した知識ベース。
このリポジトリで skill / agent / rule / hook / settings を著作する際のリファレンスとして使用する。
GitHub 側の仕様は `github-docs` スキルを参照（重複させない）。

## 探索手順

1. ユーザーのタスクに最も関連するトピックを下の索引から特定する
2. 該当する `reference/<topic>.md` を読む
3. 実装の雛形が必要なら `sample/` を、実行コマンドが必要なら `script/` を参照する
4. 関連トピックがあればリンクを辿る

## reference/ の索引

| タスク例 | 参照ファイル |
|---------|------------|
| SKILL.md を書く・frontmatter を設定する・`description` にトリガー語を入れる | [reference/skills.md](reference/skills.md) |
| `context: fork` でサブエージェント実行・`allowed-tools` の設定 | [reference/skills.md](reference/skills.md) |
| `.claude/agents/` にサブエージェントを定義する・`tools`/`model`/`permissionMode` を指定 | [reference/subagents.md](reference/subagents.md) |
| subagent_type でサブエージェントを呼び出す | [reference/subagents.md](reference/subagents.md) |
| hooks を設定する・`PreToolUse`/`PostToolUse`/`SessionStart` などのイベント | [reference/hooks.md](reference/hooks.md) |
| hook の JSON 出力・exit code・stdin 入力フォーマット | [reference/hooks.md](reference/hooks.md) |
| `settings.json` / `settings.local.json` を編集する | [reference/settings.md](reference/settings.md) |
| `permissions.allow` / `permissions.deny` を設定する | [reference/settings.md](reference/settings.md) |
| `env` で環境変数を設定する・`enabledMcpjsonServers` を指定 | [reference/settings.md](reference/settings.md) |
| スラッシュコマンドを調べる・カスタムコマンドを作る | [reference/slash-commands.md](reference/slash-commands.md) |
| MCP サーバーを追加・設定する・`.mcp.json` を書く | [reference/mcp.md](reference/mcp.md) |
| MCP ツール名の命名規則 `mcp__server__tool` | [reference/mcp.md](reference/mcp.md) |
| `CLAUDE.md` を書く・メモリ階層を理解する・`@import` を使う | [reference/memory.md](reference/memory.md) |
| `.claude/rules/` でパス別ルールを設定する | [reference/memory.md](reference/memory.md) |

## sample/ と script/ の案内

- `sample/` ── 動作実例（各機能の最小動作サンプル）
- `script/` ── 実行可能コマンド集（hook スクリプト・設定生成ユーティリティ等）

## 更新方法

公式ドキュメントの URL が変更された場合や仕様更新を反映する場合は、
`update-reference` スキルで各 reference/*.md を再取得・更新する。
各ファイル冒頭の `<!-- source: <URL> -->` と `<!-- 最終確認日: YYYY-MM-DD -->` を更新すること。

## 検証

reference/*.md を追加・更新した後、以下で整合を確認する。

```bash
# 索引に記載されたファイルが実在するか確認
ls skills/claude-code-reference/reference/
```

- SKILL.md の索引テーブルの各行に対応する `reference/<topic>.md` が存在すること
- 各ファイル先頭に `<!-- source: ... -->` と `<!-- 最終確認日: ... -->` があること
- 索引に未掲載のファイルがあれば SKILL.md の索引テーブルに追記すること

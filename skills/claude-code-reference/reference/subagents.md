<!-- source: https://code.claude.com/docs/en/sub-agents -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->
<!-- 取得状況: ✅ 取得済み -->

# Subagents リファレンス

## 概要

Subagents（サブエージェント）は特定タスクに特化した AI アシスタント。サイドタスクが会話のコンテキストを汚染する場合に使用する。各サブエージェントは独自のコンテキストウィンドウ・システムプロンプト・ツールアクセス・権限で動作し、結果のサマリーのみを返す。

**サブエージェントのユースケース:**
- コンテキストの節約（検索・ログ・ファイル内容を分離）
- ツール制限による制約の強制
- コスト制御（Haiku 等の安価なモデルへのルーティング）

---

## 必須項目・構文

### ファイル配置

| 場所 | パス | 優先度 |
|-----|------|-------|
| Managed settings | 組織管理者が配置 | 1（最高） |
| `--agents` CLI フラグ | セッション限定 | 2 |
| `.claude/agents/` | プロジェクトスコープ | 3 |
| `~/.claude/agents/` | ユーザースコープ（全プロジェクト） | 4 |
| Plugin `agents/` | プラグインスコープ | 5（最低） |

同名の場合、優先度の高いものが勝つ。`.claude/agents/` はサブディレクトリも再帰的にスキャンされる。

### サブエージェントファイルの構造

```markdown
---
name: code-reviewer
description: コードの品質とベストプラクティスをレビューする。コード変更後に使用。
tools: Read, Glob, Grep
model: sonnet
---

あなたはコードレビュアーです。コードを分析し、品質・セキュリティ・ベストプラクティスについて
具体的でアクション可能なフィードバックを提供してください。
```

本文（frontmatter 以降の Markdown）がシステムプロンプトになる。

### frontmatter 全フィールド

| フィールド | 必須 | 説明 |
|---------|-----|-----|
| `name` | Yes | 小文字英数字とハイフン。ファイル名と一致する必要はない |
| `description` | Yes | Claude がいつ委譲するかを決定する。明確に記述する |
| `tools` | No | 使用可能なツール。省略時は全ツールを継承 |
| `disallowedTools` | No | 禁止するツール |
| `model` | No | `sonnet`/`opus`/`haiku` またはフル ID。省略時は `inherit` |
| `permissionMode` | No | `default`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`/`plan` |
| `maxTurns` | No | 最大エージェントターン数 |
| `skills` | No | 起動時にプリロードするスキル（全コンテンツを注入） |
| `mcpServers` | No | このサブエージェントが使える MCP サーバー |
| `hooks` | No | このサブエージェントスコープのフック |
| `memory` | No | 永続メモリスコープ: `user`/`project`/`local` |
| `background` | No | `true`: 常にバックグラウンドタスクとして実行 |
| `effort` | No | `low`/`medium`/`high`/`xhigh`/`max` |
| `isolation` | No | `worktree`: 独立した git worktree で実行 |
| `color` | No | UI 表示色: `red`/`blue`/`green`/`yellow`/`purple`/`orange`/`pink`/`cyan` |
| `initialPrompt` | No | `--agent` フラグで起動した際の最初のユーザーターン |

**プラグインサブエージェントでは `hooks`/`mcpServers`/`permissionMode` は無視される。**

### model の解決順序

1. `CLAUDE_CODE_SUBAGENT_MODEL` 環境変数
2. 呼び出し時のパラメータ
3. サブエージェント定義の `model` frontmatter
4. メイン会話のモデル

### 利用可能なツール一覧（主要）

```
Read, Write, Edit, MultiEdit, Bash, Glob, Grep, LS,
WebFetch, WebSearch, TodoRead, TodoWrite,
Task (サブエージェント呼び出し), Skill, AskUserQuestion,
mcp__<server>__<tool>
```

---

## ビルトインサブエージェント

| エージェント | モデル | ツール | 目的 |
|-----------|-------|-------|-----|
| **Explore** | Haiku | 読み取り専用 | ファイル検索・コードベース探索。CLAUDE.md と git status をスキップ |
| **Plan** | 継承 | 読み取り専用 | プランモード時のリサーチ。CLAUDE.md と git status をスキップ |
| **general-purpose** | 継承 | 全ツール | 複雑な複数ステップのタスク |
| statusline-setup | Sonnet | — | `/statusline` コマンドで使用 |
| claude-code-guide | Haiku | — | Claude Code 機能の質問対応 |

---

## 最小例

### 基本的なサブエージェント定義

```markdown
---
name: security-auditor
description: コードのセキュリティ脆弱性を監査する。新しいコードが追加された後に使用。
tools: Read, Glob, Grep
model: sonnet
---

あなたはセキュリティ専門家です。以下の観点でコードを分析してください:
- OWASP Top 10 の脆弱性
- ハードコードされた認証情報
- 入力バリデーション不足
- XSS・SQLインジェクション・CSRF
```

### CLI フラグで定義する例（テスト・自動化向け）

```bash
claude --agents '{
  "code-reviewer": {
    "description": "コードの品質をレビューする。変更後にプロアクティブに使用。",
    "prompt": "あなたはシニアコードレビュアーです。品質・セキュリティ・ベストプラクティスに集中してください。",
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "model": "sonnet"
  }
}'
```

### スキルをプリロードするサブエージェント

```markdown
---
name: commit-assistant
description: Conventional Commits 形式でコミットを作成する。
skills:
  - create-commit
model: haiku
---

コミットを作成するアシスタントです。
```

---

## 呼び出し方

Claude はサブエージェントの `description` を見て自動委譲を決定する。
明示的に指定したい場合は以下のように伝える:

```
security-auditor エージェントを使ってこのコードを監査して
```

スキルの `context: fork` + `agent: <name>` フィールドでも呼び出せる:

```yaml
---
context: fork
agent: Explore
---
```

---

## 起動時のコンテキストロード

| 内容 | 通常サブエージェント | Explore/Plan |
|-----|-----------------|------------|
| CLAUDE.md | ロード | スキップ |
| git status | ロード | スキップ |
| サブエージェントのシステムプロンプト | ロード | ロード |
| プリロードスキル (`skills` フィールド) | ロード（全文） | ロード |

---

## よくある落とし穴

1. **サブエージェントは他のサブエージェントを生成できない**（無限ネスト防止）。
2. **プラグインサブエージェントの制限** → `hooks`/`mcpServers`/`permissionMode` は無視される。
3. **name の重複** → 同一スコープ内で同名が複数あると、どちらかが無警告で破棄される。
4. **サブエージェントファイルの変更反映** → ファイルを直接編集した場合はセッション再起動が必要。`/agents` インターフェイス経由は即時反映。
5. **`cd` コマンドが効かない** → サブエージェント内の `cd` は Bash コール間で持続しない。
6. **description が曖昧** → Claude が委譲を決定できない。いつ使うかを具体的に記述する。

---

## このリポでの使い方

```
.claude/agents/<name>.md     # プロジェクトスコープ（チームで共有）
~/.claude/agents/<name>.md   # ユーザースコープ（個人のみ）
```

**`.claude/` 配下の編集:** `dotclaude-via-temp.md` ルールに従い `_/dotclaude/agents/` で一時作業してから `mv` で移動する。

**このリポの既存エージェント:**
- `.claude/agents/plan-verifier.md` ── 計画検証エージェント（読み取り専用、Sonnet）

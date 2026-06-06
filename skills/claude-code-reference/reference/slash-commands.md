<!-- source: https://code.claude.com/docs/en/commands -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->

# スラッシュコマンド リファレンス

## 概要

スラッシュコマンドはセッション内から Claude Code を制御する仕組み。メッセージの先頭に `/` を付けて呼び出す。コマンド名の後に続くテキストは引数として渡される。

**カスタムコマンドの追加方法:** Skills を使用（詳細は [reference/skills.md](skills.md) を参照）。

---

## カスタムコマンド（Skills）の作成

```
.claude/skills/<name>/SKILL.md   # スキルディレクトリ形式（推奨）
.claude/commands/<name>.md       # 旧コマンドファイル形式（互換性あり）
```

両者は同等に動作するが、スキルディレクトリ形式を推奨（supporting files、frontmatter 等の追加機能あり）。

**コマンド名の決定:** ディレクトリ名またはファイル名（拡張子なし）が `/` の後に続くコマンド名になる。

### MCP プロンプトコマンド

MCP サーバーが公開するプロンプトは以下の形式でコマンドになる:

```
/mcp__<server>__<prompt>
/mcp__github__list_prs
/mcp__jira__create_issue "Bug in login flow" high
```

---

## ビルトインコマンド一覧

`[arg]` = 省略可、`<arg>` = 必須

### セットアップ・プロジェクト管理

| コマンド | 説明 |
|--------|-----|
| `/init` | プロジェクトの `CLAUDE.md` を生成。`CLAUDE_CODE_NEW_INIT=1` で対話フロー |
| `/memory` | CLAUDE.md 編集・auto memory の有効/無効・auto memory エントリ表示 |
| `/mcp` | MCP サーバー接続と OAuth 認証管理 |
| `/agents` | サブエージェント設定管理 |
| `/permissions` | ツール許可・拒否ルール管理（`/allowed-tools` でも可） |
| `/add-dir <path>` | セッション中にファイルアクセス対象ディレクトリを追加 |

### モデル・設定

| コマンド | 説明 |
|--------|-----|
| `/model [model]` | AI モデルの切り替え・デフォルト設定 |
| `/effort [level\|auto]` | effort レベル設定（`low`/`medium`/`high`/`xhigh`/`max`/`ultracode`） |
| `/config` | 設定インターフェイスを開く（`/settings` でも可） |
| `/theme` | カラーテーマ変更 |

### コンテキスト管理

| コマンド | 説明 |
|--------|-----|
| `/compact [instructions]` | 会話を圧縮してコンテキストを解放 |
| `/context [all]` | コンテキスト使用量を可視化 |
| `/clear [name]` | 新しい会話を開始（`/reset`/`/new` でも可） |
| `/btw <question>` | 会話を汚染せずにサイド質問 |

### 並列実行・エージェント管理

| コマンド | 説明 |
|--------|-----|
| `/background [prompt]` | 現在のセッションをバックグラウンドエージェントとして切り離し（`/bg` でも可） |
| `/tasks` | バックグラウンド実行中のタスク管理（`/bashes` でも可） |
| `/fork <directive>` | 会話をフォークしてバックグラウンドサブエージェントに委任 |
| `/branch [name]` | 会話のブランチを作成 |
| `/batch <instruction>` | **Skill** コードベース全体に大規模変更を並列適用 |

### コードレビュー・品質

| コマンド | 説明 |
|--------|-----|
| `/code-review [level] [--fix] [--comment] [target]` | **Skill** 差分をレビュー。`--fix` で自動修正、`ultra` でクラウドレビュー |
| `/simplify [target]` | **Skill** リファクタリング・クリーンアップを適用（バグ修正なし） |
| `/review [PR]` | PR をローカルでレビュー |
| `/security-review` | セキュリティ脆弱性の分析 |
| `/diff` | インタラクティブな差分ビュワー |

### セッション履歴・移動

| コマンド | 説明 |
|--------|-----|
| `/resume [session]` | 以前の会話を再開（`/continue` でも可） |
| `/rewind` | 会話とコードを以前の時点に巻き戻し（`/checkpoint`/`/undo` でも可） |
| `/rename [name]` | 現在のセッションに名前を付ける |
| `/branch [name]` | 現在の会話を別方向に分岐 |

### スキル・コマンド管理

| コマンド | 説明 |
|--------|-----|
| `/skills` | 利用可能なスキル一覧。`t` でトークン数順、`Space` で可視性切り替え |
| `/reload-skills` | スキルディレクトリを再スキャン（v2.1.152+） |
| `/reload-plugins [--force]` | プラグインをリロード |
| `/plugin [subcommand]` | プラグイン管理 |

### 診断・デバッグ

| コマンド | 説明 |
|--------|-----|
| `/doctor` | インストールと設定を診断（`f` で自動修正） |
| `/debug [description]` | **Skill** デバッグログを有効化して問題を分析 |
| `/hooks` | フック設定の閲覧（読み取り専用） |
| `/status` | バージョン・モデル・アカウント・接続状況 |
| `/usage` | コスト・使用量・統計（`/cost`/`/stats` でも可） |

### プランモード

| コマンド | 説明 |
|--------|-----|
| `/plan [description]` | プランモードに入る |

### その他

| コマンド | 説明 |
|--------|-----|
| `/help` | ヘルプと利用可能なコマンドを表示 |
| `/exit` | CLI を終了（`/quit` でも可） |
| `/copy [N]` | 最後のアシスタントレスポンスをクリップボードにコピー |
| `/export [filename]` | 現在の会話をテキストとしてエクスポート |
| `/feedback [report]` | フィードバック・バグ報告（`/bug`/`/share` でも可） |
| `/login` | Anthropic アカウントにサインイン |
| `/logout` | サインアウト |

### バンドルスキル（Skill マーク）

| コマンド | 説明 |
|--------|-----|
| `/run` | アプリを起動して変更を実際に確認（v2.1.145+） |
| `/verify` | コード変更が期待通りに動作するか実際のアプリで確認（v2.1.145+） |
| `/run-skill-generator` | `/run`/`/verify` の起動レシピをプロジェクトスキルとして記録 |
| `/loop [interval] [prompt]` | プロンプトを繰り返し実行（`/proactive` でも可） |
| `/deep-research <question>` | **Workflow** Web 検索をファンアウトして調査レポートを生成 |
| `/claude-api` | Claude API リファレンスをロード（SDK import 時に自動発火） |
| `/code-review` | 差分のコードレビュー（上記参照） |
| `/simplify` | リファクタリングのみのレビュー（v2.1.154+） |
| `/batch` | 大規模変更を並列適用 |
| `/debug` | デバッグログ有効化 |
| `/fewer-permission-prompts` | 許可プロンプト削減のための allowlist 設定 |

---

## よくある落とし穴

1. **コマンドはメッセージの先頭のみ認識** → 文中に `/command` を書いても発火しない。
2. **可用性はプラットフォーム・プラン依存** → `/desktop`（macOS/Windows + サブスクリプション必要）等は全ユーザーに表示されない。
3. **スキルと MCP プロンプトの競合** → スキルがコマンド名で優先される。
4. **`/code-review ultra` はクラウド実行** → 無料枠（3回）を超えると usage credits が必要。

---

## このリポでの使い方

このリポのスキルは `/` コマンドとして呼び出せる（`user-invocable: false` でない場合）。

```
/create-commit     # コミット作成
/create-pr         # PR 作成
/create-plan       # 計画立案
/implement-issue   # Issue 実装
```

`user-invocable: false` に設定されたスキル（`github-docs`・`claude-code-reference` 等）は `/` メニューに表示されず、Claude が自動的に呼び出す。

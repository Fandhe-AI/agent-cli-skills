<!-- source: https://code.claude.com/docs/en/memory -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->

# CLAUDE.md / メモリ リファレンス

## 概要

Claude Code のセッションはコンテキストウィンドウがリセットされる。セッションをまたいで知識を持続させる仕組みが 2 つある:

1. **CLAUDE.md ファイル** ── あなたが記述する永続的な指示
2. **Auto memory** ── Claude が自動的に書き込むメモ

---

## CLAUDE.md ファイル

### ファイル配置と優先度（ロード順）

| スコープ | ファイルパス | 共有対象 |
|---------|-----------|--------|
| **Managed policy** | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS) / `/etc/claude-code/CLAUDE.md` (Linux) | 組織全員 |
| **ユーザー** | `~/.claude/CLAUDE.md` | 自分のみ（全プロジェクト） |
| **プロジェクト** | `./CLAUDE.md` または `./.claude/CLAUDE.md` | チーム（バージョン管理） |
| **ローカル** | `./CLAUDE.local.md` | 自分のみ（gitignore 推奨） |

**ロード動作:**
- 現在の作業ディレクトリから上位ディレクトリへ再帰的に探索する。
- 発見したファイルはすべて結合してコンテキストに注入（上書きでなく追記）。
- ルートから下（広いスコープ→狭いスコープ）の順番でコンテキストに入る。
- サブディレクトリの `CLAUDE.md` は Claude がそのディレクトリのファイルを読んだ時にオンデマンドでロード。

### `@` インポート構文

```markdown
# CLAUDE.md 内でのインポート
@README
@package.json
@docs/git-instructions.md
@~/.claude/my-project-instructions.md   # ホームディレクトリ参照
```

**制約:**
- 相対パスはインポートするファイルからの相対パスで解決（作業ディレクトリではない）
- 再帰インポート可（最大 4 ホップ）
- 初回外部インポート時に承認ダイアログが表示される
- インポートされたファイルはセッション開始時にコンテキストに展開される（遅延ロードなし）

### HTML コメント

```markdown
<!-- このコメントは Claude のコンテキストに入らない（メンテナー向け） -->
```

コードブロック内のコメントは保持される。

---

## `.claude/rules/` ディレクトリ

トピック別のルールファイルを分割管理できる:

```
your-project/
├── .claude/
│   ├── CLAUDE.md           # メインプロジェクト指示
│   └── rules/
│       ├── code-style.md   # コードスタイル
│       ├── testing.md      # テスト規約
│       └── security.md     # セキュリティ要件
```

**パス別ルール（frontmatter で指定）:**

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/**/*.{ts,tsx}"
---

# API 開発ルール

- 全エンドポイントに入力バリデーションを含める
- 標準エラーレスポンスフォーマットを使用
```

`paths` がないルールはセッション開始時に常時ロード。`paths` があるルールは、一致するファイルを Claude が開いた時にロード。

**シンボリックリンクでプロジェクト間共有:**

```bash
ln -s ~/shared-claude-rules .claude/rules/shared
ln -s ~/company-standards/security.md .claude/rules/security.md
```

**ユーザーレベルルール:** `~/.claude/rules/` に配置するとすべてのプロジェクトで有効。プロジェクトルールより低優先。

---

## 効果的な CLAUDE.md の書き方

**目安:** 1 ファイルあたり 200 行以内。コンテキスト消費を抑え、指示の遵守率を上げる。

**良い例:**
```markdown
- 2 スペースインデントを使用
- `npm test` を実行してからコミット
- API ハンドラーは `src/api/handlers/` に配置
```

**悪い例:**
```markdown
- コードを適切にフォーマットする
- 変更をテストする
- ファイルを整理する
```

**構造:** Markdown ヘッダーと箇条書きを使って関連指示をグループ化。

---

## Auto Memory

Claude が自動的に学習内容を記録する仕組み（v2.1.59+）。

### ストレージ構造

```
~/.claude/projects/<project>/memory/
├── MEMORY.md          # インデックス（毎セッション最初の 200 行または 25KB をロード）
├── debugging.md       # デバッグパターンの詳細メモ
├── api-conventions.md # API 設計決定事項
└── ...
```

`<project>` パスは git リポジトリから導出（同じリポの全 worktree がメモリを共有）。

**ロード動作:**
- `MEMORY.md` の最初の 200 行（または 25KB）が毎セッション開始時にロード
- トピックファイルはオンデマンドで読み込まれる
- `MEMORY.md` を超えた内容はセッション開始時にロードされない

### 有効/無効の切り替え

```json
// settings.json
{"autoMemoryEnabled": false}
```

```bash
# 環境変数で無効化
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude
```

セッション内では `/memory` コマンドでトグル可能。

### カスタムストレージ場所

```json
{"autoMemoryDirectory": "~/my-custom-memory-dir"}
```

絶対パスまたは `~/` で始まるパスが必要。プロジェクト設定に書いた場合は workspace trust 確認後に有効。

---

## `/memory` コマンド

セッション内で CLAUDE.md・CLAUDE.local.md・rules ファイルの一覧表示、auto memory のトグル、auto memory フォルダへのリンクを提供。

---

## AGENTS.md との互換性

他のエージェントツールが `AGENTS.md` を使っている場合:

```markdown
<!-- CLAUDE.md -->
@AGENTS.md

## Claude Code 固有の指示

src/billing/ 配下の変更はプランモードを使用。
```

または シンボリックリンク:
```bash
ln -s AGENTS.md CLAUDE.md
```

---

## 大規模リポジトリ・モノレポでの管理

### 不要な CLAUDE.md を除外

```json
// .claude/settings.local.json
{
  "claudeMdExcludes": [
    "**/monorepo/CLAUDE.md",
    "/home/user/monorepo/other-team/.claude/rules/**"
  ]
}
```

パターンは絶対パスに対する glob。Managed policy の CLAUDE.md は除外できない。

### 組織共通 CLAUDE.md のデプロイ

MDM/Group Policy 等で managed policy の場所にデプロイ:
- macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`
- Linux: `/etc/claude-code/CLAUDE.md`

または `managed-settings.json` の `claudeMd` キーに直接埋め込み:

```json
{
  "claudeMd": "コミット前は `make lint` を実行すること。\nmain への直接プッシュ禁止。"
}
```

---

## `/compact` 後の生存

| コンテンツ | compact 後 |
|----------|----------|
| プロジェクトルートの CLAUDE.md | 生存（再読み込み・再注入） |
| サブディレクトリの CLAUDE.md | 次回ファイル読み込み時に再ロード |
| 会話内のみの指示 | 失われる |
| Auto memory (MEMORY.md) | 再ロード |

---

## トラブルシューティング

**CLAUDE.md が効かない場合:**
1. `/memory` でファイルがリストに表示されるか確認
2. ファイルの配置場所がセッションのパスと一致するか確認
3. 指示をより具体的に書き直す
4. 相矛盾する指示がないか確認

**強制実行が必要な場合:** CLAUDE.md はソフトガイダンス。確実に実行させるには PreToolUse hook を使う。

---

## このリポでの使い方

```
CLAUDE.md                   # プロジェクト指示（git 管理、チーム共有）
.claude/rules/              # ルール別管理（git 管理）
CLAUDE.local.md             # 個人設定（.gitignore 追加済み）
~/.claude/CLAUDE.md         # 全プロジェクト共通の個人設定
```

**このリポの CLAUDE.md に含まれている内容:**
- スキルの説明・発火トリガー語の規約
- Conventional Commits 形式の要件
- セキュリティレビュー必須事項
- 日本語出力の規約
- `.claude/` 操作は `_/dotclaude/` 経由という規則

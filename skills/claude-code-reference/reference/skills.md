<!-- source: https://code.claude.com/docs/en/skills -->
<!-- 最終確認日: 2026-06-06 -->
<!-- ✅ 取得済み（WebFetch による公式ドキュメント取得） -->
<!-- 取得状況: ✅ 取得済み -->

# Agent Skills リファレンス

## 概要

Skills は Claude Code の機能を拡張する仕組み。`SKILL.md` ファイルに手順を記述すると、Claude のツールキットに追加される。Claude が自動的に適用するか、`/skill-name` で直接呼び出せる。

**重要な設計判断:**
- CLAUDE.md のコンテンツ（常にコンテキストに入る）とは異なり、スキルの本文は**使用時のみ**ロードされるため、長いリファレンス素材のコストが低い。
- カスタムコマンド (`.claude/commands/`) はスキルに統合された。両者は同等に動作するが、スキルを推奨。

---

## 必須項目・構文

### ファイル配置

| 場所 | パス | 適用範囲 |
|-----|------|---------|
| エンタープライズ | managed settings 経由 | 組織全員 |
| 個人 | `~/.claude/skills/<name>/SKILL.md` | 全プロジェクト |
| プロジェクト | `.claude/skills/<name>/SKILL.md` | 当該プロジェクトのみ |
| プラグイン | `<plugin>/skills/<name>/SKILL.md` | プラグイン有効時 |

**コマンド名の決定:** ディレクトリ名がコマンド名になる（`frontmatter` の `name` フィールドは表示名のみ）。

### frontmatter 全フィールド

```yaml
---
name: my-skill                    # 表示名（省略可、デフォルト: ディレクトリ名）
description: "スキルの説明。Claude がいつ使うか。トリガー語を含める。"
when_to_use: "追加の発火条件や例"  # description に追記される（任意）
argument-hint: "[issue-number]"    # 引数のヒント（任意）
arguments: [issue, branch]         # 名前付き引数定義（任意）
disable-model-invocation: true     # true: ユーザーのみ呼び出し可（任意）
user-invocable: false              # false: / メニューに非表示（任意）
allowed-tools: "Read Grep Bash"    # このスキル実行中に許可するツール（任意）
disallowed-tools: "Write Edit"     # このスキル実行中に禁止するツール（任意）
model: haiku                       # haiku/sonnet/opus またはフル ID（任意）
effort: high                       # low/medium/high/xhigh/max（任意）
context: fork                      # fork: サブエージェントで実行（任意）
agent: Explore                     # context:fork 時のエージェント種類（任意）
hooks: ...                         # スキルスコープの hooks（任意）
paths:                             # このスキルが発火する glob パターン（任意）
  - "src/api/**/*.ts"
shell: bash                        # !`command` に使うシェル（bash/powershell）
---
```

**description の注意:**
- `description` + `when_to_use` の合計は **1,536 文字**でスキルリスト表示時に打ち切られる。重要なキーワードを先頭に置く。
- `#` を含む場合は**クォートで囲む**こと（YAML コメント扱いを防ぐ）。

  ```yaml
  # NG: YAML コメントとして # 以降が消える
  description: スキル説明 # 詳細は別スキル参照

  # OK: クォートで囲む
  description: "スキル説明 # 詳細は別スキル参照"
  ```

  参考: コミット e83e1bb（このリポ固有の教訓）

### model 選定基準（このリポ規約）

| ユースケース | model |
|-----------|-------|
| 機械的・集計・一覧生成 | `haiku` |
| 判定・生成・レビュー・複数ファイル読解 | `sonnet` |
| 複雑な計画立案・アーキテクチャ設計 | `opus` |

---

## 文字列置換（変数）

| 変数 | 説明 |
|-----|-----|
| `$ARGUMENTS` | 呼び出し時に渡された全引数 |
| `$ARGUMENTS[N]` | N 番目の引数（0 始まり） |
| `$N` | `$ARGUMENTS[N]` の短縮形 |
| `$name` | `arguments` フィールドで定義した名前付き引数 |
| `${CLAUDE_SESSION_ID}` | 現在のセッション ID |
| `${CLAUDE_EFFORT}` | 現在の effort レベル |
| `${CLAUDE_SKILL_DIR}` | このスキルの `SKILL.md` があるディレクトリ |

---

## 最小例

### 基本スキル

```yaml
---
name: summarize-changes
description: "コミット前の差分を要約してリスクを指摘。「何が変わった」「コミットメッセージを作って」などで使用。"
---

## 現在の差分

!`git diff HEAD`

## 指示

上記の変更を 2〜3 箇条で要約し、リスク（エラーハンドリング漏れ、ハードコード値、未更新のテスト等）を列挙する。
```

### 引数を取るスキル

```yaml
---
name: fix-issue
description: "GitHub Issue を番号で修正する。「Issue #N を直して」などで使用。"
disable-model-invocation: true
argument-hint: "[issue-number]"
---

Issue #$ARGUMENTS を修正する:
1. Issue の内容を読む
2. コードを修正する
3. テストを書く
4. コミットする
```

### サブエージェントで実行するスキル

```yaml
---
name: deep-research
description: "コードベースのトピックを詳しく調査する。「〜について調べて」などで使用。"
context: fork
agent: Explore
---

$ARGUMENTS を徹底的に調査する:
1. Glob と Grep で関連ファイルを探す
2. コードを読んで分析する
3. 具体的なファイル参照付きで結果をまとめる
```

### 動的コンテキスト注入（! バッククォート）

```yaml
---
name: pr-summary
description: "PR の変更を要約する。"
context: fork
agent: Explore
allowed-tools: "Bash(gh *)"
---

## PR コンテキスト
- PR diff: !`gh pr diff`
- PR コメント: !`gh pr view --comments`
- 変更ファイル: !`gh pr diff --name-only`

このプルリクエストを要約する...
```

`!` バッククォートは行頭または空白の直後のみ認識される。複数行は ` ```! ` ブロックを使用。

---

## invocation 制御

| frontmatter | ユーザー呼び出し | Claude 自動呼び出し | コンテキスト投入 |
|------------|--------------|------------------|--------------|
| (デフォルト) | Yes | Yes | 説明常時投入、本文は呼び出し時 |
| `disable-model-invocation: true` | Yes | No | 説明なし、本文は呼び出し時 |
| `user-invocable: false` | No | Yes | 説明常時投入、本文は呼び出し時 |

---

## よくある落とし穴

1. **description の `#` がコメント扱いになる** → 必ずクォートで囲む（`e83e1bb` 参照）
2. **スキルが発火しない** → description にユーザーが実際に言う言葉（トリガー語）を入れる。`/skills` でスキル一覧を確認。
3. **context: fork を意図しない使い方** → `context: fork` は明示的なタスク指示がある場合のみ有効。ガイドライン系のコンテンツには不適切。
4. **description が長すぎる** → `description` + `when_to_use` で 1,536 文字上限。重要情報を先頭に。
5. **スキル本文が長い** → 本文はセッション中コンテキストに残り続ける。500 行以内を推奨。詳細は別ファイルに分離。
6. **supporting files の読み込み** → `SKILL.md` から参照しないと Claude は存在を知らない。

---

## このリポでの使い方

```
skills/<name>/SKILL.md        # スキル本体
.claude/skills/<name>         # シンボリックリンク（skills/<name> → .claude/skills/<name>）
```

**シンボリックリンク作成:**

```bash
ln -s ../../skills/<name> .claude/skills/<name>
```

**新スキル追加後:**

`update-docs` スキルを実行して `CLAUDE.md` のスキル一覧・ツリーを更新する。

**.claude/ 配下の編集:** `dotclaude-via-temp.md` ルールに従い `_/dotclaude/` を経由する。

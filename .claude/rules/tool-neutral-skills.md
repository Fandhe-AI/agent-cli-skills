---
description: 配布スキルを Claude Code / Codex / OpenCode のどれで読まれても同じ手順で動く書き方にする規約
paths:
  - "skills/**"
---

# スキルの 3 ツール中立規約

配布スキル（`skills/<name>/SKILL.md` と `references/`）を、Claude Code・Codex・OpenCode のどれで読まれても同じ手順で実行できる書き方にする。ツール固有の名前・置換変数・固定表記を本文に持ち込まない。

## 適用範囲と例外

| 区分 | スキル | 扱い |
|------|--------|------|
| 適用対象 | `skills/` の全スキル（下記の適用外を除く） | 本規約に従う |
| 適用外（Claude Code 専用） | implement-issue-tree・init-claude・update-claude | 本規約の対象外。implement-issue-tree は別計画で追随する |
| ツール名を書いてよい | init-codex・update-codex・init-opencode・update-opencode | ツールごとの分岐を書くスキルなので、ツール名・ツール固有の仕様を書いてよい |

## 決定: 手順はツール固有の機構に依存させない

**Why:** 実機で確かめたのは Codex 0.164.0 と OpenCode v2.2.7 の 2 つで、下記の書き方どおりに引数・確認・委譲が意図どおり動いた。Claude Code は従来どおりの挙動を前提にしており、本規約の文面での実機確認はスキル修正時に行う。逆にツール固有の名前（委譲ツール名・確認ツール名）や置換変数は、他ツールでは解釈されずそのまま文字列として渡る。

## 3 ツールの仕様差（要点）

| 項目 | Claude Code | Codex | OpenCode |
|------|-------------|-------|----------|
| スキルの配置場所 | `.claude/skills`（`.agents/skills` は読まない） | `.agents/skills`（`.claude/skills` は読まない） | `.opencode/skills`・`.claude/skills`・`.agents/skills`（同名は `.agents` が勝つ） |
| 引数 | `$ARGUMENTS` が置換される | 置換されない。起動時のプロンプトの文字列として渡る（実機: `$name alpha beta` で `alpha beta` を受け取る） | 置換されない。起動時のプロンプトの文字列として渡る（実機: 同上） |
| 委譲 | 専用ツールで起動する | 自然言語で依頼する。`codex exec --ephemeral` では委譲せず自分で実行する（実機） | `subagent` ツールで起動する |
| 非対話時の確認 | 確認ツールで対話する | 確認は起動されず、確認事項を最終メッセージにして終了する（実機） | 確認ツールが「非対話では尋ねられない」で取り消され、書き込まず停止する（`--auto` でも同じ・実機） |
| 起動時の承認の指示 | — | 確認を省いて続行する（実機） | 確認を省いて続行する（実機） |
| 既定 sandbox | — | `.git`・`.agents`・`.codex` が読み取り専用（commit 不可・実測） | — |
| frontmatter の未知キー | `model`・`argument-hint` 等が効く | 無視（警告なし） | 無視（警告なし） |

## 書き方

### 委譲

| 項目 | 内容 |
|------|------|
| 書き方 | 「サブエージェントを使える環境では、用途に合うもの（調査は読み取り専用、作業は汎用）へ委譲する。使えない環境では同じ手順を自分で実行する」 |
| 追加で書くこと | 委譲先に渡す入力（差分・観点・出力形式）を本文に書き、どちらで実行しても同じ結果になるようにする |
| 書かないもの | `Agent ツール`・`subagent_type`・`Explore Agent` / `plan-verifier` 等の固有名・`isolation: "worktree"` |

### ユーザーへの確認と承認

書き方（そのまま使える定型文）:

> ユーザーに確認し、明示的な返答を待つ。選択肢は番号付きで示す。起動時の指示にその操作への明示の承認（例: 「確認なしでコミットまで進めて」「この計画で実装して」）が含まれていれば、確認を省いて続行してよい。承認が無く対話もできない環境（非対話実行）では、書き込み・実装をせず確認事項を報告して止める。

- 何を承認とみなすかは、スキルごとに本文で列挙する（例: create-commit はメッセージ案の確認、implement-issue は計画の承認）。
- 書かないもの: `AskUserQuestion`・plan mode・`ExitPlanMode`。

**安全上の確認は起動時の承認でも省けない。** 次は検出時に必ず止めて報告する。

| 区分 | 例 |
|------|-----|
| 秘密情報の検出 | create-commit Step 2 の検出時の確認・中止 |
| セキュリティ問題の検出による中止 | `./security.md` の高・中の重大度の扱い |
| 破壊的・取り消せない操作の確認 | 削除・force 系・公開範囲の変更・一括更新・一括アーカイブ |

### 引数

- 書き方: 「起動時に渡された文字列を引数とする。無ければユーザーに確認する」。シェル変数への代入は `<引数>` のプレースホルダで示す（例: `X="<引数のスキル名>"`）。
- 書かないもの: `$ARGUMENTS`・`$N`。

### 同梱スクリプト

- 書き方: 「このスキルの `scripts/<x>.sh`（SKILL.md と同じディレクトリ）」と書く。絶対パスは読み込んだ SKILL.md の場所から求める。`skills/` → `.agents/skills/` → `.claude/skills/` の 3 レイアウト探索は、そのまま使ってよい（探索リストを減らさない）。
- 書かないもの: `${CLAUDE_SKILL_DIR}` 等の `${CLAUDE_` 変数。

### ファイル操作の動詞

- 書き方: 「読む」「検索する」「編集する」「実行する」のように動詞で書く。
- 書かないもの: Read / Edit / Write / Glob / Grep / Bash などのツール名。シェルの状態は「呼び出しごとに消える」と性質で書く。

### 指示ファイルと規約

- 書き方: 「対象リポジトリの規約（CLAUDE.md / AGENTS.md / CONTRIBUTING / `.claude/rules/` 等）があればそれに従い、無ければ次の要点に従う」。要点は本文に置く。
- 書かないもの: `.claude/rules/X.md` だけを根拠にした断定（配布先に無いことがある）。

### 主語

- 書き方: 「エージェント」と書くか、主語を省く。
- 書かないもの: 「Claude が…」。他のエージェントと並べる例示の場合だけ許す。

### 共著者と生成表記

- 書き方: スキルからは付与しない。ツールの設定・対象リポジトリの規約に任せる。
- 書かないもの: `Co-Authored-By: Claude …`・`Generated with [Claude Code]`。

### frontmatter

| キー | 扱い |
|------|------|
| `name` | 必須。ディレクトリ名と一致する 64 文字以内の kebab-case |
| `description` | 必須。1,024 文字以内 |
| `model`・`user-invocable`・`argument-hint` | Claude Code 用。Codex / OpenCode は警告なしで無視するので残してよい。手順はこれらに依存させない |

書かないもの: `allowed-tools` 等に依存した手順。

### sandbox 環境での実行

- 「sandbox 環境での実行」見出しの節を全スキルに置く（雛形は `./skill-authoring.md`）。
- ネットワークを使う手順と、Codex の既定 sandbox で書けない場所（`.git`・`.agents`・`.codex`）に書く手順を明記する。
- Codex の対話セッションでは承認による昇格を求める。`codex exec` では昇格要求が出ない（実測）ため、書けなかったことを報告して止める。案内は「`.git` を書き込み可にした permissions プロファイルで実行し直す」か「ユーザーが自分で実行する」。

### 実機確認の判定

- 判定は副作用（sha・ファイル・偽 gh のログ）で行う。モデルの返答の文面だけで判定しない（配布した指示を読んだモデルは、禁止コマンドを自分から実行しないことがあるため）。
- Codex で委譲を確認する実行には `--ephemeral` を付けない。

## 静的検査

`.github/scripts/check-tool-neutral.sh` が、適用対象のスキルの `SKILL.md` と `references/` を検査する。`--strict` では違反か欠落が 1 件以上あると終了コード 1 になり、CI の Skill structure check が fail する。

```bash
bash .github/scripts/check-tool-neutral.sh --strict
```

検出する語:

| 検出語 | 理由 |
|--------|------|
| `Agent ツール` | 委譲の固有ツール名 |
| `subagent_type` | 委譲の固有パラメータ |
| `isolation: "worktree"` | 委譲の固有パラメータ |
| `Bash ツール` | ツール名 |
| `Claude が`・`Claude は` | 主語（`Claude Code が` などの製品名は一致しない） |
| `AskUserQuestion` | 確認の固有ツール名 |
| `ExitPlanMode` | plan mode の固有ツール名 |
| `$ARGUMENTS` | 他ツールでは置換されない |
| `${CLAUDE_` | Claude Code 専用の変数 |
| `Co-Authored-By: Claude` | 固定の共著者表記 |
| `Generated with [Claude Code]` | 固定の生成表記 |
| `.claude/agents` の agent 名（`Explore Agent` 等） | 委譲先の固有名（`.claude/agents/**/*.md` の `name:` から機械的に作る） |

加えて、「sandbox 環境での実行」見出しが適用対象のすべてにあることを検査する（節の中身の妥当性はレビューで見る）。

### 静的検査で拾わないもの（レビュー観点で見る）

次はスクリプトでは検出しない。`.claude/agents/quality/skill-reviewer.md` の観点 H で見る。

- Read / Edit / Write / Glob / Grep などの一般語と重なるツール名
- 確認・承認の箇所に、規約の文言が入っているか
- 安全上の確認が省略可能になっていないか
- 委譲先へ渡す入力・出力形式が本文にあるか
- sandbox 節の中身

例示としてどうしても上記の語を書く行には、行末に `<!-- tool-neutral: allow -->` を付ける。検査は許可マーカーの件数（`allowed`）を出力する。許可マーカーは例示専用で、手順の本文には使わない。

## 注意事項

- 本規約は Claude Code 上の手順・成果物を変えずに書き方だけを中立にする。承認の無い対話実行の挙動を変えてはならない。
- 安全上の確認を、承認の文言で省略可能にしてはならない。
- 適用外スキルへ本規約を機械的に広げない。

## 関連ルール

- `./skill-authoring.md` — SKILL.md の frontmatter・本文構成・sandbox 節の雛形
- `./description-style.md` — description の書き方
- `./security.md` — 安全上の確認・中止の基準
- `./verification.md` — 副作用に基づく完了の証拠

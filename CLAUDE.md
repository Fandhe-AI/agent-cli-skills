# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code・Codex・OpenCode 向けの CLI ワークフロースキル集。コミット・PR・Issue・レビューなどの開発ワークフローを Conventional Commits 準拠で自動化する。インストールは [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用。

## Repository Structure

> ツリーの各行は 1〜2 行の要約に留める。スクリプト・テストの詳細はファイル冒頭コメントと references に書く（update-docs・docs-writer も同じ）。

```
skills/                               -- スキル本体（各ディレクトリに SKILL.md）
  comment-code/
  create-commit/
  create-issue/
  create-issue-tree/
    scripts/                          -- create-root-body.sh（Step 6 新規作成経路のルート本文生成・実ツリーから表を作りプレースホルダー残りで中止）、merge-root-body.sh（Step 6 --root 経路・既存ルート本文へ今回の Phase 行・セクションをマージ）、tree-lib.sh（list_subs・count_open_desc・CELL・プレースホルダー正規表現の共通ヘルパー・source 専用）
  create-plan/
  create-pr/
  implement-issue/
  implement-issue-tree/
    references/                       -- 引数の詳細（args-reference.md）・opt-in テスト宣言の詳細（optin-tests.md）・base 取り込み専用ループ（base-merge.md）・cancel された run の残存 check の検知と対処（residual-check.md。residual-check-detection テストが (A) のスクリプトを抽出して実行）・自動マージ設計・検証手順・復旧・レポート書式・スクリプト実行の信頼モデル（script-trust-model.md）・テストの流し方と変異テストの使い方（testing.md）
    sample/                           -- 引数例・ツリー例
    scripts/                          -- 観測（observe-pr.sh・fetch-tree.sh・repo-scan.sh・declared-deps.sh・measure-*.sh）、封筒つき出力と launcher（lib/signed-output.sh・run-verified.sh）、push・PR（pr-push.sh・base-merge.sh・reply-resolve.sh）、マージ前検証（merge-gate.sh・merge-guard-hook.sh）、worktree 掃除と回復（worktree-remove.sh・recover-prep.sh）、状態書き込み（state.sh）、ビルダー（build-workflow.mjs・token-diff.cjs・mangle-identifiers.cjs・alpha-verify.cjs。コメント・空白除去 → トークン照合 → 束縛名の改名 → α 同値の照合の順で、どれかが失敗すれば書かない。implement-issue-tree.src.js が編集対象・implement-issue-tree.js は生成物で直接編集禁止）。純関数は lib/*-lib.sh（source 専用）。各スクリプトの契約は冒頭コメントと references/script-trust-model.md
    tests/                            -- node:test の回帰テスト（lib の表の単体検査・偽 gh と実 git のサンドボックスによるスクリプト実行・ホスト配線・ビルダーと変異テスト tools/）。流し方と変異テストは references/testing.md
  implement-review/
  implement-review-pr/
  init-claude/
  init-codex/
    assets/                           -- hooks（agent-guard.sh 共通ガード・codex-pretooluse.sh・codex-session-start.sh）・codex（hooks.json・rules・agents）・scripts/agents-md-block.sh（AGENTS.md 管理区間）
  init-opencode/
    assets/                           -- opencode（plugins/agent-guard・opencode.jsonc・agents）・hooks/agent-guard.sh（共通ガード）・scripts/agents-md-block.sh（AGENTS.md 管理区間）
  update-docs/
    scripts/                          -- select-target.sh（更新対象の選択。CLAUDE.md があれば claude、無く AGENTS.md があれば agents、同一ファイルは agents、どちらも無ければ none）、agents-section.sh（AGENTS.md の update-docs 専用区間だけを追記・差し替え。区間外はバイト不変・マーカー不整合と agents-md 区間との入れ子は書かず停止・32 KiB 超は警告）
  update-issue-tree/
    scripts/                          -- reassign-sub-issue.sh（closed 親下の残置 open issue 付け替え・孤児再配置。DELETE→POST を単一プロセスで冪等に実行。cross-repository sub-issue は非対応で exit 2）、reassign-lib.sh（Step 3/4 の呼び出し側共有ヘルパー。計画配列の存在・型検証と終了ステータス解釈。両フェンスが自己完結的に source する）、update-root-body.sh（Step 8 のルート本文部分更新。マーカー間の管理ブロックのみ差し替え・既存本文は保持・マーカー無し本文は旧 Phase 表を details へ退避して移行・exit 4/5 で fail-closed）
  update-claude/
  update-codex/
    assets/                           -- init-codex と同じ資産（hooks・codex・scripts/agents-md-block.sh）・scripts/codex-hooks-merge.sh（hooks.json のマージ）
  update-opencode/
    assets/                           -- init-opencode と同じ資産（opencode・hooks・scripts/agents-md-block.sh）・scripts/opencode-config-merge.mjs（opencode.jsonc のマージ）
  setup-repo-guards/
    scripts/                          -- verify-ai-review-wrapper.sh（Step 1 で commit SHA 固定取得した ai-review wrapper の配置前検査。allow-list 方式〔with の値はキーごとの 1 行 plain scalar・types / branches は要素ごとの完全一致・文字列の位置〔name・ジョブ ID・group・with の文字列キー・branches の要素〕では引用符なしで null・真偽値・数値・日付に解決される値を拒否〔YAML 1.1 と 1.2 の和集合・引用符で囲めば許可〕・concurrency は任意だがあれば group 必須〕・ジョブ構造は状態機械で追い uses・権限・provider を現在のジョブへ束縛・uses 完全一致 1 件・特権トリガー／run／secrets: inherit／過剰権限を拒否・ファイル内容は出力しない・exit 0 合格 / 1 不合格 / 2 使い方の誤り）
  project-init/
  project-add-items/
  project-create-issues/
  project-view-status/
  project-update-items/
  project-sync-issues/
  project-archive-done/
  contribute-skill/
    scripts/                          -- skills-contribute.sh（upstream 反映スクリプト。lock 照合は fail-closed・コピー前に対象スキルの作業ツリー clean 検査を行う）
  sync-skills-lock/
dev/                                  -- 開発専用（配布物 skills/ の外・下流へ配布されない）。dev/<name>/tests/ が skills/<name>/ のテスト（implement-issue-tree の分は別 PR で移す）
  contribute-skill/
    tests/                            -- node:test 回帰テスト（lock 不在・未登録・source 欠落・解析失敗の中止、未コミット・未追跡・ignore 対象の検出時にコピー前で中止すること）
  create-issue-tree/
    tests/                            -- node:test 回帰テスト（新規作成・--root 両経路とも scripts/ のスクリプトを直接実行・引数検証・edit 失敗の終了コード伝播・ライブラリ契約・Step 6 の呼び出しフェンス検査と 3 レイアウト探索・プレースホルダー残りで中止・ページング・一時ファイル削除・Step 3 雛形への --root マージ・コードフェンス内の行を見出しと誤認しない／閉じ忘れフェンスで中止・update-issue-tree の管理マーカー区間と退避 `<details>` を壊さない／マーカー不整合・同名見出しの重複で中止）
  create-pr/
    tests/                            -- node:test 回帰テスト（SKILL.md の静的検査: git push が Step 2 のセキュリティチェックより後・gh pr create より前・前提条件に push 済みの要求が無い・force 系の push をしない・sandbox 節の git push と .git 書き込み）
  init-claude/
    tests/                            -- node:test 回帰テスト（version-pin）
  init-codex/
    tests/                            -- node:test 回帰テスト（agent-guard・codex-adapter・agents-md-block・asset-sync・version-pin）
  init-opencode/
    tests/                            -- node:test 回帰テスト（opencode-plugin・opencode-config・asset-sync・version-pin）
  setup-repo-guards/
    tests/                            -- node:test 回帰テスト（合格形・1 項目ずつの変異で不合格・型付き scalar × 文字列の位置の直積と引用符つきの対照・concurrency の group 必須・実行できる全 bash〔/bin/bash 3.2 と PATH の bash 5〕で結果が一致すること・上流テンプレートの実物 fixture〔fixtures/〕・PyYAML による oracle〔値の型まで str を要求〕・空ファイルとエラー JSON・使い方の誤り・出力に内容を含めないこと）
  sync-skills-lock/
    tests/                            -- node:test 回帰テスト（checker・restore・scope-guard・version-pin 等）
  update-claude/
    tests/                            -- node:test 回帰テスト（version-pin）
  update-codex/
    tests/                            -- node:test 回帰テスト（asset-sync・codex-hooks-merge・version-pin）
  update-docs/
    tests/                            -- node:test 回帰テスト（select-target の選択と無変更・agents-section の追記・差し替え・unchanged・停止条件・フェンス・32768 バイト境界・init-codex との往復、SKILL.md Step 0 のフェンス）
  update-issue-tree/
    tests/                            -- node:test 回帰テスト（DELETE 失敗時に POST が呼ばれないこと、Step 8 の既存本文保持・移行・冪等・並行編集検知・マーカー不整合停止等・タイトルの文字参照変換〔create-issue-tree の CELL と同じ出力〕・旧形式の書き直し・create-issue-tree の --root 再マージとの往復〔相手のスキルが無ければ skip〕）、lib/ に gh スタブ（作る一時ディレクトリは tmp-track.mjs でプロセス終了時に消す）
  update-opencode/
    tests/                            -- node:test 回帰テスト（asset-sync・opencode-config-merge・version-pin）
.claude/
  agents/
    research/
      skill-explorer.md               -- skills/ 横断調査・読み取り専用（Sonnet）
      sub-investigator.md             -- gh/git/CLI/hook 失敗調査（Sonnet）
      reference-researcher.md         -- 公式ドキュメント調査（Sonnet）
    author/
      skill-author.md                 -- skills/<name>/SKILL.md 作成編集（Sonnet）
      agent-author.md                 -- .claude/agents 作成編集（Sonnet）
      rules-author.md                 -- .claude/rules 作成編集（Sonnet）
      docs-writer.md                  -- CLAUDE.md/README 一覧・ツリー更新（Haiku）
    quality/
      skill-reviewer.md               -- SKILL.md 品質レビュー・読み取り専用（Sonnet）
      security-auditor.md             -- OWASP 監査・読み取り専用（Sonnet）
      frontmatter-linter.md           -- frontmatter/symlink 機械検証（Haiku）
      plan-verifier.md                -- 計画検証・読み取り専用（Sonnet）
  rules/
    delegation.md                     -- 委譲の原則（調査・設計フェーズ）
    delegation-impl.md                -- 委譲マッピング（作成・編集フェーズ）
    skill-authoring.md                -- スキル著作規約
    agent-authoring.md                -- エージェント著作規約
    conventional-commits.md           -- Conventional Commits 詳細規約
    security.md                       -- セキュリティチェック規約
    japanese-style.md                 -- 日本語スタイルガイド
    dotclaude-via-temp.md             -- .claude/ 操作時の一時ディレクトリルール
    description-style.md              -- description 著作スタイル
    reference-template.md             -- reference 型スキルの書式規約
    code-comment-style.md             -- コード内コメント・ドキュメンテーションコメント規約
    verification.md                   -- 完了ゲート規約（証拠なき完了宣言の禁止・5段階検証）
    debugging.md                      -- 根本原因デバッグ規約（修正前の原因調査・3回失敗でエスカレーション）
    ruleset-policy.md                 -- ブランチ ruleset 方針（strict 必ず false・required check の App 束縛・一括更新後の 3 軸検証）
    skill-vendoring-layout.md         -- downstream のスキル配置方針（.claude/skills は symlink / 実ディレクトリどちらでも可・配置差を理由に構成変更しない）
    github-actions.md                 -- GitHub Actions のキャッシュ方針（保存は main だけ・ルートの lockfile だけをハッシュ）
    tool-neutral-skills.md            -- 3 ツール中立のスキル本文規約（委譲・確認・引数・sandbox 節・静的検査）
  skills/                             -- skills/ へのシンボリックリンク（一部実ディレクトリ）
    create-skill/                     -- リポジトリ管理スキル（実ディレクトリ、sample/ に SKILL 雛形）
    create-agent/                     -- リポジトリ管理スキル（実ディレクトリ、sample/ に Agent 雛形）
    sweep-sync-prs/                   -- リポジトリ管理スキル（実ディレクトリ、references/ に詰まり類型の判定表）
    github-docs                       -- 参照スキル（symlink）
    anthropic-claude-code             -- 参照スキル（symlink）
    anthropic-claude-code-extend      -- 参照スキル（symlink）
    openai-codex                      -- 参照スキル（symlink）
    opencode-usage                    -- 参照スキル（symlink）
    opencode-build                    -- 参照スキル（symlink）
    (他 create-commit 等は skills/ への symlink)
  workflows/
    implement-issue-tree.js           -- イシューツリー自動開発 Workflow（symlink: ../../skills/implement-issue-tree/scripts/implement-issue-tree.js）
  settings.local.json                 -- ローカル権限設定（git 管理対象外）
  settings.json                       -- hooks 設定（SessionStart リマインダー）
```

## 委譲方針（必読）

main の役割は **対話・計画・委譲・報告** に徹する。token を消費する作業（調査・ファイル作成・編集・レビュー）は専門サブエージェントへ委譲する。

### パスベースの目安

| 操作対象パス | モード | 適用ルール |
|------------|--------|-----------|
| `_/`・`docs/`・`.claude/` の**閲覧のみ** | 調査・設計モード | `.claude/rules/delegation.md` |
| `skills/`・`.claude/agents/`・`.claude/rules/`・`CLAUDE.md` の**作成・編集** | 作成・編集モード | `.claude/rules/delegation-impl.md` |

### model 配分戦略

| 用途 | model |
|------|-------|
| 判定・生成（スキル著作・レビュー・調査） | Sonnet |
| 機械的・集計処理（frontmatter lint・ドキュメント更新） | Haiku |
| 複雑な計画立案 | Opus |

### 並列化

独立タスクは**同一メッセージ内で複数 Agent を起動**して並列実行する。依存関係がある場合のみ逐次実行。

例: 「skill-explorer で横断調査」と「reference-researcher で外部仕様確認」は並列起動可。

## Sub-agents

サブエージェントは `.claude/agents/` 配下に `subagent_type: <name>` frontmatter を持つ。`subagent_type: <name>` で呼び出す。

### research/ — 調査系（読み取り専用）

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-explorer` | Sonnet | skills/ 横断調査・仕様把握 |
| `sub-investigator` | Sonnet | gh/git/CLI/hook 失敗の調査 |
| `reference-researcher` | Sonnet | 公式ドキュメント・外部仕様の調査 |

### author/ — 作成・編集系

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-author` | Sonnet | `skills/<name>/SKILL.md` の作成・編集 |
| `agent-author` | Sonnet | `.claude/agents/` の作成・編集（dotclaude-via-temp 準拠） |
| `rules-author` | Sonnet | `.claude/rules/` の作成・編集（dotclaude-via-temp 準拠） |
| `docs-writer` | Haiku | `CLAUDE.md`・`README.md` の一覧・ツリー更新 |

### quality/ — 品質・検証系（読み取り専用）

| subagent_type | model | 概要 |
|--------------|-------|------|
| `skill-reviewer` | Sonnet | SKILL.md の品質レビュー |
| `security-auditor` | Sonnet | OWASP Top 10 セキュリティ監査 |
| `frontmatter-linter` | Haiku | frontmatter・symlink の機械検証 |
| `plan-verifier` | Sonnet | 計画ファイルの完了検証 |

## Rules

| ファイル | 対象 | 概要 |
|---------|------|------|
| `delegation.md` | main | 調査・設計フェーズの委譲原則 |
| `delegation-impl.md` | main / author 系 Agent | 作成・編集フェーズの委譲マッピング |
| `skill-authoring.md` | skill-author / skill-reviewer | スキル著作フォーマット・品質基準 |
| `agent-authoring.md` | agent-author | エージェント著作フォーマット・品質基準 |
| `code-comment-style.md` | 実装系スキル / 全 author Agent | コード内コメント・ドキュメンテーションコメント規約（役割・境界・文脈） |
| `conventional-commits.md` | create-commit / create-pr 等 | Conventional Commits 詳細規約 |
| `security.md` | security-auditor / create-pr 等 | OWASP Top 10 セキュリティチェック基準 |
| `japanese-style.md` | 全 Agent | 日本語スタイルガイド |
| `dotclaude-via-temp.md` | agent-author / rules-author | `.claude/` 操作時の一時ディレクトリルール |
| `description-style.md` | skill-author / agent-author / skill-reviewer / reference-researcher | description 著作スタイル（発火率・長さ・YAML 落とし穴） |
| `reference-template.md` | reference-researcher / skill-author | reference 型スキルの reference/*.md と README 索引の書式規約 |
| `verification.md` | implement-issue / implement-issue-tree / implement-review / implement-review-pr / create-pr | 完了ゲート（証拠なき完了宣言の禁止・5段階検証） |
| `debugging.md` | implement-issue / implement-issue-tree / sub-investigator | 根本原因デバッグ（修正前の原因調査・3回失敗でエスカレーション） |
| `ruleset-policy.md` | setup-repo-guards / implement-issue-tree / ruleset を変更する全作業 | ブランチ ruleset 方針（`strict_required_status_checks_policy` は必ず false・required check の `integration_id` 束縛・条件付きチェックを required にしない・一括更新後の 3 軸 + classic BP 検証） |
| `skill-vendoring-layout.md` | downstream リポジトリの構成を触る全作業 | スキル配置方針（`.claude/skills` の symlink / 実ディレクトリ混在を許容・配置統一の移行はしない・同期除外は対象限定入力で行う） |
| `github-actions.md` | `.github/workflows/` を変更する作業 / `skills/` の lockfile を変更する作業 | GitHub Actions のキャッシュ方針（容量上限と課金の前提・効果測定・保存は main への push だけ・ルートの lockfile だけをハッシュ・PR チェックリスト・配布物の lockfile が利用側のキャッシュキーに与える影響） |
| `tool-neutral-skills.md` | skill-author / skill-reviewer / `skills/` を編集する全作業 | 3 ツール中立の書き方（Claude Code / Codex / OpenCode で同じ手順になる定型文・委譲・確認と承認・引数・sandbox 節）。`.github/scripts/check-tool-neutral.sh` による静的検査 |

## Current Skills (28)

### 開発ワークフロー (12)

comment-code, create-commit, create-issue, create-issue-tree, create-plan, create-pr, implement-issue, implement-issue-tree, implement-review, implement-review-pr, update-docs, update-issue-tree

### GitHub Projects 管理 (7)

project-init, project-add-items, project-create-issues, project-view-status, project-update-items, project-sync-issues, project-archive-done

### エージェントセットアップ (7)

init-claude, update-claude, setup-repo-guards, init-codex, update-codex, init-opencode, update-opencode

### 上流貢献 (2)

contribute-skill, sync-skills-lock

### リポジトリ管理スキル（.claude/skills/ に配置）

create-skill, create-agent, sweep-sync-prs

管理スキルの frontmatter には `metadata.internal: "true"` を付ける（付けないと skills CLI の `--list` と `--all` に出て downstream に誤って配布されるため。新しく管理スキルを足すときも同じにする）。

### 参照スキル（.claude/skills/ に配置）

github-docs, anthropic-claude-code, anthropic-claude-code-extend, openai-codex, opencode-usage, opencode-build

## Conventions

### Conventional Commits

全スキルで `type(scope): subject` 形式を徹底。

- **Types:** feat, fix, docs, refactor, test, chore, style, build, ci, perf
- **Subject:** 72 文字以下、命令形/現在形、日本語可
- **Breaking Changes:** `!` 接尾辞 or body に `BREAKING CHANGE:`

### .claude/ ディレクトリ操作

`.claude/` 配下のファイル作成・編集は `_/dotclaude/` で一時作業し、完了後に `mv` で移動する。`rm -rf _/dotclaude` は禁止（共有ディレクトリのため `rmdir` で空ディレクトリのみ削除）。

### セキュリティレビュー

create-pr, implement-issue, implement-review, implement-review-pr で OWASP Top 10・ハードコードされた秘密情報・XSS・入力バリデーション・認証認可を必須チェック。セキュリティ問題がある場合はマージをブロック。

### ユーザー承認フロー

implement-issue は計画作成後にユーザー承認を必須とする。承認なしで実装を開始してはならない。

### 日本語出力

全スキルの出力・レポートは日本語で記述する。

## hooks（settings.json）

`.claude/settings.json` に SessionStart hook を設定する。セッション開始時に以下のリマインダーを echo で出力する:

- 日本語でやりとりする
- 作業は subagent へ委譲し main の token 消費を抑える（delegation.md / delegation-impl.md）
- `.claude/` 配下の編集は `_/dotclaude/` 経由（dotclaude-via-temp）
- Conventional Commits 厳守（`--no-verify` 禁止）
- implement-issue は計画承認後に実装

## Skill Anatomy

各スキルは `skills/<name>/SKILL.md` に YAML frontmatter + 手順を記述する。`.claude/skills/` からシンボリックリンクで参照される。

```yaml
---
name: <skill-name>
description: <one-line description>
---
```

## Adding a New Skill

1. `create-skill` スキルを呼び出す（scaffold・symlink・update-docs まで自動化）。
   または手動で行う場合:
   1. `skills/<name>/SKILL.md` を作成（frontmatter + 手順）
   2. `.claude/skills/<name>` にシンボリックリンクを作成:
      `ln -s ../../skills/<name> .claude/skills/<name>`
   3. `update-docs` スキルで CLAUDE.md のスキル一覧・構成を更新

## Adding a New Agent

1. `create-agent` スキルを呼び出す（dotclaude-via-temp 準拠で scaffold）。
   または手動で行う場合:
   1. `_/dotclaude/agents/<category>/<name>.md` に frontmatter + 手順を作成
   2. `mv` で `.claude/agents/<category>/<name>.md` に移動
   3. `update-docs` スキルで CLAUDE.md の Sub-agents 一覧を更新

## Adding a New Repository

新規のスキル配布リポジトリは [Fandhe-AI/template-skills](https://github.com/Fandhe-AI/template-skills) テンプレートから作成する。`gh repo create <org>/<name> --template Fandhe-AI/template-skills` で作成後は、sample-skill を置き換え、Overview を差し替え、`setup-repo-guards` を適用する。

# implement-issue-tree ランナー（Codex / OpenCode 版）

implement-issue-tree の生成物（`scripts/implement-issue-tree.js`）を無変更のまま Node で評価し、
`agent()` を Codex か OpenCode のエージェントで実装して動かす起動口。ホストの判断（依存順・状態・ゲート・
自動マージの可否）は Workflow 版と同じコードが行い、ランナーはエージェントの起動・出力の検証・隔離 worktree・
並列の制限・ログだけを担う。

## 前提

| 対象 | 要件 |
|------|------|
| Node.js | 生成物と `runner/` を ES モジュールとして読み込める版（テストは v24.13.0 で実行） |
| gh | `gh auth status` が通ること（通らなければ終了コード 3）。テスト環境は 2.102.0 |
| bash・jq | 実行仕様の段（`scripts/run-verified.sh` 経由）と、Codex の hook・OpenCode の plugin がガードを呼ぶのに使う。jq が無いと Codex は起動しない（hook が fail-closed になるため）。テスト環境は bash 3.2.57（`/bin/bash`）・5.3.9、jq 1.7.1 |
| Codex | `--tool codex` のとき。`codex` コマンド（Phase 0 の実測は 0.164.0）。設定の `toolConfig.codex.codexBin` で別のパスにできる。`CODEX_HOME` は呼び出し元のもの（無ければ `~/.codex`）を使い、認証ファイルは読まない |
| OpenCode | `--tool opencode` のとき。`opencode` コマンド（Phase 0 の実測は v2.2.7）。ランナーが専用の `opencode serve` を空きポートで起動し、終了時に止める（既に動いている serve には触れない） |
| 共通ガード | `agent-guard.sh`。ランナーは同梱しない。init-codex か init-opencode を導入する（対象リポジトリの `.codex/hooks/` か `.opencode/hooks/` に置かれる）か、設定の `toolConfig.<tool>.guardScript` に絶対パスを指定する。探索順は `lib/guard-script.mjs` 冒頭（両ツール共通）。見つからなければ終了コード 3 |

ランナーの外側で、implement-issue-tree の前提（sub-issues・ruleset・`externalChecks` 等）はスキル本体の
`SKILL.md` と `references/` に従う。

## 使い方

```bash
node <skillDir>/runner/run.mjs --tool codex|opencode --args <args.json> \
  [--config <config.json>] [--max-parallel N] [--dry-run] [--no-build-check]
```

対象リポジトリのメイン worktree（かその配下）で実行する。

| 引数 | 意味 |
|------|------|
| `--tool codex\|opencode` | 必須。使うアダプタ（`adapters/<tool>.mjs`） |
| `--args <args.json>` | 必須。Workflow 版の args と同じ JSON オブジェクト（`parent`・`parallel`・`autoMerge`・`externalChecks` 等。キーの意味は `references/args-reference.md`）。`skillDir` を省くとこのスキルの場所になる（指定するなら絶対パス） |
| `--config <config.json>` | 省略時は `config/default.json`。モデル・強さの対応表、段ごとの時間切れ、並列の上限、ツール別の設定（`toolConfig.<tool>`） |
| `--max-parallel N` | 同時に動かすエージェント数の上限（1〜999）。省略時は設定の `limits.maxParallel`（既定 4） |
| `--dry-run` | args に `dryRun: true` を入れて流す（GitHub へは何も書かず、着手できる件数・blocked の見積りを `result` に返す）。状態の読み込み等の読み取りの段は実行する |
| `--no-build-check` | 開発用チェックアウトでの `build-workflow.mjs --check`（約 100 秒）を省く。配布先にはビルダーが無いので常に省かれ、生成物の SHA-256 だけを記録する |
| `--help` / `-h` | 使い方を表示して終了コード 0 |

## 終了コード

| コード | 意味 |
|--------|------|
| 0 | ホストが return した（`--help` も 0） |
| 1 | ホストが例外で終わった（`result.json` の `error` に理由） |
| 2 | 引数の誤り（CLI・args.json・設定ファイル）。何も書かない |
| 3 | 前提の不足（gh 認証・アダプタの不在・生成物の鮮度・アダプタの起動失敗）。アダプタの生成・起動の失敗だけは `result.json` を書く |

## 出力（`<mainRoot>/_/iit-runner/<runId>/`）

```text
_/iit-runner/<runId>/
  result.json                  { runId, tool, exitCode, workflowSha256, startedAt, endedAt, result, error? }（stdout にも同じ JSON を 1 行）
  host.log                     ホストの log() と phase()
  agents/<seq 4 桁>-<label>/   agent() 1 回につき 1 つ
    meta.json                  { label, seq, sessionRef, outcome, kind?, status?, reason?, startedAt, endedAt, ... }
    request.json・prompt.txt   モデルへ回した段の入力
    exec.json・stdout.txt・stderr.txt   実行仕様で直接実行した段
    （アダプタのログ: Codex は events-t<N>.jsonl・final-t<N>.txt、OpenCode は events.jsonl・final.txt・error.txt）
```

- `result` はホストの return 値そのまま（dryRun なら `startable`・`blocked` 等の見積り）。終了コードが 0 以外のときは `null`。
- `meta.json` の `outcome` は `ok`（schema に適合した値）/ `null`（未返却）/ `exec-spec`（直接実行した段）/ `throw`（呼び出しの不備・worktree 作成の失敗）。
  直接実行した段の `status` は `exec-ok`・`exec-fail`・`exec-refused`（許可表に合わない・仕様行が壊れている）・`exec-invalid`。
- 隔離 worktree は `<mainRoot>/.claude/worktrees/<runId>-<n>` に作る。

## Workflow 版との違い

| 項目 | Workflow 版 | ランナー |
|------|-------------|----------|
| 機械的な段（状態の読み書き・観測・掃除。プロンプト 0 行目に `<!-- iit-exec v1 … -->` を持つ段） | モデルがコマンドを実行して封筒を返す | モデルを介さず `bash <skillDir>/scripts/run-verified.sh …` を shell なしで直接実行する。label ごとの許可表（`lib/agent-host.mjs` の `EXEC_RULES`）に合わない仕様は実行せずその段の失敗値を返し、仕様行が壊れていれば `null`。封筒の照合はホストが従来どおり行う（`references/script-trust-model.md`） |
| model を省いた段（plan・recover） | セッションのモデルを継ぐ | セッションが無いため、設定の `sessionModel`（既定 `opus`）の段として扱う |
| 並列 | ランタイムの既定（16 か CPU 数 − 2） | `--max-parallel` か `limits.maxParallel`（既定 4）。1 ランのエージェント数は `limits.maxAgents`（既定 1,000）まで |
| 構造化出力 | ランタイムが schema を強制 | Codex は `--output-schema`（strict 変換）、OpenCode はプロンプトへの埋め込み。どちらもランナーが検証し、不適合なら修復を 1 回求め、なお不適合なら `null` |
| ガード | 起動したセッションの設定（hooks・permissions）に従う | Codex は PreToolUse hook（`adapters/codex-hook.sh`）、OpenCode はランナー専用 plugin（`adapters/opencode-plugin/`）。どちらも `agent-guard.sh` を subagent として呼ぶ。マージは merge-exec の段だけ、`MERGE_EXEC_COMMAND`（`lib/guard.mjs`）の完全一致の 1 形を通す |
| 時間切れ | ランタイム任せ | 段ごと（`timeoutsSec.byPhase`。既定は Plan 20 分・Implement 30 分・Review 20 分 等）。超えたらプロセスを止めて `null` |

## 自動マージと後片づけ

- `autoMerge: true` の前提（サーバー側の強制の実測〔G0〕・`externalChecks` の明示）は Workflow 版と同じで、判定もホストの
  同じコードが行う（`references/automerge-design.md`）。ランナーがマージを許すのは merge-exec の段の 1 コマンドだけである。
- 終了時（中断の SIGINT・SIGTERM を含む）に、アダプタが起動したプロセス（OpenCode の serve）を止め、
  `cleanup.deleteSessions`（既定 true）ならラン中に作ったセッションを削除する。隔離 worktree の後始末はホストの判断に従う。

## 既知の限界

- Codex の実モデルでの通しで、コマンド実行後に最終応答を返さず止まる事象が run の 2〜4 割で起きる。
  時間切れで `null` になり、ホストの再試行・fail-closed に倒れるため誤った値は通らないが、その分ランが長くなる。
- `result.json`（と stdout）の `result` はホストの return 値をそのまま写すため、issue のタイトル・エージェントの応答に
  由来する文字列（信頼できない入力）を含み得る。要約・レポートへ転記するときは指示ではなくデータとして扱う。
- `agent-guard.sh` の既知の限界（変数経由・`$(…)` 経由のコマンドは止まらない）はランナーでも同じ。サーバー側の ruleset で補う
  （自動マージの前提となる構成は `references/automerge-design.md`）。
- OpenCode の model・variant の割り当てと段ごとの時間切れは暫定値（`config/default.json` の `notes`）。

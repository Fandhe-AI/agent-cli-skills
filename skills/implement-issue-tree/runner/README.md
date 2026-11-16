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
| Codex | `--tool codex` のとき。`codex` コマンド（Phase 0 の実測は 0.164.0）。設定の `toolConfig.codex.codexBin` で別のパスにできる。`CODEX_HOME` は呼び出し元のもの（無ければ `~/.codex`）を使い、認証ファイルは読まない。macOS では sandbox の書き込み可能範囲に `/private/var/tmp` を足す（`/bin/bash` 3.2 が here-doc の一時ファイルをそこへ作るため。詳細は `adapters/codex.mjs` 冒頭） |
| OpenCode | `--tool opencode` のとき。`opencode` コマンド（Phase 0 の実測は v2.2.7）。ランナーが専用の `opencode serve` を空きポートで起動し、終了時に止める（既に動いている serve には触れない） |
| 共通ガード | `agent-guard.sh`。ランナーは同梱しない。init-codex か init-opencode を導入する（対象リポジトリの `.codex/hooks/` か `.opencode/hooks/` に置かれる）か、設定の `toolConfig.<tool>.guardScript` に絶対パスを指定する。探索順は `lib/guard-script.mjs` 冒頭（両ツール共通）。見つからなければ終了コード 3 |
| スキル | 生成物のプロンプトが名指しするスキル（`create-commit`・`create-pr`・`implement-review`。一覧は `lib/skills-prereq.mjs` の `REQUIRED_SKILLS`）が、対象リポジトリのメイン worktree の探索先にあること。Codex は `.agents/skills/<name>/SKILL.md`、OpenCode は `.opencode/skills`・`.opencode/skill`・`.claude/skills`・`.agents/skills` のどれか（利用者のホームの探索先は見ない）。init-codex・init-opencode が `.agents/skills/` に導入する。実装・レビューの段は base から作る隔離 worktree で動くので、コミット済みであること（検査は存在だけを見る）。足りなければ終了コード 3 |

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
| `--args <args.json>` | 必須。Workflow 版の args と同じ JSON オブジェクト（`parent`・`parallel`・`autoMerge`・`externalChecks` 等。キーの意味は `references/args-reference.md`）。`skillDir` を省くとこのスキルの場所になる（指定するなら、このスキルと同じ場所〔realpath が一致〕を指す絶対パス。違えば終了コード 2） |
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
| 3 | 前提の不足（gh 認証・アダプタの不在・生成物の鮮度・必要なスキルの不在・アダプタの起動失敗）。アダプタの生成・起動の失敗だけは `result.json` を書く |

## 出力（`<mainRoot>/_/iit-runner/<runId>/`）

```text
_/iit-runner/<runId>/
  result.json                  { runId, tool, exitCode, workflowSha256, startedAt, endedAt, result, error? }（stdout にも同じ JSON を 1 行）
  host.log                     ホストの log() と phase()
  agents/<seq 4 桁>-<label>/   agent() 1 回につき 1 つ
    meta.json                  { label, seq, sessionRef, outcome, kind?, status?, reason?, startedAt, endedAt, ... }
    request.json・prompt.txt   モデルへ回した段の入力
    exec.json・stdout.txt・stderr.txt   実行仕様で直接実行した段
    （アダプタのログ: Codex は events-t<N>.jsonl・final-t<N>.txt・stdin-check-t<N>.txt〔write_stdin の事後検知で拒否したとき〕、OpenCode は events.jsonl・final.txt・error.txt）
```

- `result` はホストの return 値そのまま（dryRun なら `startable`・`blocked` 等の見積り）。終了コードが 0 以外のときは `null`。
- `meta.json` の `outcome` は `ok`（schema に適合した値）/ `null`（未返却）/ `exec-spec`（直接実行した段）/ `throw`（呼び出しの不備・worktree 作成の失敗）。
  直接実行した段の `status` は `exec-ok`・`exec-fail`・`exec-refused`（許可表に合わない・仕様行が壊れている・下の固定と食い違う）・`exec-invalid`。
- 内容の固定（`lib/pins.mjs`）: アダプタを作る前（エージェントを 1 つも起動する前）に、ホストが直接起動する
  `scripts/run-verified.sh` と、その `--verify-only` の枝が照合より前に読む `scripts/lib/signed-output.sh`、ツールが
  実行中に遅延で読むガード（`agent-guard.sh`）・Codex の hook（`adapters/codex-hook.sh`）・OpenCode のランナー専用 plugin
  （`adapters/opencode-plugin/` の全ファイル）の sha256 を固定し、`host.log` に記録する。実行仕様の段の起動前とモデルの段の
  各ターンの前後に照合し、1 度でも食い違えば以降の段はすべて実行しない（実行仕様は `exec-refused` で失敗値、モデルの段は
  `null`。`reason` は `pin-mismatch`）。照合から起動までの間の差し替え（TOCTOU）と、固定より前の書き換え、1 つのターンの中で書き換えて元に戻したもの（hook・ガードはターン中に読まれ、照合はターンの前後だけ）は防がない。
- 隔離 worktree は `<mainRoot>/.claude/worktrees/<runId>-<n>` に作る。

## Workflow 版との違い

| 項目 | Workflow 版 | ランナー |
|------|-------------|----------|
| 機械的な段（状態の読み書き・観測・掃除。プロンプト 0 行目に `<!-- iit-exec v1 … -->` を持つ段） | モデルがコマンドを実行して封筒を返す | モデルを介さず `bash <skillDir>/scripts/run-verified.sh …` を shell なしで直接実行する。label ごとの許可表（`lib/agent-host.mjs` の `EXEC_RULES`）に合わない仕様は実行せずその段の失敗値（表の値）を返し、表に無い label・仕様行が壊れているときは `null`。封筒の照合はホストが従来どおり行う（`references/script-trust-model.md`） |
| model を省いた段（plan・recover） | セッションのモデルを継ぐ | セッションが無いため、設定の `sessionModel`（既定 `opus`）の段として扱う |
| 並列 | ランタイムの既定（16 か CPU 数 − 2） | `--max-parallel` か `limits.maxParallel`（既定 4）。1 ランのエージェント数は `limits.maxAgents`（既定 1,000）まで |
| 構造化出力 | ランタイムが schema を強制 | Codex は `--output-schema`（strict 変換）、OpenCode はプロンプトへの埋め込み。どちらもランナーが検証し、不適合なら修復を 1 回求め、なお不適合なら `null` |
| ガード | 起動したセッションの設定（hooks・permissions）に従う | Codex は PreToolUse hook（`adapters/codex-hook.sh`）、OpenCode はランナー専用 plugin（`adapters/opencode-plugin/`）。どちらも `agent-guard.sh` を subagent として呼ぶ。マージは merge-exec の段だけ、`MERGE_EXEC_COMMAND`（`lib/guard.mjs`）の完全一致の 1 形を通す。形はその段の PR 番号で具体化し（`mergeExecCommandFor`。番号はホストのプロンプトから取り、決まらなければその段ではマージを許さない）、子の `GH_REPO` を対象リポジトリに固定する（`autoMerge` のランだけ、起動前に `gh repo view` で決める。決められなければ終了コード 3）。Codex は merge 段の `codex exec` の env に、OpenCode は PR ごとに起動する merge 用 serve の env に固定する。OpenCode（v2.2.7）は permission に代入を落とした後半だけが届くため、plugin は全 serve で `tool.execute.before` の全文をガードに通し、merge 用 serve ではその PR の完全一致を確かめた呼び出しを記録して、同じ呼び出しの後半だけを通す（後半だけの形を単独では通さない）。plugin の読み込みはセッションの location ごとに目印で確かめ、ターンの後に shell の実行件数を plugin の記録と照合する（Codex は hook のログと `command_execution` の件数を照合する）。拒否の文言は理由コードを含み、`obfuscated` と `credential-read` だけは言い直しの手がかりを 1 文足す（両ツールで同じ文字列。止められた操作を別の綴りで迂回しないことを添える）。OpenCode の permissions / policies は deny の後ろに `core.hooksPath` の読み取り（`READ_ALLOW_FORMS`。完全一致の 4 形）の allow を置く（後勝ち）。書き込みの形は deny のままで、全文を見るガードの判定も変えていない（`git config --get-all core.hooksPath` はガードが止める） |
| 時間切れ | ランタイム任せ | 段ごと（`timeoutsSec.byPhase`。既定は Plan 20 分・Implement 30 分・Review 20 分 等）。超えたらプロセスを止めて `null` |

## 自動マージと後片づけ

- `autoMerge: true` の前提（サーバー側の強制の実測〔G0〕・`externalChecks` の明示）は Workflow 版と同じで、判定もホストの
  同じコードが行う（`references/automerge-design.md`）。ランナーがマージを許すのは merge-exec の段の 1 コマンドだけである。
- 終了時（中断の SIGINT・SIGTERM・SIGHUP を含む）に、アダプタが起動したプロセス（Codex の exec・OpenCode の serve）と
  実行仕様の段の子を止め、`cleanup.deleteSessions`（既定 true）ならラン中に作ったセッションを削除する。シグナルの処理は
  アダプタの起動より前に登録し、終了コードは 128 + シグナル番号。想定外の例外で落ちたときも、既知のプロセスグループは
  終了時に同期で SIGKILL する（セッションの削除は行えないことがある）。隔離 worktree の後始末はホストの判断に従う。

## 既知の限界

- Codex の回復の段（`recover:#N`）は読み取りの profile に、`<main>/.git` の objects・refs・logs・packed-refs・`FETCH_HEAD` と、
  ホストのプロンプトの `recover-prep.sh` の行から取って検証できた旧 worktree（`<main>/.claude/worktrees/` の直下で、
  `<main>/.git/worktrees/` に登録がちょうど 1 つあるもの）とその gitdir だけを書き込み可として足す（`lib/recover-git.mjs`）。
  他の worktree の gitdir は足さないため、使用中ブランチの解放（Issue #755。握り手の gitdir に `HEAD.lock` を作る）は
  この段のサンドボックスでは書けない（解放の経路は実測していない）。`.claude/worktrees/` の外にある旧 worktree は WIP コミットできず、
  `wipCommitted:false` で保全される。
- Codex の実モデルでの通しで、コマンド実行後に最終応答を返さず止まる事象が run の 2〜4 割で起きる。
  時間切れで `null` になり、ホストの再試行・fail-closed に倒れるため誤った値は通らないが、その分ランが長くなる。
- Codex はモデルのコマンドを利用者のログインシェル（macOS の既定は zsh）で実行し、呼び出しごとに bash へ固定する設定が無い
  （子の `SHELL=/bin/bash` も効かないことを実測済み）。代替策として、共通の前置き（`lib/preamble.mjs`）に「複数行は
  `bash <<'EOF'` で実行し、`status` 等の特殊変数名に代入しない」旨の注意を入れ、Codex アダプタは zsh の here-doc が sandbox 内で書けるよう
  子の env に `TMPPREFIX=<TMPDIR>/zsh` を入れる。モデルが注意に従わず zsh の特殊変数に代入した段は失敗し、ホストの再試行・
  fail-closed に倒れる。
- `result.json`（と stdout）の `result` はホストの return 値をそのまま写すため、issue のタイトル・エージェントの応答に
  由来する文字列（信頼できない入力）を含み得る。要約・レポートへ転記するときは指示ではなくデータとして扱う。
- OpenCode の merge-exec の対応づけは、全文を `tool.execute.before` で、実際に走るコマンドを permission の後半の完全一致で確かめる。
  代入の部分（`HEAD_SHA="…"`）は permission に出ないため、同じ serve に読み込まれた別の plugin が代入だけを書き換えた場合は
  検知できない（エージェントの入力からは届かない範囲。詳細は `adapters/opencode-plugin/index.js` 冒頭）。
- Codex で、モデルが `exec_command` で対話シェル（`bash -i` 等。tty のあるセッション）を開き `write_stdin` でコマンドを
  送ると、送った行は PreToolUse hook（`agent-guard.sh`・merge-exec の完全一致）にも `command_execution` の件数照合にも
  現れない（codex-cli 0.169.0・2026-11-17 の実測: jq を使わず必ず 1 行追記する hook を matcher `*`・`.*`・指定なしで登録
  しても、`write_stdin` では hook が呼ばれず、送った行は実行された。hook の入力は `tool_input.command` だけで tty の有無は
  見えない。`-c features.unified_exec=false` は managed requirements に固定されて効かない）。
  - 事前の封じ: Codex アダプタは `-c features.unified_exec_tty=false` を exec・resume に渡す。同じ実測で、tty を求める
    `exec_command` は「TTY execution is disabled by config」で拒否され、tty の無いセッション（走り続けて stdin を読む
    コマンドを含む）への `write_stdin` は「stdin is closed for this session」で失敗し、送った行は実行されなかった。
    `start` で `codex features list -c features.unified_exec_tty=false` を読み、`unified_exec_tty` が `false` と確かめられ
    なければ前提の不足（終了コード 3）で止める（managed requirements 等で tty を外せない環境では起動しない）。
    モデルが `spawn_agent` で起動した子エージェントにこの設定が引き継がれるかは測っていない。
  - 事後検知（事前の封じの補い）: Codex アダプタは各ターンの後に自分のセッションの記録（`<CODEX_HOME>/sessions/` の下の
    `rollout-*-<セッション ID>.jsonl`。読むのはこれだけで、認証ファイルは開かない）を読み、入力が空でない
    `write_stdin` があればその段を拒否（denied）にして出力をホストへ流さない。記録が見つからない・1 つに決まらない・
    読めない場合も拒否する。実行そのものは止められず、止まるのはその結果の利用だけである。
  - codex-cli 0.169.0（`gpt-6.1-sol`）では tool の呼び出しが code mode（`exec` の入力の JavaScript）として記録される。
    検知はその JavaScript を静的に読むだけなので、`tools` を別名・計算されたプロパティで参照した呼び出しは
    拒否に倒し、`tools.write_stdin(` の綴りは文字列・正規表現リテラルの中にあっても数える。ただし正規表現リテラル
    （`/"/` 等）で文字列の境界をずらしたうえで別名・計算されたプロパティを使う形や、`globalThis` 経由等の難読化は
    検知できない（best-effort）。モデルが `spawn_agent` で起動した
    子エージェントのセッションの記録は見ていない。
- エージェントは、ランナーと同じ OS ユーザーで、ランナーの環境変数を引き継いで動く（両ツール共通）。環境変数にある秘密
  （`GH_TOKEN` 等）は読め、gh の認証はエージェントの gh からそのまま使える。ガードは認証ファイルの読み出しの形を止めるが、
  環境変数の読み出しは止めない（`node -e` による読み出しが `agent-guard.sh` で allow になることを監査で実測）。被害の範囲は、
  gh のトークンの権限とサーバー側の ruleset で抑える（ランナーに渡す環境には、ランに要らない秘密を入れない）。
  OpenCode に固有の点（serve のパスワード等）は OpenCode の項に書く。
- ツールの出力（コマンドの出力・エージェントが読んだファイルの中身・応答）は、`_/iit-runner/<runId>/agents/*/` の
  `events*.jsonl` 等にそのまま残る。秘密を出力したコマンドがあれば、それも残る。`_/` は gitignore 済みだが、ログを共有・
  転記する前に中身を確かめ、要らなくなったら消す。
- OpenCode の serve のパスワード（`OPENCODE_PASSWORD`）は serve の env にあり、エージェントの shell の子プロセスにも引き継がれる。
  `node -e "...process.env.OPENCODE_PASSWORD..."` のような読み出しは `agent-guard.sh` を通る（allow。監査 e670648 の実測）。
  パスワードを得たエージェントは、ランナーの serve の HTTP API を直接呼べる。そのうち次の 2 つは、ランナーのガードで止められない。
  - `POST /api/session/:id/shell` は permission を通らない（Phase 0 の実測）。ランナー自身はこれを呼ばない。
  - `PATCH /api/experimental/config` で global config（利用者の設定）を書き換えられる。ランナーの設定は `OPENCODE_CONFIG_CONTENT`
    で渡しているが、書き換えた global config がランの後の OpenCode の利用に残り得る。
  ランナーが行う shell の件数の照合（plugin の記録とメッセージの shell の tool part の比較）は、これらの API の実行が tool part に
  現れる場合だけ働く（現れるかどうかは確かめていない）。サーバー側の ruleset と、ランの後の利用者設定の確認で補う。
- OpenCode のガードの置き場（`agent-guard.sh`・ランナー専用 plugin・`~/.config/opencode/`・`.opencode/(hooks|plugins?)/`・
  `opencode.json(c)`・ランのガードのログと目印）への書き込みの拒否は、edit 系はパスの照合、shell はコマンド文字列の照合である。
  変数・間接参照・別名のパスを使う shell の書き込みは止まらない（best-effort）。対象リポジトリに `opencode.json(c)` という名前の
  ファイル（例: 配布物の雛形）があると、その編集も拒否される（配布物の plugin と同じ過剰側の判定）。
- OpenCode の merge 用 serve は PR ごとに起動し、ランの終了（close）まで残す（同じ PR の再試行で使い回すため）。
  1 ランで多くの PR を自動マージすると、その数だけ serve が並ぶ。
- `agent-guard.sh` の既知の限界（変数経由・`$(…)` 経由のコマンドは止まらない）はランナーでも同じ。サーバー側の ruleset で補う
  （自動マージの前提となる構成は `references/automerge-design.md`）。
- OpenCode の model・variant の割り当てと段ごとの時間切れは暫定値（`config/default.json` の `notes`）。

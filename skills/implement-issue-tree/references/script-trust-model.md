# スクリプト実行の信頼モデル

本書は implement-issue-tree スキルの一部。全体は ../SKILL.md 参照。

決定的な手順（`gh` / `git` / `du` 等のコマンド列と分類規則）をプロンプトの文章から切り出し、スキル同梱のスクリプトにして、サブエージェントには「コマンドを実行して出力を転記する」ことだけをさせる設計（Issue #603）の、**何を防ぎ、何を防がないか**を書く。第 1 弾の対象は読み取り専用の測定 2 本（残置 worktree のバイト測定・実ディスク空き容量）、第 2 弾の対象は monitor の観測と待機（`observe-pr.sh`）で、いずれも安全判定（マージ・push・削除）を含まない。第 3 弾の対象は base 取り込みと push の検証（`base-merge.sh`、`lib/push-verify.sh`）と、push 直後の確認（`observe-pr.sh --mode push`）で、**base-merge.sh は push を実行する最初のスクリプト**である（下の「第 3 弾」節）。第 4 弾の対象は pr-create と fix の base 取り込み・push・PR 作成（`pr-push.sh`）と、ラン開始時のハッシュ予検査（`run-verified.sh --verify-only`）、観測スクリプトの `--repo` である（下の「第 4 弾」節）。安全判定を含むスクリプトを足す弾は、本書の前提を満たすか、満たさない部分を別の機構で補うことを、その弾の PR で示す。

## 構成

| 要素 | 役割 |
|------|------|
| `args.skillDir` | スキルディレクトリ（`scripts/` の 1 つ上）の絶対パス。人間（起動手順）が渡す。形式だけをホストが検証する |
| `scripts/run-verified.sh` | 実行前にスクリプトの SHA-256 を照合する launcher。`bash "<skillDir>/scripts/run-verified.sh" <sha256> <name>.sh …` で起動する（実行ビットに依存しない） |
| `scripts/measure-residual-bytes.sh` / `measure-free-disk.sh` | 測定本体。入力はパスの一覧（標準入力）または 1 件（引数）。出力は 1 行の封筒 |
| `scripts/observe-pr.sh` | monitor の観測本体（第 2 弾）。入力は PR 番号・base・branch・issue・App slug（引数）。モードは `pr` / `checks` / `required` / `reviews` / `threads` / `threads-detail` / `push`（第 3 弾）。出力は 1 行の封筒（`threads-detail` だけは外部由来の自由文を含む非信頼データで、封筒ではない）。`--wait` は有界の待機 |
| `scripts/base-merge.sh` | 自動 base 取り込みの本体（第 3 弾）。入力は PR 番号・branch・base・期待 owner/repo（引数）。**封筒を使わない**。出力の最後の 1 行は `BASE_MERGE_RESULT {…}`（キーは `BASE_MERGE_SCHEMA` と同じ） |
| `scripts/pr-push.sh` | pr-create と fix の起点の確立・base 取り込み・push・PR 作成（第 4 弾）。モードは `prepare` / `push` / `pr`。**封筒を使わない**。出力の最後の 1 行は `PR_PUSH_RESULT {…}` |
| `scripts/state.sh` | 状態ファイル（`_/issue-trees/<親>.json`）の書き込み（第 5 弾）。モードは `merge` / `init` / `hw-max` / `hw-set`。入力は標準入力の 1 行 JSON と引数。**封筒を使わない**。出力の最後の 1 行は `STATE_RESULT {"ok":…}` |
| `scripts/merge-gate.sh` | merge-exec のマージ直前の読み取り専用検証（第 6 弾。G0 = サーバー側強制の実測と、チェック・未解決スレッド・mergeable・外部チェックの再検証）。入力は PR 番号・base・期待 sha・外部チェックの宣言（引数）。**封筒を使う**: payload は判定語（`verdict`。merge-exec の reason と同じ語彙）・段階・固定語の detail・整数の件数・40 桁 16 進の HEAD sha だけ。**マージの実行は含まない** |
| `scripts/lib/signed-output.sh` | 封筒の組み立て（`so_emit`）。sha256 の入力の定義はここと `verifySignedOutput` が共有する |
| `scripts/lib/push-verify.sh` | push の前後でリモート head を突き合わせる共通部（`pv_push_verified`。第 3 弾）。`base-merge.sh` が使い、以降 pr-create の push と fix の push 検証も同じ部品へ移す |
| 生成物 `implement-issue-tree.js` の `SCRIPT_SHA256` | ビルダーが埋め込む期待ハッシュ。開発ファイルには置換前の目印を書き、`build-workflow.mjs` が置換する |
| `verifySignedOutput`（ホスト） | 転記された封筒を再計算して照合する |

実行の流れ: ホストが nonce を決めてコマンドを組み立てる → サブエージェントが 1 回の Bash 呼び出しで実行する → launcher が期待ハッシュと照合して起動する → スクリプトが `{nonce, payload, sha256}` を 1 行で出す → エージェントがそれを StructuredOutput へ転記する → ホストが nonce と sha256 を再計算して照合し、通ったときだけ payload を使う。

封筒の `sha256` は `SHA-256(nonce + "\n" + payload の正規形)`。正規形はキー昇順・空白なしの JSON で、payload は整数と ASCII の固定文字列だけにする（`jq` の数値表記やエスケープの差に依存しないため、スクリプトは `printf` で直接組み立てる）。

payload には**入力の束縛** `inputSha256` を入れる。残置バイトは標準入力のパス列（末尾の改行 1 つを除く）、空き容量は対象パスの SHA-256 で、ホストは自分が送った値（`sha256Hex(パス列)`）から再計算して `verifySignedOutput` の第 3 引数で照合する。nonce は「どの呼び出しの出力か」を、`inputSha256` は「ホストが送った入力を測った出力か」を結び付ける。nonce は `boundaryNonce` に**呼び出し連番**を含めて作り、同じ対象を何度測っても呼び出し・再試行ごとに異なる（連番を含めないと同じパスの測定は同じ nonce になり、前回の封筒を流用しても受理される。PR #611 codex P1）。

## 何を防ぐか

| 事象 | 検出の仕組み |
|------|-------------|
| エージェントの**転記ミス**（数値の取り違え・桁落ち・項目の脱落） | ホストの sha256 再計算が一致しない → 破棄して有界に再測定（既存の「転記失敗は別エージェントで再測定」と同じ扱い） |
| **別の呼び出しの出力の流用**（前回の結果の使い回し） | nonce は呼び出しごとにホストが決める。流用した封筒は nonce が一致しない |
| **測定を実行せず値を推測で作った**（sha256 を合わせずに返した） | 値を作っても sha256 が一致しない（計算するには nonce と payload の正規形を使った SHA-256 が要る。うっかり省いた・推測で埋めた場合を検出する。意図して計算する者は下の「防がない」） |
| **送った入力と違うものを測った**（コマンド中のパスを 1 文字打ち間違えた・一部を省いた） | payload の `inputSha256` がホストの送った入力の SHA-256 と一致しない。件数が同じでも拒否される（`count` 照合だけでは過小な値が通った穴） |
| **Workflow とスクリプトの版ずれ**（同期が片方だけ届いた・古いコピーが残った） | launcher が期待ハッシュと不一致で起動しない（exit 3）。出力が無いので上と同じ測定失敗になる |
| スクリプトの**書き換え**（スキルディレクトリ内） | 同上。スクリプト本体と `scripts/lib/*.sh` のバイト列を対象にするので lib の書き換えも検出する |
| **入力のシェル再評価**（パスに `$(…)`・`;`・バッククォート） | スクリプトは `eval` を使わず、変数をすべてクォートし、許可文字集合（英数字・`/`・`-`・`_`・`.`・半角スペース）外のパスは `du` に渡さず `err` に数える |
| **実行場所の取り違え**（相対パスが worktree 内のコピーに解決される） | ホストが組み立てるコマンドの実行場所は `args.skillDir`（絶対パス）で決まり、相対パスの `skillDir` は受理しない。launcher は自分と同じディレクトリから名前だけでスクリプトを解決し、パス区切りと `..` を含む名前を拒否する。これは**ホストが正しいコマンドを渡す**ことと、**エージェントがそれをそのまま実行する**ことを前提にした設計上の取り決めであり、エージェントが別の場所の launcher を実行する行為そのものは止めない（下の「防がない」） |

## 観測スクリプトの既知の限界（第 2 弾）

- **壁時計の打ち切りは `pending`（または `exhausted`）で返る。** 残り時間で縮めた制限に掛かって gh を kill した場合は取得失敗（`err:1`）にせず、この起動では結論が出なかったものとして返す（件数は 0・`headSha` は空で、`met` ではない）。**ホストはこの封筒を「チェック 0 件」と採用しない**（`headSha` が 40 桁 16 進でない封筒は `applyChecksObservation` が `inconclusive` として不採用にする。実測した 0 件の `exhausted` は `headSha` を持つので従来どおり採用する）。ただし、その起動の中で取得失敗（HTTP エラー等）があり一度も取得に成功しないまま壁時計に達した場合は、「待ち切った」と読める封筒を出さず `err:1`・`error` にする。gh 自身の制限（25 秒）超過・非 0 終了・HTTP エラー・出力サイズ超過は `err:1`。したがって**成功の根拠は件数ではなく `outcome` が `met`（または待機なしの `observed` で `err:0`）であること**で、プロンプトもそう書く。
- **gh が遅すぎる環境:** 1 回の gh が約 23 秒を超えると、gh を 4 回呼ぶ `required` は壁時計 90 秒内に観測を終えられず、取得失敗か `pending` を返し続ける。時間制限を延ばして解決する種類の問題ではない（Bash ツールの既定 120 秒が上限）。
- **本体が SIGKILL された場合:** TERM・INT・HUP なら後始末するが、SIGKILL では走らせていた gh とウォッチャーが最大 25 秒残り、一時ファイルが 1 個残る（TMPDIR 配下）。
- **gh の出力サイズ:** 1 回 16 MiB（`OBSERVE_PR_MAX_OUT_BYTES`）を超えたら取得失敗にして、出力し続ける gh が一時ファイルを際限なく育てないようにした。
- **nonce の再現:** `boundaryNonce` は seed と keyMaterial から決定的に決まる。同じ seed のラン同士、および連番がリセットされる再開では、同じ nonce を再現し得る。別ランの封筒の流用を nonce だけでは完全には防げない。封筒の用途がチェック総数の採用（timeout → conflicting の再判定）に限られ、マージ経路に入らないことで許容している。
- **pid 単独の kill:** macOS の bash が setpgid に失敗してプロセスグループを作れなかったときは、ウォッチャーが gh の pid だけを kill する。その場合、gh の孫プロセスは残り得る。
- **標準エラーのノイズ:** macOS の bash が稀に `child setpgid … Operation not permitted` を出す（200 回に 1 回ほど）。判定は標準出力の 1 行だけで行い、スクリプトは起動ブロックの標準エラーを捨てる。

## 何を防がないか

- **エージェントが待機コマンドを繰り返す回数**は止められない。`--attempt` の上限（範囲外は exit 2）を強制できるのは、エージェントが正しく 1 から 7 へ進めたときだけで、`--attempt 1` を何度も実行されればホストは見ない（ホストが見るのは転記された封筒だけ）。1 回ごとは壁時計で有界なので、影響は監視の所要時間の延びに限られ、マージ・push・削除の判定には届かない。
- **悪意のあるエージェント**は防げない。nonce と `inputSha256` の元になる入力はホストがプロンプトに書くので、エージェントは両方を知っている。`sha256sum` を自分で回せば、捏造した payload にも正しい sha256 と `inputSha256` を付けられる。nonce・sha256・`inputSha256` の照合は、**事故（転記ミス・使い回し・入力の打ち間違い・うっかりの未実行）の検出**であって、敵対的な改竄への認証ではない。
- **コマンドを組み直して別の launcher・別のスクリプトを実行すること**は止められない。ホストが検証するのは封筒の中身だけで、どのファイルを実行したかは見えない。エージェントが `bash` で別の場所の `run-verified.sh` や自作のスクリプトを起動し、同じ形式の封筒を出力して転記すれば、ホストはそれを区別できない（launcher のハッシュ照合は、正しい launcher を経由したときの版ずれ・書き換えを止めるだけである）。「スクリプトを実行せず自己流で進めた」ことの検出は、値を推測で作って sha256 を合わせなかった場合に限る。
- **StructuredOutput 経由の値は、転記の時点で自己申告になる。** スクリプトの出力そのものはホストから見えず、ホストが見るのはエージェントが返した封筒だけである。ホストは「この封筒は、この nonce に対してこの payload から計算できる sha256 を持つ」ことまでしか確かめられない。`args.repo` の先例（PR #443）と同じく、エージェントの自己申告値を**マージ・push・削除の判定には使わない**。
- **スキルディレクトリへ書き込める者**は防げない。launcher 自身は照合の対象外で、期待ハッシュを持つ生成物も同じスキルディレクトリ（またはその同期元）にある。信頼の根はスキルディレクトリであり、そこを書き換えられる者は launcher とハッシュを一緒に書き換えられる。これは `merge-guard-hook.sh` が同じディレクトリにあることと同じ前提で、本書の対象外。
- **照合から起動までの間の差し替え（TOCTOU）** は防がない。launcher はハッシュを計算してから `exec` するまでにファイルを読み直す。メイン作業ディレクトリは他のエージェントが書き込む前提の場所ではなく（実装系のエージェントは隔離 worktree で作業する）、この競合を悪用するにはスキルディレクトリへの書き込みが要るため、上の項目に含まれる。
- **`du` / `df` 自体が返す値の正しさ**は測れない（ファイルシステム上の実値を信じる）。`du` の実失敗は `err` に数え、0 に畳み込まずに測定失敗として扱う。
- **sha256sum / shasum が無い環境**では検証できない。launcher は exit 4 で起動せず、スクリプトも exit 3 で封筒を出さない。検証できないまま通すことはしない。

## 観測スクリプト（第 2 弾）が何に使われ、何に使われないか

`observe-pr.sh` の封筒は monitor エージェントの**助言的判定の材料**であり、マージ・クローズ・push・削除・イシューへの書き込みの可否には使われない（monitor の出力はマージ経路の入力にならない、という既存の性質を変えない。マージ可否は merge-exec が checks・HEAD sha・未解決スレッド数を自分で再取得して判定し、G0 がサーバー側強制を実測する）。

| 観測 | 使い道 | ホストが封筒を照合して採用するか |
|------|--------|--------------------------------|
| `checks`（チェック総数 = check-run + commit status） | monitor が 3e・3 の観測状態表で使う。ホストは `state: timeout` かつ `checksTotal === 0` を conflicting（base 取り込み）へ再判定する | **する**。monitor が `checksObservation` に転記した封筒を `applyChecksObservation` が nonce・sha256・`inputSha256`・`mode`・`err` で照合し、通ったときだけ total を `checksTotal` に採用する。欠落・不正・取得失敗は `checksTotal` を省略する（従来の「取得失敗は省略」と同じ。timeout は 0 件再判定を受けず次ラウンドへ回る） |
| `pr`（state・mergeable・headSha・bound。取得失敗は err:1 かつ bound:-1 = 不明で、想定外の PR = 0 と区別する） | monitor の MERGED / CLOSED / CONFLICTING の分岐と PR 照合（bound = 想定ブランチ・base・fork でない・closing issue） | しない（monitor が読むだけ。ホストの PR 照合 `prBindingProblem` は別経路で独立に行う） |
| `required`（required context の不足件数） | autoMerge ラン専用の 3g。`ready` を返す前の助言的確認 | しない（発行元束縛は merge-exec (v-b) が独立に検証する。名前の存在確認は助言） |
| `reviews`（外部 App のレビュー・check-run 件数） | cursor のレビュー到着待ち・外部 App の起動確認 | しない（merge-exec が `external-review-missing` を独立に判定する） |
| `threads` / `threads-detail`（未解決スレッド） | unresolved-comments の判定と fix への指摘の受け渡し | しない（merge-exec が未解決スレッド数を自分で再取得する） |

**payload は整数と ASCII の固定語彙・40 桁 16 進だけ**で、PR のコメント本文・チェック名・context 名・ログイン名のような外部由来の文字列を含めない。そのため canonical JSON の定義の差（キー順・エスケープ・非 ASCII）が問題にならず、スクリプト（`jq -cS`）とホスト（`canonicalJson`）の出力が一致することを `tests/observe-pr-host.test.mjs` が実走で固定する。`threads-detail` の自由文は非信頼データとして監視エージェントが読むだけで、プロンプトに戻す値（封筒）には入らない。

**nonce は監視呼び出しごと・再試行ごとに別**にする（`monitorObserveSeq` の連番と試行番号を `boundaryNonce` の keyMaterial に含める）。1 回の呼び出しの中でエージェントが同じコマンドを再実行する待機（`pending` の繰り返し）は同じ nonce を使うが、それは同一呼び出しの再観測であって、別ラウンド・別試行の出力の流用ではない。流用した封筒は nonce の不一致で採用されない。

**待機の回数の上限はスクリプトが `--attempt` で強制する**（範囲外は exit 2）。1 回の起動は、gh が遅い・ハングする場合を含めて壁時計 90 秒（`OBSERVE_PR_WALL_SEC`）+ 後始末の数秒以内に必ず返る（gh 1 回ごとに 25 秒の時間制限を付けてグループごと kill し、残り時間が 1 観測分に満たなければ次の観測を始めない。Bash ツールの既定タイムアウト 120 秒に収まる）。エージェントは `pending` のたびに `--attempt` を 1 増やして同じコマンドを再実行する（最大 7 回 = およそ 10 分。現行の「最大 10 分」と同等）。ホストが 1 回ごとにエージェントを呼び直す設計にしなかった理由は `agent-call-budget.md` の「監視の待機」。エージェントが `--attempt` を進めずに（`--attempt 1` を打ち続けて）繰り返すことは止められない。スクリプトが保証するのは 1 回の起動の有界性と `--attempt` の範囲検査までで、foreground の長い sleep（ハーネスが拒否する）にはならないが、繰り返しの総数の上限はエージェントの遵守と監視枠に委ねる（次節「防がないこと」）。

## 測定値の使い方（なぜこの弾の自己申告で足りるか）

残置バイト・空き容量の測定値は、**新規着手を止めるか（ディスク枯渇の防止）**、および**次回ラン開始時の 1 worktree あたり予約見積りの下限（クランプ済みの高水位）**にだけ使う。マージ可否・push・worktree の削除・PR/issue への書き込みの判定には使わない。偽の小さい値は着手を許す側に働き得るが、それが損なうのはローカルのディスク容量の保護で、リポジトリの内容・マージ・認証には影響しない。逆に偽の大きい値は着手を止める側（安全側）に働く。したがって、この弾の信頼水準は「事故を検出できる」で足りる。**悪意のあるエージェントがディスク枯渇防止の弁を迂回できる**ことは受け入れた制約である（件数軸の元になる `git worktree list` の転記も同じ自己申告である）。

安全判定を含むスクリプト（G0・マージ実行・opt-in ゲート・`verifyDiscardSafety`・base 取り込み）を切り出す弾では、この水準では足りない。出力の用途がマージ可否に及ぶ場合は、(a) ホスト側の独立な再取得、(b) サーバー側強制（ruleset の実測）、(c) 自己申告値を判定に使わない設計、のいずれかで補うこと。nonce と sha256 の照合は補強にならない。

## 第 3 弾: base 取り込みと push 後確認（`base-merge.sh`・`observe-pr.sh --mode push`）

### 位置づけ: 封筒なしで足りる理由

`base-merge.sh` は **push を実行する最初のスクリプト**だが、出力に封筒（nonce・sha256）を付けない。上の「測定値の使い方」節が求める (a)(b)(c) のうち **(c) 自己申告値を判定に使わない設計**で足りるからである。ホストが `BASE_MERGE_RESULT` から読む値は、スクリプト化の前から返っていたものと同じで、新たに採用する値が無い。

| 値 | ホストの使い道 | 誤っていた場合に起きること |
|----|----------------|--------------------------|
| `pushed` | 進捗の記録だけ（`noPushRounds` のリセットと `lastRoundPushed`）。マージ・クローズ・push・削除の可否には使わない。resolve (b) の許可リスト `computePermittedNoPushResolveIds` は常に空（恒久無効）で、`lastRoundPushed` は安全判定に届かない | `true` の誤報は連続 no-push の数え損ないにとどまり、`baseMergeCount`（`maxBaseMerges`）が回数を有界にする。次ラウンドの monitor がサーバー側の実値を再観測する |
| `routingError` | halt 対象の失敗終端 | 偽陽性は止まる側（安全側）。偽陰性は、スクリプト自身が routing 不一致のときに fetch・merge・push を一切実行していない（実 git のテストが呼び出し履歴で固定する） |
| `commitFailed` | 失敗終端 | 止まる側 |
| `conflict` / `hookRejected` | 失敗終端せず fix 経路へ委譲 | 余分に fix 経路へ回るだけ（`fixCount` 上限 6 で有界、検証権限付き） |

`pushed` の自己申告を封筒で裏付けることは、次弾以降の選択肢である（費用は monitor の checks 系統並み: schema・observe 部品・ガイド文で数 KB）。

`observe-pr.sh --mode push` の封筒も、ホストは**照合も採用もしない**（`checksStarted` / `mergeableAfterPush` は従来どおり診断・分岐ヒント専用）。nonce はホストが常に生成して渡すが、材料は `push-confirm:<branch>:<PR 番号>` だけで呼び出しごとには変えない（プロンプトを決定的に保つため）。fix では `<PR 番号>` は実際の PR 番号だが、pr-create は PR 番号を手順 1b まで知らないため、材料には字面のプレースホルダ `<PR 番号>` がそのまま入る（エージェントが実行時に置き換えるのはコマンドの引数だけで、nonce は変わらない）。**採用に切り替えるときは呼び出し連番を `boundaryNonce` の keyMaterial に足すこと**（同じ nonce のままだと前回の封筒の流用を検出できない）。

### スクリプト内のコマンドは merge-guard hook から見えない

`merge-guard-hook.sh` は subagent の Bash の**コマンド文字列**を見て、マージ系・設定変更系を拒否する。スクリプトの中で実行されるコマンドは hook から見えない。この hook は元から best-effort（承認境界ではない）だが、push を含むスクリプトが入った以降は、迂回面が『スクリプトの内容』に移る。補うのは次の 3 つである。

1. **内容の固定**: `run-verified.sh` の期待ハッシュ。スクリプトと `scripts/lib/*.sh` の内容は、ビルドしたときのものに固定される（書き換え・版ずれは exit 3 で起動しない）。ただし、固定されるのは『レビューした内容から変わっていない』ことで、『その内容が安全か』ではない。スキルディレクトリへ書き込める者は防げない（下の「何を防がないか」）。
2. **静的テスト**（`tests/script-static-guard.test.mjs`）: `scripts/*.sh` と `scripts/lib/*.sh`（hook 自身を除く）のコード行（バックスラッシュ行継続は連結してから検査する）に、マージ（`gh pr merge`・merge 系 API・mutation）、approve、ruleset・branch protection・リポジトリ設定の変更、書き込み系の HTTP メソッド（`-X` / `-XPUT` / `-iX PUT` のような他の短縮オプションとの連結 / `-X` の後ろがタブの形 / `--method` / `--request`）、`gh api` の `-f` / `-F` / `--field` / `--raw-field` / `--input` による暗黙 POST（graphql の query 送信は読み取りとして許す。`gh -R "${repo}" api …` のように `gh` と `api` の間にオプションが入る形も同じ扱い）、`gh alias` / `gh extension`（`merge-guard-hook.sh` が拒否している類）、`curl` の `-d` / `--data*` / `-F` / `--form` / `-T` / `--upload-file` / `--json` と `wget` の `--post-data` / `--post-file` / `--body-*`、`git push` の `--force` 系・`-f`・`+` refspec、`git push` の許可形（`git push --no-follow-tags origin "HEAD:refs/heads/${branch}"`）以外の形（`--no-follow-tags` の欠落・削除 refspec・`--all`・URL 直指定・remote 違い・引用符で囲んだ `"git" push` / `git "push"`）、`git remote`（`get-url` 以外）と `git config`（`--get` / `--list` 以外）、`core.hooksPath` と `GIT_CONFIG_*` による設定の注入、`--no-verify`（`--no-verif` のような長いオプションの一意な省略形を含む）と `git commit -n`、`HUSKY=` / `LEFTHOOK=` の綴りが無いことを検査する。各パターンが悪い例に発火し、正当な行に発火しないことも自己検査で固定する。**これは正規表現の lint であり、変数経由（`"${cmd}" push`）・`eval`・文字列連結で組み立てたコマンドは防げない**。防ぐのは『レビューした内容から無自覚に外れた綴り』であって、意図して迂回する書き手ではない。
3. **スクリプト側の自衛**（`base-merge.sh`）: `--branch` と `--base` が同じ値を拒否する。ref・repo・PR 番号をホストと同じ厳格さで再検証する（PR 番号の先頭ゼロ、`refs/` 始まりと `HEAD` のブランチ名、`git check-ref-format` に通らない名前を拒否する）。push は `git push --no-follow-tags origin HEAD:refs/heads/<branch>` の 1 形だけで、`--force` 系・`--no-verify` を使わない（hook を通す）。`--no-follow-tags` は、利用者設定 `push.followTags=true` と注釈付きタグがあるとき、タグが同じ push で origin へ出ていくのを止める（実測: 付けないとタグが origin に作られ、結果は `pushed: true` のままである。`tests/base-merge.test.mjs` が固定する）。fetch 元は `refs/heads/<name>` で修飾し（修飾しないと同名のタグが優先され、タグにしか無いコミットがブランチへ入る）、取得先は worktree ごとの ref（`refs/worktree/base-merge/*`。linked worktree 間で共有されず、`pr-push.sh` と同じ。並列 worktree が共有する `refs/remotes/origin/*` は読み書きも削除もしない）で、fetch の前に自分の ref だけを消す（fetch が失敗しても stale な ref を merge しない）。マージの subject は埋め込み定数を一時ファイルに書いて `-F` で渡し（commitlint 設定やコミット履歴を読まない）、一時ファイルは trap で必ず消す。作業ツリーが clean でなければマージしない。ブランチが base に含まれている（独自コミットが無い）ときは fast-forward せず何も push しない。`gh pr view` には `-R <期待リポジトリ>` を付ける（`GH_REPO` や `gh repo set-default` で別リポジトリの PR を引かない）。

### 別リポジトリ・別ホストへ push しない保証の範囲

隔離 worktree は本体の `.git/config` を共有するため、先行するエージェントが `git remote set-url --push`・`url.<x>.pushInsteadOf`・`git remote set-url --add` で push 先だけを書き換えられる位置にある。`origin` の URL を先頭 1 件だけ見ると、fetch 元は正しいまま push だけが別の場所へ届く。そこで `base-merge.sh` は、fetch や push を始める前に次の 2 つの全行を照合する。

- `git remote get-url --all origin`（fetch URL）
- `git remote get-url --push --all origin`（push 先 URL。`pushurl` と `pushInsteadOf` の書き換えを反映する）

どちらも**全行**が、許可ホスト `github.com` と `--repo` の owner/repo に（大文字小文字を区別せず）一致しなければならない。1 行でも外れる・0 行・取得に失敗するときは `routingError` で返り、fetch・checkout・merge・push を一切実行しない。受理する URL の形は `https://[userinfo@]github.com[:443]/<owner>/<repo>[.git]`、`ssh://git@github.com[:22]/<owner>/<repo>[.git]`、`git@github.com:<owner>/<repo>[.git]` の 3 つだけである。userinfo は authority の最後の `@` までを捨てて host を取るので、`https://github.com@evil.example/…` の host は `evil.example` になり拒否する。authority に `@` が 2 つ以上ある URL（`https://a@evil.example@github.com/…`）も拒否する（git は接続に失敗するが、エラー文に 2 つ目の userinfo が残る。トークンに `@` を含む正当な URL は稀で、含めるなら `%40` に符号化する）。host は完全一致で比べる（`evilgithub.com`・`evil.github.com`・`notgithub.com` のような後方一致の別ホストも拒否する）。非標準ポート、`http://`・`git://`、`git@` 以外の ssh ユーザー、小文字でない `.GIT`、owner/repo の後方一致、許可文字（英数字と `._~:/@%+-`）以外を含む URL も拒否する。URL はトークンを含み得るので、標準出力・標準エラー・`summary` のどこにも出さない（標準エラーに出るのは『何行目が不一致』だけ）。照合は実 git の実 config に対して `tests/base-merge.test.mjs` が固定する（3 つの書き換えのそれぞれで evil 側の bare に ref が 1 つも作られないことまで検査する）。

**防がないこと:**

- **スクリプト自体の書き換え。** スキルディレクトリへ書き込める者は、ハッシュと一緒に照合も書き換えられる（下の「何を防がないか」）。
- **照合後・push 前の config 書き換えの競合。** 照合から push まで（fetch・checkout・merge をはさんで数秒）の窓がある。その間に同じ `.git/config` を別のプロセスが書き換えると、照合を通った後の push が別の場所へ届き得る。照合と push を 1 つの原子的な操作にはできない。
- **静的ガードは変数経由を防げない。** 上のとおり正規表現の lint であり、`"${cmd}" push` のような綴りは見えない。
- **URL に現れない送信先の変更。** `GIT_SSH_COMMAND`・`core.sshCommand`・credential helper のような、URL ではなく通信の仕方を変える設定は `get-url` の出力に現れない。同じ類として次も防がない。
  - `remote.origin.receivepack` / `remote.origin.uploadpack`（`get-url` に現れない。ローカル transport では別の場所の実行ファイルへ届くことを実走で確認した。GitHub の https では使われない）。
  - `http.proxy` / `https_proxy` などの proxy（通信が経由する先を変える）。
  - `~/.ssh/config`（`Host github.com` の `HostName` で ssh の接続先が変わる）。
  - リポジトリの改名・移管による GitHub 側のリダイレクト（`get-url` の文字列は `--repo` と一致したまま、実際の送信先は別リポジトリになり得る）。

**git の最低版:** `git remote get-url`（`--push`・`--all` を含む）は git 2.7 で追加された。`get-url --push --all` を使えない git では `get-url` が失敗し、取得できないとして `routingError` に倒れる（安全側）。

`git merge -F` は別で、実機で確かめた限り git 2.17.1 と 2.18.4 には無く、2.20.4 にある。`-F` を持たない git では、routing ガードは通過し、fetch・checkout まで進んだうえで merge がオプション不正で失敗する。このとき MERGE_HEAD も未マージのファイルも無いので、スクリプトは『コンフリクト・hook 拒否以外の merge 失敗』として `commitFailed`（ホストでは `failed` 終端）で返し、push はしない（merge が成功しないので push の段に進まない）。したがって `-F` の無い git は安全側に倒れるが、base 取り込みはできない。`-F` を持つことを確かめたのは 2.20.4 以降の版で、2.17.1・2.18.4 の間にある版（2.19 系）は検証していない。

### 出力は固定語彙

`BASE_MERGE_RESULT` の `summary` は固定の語彙だけで、hook の出力・gh の出力・URL・ブランチ名のような外部由来の文字列を入れない（診断は標準エラーへ出す。標準エラーはエージェントが読むが、ホストへ返る値には載らない）。ホストは `summary` を `finding.summary`（fix プロンプト）へ流すため、ここに外部由来の自由文を入れると未信頼データが push 権限のある経路へ入る。

### push の検証（`lib/push-verify.sh`）

`pushed` になるのは、(i) push 前のリモート head がローカル HEAD と違い、(ii) push 後のリモート head がローカル HEAD と一致し、(iii) push コマンド自身が成功したときだけである。push コマンドの成功や、push の前後で sha が変わったことは根拠にならない（その間に別ランが同じブランチを更新すると、自分の push が拒否されても sha は変わる。PR #436）。比較できない（ls-remote の失敗・HEAD を読めない）ときも、作業は detached HEAD 上にしか無く push を省くと失われるため push は実行し、結果は `unverified`（`pushed: false`）にする。3 条件を 1 つずつ外すと赤になることは `tests/push-verify.test.mjs` が固定する。

### スクリプトを実行できなかったとき

`run-verified.sh` の exit 3（ハッシュ不一致）/ 4（欠落）、スクリプトの exit 2（使い方の誤り）では `BASE_MERGE_RESULT` の行が出ない。プロンプトはこのとき、取り込み直さずに `pushed: false`・`commitFailed: true`・`summary: base-merge.sh の失敗` で返させる。ホストは `conflict` / `hookRejected` を伴わない `commitFailed` として `failed` 終端する（`blocked` と違い halt の連続カウントに計上される。`tests/base-merge-host-flow.test.mjs` が固定する）。版ずれの間は、base とコンフリクトした PR のたびに `failed` が 1 件ずつ積まれる（fix 経路へは回らず、取り込み直しもしない）。**配布の版ずれの影響範囲は、第 1・2 弾（測定・監視が止まる）より広い**: 版ずれがあると、実装が終わった後の PR 作成・base 取り込みの時点で初めて失敗し得る（起動時に全スクリプトのハッシュを検証する予検査は未実装）。

### 既知の挙動

- **`rerere.autoupdate` が効くとコンフリクトが `hookRejected` に分類される。** 記録済みの解決が自動適用されると、未マージのファイルは残らないまま `MERGE_HEAD` だけが残るため、スクリプトは『マージコミットの hook 拒否』として `hookRejected` + `commitFailed` で返す（abort して push しない）。ホストは `conflict` と同じく fix 経路へ委譲するので、結果は安全側にそろう。
- **PR ブランチが force-push で書き換わっても取り込める。** branch の fetch の前に追跡 ref を消すため、古い追跡 ref に引きずられず、書き換え後の head を起点にする（`tests/base-merge.test.mjs` が固定する）。リモートからブランチが消えている場合は fetch が失敗し `commitFailed`（`summary` は branch fetch 失敗）で返る。

### 隔離 worktree からの実行は実ランで未検証

第 3 弾は、`isolation: 'worktree'` のエージェント（base-merge・pr-create・fix）が、メイン作業ディレクトリ側の絶対パス `skillDir` のスクリプトを実行する**最初の弾**である（第 1・2 弾のエージェントは非隔離）。隔離 worktree のエージェントがそのパスを実行できるか、スクリプトの cwd が隔離 worktree になるか（`git` の操作が隔離 worktree に対して行われるか）は、実ランで確認していない。テストは cwd を作業用 clone にして実 git で確かめているが、Workflow ランタイムの隔離とサンドボックスの挙動は再現していない。

## 第 4 弾: pr-create と fix の push（`pr-push.sh`）と起動時のハッシュ予検査

### `pr-push.sh`: 検証権限のある経路の push

`pr-push.sh` は pr-create と fix（検証権限を持つエージェント。ビルド・lint・テストを実行できる）が使う。`base-merge.sh`（検証権限を持たず、コンフリクトを解消しない）とは役割が違い、**push と base の取り込みを決定的にし、判断だけをエージェントに残す**。

| モード | スクリプトが行う | エージェントに残る判断 |
|--------|------------------|----------------------|
| `prepare` | routing ガード（`--repo` があるとき）・未コミットの変更の拒否・base の fetch（worktree ごとの ref に固定）・起点の確立と sha の一致確認・base の取り込み | コンフリクトの解消・commitlint に合わせた subject の決定（`--subject-file`）・ビルド・lint・テスト |
| `push` | routing ガード（`--repo` があるとき）・途中のマージ（MERGE_HEAD）の拒否・固定した base が HEAD の祖先でなければ拒否（`base-not-merged`）・差分ゼロの拒否（pr-create）・`pv_push_verified` による push と前後の突き合わせ（結果に `headSha` を添える） | 修正のコミット・opt-in テストの実行 |
| `pr` | routing ガード（`--repo` があるとき）・サーバー上のブランチ head と `--expect-sha` の照合・Closes 対象 Issue の milestone 確認・open PR の検出（同一リポジトリの head だけ。base と head の sha の照合）・`gh pr create` | タイトルと本文の文面・既存 PR 本文の追記 |

- **封筒を使わない。** 結果の最後の 1 行 `PR_PUSH_RESULT {…}` は固定語彙・整数・40 桁 16 進だけで、ホストは採用しない。`base-merge.sh` と同じ理由（上の第 3 弾「封筒なしで足りる理由」）で、ホストが読む値は従来のエージェントの返却値（`prNumber`・`pushed`・`commitFailed`）と同じで、新しく採用する値は無い。`pushed: true` の誤報が resolve (a) を解禁し得る点は従来と同じ経路で、`pushed` は `pv_push_verified` の二条件でしか `pushed` にならない（スクリプトを経由しない自己申告に戻らない）。
- **routing ガードは `base-merge.sh` と同じ関数。** `lib/base-merge-lib.sh` の `routing_check_remotes`（fetch URL と push 先 URL の全行を `url_allowed` で照合）を共有する。`--repo` はホストが `args.repo` を持つときだけ渡す。**持たないランでは照合しない**（従来の pr-create / fix も照合していない）。この場合の別リポジトリへの push の防御は、fix の手順 0（`gh issue view` の title 照合）と、隔離 worktree の運用に依存したままである。`args.repo` を渡すと pr-create / fix も `base-merge.sh` と同じ強さになる（`prepare` だけでなく `push` の push の直前と `pr` の gh の前にも同じ照合を実行する。remote の URL は本体の `.git/config` を共有する worktree 間で書き換えられ得るため）。`pr` モードの `gh pr list` / `gh pr create` / `gh issue view` も `-R <repo>` で束縛し、milestone の件数を読む `gh api` は path に repo を埋める。プロンプトが実行する再利用 PR の本文取得・更新（`gh pr view` / `gh pr edit`）にも同じ `-R` を渡す。
- **コンフリクトの扱いは `base-merge.sh` と逆。** 検証権限のある経路なので、`prepare` はコンフリクトを解消せず**マージを途中のまま残して `conflict` を返す**（エージェントが解消し `git commit -F` で確定する）。途中のまま `push` を呼んでも、`MERGE_HEAD` が残っていれば `merge-in-progress` で止まり push しない。commit hook が既定 subject を拒否したときは abort して `hook-rejected` を返し、エージェントが subject を決めて `--subject-file` つきで再実行する。解消後のコミットが hook に拒否されたときは、エージェントが `git merge --abort` して失敗で返す（プロンプトが固定する）。
- **push の形は 1 形。** `git push --no-follow-tags origin HEAD:refs/heads/<branch>`（`lib/push-verify.sh` の `pv_git_push` が唯一の `git push`）。`--force` 系・`--no-verify` を使わない。push の標準エラーは URL を含み得る行（`To <url>`・`failed to push some refs to '<url>'`・`://` を含む行）を除いて出す（どの出力にも URL を出さない）。
- **起点の取り違えを止める。** `prepare` は checkout 後の HEAD が決めた sha と一致することを確かめ（`sha-mismatch`）、`push` は pr-create で base との差分ゼロなら push しない（`no-diff`）。remote ahead（第三者の push と区別できない）は採用せず `remote-ahead`、双方向とも祖先でないなら `diverged`、リモートにあるのにローカルの `refs/heads/` が無ければ `local-missing` で止まる（判定は `lib/pr-push-lib.sh` の `pp_decide_origin` で、表の単体テストが固定する）。
- **既存 PR の再利用は base と head の sha が一致する 1 件だけ。** base が違う PR・head が動いている PR・複数の PR は再利用も新規作成もしない（`pp_classify_pr`）。fork の同名ブランチの PR（`isCrossRepository`）は一覧から除く。
- **PR の head はサーバーで確認してから使う。** `push` の結果（`race`・`unverified` を含む）に関わらず、`pr` モードは `git ls-remote` で得たサーバー上のブランチ head が `--expect-sha`（`push` の結果の `headSha`）と一致しなければ、作成も再利用もしない（`remote-head-mismatch`・`remote-head-unknown`・`remote-head-missing`）。ローカル HEAD が `--expect-sha` と違えば `head-moved`。push 後に第三者が積んだ未レビューのコミットを含む PR を自動マージ経路へ渡さない。プロンプトは `race` で PR 作成を止める（`unverified` はこの照合に委ねる）。
- **base は worktree ごとの ref に固定する。** `prepare` は base を `refs/worktree/pr-push/base`（linked worktree 間で共有されない）へ取得し、以降の取り込み・`push` の base 検査・差分ゼロ確認はこの ref を使う。並列 worktree が共有する `refs/remotes/origin/<base>` は削除しない（別の worktree が参照中に消すと、そちらの取り込みや検査が解決できず正常な作業を失敗終端させる）。`git fetch` による共有 ref の前進は git の通常動作で、固定した base には影響しない。
- **milestone の確認（create-pr スキル Step 2.5 の手順 3 と同じ判定）。** リポジトリに milestone が 1 件も無ければ非運用とみなして確認しない（`not-used`）。件数・Issue の milestone を取得できなければ PR を作らず止まる（`milestone-check-failed`。取得失敗を非運用や割当済みと読み替えない）。未割当は警告つきで続行し、新規作成なら PR 本文へ警告行を足す（再利用ならプロンプトが追記する）。自律運転ではユーザーの同意を取れないため、create-pr の『候補が 1 件なら同意を得て割り当てる』は行わない（milestone を書き換えない）。判定は `lib/pr-push-lib.sh` の `pp_milestone_status`（表の単体テストが固定する）。
- **静的ガード**（`tests/script-static-guard.test.mjs`）は `pr-push.sh` と `lib/pr-push-lib.sh` も走査する。`gh` は `pr list` / `pr create` / `issue view` と、milestone 件数を読む `gh api`（GET のみ）だけを呼ぶ（merge・review・close・edit・API の書き込みの綴りが無い）。

### 起動時のハッシュ予検査（`run-verified.sh --verify-only`）

**何をするか。** ラン開始時（シードの取得の直後・状態の読み込みの前）に 1 回、`SCRIPT_SHA256` の全エントリ（`<sha256> <スクリプト名>` を 1 行ずつ）を skillDir の実ファイルと照合する。`skillDir` を渡したランで行う（`dryRun` を含む。`dryRun` で `skillDir` を省略したラン〔スクリプトを使わない〕では行わない）。不一致・欠落があれば、状態の読み込みも Plan も実装も始めずに、件数と先頭のスクリプト名を示して停止する。従来は版ずれを最初のスクリプトの起動（exit 3 / 4）で、ラン途中に初めて知った。

**ホストは bash を実行できないので、エージェント 1 回で確かめる。** 表を標準入力のヒアドキュメントで渡し、`bash <skillDir>/scripts/run-verified.sh --verify-only --nonce <nonce>` を一字一句そのまま実行させ、出力の封筒（`nonce`・`payload`・`sha256`）を転記させる。`--verify-only` は**スクリプトを実行せず**、各行を通常の起動と同じ定義のハッシュ（スクリプト本体 + `lib/*.sh`）で照合する。payload は整数と入力のハッシュだけ（`count`・`ok`・`mismatch`・`missing`・`firstBad`・`inputSha256`）。ホストは `verifySignedOutput` で再計算し、(1) nonce が呼び出しごとに一意（試行番号を材料に含める）、(2) `inputSha256` がホストの送った表と一致、(3) `count` が表の行数と一致し `ok + mismatch + missing == count`、のときだけ採用する。

| 結果 | ホストの動作 |
|------|------------|
| 全行一致（`mismatch == 0 && missing == 0`） | 続行 |
| 封筒の形が不完全・nonce 不一致・sha256 不一致・別の表を検査した・件数が合わない | 転記ミスまたはスクリプト未実行とみなし、別エージェント（sonnet）で 1 回だけ再試行する。使い切れば停止する |
| agent 例外・出力欠落 | 同上（再試行 1 回、使い切れば停止） |
| 不一致・欠落（封筒は正しい） | 再試行せず停止する（実ファイルが埋め込みと違うことは、再試行しても変わらない） |

**エージェントの自己申告だけで「一致」を信じない。** 「一致した」とだけ報告させても検証できないので、ホストが再計算できる封筒を要求する。ただし、これは**転記ミス・未実行・別の呼び出しの流用・別の表の検査を検出するもの**で、`sha256sum` を自分で回せる悪意あるエージェントの捏造（nonce と表はプロンプトに書かれているため、正しい封筒を作れる）は検出しない。launcher 自身も照合の対象外である。

**予検査は信頼境界ではない。** 各スクリプトの起動時のハッシュ照合（`run-verified.sh` の exit 3 / 4）は予検査とは別に毎回働き、マージ・push・削除の可否は予検査の結果に依らない。予検査が防ぐのは『版ずれのままラン途中まで進んでから止まる』ことで（すでに状態を書き、worktree を作った後に止まる）、『版ずれのスクリプトが実行される』ことは起動時の照合が防ぐ。予検査を通過した後にスクリプトが書き換わる競合（TOCTOU）も防がない（上の限界と同じ）。

**エージェント呼び出し数。** 予検査は 1 回（再試行で最大 2 回）で、開始処理の見積り（30）の余裕の内に収まる。`agentCallLimit` の下限（81）は変えない（`references/agent-call-budget.md`）。

### `observe-pr.sh --repo`

ホストが `args.repo` を持つときは、観測コマンドに `--repo OWNER/REPO` を渡し、スクリプト内の `gh` を対象リポジトリへ束縛する（`gh pr view -R`・`gh api repos/OWNER/REPO/…`・GraphQL の owner / name）。持たないランは従来どおり（`gh` が cwd のリポジトリに解決する）。`--repo` は封筒の `inputSha256` の材料に含まれるので、`--repo` を落として実行した出力は、repo 入りの入力を期待するホストの照合で `input` として拒否される。形式検証は `lib/base-merge-lib.sh` の `valid_repo` を共有する。

## 第 5 弾: 状態ファイルの書き込み（`state.sh`）

### 位置づけ: 封筒なしで足りる理由

`state.sh` は状態ファイルへの書き込み（`.items[n]` へのマージ・一括初期化・高水位の更新）を、従来プロンプトに文章で書いていた `mktemp` → `jq` → `mv` の手順から、固定のコマンド列へ移した。ホストが読む値は従来のエージェントの返却値（`ok`）と同じで、新しく採用する値は無いため、`base-merge.sh` と同じく封筒を付けない（上の「測定値の使い方」の (c) 自己申告値を判定に使わない設計）。`ok` が偽って `true` で返ると、保存できていない回復情報（PR 番号・worktree）のまま次へ進み得る。これは従来のエージェントの自己申告と同じ水準で、悪化していない。改善した点は、手順の組み立て（クォート・一時ファイル・原子的な置換）がエージェントの文章解釈に依らなくなったことである。

| 項目 | 従来（プロンプト） | `state.sh` |
|------|------------------|-----------|
| 書き込み先 | プロンプトの `STATE_FILE` | `_/issue-trees/<正の整数>.json` の 1 形だけ（それ以外は exit 2 で何も書かない） |
| patch の渡し方 | 未信頼範囲の囲み + ヒアドキュメント + `--slurpfile` | ヒアドキュメント（終端は呼び出しごとの nonce で作り、本文から nonce を除く）+ `--slurpfile`。patch は jq のプログラム文字列に入らない |
| 入力の形 | なし | 入力はちょうど 1 個の JSON 値（複数の値が続く入力は拒否。`jq -e` は最後の値しか見ないため）。`merge`: 番号は 1 以上の整数・patch はオブジェクト。`init`: type は `implement` / `verify-close`。形が違えば書かず `invalid-input` |
| 壊れた状態ファイル | jq の失敗に任せる | 書き換え前に `.items` がオブジェクトかを確かめ、違えば書かない（`rewrite-failed`）。出力も同じ検査を通ってから置換する |
| 並行書き込み | なし（ホストの直列化だけ） | スナップショットから計算し、置換の直前に元ファイルが変わっていないか確かめる。変わっていれば最初からやり直し、3 回続けば `changed-concurrently`（別ランの書き込みを失わない） |
| 一時ファイル | 後始末はエージェント任せ | 入力の一時ファイル・`st_rewrite` のスナップショット・出力用一時ファイルのパスを trap から見える変数（`pf` / `ST_SNAP` / `ST_TMP`）で持ち、正常終了・失敗経路・TERM / INT / HUP のいずれでも消す（テストが残存 0 を確かめ、SIGTERM 中断も実測する）。SIGKILL では残る |

- **`state.sh` が持たないもの。** 読み込み（`loadState` の読込・照合）と worktree / branch の削除（`state:cleanup`・最終スイープ）は移していない。削除は `--force` を使う別の安全判定を含み、確認と削除を同じスクリプトで行う独立の弾で扱う。掃除の手順 5（削除後の `.worktree` のクリア）だけは `state.sh merge` を呼ぶ。
- **変更検知はアドバイザリで、排他ロックではない。** 検知から `mv` までの数ミリ秒の窓は残る。同一ランの書き込みはホストが直列化している（`enqueueStateWrite`）ので、検知が対象にするのは別ランが同じ状態ファイルを書いた場合である。
- **掃除の手順 5 にも同じ判定指示を入れる。** `state.sh` は書き込みに失敗しても exit 0 で `STATE_RESULT {"ok":false,…}` を出すので、掃除プロンプトの手順 5 にも「`ok` が false・結果の行なし・非 0 終了なら掃除全体の `ok` を false で返す」を入れる（書き込みプロンプトと同じ `STATE_NOTE`）。open な項目が 0 件のときの `init` はホストが呼ばずに成功として扱う（`state.sh` は空配列を `invalid-input` で拒否する）。
- **失敗の返し方は従来と同じ。** 結果の行が出ない・非 0 終了・`ok: false` は、エージェントが `ok: false` を返し、ホストの既存の経路（`StructuredOutput` 未返却は sonnet へ 1 回フォールバック、応答した上での失敗はフォールバックしない）に乗る。`merge` が失敗したら掃除をしない（回復情報を保全する）契約も変えていない。
- **静的ガード**（`tests/script-static-guard.test.mjs`）は `state.sh` と `lib/state-lib.sh` も走査する。`rm` は自分が作った一時ファイルへの `rm -f` だけで、`rm -rf`・`--force` の綴りは無い（ガードが固定する）。

### `base-merge.sh` の共有 ref

第 4 弾の持ち越し: `base-merge.sh` は branch と base の取得先を `refs/worktree/base-merge/*` に変え、並列 worktree が共有する `refs/remotes/origin/*` を削除しない（実 git の 2 worktree テストと変異 U40 が固定する）。`refs/worktree/` が worktree ごとに分かれることは、git 2.54 でしか実測していない（最低版 2.20 では未確認）。

## 第 6 弾: merge-exec の G0 と再検証（`merge-gate.sh`）

### 位置づけ: マージの実行はプロンプトに残し、読み取り専用の検証だけを移す

merge-exec のプロンプトは、マージ直前に (a) ベースブランチのサーバー側強制の実測（G0: ruleset の source / `bypass_actors` / `enforcement` / required status checks の `integration_id` 束縛 / 外部チェック App の context + App ID の組 / レビュースレッド解消の必須化 / client-only チェックの不在）と、(b) チェック状態・未解決スレッド・mergeable・外部チェックの再検証を、`gh` / `jq` の手順として文章で持っていた。これを `scripts/merge-gate.sh`（判定は `lib/merge-gate-lib.sh` の純関数）へ移し、プロンプトは「コマンドを 1 回実行し、`payload.verdict` が `ok` ならマージ、それ以外は verdict をそのまま reason にして辞退する」だけにした。

**squash merge の実行（`--match-head-commit` 付きの 1 形）はスクリプトに入れない。** `script-static-guard` はスクリプトにマージ系の綴りを禁じ、`merge-guard-hook.sh` は Bash のコマンド文字列でマージを拒否する。マージ実行をスクリプトに入れるとガードの例外化と hook の素通りが生じる。除外リストと hook はこの弾で変えていない（変えたのは `/rulesets` の 1 パターンだけで、下の「静的ガード」参照）。merge-verify（マージ後の `gh pr view` 1 コマンドの独立確認）は、移しても削減が無いうえ「別コンテキストが独立に観測する」ことが本質なので移していない。

### 封筒を使う理由: ホストの受理条件に入る

`state.sh` と違い、出力はホストのゲート判定の入力になる。ホストは `merged: true / reason: merged` を受理する前に、merge-exec が転記した封筒（返却の `gate`）を `verifyMergeGate` で照合し、次がすべて揃ったときだけ受理する。

- 封筒の nonce が、そのラウンドの merge-exec 呼び出しに対してホストが決めた nonce と一致する（呼び出しごと・ラウンドごとに別。前の封筒の流用は通らない）
- sha256 が nonce + payload の正規形から再計算した値と一致する
- `payload.inputSha256` が、ホストが自分の引数（PR・repo・base・期待 sha・外部チェックの宣言の文字列）から再計算した値と一致する（別の PR・別の宣言を検証した出力は通らない）
- `verdict == ok`・`err == 0`・`stage == done`（最後の段階まで到達した）
- 封筒の `headSha` が merge-exec 申告の `headSha` と一致する（ホストが opt-in ゲートの期待 sha を持つときはそれとも一致）。続けて既存の merge-verify の独立観測 `headRefOid` との一致も要求する

**この照合はマージの後に行われ、マージを防ぐ仕組みではない**（マージを防ぐのはサーバー側の ruleset と hook で、照合は不正・転記漏れの検出と `blocked` 化を担う）。不合格は既存の「独立確認で裏付けられなかった」経路（`blocked` + `quality`、次回ランの monitoring 再開で `already-merged` 回復）へ流す。ホストの分岐の意味は変えていない。`already-merged` の回復は新規マージではないので封筒を要求しない。reason が `merged` でない辞退（`checks-not-green` など）の分岐は従来どおり merge-exec の reason を使う。

payload に入れるのは整数・固定語彙（verdict / stage / detail）・40 桁 16 進だけで、ruleset 名・context 名・App 名・PR のタイトルのような GitHub 由来の自由文字列は入れない（テストが外部由来の文字列を含む fixture で標準出力に出ないことを確かめる）。外部チェックの宣言（App の slug と context）は `--external` の引数文字列 1 つで渡し、封筒の `inputSha256` がそれを束縛する。

### 判定の対応（プロンプトの旧手順との同値性）

| 段階 | 判定語 | 旧手順 |
|------|--------|--------|
| view | `head-moved`（取得失敗・HEAD sha の形式・OPEN でない・期待 sha の不一致）/ `pr-closed` / `wrong-target`（base 不一致・draft） | 手順 2 |
| g0 | `classic-unsupported`（required status checks が 0 件・取得失敗）/ `server-enforcement-missing`（Organization 継承・ruleset の取得失敗・`bypass_actors` が空でない・スレッド解消の強制なし・外部チェックの App ID + context の組が required に無い・client-only チェックあり・取得失敗）/ `issuer-unbound`（`integration_id` が数値でない・取得失敗）/ `checks-not-green`（束縛済み check-run が HEAD に未発行 = 一過性） | 手順 2b (i)〜(v-b) |
| checks | `checks-not-green`（総数 0・合格以外あり・終了コード 8 = pending あり〔一過性 = `err 0`。出力が解析できれば解析結果で、全件 green に読めても止める〕。8 以外の非 0 終了・時間切れ・解析失敗は取得失敗 = `err 1`） | 手順 3 |
| threads | `unresolved-threads` / `head-moved`（取得失敗） | 手順 4 |
| mergeable | `not-mergeable`（CONFLICTING のみ。UNKNOWN は止めない） | 手順 4 |
| external | `external-review-missing` / `checks-not-green`（cursor 以外の check-run が不合格） | 手順 4b |

- **追加した検査は 1 つ**: 各 ruleset の `enforcement` が `active` であること（旧手順は `bypass_actors` のみ。effective rules は active の ruleset だけを返すはずなので通常は同値で、`evaluate` / `disabled` を通さない側にだけ厳しくなる）。`ruleset-policy.md` の「strict 以外の必須構成」表の enforcement 行に対応する。
- **取得失敗・ページ不完全は合格に倒さない**: `gh` の非 0 終了（`--paginate` のページ途中の失敗を含む）・出力サイズ超過・時間切れ（1 回 25 秒・全体 100 秒、孫プロセスごと kill）・想定外の形（HTTP エラー本文が exit 0 で出た等）は、それぞれの段階の fail-closed の判定語と `err == 1` で返す。未解決スレッドは `hasNextPage` が真で `endCursor` が無ければ打ち切らず取得失敗にする。
- **`strict_required_status_checks_policy` は読まない**（`ruleset-policy.md`）。
- **HEAD sha の出所**: スクリプトが `gh pr view` で 1 回取得して固定し、封筒で返す。エージェントはその値だけを `--match-head-commit` に使う。ホストが opt-in ゲートの確認値を持つときは `--expect-sha` で束縛し、不一致は `head-moved`。`--repo` は任意引数（`args.repo` を持つラン）で、持たないランは `observe-pr.sh` と同じく cwd のリポジトリに解決する。

### 静的ガード

G0 は適用 ruleset の `bypass_actors` を読むため `gh_api "${repo_path}/rulesets/${id}" || …` の 1 行が `/rulesets` を含む。`script-static-guard` の「ruleset / リポジトリ設定」パターンは `/rulesets` を設定変更の経路として拒否していたので、**この 1 行の形（`/${id}" ||` が続く GET）だけを許す**ようパターンを狭く直した。許す行が `merge-gate.sh` 以外に無く、形が 1 つであることは専用テストで固定する。書き込み（`-X`・`--method`・`-f` による暗黙 POST）は別のパターンが引き続き拒否する。メソッド指定のパターンは GET のリテラル以外（`-X "$m"` のような変数値を含む）にすべて反応し、`gh_api()` ラッパーの本体が `run_timed "${gh_timeout}" gh api "$@"` の 1 形（メソッド指定を含まない）であることも専用テストで固定する（変数でメソッドを切り替えると `/rulesets/${id}` が DELETE になり得るため）。`EXCLUDED`（除外リスト）と `merge-guard-hook.sh` は変更していない。

### この弾の検証範囲

単体テスト（判定の表・偽 `gh` を差し替えたスクリプト全体・ホストの封筒照合・プロンプトの配線）と変異（危険側 38 件）でのみ検証している。**`autoMerge: true` の実ランでは未検証**（実 GitHub の ruleset / App に対する G0 の通過、`gh pr checks --json state --jq` の実出力と終了コード（pending で 8 を返すかは未確認。8 は一過性の `checks-not-green`、それ以外の非 0 終了は取得失敗で、どちらも合格に倒さない。exit 0 で PENDING が混じっても `checks-not-green`）、隔離 worktree からの `run-verified.sh` 経由の起動を含む）。なお `apps/<slug>`（外部チェック App の ID 取得）は GitHub 側がリポジトリに束縛できないグローバルな endpoint で、他の `gh` 呼び出しがすべて対象リポジトリを明示するのに対する唯一の例外である。

## ハッシュ埋め込みと鮮度

- 開発ファイル（`implement-issue-tree.src.js`）には、スクリプトごとの期待ハッシュの代わりに置換前の目印（`SCRIPT_SHA256` の値）を書く。`build-workflow.mjs` は**コメント除去とトークン照合より前に**、同じディレクトリのスクリプトの `bundleSha256`（スクリプト本体 + `scripts/lib/*.sh` のバイト列連結の SHA-256）へ置換する。置換後の文字列を「開発ファイル」としてトークン照合に使うので、照合の定義（種類・値・開始行）は変わらない。生成物に目印が残らない。
- スクリプトまたは lib を書き換えると生成物の内容が変わる。`--check`（鮮度ゲート）と `tests/build-workflow.test.mjs` は、スクリプトだけが変わって生成物が再生成されていない状態を検出する。
- スクリプトが無い・目印の書式が不正（置換されずに残る）ならビルドは生成物を書かずに中止する。
- `launcher` と `bundleSha256` の定義の一致（sha256sum 経路・shasum 経路の両方）は `tests/script-launcher.test.mjs` が検証する。

## 運用

- `args.skillDir` は呼び出し側（起動手順）が渡す。配布後、既存の呼び出し手順は更新が必要になる。`dryRun` でないランで未指定なら起動時エラーで停止する（第 2 弾から、monitor が毎回 `observe-pr.sh` を使うため、`maxResidualWorktreeBytes: 0` のランも対象）。named workflow（`{name: "implement-issue-tree"}`）で起動する場合も同じ。
- 同期で届くのはスキルディレクトリ全体（Workflow とスクリプトを同じコミットで）なので、通常は版ずれは起きない。`run-verified.sh` が exit 3 を出したときは、スキルの同期が途中か、スクリプトがローカルで変更されている。同期し直す。
- 新しいスクリプトを足すとき: `scripts/` 直下に `*.sh`（小文字・数字・`-`・`.`）で置き、`SCRIPT_SHA256` に目印を足し、`bash <skillDir>/scripts/run-verified.sh` 経由で起動し、封筒で返す（ホストが値を採用しないスクリプトは、上の第 3 弾の節の理由づけを示したうえで封筒なしにできる）。`scripts/lib/*.sh` を足すと、**すべてのスクリプトのハッシュが変わる**（`run-verified.sh` は lib 全体をハッシュに含める）。再ビルドで追従する。`tests/script-static-guard.test.mjs` の走査対象は `scripts/*.sh` と `scripts/lib/*.sh` の全体なので、新しいスクリプトも自動で対象になる。冒頭コメントに入力・出力・終了コードを書く。`bash 3.2`（macOS）と GNU の両方で動く書き方に限る（`paste`・`bc`・GNU 専用フラグ・`date -d`・`sed -i`・`mapfile`・連想配列を使わない）。

## 関連

- `./automerge-design.md` — G0 とサーバー側強制（安全判定の信頼境界）
- `./verification.md` — 起動可否契約とサイズ予算
- `../../../.claude/rules/security.md` — OWASP A03（インジェクション）・A08（整合性）の観点

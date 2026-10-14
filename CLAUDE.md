# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code 向けの CLI ワークフロースキル集。コミット・PR・Issue・レビューなどの開発ワークフローを Conventional Commits 準拠で自動化する。インストールは [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI を使用。

## Repository Structure

```
skills/                               -- スキル本体（各ディレクトリに SKILL.md）
  comment-code/
  create-commit/
  create-issue/
  create-issue-tree/
    scripts/                          -- create-root-body.sh（Step 6 新規作成経路のルート本文生成・実ツリーから表を作りプレースホルダー残りで中止）、merge-root-body.sh（Step 6 --root 経路・既存ルート本文へ今回の Phase 行・セクションをマージ）、tree-lib.sh（list_subs・count_open_desc・CELL・プレースホルダー正規表現の共通ヘルパー・source 専用）
    tests/                            -- node:test 回帰テスト（新規作成・--root 両経路とも scripts/ のスクリプトを直接実行・引数検証・edit 失敗の終了コード伝播・ライブラリ契約・Step 6 の呼び出しフェンス検査と 3 レイアウト探索・プレースホルダー残りで中止・ページング・一時ファイル削除・Step 3 雛形への --root マージ・コードフェンス内の行を見出しと誤認しない／閉じ忘れフェンスで中止）
  create-plan/
  create-pr/
  implement-issue/
  implement-issue-tree/
    references/                       -- 自動マージ設計・検証手順・復旧・レポート書式・スクリプト実行の信頼モデル（script-trust-model.md）・テストの流し方と変異テストの使い方（testing.md）
    sample/                           -- 引数例・ツリー例
    scripts/                          -- preview-tree.sh、measure-residual-bytes.sh / measure-free-disk.sh（残置 worktree のバイト・実ディスク空き容量の読み取り専用測定。物理パスは末尾の改行も保って受け取り、許可文字集合外の物理パスは測らず err に数える。出力は {nonce,payload,sha256} の 1 行封筒・args.skillDir から bash で起動）、observe-pr.sh（monitor の PR 観測と有界の待機。モード pr / checks〔--until settled は CI の完了待ち = 旧 gh pr checks --watch の置き換え・合格 / 未完了 / 不合格の件数・既定は 25 秒間隔 × 4 観測 × --attempt 最大 30 回 = 約 40 分〕 / required / reviews / threads / threads-detail / push〔push した HEAD が PR の head になるのを待ってから件数・mergeable を読む・pr-create と fix が実行・ホストは採用しない〕。出力は 1 行封筒で payload は整数と固定語彙のみ・助言的判定の材料でマージ経路には使わない・--wait は 1 回が壁時計 90 秒 + 数秒以内（gh 1 回ごとに時間制限・孫プロセスも kill）で --attempt が上限を強制）、base-merge.sh（自動 base 取り込み。routing ガード・fetch・マージ・push 検証を決定的に実行しコンフリクトは解消せず報告。封筒なしで最後の 1 行が BASE_MERGE_RESULT・push は HEAD:refs/heads/<branch> の 1 形のみ）、run-verified.sh（実行前にスクリプト + lib の SHA-256 を照合して起動する launcher。`--verify-only` はスクリプトを実行せず、ラン開始時の予検査として表の全行を照合し封筒で返す）、pr-push.sh（pr-create と fix の起点の確立・base 取り込み・push と反映の確認・PR の検出と作成。モード prepare / push / pr。コンフリクトは途中のまま残してエージェントが解消する。封筒なしで最後の 1 行が PR_PUSH_RESULT・push は HEAD:refs/heads/<branch> の 1 形のみ）、merge-gate.sh（merge-exec のマージ直前の読み取り専用検証。G0 = サーバー側強制の実測とチェック・未解決スレッド・mergeable・外部チェックの再検証を封筒つきの判定語で返す・マージの実行は含まない・出力は {nonce,payload,sha256} の 1 行封筒で payload は整数と固定語彙と HEAD sha のみ）、lib/observe-checks-lib.sh（checks --until settled の分類。check-run と commit status を合格 / 未完了 / 不合格に分ける純関数・source 専用）、lib/merge-gate-lib.sh（merge-gate.sh の JSON→判定語の純関数・テストが表で単体検査する・source 専用）、worktree-remove.sh（worktree の破棄・掃除。確認と削除を同じプロセスで行う。`remove --mode superseded|discard`〔汚れの確認は `status --porcelain=v2 -uall --ignore-submodules=none`・lock は `claude agent … (pid N)` で pid が死んでいるときだけ外す・superseded は汚れていても `--force`〔submodule に未記録の変更があれば保持〕・discard は汚れ／初期化済み submodule で保持し `--force` を使わない・`--expect-branch` は消さずに HEAD がそのブランチ上かだけ照合・ブランチは worktree が無くなってから消し消す前の先頭 sha を結果に出す・base と同名は消さない・ブランチを持つ実体の無い登録の後始末は --path の結果を上書きせず holder に出す〔後始末は unregistered ガード付きで、パスに登録の無い実体が現れていたら retained-unregistered を holder に出しブランチを残す・実体の有無にも結びつけ、登録済みの worktree が作り直されていたら retained-present を holder に出しブランチを残す（lock があれば pid の生死を問わず外さず retained-locked を holder に出しブランチを残す = unlock が走るのは結びつけの無い呼び出しだけ）・消す直前にもパスの不在を確かめる〕・prune は remove が実際に消したとき・sweep が候補を 1 件でも消したときだけ・登録の無い実体は --head / --expect-branch / --path つきの --branch なら retained-unregistered〔ブランチも残す〕〕と `sweep`〔状態ファイルの failed / blocked / monitoring が記録した worktree と登録外・メイン worktree は消さない〕と `check-absent --path`〔削除を一切しない不在専用の確認。absent / prunable〔登録だけ残り lock なし・ブランチ上。prunable のときホストは planning の前に remove --mode discard --path <旧パス> --require-missing で旧登録だけ片づける。--require-missing は確認と削除の間に作り直された実体を消さない結びつけで、削除の前に同じプロセスで実体を読み、あれば retained-present・登録の無い実体は retained-unregistered・lock ありは unlock せず retained-locked で保持する〕だけを不在として返し、実体あり・detached や lock の prunable・判定不能は保全側の固定語。Recover が discard・worktreeMissing・ブランチ空のときだけ呼ぶ〕。メイン worktree・未登録パス・カレントの中は消さず `rm -rf` を持たない。全体の worktree prune は 1 か所だけで、何も消さなかったとき・実体の無い detached / HEAD 0000… の登録・有無を観測できない登録があるときはスキップ〔pruneSkipped〕。check-absent は照合前にパスを正規化し大小違いの登録は unknown・--repo-root でカレントのリポジトリを照合。観測の失敗は retained-unobservable。封筒なしで最後の 1 行が WORKTREE_REMOVE_RESULT）、lib/worktree-remove-lib.sh（判断・lock 理由の解析・status の読み取り・入力検証の純関数・テストが表で単体検査する・source 専用）、recover-prep.sh（Recover の機械手順。対象ブランチの解決〔live は worktree の HEAD・dead と branch だけの残骸は記録のブランチ・メイン／未登録／git がそのパスを指さない／detached／base と同名は確定せず何も書かない〕・未コミット変更の WIP コミット〔フックを通す・退避完了の根拠はコミット後の観測が空であること〕・base の取得・差分の有無〔取得失敗は unknown〕。継続／破棄の判断と回復ブリーフはエージェントに残る。封筒なしで最後の 1 行が RECOVER_PREP_RESULT・削除の実効のゲートは worktree-remove.sh）、lib/recover-prep-lib.sh（ブランチ解決・WIP の要否と結果の分類・差分の三値判定の純関数・テストが表で単体検査する・source 専用）、lib/signed-output.sh（封筒の共通ヘルパー・source 専用）、lib/push-verify.sh（push 前後のリモート head の突き合わせ・二条件で pushed を判定・source 専用）、state.sh（状態ファイルの書き込み。モード merge / init / hw-max / hw-set。入力の形を検証し、書き込み直前の変更検知つきで原子的に書く。封筒なしで最後の 1 行が STATE_RESULT）、lib/state-lib.sh（その検証と書き換えの純関数・source 専用）、lib/pr-push-lib.sh（pr-push.sh の判定だけの純関数: 起点の 4 分岐・既存 PR の分類・PR 番号の取り出し・形式検証・source 専用）、observe-pr.sh は `--repo` で gh 呼び出しを対象リポジトリへ束縛、lib/base-merge-lib.sh（base-merge.sh の引数検証と remote URL 照合の純関数 is_uint / valid_repo / lower / url_allowed と許可ホストの定数・テストが表で単体検査するため本体から無変更で切り出した・source 専用）、implement-issue-tree.src.js（自動開発の開発ファイル・編集対象）、implement-issue-tree.js（build-workflow.mjs がコメント除去・コード行の先頭インデント除去・トークン間の不要な半角スペース除去をして生成する実行ファイル・直接編集禁止）、build-workflow.mjs（ビルダー。`/` が除算か正規表現かは非 ASCII 識別子・`of`・`if`/`for`/`for await`/`while` の括弧の直後・プロパティ名・private 名・正規表現の直後まで lexer が判別し、`}` の直後は除算側に倒す。生成時と --check で生成物と src を acorn.parse のトークン列〔パーサ文脈つき・module とランタイムの評価形 = `export ` を外した script の両ゴール〕で照合し、不一致・どちらかがパースできない・照合を実行できない・照合結果が想定の形でない場合は書かずに中止。照合を差し替える CLI 引数は無い。中止になる書き方は `}` の直後の `//` `/*` を含む正規表現・`o?.in / 2` 型・`with` 文など）、token-diff.cjs（その照合ヘルパー・テストと共用）、merge-guard-hook.sh（マージ系 deny hook・best-effort）
    tests/                            -- node:test 回帰テスト（G0 ゲート・merge ループ・依存再判定・CONFLICTING→base 取り込み dispatch・Workflow 起動可否・Review 比較基準・opt-in テスト記録ゲート・state 書込みフォールバック・残置 worktree バイト測定の再測定〔転記失敗・agent 例外・StructuredOutput 欠落を有界に再測定／du 実失敗は再測定せず fail-closed〕・monitor の required context 揃い待機・ツリー取得の完全性照合〔子総数 subIssuesTotal と返却ノードの子数の不一致・欠落・番号重複で停止／5 段ツリー・closed 配下の open 子孫〕・closed 中間ノード配下の open 子孫を親の verify-close が待つ待機先〔closed を貫通して最初の open 子孫・貫通辺は循環除去で削除されない〕）・closed で skip する実装ノードの後始末〔closed-skip-cleanup: 候補の表・試行回数 closedCleanupAttempts の少ない順に試し一過性の候補が先頭に 11 件以上あっても数ラン以内に後ろの候補へ順番が回ること・MERGED かつ HEAD 一致のときだけ掃除 → merged へ更新・未マージ／結び付き不成立／保持／dryRun／照合未成立では状態不変・unverifiedPr だけの項目〕・着手できないノードの blocked 一括記録〔件数 N に比例せず 100 件ごと 1 エージェント・保存済みと同一の項目は書かない・dryRun が書き込み系と実装系エージェントを起動せず見積りを返す・チャンク失敗時の書けた件数の差・note の「件数 + 先頭 5 件」・sonnet フォールバック登録〕・測定スクリプトの実行〔du / df を本当に走らせる・存在しないパス・空白／非許可文字を含むパス・0 件・多数件・du 失敗の注入・bash 3.2 と GNU の両対応〕・launcher のハッシュ照合〔不一致・欠落・lib 書き換え・sha256sum / shasum 両経路〕・起動時のハッシュ予検査〔--verify-only の一致・不一致・欠落・lib 書き換え・入力の正規化・スクリプトを実行しないこと・使い方の誤り、ホストの封筒照合と再試行・何も着手せず停止・dryRun〕・pr-push.sh の実行〔pr-push-unit は起点の 4 分岐・PR の分類・番号の取り出しの表、pr-push は実 git で起点 3 種・中止・コンフリクト・hook 拒否・routing・push・PR の検出と作成・引数検証〕・pr-create / fix のプロンプトの配線（pr-push-prompt）・ホストの封筒照合〔欠落・不正・nonce 不一致・sha 不一致・件数不一致を拒否〕・封筒が入力を束縛すること〔inputSha256・nonce の呼び出しごとの一意性〕・CI の完了待ち（observe-checks-unit は分類の表、observe-pr-checks-settled は pending → settled・上限 exhausted・取得失敗を完了に倒さない・commit status のみの CI・bash 3.2 と GNU）・観測スクリプトの実行〔偽 gh を PATH に置いて ページ合算・0 件と取得失敗の区別・HTTP エラー本文・required context の不足・外部 App の conclusion・待機の met / pending / exhausted・特殊文字の context 名・bash 3.2 と GNU〕・ホストの観測封筒照合と nonce の呼び出しごと／再試行ごとの一意性・monitor 結合〔封筒つきの checksTotal 0 だけを conflicting へ再判定〕・args.skillDir の検証と dryRun 以外での未指定時の起動時エラー・sample/args-example.json の全例が生成物の起動時検証を通ること・ビルダーのスクリプトハッシュ埋め込みと鮮度ゲート・ビルダーの空白除去〔許可リスト・文字列／テンプレート／正規表現の不変・行数保持・冪等・acorn による変換前後のトークン列一致・規則を 1 項ずつ外す変異テスト・`/` 判別の固定ケースと `}` の直後など判別できない入力での中止・lexer と同じ誤読を tokenizer 単体は見逃しパーサ文脈つきの照合が止める壊れた生成物・`<!--` による script 読みの差・文法ベースの生成的テスト・照合ヘルパーが失敗／想定外の出力のときの中止〕、base-merge.sh の実行〔bare の origin を作る実 git・正常取り込み／取り込み不要／コンフリクト／commit hook 拒否／push 拒否／push 後にリモートが動いた／push 前後の確認不能・routing 不一致で fetch・merge・push を呼ばない・launcher の exit 3 / 4〕・push-verify.sh の二条件・observe-pr.sh --mode push の実行・state.sh の実行〔merge / init / hw-max / hw-set・不正入力と壊れたファイルで書かない・並行書き込みの検知〕・base-merge.sh が共有の追跡 ref を削除しない並列 worktree テスト・スクリプトの静的ガード〔merge・approve・設定変更・force push・--no-verify の綴りが scripts/*.sh と scripts/lib/*.sh に無い〕・base-merge の host 結合〔fallback の失敗終端〕・implement が返した branch の命名ゲート〔`<type>/<issueNumber>-<short-name>` に合わなければ Review・push・PR 作成を起動せず blocked・状態へ違反 branch を書かない・回復 Implement も同じゲート〕・args.models による判断を伴う agent の段階別モデル上書き（未指定は既定のモデル・機械的な agent は対象外・不正な指定は起動時に停止）・worktree-remove.sh の実行〔--head の一致・不一致・detached・実体なし・引数の形・実 git のサンドボックスで clean・追跡変更・staged・未追跡・入れ子の独立 repo・ignore のみ・showUntrackedFiles=no・ignoreSubmodules 設定・submodule 未初期化／初期化済み／内部の変更／deinit 後・lock〔生存 pid／死んだ pid／他形式〕・実体なし・メイン worktree・未登録パス・.git 破損・空白を含むパス・ブランチの各状態・引数の誤り・sweep の保持照合と状態ファイルを読めない場合を bash 3.2 と 5 で・観測が誤って clean を返しても discard が --force を使わないこと・ホスト配線〔モード・引数・retained の扱い・Recover の分岐〕・git worktree remove／unlock と git branch -D の許可形が worktree-remove.sh の決まった行にしか無いこと〕・recover-prep.sh の実行〔recover-prep-unit は lib の表を 1 回の bash 起動で・recover-prep は実 git で clean／追跡変更／staged／未追跡／ignore のみ／showUntrackedFiles=no／グローバルの除外／フックの拒否と書き換え／コンフリクト中／入れ子の独立 repo／submodule／観測不能／state との食い違い／dead worktree／branch だけの残骸／detached／メイン worktree／未登録パス／.git 破損／base と同名／base の取得失敗〔古い追跡 ref あり〕・args.securityReview によるセキュリティ専用の Review（無効時は呼び出し不変・有効時は各ラウンドで並列起動・両方の結果を合わせた判定と fix への受け渡し・予算と worktree 予約の増分・片方の Review が例外で終了しても両方の worktree を台帳へ記録して failed 経路へ流す）、lib/ に起動可否契約の実装・acorn トークン比較ヘルパー・封筒（nonce / payload / sha256）のテスト用ハーネス・偽 gh（gh-observe-stub.mjs）・実 git のサンドボックス（git-sandbox.mjs・テンプレートをコピーして使い回す）・base-merge.sh の実 git テスト一式（base-merge-suite.mjs・bash ごとにファイルを分けて並列化し、URL・引数の表は base-merge-unit.test.mjs が lib を 1 回の bash 起動で単体検査）・子プロセスの非同期実行（run-async.mjs・実時間を待つ観測テストを縮尺を変えずに同時に待つ）・stub agent で実装スクリプト全体を実行する共有ハーネス（stub-run.mjs）、merge-gate.sh の実行〔merge-gate-unit は JSON→判定語の表、merge-gate は偽 gh で 段階の順序・bypass／enforcement／integration_id 束縛・client-only・外部チェック App の組・取得失敗とページ不完全の fail-closed・出力サイズと時間切れ・全 gh 呼び出しの repo 明示・外部由来の文字列が payload に入らないこと・引数検証〕・ホストの封筒照合（merge-gate-host: nonce・sha256・入力・verdict・HEAD sha の不一致で merged を確定しない）、tools/（変異テストの実行器 mutate.mjs と変異の定義 mutations.mjs・作業コピー上で置換・再ビルド・関連テストだけを流して killed / survived を判定・--list / --run）
  implement-review/
  implement-review-pr/
  init-claude/
  update-docs/
  update-issue-tree/
    scripts/                          -- reassign-sub-issue.sh（closed 親下の残置 open issue 付け替え・孤児再配置。DELETE→POST を単一プロセスで冪等に実行。cross-repository sub-issue は非対応で exit 2）、reassign-lib.sh（Step 3/4 の呼び出し側共有ヘルパー。計画配列の存在・型検証と終了ステータス解釈。両フェンスが自己完結的に source する）、update-root-body.sh（Step 8 のルート本文部分更新。マーカー間の管理ブロックのみ差し替え・既存本文は保持・マーカー無し本文は旧 Phase 表を details へ退避して移行・exit 4/5 で fail-closed）
    tests/                            -- node:test 回帰テスト（DELETE 失敗時に POST が呼ばれないこと、Step 8 の既存本文保持・移行・冪等・並行編集検知・マーカー不整合停止等）、lib/ に gh スタブ（作る一時ディレクトリは tmp-track.mjs でプロセス終了時に消す）
  update-claude/
  setup-repo-guards/
  project-init/
  project-add-items/
  project-create-issues/
  project-view-status/
  project-update-items/
  project-sync-issues/
  project-archive-done/
  contribute-skill/
    scripts/                          -- skills-contribute.sh（upstream 反映スクリプト。lock 照合は fail-closed・コピー前に対象スキルの作業ツリー clean 検査を行う）
    tests/                            -- node:test 回帰テスト（lock 不在・未登録・source 欠落・解析失敗の中止、未コミット・未追跡・ignore 対象の検出時にコピー前で中止すること）
  sync-skills-lock/
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
  skills/                             -- skills/ へのシンボリックリンク（一部実ディレクトリ）
    create-skill/                     -- リポジトリ管理スキル（実ディレクトリ、sample/ に SKILL 雛形）
    create-agent/                     -- リポジトリ管理スキル（実ディレクトリ、sample/ に Agent 雛形）
    github-docs                       -- 参照スキル（symlink）
    anthropic-claude-code             -- 参照スキル（symlink）
    anthropic-claude-code-extend      -- 参照スキル（symlink）
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

## Current Skills (24)

### 開発ワークフロー (12)

comment-code, create-commit, create-issue, create-issue-tree, create-plan, create-pr, implement-issue, implement-issue-tree, implement-review, implement-review-pr, update-docs, update-issue-tree

### GitHub Projects 管理 (7)

project-init, project-add-items, project-create-issues, project-view-status, project-update-items, project-sync-issues, project-archive-done

### Claude Code セットアップ (3)

init-claude, update-claude, setup-repo-guards

### 上流貢献 (2)

contribute-skill, sync-skills-lock

### リポジトリ管理スキル（.claude/skills/ に配置）

create-skill, create-agent

### 参照スキル（.claude/skills/ に配置）

github-docs, anthropic-claude-code, anthropic-claude-code-extend

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

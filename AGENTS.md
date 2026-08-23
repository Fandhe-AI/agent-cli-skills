# AGENTS.md

## 文書の位置づけ

本リポジトリで作業するすべての AI エージェント・人間レビュアーが共通で用いるレビュー観点集。
Codex による PR 自動レビュー（`.github/workflows/codex-review.yml`。Fandhe-AI/actions の
reusable workflow を `@latest` で呼び出す wrapper）は、PR の base コミットの本ファイルを
レビュー基準として読む。運用ガイドの正は `CLAUDE.md`、著作規約の詳細は
`.claude/rules/`（特に `skill-authoring.md` / `security.md`）を参照し、本書は重複させず
レビュー判定基準に絞る。

本リポジトリのスキルは `npx skills add Fandhe-AI/agent-cli-skills` で**組織内の多数の
リポジトリへ配布される共通アセット**である。ここでの欠陥・危険指示は導入先すべてへ
伝播するため、通常のリポジトリより厳しい基準でレビューする。

## 優先度の定義

| 優先度 | 意味 | 扱い |
|--------|------|------|
| P0 | マージブロック。導入先への危険指示の伝播・情報漏えいに直結 | 修正までマージ不可 |
| P1 | 強く推奨。著作規約・構造規約への違反 | 原則修正してからマージ |
| P2 | 提案。可読性・保守性・発火率の改善 | 任意（コメントのみ） |

## 1. セキュリティ観点

- **埋め込みシェルスニペットのインジェクション（P0）**: SKILL.md・スクリプト
  （`skills/*/script/`）内のシェル例で、ユーザー入力・イシュータイトル・PR 本文等の
  外部由来文字列を未クォートで展開しない。変数は `"${var}"` 形式でクォートし、
  `gh` への本文受け渡しは `--body-file` / heredoc / `--body "$(cat <<'EOF' ... )"` 等の
  安全な形に限る。`eval`・バッククォート展開への外部文字列の埋め込みは禁止
- **危険指示の混入（P0）**: `--no-verify`・`--force`（force push）・フック回避・
  `rm -rf` の広域削除・`sudo` を促す手順をスキルへ埋め込まない。既存スキルの安全弁
  （create-commit のシークレット混入チェック、contribute-skill の `Fandhe-AI/` 以外への
  push 中止等）を削除・弱体化する差分は P0
- **秘密情報の混入（P0）**: 実トークン・実 API キーをスキル本文・sample・テストに
  書かない（例示はダミー値・パターン表記に限る）
- **TLS 検証無効化の拡大（P1）**: `GIT_SSL_NO_VERIFY=1` は sandbox 環境の
  ワークアラウンド（`docs/sandbox-tls.md`）に限定する。無条件・恒常的な使用を促す
  記述への変更は P1
- **CI・ワークフローの改変（P1）**: **第三者の** action・reusable workflow 呼び出しの
  SHA 固定を可動参照へ緩める変更、`permissions` の拡大、構造検証
  （`.github/scripts/check-skill-structure.sh`）・lint の弱体化。
  **`Fandhe-AI/actions`（組織内の上流リポジトリ）への参照は例外で、可変タグ `@latest` を
  使う**（2026-08-18・オーナー判断。pin の手動更新コストを避けるための組織方針であり、
  `@latest` への統一・SHA pin の除去を指摘しない）。`latest` は上流の
  `move-latest-tag.yml` が main への push ごとに付け替え、その鮮度は本リポの
  `update-external-drift.yml`（軸 2）が日次で実測する。**SHA pin の行末注記は由来を
  正確に示す**（2026-08-19・オーナー判断）: リリースタグから導出した SHA には由来タグを
  `# vX.Y.Z`（SHA と一致する正確なリリースタグ）で注記し、`# v4` 等の可動メジャータグや
  `# main` をタグ由来 SHA に書かない（誤った更新方針の示唆になる）。main 追従の SHA pin
  のみ `# main` とする。`@latest` 参照は ref 自体が由来を示すため注記不要
- **承認境界の後退（P1）**: implement-issue の「計画承認後に実装」、Issue 起票・
  破壊的操作前のユーザー確認など、既存スキルが持つ人間承認ゲートを外す変更。
  **例外基準（一般則）**: opt-in の自動マージ経路は、差分とスキル文書から**独立して
  検証可能な**次の安全要件をすべて満たす場合に限り、その存在自体は承認境界の後退と
  して指摘しない: (1) 有効化がホストの決定的コード（args パース）による明示 opt-in で
  あり、エージェントの申告・出力では有効化できない、(2) 未信頼テキスト（レビュー
  本文・PR 本文・イシュー本文等）を読むエージェントの出力がマージ可否・対象 SHA の
  決定に影響しない（マージ経路から構造的に分離されている）、(3) マージ実行エージェント
  が対象 PR の状態・HEAD SHA を自己取得して再検証し、他エージェントの申告値を使わない、
  (4) ベースブランチのサーバー側強制（bypass 不能な required status checks 等）を
  マージ前に実測検証し、確認できない場合は fail-closed でマージせず停止する、
  (5) 以上の設計がスキル文書に明記され、差分が設計どおりかをレビューで検証できる。
  これらの要件のいずれかを弱める変更、opt-in 条件を迂回・緩和する変更、fail-closed を
  外す変更、未信頼テキストをマージ実行・検証コンテキストへ持ち込む変更は P0 として扱う。
  **例外（2026-08-20・オーナー判断。(b) は 2026-08-21・#427 の判断で更新、#430 で実装済み。
  (a) の実行主体分離は 2026-08-23・#436 codex-review P0 対応で実装済み。(a) の hostPreSha
  出所是正・pushVerified AND ゲート追加は 2026-08-23・#436 追加 codex-review P0 再指摘で
  実装済み）**:
  implement-issue-tree の「対応済みレビュースレッド resolve」（`resolveReviewThread`
  mutation）は、要件 (2) の限定的例外として受容する。未信頼テキスト（レビュー本文）を
  読む fix の判断が resolve 候補の選定に影響することを認識したうえで、レビュー指摘→
  修正 push→resolve→自動マージの無人ループ成立を優先する判断である。
  **resolve mutation の実行主体は fix ではない（2026-08-23・#436 codex-review P0
  対応）**: 旧設計は Merge ループの fix（pushAfterFix=true）自身が `gh api graphql` で
  mutation を実行しており、host 側の裏取り（下記 preSha/postSha 検証）は fix のターン
  内で mutation が既に実行された後にしか働かなかった。prompt injection を受けた fix が
  形式上正しい preSha/postSha の 2 値を捏造するだけで mutation を通過させ得るという
  codex-review P0（PR #436）を受け、実行主体を fix から分離した。現在の設計:
  **(a) resolve 実行主体は host が起動する `resolveThreadsPrompt` 専用エージェントのみ
  （monitor / merge-exec / merge-verify / Review ループの fix は実行しない）**。
  resolve 候補は Merge ループの fix（pushAfterFix=true）が報告し、当該ラウンドで実際に
  head が進んだことを `resolveThreadsPrompt` 自身が独立確認できた場合のみ resolve する。
  fix は「対応したと考える候補」（`resolvedThreadIds`）を報告するのみで
  `resolveReviewThread` mutation を一切実行しない。host は fix が報告した候補を
  当該ラウンドの未解決スレッド一覧（`finding.unresolvedComments`）との交差に限定した
  うえで、未信頼テキストを一切読まない専用エージェント（`resolveThreadsPrompt`）へ渡す。
  このエージェントは branch・host 保持の `hostPreSha`（`hostPrePushHead`。下記）・候補
  threadId 一覧のみを受け取り（finding.summary・イシュータイトル・レビュー本文等は一切
  渡さない）、自ら `git ls-remote origin refs/heads/<branch>` で現在の HEAD
  （`observedHead`）を独立取得する。`observedHead` が `hostPreSha` と異なる（= head が
  実際に進んだ）ことを自ら確認できた場合に限り mutation を実行する。host
  （runMergeLoop）はこの `observedHead` と `hostPreSha` の比較（`resolveVerified`）に
  加え、下記 `pushVerified` を AND 条件として要求し、双方が true の場合のみ
  `resolveThreadsPrompt` へ resolve 候補（非空の threadIds）を渡す。fix 自己申告の
  `pushed`・`preSha`・`postSha` は mutation 実行可否の直接の根拠にはしない
  （`resolveVerified` 自体は `resolveThreadsPrompt` の独立観測のみで成立する）。
  **hostPreSha の出所（2026-08-23・#436 追加 codex-review P0 再指摘で是正）**: 旧設計は
  `resolveProof.head`（当該ラウンドの monitor が `gh pr view --json headRefOid` で
  取得し構造化出力として返す値）を `hostPreSha` に使っていたが、monitor はレビュー本文等の
  未信頼テキストを読むエージェントであり、その構造化出力の各フィールド（headSha を含む）は
  最終的にモデル自身が組み立てるため、injection を受けた monitor が任意の headSha を
  偽装し得る（= 「host が独立取得した値」の実体になっていなかった）。是正後は、fix 起動の
  直前（未信頼レビュー本文を読むいかなるエージェントより後ろに置かない）に host が
  未信頼データを一切含まないプロンプト・単一コマンドのみの専用エージェント
  （`prePushHeadPrompt`。merge-verify と同型）を都度起動し、その返り値
  （`hostPrePushHead`）のみを `hostPreSha` として使う。`resolveProof.head`（monitor
  自己申告）は (b) 経路（下記。恒久的に不成立）専用の入力としてのみ残り、(a) の
  `hostPreSha` には二度と使わない。
  **pushVerified の AND ゲート（同上・2026-08-23 是正）**: `resolveVerified`
  （`observedHead !== hostPreSha`）のみを resolve 許可根拠にすると、head が進んだ理由が
  「当該ラウンドの fix 自身の push」なのか「無関係な第三者 push・並行実行中の別ラウンド」
  なのかを区別できない（#436 追加 codex-review P0「無関係な並行 push でも resolve が
  許可される」）。`pushVerified`（`computeVerifiedPushed`。fix 自己申告の
  `preSha`/`postSha` を `hostPrePushHead` と突き合わせた値）を `resolveThreadsPrompt`
  呼び出しの AND 条件に追加し、「当該ラウンドの fix 自身の push」であることを要求する。
  `pushVerified` が false の場合は `resolveThreadsPrompt` 自体を呼ばない（mutation を
  一切実行しない）。`git push` は送るものが何もない no-op（前ラウンドで既に同内容が
  push 済み、当該ラウンドは修正コミットも base 取り込みコミットも無い）でも
  `Everything up-to-date` で exit 0 になるため、fix の自己申告だけでは「実際に head が
  進んだ」根拠にならない。`computeVerifiedPushed` は preSha/postSha が両方とも 40 桁
  hex で一致しないこと、および第 4 引数 `hostPreSha`（`hostPrePushHead`）と fix 申告
  preSha の一致を検証する。fix 自己申告の preSha/postSha が書式不備・欠落なだけで
  実際には push 済みのケースでは resolve の機会を逃すが（`resolveThreadsPrompt` 自体が
  呼ばれない）、これは意図した trade-off である（「機会損失は許容し、誤った許可拡大を
  避ける」。下記 (b) と同じ方針）。resolve mutation の実行可否は
  `resolveVerified && pushVerified` の両方で判定する。(b) resolve は
  対象修正がリモート head（`origin/<branch>`）に反映済みであることを前提とする。成立
  経路は次の 2 つに限る — 当該ラウンドの push が成功した場合、または push しなかった
  ラウンド（過去ラウンドで push 済み）では、**ホストが自ら観測した push の結果**に対し
  **ホスト側が実行する決定的照合**が成立した場合に限る。Workflow ランタイムはホスト
  コードから直接シェル・ファイルシステムへアクセスできないため（spawn したエージェントの
  みが触れる）、観測は Merge ループの各ラウンド・fix 起動より前に必ず実行される monitor
  に相乗りさせて `gh api .../compare/<host提供prevSha>...<今回headSha>` の結果
  （`compareStatus` / `changedFiles`）を取得する。**monitor はレビュー本文等の未信頼
  テキストを読むエージェントであり merge-verify（未信頼テキスト不読）と同型ではない**
  ——これは #430 のスコープ内での既知の妥協である。緩和策として、host へ渡す値は
  `sanitizeSha`（40 桁 hex）・`compareStatus` の enum・`sanitizeRepoRelPath` 通過済み
  path のみで自由文は一切通さず、**比較・許可判定はホストの決定的コード**
  （`applyResolveProofObservation` / `computePermittedNoPushResolveIds`。詳細は
  `skills/implement-issue-tree/references/automerge-design.md`「resolve 前提のホスト側
  決定的照合」）が行う設計とした。
  **(b) 経路の現状（2026-08-21・#430 codex-review P0 再指摘・PR #433 で対応）**:
  上記の緩和策は「値の形式」しか検証できず「値の真偽」は検証できない。ホスト
  （`implement-issue-tree.js`）は Workflow ランタイムの制約（`export const meta` 以外の
  top-level export 不可・child_process 等の直接シェル実行手段なし）により `gh api compare`
  を自ら実行して monitor の申告を裏取りできないため、injection を受けた monitor が虚偽の
  `ahead` + 都合の良い `changedFiles` を返せば path 一致（上界判定）を根拠に push なしでの
  resolve が許可され得るリスクは、`lastRoundPushed`・境界 (c)・fix 自身の判断・次周回
  monitor の独立再検出という多重防御だけでは見送り可能な水準まで下げ切れないと判断した。
  未信頼テキストを一切読まない専用の proof エージェント（merge-verify と同型の新設）を
  用意するまでの間、`computePermittedNoPushResolveIds` は proofState の内容に関わらず
  **常に空リストを返す**（fail-closed）よう実装済みで、(b) 経路は**恒久的に不成立**である。
  resolve が成立するのは (a)（当該ラウンドの push が成功した場合の自己修正スレッド resolve）
  のみであり、push しなかったラウンドで対応済みスレッドが残る場合は未解決のまま次ラウンドへ
  持ち越され、最終的に `required_review_thread_resolution` により人間の resolve 待ちで
  停止する（機会損失は許容し、誤った許可拡大を避ける）。**専用 proof エージェント
  （2026-08-23・#436 追加 codex-review P0 是正で `prePushHeadPrompt` として新設済み）は
  (a) の `hostPreSha`（単一の `git ls-remote` による現在 HEAD 取得）専用であり、(b) が
  必要とする「push 前後 2 点間の compare（`gh api .../compare/<prevSha>...<headSha>` の
  `status`/`changedFiles`）」は範囲外**である。(b) の follow-up（compare 結果まで
  未信頼テキスト不読で取得する proof エージェント）は引き続き未着手のまま残る。
  **fix エージェントの申告 sha はいかなる形式検証を経ても信頼境界に置かず、照合対象に
  使わない**（既存の任意の祖先 sha を「修正コミット」と申告すれば ancestry 照合を
  通過できてしまうため。未信頼なレビュー本文の記述からの推定も同様に禁止）。ホスト側照合が
  **不成立の場合、または sha を確定できない場合は resolve を実行しない（fail-closed）**
  （「ファイル内容への反映確認でも可」という旧代替経路は誰がどの範囲を照合するかが
  未定義になり、未信頼テキストを読む fix の自己判断だけで別の既存変更を対象修正と
  誤認して `required_review_thread_resolution` ゲートを解除し得るため廃止した）。
  未コミット・未 push の修正（ローカルにのみ存在する修正）に対する resolve は前提を
  満たさず禁止、(c) 対象は monitor の構造化出力由来で host が `sanitizeThreadId` 検証
  した threadId に限定（fix がスレッド一覧を自前再取得して対象を広げない）、(d)
  out-of-scope 判断のスレッドは resolve せず人間に委ねる。この (a)〜(d) を弱める
  変更・resolve 主体や対象を拡大する変更、(b) 経路を再度有効化する変更は引き続き
  P0 として指摘する

## 2. アーキテクチャ・設計整合の観点

- **スキル書式規約（P1）**: `skills/<name>/SKILL.md` は YAML frontmatter
  （`name` はディレクトリ名と一致・`description` は発火条件を含む）+ 手順の構成に従う
  （`.claude/rules/skill-authoring.md` / `description-style.md`）。frontmatter 不正・
  name 不一致・symlink リンク切れは CI（structure ジョブ）でも落ちる
- **symlink 構成の維持（P1）**: 新スキル追加時は `.claude/skills/<name>` への symlink と
  `CLAUDE.md` のスキル一覧更新を伴う（`create-skill` スキルの手順）。実ディレクトリ配置は
  リポジトリ管理スキル（create-skill / create-agent）・参照スキルの既存例外に限る
- **エージェント・ルールの責務境界（P1）**: `.claude/agents/` は research（読み取り専用）/
  author / quality（読み取り専用）のカテゴリ責務に従う。読み取り専用エージェントへ
  編集責務を足す変更、`dotclaude-via-temp.md`（`.claude/` 直接編集の禁止）に反する
  手順記述は指摘する
- **フロー構成の一貫性（P2）**: スキルの手順は Step 分割・確認コマンド・失敗時の案内を
  持つ既存スキルの構成に揃える。sandbox 節（「sandbox 環境での実行」）を持つ規約に
  従い、リモート操作の要否分類を記述する
- **model 指定の整合（P2）**: frontmatter の `model` は用途基準
  （判定・生成 = sonnet / 機械処理 = haiku / 複雑計画 = opus）と整合させる

## 3. 再利用・アセット化の観点（重点）

- **リポジトリ非依存性（P1）**: スキル本文へ特定リポジトリの固有パス・固有イシュー番号・
  固有ブランチ名をハードコードしない。導入先で変わる値は引数・プレースホルダ・
  「対象リポジトリの規約に従う」形の記述にする（sample/ での例示は可）
- **導入先互換性（P1）**: 既存スキルの引数仕様・出力契約（他スキル・workflow js が
  parse する形式）を変える場合は破壊的変更として明示し、依存スキル
  （例: implement-issue-tree → create-pr / implement-review）への影響を PR に記載する
- **ツール前提の明示（P1）**: スキルが前提とする CLI（`gh`・`jq`・`node` 等）と
  認証状態は本文へ明記し、存在チェック（`command -v`）または失敗時の案内を添える。
  導入先の環境を暗黙に仮定しない
- **自己完結性（P2）**: スキルは SKILL.md（+ 同ディレクトリの sample / script）で完結させ、
  本リポジトリ外のファイルへの相対参照を持ち込まない
- **ドキュメント追随（P2）**: スキル・エージェント・ルールの追加変更は `CLAUDE.md` /
  `README.md` の一覧・ツリーを同時に更新する（`update-docs` スキル）。
  skills-lock.json を利用する導入先（sync-skills-lock）への影響がある場合は言及する

## リポジトリ固有の観点

- **日本語出力（P2）**: スキルの出力・レポートは日本語。description は発火率を意識した
  文体規約（`description-style.md`）に従う
- **コミット規約（P2）**: 日本語 Conventional Commits（`conventional-commits.md`）。
  `--no-verify` の使用を促す・前提とする記述は P1
- **参照スキルの書式（P2）**: reference 型スキル（github-docs 等）は
  `reference-template.md` の reference/*.md + README 索引の書式に従う

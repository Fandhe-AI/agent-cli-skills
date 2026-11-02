---
name: sweep-sync-prs
description: >
  Fandhe-AI のスキル同期 PR（chore/skills-update-YYYYMMDD）を直近 N 日分棚卸しし、詰まりの類型ごとに対処して全件マージまで見届ける。
  「同期 PR をマージまで対応して」「スキル更新 PR が止まっている」「skills-update PR を棚卸しして」で使用。
  上流修正は implement-issue、ruleset 導入は setup-repo-guards を参照。
model: sonnet
user-invocable: true
argument-hint: "[days] (例: sweep-sync-prs 7。既定 7 日)"
---

# sweep-sync-prs

`Fandhe-AI/actions` の `update-external.yml` が作る `chore/skills-update-YYYYMMDD` ブランチの同期 PR を、直近 N 日（既定 7 日）に更新があった全リポで棚卸しする。マージされていない PR は詰まりの類型ごとに対処し、全件マージされるまで見届ける。

本スキルは `.claude/skills/` の実ディレクトリに置くリポジトリ管理スキルで、下流へは配布しない。類型ごとの手順・実例は `references/triage.md` にあり、順序規則と停止ルールの正典は本ファイルに置く。

## 使い方

```
/sweep-sync-prs        # 直近 7 日
/sweep-sync-prs 14     # 直近 14 日
```

| 引数 | 必須 | 説明 |
| --- | --- | --- |
| `days` | 任意 | 棚卸し対象の日数 N（既定 7） |

前提(ツール):

| 区分 | コマンド |
| --- | --- |
| 常時必要 | `gh`(認証済み)、`git`、`jq`、`awk`(Step 1 の canary 判定で使用)、`wc`・`printf`(POSIX 標準) |
| 上流修正のときだけ必要 | `node`(implement-issue-tree のビルド `build-workflow.mjs` とテスト `node --test`) |

開始時に次を実行し、不足があれば処理を始めずに停止して、導入を案内する(`gh` は `brew install gh` など、`jq` は `brew install jq` など)。`Fandhe-AI` 組織のリポジトリを参照できない場合も停止して報告する。

```bash
missing=""
for c in gh git jq awk; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
[ -z "$missing" ] || { echo "未導入のコマンド:$missing。導入してから再実行する"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh が未認証。gh auth login を案内して停止する"; exit 1; }
```

上流修正を行う場合は、そのときに `command -v node` も確認する。ネットワーク越しの GitHub 操作（`gh`・`git fetch`）を必須とするため、該当コマンドはコマンド単位で sandbox 無効にして実行する（`docs/sandbox-tls.md` 参照）。ネットワーク遮断を解除できない環境では実行できない。

## 進め方の原則

- main は対話・計画・判断・報告に徹する。機械的な棚卸しは haiku のサブエージェント、上流の実装は sonnet のサブエージェント（`isolation: worktree`）、独立レビューは sonnet に任せる。
- PR が多い（目安 10 件超）場合、ユーザーが明示したときに限り Workflow で並列化してよい。
- ユーザーが別の作業をしているリポジトリを触るときは、必ず worktree を作る。
- 詰まったら、main が過去のコメント（スレッド全件・PR コメント・過去巡の指摘）をすべて読んでから実装計画を立て、サブエージェントに実装させる。
- 待機には Monitor かバックグラウンドの `until` ループを使い、フォアグラウンドで sleep しない。
- zsh では未クォートの展開が単語分割されない。ループで複数の値を渡すときは `set -- $x` ではなく `read -r a b` で分割する。
- `gh api` のエラーは stdout に出る。存在の判定は終了コードか HTTP status で行う。
- サブエージェントの「PR を作った」報告は捏造があり得る。`gh pr view` で実在を確かめる。
- 外部 API を叩くサブエージェントへの指示、秘密情報・メールアドレスの扱いは「注意事項」に従う。

## フロー

### Step 1: 棚卸し（haiku サブエージェントに委譲）

1. 対象リポ: `gh repo list Fandhe-AI --limit 300 --no-archived --json name,pushedAt` のうち、`pushedAt` が N 日以内のもの。
2. open の同期 PR: 次の 2 通りで検索し、和集合を取る。`chore/submodule-update-*`（docs/spec などの submodule 更新）はスキル同期ではないので、報告に載せるだけで対象外にする。
   ```bash
   gh search prs --owner Fandhe-AI --state open "エージェントスキルを最新に更新"
   gh search prs --owner Fandhe-AI --state open --head chore/skills-update-   # head は前方一致（実測済み）
   ```
3. 各リポの同期 workflow の最新 run。workflow 名はここで 1 か所だけ定義し、Step 7 と `references/triage.md` でも同じ定義を使う。
   ```bash
   W=$([ "$r" = actions ] && echo update-external-self.yml || echo update-external.yml)
   gh run list --workflow "$W" -R "Fandhe-AI/$r" -L 1 --json conclusion,status,createdAt
   ```
   結論を次に分類する。「run 0 件」（終了コード 0・出力が空）と「workflow なし」（workflow が存在せず終了コード 1 で失敗）は別の分類にする。
   - success / failure / cancelled / in_progress
   - run なし（workflow はあるが run 0 件）
   - workflow なし
4. PR が無いリポは open PR の検索だけでは漏れる。canary の blob sha で鮮度を判定する。
   ```bash
   git fetch origin
   git rev-parse origin/main:skills/implement-issue-tree/scripts/implement-issue-tree.src.js
   f=repos/Fandhe-AI/$r/contents/.agents/skills/implement-issue-tree/scripts/implement-issue-tree.src.js
   code=$(gh api -i "$f" 2>/dev/null | awk 'NR==1{print $2}')
   case "$code" in
     200) gh api "$f" --jq .sha ;;
     404) echo "canary なし（未導入。鮮度は判定不能として報告）" ;;
     *)   echo "判定不能 (HTTP ${code:-?})" ;;
   esac
   ```
   2 つの sha が一致しなければ古い。
5. 各 PR について、mergeStateStatus・autoMergeRequest・失敗または pending のチェック・未解決のレビュースレッド（GraphQL の `reviewThreads`）・`Cursor Bugbot` の check-run の有無と、それが HEAD に対するものかを取得する。

### Step 2: 詰まりの類型を判定する

PR ごとに下表の入口で類型を決め、対処の詳細は `references/triage.md` に従う。

| 症状 | 類型 |
| --- | --- |
| required の `Cursor Bugbot` がチェック一覧に無く Expected のまま | Bugbot 未起動 |
| オーナーの workflow_dispatch が in_progress、または直後に後続 PR ができた | 手動 run 待ち |
| autoMergeRequest が null | auto-merge 欠落 |
| Bugbot / codex の未解決スレッドが残る | 未解決スレッド |
| 同じ箇所への指摘が 3 巡続く | 連鎖指摘 |
| チェックが failure | CI 失敗 |
| base が古い / required check が「expected」のまま固まる | 古い base・固着 |
| Bugbot が `TOO_LARGE_TO_REVIEW`（差分 4 万行超） | Bugbot 対象外 |
| 条件は満たすのに resolve 後も auto-merge が発火しない | 発火漏れ |
| 同期 run が cancel / ハングして PR が無い | run 異常 |
| run なし・workflow なし・ラベル欠落・ruleset 無し | 新設リポ |

### Step 3: 承認なしで進める対処（順序規則と停止ルールの正典）

`references/triage.md` の類型ごとの手順を実行する。次の規則は本節が正典で、triage.md は本節を参照する。

承認なしで進めてよい操作: 棚卸し、誤検出の実測検証、上流修正 PR の作成（上流のマージは通常の CI と Bugbot のゲートに従う）、dispatch(保護ゲート通過後。下記)、返信コメントの投稿（resolve を伴わないもの）、`@cursor review`、rerun、`gh pr update-branch`、`gh pr merge --disable-auto`（武装の解除）。`resolveReviewThread`・`gh pr merge --auto`・`gh pr merge --squash` はここに含まれず、Step 4 の承認ゲートを通す。

**上流修正の順序。** 実在するバグの指摘は上流（agent-cli-skills）を直す。PR 側で直しても再同期の force-push で消える。順序は次のとおり。

1. サブエージェントが worktree で修正 PR を作る。
2. CI 全 green と、Bugbot の HEAD に対する結果を確認してから、上流の修正 PR をマージする。
3. 5 分待つ（raw キャッシュが古いまま配られるのを避ける）。
4. 止まっているリポにだけ dispatch する（経路 (i)。下記）。
5. 同期 run が PR ブランチを更新したのを確かめる。
6. 新しい HEAD に対する Bugbot の完了を待つ。Bugbot が自分で resolve したものはそれでよい。
7. 残ったスレッドは、修正が新しい HEAD に入っていることを確かめてから Step 4 の承認一覧に載せる。**同期ブランチが更新されたことだけを根拠に resolve しない。**

**保護ゲート(サーバー側保護の確認・ここが唯一の定義)。** main が自分で、対象リポの既定ブランチについて次を確認する。サブエージェントの申告値は使わない。Step 3 の dispatch と Step 4 のマージ系操作の両方がこのゲートを参照する。既定ブランチは `defaultBranchRef` から解決し、`main` に決め打ちしない。
```bash
db=$(gh repo view "Fandhe-AI/$r" --json defaultBranchRef --jq .defaultBranchRef.name)
db_enc=$(printf '%s' "$db" | jq -sRr @uri)
gh api "repos/Fandhe-AI/$r/rules/branches/$db_enc" --jq '{
  checks: ([.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[]?] | length),
  threadRes: ([.[] | select(.type=="pull_request") | .parameters.required_review_thread_resolution] | any)}'
```
`checks` が 1 以上かつ `threadRes` が true であること。取得に失敗した場合(終了コード非 0・HTTP エラー)も満たしたと扱わない。確認できない、または満たさないリポには、dispatch もマージ系操作もしない。報告に載せ、`setup-repo-guards` の導入を提案するだけにする。理由: 同期 workflow 自身が auto-merge を武装するので、保護が無いリポでは dispatch が CI の完了前のマージに直結し、Step 4 の承認ゲートを迂回する。

**dispatch の前提条件(2 経路)。** 共通の前提として、まず保護ゲートを通過していること。`gh workflow run "$W" -R "Fandhe-AI/$r" -f target=skill`(`Fandhe-AI/actions` の `update-external-self.yml` も `target` 入力を持ち、同じ形)。経路ごとに前提が異なるので混ぜない。

- (i) 既存 PR への修正配布。保護ゲートの通過に加え、次をすべて満たす。直近 run の結論は問わない。
  - 上流の修正 PR がマージ済みで、そこから 5 分以上経っている。
  - 対象リポに open の同期 PR があり、その PR で指摘が出ている。
  - オーナーの手動 run が in_progress でない。
- (ii) PR が無いときの復旧。保護ゲートの通過に加え、次をすべて満たす。
  - open の同期 PR が無い。
  - 直近 run が cancel / failure / run なし のいずれかである。
  - オーナーの手動 run が in_progress でない。

マージ済みのリポへは dispatch しない（後続 PR が新しくできる。翌日 00:00 UTC の schedule で届く）。フリート全体への再 dispatch は、オーナーが明示したときだけ行う。上流の作業が途中なら最新化しない。

**ラベル作成。** `dependencies` / `automated` ラベルの作成は、同期 PR を作るための最小限で取り消せる前提作業なので、承認なしで行ってよい。ただし保護ゲートを通過し dispatch する場合に限る(dispatch しないなら不要)。報告に必ず載せる。

**3 巡ルール。** 同じ箇所への指摘が 3 巡続いたら、修正しない。

1. スレッドは**未解決のまま**残す。
2. 上流で issue 化し、スレッドに issue へのリンクを返信する（resolve はしない）。
3. 停止してオーナーの判断を待つ。報告に「オーナー判断待ち」として載せる。
4. リポに `required_review_thread_resolution` が無く auto-merge が武装済みなら、`gh pr merge <n> -R "Fandhe-AI/$r" --disable-auto` で解除し、報告する。

オーナーが「直して」と明示したら続ける。

### Step 4: 承認ゲートとマージ系操作の前提

スキルは人間が呼ぶ対話セッションで動く。次の操作は、オーナーが同じセッションで明示的に承認した場合に限り実行する。承認は AskUserQuestion で取る。対象を一覧にして根拠を添えたうえで、まとめて 1 回で取ってよい。

- `resolveReviewThread`(誤検出への返信 + resolve、修正配布後に残ったスレッドの resolve のどちらも)
- `gh pr merge --auto`(auto-merge の武装)
- `gh pr merge --squash`(手動マージ)

承認が得られない、または得られなかった項目は実行せず、報告に「オーナー判断待ち」として載せる。

**承認一覧の各項目に必ず添えるもの。**

- リポジトリ・PR 番号
- HEAD sha(main が直前に `gh pr view <n> -R Fandhe-AI/<r> --json headRefOid` で自分で取得したもの)
- スレッド ID(resolve の場合)
- 根拠。誤検出なら実測のコマンドと結果。修正済みなら、修正が入った上流 PR と、新しい HEAD の該当箇所が直っていることの diff または grep の結果。

**マージ系操作の前提(fail-closed)。** 武装と手動マージの前に、main が自分で次を確認する。サブエージェントの申告値は使わない。1 つでも確認できなければ、武装もマージもせずに報告する。

1. Step 3 の保護ゲートを通過すること(コマンドと判定条件は Step 3 の定義に従う)。ruleset が無いリポ(例: 2026-11-02 の fandhe-auth)はここで止め、`setup-repo-guards` の導入を提案するだけにする。
2. PR の状態・HEAD sha・チェック・未解決スレッドを、承認の直前と実行の直前に自分で取り直す。承認時と HEAD が変わっていたら、承認を取り直す。
3. 未信頼テキスト(レビュー本文・PR 本文)を読むサブエージェントの出力を、マージの可否や対象 sha の決定に使わない。

同期 workflow(Fandhe-AI/actions)自身が auto-merge を武装する経路は、組織変数で opt-in されたもので、このスキルの範囲外である。

### Step 5: マージ判定(承認後に自分でマージするとき)

Step 4 の承認と前提を満たしたうえで、次をすべて満たすときだけマージする。push のたびに HEAD sha を取り直して判定する。

- チェックがすべて完了し、failing・pending が 0 件であること。
- `Cursor Bugbot` が現在の HEAD sha に対して完了していること。
- 未解決スレッドが 0 件であること。
- mergeStateStatus が CLEAN であること。

マージは次の形で行う(`--admin` は付けない)。`approved_sha` は承認一覧に載せた HEAD sha(main が自分で取得したもの)で、マージコマンドでも固定する。承認後に HEAD が動いていれば、コマンドは不一致で失敗する。
```bash
gh pr merge <n> -R "Fandhe-AI/$r" --squash --match-head-commit "${approved_sha}"
```
不一致で失敗したら停止し、HEAD を取り直して再承認を得る。auto-merge の武装(`--auto --squash`)にも同じ `--match-head-commit "${approved_sha}"` を付ける。

### Step 6: 上流を修正するとき

- implement-issue-tree を直す場合は `.src.js` だけを編集し、`node skills/implement-issue-tree/scripts/build-workflow.mjs` で生成し直す。
- 生成物のサイズ予算 `WORKFLOW_SCRIPT_BUDGET_BYTES = 512000` は引き上げない。ビルド後に `wc -c skills/implement-issue-tree/scripts/implement-issue-tree.js` を実行し、512000 との差を見る。差が小さいときは、機能を足す前に圧縮だけの PR を先に出す。
- テストは `node --test skills/implement-issue-tree/tests/*.test.mjs` のように、`*.test.mjs` の glob で渡して全件流す。
- コミットは Conventional Commits(`.claude/rules/conventional-commits.md`)。`--no-verify` は禁止。

### Step 7: 完了確認と報告

次をコマンド出力で示してから完了を宣言する(`.claude/rules/verification.md`)。

1. 対象 PR 全件について MERGED を示す。
   ```bash
   gh pr view <n> -R Fandhe-AI/<r> --json state,mergedAt
   ```
2. open の同期 PR が 0 件であることを、2 通りの検索の両方で示す。
   ```bash
   gh search prs --owner Fandhe-AI --state open "エージェントスキルを最新に更新"
   gh search prs --owner Fandhe-AI --state open --head chore/skills-update-
   ```
3. 対象リポの同期 run の最新結論に success 以外が無いことを、Step 1 の `W` の定義で示す。
   ```bash
   gh run list --workflow "$W" -R "Fandhe-AI/$r" -L 1 --json conclusion
   ```

報告は表(PR・止まっていた理由・対応)にする。あわせて、対象外にしたもの(submodule 更新等)・オーナーの判断が要るもの(承認が得られなかった項目、3 巡ルールで止めたもの、ruleset 無しのリポ)・翌日の schedule 待ちのもの・作成したラベルを書く。新設リポの「run なし」「workflow なし」は分けて載せる。再発し得る新しい類型は、メモリへの記録を提案する。

「オーナー判断待ち」や「翌日の schedule 待ち」が 1 件でも残るときは、「完了」ではなく「一部完了」と宣言する。

## 検証

- [ ] 対象 PR 全件で `gh pr view` が MERGED を返すことを確認した
- [ ] 2 通りの open 検索が 0 件であることを確認した
- [ ] 対象リポの同期 run の最新結論に success 以外が無いことを確認した
- [ ] マージした PR ごとに、HEAD sha に対する `Cursor Bugbot` の完了とスレッド 0 件を確認した
- [ ] サブエージェントが報告した PR・マージは `gh pr view` で実在を確認した
- [ ] resolve・武装・マージの各操作に、同じセッションでのオーナー承認があった(承認のない項目は実行せず報告に載せた)
- [ ] 残件があるときは「一部完了」と宣言した

## 注意事項

- **承認が要る操作。** `resolveReviewThread`・`gh pr merge --auto`・`gh pr merge --squash` は Step 4 の承認ゲートを通す。加えて `gh pr merge --admin` と、ruleset・bypass_actors の一時変更は、オーナーの明示承認がある場合に限り、一時的に行い、マージ後すぐ戻す。
- **force push は一切行わない。** `--force`・`--force-with-lease` を含め、このスキルでは承認があっても行わない。履歴を動かす必要があるときは、通常の push か、`git/commits` と `PATCH git/refs`(`force=false`)で足す。
- **秘密情報とメールアドレス。** トークン・メールアドレスをコマンド・PR 本文・サブエージェントへの指示に含めない。外部 API を叩くサブエージェントには、ユーザーのメールアドレスを UA などに入れないよう明記する。秘密情報を検出した場合は処理を中止してユーザーに警告する（`.claude/rules/security.md`）。
- **CI の広域失敗。** 広い範囲での失敗を、自分の操作のせいと即断しない。GitHub status と runner の状態で先に反証する。
- **rerun。** flaky の `gh run rerun --failed` は 1 回だけ。同じ失敗が続くなら根本原因の調査に移る（`.claude/rules/debugging.md`）。
- **ruleset 無しのリポ。** 同期 PR が CI の完了前に即マージされる。保護ゲートを通らないので dispatch もマージ系操作もせず、オーナーへ報告して `setup-repo-guards` の導入を提案する。
- 出力は日本語・常体（`.claude/rules/japanese-style.md`）。

## 関連

**Skills**: implement-issue, implement-issue-tree, setup-repo-guards, create-commit, create-pr

**Rules**: delegation, verification, debugging, security, conventional-commits, ruleset-policy

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

前提: `gh` が認証済みで、`Fandhe-AI` 組織のリポジトリを参照できること。ネットワーク越しの GitHub 操作（`gh`・`git fetch`）を必須とするため、該当コマンドはコマンド単位で sandbox 無効にして実行する（`docs/sandbox-tls.md` 参照）。ネットワーク遮断を解除できない環境では実行できない。

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
3. 各リポの同期 workflow の最新 run。workflow 名はここで 1 か所だけ定義し、Step 6 と `references/triage.md` でも同じ定義を使う。
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

### Step 3: 対処を実行する（順序規則と停止ルールの正典）

`references/triage.md` の類型ごとの手順を実行する。次の規則は本節が正典で、triage.md は本節を参照する。

**上流修正の順序。** 実在するバグの指摘は上流（agent-cli-skills）を直す。PR 側で直しても再同期の force-push で消える。順序は次のとおり。

1. サブエージェントが worktree で修正 PR を作る。
2. CI 全 green と、Bugbot の HEAD に対する結果を確認してからマージする。
3. 5 分待つ（raw キャッシュが古いまま配られるのを避ける）。
4. 止まっているリポにだけ `gh workflow run "$W" -R "Fandhe-AI/$r" -f target=skill` で dispatch する（`Fandhe-AI/actions` の `update-external-self.yml` も `target` 入力を持ち、同じ形で dispatch できる）。
5. 同期 run が PR ブランチを更新したのを確かめる。
6. 残ったスレッドを resolve する（Bugbot が自分で resolve することも多い）。

**スレッドの resolve は dispatch の後に行う。** 先に resolve すると、auto-merge 武装済みの PR が旧内容のままマージされる。

**誤検出スレッドを resolve する前の確認。** resolve すると、auto-merge 武装済みの PR は直ちにマージされ得る。次をすべて確かめてから resolve する。

- 同じ PR に実在バグのスレッドが残っていない。
- Bugbot が現在の HEAD に対して完了している。

**再 dispatch の前提条件。** 次をすべて満たすときだけ dispatch する。

- 当該リポに open の同期 PR が無い（既存 PR は上の順序で更新される。重ねて新しい PR を作らない）。
- 直近の run が cancel / failure / 無し（run なし・workflow なし）である。
- オーナーの手動 run が in_progress でない。

マージ済みのリポへは dispatch しない（後続 PR が新しくできる。翌日 00:00 UTC の schedule で届く）。フリート全体への再 dispatch は、オーナーが明示したときだけ行う。上流の作業が途中なら最新化しない。

**ラベル作成。** `dependencies` / `automated` ラベルの作成は、同期 PR を作るための最小限で取り消せる前提作業なので、承認なしで行ってよい。ただし報告に必ず載せる。

**3 巡ルール。** 同じ箇所への指摘が 3 巡続いたら、修正せずに上流で issue 化し、返信して resolve したうえでオーナーに判断を仰ぐ。オーナーが「直して」と明示したら続ける。

**オーナー承認が要る操作。** bypass の一時付与・空コミットは、オーナーの承認を得てから行う（詳細は「注意事項」）。

### Step 4: マージ判定（自分でマージするとき）

次をすべて満たすときだけマージする。push のたびに HEAD sha を取り直して判定する。

- チェックがすべて完了し、failing・pending が 0 件であること。
- `Cursor Bugbot` が現在の HEAD sha に対して完了していること。
- 未解決スレッドが 0 件であること。
- mergeStateStatus が CLEAN であること。

マージは `gh pr merge <n> -R Fandhe-AI/<r> --squash` で行う（`--admin` は付けない）。

### Step 5: 上流を修正するとき

- implement-issue-tree を直す場合は `.src.js` だけを編集し、`node skills/implement-issue-tree/scripts/build-workflow.mjs` で生成し直す。
- 生成物のサイズ予算 `WORKFLOW_SCRIPT_BUDGET_BYTES = 512000` は引き上げない。ビルド後に `wc -c skills/implement-issue-tree/scripts/implement-issue-tree.js` を実行し、512000 との差を見る。差が小さいときは、機能を足す前に圧縮だけの PR を先に出す。
- テストは `node --test skills/implement-issue-tree/tests/*.test.mjs` のように、`*.test.mjs` の glob で渡して全件流す。
- コミットは Conventional Commits（`.claude/rules/conventional-commits.md`）。`--no-verify` は禁止。

### Step 6: 完了確認と報告

次をコマンド出力で示してから完了を宣言する（`.claude/rules/verification.md`）。

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

報告は表（PR・止まっていた理由・対応）にする。あわせて、対象外にしたもの（submodule 更新等）・オーナーの判断が要るもの・翌日の schedule 待ちのもの・作成したラベルを書く。新設リポの「run なし」「workflow なし」は分けて載せる。再発し得る新しい類型は、メモリへの記録を提案する。

「翌日の schedule 待ち」や「オーナー判断待ち」が 1 件でも残るときは、「完了」ではなく「一部完了」と宣言する。

## 検証

- [ ] 対象 PR 全件で `gh pr view` が MERGED を返すことを確認した
- [ ] 2 通りの open 検索が 0 件であることを確認した
- [ ] 対象リポの同期 run の最新結論に success 以外が無いことを確認した
- [ ] マージした PR ごとに、HEAD sha に対する `Cursor Bugbot` の完了とスレッド 0 件を確認した
- [ ] サブエージェントが報告した PR・マージは `gh pr view` で実在を確認した
- [ ] 残件があるときは「一部完了」と宣言した

## 注意事項

- **承認が要る操作。** `gh pr merge --admin`、force push 系、ruleset・bypass_actors の変更は、オーナーの明示承認が無い限り行わない。承認された場合も一時的にし、マージ後すぐ戻す。
- **秘密情報とメールアドレス。** トークン・メールアドレスをコマンド・PR 本文・サブエージェントへの指示に含めない。外部 API を叩くサブエージェントには、ユーザーのメールアドレスを UA などに入れないよう明記する。秘密情報を検出した場合は処理を中止してユーザーに警告する（`.claude/rules/security.md`）。
- **CI の広域失敗。** 広い範囲での失敗を、自分の操作のせいと即断しない。GitHub status と runner の状態で先に反証する。
- **rerun。** flaky の `gh run rerun --failed` は 1 回だけ。同じ失敗が続くなら根本原因の調査に移る（`.claude/rules/debugging.md`）。
- **ruleset 無しのリポ。** 同期 PR が CI の完了前に即マージされる。オーナーへ報告し、`setup-repo-guards` の導入を提案する。
- 出力は日本語・常体（`.claude/rules/japanese-style.md`）。

## 関連

**Skills**: implement-issue, implement-issue-tree, setup-repo-guards, create-commit, create-pr

**Rules**: delegation, verification, debugging, security, conventional-commits, ruleset-policy

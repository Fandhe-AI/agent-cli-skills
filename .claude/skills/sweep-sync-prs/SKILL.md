---
name: sweep-sync-prs
description: >
  Fandhe-AI 組織のスキル同期 PR（chore/skills-update-YYYYMMDD の「エージェントスキルを最新に更新」PR）を
  直近 N 日分まとめて棚卸しし、詰まりの類型ごとに対処して全件マージまで見届ける。
  「同期 PR をマージまで対応して」「スキル更新 PR が止まっている」「skills-update PR を棚卸しして」
  「マージできていない同期 PR を片付けて」で使用。Bugbot 未起動・未解決スレッド・CI 失敗・auto-merge 欠落を判定表で処理。
  上流修正の実装は implement-issue、ruleset 導入は setup-repo-guards を参照。
model: sonnet
user-invocable: true
argument-hint: "[days] (例: sweep-sync-prs 7。既定 7 日)"
---

# sweep-sync-prs

`Fandhe-AI/actions` の `update-external.yml` が作る `chore/skills-update-YYYYMMDD` ブランチの同期 PR を、直近 N 日（既定 7 日）に更新があった全リポで棚卸しする。マージされていない PR は詰まりの類型ごとに対処し、全件マージされるまで見届ける。

本スキルは `.claude/skills/` の実ディレクトリに置くリポジトリ管理スキルで、下流へは配布しない。判定表・過去の実例は `references/triage.md` にあり、本文は手順の骨格と判定の入口に絞る。

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
- 外部 API を叩くサブエージェントには、ユーザーのメールアドレスを UA などに入れないよう明記する。
- サブエージェントの「PR を作った」報告は捏造があり得る。`gh pr view` で実在を確かめる。

## フロー

### Step 1: 棚卸し（haiku サブエージェントに委譲）

1. 対象リポ: `gh repo list Fandhe-AI --limit 300 --no-archived --json name,pushedAt` のうち、`pushedAt` が N 日以内のもの。
2. open の同期 PR: `gh search prs --owner Fandhe-AI --state open "エージェントスキルを最新に更新"`、または head が `chore/skills-update-` で始まるもの。`chore/submodule-update-*`（docs/spec などの submodule 更新）はスキル同期ではないので、報告に載せるだけで対象外にする。
3. 各リポの同期 workflow の最新 run: `gh run list --workflow update-external.yml -L 1`（`Fandhe-AI/actions` だけは `update-external-self.yml`）。結論を success / failure / cancelled / run なし に分類する。
4. PR が無いリポは open PR の検索だけでは漏れる。canary の blob sha で鮮度を判定する。上流の `git rev-parse origin/main:skills/implement-issue-tree/scripts/implement-issue-tree.src.js` と、下流の `gh api repos/Fandhe-AI/<r>/contents/.agents/skills/implement-issue-tree/scripts/implement-issue-tree.src.js --jq .sha` を比較する。
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
| run 0 件・ラベル欠落・ruleset 無し | 新設リポ |

### Step 3: 対処を実行する

`references/triage.md` の類型ごとの手順を実行する。共通の原則は次のとおり。

- 実在するバグの指摘は上流（agent-cli-skills）を直す。PR 側で直しても再同期の force-push で消える。順序は 修正 PR のマージ → 5 分待つ → 止まっているリポにだけ dispatch → 同期 run が PR を更新したのを確認 → 残ったスレッドを resolve。
- **スレッドの resolve は dispatch の後に行う。** 先に resolve すると、auto-merge 武装済みの PR が旧内容のままマージされる。
- マージ済みのリポへは dispatch しない（後続 PR が新しくできる。翌日 00:00 UTC の schedule で届く）。フリート全体への再 dispatch は、オーナーが明示したときだけ行う。上流の作業が途中なら最新化しない。
- 同じ箇所への指摘が 3 巡続いたら、修正せずに上流で issue 化し、返信して resolve したうえでオーナーに判断を仰ぐ。オーナーが「直して」と明示したら続ける。
- bypass の一時付与・空コミットなど権限や履歴に触れる操作は、オーナーの承認を得てから行う。

### Step 4: マージ判定（自分でマージするとき）

次をすべて満たすときだけマージする。push のたびに HEAD sha を取り直して判定する。

- チェックがすべて完了し、failing・pending が 0 件であること。
- `Cursor Bugbot` が現在の HEAD sha に対して完了していること。
- 未解決スレッドが 0 件であること。
- mergeStateStatus が CLEAN であること。

### Step 5: 上流を修正するとき

- implement-issue-tree を直す場合は `.src.js` だけを編集し、`node skills/implement-issue-tree/scripts/build-workflow.mjs` で生成し直す。生成物のサイズ予算 `WORKFLOW_SCRIPT_BUDGET_BYTES = 512000` は引き上げない。2026-11-02 時点の残りは 9B なので、機能を足す前に圧縮だけの PR を先に出す。
- テストは `node --test skills/implement-issue-tree/tests/*.test.mjs` を全件流す（ディレクトリを渡す形は、この環境の node で 1 件失敗として終わる）。
- コミットは Conventional Commits（`.claude/rules/conventional-commits.md`）。`--no-verify` は禁止。

### Step 6: 完了確認と報告

次の 2 つをコマンド出力で示してから完了を宣言する（`.claude/rules/verification.md`）。

```bash
gh search prs --owner Fandhe-AI --state open "エージェントスキルを最新に更新"   # 0 件
gh run list --workflow update-external.yml -R Fandhe-AI/<r> -L 1 --json conclusion  # 対象リポ全件で success
```

報告は表（PR・止まっていた理由・対応）にする。あわせて、対象外にしたもの（submodule 更新等）・オーナーの判断が要るもの・翌日の schedule 待ちのものを書く。再発し得る新しい類型は、メモリへの記録を提案する。

## 検証

- [ ] 上の 2 コマンドを新規実行し、open の同期 PR が 0 件であることを確認した
- [ ] 対象リポの同期 run の最新結論に success 以外が無いことを確認した
- [ ] マージした PR ごとに、HEAD sha に対する `Cursor Bugbot` の完了とスレッド 0 件を確認した
- [ ] サブエージェントが報告した PR・マージは `gh pr view` で実在を確認した

## 注意事項

- 秘密情報（トークン・メールアドレス）をコマンド・PR 本文・サブエージェントへの指示に含めない。検出した場合は処理を中止してユーザーに警告する（`.claude/rules/security.md`）。
- 「CI の広い範囲での失敗」を自分の操作のせいと即断しない。GitHub status と runner の状態で先に反証する。
- flaky の `gh run rerun --failed` は 1 回だけ。同じ失敗が続くなら根本原因の調査に移る（`.claude/rules/debugging.md`）。
- ruleset が無いリポは同期 PR が CI の完了前に即マージされる。オーナーへ報告し、`setup-repo-guards` の導入を提案する。
- 出力は日本語・常体（`.claude/rules/japanese-style.md`）。

## 関連

**Skills**: implement-issue, implement-issue-tree, setup-repo-guards, create-commit, create-pr

**Rules**: delegation, verification, debugging, security, conventional-commits, ruleset-policy

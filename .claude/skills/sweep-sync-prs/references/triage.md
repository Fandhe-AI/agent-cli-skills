# 同期 PR の詰まり類型と対処

`SKILL.md` Step 2・3 の詳細。類型ごとに「見分け方 → 対処」を記す。日付つきの事例は実績であり、再現手順の根拠として使う。

## Bugbot 未起動

- 見分け方: required の `Cursor Bugbot` がチェック一覧に無く Expected のまま。
- 対処: `gh pr comment <n> --body "@cursor review"` で起動する（ユーザー指示）。オーナーが既に投稿済みなら重ねない。
- 30 分ほど反応が無ければ、代替として `bugbot run` を試す（2026-08-17 に `@cursor review` が効かず `bugbot run` で起動した実績がある）。

## 手動 run 待ち

- 見分け方: オーナーの workflow_dispatch が in_progress、または直後に後続 PR ができた。
- 対処: 待機する。重ねて dispatch しない。手動 run が作った後続 PR も、マージまで見届ける。

## auto-merge 欠落

- 見分け方: PR はあるが autoMergeRequest が null。例として、同期 run の PR 作成ステップが GraphQL の一時エラーで失敗し、PR はできたが auto-merge の有効化が飛んだ（2026-11-02 の fandhe-frontend）。
- 対処: 失敗ログで原因を確かめてから `gh pr merge <n> --auto --squash` で武装する。

## 未解決スレッド（Bugbot / codex）

1. main が指摘を実測で検証する。jq や shell の挙動なら、実際のフィルタで再現を試す。
2. 誤検出なら、実測結果を引用した返信を GraphQL `addPullRequestReviewThreadReply` で付けてから `resolveReviewThread` で解決する。2026-11-02 の実績: skipLabels の「空出力で fail-closed」という High 指摘は、`printf '%s\n' "" | jq -s` が `[]`・rc=0 になると示して resolve し、3 件がマージされた。
3. 実在するバグなら上流（agent-cli-skills）を修正する。PR 側で直しても再同期の force-push で消える。
   1. サブエージェントが worktree で修正 PR を作る。
   2. CI 全 green と、Bugbot の HEAD に対する結果を確認してからマージする。
   3. 5 分待つ（raw キャッシュが古いまま配られるのを避ける）。
   4. 止まっているリポにだけ `gh workflow run update-external.yml -R Fandhe-AI/<r> -f target=skill` を打つ。
   5. 同期 run が PR ブランチを更新したのを確かめてから、残ったスレッドを resolve する（Bugbot が自分で resolve することも多い）。
4. スレッドの resolve は dispatch の後に行う。先に resolve すると、auto-merge 武装済みの PR が旧内容のままマージされる。
5. マージ済みのリポへ dispatch すると後続 PR が新しくできるので打たない（翌日 00:00 UTC の schedule で届く）。フリート全体への再 dispatch は、オーナーが明示したときだけ行う。上流の作業が途中なら最新化しない。

## 連鎖指摘

同じ箇所への指摘が 3 巡続いたら、修正せずに上流で issue 化し、返信して resolve したうえでオーナーに判断を仰ぐ。オーナーが「直して」と明示したら続ける。

## CI 失敗

- まず main の CI（schedule / push）も同じ理由で落ちているかを確かめる。落ちているなら修正先は main。例: RUSTSEC の新しい advisory は、依存の更新か、根拠付きの ignore（`deny.toml` と `.cargo/audit.toml` の両方）。main を直したら、同期 PR は `gh pr update-branch` で CI を通し直す。
- flaky の既知類型は `gh run rerun --failed` を 1 回だけ行う。
  - advisory-db 401
  - OOM signal 9
  - ETXTBSY
  - browser test の p95 しきい値超過
  - runner の rustup 欠落
- `rerun` は以前に解決した reusable workflow の版で動く。新しい版で走らせたいときは、新しい push が要る。
- CI の広い範囲での失敗を、自分の操作のせいだと即断しない。GitHub status と runner の状態で先に反証する。

## 古い base・required check の固着

- `gh pr update-branch` を試す。
- それでも解消しないときは、オーナーの承認を得て、同じ tree の空コミットで head を動かす。

## Bugbot 対象外（TOO_LARGE_TO_REVIEW）

- 差分 4 万行超。`@cursor review` でも変わらない。
- オーナーの承認を得て bypass を一時的に付与し、マージ後すぐ戻す。

## 発火漏れ（resolve 後に auto-merge が動かない）

マージ判定（`SKILL.md` Step 4）の 4 条件が満たされていることを確かめてから、手動でマージする。

## run 異常（cancel / ハング）

同期 run が cancel またはハングして PR が無い場合は、再 dispatch する。

## 新設リポ

- 症状: schedule が一度も起動していない（run 0 件）、`dependencies` / `automated` ラベルが無い（PR 作成で exit 1）、ruleset が無い（同期 PR が CI の完了前に即マージされる）。
- 対処: ラベルは作成し、手動で dispatch する。ruleset が無いことは、オーナーに報告する（`setup-repo-guards` の導入を提案する）。
- 実例: 2026-11-02 の fandhe-auth。

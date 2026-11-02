# 同期 PR の詰まり類型と対処

`SKILL.md` Step 2 の類型ごとの詳細。順序規則・3 巡ルール・dispatch の 2 経路・承認ゲート・マージ系操作の前提は `SKILL.md` Step 3・4 が正典で、ここでは重複して書かず参照する。`$W` は `SKILL.md` Step 1 の定義を使う。日付つきの事例は実績であり、末尾の「→ 判断基準」を一般化した規則として使う。

resolve・`--auto` の武装・手動マージは、いずれも `SKILL.md` Step 4 の承認一覧に載せ、オーナーの承認を得てから実行する。以下の各類型で「承認一覧に載せる」とあるのはこの意味である。

## Bugbot 未起動

- 見分け方: required の `Cursor Bugbot` がチェック一覧に無く Expected のまま。
- 対処(承認不要): PR コメントとして `@cursor review` を投稿する(オーナー指示・2026-11-02)。
  ```bash
  gh pr comment <n> -R "Fandhe-AI/$r" --body "@cursor review"
  ```
- オーナーが既に投稿済みなら重ねない。
- 30 分ほど反応が無ければ、代替として `bugbot run` を PR コメントとして投稿する。
  - 事例: 2026-08-17 に `@cursor review` が効かず `bugbot run` で起動した。
  - → 判断基準: 先に `@cursor review` を試し、30 分反応が無いときだけ `bugbot run` に切り替える。

## 手動 run 待ち

- 見分け方: オーナーの workflow_dispatch が in_progress、または直後に後続 PR ができた。
- 対処: 待機する。重ねて dispatch しない。手動 run が作った後続 PR も、マージまで見届ける。

## auto-merge 欠落

- 見分け方: PR はあるが autoMergeRequest が null。
- 対処: 次の順に進める。
  1. 失敗ログで原因を確かめる。
  2. `SKILL.md` Step 4 のマージ系操作の前提(サーバー側強制の実測など)を、main が自分で確認する。確認できなければ武装せず報告する。
  3. 前提を満たしたら、承認一覧に載せる。承認を得たものだけ武装する。
     ```bash
     gh pr merge <n> -R "Fandhe-AI/$r" --auto --squash --match-head-commit "${approved_sha}"
     ```
     `approved_sha` は承認一覧に載せた HEAD sha(main が自分で取得したもの)。不一致で失敗したら停止し、HEAD を取り直して再承認を得る。
- 事例: 2026-11-02 の fandhe-frontend。同期 run の PR 作成ステップが GraphQL の一時エラーで失敗し、PR はできたが auto-merge の有効化が飛んだ。この日は承認ゲートを通さずに武装したが、現行の手順は上のとおりゲートつきである。
  - → 判断基準: PR があって autoMergeRequest が null なら、原因確認 → 前提確認 → 承認、の順を省略しない。

## 未解決スレッド(Bugbot / codex)

1. main が指摘を実測で検証する(承認不要)。jq や shell の挙動なら、実際のフィルタで再現を試す。
2. 誤検出なら、実測結果を引用した返信を付ける。返信だけなら承認は不要。本文は必ず変数で渡す(クエリ文字列へ埋め込まない)。`$thread_id` は `reviewThreads` の `id`。
   ```bash
   body='実測: printf "%s\n" "" | jq -s は [] を返し rc=0 になる。…'
   gh api graphql \
     -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' \
     -f t="$thread_id" -f b="$body"
   ```
3. resolve は承認一覧に載せる。根拠として実測のコマンドと結果を添える。同じ PR に実在バグのスレッドが残っていないこと、Bugbot が現在の HEAD に対して完了していることも確かめる。承認を得たものだけ resolve する。
   ```bash
   gh api graphql \
     -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
     -f t="$thread_id"
   ```
4. 実在するバグなら、`SKILL.md` Step 3 の「上流修正の順序」に従う。配布後に残ったスレッドも、修正が新しい HEAD に入っていることを確かめてから承認一覧に載せる。
   - 事例: 2026-11-02 に skipLabels の「空出力で fail-closed」という High 指摘を、`printf '%s\n' "" | jq -s` が `[]`・rc=0 になると示して resolve し、3 件がマージされた。この日は承認ゲートを通さずに resolve したが、現行の手順は上のとおりゲートつきである。
   - → 判断基準: 指摘が jq・shell の挙動なら、実フィルタでの再現結果を引用できるときだけ誤検出と判定する。resolve には承認を取る。

## 連鎖指摘

`SKILL.md` Step 3 の 3 巡ルールに従う(修正しない・スレッドは未解決のまま・issue 化して issue へのリンクを返信・停止)。

## CI 失敗

- まず main の CI(schedule / push)も同じ理由で落ちているかを確かめる。落ちているなら修正先は main。
  - 例: RUSTSEC の新しい advisory は、依存の更新か、根拠付きの ignore(`deny.toml` と `.cargo/audit.toml` の両方)。
  - main を直したら、同期 PR は `gh pr update-branch` で CI を通し直す。
- flaky の既知類型は `gh run rerun --failed` を 1 回だけ行う。
  - advisory-db 401
  - OOM signal 9
  - ETXTBSY
  - browser test の p95 しきい値超過
  - runner の rustup 欠落
- `rerun` は以前に解決した reusable workflow の版で動く。新しい版で走らせたいときは、新しい push が要る。
- 広域失敗の扱いは `SKILL.md` 注意事項に従う(自分の操作のせいと即断しない)。

## 古い base・required check の固着

- `gh pr update-branch` を試す。
- それでも解消しないときは、オーナーの承認を得て、同じ tree の空コミットで head を動かす。

## Bugbot 対象外(TOO_LARGE_TO_REVIEW)

- 差分 4 万行超。`@cursor review` でも変わらない。
- オーナーの明示承認を得て bypass を一時的に付与し、マージ後すぐ戻す(`SKILL.md` 注意事項)。マージ自体も Step 4 の承認一覧に載せる。

## 発火漏れ(resolve 後に auto-merge が動かない)

マージ判定(`SKILL.md` Step 5)の 4 条件を確かめ、Step 4 の前提を満たしたうえで、手動マージを承認一覧に載せる。承認を得たものだけ実行する。

```bash
gh pr merge <n> -R "Fandhe-AI/$r" --squash --match-head-commit "${approved_sha}"
```

`approved_sha` は承認一覧に載せた HEAD sha。不一致で失敗したら停止し、HEAD を取り直して再承認を得る。

## run 異常(cancel / ハング)

同期 run が cancel またはハングして PR が無い場合は、`SKILL.md` Step 3 の経路 (ii) の前提を確かめてから再 dispatch する。

```bash
gh workflow run "$W" -R "Fandhe-AI/$r" -f target=skill
```

## 新設リポ

- 症状: schedule が一度も起動していない、`dependencies` / `automated` ラベルが無い(PR 作成で exit 1)、ruleset が無い。
- 分類: run 0 件(終了コード 0・出力が空)は「run なし」、workflow が存在せず終了コード 1 で失敗するのは「workflow なし」。報告では分けて載せる。
- 対処: ラベルを作成し(承認不要・報告に載せる)、`SKILL.md` Step 3 の経路 (ii) の前提を確かめて dispatch する。ruleset が無いことは、`SKILL.md` Step 4 に従い武装もマージもせず、オーナーへ報告して `setup-repo-guards` の導入を提案するだけにする。
- 事例: 2026-11-02 の fandhe-auth。ruleset が無く、同期 PR が CI の完了前に即マージされた。
  - → 判断基準: 新設リポは、ラベル・初回 dispatch・ruleset の 3 点を順に確かめる。ruleset 導入は提案までで、勝手に適用しない。

# 同期 PR の詰まり類型と対処

`SKILL.md` Step 2 の類型ごとの詳細。順序規則・3 巡ルール・再 dispatch の前提条件・resolve 前の確認は `SKILL.md` Step 3 が正典で、ここでは重複して書かず参照する。`$W` は `SKILL.md` Step 1 の定義を使う。日付つきの事例は実績であり、末尾の「→ 判断基準」を一般化した規則として使う。

## Bugbot 未起動

- 見分け方: required の `Cursor Bugbot` がチェック一覧に無く Expected のまま。
- 対処: PR コメントとして `@cursor review` を投稿する（オーナー指示・2026-11-02）。
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
- 対処: 失敗ログで原因を確かめてから武装する。
  ```bash
  gh pr merge <n> -R "Fandhe-AI/$r" --auto --squash
  ```
- 事例: 2026-11-02 の fandhe-frontend。同期 run の PR 作成ステップが GraphQL の一時エラーで失敗し、PR はできたが auto-merge の有効化が飛んだ。
  - → 判断基準: PR があって autoMergeRequest が null なら、まず run のログで原因を確かめ、一時エラーなら武装し直す。

## 未解決スレッド（Bugbot / codex）

1. main が指摘を実測で検証する。jq や shell の挙動なら、実際のフィルタで再現を試す。
2. 誤検出なら、実測結果を引用した返信を付けてから resolve する。resolve 前の確認は `SKILL.md` Step 3 に従う。
   ```bash
   body='実測: printf "%s\n" "" | jq -s は [] を返し rc=0 になる。…'
   gh api graphql \
     -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' \
     -f t="$thread_id" -f b="$body"
   gh api graphql \
     -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
     -f t="$thread_id"
   ```
   `$thread_id` は `reviewThreads` の `id`。本文は必ず変数で渡す（クエリ文字列へ埋め込まない）。
3. 実在するバグなら、`SKILL.md` Step 3 の「上流修正の順序」に従う。
   - 事例: 2026-11-02 に skipLabels の「空出力で fail-closed」という High 指摘を、`printf '%s\n' "" | jq -s` が `[]`・rc=0 になると示して resolve し、3 件がマージされた。
   - → 判断基準: 指摘が jq・shell の挙動なら、実フィルタでの再現結果を引用できるときだけ誤検出と判定する。

## 連鎖指摘

`SKILL.md` Step 3 の 3 巡ルールに従う。

## CI 失敗

- まず main の CI（schedule / push）も同じ理由で落ちているかを確かめる。落ちているなら修正先は main。
  - 例: RUSTSEC の新しい advisory は、依存の更新か、根拠付きの ignore（`deny.toml` と `.cargo/audit.toml` の両方）。
  - main を直したら、同期 PR は `gh pr update-branch` で CI を通し直す。
- flaky の既知類型は `gh run rerun --failed` を 1 回だけ行う。
  - advisory-db 401
  - OOM signal 9
  - ETXTBSY
  - browser test の p95 しきい値超過
  - runner の rustup 欠落
- `rerun` は以前に解決した reusable workflow の版で動く。新しい版で走らせたいときは、新しい push が要る。
- 広域失敗の扱いは `SKILL.md` 注意事項に従う（自分の操作のせいと即断しない）。

## 古い base・required check の固着

- `gh pr update-branch` を試す。
- それでも解消しないときは、オーナーの承認を得て、同じ tree の空コミットで head を動かす。

## Bugbot 対象外（TOO_LARGE_TO_REVIEW）

- 差分 4 万行超。`@cursor review` でも変わらない。
- オーナーの明示承認を得て bypass を一時的に付与し、マージ後すぐ戻す（`SKILL.md` 注意事項）。

## 発火漏れ（resolve 後に auto-merge が動かない）

マージ判定（`SKILL.md` Step 4）の 4 条件が満たされていることを確かめてから、`gh pr merge <n> -R "Fandhe-AI/$r" --squash` で手動マージする。

## run 異常（cancel / ハング）

同期 run が cancel またはハングして PR が無い場合は、`SKILL.md` Step 3 の前提条件を確かめてから再 dispatch する。

```bash
gh workflow run "$W" -R "Fandhe-AI/$r" -f target=skill
```

## 新設リポ

- 症状: schedule が一度も起動していない、`dependencies` / `automated` ラベルが無い（PR 作成で exit 1）、ruleset が無い。
- 分類: run 0 件（終了コード 0・出力が空）は「run なし」、workflow が存在せず終了コード 1 で失敗するのは「workflow なし」。報告では分けて載せる。
- 対処: ラベルを作成し（承認不要・報告に載せる）、`SKILL.md` Step 3 の前提条件を確かめて dispatch する。ruleset が無いことは `SKILL.md` 注意事項に従いオーナーへ報告する。
- 事例: 2026-11-02 の fandhe-auth。
  - → 判断基準: 新設リポは、ラベル・初回 dispatch・ruleset の 3 点を順に確かめる。ruleset 導入は提案までで、勝手に適用しない。

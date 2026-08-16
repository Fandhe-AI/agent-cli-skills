# ブランチ ruleset 方針

`implement-issue-tree` の並列ラン + クライアント側自動マージ（`autoMerge: true`）を成立させるための、
ベースブランチ ruleset の構成規約。ruleset を新規作成・変更するとき（`setup-repo-guards` の実行、
Fandhe-AI 配下リポジトリへの一括適用、required check 名の変更に伴う PUT）に適用する。

## strict は必ず false にする

`required_status_checks` ルールの **`strict_required_status_checks_policy` は `false`** にする
（classic branch protection の `strict` = 「Require branches to be up to date before merging」も同様）。

**Why:** `true` にすると 1 件マージするたびに、同じ base を持つ他の open PR がすべて
「base が古い」状態になり `BLOCKED` へ落ちる。`implement-issue-tree` は `parallel >= 2` で
複数 PR を同時に走らせるため、base 更新 → 全チェック再実行 → その間に別の PR がマージ、
というループで収束しなくなり、自動マージが実質成立しない。並列度を上げるほど悪化する。

strict はセキュリティ要件ではない。「チェックが現在の base に対して走ったか」という**鮮度**の
制御であって、「誰がマージ条件を迂回できるか」という**bypass 不能性**の制御ではないため、
外しても G0（サーバー側強制の実測）の主張 —「共有 `gh` 認証のどのエージェントが直接マージを
試みてもサーバーが同条件で拒否する」— は成立する。実際 `implement-issue-tree` の G0 (i-c) と
サーバー側 auto-merge サンプルの G8 は、いずれも strict を要件から外している。

**How to apply:**
- ruleset を作成・更新するときは `strict_required_status_checks_policy: false` を明示する
- 既存 ruleset を PATCH するときは `required_status_checks` の `parameters` が丸ごと置換される
  ことに注意し、`required_status_checks` 配列（各エントリの `integration_id` 束縛を含む）を
  保存したうえで strict だけを変更する。`integration_id` を落とすと G0 (v-b) が
  `issuer-unbound` で辞退し、自動マージが全リポジトリで止まる
- strict = false で残るリスクは「古い base に対して成功したチェックのままマージされ、
  マージ後の base が壊れ得る」ことのみ。テキストコンフリクトは merge-exec が `mergeable` を
  自己取得して `CONFLICTING` を検出し `not-mergeable` で終端するため通らない。
  意味的コンフリクトは**ラン完了後にベースブランチの CI が green であることを確認**して補う
- 「マージが古い base で通ってしまう」を理由に strict を戻さない。戻すと並列ランが止まる

## strict 以外の必須構成（自動マージ opt-in 時）

`autoMerge: true` を使うリポジトリでは、G0 が実測確認する次の構成が必要になる。
1 つでも欠けると `server-enforcement-missing` / `classic-unsupported` / `issuer-unbound` で
マージせず `blocked` 終端する。

| 項目 | 構成 |
|------|------|
| ruleset のソース | Repository ruleset（`ruleset_source_type == "Repository"`）。Organization 継承は検証不能で辞退 |
| bypass | 全適用 ruleset で `bypass_actors` が空配列 |
| enforcement | `active`（`disabled` / `evaluate` は不可） |
| required status checks | 1 件以上。**PR で必ず実行される** context のみを登録する |
| 発行元束縛 | required check の全エントリに数値の `integration_id` |
| レビュースレッド | `pull_request` ルールの `required_review_thread_resolution: true` |
| 外部チェック App | `args.externalChecks` で宣言した context を、その App の `integration_id` 束縛付きで required に含める |

**条件付き実行のチェックを required にしない。** `on.pull_request` に `paths` フィルタを持つ
workflow のジョブは、変更内容によっては起動しない。required に登録すると「Expected」のまま
永久に埋まらず、その PR は恒久的にマージ不能になる。required 候補は「直近の merged PR
すべてで実行されている context」に限る。

## 関連ルール

- `./verification.md` — ruleset 変更後の確認（実測して証拠を示す）
- `./security.md` — bypass 経路・認証境界の観点
- `skills/implement-issue-tree/references/automerge-design.md` — G0 の全判定と設計根拠
- `skills/setup-repo-guards/SKILL.md` — ruleset の初期構築手順

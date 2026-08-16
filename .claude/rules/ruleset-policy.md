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
- PUT 実行後は必ず「一括更新後の検証（3 軸 + classic BP）」節のスイープを実行し、
  strict 以外に落ちたフィールドがないことを実測する（classic BP の `strict` 確認は同節の手順 B が対応する）

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

## 一括更新後の検証（3 軸 + classic BP）

**この節は「strict 以外の必須構成」表（7 項目）の代替ではない。** 複数リポジトリへの ruleset
一括 PUT、required check 名変更に伴う PUT、`setup-repo-guards` の一括適用のたびに、7 項目表の
上に重ねて実行する**最小回帰スイープ**である。`PUT /repos/{o}/{r}/rulesets/{id}` は
`required_status_checks.parameters` を丸ごと置換する仕様のため、strict だけを変更したつもりでも
`integration_id` 束縛のような他フィールドが黙って落ち得る。束縛欠落は fail-closed のため危険側
ではないが、G0 (v-b) が `issuer-unbound` で辞退して自動マージが**静かに**止まる。strict と
`bypass_actors` の 2 軸だけを見ていると、この停止が「全 green」に見えてしまう。

3 軸で実測する: **strict** / **`bypass_actors`** / **`integration_id` 残存**。加えて classic
branch protection の `strict` も本ファイル冒頭の適用範囲に含まれるため、手順 B で別枠に掃く。

既定ブランチ名を `main` に決め打ちしない。`gh repo view` の `defaultBranchRef` から解決する。

### 手順 A: 全 branch ruleset のスイープ

**PUT した ruleset 単体だけを見ない。** 同じブランチに複数の ruleset が併存し得るため
（実例: `fandhe-backend` は `main-protection` と `main-required-checks` の 2 ruleset が
同一ブランチに適用されている）、`GET /repos/{o}/{r}/rulesets` で branch target の全 ruleset を
まず列挙してから 1 件ずつ詳細を掃く。org 継承 ruleset（`source_type == "Organization"`）を
repo 側エンドポイントで引くと 404 になり「未束縛 0 件 = clean」と誤読するため、
`source_type` でエンドポイントをルーティングする。

```bash
repo="Fandhe-AI/<REPO>"
org="${repo%%/*}"

gh api "repos/${repo}/rulesets" \
  --jq '.[] | select(.target == "branch") | [(.id|tostring), .name, (.source_type // "unknown")] | @tsv' |
while IFS=$'\t' read -r id name src; do
  case "${src}" in
    Repository)   path="repos/${repo}/rulesets/${id}" ;;
    Organization) path="orgs/${org}/rulesets/${id}" ;;   # repo 側で引くと 404 → 誤って clean に見える
    *)            echo "UNKNOWN source_type: ${name} (${src}) — 手動確認"; continue ;;
  esac
  gh api "${path}" --jq '{
    name: .name,
    enforcement: .enforcement,
    bypass: (.bypass_actors | length),
    strict: ([.rules[]? | select(.type=="required_status_checks")
              | .parameters.strict_required_status_checks_policy] | first),
    total:   ([.rules[]? | select(.type=="required_status_checks")
              | .parameters.required_status_checks[]?] | length),
    unbound: [.rules[]? | select(.type=="required_status_checks")
              | .parameters.required_status_checks[]?
              | select(.integration_id == null) | .context]
  }'
done
```

実行例（`Fandhe-AI/agent-cli-skills` で実測。`while` ループはインライン実行不可の環境があるため
1 ファイルにしてから `bash` で実行した）:

```
$ bash sweep_a.sh Fandhe-AI/agent-cli-skills
{"bypass":0,"enforcement":"active","name":"main-protection","strict":false,"total":10,"unbound":[]}
```

2 ruleset が併存する `fandhe-backend` でも実測済み（列挙 → ルーティングが両エントリを掃く証拠）:

```
$ bash sweep_a.sh Fandhe-AI/fandhe-backend
{"bypass":0,"enforcement":"active","name":"main-protection","strict":false,"total":18,"unbound":[]}
{"bypass":0,"enforcement":"active","name":"main-required-checks","strict":false,"total":1,"unbound":[]}
```

`unbound` が空配列でも `total == 0` なら「未束縛 0 件」ではなく required check 未設定
（「strict 以外の必須構成」表の失格状態）である。`total` と `unbound` を必ず併記し、
`join(",")` で空配列にして両者を混同しない。

参考: `GET /repos/{o}/{r}/rules/branches/{branch}`（effective rules。ブランチ名は `@uri` で
エンコードする。`automerge-design.md` の G4/G6 が同エンドポイントで `integration_id` を検証
済み）は org 継承分もマージ済みの `required_status_checks` を単一呼び出しで返し、上記スイープの
`total`/`unbound` のクロスチェックに使える（実測: `agent-cli-skills` で `integration_id` 付き
10 件を確認）。ただし `bypass_actors` と `enforcement` は ruleset 単位のメタデータであり
effective rules には含まれないため、この節の主目的（bypass 軸の検証）では手順 A の per-ruleset
スイープが引き続き必須である。

### 手順 B: classic branch protection を別枠で掃く

`.claude/rules/ruleset-policy.md` は classic の `strict` も対象と明記しているが、`/rulesets`
系エンドポイントは classic の設定を返さない。既定ブランチを解決し、存在確認は**終了コードでは
なく HTTP status** で行う（`gh api` はエラーも stdout に出す仕様のため、`>/dev/null 2>&1` の
成否だけでは 403（権限不足）と 404（未保護）を区別できない）。

```bash
repo="Fandhe-AI/<REPO>"

db=$(gh repo view "${repo}" --json defaultBranchRef --jq '.defaultBranchRef.name')   # main 決め打ち禁止
db_enc=$(printf '%s' "${db}" | jq -sRr '@uri')                                        # release/1.0 等の / を保護
code=$(gh api -i "repos/${repo}/branches/${db_enc}/protection" 2>/dev/null | awk 'NR==1{print $2}')
case "${code}" in
  200) gh api "repos/${repo}/branches/${db_enc}/protection" --jq '{
         strict: (.required_status_checks.strict // "none"),
         enforce_admins: .enforce_admins.enabled,
         unbound: [.required_status_checks.checks[]? | select(.app_id == null) | .context]
       }' ;;                                   # classic は integration_id ではなく app_id
  404) echo "classic BP なし（${db}）" ;;
  *)   echo "判定不能 (HTTP ${code:-?}) — Administration: read 権限を確認。green と扱わない" ;;
esac
```

`branches/{branch}/protection` の呼び出しには Administration: read 権限が必要。

実行例（`Fandhe-AI/agent-cli-skills` は ruleset 運用のため 404 経路を実測。200 経路は
GitHub REST のスキーマ通りの合成 JSON で jq の抽出式のみ検証済み — 本リポジトリ配下に
classic BP を持つサンプルが見つからず、未検証の抽出式をそのまま載せないため）:

```
$ bash sweep_b.sh Fandhe-AI/agent-cli-skills
classic BP なし（main）

$ echo '{"required_status_checks":{"strict":true,"checks":[{"context":"ci","app_id":123},{"context":"legacy","app_id":null}]},"enforce_admins":{"enabled":true}}' \
  | jq '{strict:(.required_status_checks.strict // "none"), enforce_admins:.enforce_admins.enabled, unbound:[.required_status_checks.checks[]? | select(.app_id==null) | .context]}'
{"strict":true,"enforce_admins":true,"unbound":["legacy"]}
```

### 判定表

| 軸 | green 条件 | fail 時に起きること |
|----|-----------|-------------------|
| strict | ruleset `false` / classic `false` or `none` | 並列ランが収束せず自動マージが実質停止 |
| bypass_actors | 全 branch ruleset で `0` | G0 が `server-enforcement-missing` で辞退 |
| integration_id 残存 | `unbound` が空、かつ `total >= 1` | G0 (v-b) が `issuer-unbound` で辞退し**静かに**自動マージ停止 |
| classic BP | 未設定（404）、または設定ありで strict false + `app_id` 束縛あり | classic のみのリポは `classic-unsupported` で辞退 |

`total == 0` は「未束縛 0 件」ではなく required check 未設定（7 項目表の失格状態）。空配列の
`join` で両者を混同しない。403 等の判定不能ステータスは green に倒さず「判定不能」と記録する。

### 未束縛検出時の復旧

required checks を GitHub App 発行の check-run に統一し、ruleset へ `integration_id` を設定して
PUT し直す。PUT は `GET` した ruleset JSON の `required_status_checks` パラメータのみを差し替えて
送る（既存の「How to apply」の記述と同じ手順。丸ごと新規オブジェクトを組み立てて送らない）。

## 関連ルール

- `./verification.md` — ruleset 変更後の確認（実測して証拠を示す）
- `./security.md` — bypass 経路・認証境界の観点
- `skills/implement-issue-tree/references/automerge-design.md` — G0 の全判定と設計根拠
- `skills/setup-repo-guards/SKILL.md` — ruleset の初期構築手順

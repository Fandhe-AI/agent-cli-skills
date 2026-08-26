---
description: >
  implement-issue-tree の並列ラン・クライアント側自動マージを成立させるための
  ブランチ ruleset 構成規約。strict は必ず false・required check への
  integration_id 束縛・bypass_actors 空・一括更新後の strict / bypass_actors /
  integration_id 残存の 3 軸検証と classic branch protection の別枠検証を定める。
applies_to: setup-repo-guards, implement-issue-tree, ruleset を変更する全作業
---

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
- 既存 ruleset を PUT で更新するときは `required_status_checks` の `parameters` が丸ごと置換される
  ことに注意し、`required_status_checks` 配列（各エントリの `integration_id` 束縛を含む）を
  保存したうえで strict だけを変更する。`integration_id` を落とすと G0 (v-b) が
  `issuer-unbound` で辞退し、自動マージが全リポジトリで止まる
- strict = false で残るリスクは「古い base に対して成功したチェックのままマージされ、
  マージ後の base が壊れ得る」ことのみ。テキストコンフリクトは merge-exec が `mergeable` を
  自己取得して `CONFLICTING` を検出し `not-mergeable` で終端するため通らない。
  意味的コンフリクトは**ラン完了後にベースブランチの CI が green であることを確認**して補う。
  **ただしこの補償はマージ先ブランチへの push で CI が起動するリポジトリでのみ成立する**
  （成立確認の手順・判定表は
  `skills/implement-issue-tree/references/automerge-design.md` の
  「補償策の成立確認（base CI プローブ）」節を参照。下記「補償策が成立しないリポジトリ
  （実測記録）」も参照）
- 「マージが古い base で通ってしまう」を理由に strict を戻さない。戻すと並列ランが止まる
- PUT 実行後は必ず「一括更新後の検証（3 軸 + classic BP）」節のスイープを実行し、
  strict 以外に落ちたフィールドがないことを実測する（classic BP の `strict` 確認は同節の手順 B が対応する）

### 補償策が成立しないリポジトリ（実測記録）

測定日: 2026-08-17。測定コマンド: `skills/implement-issue-tree/references/automerge-design.md`
の「補償策の成立確認（base CI プローブ）」節のプローブ手順（対象ブランチは `@<branch>` で
明示。この測定では `@` を省略し既定ブランチへフォールバックした形で実行した。既定ブランチは
`defaultBranchRef` から解決、head sha は HTTP status で存在確認、`event == "push"` の
件数のみを読む）。判定不能は green にも不成立にも倒さず、判定不能のまま記録して再測する。

**注記（対象ブランチと既定ブランチ）**: 本記録は各リポの**既定ブランチに対する測定**であり、
`args.branch` に非既定ブランチを指定する運用（`implement-issue-tree` の `branch` 引数で
`release/1.0` 等を指定するケース）では対象ブランチ基準での再測が必要になる
（Issue #362 でプローブを既定ブランチ決め打ちから対象ブランチ検査へ是正済み。フォールバック
形の挙動 — `@branch` 省略時に既定ブランチへフォールバックする経路 — は従来と同一のため、
`push_total == 0` という以下の判定自体は今回の変更で影響を受けず、既定ブランチについての
5 行の判定は再測不要）。

実測時点で 5 リポジトリすべて既定ブランチの head に `push` イベントの run が 0 件
（`push_total == 0`）であり、判定表の「補償策不成立」に該当した（503 等の判定不能は
発生せず、いずれも決定的に判定できた）。加えて `.github/workflows/*.yml` の
`push:` トリガ有無を横断確認し、「push トリガ workflow が構造的に無い」場合と
「push トリガ workflow はあるが `paths` フィルタでこの head では起動しなかった」場合を
区別した（前者はどの head でも恒久的に補償策不成立、後者は該当 push があれば成立し得る）。

**注記（`.yml`/`.yaml` 拡張子）**: この測定時点の横断確認は `.github/workflows/*.yml` のみを
対象にしており、GitHub Actions が同様に認識する `.yaml` 拡張子の workflow ファイルは確認して
いない（自動マージ設計側の必須 workflow 集合の決め方も同じ理由で `*.yml`/`*.yaml` 両方の確認
を要求するよう修正済み。`skills/implement-issue-tree/references/automerge-design.md` 参照）。
5 リポいずれかに `.yaml` 拡張子の workflow ファイルが存在する場合、この表の判定は再測が必要
になり得る。

**注記（プローブ仕様変更との整合性）**: この記録は「意味的コンフリクト検出に必須な
workflow 集合の被覆確認（`required_missing`）」と「取得上限 100 件到達チェック」を
プローブへ追加する前に取得したものである。両追加は `push_total >= 1` の場合の判定を
より厳格化する変更（必須 workflow が欠けていれば green ではなく補償策不成立へ倒す）
であり、`push_total == 0` の判定（補償策不成立）自体は変更の影響を受けない。5 リポ
すべて `push_total == 0` のため、この表の判定はプローブ仕様変更後も再測なしで有効である。

**注記（必須 workflow 集合の入力形式変更・Issue #363）**: この記録取得後、プローブの必須
workflow 集合の入力形式をカンマ区切り文字列から JSON 配列（`["name1","name2"]`）へ変更した
（GitHub Actions の workflow レベル `name:` にはカンマを含められるため、カンマ区切りでは
区切り文字と衝突し誤分割される）。この変更は入力の**表現形式**のみを変えるものであり、
判定ロジック（`push_total` の算出・`required_missing` の判定）自体には影響しない。5 リポ
すべて `push_total == 0` のため、この表の判定は入力形式変更後も再測不要である。再測・新規
測定を行う場合は新形式（JSON 配列）でプローブを実行すること。

**注記（集計対象の必須集合限定・Issue #364）**: この記録取得後、プローブの `failed`/
`incomplete`/`unknown` の集計対象を「対象ブランチへの push run 全件（`$p`）」から
「必須 workflow 集合の run のみ（`$rp`。`workflowDatabaseId` を必須集合の `id` と突き合わせて
抽出）」へ限定し、必須 run 件数を示す `required_push_total` を出力へ追加した（必須外の
`paths` フィルタ付き軽量 workflow 等が `skipped`/`neutral` で完了しても green 判定を妨げない
ようにするため）。`push_total`（対象ブランチへの push run 全件。構造的不在検出専用）の意味は
変更していない。5 リポすべて `push_total == 0`（push run 自体が 0 件で `$p` も `$rp` も
空集合）であり、集計対象の限定は `push_total >= 1` の場合の判定にのみ影響するため、この表の
判定はこの変更後も再測不要である。

| リポジトリ | 判定 | 理由 | 判断 |
|-----------|------|------|------|
| `Fandhe-AI/actions` | 補償策不成立 | `.github/workflows/*.yml` に `push:` トリガが無い（構造的不在） | 補償策 適用外。`autoMerge: true` は非推奨。使う場合は上記節の 3. の代替確認を必須とする |
| `Fandhe-AI/life-plan-app` | 補償策不成立 | `.github/workflows/*.yml` に `push:` トリガが無い（構造的不在） | 同上 |
| `Fandhe-AI/local-server` | 補償策不成立 | `.github/workflows/*.yml` に `push:` トリガが無い（構造的不在） | 同上 |
| `Fandhe-AI/pronunciation-vocab-app` | 補償策不成立 | `.github/workflows/*.yml` に `push:` トリガが無い（構造的不在） | 同上 |
| `Fandhe-AI/automation-app` | 補償策不成立 | `push:` トリガを持つ workflow は存在する（`deploy-api.yml` 等）が、いずれも `paths` フィルタ付きで実測 head の変更内容では起動しなかった（`push_total == 0`） | 補償策 適用外（現状の head では）。`autoMerge: true` は非推奨。使う場合は上記節の 3. の代替確認を必須とする。他 4 リポと異なり、`paths` に該当する変更が push された head では補償策が成立し得るため、再測の意義が高い |

リポジトリ構成は変わるため、この記録は測定日時点のスナップショットであり、`autoMerge`
運用を開始・再開するたびに再測する。該当 5 リポへの push トリガ CI 追加（判定表の
不成立時の扱い 1.）は別リポジトリの構成変更であり本リポジトリの変更では実施できない
（追跡は Issue で行う）。

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
         strict: (if .required_status_checks == null then "none" else .required_status_checks.strict end),
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
  | jq '{strict:(if .required_status_checks == null then "none" else .required_status_checks.strict end), enforce_admins:.enforce_admins.enabled, unbound:[.required_status_checks.checks[]? | select(.app_id==null) | .context]}'
{"strict":true,"enforce_admins":true,"unbound":["legacy"]}
```

注記: 抽出式は当初 `.required_status_checks.strict // "none"` だったが、jq の `//` は
`false` も「値なし」と同様に右辺へ置換するため、strict が明示的に `false` の classic BP を
`"none"`（未設定）と誤報告するバグがあった。上の `if ... == null then "none" else ... end`
形へ修正済み。合成 JSON の実行例は `strict: true` の入力であり、新旧どちらの式でも出力は
同一のため、上の出力記録はそのまま有効である。

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

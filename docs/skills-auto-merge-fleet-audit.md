# wrapper 導入済みリポの skills-auto-merge fail-closed 監査（イシュー #359）

イシュー #342 では新規導入 5 リポのうち保護なし 4 リポを `skills-auto-merge: 'false'` 明示で
fail-closed 化した（`docs/update-external-rollout.md` 参照）。本ドキュメントは **#342 以前から
`update-external.yml` wrapper を持つ既存リポ**を同じ観点で棚卸しし、方針を決定した記録。
**方針の決定と実施はこのドキュメントのスコープだが、本エージェントの書き込み対象は
`agent-cli-skills` 自身に限られる。同リポへの変更適用は本 PR 内で実施済みであり、残り
23 リポへの適用は未実施のまま後続担当へ引き継ぐ（「7. 実施状況」参照）。**

測定日: 2026-08-19。

## 1. 前提の実測（結論に効く事実）

- 組織変数 `SKILLS_AUTO_MERGE` = `true`（`visibility: all`）。
  `gh api /orgs/Fandhe-AI/actions/variables/SKILLS_AUTO_MERGE` で実測。
- 組織変数 `SKILLS_AUTO_MERGE_ALLOWLIST` は**未登録**（`gh api` が 404）。
  allowlist 未指定のため、上流 reusable workflow は「全スキルを自動マージ対象」と判定する
  （`docs/update-external-rollout.md` の同型の記述と同じ挙動）。
- wrapper は `skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}` の形で組織変数へ
  追従する（`vars` が未設定なら `'false'` にフォールバックする非対称設計）。

**この 2 点により、組織変数追従のまま branch protection / ruleset を持たないリポは、
上流スキル同期 PR がレビューもサーバー側ゲートも経ずに既定ブランチへ自動マージされる状態にある
（イシュー #342 の 4 リポで実際に踏んだ事故と同型）。** イシュー本文の懸念は実測で裏付けられた。

## 2. 列挙（動的列挙が正）

非 archived 120 リポ中、`.github/workflows/update-external.yml` を持つのは **30 リポ**
（イシュー記載の「22 リポ」とは件数が一致しない。動的列挙をこの表の正とする）。

| 分類 | 件数 | 内訳 |
|------|-----:|------|
| 上流 reusable workflow 本体（対象外） | 1 | `actions` |
| `skills-auto-merge: 'false'` 明示済み（#342 で対応済み・再確認のみ） | 4 | `aliz-corporate-web` / `automation-spec` / `hobby-keyboard` / `mcp_hub-spec` |
| 組織変数追従（`VARS_FOLLOW`） = 本監査の対象 | 25 | 下表 |

`VARS_FOLLOW` 25 リポ: `agent-cli-skills` `agent-reference-skills` `articles`
`automation` `automation-app` `baby-tasks-app` `brain-training-app`
`desktop-automation-app` `fandhe-backend` `fandhe-frontend` `fandhe-multi-platform`
`ideas` `life-plan-app` `local-llm-server` `local-server` `mirror-ui`
`pet-hub` `pronunciation-vocab-app` `rust-ai-library` `team-hub` `team-hub-spec`
`template-articles` `template-frontend-react_router` `template-ideas`
`yadori`

（`agent-cli-skills` 自身も `VARS_FOLLOW` である。本リポは ruleset 構造は保護ありだが、
4.2 節の PR レベル確認は他 24 リポと同様に判定不能であり、fail-closed 対象に含まれる。
本リポジトリは本エージェントの書き込み対象内であるため、6 節のとおり本 PR で
`skills-auto-merge: 'false'` を実際に適用済み。）

## 3. 判定基準

`.claude/rules/ruleset-policy.md` の「一括更新後の検証（3 軸 + classic BP）」と同じ実測軸を
リポごとに適用する。

| 軸 | green 条件 |
|----|-----------|
| 既定ブランチへの適用 | ruleset の `conditions.ref_name` が既定ブランチにマッチする、または既定ブランチの effective rules（`GET /repos/{o}/{r}/rules/branches/{branch}`）に当該 ruleset の `required_status_checks` が現れる |
| ruleset ソース | `source_type == "Repository"`（Organization 継承は本監査では未出現） |
| enforcement | `active` |
| bypass_actors | 全 branch ruleset で `0` |
| required status checks | `total >= 1` かつ `unbound`（`integration_id` 欠落）が空 |
| classic BP | 未設定（404）、または設定ありで `strict` が `false`/`none` かつ `app_id` 束縛あり |

全軸 green なら「保護あり」、1 つでも欠ける・判定不能（403 等）なら「保護なし」として
fail-closed 側へ倒す（`ruleset-policy.md` の方針どおり、判定不能を green に倒さない）。

**既定ブランチへの適用軸について（P1 是正）**: 単に `repos/{repo}/rulesets` で branch target の
ruleset が列挙される・`total >= 1` であることだけでは「既定ブランチが保護されている」ことの
証明にならない。ruleset は `conditions.ref_name` で任意のブランチ（例: `release/*` のみ）を
対象にでき、既定ブランチに一切適用されない ruleset が存在しても列挙上は区別できないため、
既定ブランチ以外だけを保護する ruleset を「保護あり」と誤判定しうる。本監査ではこれを避けるため、
リポジトリごとに (a) 各 branch ruleset の `conditions.ref_name.include`/`exclude` が既定ブランチ
（`~DEFAULT_BRANCH` / `~ALL` / `refs/heads/<default>` 一致 / 一致するパターン）にマッチするかを
判定し、(b) 既定ブランチの effective rules エンドポイントが返す `required_status_checks` の
`total`/`unbound` と突き合わせた（4 節「再監査」参照）。

**個別 PR レベルの実測（P0 是正）**: `docs/update-external-rollout.md` の判定基準
（「実際に PR が required checks の完了を待って `BLOCKED` になることを確認した」場合に
限り組織変数追従を許容する）に合わせ、構造的実測（ruleset 設定）だけでなく個別 PR レベルの
サーバー側強制についても 25 リポ全件で確認を試みた。手順・生の測定結果は 4.2 節を参照。
`team-hub-spec` のみ #342 実測時に同期 PR #58 の `BLOCKED` を確認済みであり、それ以外の
24 リポ（`agent-cli-skills` と `fandhe-backend` を含む。両リポの `ruleset-policy.md` 記録は
構造的実測に留まり PR レベル確認ではない）では測定日時点で確認対象となる open な同期 PR が
存在せず、PR レベルの確認は判定不能だった。判定不能を保護ありに倒さない
（`ruleset-policy.md` の方針どおり）ため、5 節の方針決定は 3〜4 節の構造的実測結果によらず
この判定不能を反映して再整理した。

## 4. 実測結果

`repos/{repo}/rulesets`（branch target のみ・`source_type` でエンドポイントをルーティング）
と `repos/{repo}/branches/{default}/protection`（HTTP status 判定・`@uri` エンコード）を
25 リポ全件に対して実行した。

| リポジトリ | ruleset (enforcement/bypass/total/unbound) | classic BP | 判定 |
|---|---|---|---|
| `agent-cli-skills` | active/0/12/[] | 404 | 保護あり |
| `agent-reference-skills` | active/0/9/[] | 404 | 保護あり |
| `articles` | active/0/8/[] | 404 | 保護あり |
| `automation` | active/0/14/[] | 404 | 保護あり |
| `automation-app` | active/0/30/[] | 404 | 保護あり |
| `baby-tasks-app` | active/0/6/[] | 404 | 保護あり |
| `brain-training-app` | active/0/8/[] | 200（strict: none, unbound: []） | 保護あり |
| `desktop-automation-app` | active/0/9/[] | 200（strict: none, unbound: []） | 保護あり |
| `fandhe-backend` | active/0/18/[] | 404 | 保護あり |
| `fandhe-frontend` | active/0/25/[] | 404 | 保護あり |
| `fandhe-multi-platform` | active/0/9/[] | 404 | 保護あり |
| `ideas` | active/0/8/[] | 404 | 保護あり |
| `life-plan-app` | active/0/8/[] | 404 | 保護あり |
| `local-llm-server` | active/0/21/[] | 404 | 保護あり |
| `local-server` | active/0/8/[] | 404 | 保護あり |
| `mirror-ui` | active/0/7/[] | 404 | 保護あり |
| `pet-hub` | active/0/9/[] | 404 | 保護あり |
| `pronunciation-vocab-app` | active/0/3/[] | 404 | 保護あり |
| `rust-ai-library` | active/0/15/[] | 404 | 保護あり |
| `team-hub` | active/0/23/[] | 404 | 保護あり |
| `team-hub-spec` | active/0/4/[] | 404 | 保護あり（#342 実測: PR #58 の `BLOCKED` も確認済み） |
| `template-articles` | **ruleset 0 件** | **404** | **保護なし** |
| `template-frontend-react_router` | active/0/12/[]（ruleset 名「Code Quality Copilot review for default branch」） | 404 | 保護あり |
| `template-ideas` | active/0/8/[] | 404 | 保護あり |
| `yadori` | active/0/12/[] | 404 | 保護あり |

**結果: 25 リポ中 24 リポが保護あり、`template-articles` のみ保護なし。**

想定（イシュー本文・実装計画は「保護なしが多数」を前提としていた）に反し、フリートの大半は
既に branch ruleset で保護されていた。`template-articles` は `gh api repos/Fandhe-AI/template-articles/rulesets`
が空配列 `[]`、classic BP も 404 であることを確認した（repo 単体で再実行し確認済み）。
リポ側の `SKILLS_AUTO_MERGE_ALLOWLIST` 変数上書きも無い
（`gh api repos/Fandhe-AI/template-articles/actions/variables` に該当変数なし）。

同リポの直近 PR 履歴（`gh pr list --state all`）を確認した限り、スキル同期 PR はまだ
作成されていない（#1〜#3 は wrapper 導入・pin 移行の手動 PR のみ）。したがって
`template-articles` は**まだ無審査自動マージを踏んでいないが、次回 schedule 実行で
踏み得る状態**にあった。

### 4.1 既定ブランチ適用の再検証（P1 是正・再測定日: 2026-08-19）

上記表は branch target の ruleset を列挙しただけで、各 ruleset が実際に既定ブランチへ
適用されるか（`conditions.ref_name` が既定ブランチにマッチするか）を個別確認していなかった。
25 リポ全件について、(a) 各 branch ruleset の `conditions.ref_name` が既定ブランチにマッチする
ものだけを抽出し bypass_actors / enforcement を再集計、(b) 既定ブランチの effective rules
エンドポイント（`GET /repos/{o}/{r}/rules/branches/{branch}`）で `required_status_checks` の
`total`/`unbound` を独立に取得、の 2 経路で再測定した。

結果、25 リポすべてで両経路が一致し、3 節の判定は変わらなかった。

| リポジトリ | 既定ブランチにマッチする ruleset 数 | effective required_status_checks (total/unbound) |
|---|---:|---|
| `agent-cli-skills` | 1 | 12/[] |
| `agent-reference-skills` | 1 | 9/[] |
| `articles` | 1 | 8/[] |
| `automation` | 1 | 14/[] |
| `automation-app` | 1 | 30/[] |
| `baby-tasks-app` | 1 | 6/[] |
| `brain-training-app` | 1 | 8/[] |
| `desktop-automation-app` | 1 | 9/[] |
| `fandhe-backend` | 1 | 18/[] |
| `fandhe-frontend` | 1 | 25/[] |
| `fandhe-multi-platform` | 1 | 9/[] |
| `ideas` | 1 | 8/[] |
| `life-plan-app` | 1 | 8/[] |
| `local-llm-server` | 1 | 21/[] |
| `local-server` | 1 | 8/[] |
| `mirror-ui` | 1 | 7/[] |
| `pet-hub` | 1 | 9/[] |
| `pronunciation-vocab-app` | 1 | 3/[] |
| `rust-ai-library` | 1 | 15/[] |
| `team-hub` | 1 | 23/[] |
| `team-hub-spec` | 1 | 4/[] |
| `template-articles` | **0** | **0/[]** |
| `template-frontend-react_router` | 1 | 12/[] |
| `template-ideas` | 1 | 8/[] |
| `yadori` | 1 | 12/[] |

`template-articles` のみ既定ブランチにマッチする ruleset が 0 件（effective
`required_status_checks` も 0 件）であり、他 24 リポは既定ブランチにマッチする ruleset が
1 件存在し、その `required_status_checks` が effective rules 上でも `total >= 1`・
`unbound` 空で一致した。**この再検証により「25 リポ中 24 リポが保護あり、
`template-articles` のみ保護なし」という 4 節の結論は既定ブランチ基準で裏付けられた
（誤判定は検出されなかった）。** ただしこれは ruleset の**構造**が green であることの
裏付けであり、`docs/update-external-rollout.md` が要求する「実際に PR が `BLOCKED` に
なることの確認」とは別軸である。後者は 4.2 節で扱う。

### 4.2 個別 PR レベルの実測（P0 是正・測定日: 2026-08-19）

`docs/update-external-rollout.md` の判定基準は、組織変数追従（`skills-auto-merge:
${{ vars.SKILLS_AUTO_MERGE || 'false' }}`）を許容する条件として「実際に PR が
required checks の完了を待って `BLOCKED` になることを確認した」ことを明記している
（同ファイル 121 行・158 行）。3〜4.1 節の構造的実測（ruleset 設定）だけではこの基準を
満たさないため、これを埋める確認を行った。

`VARS_FOLLOW` 25 リポのうち、`team-hub-spec` は #342 実測時に同期 PR #58 が実際に
`BLOCKED` で待機していることを確認済み（`docs/update-external-rollout.md` 158 行）で
あり、25 リポ中唯一の PR レベル確認済みリポジトリである。残り 24 リポ
（`template-articles` を含む）について、上流スキル同期 PR の open 状態を次のコマンドで
確認した:

```bash
gh pr list -R "Fandhe-AI/<repo>" --state open --search "エージェントスキル" \
  --json number,title,mergeStateStatus,isDraft --limit 5
```

結果: 24 リポすべてで該当する open PR が **0 件**（`[]`）だった。open PR が無い理由は
リポジトリによって異なり、本監査ではそれぞれを個別に確定できていない。`template-articles`
は 4 節のとおり同期 PR 自体が一度も作成されていないことを確認済みであり「自動マージ済み」
ではない。残り 23 リポについては、直近の同期 PR が required checks 通過後に既に
自動マージ済みで観測窓を外れた可能性・まだ schedule が一度も走っていない可能性のいずれも
排除できず、`gh pr list --state open` の 0 件という結果からは断定できない。マージ済み PR
の `mergeStateStatus` 履歴は事後に取得できないため、遡って `BLOCKED` だったことを
確認することもできない。（仮に `CLEAN` な状態を観測できたとしても、それ自体はサーバー側
強制が働いたことの証明にはならない点にも注意する。今回は `CLEAN` の観測すらなく、単に
確認対象の open PR が存在しなかった。）**したがって 23 リポについて「自動マージ済み」と
断定せず、PR レベルの状態は観測不能だったに留める。**

**`ruleset-policy.md` の「判定不能を green に倒さない」方針に従い、PR レベルで確認でき
なかった 24 リポ（`template-articles` を含む）は、3〜4.1 節の構造的実測の結果（保護あり
/ なし）によらず fail-closed 対象として扱う。** 5 節の方針決定はこれを反映する。

## 5. 方針決定

イシュー本文の受入条件 a / b、および 4.2 節の PR レベル実測結果を踏まえ、**案 a
（wrapper で `skills-auto-merge: 'false'` を明示）を適用する方針を決定した。適用対象は
PR レベルでサーバー側強制を確認できた `team-hub-spec` を除く `VARS_FOLLOW` 24 リポ
（`template-articles` を含む）。このうち本リポジトリ自身（`agent-cli-skills`）は
このドキュメントを含む本 PR で実際に適用済み（`.github/workflows/update-external.yml`。
「6. 適用すべき変更内容」参照）。残り 23 リポは本 worktree からの書き込み対象外の
別リポジトリであり、後続担当への引き継ぎとする（「7. 実施状況」参照）。**

- 案 a は #342 と同一の前例があり、変更が wrapper 1 行 + コメントに閉じ、可逆で、他の運用
  （手動マージ・schedule 実行そのもの）を壊さない。24 リポへ一律適用してもリポごとの
  差分の種類は増えない（値は同じ `'false'`、理由コメントのみリポごとに実測内容へ差し替える）。
- 案 b（branch protection / ruleset の新設）は required check の設計
  （PR で必ず実行される context の選定・`integration_id` 束縛・条件付きチェック除外）を
  リポごとに要し、`ruleset-policy.md` の制約上オーナー判断を伴う構成変更になる。
  24 リポ分を即断できないため、**新設は行わず、後続イシューとして起票する候補として
  記録するに留める**（本イシューでは着手しない）。
- **案 c（組織変数 `SKILLS_AUTO_MERGE` を `false` へ戻す、または
  `SKILLS_AUTO_MERGE_ALLOWLIST` を明示して対象を絞る）も評価した。** 1 箇所の変更でフリート
  全体に効き、個別リポでの drift（新規リポが無審査で追従してしまう再発）を構造的に防げる点で
  案 a より筋が良い。しかし組織変数の変更は `team-hub-spec` を含む既存運用（保護ありかつ
  PR レベル確認済みのリポでの組織変数追従は `.claude/rules/ruleset-policy.md` が要求する
  運用そのもの）に影響する組織レベルの状態変更であり、このイシューの決定範囲・本エージェントの
  書き込み対象（`agent-cli-skills` へのローカルコミット・push のみ。組織設定・他リポジトリへの
  書き込みは対象外）を超える。**適用しない。将来
  `SKILLS_AUTO_MERGE_ALLOWLIST` を allowlist 運用に切り替える案として記録するに留める。**

## 6. 適用すべき変更内容（`agent-cli-skills` は本 PR で適用済み・残り 23 リポは後続担当への引き継ぎ）

4.2 節の PR レベル実測を踏まえ、`team-hub-spec` を除く `VARS_FOLLOW` 24 リポ
（`template-articles` を含む全件）の `.github/workflows/update-external.yml` にある
`skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}` を、
`docs/update-external-rollout.md` のテンプレートと同型のコメント +
`skills-auto-merge: 'false'` へ置換する変更を**方針として決定した**（差分案は下記）。
**このうち `agent-cli-skills` 自身は本ドキュメントと同じ PR の一部として
`.github/workflows/update-external.yml` へ実際に適用済み**（本リポジトリは本エージェントの
書き込み対象内であり、push 権限の欠如を理由に未適用とすることはできないため）。
**残り 23 リポ（`agent-cli-skills` を除く）は本 worktree の外側にある別リポジトリへの
書き込みであり、本エージェントの実行範囲（本リポジトリへのローカルコミット・push のみ）を
超えるため未適用のまま引き継ぐ。** 適用の実施状況は「7. 実施状況」を参照。

## 7. 実施状況（本イシューのスコープ境界）

**本タスク（実装エージェント）は本リポジトリ（`agent-cli-skills`）以外への push・書き込み・
PR 作成・イシューコメントを行わない契約下にある。** したがって:

- `agent-cli-skills` を除く 23 リポへの実際の変更適用（PR 作成・マージ）
- 案 c（組織変数の変更）の実施
- 案 b（branch protection 新設）の起票・実施
- 本イシュー #359 への判定結果コメント

はいずれも `outOfScope` として本エージェントの返却に記録し、実施しない
（`agent-cli-skills` への適用自体は 6 節のとおり本 PR 内で実施済みであり対象外ではない）。
実装計画の Step 5/7/8（25 リポへの横断適用・本リポ PR 作成・イシューコメント）は、
`agent-cli-skills` 分の実適用 + 本ドキュメント作成をもって部分的に代替し、残り 23 リポへの
適用は後続の担当（該当リポジトリへの push/PR 作成が許可されたエージェント、
またはユーザー自身）に委ねる。

**追跡先はイシュー #359 とする。** 本 PR は #359 を `Closes` せず `Refs` で参照するに留め、
残り 23 リポ（6 節末尾の一覧）への適用・案 b／案 c の要否判断が完了するまで #359 を open の
まま残す。後続担当は #359 のコメントで各リポの適用状況（PR URL・適用済み差分・未適用の理由）
を追記し、23 リポすべてに適用が完了した時点で #359 を close する運用とする。

`agent-cli-skills` に実際に適用した差分（`.github/workflows/update-external.yml`）:

```diff
-      skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}
+      # 組織変数 vars.SKILLS_AUTO_MERGE は実測で 'true'（visibility: all）であり、
+      # allowlist 未指定と組み合わさると「全スキルを自動マージ対象」と判定される。
+      # 本リポジトリの branch ruleset 構造は保護あり（active/bypass:0/total:12/unbound:[]）
+      # だが、上流スキル同期 PR が required checks 完了を待って実際に BLOCKED になることは
+      # 測定日時点で確認対象の open な同期 PR が無く未確認（PR レベルの状態は観測不能）。
+      # `docs/update-external-rollout.md` の組織変数追従への切替条件（PR レベルの BLOCKED
+      # 確認必須）を満たさないため fail-closed の 'false' を明示する。詳細は
+      # docs/skills-auto-merge-fleet-audit.md（イシュー #359）4.2/5/6 節を参照。
+      skills-auto-merge: 'false'
```

`template-articles` へ適用すべき差分（参考・未適用。ruleset/classic BP とも不在が理由）:

```diff
-      skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}
+      # 組織変数 vars.SKILLS_AUTO_MERGE は実測で 'true'（visibility: all）であり、
+      # allowlist 未指定と組み合わさると「全スキルを自動マージ対象」と判定される。
+      # 本リポジトリは branch ruleset も classic branch protection も持たない
+      # （2026-08-19 実測: rulesets が空配列・branches/main/protection が 404）ため、
+      # マージ前に bypass 不能な required status checks をサーバー側で強制していることを
+      # 実測できない。詳細は agent-cli-skills イシュー #359 /
+      # docs/skills-auto-merge-fleet-audit.md を参照。
+      skills-auto-merge: 'false'
```

残り 22 リポ（`agent-cli-skills`・`template-articles` を除く。
`agent-reference-skills` / `articles` / `automation` /
`automation-app` / `baby-tasks-app` / `brain-training-app` / `desktop-automation-app` /
`fandhe-backend` / `fandhe-frontend` / `fandhe-multi-platform` / `ideas` / `life-plan-app` /
`local-llm-server` / `local-server` / `mirror-ui` / `pet-hub` / `pronunciation-vocab-app` /
`rust-ai-library` / `team-hub` / `template-frontend-react_router` / `template-ideas` /
`yadori`）は ruleset の構造的実測（4 節）自体は green のため、置換後の値
（`skills-auto-merge: 'false'`）は同じだが、理由コメントは「ruleset 構造は green だが
同期 PR が `BLOCKED` になることを個別確認できていない（4.2 節参照。測定日時点で open な
同期 PR が存在せず観測不能）」という別内容に差し替える。適用時は 4 節・4.2 節の実測値
（リポ名・total/unbound）をコメントへ反映すること。

## 8. 関連ドキュメント

- `docs/update-external-rollout.md` — #342 の 5 リポ導入記録・同型のテンプレートと判定基準
- `.claude/rules/ruleset-policy.md` — 3 軸 + classic BP の検証手順・判定表

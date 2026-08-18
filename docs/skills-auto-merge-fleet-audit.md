# wrapper 導入済みリポの skills-auto-merge fail-closed 監査（イシュー #359）

イシュー #342 では新規導入 5 リポのうち保護なし 4 リポを `skills-auto-merge: 'false'` 明示で
fail-closed 化した（`docs/update-external-rollout.md` 参照）。本ドキュメントは **#342 以前から
`update-external.yml` wrapper を持つ既存リポ**を同じ観点で棚卸しし、方針を決定・適用した記録。

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

（`agent-cli-skills` 自身も `VARS_FOLLOW` である。本リポは後述のとおり保護ありのため対象外。）

## 3. 判定基準

`.claude/rules/ruleset-policy.md` の「一括更新後の検証（3 軸 + classic BP）」と同じ実測軸を
リポごとに適用する。

| 軸 | green 条件 |
|----|-----------|
| ruleset ソース | `source_type == "Repository"`（Organization 継承は本監査では未出現） |
| enforcement | `active` |
| bypass_actors | 全 branch ruleset で `0` |
| required status checks | `total >= 1` かつ `unbound`（`integration_id` 欠落）が空 |
| classic BP | 未設定（404）、または設定ありで `strict` が `false`/`none` かつ `app_id` 束縛あり |

全軸 green なら「保護あり」、1 つでも欠ける・判定不能（403 等）なら「保護なし」として
fail-closed 側へ倒す（`ruleset-policy.md` の方針どおり、判定不能を green に倒さない）。

**適用範囲の限定（既知の簡略化）**: 本監査は上記の構造的実測（ruleset 設定）までを行い、
`team-hub-spec`（#342 実測時に同期 PR #58 の `BLOCKED` を確認済み）のような
個別 PR レベルのサーバー側強制の逐次確認は 25 リポ全件には行っていない。
`agent-cli-skills` と `fandhe-backend` も `ruleset-policy.md` に別途実測記録がある
（`main-protection` active・bypass 0）。それ以外の 22 リポは本監査のスイープ実行結果のみを
根拠とする。挙動レベルの追加確認（PR が実際に `BLOCKED` になるか）は本監査のスコープ外とし、
必要なら後続で個別に実施する。

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

## 5. 方針決定

イシュー本文の受入条件 a / b のうち、**案 a（wrapper で `skills-auto-merge: 'false'` を明示）を
`template-articles` 1 リポにのみ適用する。**

- 案 a は #342 と同一の前例があり、変更が wrapper 1 行 + コメントに閉じ、可逆で、他の運用
  （手動マージ・schedule 実行そのもの）を壊さない。
- 案 b（branch protection / ruleset の新設）は required check の設計
  （PR で必ず実行される context の選定・`integration_id` 束縛・条件付きチェック除外）を
  リポごとに要し、`ruleset-policy.md` の制約上オーナー判断を伴う構成変更になる。
  `template-articles` はテンプレートリポであり CI 構成が薄いため、required check の設計自体が
  即断できない。**新設は行わず、後続イシューとして起票する候補として記録するに留める**
  （本イシューでは着手しない）。
- **案 c（組織変数 `SKILLS_AUTO_MERGE` を `false` へ戻す、または
  `SKILLS_AUTO_MERGE_ALLOWLIST` を明示して対象を絞る）も評価した。** 1 箇所の変更でフリート
  全体に効き、個別リポでの drift（新規リポが無審査で追従してしまう再発）を構造的に防げる点で
  案 a より筋が良い。しかし組織変数の変更は 24 リポの既存運用（保護ありリポでの組織変数追従は
  `.claude/rules/ruleset-policy.md` が要求する運用そのもの）に影響する組織レベルの状態変更であり、
  このイシューの決定範囲・本エージェントの実行権限（ローカルコミットのみ・push/PR 作成不可）を
  超える。**適用しない。将来 `SKILLS_AUTO_MERGE_ALLOWLIST` を allowlist 運用に切り替える案として
  記録するに留める。**

## 6. 適用内容

`template-articles` の `.github/workflows/update-external.yml` の
`skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}` を、`docs/update-external-rollout.md`
のテンプレートと同型のコメント + `skills-auto-merge: 'false'` へ置換する変更を用意した
（本ドキュメントおよびリポジトリ横断の適用は「7. 実施状況」を参照）。

## 7. 実施状況（本イシューのスコープ境界）

**本タスク（実装エージェント）は push・他リポジトリへの書き込み・PR 作成・イシューコメントを
行わない契約下にある。** したがって:

- `template-articles` への実際の変更適用（PR 作成・マージ）
- 案 c（組織変数の変更）の実施
- 案 b（branch protection 新設）の起票・実施
- 本イシュー #359 への判定結果コメント

はいずれも `outOfScope` として本エージェントの返却に記録し、実施しない。
実装計画の Step 5/7/8（25 リポへの横断適用・本リポ PR 作成・イシューコメント）は
本ドキュメント作成をもって代替し、適用は後続の担当（push/PR 作成が許可されたエージェント、
またはユーザー自身）に委ねる。

`template-articles` へ適用すべき差分（参考・未適用）:

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

## 8. 関連ドキュメント

- `docs/update-external-rollout.md` — #342 の 5 リポ導入記録・同型のテンプレートと判定基準
- `.claude/rules/ruleset-policy.md` — 3 軸 + classic BP の検証手順・判定表

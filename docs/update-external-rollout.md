# SYNC-CI-ABSENT 5 リポへの update-external.yml 導入

`.github/workflows/update-external-drift.yml`（乖離検知）の軸 3 が「`.agents/skills` と
`skills-lock.json` を vendor 済みだが `update-external.yml` を持たない」リポジトリを
5 件（分類 `SYNC-CI-ABSENT`）検出していた。イシュー #342 の成果物として、採用した導入案
（A / B / C の評価）と 5 リポへの導入手順・実測結果を記録する。

`.claude/skills` が実ディレクトリ（tree mode `040000`）である場合の checkout 失敗
（イシュー #256）は本ドキュメントの対象外。対象 5 リポでの再燃有無は導入実行時に
S5 の判定ルールに従って個別に確認・記録する。

## 対象リポジトリ

| リポジトリ | 既定ブランチ | ruleset | classic BP | `.gitmodules` | `.agents/skills` エントリ数 | 既存 workflow |
|---|---|---|---|---|---|---|
| `Fandhe-AI/aliz-corporate-web` | main | なし（`[]`） | 404 | あり（8 件） | 35 | なし |
| `Fandhe-AI/automation-spec` | main | なし | 404 | なし | 17 | なし |
| `Fandhe-AI/hobby-keyboard` | main | なし | 404 | なし | 14 | なし |
| `Fandhe-AI/mcp_hub-spec` | main | なし | 404 | なし | 9 | markdownlint / openapi |
| `Fandhe-AI/team-hub-spec` | main | `main-protection`（active・bypass 0） | 404 | なし | 17 | ci / codex-review |

2026-08-18 実測（`gh api repos/{repo}/rulesets` の件数、`gh api repos/{repo}/contents/.github/workflows/update-external.yml` の 404）で再確認済み。ruleset・既存 workflow の有無は変わっていない。

## 方針決定（A / B / C の評価）

**採用: 案 A — 5 件とも通常の wrapper（日次 schedule + workflow_dispatch）を導入する。**

- **却下 B**（低活動リポは `workflow_dispatch` のみ）: `docs/update-external-schedule.md`
  の軸 5 判定仕様は「`on:` に `schedule` を持つ」リポのみを対象とし、`workflow_dispatch`
  のみの wrapper を明示的に対象外としている。案 B は「同期が死んでいても検知されない」
  状態を作り、本イシューが解こうとしている無告知停止をむしろ悪化させる。
- **却下 C**（上流からの一括 dispatch / keepalive）: イシュー #304 が「無活動カウンタを
  Actions 実行がリセットするか公式ドキュメントで確認できない」ことを理由に keepalive を
  恒久対策として不採用と決定済み。加えて `actions: write` を持つ PAT が新たに必要で、
  資格情報の境界を広げる。#304 の決定を本イシューで覆さない。
- 案 A の残リスク（低活動 3 リポで schedule が自動無効化され得る）は、#304 が採用した
  「軸 5 で検知 → `docs/update-external-schedule.md` の復旧手順で人手再有効化」で担保する。

この評価結果はイシュー #342 へコメントとして記録する（後続の push/PR 作成担当が実施）。

## 導入する wrapper（共通テンプレート）

5 リポ共通。`<SHA>` は上流 `Fandhe-AI/actions` main の到達性確認済みコミット、
`runner-json` は組織 self-hosted runner（`self-hosted` 単独は OS を限定しないため
複数ラベル指定）。

```yaml
# 外部ソース（submodule 参照・エージェントスキル）の自動追従ワークフロー。
#
# 実装本体は Fandhe-AI/actions の reusable workflow `.github/workflows/update-external.yml`。
# 本ファイルはリポジトリ固有の設定だけを持つ薄い wrapper であり、fail-closed ガード・
# `persist-credentials`・`source-token`・外部 action の pin・Node / skills CLI の版数は
# 共通側で集中管理される。
#
# 導入経緯: 本リポジトリは `.agents/skills` と `skills-lock.json` を持ちながら同期 CI が
# 無く、上流スキル更新が届いていなかった（Fandhe-AI/agent-cli-skills イシュー #342、
# 乖離検知の分類 SYNC-CI-ABSENT）。
#
# 参照 SHA の検証記録（<YYYY-MM-DD> 実測）:
# - 到達性: `gh api repos/Fandhe-AI/actions/compare/main...<SHA>` → `ahead_by: 0`
#   （upstream main の祖先であることを確認）
# - 入力契約: 同 SHA の `on.workflow_call` を contents API で取得し、inputs 11 件・
#   secrets 2 件（いずれも required: false）であること、本ファイルの with / secrets が
#   その範囲内であることを照合した
# - 権限: 呼び出し先ジョブの permissions は validate-inputs `{}`・submodule / skills が
#   `contents: read`。本ファイルの `permissions: contents: read` で充足する
# - タグ未公開（0 tags / 0 releases）のため SHA 固定が必須。Dependabot の自動更新は効かない
#
# runner: 組織 self-hosted runner（Default グループ・visibility all）を使う。素の
# `self-hosted` 単独は OS を限定しないため、上流の推奨どおり複数ラベルで指定する。

name: Update external sources

on:
  schedule:
    - cron: '0 0 * * *'   # 00:00 UTC = 09:00 JST
  workflow_dispatch:
    inputs:
      target:
        description: '更新対象（手動実行時のみ有効。schedule は常に all）'
        type: choice
        required: false
        default: all
        options:
          - all
          - submodule
          - skill

permissions:
  contents: read

# reusable workflow のトップレベル concurrency は機能しないため呼び出し側で設定する
concurrency:
  group: update-external
  cancel-in-progress: false

jobs:
  update-external:
    # Fandhe-AI/actions はタグ未公開のため main 追従の最新コミット SHA に固定する
    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@<SHA> # main
    permissions:
      contents: read
    with:
      target: ${{ inputs.target || 'all' }}
      runner-json: '["self-hosted","Linux"]'
      submodule-auto-merge: ${{ vars.SUBMODULE_AUTO_MERGE || 'false' }}
      submodule-auto-merge-allowlist: ${{ vars.SUBMODULE_AUTO_MERGE_ALLOWLIST }}
      skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}
      skills-auto-merge-allowlist: ${{ vars.SKILLS_AUTO_MERGE_ALLOWLIST }}
    secrets:
      SUBMODULE_PAT: ${{ secrets.SUBMODULE_PAT }}
      SKILLS_PAT: ${{ secrets.SKILLS_PAT }}
```

固定した設計判断:

- `enable-submodule` / `enable-skills` は渡さない（既定 `true`）。`.gitmodules` を
  持たない 4 リポでは submodule ジョブは checkout 前の存在判定で no-op になる。
  `.gitmodules` を持つ `aliz-corporate-web` の `enable-submodule` 要否はイシューが
  明示的にスコープ外としているため、既定のまま導入して観測に留める。
- `cron` は本リポの既存 wrapper と同じ `0 0 * * *` に統一する（ずらさない）。
- `base-branch` は渡さない（既定 `main` = 5 リポとも既定ブランチ）。
- auto-merge は組織変数を解決して `'false'` フォールバック（既存運用と同一）。

### テンプレートの機械検証（2026-08-18 実測）

- `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1], encoding='utf-8'))"` →
  パース成功。
- `.github/scripts/check_update_external_drift.py` の `classify_workflow` に上記
  テンプレート（`<SHA>` を実測 SHA へ置換したもの）を通した結果:

  ```text
  {'kind': 'WRAPPER', 'pin': '0bd2cf930f5c78732abd539dfd468aa8c1363e15', 'reason': '', 'has_schedule': True}
  ```

  `kind == 'WRAPPER'`・pin 一致・`has_schedule == True` を確認した。
- 参照 SHA `0bd2cf930f5c78732abd539dfd468aa8c1363e15`（`Fandhe-AI/actions` main 実測時点の
  tip）について `gh api repos/Fandhe-AI/actions/compare/main...0bd2cf930f5c78732abd539dfd468aa8c1363e15`
  → `{"status":"identical","ahead_by":0,"behind_by":0}`。
- 同 SHA の `.github/workflows/update-external.yml` を contents API で取得し
  `on.workflow_call.inputs` 11 件・`secrets` 2 件（いずれも `required: false`）を確認。
  上記テンプレートの `with:` / `secrets:` キー（`target` / `runner-json` /
  `submodule-auto-merge` / `submodule-auto-merge-allowlist` / `skills-auto-merge` /
  `skills-auto-merge-allowlist` / `SUBMODULE_PAT` / `SKILLS_PAT`）はいずれもこの契約の
  範囲内。
- ジョブ権限: `validate-inputs` が `permissions: {}`、submodule / skills ジョブが
  `permissions: contents: read` であることを同 SHA のファイル内容で確認。
- 組織シークレット `SUBMODULE_PAT` は `visibility: all` で登録済み（
  `gh api orgs/Fandhe-AI/actions/secrets` で実測）。`SKILLS_PAT` は組織に未登録のため
  上流が `SUBMODULE_PAT` へフォールバックする。

### プレースホルダの置換（導入直前・全 5 リポ共通）

上記テンプレート（コードブロック内、47〜113 行目相当）に含まれる実プレースホルダは
`<YYYY-MM-DD>`（59 行目・検証記録コメントの見出し）と `<SHA>`（60 行目・検証記録コメント内の
`compare/main...<SHA>` 参照／100 行目・`uses:` 行）の計 3 箇所のみである。配置前に必ず置換する。

**137 行目は置換対象ではない。** 「テンプレートの機械検証」節（125〜150 行目）に記載した
`0bd2cf930f5c78732abd539dfd468aa8c1363e15` はテンプレートの `<SHA>` プレースホルダではなく、
2026-08-18 の検証実行時点で得た**実測値そのもの**（既に解決済みの具体的な SHA）を記録した
スナップショットである。プレースホルダと誤認して 137 行目を書き換えると、検証時点の実測記録
が導入実行時点の値で上書きされ、過去の検証がいつ・どの SHA に対して行われたかの記録が失われる。
置換対象はテンプレートのコードブロック内（59・60・100 行目）に限定し、「テンプレートの機械検証」
節（125〜150 行目）には一切手を加えない。

1. `SHA=$(gh api repos/Fandhe-AI/actions/commits/main --jq '.sha')` で最新 SHA を取得する。
2. `DATE=$(date -u +%Y-%m-%d)` で置換用日付を取得する。
3. `gh api repos/Fandhe-AI/actions/compare/main...${SHA}` で `ahead_by: 0` を再確認する
   （導入直前に SHA を取り直したため到達性の再確認も必須）。
4. テンプレートのコードブロック内（59・60・100 行目のみ。「テンプレートの機械検証」節の
   137 行目は対象外）にある `<SHA>` を全箇所 `${SHA}` へ、`<YYYY-MM-DD>`（59 行目）を
   `${DATE}` へ置換してから、リポごとの wrapper 内容を確定する。
5. 置換後の内容を `.github/scripts/check_update_external_drift.py` の `classify_workflow`
   に通し、`kind == 'WRAPPER'` かつ `pin == "${SHA}"` かつ `has_schedule == True` を、
   置換漏れがないことの機械的な確認として実行してから PUT / コミットへ進む。

置換漏れ（`<SHA>` や `<YYYY-MM-DD>` が残ったまま配置）は reusable workflow の解決失敗
（初回実行・日次同期の即時失敗）に直結するため、上記 5 を経ずに導入手順 2・3 へ進まない。

## 導入手順（実行担当は本ドキュメント作成後の別フェーズ）

1. **ラベル作成**（5 リポ共通、冪等）: `dependencies` / `automated` ラベルを対象 5 リポの
   それぞれで `gh label create dependencies ... --repo Fandhe-AI/<REPO>` /
   `gh label create automated ... --repo Fandhe-AI/<REPO>` のように作成する。実行担当の
   作業ディレクトリが本ドキュメント配置先の `agent-cli-skills` であることを踏まえ、
   `--repo` を必ず明示する（省略すると作業ディレクトリの `origin` = `agent-cli-skills`
   自身にラベルを作成してしまう）。上流 composite の `gh pr create` が
   `pr-labels: 'dependencies,automated'` をハードコードしているため、未作成だと
   同期 PR 作成が失敗する。
2. **ruleset の無い 4 リポ**（`aliz-corporate-web` / `automation-spec` /
   `hobby-keyboard` / `mcp_hub-spec`）: 上記「プレースホルダの置換」を実行して確定した
   wrapper 内容で `PUT /repos/{o}/{r}/contents/.github/workflows/update-external.yml`
   を実行し `main` へ直接コミットする。
3. **`team-hub-spec`**: `main-protection` ruleset により直接 push 不可。上記「プレース
   ホルダの置換」を実行して確定した wrapper 内容でブランチを切り
   `PUT contents` → `gh pr create --repo Fandhe-AI/team-hub-spec` → 必須チェック 4 件
   （`EditorConfig (strict)` / `PoC rustfmt --check` / `Broken link check (lychee)` /
   `Cursor Bugbot`）の green を `gh pr checks --repo Fandhe-AI/team-hub-spec --watch` で
   確認 → `gh pr merge --repo Fandhe-AI/team-hub-spec --squash`。手順 1 と同じ理由
   （作業ディレクトリの `origin` が `agent-cli-skills` 自身であるため）で、これら
   `gh pr` コマンドにも `--repo` を必ず明示する。ruleset の緩和・bypass 付与は
   行わない（`.claude/rules/ruleset-policy.md`）。必須チェックが構造的に埋まらない場合は
   マージせず状況をイシューへ記録して停止する。
4. **初回実行**: 各リポで対象を明示して実行・監視する（作業ディレクトリの
   `origin`（`agent-cli-skills`）へ誤って起動・参照しないよう、以下いずれの
   コマンドにも `--repo Fandhe-AI/<REPO>` を必ず付ける）。`aliz-corporate-web` のみ
   4-1〜4-2 を 2 回に分けて段階的に確認する（他 4 リポは `target=all` で 1 回）。
   1. dispatch 直前に既存 run ID 集合と自分の actor を記録する（BEFORE 集合 / ACTOR）:
      `gh run list --repo Fandhe-AI/<REPO> --workflow update-external.yml --limit 20 --json databaseId --jq '[.[].databaseId] | sort'`
      と `ACTOR=$(gh api user --jq '.login')` の出力を保存する。`ACTOR` は dispatch を
      実行する認証主体（`gh auth status` のユーザー）のログイン名であり、次段の候補
      run を「自分が起動した run」だけに絞り込む相関キーとして使う。取得できない
      （空文字・エラー）場合は、この認証状態自体が信頼できないと判断し、以降の
      dispatch を実行せず状況をイシューへ記録して停止する（fail-closed）。
      `gh run list` の `--json` はこの相関に使う `actor` フィールドを持たない
      （`gh run list --json bogus` のエラー出力で確認可能なフィールド一覧に `actor`
      は含まれない）ため、次段の候補特定は `gh run list` ではなく actor 指定付きの
      REST API（`gh api`）を使う。
   2. `target` を明示して dispatch する
      （`gh workflow run` はこの時点では run ID を返さないため、次段で BEFORE 集合との
      差分と ACTOR 一致から新規 run を特定する）。
      - `aliz-corporate-web`: まず
        `gh workflow run update-external.yml --repo Fandhe-AI/aliz-corporate-web -f target=skill`
        で skills 経路のみを先に確定し、本手順 4-3〜4-6 を完走させて結論を記録する。
        成功を確認したうえで改めて
        `gh workflow run update-external.yml --repo Fandhe-AI/aliz-corporate-web -f target=all`
        を dispatch し（このとき BEFORE 集合も取り直す）、4-3〜4-6 をもう一度通す
        （submodule ジョブの失敗有無を切り分けて観測するため、いきなり `all` を実行しない）。
      - 他 4 リポ: `gh workflow run update-external.yml --repo Fandhe-AI/<REPO> -f target=all`
        で 1 回のみ dispatch する。
   3. dispatch 直後は一覧反映が遅延し得るため、REST API を actor・event 指定付きで
      ポーリングする（`gh run list` の `--json` は手順 4-1 の注記のとおり `actor` を
      持たないため使わない）:
      `gh api "repos/Fandhe-AI/<REPO>/actions/workflows/update-external.yml/runs?event=workflow_dispatch&actor=${ACTOR}&per_page=20" --jq '[.workflow_runs[] | {id,status,created_at}]'`。
      `actor` はサーバー側で絞り込まれるため、`ACTOR` が実際の起動主体と一致しない
      場合（例: GitHub App/bot 経由の dispatch で、`gh api user` のログインに
      実効 actor と異なる別名が付くケース）は候補が常に 0 件になり得る。この場合は
      「一覧未反映」と誤認せず、`ACTOR` の解決自体が信頼できないと判断して以下の
      0 件ポーリングの上限に達した時点で fail-closed とする（推測で ID 差分のみに
      緩めて再絞り込みはしない）。取得した最大 20 件のうち `.id` が **BEFORE 集合に
      含まれない**（= 手順 4-1 の ID 差分）run を候補とする（`event`/`actor` は既に
      クエリパラメータで絞り込み済み）。作成時刻 (`created_at`) だけを判定条件に
      せず、必ず ID 差分とサーバー側の actor/event 絞り込みの両方を経由する（ID 差分
      だけでは、自分より先に一覧へ反映された別ユーザーの dispatch を誤って候補に
      含め、その run を対象として確定し得るため）。
      - 候補が 0 件: まだ一覧に反映されていないと判断し、ポーリングを継続する。
        **上限 10 回（1 回あたり間隔 5 秒以上、合計 50 秒以上）を超えて 0 件が続く
        場合は取りこぼしまたは actor 不一致と判断し、それ以上ポーリングを続けず
        fail-closed で停止する**（無期限のポーリングは行わない）。停止時は BEFORE
        集合・`ACTOR`・直近の取得結果をそのままイシューへ記録し、人間の判断を仰ぐ。
      - 候補が 1 件: 直ちには確定しない。**5 秒以上間隔を空けて同じ絞り込みを再実行
        し、直近 2 回連続で同一の `id` 1 件のみが候補になったこと**（安定確認）を
        確認してから、その `id` を対象 run として確定する。1 回目と 2 回目で候補の
        `id` が変わった、または 2 回目に候補が 2 件以上になった場合は安定していない
        と判断し、上記 0 件の上限を共有カウントとして候補が 0 件または 1 件で安定
        するまでポーリングを継続する（反映タイミングのずれにより、1 回のポーリング
        では自分の run がまだ一覧に現れていないだけの可能性があるため、単発の 1 件
        確認では確定しない）。上限に達しても安定しない場合は同様に fail-closed で
        停止する。
      - 候補が 2 件以上（安定確認時を含む）: 同一 actor による同時期の別
        workflow_dispatch が発生し一意に識別できない状態（例: 同一トークンでの
        並行実行）と判断し、**推測で1件を選ばず fail-closed で停止する**。
        `docs/update-external-schedule.md` の切り分け手順には進まず、候補 run ID
        一覧と状況をそのままイシューへ記録し、人間の判断を仰ぐ。
   4. run ID を特定したら
      `gh run watch <databaseId> --repo Fandhe-AI/<REPO> --exit-status` で完了
      （`status == completed`）まで待機する。単発の `gh run list --limit 1` を一度
      呼ぶだけで結論とせず、`status` が `completed` になったことを確認してから
      `conclusion` を読む。
   5. 完了後に
      `gh run view <databaseId> --repo Fandhe-AI/<REPO> --json conclusion,url` で
      最終結論を取得する。「成功 + 同期 PR あり」「成功だが差分なしで PR なし」は
      いずれも正常終了として扱う。失敗時は `docs/update-external-schedule.md` の
      「SCHEDULE-FAILING の復旧手順」の切り分け表に従う。同一箇所で 3 回失敗したら
      `.claude/rules/debugging.md` に従いエスカレーションする。
5. **乖離検知の再実行**（`team-hub-spec` の PR マージ完了後）:
   `gh workflow run update-external-drift.yml --repo Fandhe-AI/agent-cli-skills` を実行し、
   レポート issue（#341）本文で `SYNC-CI-ABSENT` が 0 件であることを確認する。判定ゲートは
   `SYNC-CI-ABSENT == 0` のみ（`PIN-STALE` 等の残存は別イシュー #343 の担当）。
6. **記録**: 各手順の実測（コミット SHA・run URL・PR URL・drift 再実行結果）を下表へ追記し、
   イシュー #342 へコメントする。

## 実測結果

導入手順（S1〜S5）は本ドキュメント作成時点では**未実施**。以下は各行の実測値を埋める
ためのプレースホルダであり、推測値は記入しない。

| リポジトリ | ラベル作成 | wrapper 導入コミット | 初回実行 run | 同期結果 |
|---|---|---|---|---|
| `aliz-corporate-web` | 未実施 | 未実施 | 未実施 | 未実施 |
| `automation-spec` | 未実施 | 未実施 | 未実施 | 未実施 |
| `hobby-keyboard` | 未実施 | 未実施 | 未実施 | 未実施 |
| `mcp_hub-spec` | 未実施 | 未実施 | 未実施 | 未実施 |
| `team-hub-spec` | 未実施 | 未実施（PR + squash merge 経路） | 未実施 | 未実施 |

| 項目 | 状態 |
|---|---|
| `team-hub-spec` 導入 PR の `state`/`mergedAt` | 未実施 |
| 乖離検知 CI 再実行（run URL） | 未実施 |
| レポート issue（#341）の `SYNC-CI-ABSENT` 件数 | 未実施 |

## リスクと対処

| リスク | 影響 | 対処 |
|---|---|---|
| 同期 PR が下流の lint（`team-hub-spec` の editorconfig / lychee、`mcp_hub-spec` の markdownlint）で赤になる | 同期 PR がマージできない | 受入条件は「PR が作成されること」。事象を記録し後続イシューを起票する |
| `team-hub-spec` で `Cursor Bugbot` が起動しない | 導入 PR が恒久的にマージ不能 | ruleset を緩めず、状況をイシューへ記録して停止・エスカレーションする |
| 低活動 3 リポで schedule が自動無効化される | 同期が止まる | 軸 5 が検知 → `docs/update-external-schedule.md` の復旧手順。導入直後は猶予判定で偽陽性なし |
| `aliz-corporate-web` の submodule ジョブ失敗 | 日次 run が赤 → 将来 SCHEDULE-FAILING | `target=skill` で skills 経路を先に確定 → `target=all` で観測 → 失敗時は記録 + 後続イシュー（`enable-submodule` の要否判断はスコープ外） |
| 導入直後に `PIN-STALE` として再登場 | レポート件数は `SYNC-CI-ABSENT` 単独では減らない | 判定ゲートは `SYNC-CI-ABSENT == 0` のみ。pin 追従は #343 |

## スコープ外

- `SYNC-CI-ABSENT` の判定文言（#256 但し書き）の陳腐化修正 → #344
- wrapper の pin 自動追従 → #343
- `enable-submodule` 要否のポリシー判断 → 本イシューが明示的に対象外と宣言
- 5 リポの既存 CI・lint 設定の修正
- 5 リポへの実際の書き込み（ラベル作成・wrapper 導入コミット・PR 作成・マージ・
  workflow 初回実行）・乖離検知 CI の再実行・イシュー #342 へのコメント投稿。
  本フェーズはローカルコミットのみ許可されており、push・外部リポジトリへの書き込みは
  後続フェーズの担当

## 関連

- イシュー #342 — 本ドキュメントの元イシュー
- イシュー #256 — `.claude/skills` 実ディレクトリでの checkout 失敗
- イシュー #304 — `docs/update-external-schedule.md`（軸 5・復旧手順）
- イシュー #341 — 乖離検知レポート issue
- イシュー #343 — pin 自動追従
- イシュー #344 — `SYNC-CI-ABSENT` 判定文言の陳腐化修正
- `.claude/rules/ruleset-policy.md` — ブランチ ruleset 方針
- `.claude/rules/debugging.md` — 根本原因デバッグ規約
- `.github/scripts/check_update_external_drift.py` — 判定ロジック本体

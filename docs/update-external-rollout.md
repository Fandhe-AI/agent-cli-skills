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
   `hobby-keyboard` / `mcp_hub-spec`）: `PUT /repos/{o}/{r}/contents/.github/workflows/update-external.yml`
   で `main` へ直接コミット。
3. **`team-hub-spec`**: `main-protection` ruleset により直接 push 不可。ブランチを切り
   `PUT contents` → `gh pr create` → 必須チェック 4 件（`EditorConfig (strict)` /
   `PoC rustfmt --check` / `Broken link check (lychee)` / `Cursor Bugbot`）の green を
   `gh pr checks --watch` で確認 → `gh pr merge --squash`。ruleset の緩和・bypass 付与は
   行わない（`.claude/rules/ruleset-policy.md`）。必須チェックが構造的に埋まらない場合は
   マージせず状況をイシューへ記録して停止する。
4. **初回実行**: 各リポで対象を明示して実行・監視する（作業ディレクトリの
   `origin`（`agent-cli-skills`）へ誤って起動・参照しないよう、以下いずれの
   コマンドにも `--repo Fandhe-AI/<REPO>` を必ず付ける）。
   1. `gh workflow run update-external.yml --repo Fandhe-AI/<REPO>` で dispatch する
      （`gh workflow run` はこの時点では run ID を返さないため、次段で新規 run を
      run 一覧から特定する）。
   2. dispatch 直後は一覧反映が遅延し得るため、
      `gh run list --repo Fandhe-AI/<REPO> --workflow update-external.yml --limit 1 --json databaseId,event,status,createdAt`
      をポーリングし、`event == "workflow_dispatch"` かつ手順 4-1 の実行時刻以降に
      `createdAt` を持つ run が現れるまで待ってから対象 run の `databaseId` を確定する
      （queued のまま古い run を拾わないための識別）。
   3. run ID を特定したら
      `gh run watch <databaseId> --repo Fandhe-AI/<REPO> --exit-status` で完了
      （`status == completed`）まで待機する。単発の `gh run list --limit 1` を一度
      呼ぶだけで結論とせず、`status` が `completed` になったことを確認してから
      `conclusion` を読む。
   4. 完了後に
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

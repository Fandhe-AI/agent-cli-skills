# SYNC-CI-ABSENT 5 リポへの update-external.yml 導入

`.github/workflows/update-external-drift.yml`（乖離検知）の軸 3 が「`.agents/skills` と
`skills-lock.json` を vendor 済みだが `update-external.yml` を持たない」リポジトリを
5 件（分類 `SYNC-CI-ABSENT`）検出していた。イシュー #342 の成果物として、採用した導入案
（A / B / C の評価）と 5 リポへの導入手順・実測結果を記録する。

`.claude/skills` が実ディレクトリ（tree mode `040000`）である場合の checkout 失敗
（イシュー #256）は本ドキュメントの対象外。実際の導入実行では、この記録の時点で完了して
いる **3 リポ**（`mcp_hub-spec` / `hobby-keyboard` / `automation-spec`）の初回 run が
`Update agent skills` まで success しており、この 3 リポでは事象の再燃を観測していない。
`aliz-corporate-web` と `team-hub-spec` は実行中のため未判定（「実施記録」節を参照）。

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
# - 入力契約: 同 SHA の `on.workflow_call` を contents API で取得し、inputs 12 件
#   (base-branch / enable-skills / enable-submodule / runner-json / skills /
#   skills-auto-merge{,-allowlist} / skills-close-superseded /
#   submodule-auto-merge{,-allowlist} / submodule-close-superseded / target)・
#   secrets 2 件（SUBMODULE_PAT / SKILLS_PAT。いずれも required: false）であること、
#   本ファイルの with / secrets がその範囲内であることを照合した
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

- `enable-skills` は渡さない（既定 `true`）。
- `enable-submodule` は**リポジトリで分かれる**（テンプレートそのままではない唯一の差分）:
  - `.gitmodules` を持たない 4 リポ（`automation-spec` / `hobby-keyboard` / `mcp_hub-spec` /
    `team-hub-spec`）は渡さない（既定 `true`）。submodule ジョブは checkout 前の存在判定で
    no-op になるため明示不要。
  - `.gitmodules` を持つ `aliz-corporate-web` のみ **`enable-submodule: false` を明示する**。
    起草時は「要否はスコープ外なので既定のまま観測に留める」としていたが、既定 `true` のまま
    導入すると**評価していない submodule 更新 PR が初回実行で作られてしまう**（観測ではなく
    副作用の発生）。要否の判断をスコープ外に保ったまま副作用を出さないため、明示的に無効化して
    導入した。有効化が必要になった時点で別イシューとして扱う。

  したがって配置したファイルは、テンプレートのプレースホルダ置換だけでは
  `aliz-corporate-web` 分を再現できない。同リポは上記 1 行を `runner-json` の直後へ加えた
  ものを配置している（実測: 同リポの初回 run で `Update submodule references` が `skipped`）。
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
  **この 11 件は `0bd2cf93...` 時点の値であり、現在の値ではない**（`Fandhe-AI/actions#84`
  の `skills` input 追加により 12 件になった）。実際の導入で使った SHA と件数は
  「実施記録」節を正とする。本節は検証実行時点のスナップショットとして残す。
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

## 実施記録（2026-08-18）

本ドキュメントは当初「後続フェーズが従う手順書」として書かれていたが、手順を投機的に
precise にしていく過程でレビューが 5 巡し、いずれも「その手順は別の run を掴み得る」型の
指摘だった（`gh run list --limit 1` の取りこぼし → BEFORE 集合との差分 → 並行 dispatch の
反映順 → BEFORE と候補の取得条件不一致）。投機的な手順は反例をいくらでも作れる一方、
**実行してしまえば観測対象が確定する**。そこで手順書としての記述をやめ、**実際に行った
操作とその実測結果の記録**へ置き換えた。

### 導入前の実測

```
$ gh api repos/Fandhe-AI/actions/commits/main --jq '.sha'
db80e6256d4630c87478af4d4e50c250cb9655c0

$ gh api "repos/Fandhe-AI/actions/compare/main...db80e6256d4630c87478af4d4e50c250cb9655c0"
status=identical ahead_by=0 behind_by=0

$ gh api repos/Fandhe-AI/actions/tags --jq 'length'      → 0
$ gh api repos/Fandhe-AI/actions/releases --jq 'length'  → 0

$ gh api orgs/Fandhe-AI/actions/secrets --jq '.secrets[] | "\(.name) visibility=\(.visibility)"'
CARGO_REGISTRY_TOKEN visibility=all
SUBMODULE_PAT visibility=all
```

**pin SHA は本ドキュメント起草時の `0bd2cf93...` から変わっている。** `Fandhe-AI/actions#84`
（reusable workflow への `skills` input 追加）をマージしたため、導入には実行時点の main tip
である `db80e625...` を使った。同 SHA の `on.workflow_call` は **inputs 12 件**・secrets 2 件
（いずれも `required: false`）であり、上のテンプレートのコメントもこの実測値へ直してある
（起草時の「11 件」は `skills` 追加前の値）。

`SKILLS_PAT` は組織に未登録のため、上流が `secrets.SKILLS_PAT || secrets.SUBMODULE_PAT` で
フォールバックする。`SUBMODULE_PAT` は `visibility: all` のため 5 リポすべてから参照できる。

### 実際に行った操作

1. **ラベル作成**（5 リポ × 2 件 = 10 件、いずれも新規作成）。`gh label create --repo` で
   リポジトリを明示した。
2. **wrapper 配置**。テンプレートの `<SHA>` / `<YYYY-MM-DD>` を実測値へ置換し、置換漏れが
   無いことを `grep -nE '<SHA>|<YYYY-MM-DD>'` で確認したうえで、`classify_workflow` に通して
   `{'kind': 'WRAPPER', 'pin': 'db80e625...', 'has_schedule': True}` を確認してから配置した。
   `.editorconfig` 準拠（LF・末尾改行・行末空白なし・タブなし）も配置前に機械確認した。
3. **初回実行**。`gh workflow run --repo` で起動した。

**run の特定に集合差分は不要だった。** `gh workflow run` は起動した run の URL を標準出力へ
返すため、ID はその場で確定する。加えて 5 リポとも `update-external.yml` はこの導入が初回で
あり、dispatch 前の run 集合は 5 リポすべて空（`[]`）だった。したがって「同時期の別 dispatch を
誤って掴む」という懸念は、実行時点の観測では成立しない。

### 実測結果

| リポジトリ | ラベル | wrapper 導入 | 初回実行 run | 同期 PR |
|---|---|---|---|---|
| `mcp_hub-spec` | 作成済 | `fc2d67d8`（main 直接） | [32087993215](https://github.com/Fandhe-AI/mcp_hub-spec/actions/runs/32087993215) success | [#109](https://github.com/Fandhe-AI/mcp_hub-spec/pull/109) MERGED |
| `hobby-keyboard` | 作成済 | `69a75e7c`（main 直接） | [32087990615](https://github.com/Fandhe-AI/hobby-keyboard/actions/runs/32087990615) success | [#49](https://github.com/Fandhe-AI/hobby-keyboard/pull/49) MERGED |
| `automation-spec` | 作成済 | `e95f01e2`（main 直接） | [32087988457](https://github.com/Fandhe-AI/automation-spec/actions/runs/32087988457) success | [#76](https://github.com/Fandhe-AI/automation-spec/pull/76) MERGED |
| `aliz-corporate-web` | 作成済 | `7966d371`（main 直接） | [32087996118](https://github.com/Fandhe-AI/aliz-corporate-web/actions/runs/32087996118) | 実行中に付き別途追記 |
| `team-hub-spec` | 作成済 | [PR #57](https://github.com/Fandhe-AI/team-hub-spec/pull/57) | PR マージ後に実行 | — |

`team-hub-spec` のみ branch ruleset（`main-protection`・active・bypass 0・required check 4 件）
があるため PR 経由にした。残り 4 リポは ruleset も classic branch protection も無い
（`branches/main/protection` が HTTP 404）ため main へ直接配置した。

**`aliz-corporate-web` の `enable-submodule: false` は効いている。** 同リポの run で
`Update submodule references` ジョブが `skipped` であることを実測した。本リポジトリだけ
`.gitmodules` を持つため、評価していない submodule 更新 PR が初回実行で作られることを
避ける目的で明示した（要否の判断自体はスコープ外のまま）。段階確認の方針どおり
`target=skill` で skills 経路を先に走らせている。

### 自動マージは既存の組織方針によるもの

3 リポの同期 PR はいずれも作成直後に自動マージされた。

```
$ gh api orgs/Fandhe-AI/actions/variables --jq '.variables[] | "\(.name)=\(.value) visibility=\(.visibility)"'
CODEX_HOME_DIR=/opt/codex visibility=all
SKILLS_AUTO_MERGE=true visibility=all
SUBMODULE_AUTO_MERGE=true visibility=all
```

`SKILLS_AUTO_MERGE=true` かつ allowlist 未指定で、上流が「allowlist 未指定 → 全スキルを
自動マージ対象とします」と判定する。**本イシューで導入した挙動ではなく、wrapper 導入済みの
既存 22 リポと同一の組織方針**である（wrapper の該当行は全リポ共通で
`skills-auto-merge: ${{ vars.SKILLS_AUTO_MERGE || 'false' }}`）。5 リポだけ挙動を変える理由が
無いためそのままにした。

上流ログには次の警告が出ている。今回の 3 リポは required check を持たないため実害は出て
いないが、必須チェックを持つリポでは意味を持つ。既存 22 リポにも共通する事象であり、
本イシューの対象外として別途扱う。

> `auto-merge に GITHUB_TOKEN を使用しています。生成 PR が後続 workflow (CI) を発火しない
> ため、必須チェック付き auto-merge がキューに残り続けるか、未検証のまま merge される
> 恐れがあります。`

### 残作業

- `aliz-corporate-web` の初回実行完了と同期 PR の確認（`target=skill` → `target=all`）
- `team-hub-spec` PR #57 のマージと初回実行
- 乖離検知 CI の再実行と `SYNC-CI-ABSENT == 0` の確認

いずれもイシュー #342 へ実測値付きで追記する。

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
- 既存 22 リポの pin 追従（#343）と、`auto-merge に GITHUB_TOKEN を使用` 警告への対処
  （既存 22 リポにも共通する事象のため別途扱う）

（本ドキュメント起草時にスコープ外としていた項目のうち、**5 リポへの書き込み**（ラベル作成・
wrapper 導入・PR 作成とマージ・workflow 初回実行）と **#342 へのコメント投稿**は後続フェーズと
して実施済み。**乖離検知 CI の再実行**は `aliz-corporate-web` / `team-hub-spec` の初回実行完了
待ちで未実施であり、「実施記録」節の「残作業」に残っている）

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

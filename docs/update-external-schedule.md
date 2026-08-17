# update-external の schedule 停止時の復旧手順と恒久対策

`.github/workflows/update-external-drift.yml`（乖離検知）の軸 5「定期実行の生存」が
検知する障害と、その復旧手順・恒久対策の決定をまとめる。イシュー #304 の成果物。

## なぜ軸 5 が要るか

`update-external.yml` の内容が上流 reusable wrapper に完全適合していても、GitHub が
`schedule` トリガを自動無効化していると同期は動かない。GitHub は「一定期間リポジトリ
活動が無い」状態で scheduled workflow を止めるため、テンプレート・spec 系の低活動
リポジトリがちょうど該当する。

軸 1-4（イシュー #260 / #261）は下流ファイルの**内容**しか見ないため、この
「ファイルは正しいのに同期が死んでいる」状態を検出できず、無告知で停止する。

**`state` 単独では検出できない。** 本イシューの計画立案時（2026-08-17T19:03Z）に
Fandhe-AI 配下 3 リポで実測したところ、次のとおりだった。

| リポジトリ | `state` | 最終 schedule 実行 | 経過 |
|---|---|---|---|
| `template-articles` | `active` | `2026-08-14T02:00:09Z` | 約 3.7 日 |
| `agent-cli-skills` | `active` | `2026-08-17T00:04:20Z` | 約 19 時間 |
| `fandhe-backend` | `active` | `2026-08-17T00:04:45Z` | 約 19 時間 |

`template-articles` は `state` が `active` を返しながら実行が止まっていた。`state` と
「最終 schedule 実行からの経過日数」の**両方**を使わないと検出できないことが、この
実測で裏付けられている。

## 判定仕様

対象は「`update-external.yml` が存在し（contents API 200）、reusable 定義本体ではなく、
YAML がパース可能で、`on:` に `schedule` を持つ」リポジトリ。**LEGACY 分類（手管理の
まま）のリポジトリも対象に含める。** 手管理のままでも同期自体は動いている場合と、
同期どころか schedule 自体が死んでいる場合とでは障害の種類も直し方も違うため、
1 リポが軸 1（LEGACY）と軸 5（SCHEDULE-STALE 等）の両方で報告されるのは意図どおり。
`workflow_dispatch` のみの wrapper（`on:` に `schedule` が無い）は軸 5 の対象外。

使用する API（いずれも組織シークレット `SUBMODULE_PAT`）:

- `GET repos/{repo}/actions/workflows/update-external.yml` → `state` ・ `created_at`
- `GET repos/{repo}/actions/workflows/update-external.yml/runs?event=schedule&per_page=1`
  → 直近 schedule 実行の `created_at`

判定表:

| 条件 | 分類 | 乖離か |
|---|---|---|
| `state` が `disabled_inactivity` | SCHEDULE-DISABLED（無活動による自動無効化） | Yes |
| `state` が `disabled_manually` | SCHEDULE-DISABLED（手動無効化） | Yes |
| `state` が `disabled_fork` | SCHEDULE-DISABLED（fork では schedule 不動作） | Yes |
| `state` が `active` かつ直近 schedule 実行が N 日以上前 | SCHEDULE-STALE | Yes |
| `state` が `active` かつ schedule 実行が見つからず `created_at` が N 日以内 | OK（導入直後の猶予） | No |
| `state` が `active` かつ schedule 実行が見つからず `created_at` が N 日超 | SCHEDULE-STALE（「直近の schedule 実行を確認できない」） | Yes |
| `state` が `active` かつ直近実行が N 日以内 | OK（`schedule_ok` へ計上） | No |
| API が 403 / 5xx・想定外 `state`・タイムスタンプ解析失敗 | UNKNOWN | 乖離ではないが issue は open のまま |

**「一度も実行されていない」とは書かない。** Actions の実行履歴には保持期間があり、
保持期間を超えて停止していたリポジトリは履歴があっても `total_count == 0` を返し
得る。文言は「直近の schedule 実行を確認できない」に限定する。

### しきい値 N の決定: 2 日（既定値）

- 健全時の実測ギャップは約 19 時間。検知ジョブは 03:00 UTC、`update-external` の
  cron は 00:00 UTC なので、スキャン時点の健全なギャップは約 3 時間。
- N=3 にすると「2 回連続で日次実行が飛んだ」状態が green に読める。実測の
  `template-articles` は 3.7 日経過だったが、検知ジョブが 1 日早く回っていれば
  ギャップは 2.04 日で **N=3 では取りこぼしていた**。
- 偽陽性のコストは報告 issue に自己解消する 1 行が出るだけ。偽陰性のコストは
  本イシューが防ごうとしている無告知停止そのもの。この非対称性がしきい値を決める。
- しきい値への依存を下げるため、finding の detail には**実際の最終実行
  タイムスタンプと算出経過日数を必ず併記**し、読み手がしきい値を信用せずに
  判断できるようにしてある。
- `.github/workflows/update-external-drift.yml` の `SCHEDULE_STALE_DAYS` 環境変数で
  上書きできる（正の整数以外はスクリプトが `ScanError` で拒否し、緩い値のまま
  黙って走らせない）。

## 前提

`SUBMODULE_PAT`（組織シークレット、visibility: all）に **Actions: read** 権限が
必要。軸 1-4 はこのスコープを一度も行使していない。権限が不足していると軸 5 の
候補リポジトリ全件で 403 になり、個別 UNKNOWN の山として見せず
`SUBMODULE_PAT に Actions: read 権限が必要` という `ScanError` でジョブ全体を
fail-closed に落とす（候補の一部だけが 403 の場合は systemic 扱いにせず、
その 1 件だけを UNKNOWN として残す）。

## 復旧手順

検知（`SCHEDULE-DISABLED` / `SCHEDULE-STALE`）した場合の手順。

1. **現状確認**（`state` と最終実行日時の両方を見る。片方だけでは判定できない）

   ```bash
   gh api repos/Fandhe-AI/<REPO>/actions/workflows/update-external.yml --jq '.state'
   gh api "repos/Fandhe-AI/<REPO>/actions/workflows/update-external.yml/runs?event=schedule&per_page=1" \
     --jq '(.workflow_runs[0].created_at // "none")'
   ```

2. **再有効化**

   ```bash
   gh api -X PUT repos/Fandhe-AI/<REPO>/actions/workflows/update-external.yml/enable
   ```

3. **疎通確認**（手動起動して成功を確認する）

   ```bash
   gh workflow run update-external.yml --repo Fandhe-AI/<REPO>
   gh run list --repo Fandhe-AI/<REPO> --workflow update-external.yml --limit 1
   ```

4. **恒久確認**（`state` が `active` に戻っただけでは復旧の証拠にならない。
   翌日以降に schedule 実行が実際に再開したことを実測する）

   ```bash
   # 翌日以降に再実行し、event が "schedule" であることを確認する
   gh api "repos/Fandhe-AI/<REPO>/actions/workflows/update-external.yml/runs?event=schedule&per_page=1" \
     --jq '.workflow_runs[0] | {created_at, event, conclusion}'
   ```

### コミットによる解消の可否（未確認）

GitHub 公式ドキュメント（[Disabling and enabling a workflow](https://docs.github.com/actions/managing-workflow-runs/disabling-and-enabling-a-workflow)）
を確認したが、次の 2 点について**明確な記述が無かった**。

1. 60 日の無活動カウンタが commit（push）のみでリセットされるのか、
   `workflow_dispatch` を含む任意の Actions 実行でもリセットされるのか
2. `disabled_inactivity` に落ちた workflow が、コミットだけで自動的に
   再有効化されるのか、それとも手動操作（Enable workflow ボタン）や
   `PUT .../actions/workflows/{id}/enable` API が必須か

公式ドキュメントには「automatically disabled」の記述と、手動での再有効化手順
（Actions タブから Enable）のみが明記されている。コミュニティの議論・第三者記事には
「push のみが activity としてカウントされ、リリース作成・タグ push・Issue 作成・
PR マージは含まない」という記述があったが、これは非公式情報であり、本ドキュメントは
**確認できていない前提を確定した仕様として書かない**という方針に従い、これを
根拠に断定しない。

**したがって「コミットで解消する」とは書かない。** 上記の手順 2（`enable` API による
明示的な再有効化）を必須の復旧手段として扱う。

## 低活動リポジトリへの恒久対策（決定）

### 却下（Step 1 の結果に依らず確定）

- **定期 no-op コミット** — 却下。履歴を汚し、コミット契機の CI を無駄に起動し、
  commitlint / ruleset の要求とも噛み合わない。
- **当該リポでは日次同期を諦める** — 却下。無告知停止こそが本イシューの問題で
  あり、放置は劣化を固定化する。

### 採用: 軸 5 で検知し、検知したら上記の手順に従って人手で再有効化する

公式ドキュメントで「Actions 実行（`workflow_dispatch` 等）が無活動カウンタを
リセットするか」を確定できなかったため、上流からの `workflow_dispatch` 集中実行
（keepalive）を恒久対策として**今は採用しない**。原理が確認できない対策を採用すると、
実際には効かない「対策済み」の状態を作りかねず、無告知停止という本イシューが防ぎたい
失敗モードを別の形で再生産する。

代わりに、検知の確実性（軸 5・N=2・fail-closed）で恒久的に担保する方針を採用する。
乖離検知は日次で走るため、停止から最大でも「N 日 + 検知ジョブの実行間隔」以内に
報告 issue が立つ。

keepalive が公式ドキュメントで確認でき次第、再検討の余地はある。その場合も
`actions: write` を持つ PAT が新たに必要になり、資格情報の境界を広げる判断になる
ため、実装は別イシューへ切り出しオーナー承認を要する。

## 関連

- イシュー #260 — 乖離検知の当初案（マーカー grep）
- イシュー #261 — 下流 19 リポの reusable wrapper 移行
- イシュー #264 — 4 軸への再定義
- イシュー #304 — 本ドキュメントの元イシュー（軸 5 の追加）
- `.claude/rules/verification.md` — 完了ゲート規約
- `.github/scripts/check_update_external_drift.py` — 判定ロジック本体

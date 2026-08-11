# report spec スキーマ

`scripts/render_report.py` が受け取る JSON report spec の完全な仕様。
renderer は本スキーマの spec を単一の自己完結 HTML へ変換する。座標計算・escaping・テーマ・アクセシビリティ属性は renderer の責務であり、spec には**生データと文言のみ**を書く（計算済み SVG 座標を保存しない）。

## 目次

- [実行方法](#実行方法)
- [トップレベル構造](#トップレベル構造)
- [kpis](#kpis)
- [findings](#findings)
- [sections](#sections)
- [chart 共通フィールド](#chart-共通フィールド)
- [chart type 別 data 形式](#chart-type-別-data-形式)
  - [bar](#bar) / [line](#line) / [scatter](#scatter) / [heatmap](#heatmap)
  - [waterfall](#waterfall) / [donut](#donut) / [radar](#radar) / [gantt](#gantt)
- [tables（独立データ表）](#tables独立データ表)
- [assumptions / sources / meta](#assumptions--sources--meta)
- [欠損値・検証ルール](#欠損値検証ルール)
- [最小例](#最小例)
- [完全例](#完全例)

## 実行方法

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/render_report.py" --spec <spec.json> --output <out.html>
python3 "${CLAUDE_SKILL_DIR}/scripts/validate_report.py" <out.html>   # 生成後必ず実行
```

## トップレベル構造

| フィールド | 必須 | 型 | 意味 |
|---|---|---|---|
| `title` | ✅ | string | レポートタイトル。`<h1>` と `<title>` に使用。可能なら結論を含める |
| `subtitle` | — | string | 副題 |
| `lang` | — | string | `<html lang>`。既定 `"ja"` |
| `date` | — | string | レポート基準日（表示用文字列） |
| `scope` | — | string | 対象・期間の説明 |
| `interactive` | — | boolean | `true` のときのみ inline JS（テーブルソート・TOC スクロールスパイ）を注入。既定 `false` |
| `summary` | — | string \| string[] | 要約。配列は段落ごとに `<p>` 化 |

**型契約**: spec の root は JSON object であること。`sections` / `kpis` / `findings` / `sources` / `assumptions` 等の配列フィールドとその要素（section / chart / table / kpi / source は object）が上表・各節の型と異なる場合、renderer は traceback を出さず日本語の SpecError（終了コード 1）で拒否する。
| `kpis` | — | array | [KPI カード](#kpis) |
| `findings` | — | array | [主な所見](#findings) |
| `sections` | — | array | [本文セクション](#sections)。**3 個以上で TOC が自動生成される** |
| `assumptions` | — | string[] | 前提・制約。欠損・仮定の明示に使う |
| `sources` | — | array | [出典](#assumptions--sources--meta) |
| `meta` | — | object | `generated_at`（省略時は現在時刻）・`generator` |

ページ構成は固定順: skip link → header（title/subtitle/date/scope）→ TOC → 要約 → KPI → 主な所見 → sections → 前提・制約 → 出典 → footer。

## kpis

```json
{"label": "月間リクエスト", "value": "4,210", "unit": "万件",
 "delta": "+12.4% 前月比", "trend": "up", "note": "補足"}
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `label` | ✅ | 指標名 |
| `value` | ✅ | 表示値（整形済み文字列。renderer は再整形しない） |
| `unit` | — | 単位（値の右に小さく表示） |
| `delta` | — | 増減の説明文字列 |
| `trend` | — | `"up"` / `"down"` / `"flat"`。矢印記号（↑↓→）と色を決める。色だけに依存させないため矢印+テキストが必ず付く |
| `note` | — | 補足文 |

KPI は「読者が最初に知る価値が高い値」に 3〜4 個へ限定する。

## findings

文字列、または `{"title": "...", "body": "..."}` の配列。`<ol>` で番号付き表示される。

## sections

```json
{"id": "cost", "heading": "コスト比較", "body": "説明文または段落配列",
 "charts": [ ... ], "tables": [ ... ]}
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `id` | — | アンカー ID（省略時 `sec-N`）。TOC・スクロールスパイが参照。下記「sections[].id の契約」に従う |
| `heading` | ✅ | `<h2>` 見出し |
| `body` | — | string \| string[]。段落として描画 |
| `charts` | — | chart 定義の配列。body → charts → tables の順で描画 |
| `tables` | — | chart に紐付かない独立データ表 |

### sections[].id の契約

renderer は違反を SpecError として拒否する（duplicate id の HTML を生成しない）。

- **一意性**: `id` はページ内で一意。自動採番 `sec-N`（省略時）との衝突も重複扱い
- **予約 ID**: renderer がページ骨格で固定使用する `main` / `toc` / `summary` / `kpis` / `findings` / `assumptions` / `sources`、および chart アクセシビリティ用の自動採番形式 `ct-N` / `cd-N` は指定不可
- **形式**: 英字始まり + 英数字と `-` `_` のみ（空白・引用符・`#` 等は不可）

## chart 共通フィールド

全 chart type で共通。

| フィールド | 必須 | 意味 |
|---|---|---|
| `type` | ✅ | `bar` / `line` / `scatter` / `heatmap` / `waterfall` / `donut` / `radar` / `gantt` |
| `title` | ✅ | figcaption と SVG `<title>`。**単なる名詞ではなく takeaway を伝える文にする**（例:「売上は 3 か月連続増加」） |
| `unit` | — | 値の単位。軸ラベル・データ表の列見出しに付く |
| `source` | — | データ出典（chart 直下に「出典: …」で表示） |
| `note` | — | 注記 |
| `accessibility_summary` | 推奨 | SVG `<desc>` に入る screen reader 向け要約。**主要な数値と傾向を文章で書く**。省略時は自動生成の汎用文になる |

各 chart は figure 単位（figcaption → SVG → note/出典 → `<details>` 内の exact-data table）で描画され、データ表は renderer が自動生成する。閉じた `<details>` の中身はブラウザ仕様で印刷されないため、標準モード（`interactive` 未指定/false）では `open` 付きで出力し、interactive モードでは印刷時に JS（beforeprint / afterprint）が自動で開閉する。

## chart type 別 data 形式

### bar

```json
{"type": "bar", "orientation": "horizontal", "mode": "grouped",
 "categories": ["案A", "案B"],
 "series": [{"name": "スコア", "values": [2.9, 4.1]}]}
```

- `orientation`: `"horizontal"`（既定・カテゴリ比較向き）/ `"vertical"`（期間比較向き）
- `mode`: `"grouped"`（既定）/ `"stacked"`。stacked は**負値不可**
- `values` の `null` は当該バーを描かず、表では「—」
- 軸は必ず 0 を含む（axis integrity）。単一系列 horizontal は値の直接ラベル付き

### line

```json
{"type": "line", "x": ["2026-01", "2026-02"],
 "series": [{"name": "Web", "values": [1480, null]}],
 "annotations": [{"x": "2026-02", "label": "キャンペーン開始"}]}
```

- `x`: 時点ラベル配列（等間隔配置。多すぎるラベルは自動間引き）
- `values` の **`null` は gap**（線が途切れる）。0 に変換されない
- `annotations[].x` は `x` のラベル値、または `x_index`（0 始まり index）で位置指定。`x_index` は **整数かつ `0 <= x_index < len(x)` の範囲内**であること（小数・範囲外は SpecError。renderer は黙って切り捨て・clamp しない）
- 系列は色 + 破線パターンで区別（色覚多様性対応）

### scatter

```json
{"type": "scatter", "x_label": "レイテンシ（ms）", "y_label": "TCO（万円）",
 "series": [{"name": "各案", "points": [{"x": 98, "y": 4120, "label": "案B"}]}]}
```

- `points`: `{"x", "y", "label"}` の配列、または `[x, y]` ペア配列
- `label` は点の横に直接表示。系列はマーカー形状（●■▲◆）+ 色で区別

### heatmap

```json
{"type": "heatmap", "rows": ["月", "火"], "cols": ["午前", "午後"],
 "values": [[12, 98], [11, null]]}
```

- `values` は `rows × cols` の 2 次元配列。`null` は欠損セル（無色 + 「—」表示）
- 色は Viridis 近似の連続スケール（絶対色・グレースケール印刷でも判別可）。min/max ラベル付き凡例が自動で付く

### waterfall

```json
{"type": "waterfall", "items": [
  {"label": "2025-08", "value": 202, "type": "start"},
  {"label": "増量", "value": 22, "type": "delta"},
  {"label": "割引", "value": -18, "type": "delta"},
  {"label": "2026-08", "value": 218, "type": "total"}]}
```

- `type`: `"start"` / `"delta"`（増減。負値可）/ `"total"`。start / total は 0 起点、delta は直前の累積から積む
- `total` の `value` は**累積の検算値として絶対値を書く**（renderer は与えた値をそのまま 0 起点で描く）
- 増加・減少・累計は色 + 符号ラベルで区別。累積コネクタ（破線）自動描画

### donut

```json
{"type": "donut", "unit": "万円",
 "slices": [{"label": "コンピュート", "value": 126}]}
```

- `value` は非負のみ。中央に合計値、凡例に構成比（%）を自動表示
- part-to-whole 用途のみ。slice が多い場合は bar を検討する

### radar

```json
{"type": "radar", "max": 5, "axes": ["性能", "コスト", "運用性"],
 "series": [{"name": "案B", "values": [4.0, 4.5, 4.5]}]}
```

- `axes` は 3 軸以上。`max` は全軸共通の最大値（既定 5）で **0 より大きい値必須**（0 以下はエラー）。値は `0..max` 範囲必須（範囲外はエラー）
- **同一スケールへ正当に正規化できる場合のみ使う**（SKILL.md の anti-pattern 参照）

### gantt

```json
{"type": "gantt", "today": "2026-08-11", "tasks": [
  {"id": "T1", "name": "基本設計", "phase": "設計",
   "start": "2026-07-01", "end": "2026-07-17", "progress": 1.0, "status": "done"},
  {"id": "M1", "name": "設計承認", "phase": "設計",
   "milestone": true, "date": "2026-07-31", "status": "done",
   "dependsOn": ["T1"]}]}
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `today` | — | `YYYY-MM-DD`。**期間内にある場合のみ** today line（破線 + 「本日」ラベル）を描画 |
| `tasks[].name` | ✅ | タスク名（左列に表示） |
| `tasks[].phase` | — | フェーズ名。出現順にグルーピングされ、フェーズ見出し行が挿入される |
| `tasks[].start` / `end` | ✅（通常タスク） | `YYYY-MM-DD`。`end >= start` 必須（負期間はエラー）。**不明な日付を推測で埋めない**（不明タスクは spec に入れず assumptions に書く） |
| `tasks[].milestone` | — | `true` で milestone（diamond 表示）。`date` が必須になり `start`/`end` は不要 |
| `tasks[].progress` | — | `0.0..1.0` 厳格（範囲外は clamp せずエラー）。planned bar 上に不透明 overlay で重ねられ、% がテキスト表示される |
| `tasks[].status` | — | `done` / `in-progress` / `planned` / `at-risk` / `blocked`。色 + **日本語テキストラベル**（完了/進行中/予定/リスク/ブロック）で表示 |
| `tasks[].id` / `dependsOn` | — | 依存関係。矢印では描かず**依存関係テーブル**として chart 下に自動生成 |

- 日付軸の tick は期間長で自動選択: 120 日以下 → 週（月曜、`M/D`）、超 → 月（`YYYY-MM`）
- SVG と同一の task / start / end / progress / status がデータ表にも必ず出る

## tables（独立データ表）

```json
{"title": "リスク一覧", "columns": ["リスク", "影響", "件数"],
 "align": ["", "", "num"], "rows": [["互換性問題", "2週遅延", 3]], "note": "注記"}
```

- `rows` のセルは文字列または数値。数値は桁区切り整形され右寄せ
- `align` で列ごとに `"num"`（右寄せ）を明示できる。省略時は数値セルのみ右寄せ
- caption（`title`）と `<th scope>` は renderer が必ず付ける

## assumptions / sources / meta

```json
"assumptions": ["コストは 2026-07 時点の試算。", "欠測は補完せず gap とした。"],
"sources": [
  {"label": "評価会議 議事録", "url": "https://example.com/minutes"},
  {"label": "社内試算シート"}],
"meta": {"generated_at": "2026-08-11 21:00", "generator": "create-html-report"}
```

- `sources[].url` は **https のみリンク化**される。それ以外の scheme は文字列（`<code>`）表示に落ちる。リンクには `rel="noopener noreferrer"` が自動付与
- `meta.generated_at` を省略すると生成時刻が入る（決定的な出力が必要なら明示する）

## 欠損値・検証ルール

renderer は以下を機械検証し、違反時は日本語の `spec エラー:` で終了コード 1 を返す。

- すべての数値は**有限値**（NaN / Inf 不可）。文字列の数値も parse される
- 値数の不一致（series の values と categories/x/axes の長さ違い）はエラー
- stacked bar / donut の負値、radar の範囲外値・`max <= 0`、gantt の `progress` 範囲外・`end < start` はエラー
- 日付は `YYYY-MM-DD` 固定
- **欠損は `null` で表現する**。0 と欠損は別物として扱われる（line は gap、heatmap は無色セル、表は「—」）
- spec 由来の全文字列は escape されて挿入される。HTML タグを書いても文字列として表示されるだけで解釈されない

## 最小例

```json
{
  "title": "月次売上レポート — 3 か月連続増加",
  "sections": [
    {
      "heading": "売上推移",
      "charts": [
        {
          "type": "line",
          "title": "売上は 4 月以降 3 か月連続で増加",
          "unit": "万円",
          "x": ["4月", "5月", "6月"],
          "series": [{"name": "売上", "values": [820, 910, 1040]}],
          "accessibility_summary": "月次売上の折れ線。4月820万円、5月910万円、6月1,040万円と3か月連続増加。"
        }
      ]
    }
  ]
}
```

## 完全例

実運用相当の完全な例は `samples/` を参照する（すべて validate_report.py PASS 済み）。

| ファイル | 含む要素 |
|---|---|
| [samples/comparison.json](../samples/comparison.json) | KPI・findings・horizontal bar・radar・grouped bar・scatter・独立 table・interactive: true |
| [samples/project-gantt.json](../samples/project-gantt.json) | gantt（phase / milestone / progress / status / dependsOn / today）・リスク table |
| [samples/time-series.json](../samples/time-series.json) | line（null gap・annotation）・heatmap（欠損セル）・waterfall・donut |

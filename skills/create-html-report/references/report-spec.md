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
| `interactive` | — | boolean | `true` のときのみ inline JS（テーブルソート・TOC スクロールスパイ）を注入。既定 `false`。**boolean 厳格**: `true` / `false` のみ許容（`"false"` 等の文字列・数値は SpecError） |
| `summary` | — | string \| string[] | 要約。配列は段落ごとに `<p>` 化。string / string 配列以外（数値・object・null 要素混じりの配列等）は SpecError |

**型契約**: spec の root は JSON object であること。`sections` / `kpis` / `findings` / `sources` / `assumptions` および各 chart の主要配列フィールド（`categories` / `series` / `x` / `rows` / `cols` / `values` / `items` / `slices` / `axes` / `tasks` / `annotations` / `points` / `dependsOn` 等）とその要素（section / chart / table / kpi / source / series / item / slice / task / annotation は object）が上表・各節の型と異なる場合、renderer は traceback を出さず日本語の SpecError（終了コード 1）で拒否する。文字列を配列の代わりに渡す（例: `"categories": "XY"`）ことはできない。省略可の配列・object フィールドへの**明示 `null` は欠損（未指定）と同義**に正規化される（`annotations: null`・`dependsOn: null`・`meta: null` 等）。
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
| `label` | ✅ | 指標名。**欠落は SpecError** |
| `value` | ✅ | 表示値（整形済み文字列。renderer は再整形しない）。**欠落は SpecError** |
| `unit` | — | 単位（値の右に小さく表示） |
| `delta` | — | 増減の説明文字列 |
| `trend` | — | `"up"` / `"down"` / `"flat"` のみ（**enum 外は SpecError**。`"Up"` 等の表記ゆれ不可）。矢印記号（↑↓→）と色を決める。色だけに依存させないため矢印+テキストが必ず付く |
| `note` | — | 補足文 |

KPI は「読者が最初に知る価値が高い値」に 3〜4 個へ限定する。

## findings

文字列、または `{"title": "...", "body": "..."}` の配列。`<ol>` で番号付き表示される。要素が string でも object でもない場合（数値・配列等）は SpecError。

## sections

```json
{"id": "cost", "heading": "コスト比較", "body": "説明文または段落配列",
 "charts": [ ... ], "tables": [ ... ]}
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `id` | — | アンカー ID（省略時 `sec-N`）。TOC・スクロールスパイが参照。下記「sections[].id の契約」に従う |
| `heading` | ✅ | `<h2>` 見出し。**欠落は SpecError** |
| `body` | — | string \| string[]。段落として描画。string / string 配列以外は SpecError |
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

- `orientation`: `"horizontal"`（既定・カテゴリ比較向き）/ `"vertical"`（期間比較向き）。**enum 外は SpecError**（`"Horizontal"` 等の表記ゆれ不可）
- `mode`: `"single"`（単一系列時の既定。値の直接ラベル付き描画）/ `"grouped"`（複数系列時の既定）/ `"stacked"`。stacked は**負値不可・`null`（欠損）不可**。**enum 外は SpecError**
- `values` の `null` は当該バーを描かず、表では「—」（grouped / 単一系列のみ。stacked は合計を積み上げの長さで表すため欠損を gap として表現できず、`null` を 0 として積むと存在しない合計値を発明する。**stacked の `null` は SpecError** とし、欠損を含むデータは grouped を使う）
- 軸は必ず 0 を含む（axis integrity）。単一系列 horizontal（`mode: "single"`）は値の直接ラベル付き

### line

```json
{"type": "line", "x": ["2026-01", "2026-02"],
 "series": [{"name": "Web", "values": [1480, null]}],
 "annotations": [{"x": "2026-02", "label": "キャンペーン開始"}]}
```

- `x`: 時点ラベル配列（等間隔配置。多すぎるラベルは自動間引き）
- `values` の **`null` は gap**（線が途切れる）。0 に変換されない
- `annotations[].x` は `x` のラベル値、または `x_index`（0 始まり index）で位置指定。`x` がどのラベルとも一致せず `x_index` も未指定の場合は SpecError（annotation を黙って落とさない）。`x_index` は **整数かつ `0 <= x_index < len(x)` の範囲内**であること（小数・範囲外は SpecError。renderer は黙って切り捨て・clamp しない）
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

- `type`: `"start"` / `"delta"`（増減。負値可）/ `"total"` のみ（省略時 `"delta"`）。**enum 外は SpecError**（`"Total"` 等の表記ゆれを silent に delta 扱いしない）。start / total は 0 起点、delta は直前の累積から積む
- `total` の `value` は**累積の検算値として絶対値を書く**（renderer は与えた値をそのまま 0 起点で描く）
- 増加・減少・累計は色 + 符号ラベルで区別。累積コネクタ（破線）自動描画

### donut

```json
{"type": "donut", "unit": "万円",
 "slices": [{"label": "コンピュート", "value": 126}]}
```

- `value` は非負のみ。中央に合計値、凡例に構成比（%）を自動表示
- part-to-whole 用途のみ。**`slices` は 6 件以下**（7 件以上は SpecError。多区分は bar を使う）

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
| `tasks[].name` | ✅ | タスク名（左列に表示）。**欠落は SpecError** |
| `tasks[].phase` | — | フェーズ名。出現順にグルーピングされ、フェーズ見出し行が挿入される |
| `tasks[].start` / `end` | ✅（通常タスク） | `YYYY-MM-DD`。`end >= start` 必須（負期間はエラー）。**不明な日付を推測で埋めない**（不明タスクは spec に入れず assumptions に書く） |
| `tasks[].milestone` | — | `true` で milestone（diamond 表示）。`date` が必須になり `start`/`end` は不要。**boolean 厳格**: `true` / `false` のみ許容（`"false"` 等の文字列・数値は SpecError） |
| `tasks[].progress` | — | `0.0..1.0` 厳格（範囲外は clamp せずエラー）。planned bar 上に不透明 overlay で重ねられ、% がテキスト表示される |
| `tasks[].status` | — | `done` / `in-progress` / `planned` / `at-risk` / `blocked` のみ（未指定は `planned` 扱い。**enum 外は SpecError**。`"Done"` 等の表記ゆれ不可）。色 + **日本語テキストラベル**（完了/進行中/予定/リスク/ブロック）で表示 |
| `tasks[].id` / `dependsOn` | — | 依存関係。矢印では描かず**依存関係テーブル**として chart 下に自動生成。**`id` の重複は SpecError**（重複を許すと依存先の解決が黙って後勝ちになるため） |

- 日付軸の tick は期間長で自動選択: 120 日以下 → 週（月曜、`M/D`）、730 日（約 2 年）以下 → 月（`YYYY-MM`）、超 → 四半期（`YYYY Qn`）
- SVG と同一の task / start / end / progress / status がデータ表にも必ず出る

## tables（独立データ表）

```json
{"title": "リスク一覧", "columns": ["リスク", "影響", "件数"],
 "align": ["", "", "num"], "rows": [["互換性問題", "2週遅延", 3]], "note": "注記"}
```

- `rows` のセルは文字列または数値。数値は桁区切り整形され右寄せ。boolean（`true` / `false`）は数値扱いしない（`1` として整形されず文字列表示）
- **各行の列数は `columns` の列数と一致必須**（不一致は SpecError）
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

- すべての数値は**有限値**（NaN / Inf 不可）。文字列の数値も parse される。値同士の差が浮動小数の上限（約 1.8e308）を超える巨大値の組もエラー
- **数値フィールドに boolean は不可**（JSON の `true` を数値 1 として描画しない）
- **boolean フィールドは厳格**（`interactive`・`tasks[].milestone`。`true` / `false` 以外はエラー）
- **enum フィールドは厳格**（bar `orientation` / `mode`、waterfall `items[].type`、kpi `trend`、gantt `tasks[].status`。一覧外の値・表記ゆれはエラーで、silent に既定値へ倒さない）
- `summary` / `sections[].body` は string または string の配列のみ（それ以外の型・非 string 要素はエラー）
- 値数の不一致（series の values と categories/x/axes の長さ違い、table の行と columns の列数違い）はエラー
- stacked bar / donut の負値、stacked bar の `null`（欠損）、radar の範囲外値・`max <= 0`、gantt の `progress` 範囲外・`end < start`・`tasks[].id` 重複はエラー
- 必須フィールドの欠落（`sections[].heading`・`kpis[].label`・`kpis[].value`・gantt `tasks[].name` 等）はエラー
- 日付は `YYYY-MM-DD` 固定
- **欠損は `null` で表現する**。0 と欠損は別物として扱われる（line は gap、heatmap は無色セル、表は「—」）。ただし stacked bar は欠損を表現できないため `null` はエラー（grouped を使う）
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

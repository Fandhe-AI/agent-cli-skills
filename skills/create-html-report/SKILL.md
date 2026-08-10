---
name: create-html-report
description: >
  比較・分析結果を自己完結 HTML レポートにまとめる。「レポート作って」「HTML レポート」「比較レポート」
  「グラフで見せて」「見やすくまとめて」で使用。棒グラフ・折れ線グラフ・レーダーチャート（六角形グラフ）を
  インライン SVG で描画し、外部 CDN 不使用・レスポンシブ対応で単一 HTML ファイルを生成する。
  表・凡例・軸ラベル・配色一貫・ダークモード対応（prefers-color-scheme）まで単体で完結する。
model: sonnet
user-invocable: true
argument-hint: "<レポート内容の説明> (例: create-html-report 3案のパフォーマンス比較)"
---

# create-html-report

比較・分析結果を、表と多様なグラフ（棒グラフ・折れ線グラフ・レーダーチャート）で見やすくまとめた自己完結 HTML レポートを生成する。

## 使い方

引数でレポート化したい内容（比較対象・データ・目的）を渡す。引数がない場合は Step 1 でユーザーに確認する。

- 出力先はユーザー指定がなければ `_/reports/<report-name>.html`
- 生成する HTML は外部依存なし（CDN・外部フォント・外部画像・外部 JS ライブラリ不使用）の単一ファイル

## フロー

### Step 1: 入力データ・比較対象・レポート趣旨の確認

- 何を比較・分析するレポートか（対象・期間・指標）を確認する
- 元データの所在を確認する（ユーザー提供のテキスト・既存ファイル・コマンド出力等）
- レポートの想定読者と目的（意思決定材料か、経過報告か）を確認する
- 引数なしで曖昧な場合はユーザーに質問してから次に進む

### Step 2: レポート構成の設計

セクション構成と各セクションで使うグラフ種を選定する。グラフ種は以下の選定基準に従う。

| データの性質 | 推奨グラフ | 理由 |
|------------|-----------|------|
| カテゴリ間の数値比較（部門別・案別など） | 棒グラフ | 離散カテゴリの大小比較に最適 |
| 時系列・推移（月次・バージョン推移など） | 折れ線グラフ | 連続的な変化の傾向が読み取りやすい |
| 多軸の特性比較（3〜8軸、案の総合評価など） | レーダーチャート（六角形グラフ） | 複数指標を同時に俯瞰できる |
| 正確な数値の突合が必要な箇所 | 表（グラフと併記） | グラフは概観、表は正確な値の確認用 |

設計時に以下を決める。

- セクション見出しの一覧（例: 概要 → 比較表 → 指標別グラフ → 総合評価レーダーチャート → 結論）
- 各グラフの系列（対象）と使用する配色。**同じ対象は全グラフで同じ色**に固定する
- 軸・単位・凡例に必要な情報（タイトル・軸ラベル・単位・凡例テキスト）

### Step 3: HTML 生成

以下の設計原則に従い、単一の自己完結 HTML ファイルを生成する。

#### 自己完結の原則

- 外部 CDN・外部フォント・外部画像に依存しない。CSS はすべて `<style>` 内にインラインで記述する
- グラフは Chart.js 等の外部ライブラリを使わず、**インライン SVG** で描画する。グラフは静的 SVG のみで完結できるため、動的データを含む `<script>` は使用しない
- フォントは `system-ui` 等の OS 標準フォントスタックを使用する

#### 動的データのエスケープ原則（重要）

HTML テキストノード・属性値・SVG `<text>`・`aria-label` に埋め込む動的値（ユーザー提供データ・外部データ由来の値）は、挿入前に必ず以下の文字エスケープを行う。

| 文字 | エスケープ後 |
|------|------------|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |
| `'` | `&#39;` |

エスケープを怠ると HTML インジェクション・XSS のリスクがある。表のセル・グラフの軸ラベル・凡例テキスト・`aria-label` など、動的値を差し込む全箇所で例外なく適用する。`&` を最初に置換すること。順序を誤ると `&amp;lt;` のような二重エスケープになる。

#### レスポンシブの原則

- 相対単位（`%`・`rem`・`em`）と flexbox / grid でレイアウトする
- 画像・グラフ・表は `max-width: 100%` を基本とし、幅が広い表やグラフは `overflow-x: auto` のラッパー要素でスクロールさせ、`body` 自体の横スクロールを発生させない

```css
.table-wrap, .chart-wrap { overflow-x: auto; max-width: 100%; }
```

#### テーマ対応の原則

CSS カスタムプロパティで配色トークンを `:root` に定義し、`prefers-color-scheme: dark` で上書きする。単一テーマのみで作る場合も背景色・文字色は必ず明示する（ブラウザ既定に依存しない）。

```css
:root {
  --bg: #ffffff; --fg: #1a1a1a; --card-bg: #f5f5f7;
  --series-1: #3b82f6; --series-2: #ef4444; --series-3: #10b981;
  --grid-line: #d0d0d5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #eaeaec; --card-bg: #222226;
    --grid-line: #3a3a40;
  }
}
body { background: var(--bg); color: var(--fg); }
```

#### dataviz 原則（グラフ実装共通）

- 軸ラベル・単位・凡例・タイトルを必ず付ける
- 3D 表現・過剰な装飾（グラデーション多用・影の乱用）は禁止
- 系列色は一貫させ、色だけに頼らずラベル・凡例を併記する（色覚多様性への配慮）
- 正確な数値比較が必要な箇所はグラフに加えて表も併記する

#### 棒グラフの SVG 実装パターン

カテゴリ軸を x、値軸を y として、カテゴリごとに `<rect>` を並べる。

```html
<svg viewBox="0 0 400 220" class="chart" role="img" aria-label="カテゴリ別比較棒グラフ">
  <!-- 軸線 -->
  <line x1="40" y1="10" x2="40" y2="180" stroke="var(--grid-line)"/>
  <line x1="40" y1="180" x2="380" y2="180" stroke="var(--grid-line)"/>
  <!-- barHeight = (value / maxValue) * plotHeight で算出 -->
  <rect x="60" y="80" width="30" height="100" fill="var(--series-1)"/>
  <text x="75" y="195" font-size="10" text-anchor="middle" fill="var(--fg)">案A</text>
  <text x="75" y="70" font-size="10" text-anchor="middle" fill="var(--fg)">100</text>
</svg>
```

座標計算の要点: `barY = plotBottom - (value / maxValue) * plotHeight`、`barHeight = plotBottom - barY`。

#### 折れ線グラフの SVG 実装パターン

各点の座標を計算し `<polyline>` の `points` に連結する。

```html
<svg viewBox="0 0 400 220" class="chart" role="img" aria-label="推移折れ線グラフ">
  <line x1="40" y1="10" x2="40" y2="180" stroke="var(--grid-line)"/>
  <line x1="40" y1="180" x2="380" y2="180" stroke="var(--grid-line)"/>
  <!-- x_i = 40 + i * stepX, y_i = plotBottom - (value_i / maxValue) * plotHeight -->
  <polyline points="40,150 140,90 240,110 340,50"
            fill="none" stroke="var(--series-1)" stroke-width="2"/>
  <circle cx="340" cy="50" r="3" fill="var(--series-1)"/>
</svg>
```

座標計算の要点: `x_i = plotLeft + i * (plotWidth / (n - 1))`、`y_i = plotBottom - (value_i / maxValue) * plotHeight`。

#### レーダーチャート（六角形グラフ）の SVG 実装パターン

N 軸（既定 6 軸）の頂点座標を、中心 `(cx, cy)`・半径 `r`・角度 `θ_i = 2π·i/N − π/2` から算出する。

```html
<svg viewBox="0 0 300 300" class="chart" role="img" aria-label="総合評価レーダーチャート">
  <!-- 目盛りの同心多角形（例: r=40,80,120 の3段階） -->
  <polygon points="..." fill="none" stroke="var(--grid-line)"/>
  <!-- 軸線: 中心から各頂点へ -->
  <line x1="150" y1="150" x2="150" y2="30" stroke="var(--grid-line)"/>
  <!-- データ polygon（半透明 fill）。r=120, value/maxValue(各軸i=0..5) = [0.83, 0.90, 0.70, 0.75, 0.90, 0.65] を θ_i = 2π・i/6 − π/2 の式で算出 -->
  <polygon points="150,50 244,96 223,192 150,240 56,204 82,111"
           fill="var(--series-1)" fill-opacity="0.25" stroke="var(--series-1)" stroke-width="2"/>
  <text x="150" y="20" font-size="10" text-anchor="middle" fill="var(--fg)">品質</text>
</svg>
```

座標計算の要点（軸 i、値 `value_i`、最大値 `maxValue`、頂点数 N）:

```
θ_i = (2 * PI * i / N) - (PI / 2)
axisX_i = cx + r * cos(θ_i)          # 目盛り最外周（軸ラベル位置）
axisY_i = cy + r * sin(θ_i)
pointX_i = cx + r * (value_i / maxValue) * cos(θ_i)   # データ頂点
pointY_i = cy + r * (value_i / maxValue) * sin(θ_i)
```

同心多角形は `r` を等分割した半径（例: r/3, 2r/3, r）で同じ角度計算を繰り返して描く。

#### 表の実装

`<table>` に `<caption>` で見出しを付け、数値列は `text-align: right` で右寄せする。幅が広い表は `.table-wrap` でラップして `overflow-x: auto` を効かせる。

### Step 4: 検証

生成した HTML の構文と成果物の存在を確認する。ブラウザで直接開ける場合は目視でも確認する。

```bash
# ファイル存在確認
ls -la "_/reports/<report-name>.html"

# 簡易構文チェック（開始・終了タグの対応、文字化けの有無）
# grep -c は「一致した行数」を返すため、同一行に複数タグがあると出現数を見誤る。
# grep -o でタグ文字列を抽出し wc -l で実際の出現数を数える
grep -o '<svg\b' "_/reports/<report-name>.html" | wc -l
grep -o '</svg>' "_/reports/<report-name>.html" | wc -l
```

- `<svg` と `</svg>` の出現数が一致すること（未閉タグがないこと）
- `<html`・`<head`・`<body` の基本構造が揃っていること
- 外部 URL（`http://`・`https://`）への参照が一切含まれていないこと（`<link>`・`<script src>` に限らず `<img src>`・CSS `url()`・`@import`・SVG `xlink:href` も含めた包括チェック。自己完結の確認）

```bash
grep -nE 'https?://' "_/reports/<report-name>.html"
```

上記コマンドが**何も出力しない**ことを pass 条件とする。出力があれば外部依存が混入しているため修正する。`grep` は不一致（＝正常）の場合に終了コード 1 を返すため、このコマンドを `&&` で後続処理の成功ゲートに直結させないこと。

### Step 5: 出力先の案内

生成したファイルの絶対パスをユーザーに報告する。ブラウザで直接開けることを案内する（例: `open "_/reports/<report-name>.html"`）。

## 検証

- Step 4 のコマンドをすべて実行し、`<svg>`/`</svg>` タグ数の一致・`grep -nE 'https?://'` の出力なし（外部 URL 参照なし）を確認する
- ファイルが `_/reports/` 配下（またはユーザー指定先）に実在することを `ls` で確認する
- グラフごとに軸ラベル・凡例・タイトルが記述されているかを Read で目視確認する

## 注意事項

- 外部 CDN・外部フォント・外部画像・外部 JS ライブラリは一切使用しない（Chart.js 等も不可）。すべてインライン SVG / CSS で完結させる。動的データを含む `<script>` は使用しない
- 3D 表現・過剰な装飾（不要なグラデーション・影）は使用しない
- 系列色は同一対象で全グラフを通して一貫させる。色のみに依存せず凡例・ラベルを併記する
- 幅広の表・グラフは `overflow-x: auto` のコンテナでスクロールさせ、`body` 全体の横スクロールを発生させない
- レポートに機密情報（トークン・個人情報・内部限定データ）を含める場合は、出力先が公開領域でないことを事前にユーザーへ確認する
- レポート化対象のデータに機密情報（トークン・個人情報等）や信頼できない外部由来データが含まれ、埋め込み可否が不明な場合は生成を中止し、ユーザーに確認を求める
- 出力先ディレクトリ（`_/reports/` 等）が存在しない場合は `mkdir -p` で作成してから書き出す

## sandbox 環境での実行

このスキルは sandbox 環境では実行できない。ネットワークアクセス・ファイルシステムへの書き込みが必要なため、通常の Claude Code セッションで実行すること。

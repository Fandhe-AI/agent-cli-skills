# Report design reference

page layout・design tokens・component 実装・responsive・print の詳細。
chart の選定は [./chart-selection.md](./chart-selection.md)、
accessibility / security の基準は [./accessibility-security.md](./accessibility-security.md) を参照。

## 目次

- [Page shell](#page-shell)
- [情報階層と visual hierarchy](#情報階層と-visual-hierarchy)
- [Design tokens](#design-tokens)
- [Okabe-Ito palette](#okabe-ito-palette)
- [Dark mode](#dark-mode)
- [Component 実装パターン](#component-実装パターン)
  - [KPI card](#kpi-card)
  - [Figure / chart unit](#figure--chart-unit)
  - [Table](#table)
- [Responsive](#responsive)
- [Print CSS](#print-css)
- [prefers-reduced-motion](#prefers-reduced-motion)
- [Interactive mode の component](#interactive-mode-の-component)

## Page shell

semantic 構造の骨格:

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>売上分析レポート 2026 Q2 — 3案比較</title>
  <style>/* すべて inline */</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header>タイトル・scope・生成日</header>
  <nav aria-label="Table of contents">…</nav>
  <main id="main">
    <section id="summary" aria-labelledby="summary-h">…</section>
    …
  </main>
  <footer>sources / generated metadata</footer>
</body>
</html>
```

- `<title>` は「何の・いつの・何を比較した」レポートか分かる記述にする。
- skip link は通常時は視覚的に隠し、focus 時に表示する:

```css
.skip-link {
  position: absolute;
  left: -9999px;
}
.skip-link:focus {
  left: 0; top: 0;
  background: var(--surface);
  padding: .5rem 1rem;
  z-index: 10;
}
```

- **TOC**: section 数が 4 以上または長いレポートで `<nav aria-label="Table of contents">` を置き、anchor link で各 `<section id>` へ飛ばす。
- **sticky nav の注意**: desktop で TOC を sticky にする場合も main content の横幅を狭めすぎない（TOC 列は 200〜240px 程度、content は最低 60ch を維持）。mobile では通常 flow へ戻す（`position: static`）。sticky header を使うなら anchor 遷移で見出しが隠れないよう `scroll-margin-top` を見出しへ設定する。

## 情報階層と visual hierarchy

情報階層 9 段（SKILL.md Step 2）の各段の実装指針:

| # | 段 | 実装 |
|---|---|---|
| 1 | Title / scope | `<header>` 内 `<h1>` + 対象・期間・データソースの 1 行 meta |
| 2 | Executive summary | 冒頭 `<section>`。最重要 1 メッセージを最初の段落に。3〜6 文以内 |
| 3 | KPI / key findings | KPI card grid（3〜4 個）または findings の箇条書き |
| 4 | Decision / recommendation | 該当時のみ。推奨案を明確な文で書き、根拠 section へ anchor する |
| 5 | Main visual analysis | figure 群。1 figure = 1 メッセージ |
| 6 | Schedule / risks / dependencies | 該当時のみ。Gantt + dependency table + risk table |
| 7 | Detailed data | 完全な data table 群。`<details>` で折りたたみ可（重要情報は畳まない） |
| 8 | Methodology / assumptions | 集計方法・除外条件・仮定の列挙 |
| 9 | Sources / generated metadata | `<footer>`。出典リンク・生成日時・生成ツール |

layout 原則:

- max content width を設定（`max-width: 60rem` 程度、本文の行長は 60〜75ch）
- 1 カラム基本。KPI・小型比較のみ responsive grid
- 見出しは `<h1>` 1 個 → `<h2>` section → `<h3>` sub の順序を飛ばさない
- section 間の whitespace は margin で確保（`margin-block: 3rem` 程度）
- chart と説明・table を 1 つの `<figure>` visual unit に閉じ、間へ別要素を挟まない

## Design tokens

CSS custom properties を `:root` へ一元定義し、component は token のみ参照する:

```css
:root {
  color-scheme: light dark;

  /* surface / text */
  --bg: #f6f7f8;
  --surface: #ffffff;
  --fg: #1a1c1e;
  --muted: #5b6167;
  --border: #d5d9dd;
  --grid: #e4e7ea;
  --focus: #0b57d0;
  --link: #0b57d0;

  /* semantic（増減表示） */
  --pos: #0072B2;
  --neg: #D55E00;

  /* categorical series（Okabe-Ito、割当順） */
  --series-1: #0072B2; /* blue */
  --series-2: #E69F00; /* orange */
  --series-3: #56B4E9; /* sky blue */
  --series-4: #D55E00; /* vermillion */
  --series-5: #009E73; /* bluish green */
  --series-6: #CC79A7; /* reddish purple */
  --series-7: #F0E442; /* yellow */
  --series-8: #8A8F94; /* gray（black の代替。dark では #a2a8ae へ調整） */

  /* gantt status */
  --status-done: #009E73;
  --status-active: #0072B2;
  --status-planned: #8A8F94;
  --status-risk: #D55E00;
  --status-blocked: #CC79A7;
}
```

- 色の直書きを component CSS・SVG 属性へ散らさない。SVG も `fill="var(--series-1)"` で token を参照する。
- `--pos` / `--neg` は Okabe-Ito の blue / vermillion を流用し、必ず symbol / text（↑ / ↓、+ / −）を併用する。`--warning` 相当の token は定義しない（注意喚起は `--series-2` の orange とテキスト表現で行う）。

## Okabe-Ito palette

色覚多様性対応の事実上の標準。8 色と割当順:

| 順 | 色名 | HEX | 用途の目安 |
|---|---|---|---|
| 1 | blue | `#0072B2` | 主系列 |
| 2 | orange | `#E69F00` | 第 2 系列・warning |
| 3 | sky blue | `#56B4E9` | 第 3 系列 |
| 4 | vermillion | `#D55E00` | 第 4 系列・negative |
| 5 | bluish green | `#009E73` | 第 5 系列・status done |
| 6 | reddish purple | `#CC79A7` | 第 6 系列 |
| 7 | yellow | `#F0E442` | 明背景で低 contrast。塗り専用・線や文字に使わない |
| 8 | gray（black の代替） | `#8A8F94` | 基準線・補助・不明 status（dark mode では `#a2a8ae` へ明度調整） |

- 4 系列以下は blue / orange / sky blue / vermillion を優先する。
- カテゴリカルは 6 色以下。超える場合は small multiples か「その他」集約へ。
- 連続値（heatmap 等）は Okabe-Ito ではなく Viridis / Cividis 系の知覚的均一 scale を使う。
- 同じ entity はレポート全体で同じ色・同じ line style を維持する。

## Dark mode

`color-scheme` の宣言 + `prefers-color-scheme` での token 再定義のみで対応する。component 側の変更は不要:

```css
:root { color-scheme: light dark; }

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a;
    --surface: #1f2226;
    --fg: #e6e8ea;
    --muted: #9aa1a8;
    --border: #3a3f45;
    --grid: #303539;
    --focus: #8ab4f8;
    --link: #8ab4f8;
    --series-8: #a2a8ae; /* gray を明るめへ調整 */
    /* --pos / --neg は dark 背景でコントラスト比 4.5:1 を割るため明度を上げる */
    --pos: #4ea3dd;
    --neg: #ef8a3c;
  }
}
```

- `color-scheme: light dark` により form control・scrollbar が OS テーマへ追従する。
- series 色（Okabe-Ito）は両テーマで共通のまま使えるが、dark 背景に対する contrast 3:1 を割る色（yellow・sky blue の細線等）は線幅を太くするか使用箇所を限定する。
- 判定基準の数値は [./accessibility-security.md](./accessibility-security.md) を参照。

## Component 実装パターン

### KPI card

「最初に知る価値が高い値」3〜4 個に限定する。値・ラベル・文脈（前期比等）の 3 点セット:

```html
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">月間売上</div>
    <div class="kpi-value">¥12.4M</div>
    <div class="kpi-delta pos">↑ +12.4% 前月比</div>
  </div>
  …
</div>
```

```css
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: .75rem;
}
.kpi-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: .9rem 1rem;
}
.kpi-value { font-size: 1.6em; font-weight: 700; }
.kpi-label { color: var(--muted); font-size: .82em; }
.kpi-delta.pos { color: var(--pos); }
.kpi-delta.neg { color: var(--neg); }
```

増減は色 + 矢印 symbol + テキストの 3 重で表現する（色単独禁止）。

### Figure / chart unit

```html
<figure class="chart-figure">
  <figcaption>
    <h3>売上は 4 月以降 3 か月連続で増加</h3>
    <p class="takeaway">新規チャネル追加後の 5 月に伸びが加速した。</p>
  </figcaption>
  <div class="chart-wrap">
    <svg class="chart" viewBox="0 0 720 400" role="img"
         aria-labelledby="c1-t c1-d">
      <title id="c1-t">月別売上の推移（2026年1〜6月）</title>
      <desc id="c1-d">1月 8.2M から 6月 12.4M へ増加。4月以降は毎月増。</desc>
      …
    </svg>
  </div>
  <p class="source">Source: <a href="https://example.com/data">社内売上 DB</a>（2026-07-01 時点）</p>
  <details>
    <summary>データ表を表示</summary>
    <table>…</table>
  </details>
</figure>
```

- figcaption の見出しは名詞（「売上推移」）でなく主要な傾向を伝える文にする。
- exact-data table は `<details>` で畳んでよいが、findings の根拠となる主要値は本文にも書く。
- `.chart { width: 100%; height: auto; display: block; }` を必ず適用する。

### Table

```html
<div class="table-wrap">
  <table>
    <caption>案別の性能・コスト比較（2026 Q2 時点）</caption>
    <thead>
      <tr>
        <th scope="col">案</th>
        <th scope="col" class="num">throughput (req/s)</th>
        <th scope="col" class="num">月額コスト (USD)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">案 A</th>
        <td class="num">1,240</td>
        <td class="num">3,200</td>
      </tr>
    </tbody>
  </table>
</div>
```

```css
.table-wrap { max-width: 100%; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
caption { text-align: left; font-weight: 600; margin-bottom: .5rem; }
th, td { padding: .4rem .6rem; border: 1px solid var(--border); text-align: left; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
```

- 数値列は右寄せ + `tabular-nums`。単位は列見出しへ集約し、桁区切り・小数桁数を列内で統一する。
- 行数が多い table は zebra（`tbody tr:nth-child(even) { background: var(--surface); }`）で追いやすくする。

## Responsive

- すべての SVG に `viewBox` を持たせ、`width`/`height` 属性の固定を避ける。
- 幅広 chart（Gantt・多カテゴリ heatmap・幅広 table）は `.chart-wrap` / `.table-wrap`（`overflow-x: auto`）で包み、**body 全体を横スクロールさせない**。wrap 内の SVG には `min-width` を与えて潰れを防ぐ。
- font size は `clamp()` で流動化してよい（例: `font-size: clamp(.875rem, 1.5vw, 1rem)`）。
- layout は Grid / Flexbox。`@media (max-width: 40rem)` 程度で KPI grid の列数が自然に落ちるよう `auto-fit + minmax` を使う。
- small screen で意味が失われるほど chart を縮小しない。ラベルが重なるなら abbreviated label + 完全な table へ切替える。
- mobile では decorative element（薄い gridline・補助 annotation）を減らす。

## Print CSS

`@media print` を必ず用意する。完全例:

```css
@media print {
  @page {
    size: A4;
    margin: 14mm;
  }
  :root {
    /* 印刷は常に light 相当へ固定 */
    --bg: #ffffff;
    --surface: #ffffff;
    --fg: #000000;
    --muted: #444444;
    --border: #999999;
    --grid: #dddddd;
  }
  body { background: #fff; color: #000; }

  /* navigation・操作 UI を非表示 */
  nav, .skip-link, .controls, button { display: none; }

  /* 注: 閉じた <details> の中身は CSS（display:block 等）では印刷に出せない
     （ブラウザ仕様）。折りたたみの印刷可視化は CSS ではなく、
     open 属性付きで出力する（JS なし）か、beforeprint / afterprint の JS で
     開閉を切り替える（interactive モード）ことで実現する */

  /* 不自然な page break を防ぐ */
  .chart-figure, .kpi-card, tr { break-inside: avoid; }
  h2 { break-after: avoid; }

  /* SVG・chart の色を保持 */
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }

  /* ink 節約 */
  * { box-shadow: none !important; text-shadow: none !important; }
  .kpi-card { border: 1px solid #999; background: #fff; }

  /* 出典 URL を印字 */
  .source a[href^="https://"]::after {
    content: " (" attr(href) ")";
    font-size: .75em;
    word-break: break-all;
  }

  .chart-wrap, .table-wrap { overflow: visible; }
  a { color: #000; text-decoration: underline; }
}
```

- chart・URL がページ外へ切れないことを確認する。A4 幅を超える Gantt は縮小して収めるか、table を canonical にする。
- 重要情報を閉じた `<details>` の中だけへ置かない。閉じた `<details>` は print CSS では展開できないため、JS なしなら `open` 付きで出力し、JS ありなら beforeprint / afterprint で開閉する。

## prefers-reduced-motion

motion を追加した場合は必ず併記する:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

そもそも animation は原則不要。data の理解を助けない motion を加えない。

## Interactive mode の component

実装（テーブルソート・スクロールスパイ等の JavaScript）は renderer 側が持つ。ここでは**いつ有効化するか**の判断基準を示す。

| component | 有効化する条件 | 有効化しない条件 |
|---|---|---|
| table sort | 行数 15 超で読者が並び順を変えて探索する価値がある | 行数が少ない・順位が本質でソート済み表示が結論そのもの |
| table search / filter | 行数 50 超の参照用一覧 | findings 提示が目的の小さな table |
| scroll spy（TOC 現在位置） | section 6 個超の長大レポートで `--interactive` 指定あり | 短いレポート。anchor link のみで十分 |
| series visibility toggle | 4〜5 系列の multi-line で系列の見比べが主目的 | 系列 3 本以下・small multiples で解決できる場合 |
| section collapse | 詳細データ・付録が本文の 2 倍を超える | 主要 section（summary・findings）には適用しない |
| theme override | 印刷前確認・スクリーンショット用途が想定される | 通常は `prefers-color-scheme` 追従のみで足りる |
| Gantt detail toggle | task 30 個超で phase 単位の折りたたみが要る | 1 画面に収まる規模 |

有効化時の共通制約（詳細は [./accessibility-security.md](./accessibility-security.md)）:

- JavaScript 無効でも全データが読める（sort 前の初期順で完結する等、progressive enhancement）
- keyboard 操作可能・visible focus 維持
- sort 状態は `aria-sort` を `th` へ反映する
- 最重要メッセージの閲覧に click を要求しない・hover-only tooltip を使わない

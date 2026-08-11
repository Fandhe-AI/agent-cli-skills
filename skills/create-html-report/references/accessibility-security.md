# Accessibility / security checklist

WCAG 2.2 AA 目標・SVG / table accessibility・escaping・safe JavaScript policy のチェックリスト。
component 実装は [./report-design.md](./report-design.md)、chart 別の表現規則は
[./chart-selection.md](./chart-selection.md) を参照。

## 目次

- [WCAG 2.2 AA 目標値](#wcag-22-aa-目標値)
- [SVG accessibility](#svg-accessibility)
- [Table accessibility](#table-accessibility)
- [キーボード・focus](#キーボードfocus)
- [Escaping 原則](#escaping-原則)
- [Safe JavaScript policy](#safe-javascript-policy)
- [外部依存の禁止リストと出典リンク](#外部依存の禁止リストと出典リンク)
- [Sensitive data redaction](#sensitive-data-redaction)
- [公開前の最終チェックリスト](#公開前の最終チェックリスト)

## WCAG 2.2 AA 目標値

| 対象 | 最低 contrast | 補足 |
|---|---|---|
| 通常テキスト | 4.5:1 | 本文・table・axis label・annotation を含む |
| 大テキスト | 3:1 | 18pt（≒24px）以上、または 14pt（≒18.66px）bold 以上 |
| 非テキスト要素 | 3:1 | 意味を持つ chart element（bar・line・marker）・UI control・focus indicator。adjacent background に対して |

チェックリスト:

- [ ] light / dark 両テーマで本文・muted テキストが 4.5:1 を満たす
- [ ] chart の主要 element（bar 塗り・line・marker）が背景に対し 3:1 を満たす。満たさない色（Okabe-Ito の yellow `#F0E442` 等）は塗り面専用にし、細線・文字に使わない
- [ ] 隣接する series 同士が色以外（direct label・line style・pattern・symbol）でも区別できる
- [ ] positive / negative を red / green の色だけで表現していない（↑ / ↓、+ / −、文字を併用）
- [ ] 情報を透明度・彩度の差だけで区別していない
- [ ] 200% zoom で情報・機能が失われない（`viewBox` + relative unit の徹底で概ね満たせる）

## SVG accessibility

意味のある chart の標準形:

```html
<svg role="img" aria-labelledby="c1-t c1-d" viewBox="0 0 720 400">
  <title id="c1-t">月別売上の推移（2026年1〜6月）</title>
  <desc id="c1-d">1月 8.2M から 6月 12.4M へ増加。4月以降は毎月増。</desc>
  …
</svg>
```

- [ ] 意味のある SVG に `role="img"` + `aria-labelledby` で `<title>` / `<desc>` を紐付けている（`id` は文書内で一意）
- [ ] `<title>` は chart の内容が分かる 1 文、`<desc>` は主要な傾向・範囲・結論の要約（軸の復唱ではなく findings を書く）
- [ ] **aria-hidden の判断**: SVG の情報が直前の本文と data table で完全に重複し、screen reader への二重読上げが害になる場合のみ `aria-hidden="true"` を選ぶ。この場合 `role` / `title` / `desc` は付けない
- [ ] どちらを選んでも、重要なデータが SVG だけに存在しない（本文または table に必ず存在する）
- [ ] SVG 内テキスト（axis label・value label）も contrast・最小サイズ（およそ 11px 相当以上）を満たす
- [ ] 装飾要素（gridline・背景帯）は読上げ対象にしない（意味づけしない）

## Table accessibility

- [ ] data table に `<caption>`（表の内容と時点が分かる 1 文）がある
- [ ] `<thead>` / `<tbody>` を分離し、列見出しは `<th scope="col">`、行見出しは `<th scope="row">`
- [ ] layout 目的の table を使っていない（layout は CSS Grid / Flexbox）
- [ ] 結合セル（`rowspan` / `colspan`）を極力避ける。必要な複雑 table は分割を検討する
- [ ] 単位は列見出しへ集約し、セル内の表記（桁区切り・小数桁）が列内で一貫している
- [ ] sort 可能な table では現在の sort 状態を `th` の `aria-sort`（`ascending` / `descending` / `none`）へ反映している

## キーボード・focus

- [ ] すべての interactive 要素（link・button・summary・sort header）へ Tab で到達できる
- [ ] focus 順序が視覚的順序と一致している（正の `tabindex` を使わない）
- [ ] visible focus を消していない（`outline: none` の放置禁止。消す場合は `:focus-visible` で代替 indicator を実装し 3:1 を満たす）
- [ ] `Skip to main content` link が最初の Tab で現れる
- [ ] hover-only の tooltip / 表示切替がない（keyboard・touch で到達不能になるため）
- [ ] sort 等の操作は `<button>` / native 要素で実装し、`div` + click handler にしていない
- [ ] `<details>` / `<summary>`・anchor navigation など native 機構を JavaScript 実装より優先している

## Escaping 原則

untrusted data（ユーザー入力・外部ファイル・Web 取得データ）は trusted markup として扱わない。

- [ ] HTML / SVG の text node・attribute へ入るすべての文字列が renderer の escaping function を経由している。Python では `html.escape(value, quote=True)` 相当を**一元利用**する（呼び出し箇所ごとの自前 replace を書かない）
- [ ] escape は出力の直前（sink 側）で行い、二重 escape を避けるため中間データは raw のまま保持する

**context 別の注意** — HTML escape を他 context へ流用しない:

| context | 規則 |
|---|---|
| HTML / SVG text node | `html.escape` を通す |
| HTML / SVG attribute | `html.escape(value, quote=True)` + attribute は必ず引用符で囲む |
| URL（`href` 等） | scheme を allowlist（`https:`・`mailto:` 等）で検証し、query は URL encode。HTML escape で代用しない |
| JavaScript string | untrusted data を script へ埋め込まない。必要なら JSON encode（`json.dumps` の `<` escape 考慮）+ `<script type="application/json">` から `textContent` で読み出す |
| CSS | untrusted data を `<style>` / `style` attribute へ埋め込まない。値は数値・token 検証後のみ使用 |

- [ ] untrusted data を `<script>`・`<style>`・event handler attribute・raw URL・raw HTML へ直接埋め込んでいない
- [ ] 数値は parse 後に有限値（`math.isfinite`）であることを確認してから座標計算に使っている（`NaN` / `Infinity` を SVG 属性へ流さない）
- [ ] `id` / class 名へ untrusted data を使う場合は英数字と `-` `_` のみへ正規化している

## Safe JavaScript policy

inline vanilla JavaScript のみ許可（`--interactive` 時など）。

**禁止 API・パターン**:

- `eval` / `new Function` / 文字列引数の `setTimeout` / `setInterval`
- untrusted string の `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` への代入
- `onclick="..."` 等の inline event handler attribute（`addEventListener` を使う）
- `javascript:` URL
- network access 全般 — `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon`
- 外部 storage / 送信 — `localStorage` への機微データ保存、`window.open` での外部送信
- external library の読込（inline へ bundle して混入させることも含む）

**推奨パターン**:

- DOM 生成は `createElement` + `textContent` / `setAttribute`
- データはページ内 `<script type="application/json">` から `JSON.parse(el.textContent)` で読む
- すべての機能は progressive enhancement（JavaScript 無効でも主要情報が読める）

チェック:

- [ ] 上記禁止 API がソース中に存在しない（validator が機械検査する）
- [ ] JavaScript を無効化して開いても executive summary・findings・全 data table が読める

## 外部依存の禁止リストと出典リンク

self-contained 原則。**ページロード時・操作時に一切の外部通信を発生させない**。

**禁止（external dependency）**:

- `<script src="https://...">`（CDN 含む）
- external stylesheet（`<link rel="stylesheet" href="https://...">`）
- external font（`@font-face` の remote `src`、Google Fonts 等）
- remote `<img src="https://...">`
- `<iframe src="https://...">` / `<object data="https://...">` / `<embed>`
- CSS `@import` / CSS `url(https://...)`
- SVG の remote `<image href>` / remote `<use href>`
- `<link rel="preconnect">` / `rel="dns-prefetch"` 等の投機的接続
- runtime の network request（前節の禁止 API）

**許可（hyperlink）** — 以下の条件をすべて満たす `<a href>` のみ:

- [ ] 用途が source / reference / 関連資料への通常リンク（click しない限り通信しない）
- [ ] scheme が `https:`（または明示的に必要な安全な scheme。`javascript:` は禁止）
- [ ] 新しい tab で開く場合は `rel="noopener noreferrer"` を付与
- [ ] tracking parameter 付き URL・短縮 URL を出典として使わない（可能な限り正規 URL）

**相対 URL も禁止**: `<link href="style.css">` / `<img src="image.png">` のような相対参照は、単一ファイル配布でファイル欠落・意図しないリクエストの原因になるため external dependency と同様に禁止する。validate_report.py はリソース読み込み属性（`script src` / `link href` / `img src` / `iframe src` / SVG `image`・`use` の `href` 等）を、`data:` URI と SVG の文書内 `#fragment` 参照（`<use href="#id">` 等）を除き一律不合格にする（`<script src>` は `data:` でも不合格）。

data URI（`data:image/svg+xml` 等の self-contained 埋め込み）は外部依存ではないが、原則 inline SVG を優先する。

## Sensitive data redaction

- [ ] token・credential・secret・API key・秘密鍵をレポートへ埋め込んでいない。入力データに検出した場合は redaction する（例: `sk-abc...xyz` のように先頭・末尾のみ残す）
- [ ] 検出対象の例: `sk-` / `ghp_` / `github_pat_` / `AKIA` 接頭辞、`token=` / `secret=` / `password=` / `api_key=` 形式、PEM ブロック（`-----BEGIN ... PRIVATE KEY-----`）、`Authorization: Bearer` ヘッダ
- [ ] URL の query string に埋まった credential（`?token=...`）も redaction する
- [ ] 個人情報（メールアドレス・電話番号・住所・氏名）は、レポートの目的に必須でなければ集計値・仮名へ置換する
- [ ] 非公開の内部情報（未公開の数値・社外秘の固有名詞）が含まれる場合、レポート冒頭に取扱注意の明示を検討する
- [ ] 公開可能性が不明な機密情報を含むレポートを、公開前提の出力先（public repo・共有 URL）へ書き込まない。判断がつかない場合はユーザーへ確認する
- [ ] redaction した事実を Methodology / assumptions 節へ記載する（何を・なぜ伏せたか。値そのものは書かない）

## 公開前の最終チェックリスト

validator（`validate_report.py`）が機械検査する項目に加え、以下を目視確認する:

- [ ] light / dark / print の 3 モードで表示が破綻しない
- [ ] 全 chart に accessible name（または正当な `aria-hidden`）と table / text 代替がある
- [ ] 外部通信が 0 件（browser の network panel で確認できる場合）
- [ ] 出典リンクがすべて `https:` で、`javascript:` URL が存在しない
- [ ] secret・個人情報の redaction 漏れがない
- [ ] キーボードだけで全 interactive 要素を操作できる

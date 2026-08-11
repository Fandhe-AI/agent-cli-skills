# Chart selection reference

chart type ごとの選択条件・scale ルール・annotation 指針・アンチパターンの詳細。
概要と選定フローは SKILL.md 本体、component 実装は [./report-design.md](./report-design.md)、
accessibility は [./accessibility-security.md](./accessibility-security.md) を参照。

## 目次

- [選定表（詳細版）](#選定表詳細版)
- [Axis integrity](#axis-integrity)
- [Missing values](#missing-values)
- [Small multiples](#small-multiples)
- [Chart 別の詳細ルール](#chart-別の詳細ルール)
  - [Bar / column](#bar--column)
  - [Line](#line)
  - [Scatter](#scatter)
  - [Heatmap](#heatmap)
  - [Waterfall](#waterfall)
  - [Donut / pie](#donut--pie)
  - [Radar](#radar)
  - [Gantt](#gantt)
- [Annotation 共通指針](#annotation-共通指針)

## 選定表（詳細版）

「伝えたい関係」から選ぶ。chart type ありきで選ばない。

| 伝えたい関係 | 第一候補 | 補助候補 | 選定の決め手 |
|---|---|---|---|
| カテゴリ間の大きさ | horizontal bar | lollipop / dot plot | ラベルが長い・カテゴリ 5 個超なら horizontal。値が近接し bar の ink が過剰なら lollipop |
| 順位 | sorted bar | lollipop | 必ず値でソート。アルファベット順・入力順のまま出さない |
| 時系列の傾向 | line | column / small multiples | 連続的な傾向は line。離散的な期間量（月次売上等）は column |
| 期間ごとの量・flow | column | bar | 期間が 12 個超で column が細くなりすぎるなら line へ切替 |
| 目標との差 | diverging bar / dot | bullet-like bar | 基準線（目標・平均・前年）を 0 位置に置き、正負で色相を変えず symbol/label 併用 |
| 増減への寄与 | waterfall | diverging bar | 開始値→終了値の橋渡しを見せたいときのみ waterfall |
| 2変数の相関 | scatter | scatter + reference line | 点数 5 未満なら table の方が誠実。回帰線は根拠を明記できる場合のみ |
| 分布 | histogram / box plot | dot plot | n が小さい（〜30）なら raw の dot plot を優先し要約統計で隠さない |
| before / after | dumbbell / slope | grouped bar | 2 時点比較は slope が変化方向を最も直接的に見せる |
| part-to-whole | stacked / 100% stacked | donut / pie | 構成比の時系列変化は 100% stacked。単一時点 2〜4 要素なら donut 可 |
| matrix / 時間×カテゴリ | heatmap | table | 値の正確な読取りが主目的なら table。パターン発見が主目的なら heatmap |
| タスクの期間 | Gantt | milestone timeline | 開始・終了日があるなら Gantt。日付が点のみなら timeline |
| milestone の時系列 | timeline | Gantt | 期間概念がないイベント列に bar を与えない |
| 多数系列の比較 | small multiples | limited multi-line | 系列 5 本以上は原則 small multiples。multi-line は最大 4〜5 本 + direct label |
| 多変量プロフィール | normalized bar / small multiples | radar | radar は後述の条件を満たす場合のみ |
| 正確な数値確認 | table | chart + table | 監査・照合目的なら chart を省略してよい |

## Axis integrity

- **0 起点原則**: bar / column / area / waterfall の量的軸は必ず 0 から開始する。長さ・面積で量を符号化する chart は baseline を切ると比率が嘘になる。
- **non-zero baseline を許す条件**（line / scatter / dot plot のみ）:
  - 位置で符号化しており長さ比較を求めない
  - 変動幅が絶対値に比べて小さく、0 起点では傾向が読めない
  - 軸範囲を明示し、必要なら「軸は N〜M の範囲」と note に記す
- index 化（基準時点 = 100）は異なる単位の系列比較に有効。index であることを軸ラベルに明記する。
- 対数軸は倍率変化が主題の場合のみ。軸ラベルに「log scale」と明記し、一般読者向けレポートでは避ける。
- dual-axis は禁止。2 単位を並べたい場合は small multiples に分割する。

## Missing values

- missing を 0 に変換しない。0 は「測定して 0 だった」という別の情報。
- line chart では missing 区間を gap（線を切る）で表現する。補間して繋がない。
- `N/A`（該当なし）、`unknown`（未取得）、`not measured`（測定対象外）が意味的に異なる場合は table・legend で区別する。
- 欠損が多い系列は chart 化を諦め、欠損状況ごと table で見せる方が誠実な場合がある。
- 欠損を含む集計値（平均等）には母数 n を併記する。

## Small multiples

- 比較目的の small multiples は**全 panel で同一 scale**（x 軸・y 軸とも）を原則とする。
- panel ごとに scale を変えざるを得ない場合（桁が違う等）は、各 panel に軸値を明記し「scale は panel ごとに異なる」と note に書く。
- panel 数は 12 個程度まで。並び順は値・重要度でソートし、grid は 2〜4 列。
- 各 panel のタイトルは短く（entity 名のみ）、共通の説明は figure レベルに 1 回だけ書く。

## Chart 別の詳細ルール

### Bar / column

- 使用条件: カテゴリ間の量比較。カテゴリが名義尺度なら値でソート、順序尺度（年齢帯等）なら順序を維持する。
- horizontal bar を優先する条件: ラベルが 6 文字超、カテゴリ 6 個超、mobile 表示重視。
- bar 間の gap は bar 幅の 30〜50%。太すぎる bar・密着 bar を避ける。
- 値ラベルは bar 端に direct label。gridline はラベルを付けたら減らす。
- grouped bar は 1 group あたり最大 3〜4 本。それ以上は small multiples へ。
- stacked bar は最下段 segment 以外の比較が困難。比較させたい segment を最下段に置くか、100% stacked + 合計値ラベルにする。
- アンチパターン: 0 起点でない bar、3D、丸め・先細り形状（長さが読めなくなる）、意味のない色分け（単一系列は 1 色）。

### Line

- 使用条件: 連続時間軸上の傾向・変化率。時間間隔が不均等なら x を実時間スケールにする（等間隔に並べない）。
- multi-line は 4〜5 本まで。系列の識別は色 + line style（solid/dashed/dotted）+ 終端の direct label。legend 単独に依存しない。
- marker は data point が疎（〜20 点）なら付け、密なら省く。
- 面を塗る area は単一系列 + 0 起点のときのみ。重ね合わせ area（stacked でない透過重ね）は使わない。
- smoothing（bezier 補間）はデータにない曲線を作るため使わない。折れ線のまま描く。
- アンチパターン: 10 系列以上の spaghetti、カテゴリ名義軸への line 適用、y 軸切り取りの無明示。

### Scatter

- 使用条件: 2 連続変数の関係。点数 5〜500 程度。5 未満は table、超過は密度表現（透過・binning）を検討する。
- 両軸に単位付きラベル必須。相関 ≠ 因果を本文で明確にする。
- reference line（平均・目標・y=x）は根拠があるときのみ。回帰線を引く場合は手法を note に書く。
- 第 3 変数は marker size（bubble）より色・small multiples を優先。bubble を使うなら**面積**を値に比例させ、凡例に size 例を示す。
- 重要な点・外れ値には direct label を付ける。全点ラベルは不要。

### Heatmap

- 使用条件: matrix 構造（時間×カテゴリ、カテゴリ×カテゴリ）のパターン俯瞰。正確な値の読取りが主目的なら table。
- color scale は知覚的に均一な連続系（Viridis / Cividis 系統）を使い、rainbow を使わない。グレースケール印刷でも単調に判別できること。
- 発散データ（正負・基準との差）は diverging scale とし、中立点を明示的に中央色へ割り当てる。
- cell 数が少ない（〜100 個程度）場合は cell 内に値を直接記載する。文字色は cell 背景に対し contrast を確保する（明背景に暗字・暗背景に明字を閾値で切替）。
- color legend（scale bar）と単位を必ず付ける。missing cell は scale 外の別表現（斜線・`–`）にする。

### Waterfall

- 使用条件: 開始値から終了値への増減寄与の分解（予算差異、利益ブリッジ等）。項目 4〜10 個程度。
- 開始・終了は 0 起点の full bar、中間は floating bar。増・減・合計を色 + 符号ラベル（+/−）で区別し、色だけに依存しない。
- 各 bar に値ラベルを direct label で付ける。connector line（前 bar 終端→次 bar 始端）を細線で描く。
- 項目が多く中間 bar が読めない場合は上位項目 + 「その他」へ集約する。
- アンチパターン: 増減の符号が色のみ、合計 bar の欠落、ソート順が恣意的（原則は寄与の大きさ順か勘定科目順）。

### Donut / pie

- 使用条件: 単一時点の part-to-whole、要素 2〜4 個、かつ「約半分」「約 4 分の 1」レベルの把握で足りる場合のみ。
- 要素 5 個以上・値が近接・時系列比較のいずれかに該当したら horizontal bar か 100% stacked へ切替える。
- 各 slice に「ラベル + 値（%）」を direct label で付け、legend だけにしない。合計が 100% になることを確認する。
- donut 中央の空白には合計値・最重要値を置ける。装飾用の空洞にしない。
- 実装: `stroke-dasharray` による円弧塗り分け（円周 C = 2πr に対し割合分の dash）。JavaScript 不要。
- アンチパターン: 複数 donut の並置比較（slope / bar へ）、3D pie、切り離し（exploded）slice、gauge/speedometer への転用。

### Radar

**使ってよい条件（すべて満たす場合のみ）**:

- 多軸プロフィールの「形」を俯瞰すること自体に価値がある（例: 製品特性の型分類、スキルバランス）
- 軸数 3〜6 程度
- 全軸を同一スケールへ正当に正規化できる（0〜5 の評点等、単位と方向が揃う）
- 重ねる entity が 2〜3 個以下

**使わない条件（1 つでも該当したら normalized bar / small multiples へ）**:

- 軸間に自然な順序がなく、軸の並び順で形（面積）が恣意的に変わることが問題になる
- 軸ごとに単位・スケールが異なり、正規化の根拠を説明できない
- 正確な値の比較・順位付けが目的（radar は読取り精度が低い）
- entity が 4 個以上（重なって判読不能）
- 「良い方向」が軸ごとに逆（大きいほど良い軸と小さいほど良い軸の混在）

使う場合は: 各軸に軸名 + スケール範囲を明記、entity は色 + line style で区別、面の塗りは透過を弱く（fill-opacity 0.1〜0.2）、正規化方法を note に書き、同じデータの table を併記する。

### Gantt

開始日・終了日・milestone・依存関係のある計画に使う。SKILL.md Step 4 の要件の実装詳細。

**座標式**（renderer が計算する。spec には日付のまま渡す）:

```text
X_i     = X_start + ((t_start_i − T_start) / D_total) × W_usable
Width_i = ((t_end_i − t_start_i) / D_total) × W_usable
```

- `T_start` / `D_total` は表示範囲の開始日と総日数。表示範囲は最初の task 開始〜最後の task 終了に前後数日の余白を加える。
- **tick 選択**: 表示範囲 ≦ 3 か月なら week tick（月曜起点）、3 か月〜2 年なら month tick、2 年超なら quarter tick。tick label は範囲に応じて `M/D`・`YYYY-MM`・`YYYY Q n` を使い分け、年境界では年を明記する。
- **行構成**: 左列に task 名（長い名前は省略 + `<title>` で全文）。phase ごとに grouping し、phase 見出し行を挟む。行高は一定にし、bar 高は行高の 55〜70%。
- **milestone**: 期間を持たない点は bar ではなく diamond（rotate 45° の rect か polygon）で描き、ラベルを右横に置く。
- **progress**: planned bar の上に progress 分の overlay bar（同色の濃色または pattern）を重ねる。%値を bar 内または右端にラベルする。progress 不明の task に 0% を与えない（overlay なし + 表で `–`）。
- **today line**: current date が表示範囲内にある場合のみ、縦の破線 + `Today (YYYY-MM-DD)` ラベルを描く。範囲外なら描かない。
- **status**: 色 + 文字/pattern/symbol で区別する（例: done = 塗り + ✓、at-risk = 斜線 pattern + `!`）。legend に全 status を列挙する。
- **dependency の描き分け**: 依存が少数（〜5 本程度）で交差しないなら arrow を描いてよい。それ以上、または arrow が bar・ラベルと交差して読めなくなるなら **arrow を描かず dependency table（task / depends on / type）を併記**する。中途半端に一部だけ描かない。
- **table 併記**: SVG と同じ task / start / end / status / progress を持つ table を必ず併記する。これが screen reader・印刷・正確な日付確認の canonical source になる。
- 日付不明の task に架空の日付を与えない。未定 task は Gantt から除外し、table に「日付未定」として残す。
- mobile: `.chart-wrap` で横スクロール。task 名列は最低幅を確保する。

## Annotation 共通指針

- annotation は「chart から読み取れない文脈」（イベント発生、仕様変更、外れ値の理由）に限定する。読めば分かる値の復唱をしない。
- 対象の直近に配置し、引出線は最短・交差なし。1 chart あたり 1〜3 個まで。
- 基準線（目標・平均・前年）は破線 + 右端ラベルで描き、legend と重複させない。
- annotation のテキストも contrast・font size の基準（[./accessibility-security.md](./accessibility-security.md)）を満たす。
- 出典・注記（データ範囲、除外条件、正規化方法）は chart 直下の source 行に置く。

#!/usr/bin/env python3
"""render_report.py — JSON report spec から自己完結 HTML レポートを生成する renderer。

役割と境界:
- 入力: references/report-spec.md に定義された JSON report spec（--spec）
- 出力: 外部リソースへ一切依存しない単一 HTML ファイル（--output）
- 座標計算・escaping・テーマ・アクセシビリティ属性の付与は本スクリプトの責務。
  「どのグラフを選ぶか」「narrative 設計」は呼び出し側（SKILL.md の手順）の責務。
- Python 3 標準ライブラリのみ使用（外部 package 禁止）。
- 生成物の機械検証は validate_report.py が担う（本スクリプトは生成に専念）。

使い方:
    python3 render_report.py --spec <report-spec.json> --output <out.html>

セキュリティ方針:
- spec 由来の文字列（untrusted）は必ず esc() を経由して text node / attribute に挿入する。
- 数値は有限値であることを検証する（NaN / Inf は SpecError）。
- URL は https: のみハイパーリンク化し、それ以外は文字列として表示する。
- 外部リソース参照（script src / link / remote img / @import / url(https...)）は生成しない。
"""

import argparse
import datetime
import html
import json
import math
import os
import re
import sys

# ---------------------------------------------------------------------------
# 定数: パレット・寸法
# ---------------------------------------------------------------------------

# Okabe-Ito パレットは CSS custom properties（--series-1..8）として定義し、
# SVG 側は fill="var(--series-n)" で参照する（dark mode での差し替えを CSS に委ねる）。
SERIES_VARS = [f"var(--series-{i})" for i in range(1, 9)]

# 折れ線の系列区別は色に加えて破線パターンでも行う（色覚多様性対応）
DASHES = ["", "7 4", "2 4", "10 4 2 4", "4 4", "12 3", "1 3", "6 2 2 2"]

# scatter のマーカー形状（色以外の区別手段）
MARKERS = ["circle", "square", "triangle", "diamond"]

# heatmap 用 Viridis 近似ストップ（知覚的均一・グレースケール印刷でも判別可能）
VIRIDIS = [
    (68, 1, 84), (72, 36, 117), (65, 68, 135), (53, 95, 141),
    (42, 120, 142), (33, 145, 140), (34, 168, 132), (68, 191, 112),
    (122, 209, 81), (189, 223, 38), (253, 231, 37),
]

CHART_W = 760  # 全チャート共通の viewBox 幅（width:100% で縮尺）

# renderer がページ骨格で固定使用する id の予約レジストリ。
# build_html（main / summary / kpis / findings / assumptions / sources）と
# render_toc（toc）が出力する id と同期して管理する。
# sections[].id がこれらと衝突すると duplicate id の HTML を生成してしまうため、
# render_sections が SpecError で弾く（validate_report.py の #3 に到達する前に拒否）。
RESERVED_SECTION_IDS = frozenset(
    {"main", "toc", "summary", "kpis", "findings", "assumptions", "sources"})

# chart のアクセシビリティ id は Ids クラスが ct-N / cd-N で自動採番する。
# sections[].id がこの形式だと chart の <title>/<desc> id と衝突し得るため予約扱いにする。
RESERVED_ID_PATTERN = re.compile(r"^(ct|cd)-\d+$")

# HTML id として許可する形式。空白・引用符等による属性崩れ・アンカー不整合を防ぐため
# 英字始まり + 英数字と - _ のみに制限する（自動採番 sec-N もこの形式に収まる）。
VALID_HTML_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")


class SpecError(Exception):
    """report spec の不備（型不正・非有限数値・必須欠落）を表す。"""


# ---------------------------------------------------------------------------
# 基本ユーティリティ: escaping・数値検証・URL 検証・ID 採番
# ---------------------------------------------------------------------------

def esc(value):
    """untrusted 文字列の一元 escape 関数。HTML/SVG の text・attribute はすべてここを通す。"""
    return html.escape(str(value), quote=True)


def finite(value, ctx="値"):
    """数値を float 化し有限値であることを検証する。None はそのまま返す（欠損許容箇所用）。"""
    if value is None:
        return None
    # bool は int のサブクラスのため float() を素通りする。JSON の true が
    # 数値 1 として描画される事故を防ぐため、数値文脈では boolean を拒否する。
    if isinstance(value, bool):
        raise SpecError(f"{ctx} が boolean（true/false）で数値ではない: {value!r}")
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise SpecError(f"{ctx} が数値ではない: {value!r}")
    if not math.isfinite(f):
        raise SpecError(f"{ctx} が有限値ではない: {value!r}")
    return f


def require_finite(value, ctx="値"):
    """欠損を許容しない数値検証。"""
    f = finite(value, ctx)
    if f is None:
        raise SpecError(f"{ctx} が欠損している")
    return f


def safe_url(url):
    """https: の URL のみ返す。他 scheme（javascript: 等）は None を返し、呼び出し側で文字列表示する。"""
    if not isinstance(url, str):
        return None
    u = url.strip()
    if u.lower().startswith("https://") and not any(c in u for c in ' <>"\''):
        return u
    return None


def fmt(value):
    """表・ラベル用の数値整形。欠損は em ダッシュ、整数は桁区切り、小数は末尾ゼロ除去。"""
    if value is None:
        return "—"
    f = float(value)
    if f == int(f) and abs(f) < 1e15:
        return f"{int(f):,}"
    s = f"{f:,.2f}"
    return s.rstrip("0").rstrip(".")


def require_dict(value, ctx):
    """spec の入れ子が object（dict）であることを検証する。

    JSON として構文上正しくても構造が契約と異なる spec（root が配列・
    chart が数値等）で .get() の AttributeError を露出させないための型ゲート。
    """
    if not isinstance(value, dict):
        raise SpecError(f"{ctx} は object（JSON オブジェクト）で指定する: "
                        f"{type(value).__name__} が渡された")
    return value


def require_list(value, ctx):
    """spec の配列フィールドの型ゲート。None は空リストとして許容する（省略可フィールド用）。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise SpecError(f"{ctx} は配列で指定する: {type(value).__name__} が渡された")
    return value


def require_bool(value, ctx):
    """boolean フィールドの厳格型ゲート。None（未指定）は False として扱う。

    Python の truthy 判定では "false"（非空文字列）や 1 が True 扱いになり
    spec の意図と食い違うため、JSON の true / false（bool）以外は SpecError で拒否する。
    """
    if value is None:
        return False
    if not isinstance(value, bool):
        raise SpecError(f"{ctx} は true / false（boolean）で指定する: {value!r} が渡された")
    return value


def parse_date(value, ctx="日付"):
    """ISO 形式（YYYY-MM-DD）の日付を parse する。不正なら SpecError。"""
    try:
        return datetime.date.fromisoformat(str(value))
    except ValueError:
        raise SpecError(f"{ctx} が YYYY-MM-DD 形式ではない: {value!r}")


def est_w(text, font=13):
    """SVG テキストの概算幅（px）。CJK は全角、それ以外は半角として見積もる。"""
    w = 0.0
    for ch in str(text):
        w += 1.0 if ord(ch) > 0x2E80 else 0.56
    return w * font


class Ids:
    """ページ内で一意な id を採番する。duplicate id を機械的に防ぐ。"""

    def __init__(self):
        self._n = 0

    def next(self, prefix):
        self._n += 1
        return f"{prefix}-{self._n}"


def nice_ticks(lo, hi, target=5):
    """軸目盛りの「きりのよい」値列を返す。lo == hi の縮退にも対応する。"""
    lo, hi = float(lo), float(hi)
    if lo > hi:
        lo, hi = hi, lo
    if lo == hi:
        hi = lo + 1 if lo == 0 else lo + abs(lo) * 0.1
    span = hi - lo
    # 各値は有限でも差が float 上限（約 1.8e308）を超えると span が inf になり
    # 後段の 10**floor(log10(...)) が OverflowError で落ちる。SpecError に正規化する。
    if not math.isfinite(span):
        raise SpecError(
            f"軸範囲の計算が浮動小数の上限を超えた（{lo!r}〜{hi!r}）。値のスケールを見直すこと")
    raw = span / max(target, 1)
    mag = 10 ** math.floor(math.log10(raw))
    step = mag
    for m in (1, 2, 2.5, 5, 10):
        step = m * mag
        if span / step <= target:
            break
    lo2 = math.floor(lo / step) * step
    ticks = []
    t = lo2
    while t <= hi + step * 1e-9:
        ticks.append(round(t, 10))
        t += step
    return ticks


# ---------------------------------------------------------------------------
# 共通 HTML 部品: figure・legend・データ表
# ---------------------------------------------------------------------------

def svg_open(w, h, tid, did, title, desc):
    """アクセシブルな chart SVG の開始タグ。role=img + <title>/<desc> を必ず持つ。"""
    return (
        f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" '
        f'aria-labelledby="{tid} {did}" preserveAspectRatio="xMidYMid meet">'
        f'<title id="{tid}">{esc(title)}</title>'
        f'<desc id="{did}">{esc(desc)}</desc>'
    )


def legend_html(entries):
    """凡例（SVG 外の HTML）。entries: [(swatch_html, label), ...]。装飾なので aria-hidden。"""
    items = "".join(
        f'<li>{swatch}<span>{esc(label)}</span></li>' for swatch, label in entries
    )
    return f'<ul class="legend" aria-hidden="true">{items}</ul>'


def swatch_box(color):
    return f'<span class="swatch" style="background:{color}"></span>'


def swatch_line(color, dash):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<svg class="swatch-line" viewBox="0 0 28 10" aria-hidden="true">'
        f'<line x1="1" y1="5" x2="27" y2="5" stroke="{color}" stroke-width="3"{d}/></svg>'
    )


def swatch_marker(color, shape):
    inner = {
        "circle": f'<circle cx="7" cy="7" r="4" fill="{color}"/>',
        "square": f'<rect x="3" y="3" width="8" height="8" fill="{color}"/>',
        "triangle": f'<path d="M 7 2 L 12 12 L 2 12 Z" fill="{color}"/>',
        "diamond": f'<path d="M 7 2 L 12 7 L 7 12 L 2 7 Z" fill="{color}"/>',
    }[shape]
    return f'<svg class="swatch-line" viewBox="0 0 14 14" aria-hidden="true">{inner}</svg>'


def marker_svg(shape, x, y, color, r=4):
    """scatter / line 用マーカー。形状は色と独立した系列識別手段。"""
    if shape == "circle":
        return f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{color}"/>'
    if shape == "square":
        return f'<rect x="{x - r:.1f}" y="{y - r:.1f}" width="{2 * r}" height="{2 * r}" fill="{color}"/>'
    if shape == "triangle":
        return (f'<path d="M {x:.1f} {y - r - 1:.1f} L {x + r + 1:.1f} {y + r:.1f} '
                f'L {x - r - 1:.1f} {y + r:.1f} Z" fill="{color}"/>')
    return (f'<path d="M {x:.1f} {y - r - 1:.1f} L {x + r + 1:.1f} {y:.1f} '
            f'L {x:.1f} {y + r + 1:.1f} L {x - r - 1:.1f} {y:.1f} Z" fill="{color}"/>')


def data_table(caption, columns, rows, interactive=False):
    """chart と同データの exact-data table。caption / th scope を必ず持つ。

    rows の各セルは (text, is_num) タプル。is_num=True で右寄せ class を付ける。
    """
    cls = ' class="sortable"' if interactive else ""
    ths = "".join(f'<th scope="col">{esc(c)}</th>' for c in columns)
    body = []
    for row in rows:
        tds = []
        for i, (text, is_num) in enumerate(row):
            tag = "th" if i == 0 else "td"
            scope = ' scope="row"' if i == 0 else ""
            num_cls = ' class="num"' if is_num else ""
            tds.append(f"<{tag}{scope}{num_cls}>{esc(text)}</{tag}>")
        body.append(f"<tr>{''.join(tds)}</tr>")
    return (
        f'<div class="table-wrap"><table{cls}><caption>{esc(caption)}</caption>'
        f"<thead><tr>{ths}</tr></thead><tbody>{''.join(body)}</tbody></table></div>"
    )


def figure_html(chart, svg, legend, table_html, interactive):
    """chart の visual unit: figcaption（takeaway）→ SVG → source/note → details 内データ表。

    exact-data table を包む details の開閉は印刷契約に直結する。閉じた details の
    中身はブラウザ仕様で印刷されない（print CSS の display:block では展開できない）ため:
    - interactive モード: 閉じて出力し、beforeprint / afterprint の JS で開閉を切り替える
    - 標準モード（JS なし）: open 付きで出力し、印刷時も常に表が読める状態を保つ
    """
    parts = [f'<figure class="chart-figure">']
    parts.append(f"<figcaption>{esc(chart['title'])}</figcaption>")
    parts.append(f'<div class="chart-wrap">{svg}</div>')
    if legend:
        parts.append(legend)
    notes = []
    if chart.get("note"):
        notes.append(esc(chart["note"]))
    if chart.get("source"):
        notes.append(f"出典: {esc(chart['source'])}")
    if notes:
        parts.append(f'<p class="chart-note">{" ／ ".join(notes)}</p>')
    open_attr = "" if interactive else " open"
    parts.append(
        f'<details class="chart-data"{open_attr}><summary>データ表を表示</summary>{table_html}</details>'
    )
    parts.append("</figure>")
    return "".join(parts)


def chart_desc(chart, fallback):
    """SVG <desc> 用テキスト。spec の accessibility summary を優先し、なければ自動要約。"""
    return chart.get("accessibility_summary") or fallback


# ---------------------------------------------------------------------------
# chart renderer: bar（horizontal / vertical・single / grouped / stacked）
# ---------------------------------------------------------------------------

def render_bar(chart, ids, interactive):
    cats = require_list(chart.get("categories"), f"bar chart '{chart.get('title')}' の categories")
    series = require_list(chart.get("series"), f"bar chart '{chart.get('title')}' の series")
    if not cats or not series:
        raise SpecError(f"bar chart '{chart.get('title')}' に categories / series がない")
    # enum 外の値を silent に既定値扱いすると spec の誤記（"Horizontal" 等）が
    # 意図と違うレイアウトのまま気付かれないため、既定値以外は厳格に拒否する
    orient = chart.get("orientation", "horizontal")
    if orient not in ("horizontal", "vertical"):
        raise SpecError(f"bar chart '{chart.get('title')}' の orientation は "
                        f"horizontal / vertical のいずれか: {orient!r}")
    mode = chart.get("mode", "grouped" if len(series) > 1 else "single")
    if mode not in ("single", "grouped", "stacked"):
        raise SpecError(f"bar chart '{chart.get('title')}' の mode は "
                        f"single / grouped / stacked のいずれか: {mode!r}")
    unit = chart.get("unit", "")
    ns, nc = len(series), len(cats)
    # report-spec.md は "single" を単一系列専用（値の直接ラベル付き描画）と
    # 公開契約している。複数系列を "single" のまま受理すると grouped と同じ
    # 描画経路に流れて文書と実装が食い違うため、ここで明示的に拒否する
    # （レビュー指摘に基づく契約整合）。
    if mode == "single" and ns != 1:
        raise SpecError(f"bar chart '{chart.get('title')}' の mode 'single' は "
                        f"単一系列専用（series が{ns}件）。複数系列は 'grouped' を使用すること")

    vals = []
    for si, s in enumerate(series):
        require_dict(s, f"bar chart '{chart.get('title')}' の series[{si}]")
        v = [finite(x, f"bar '{s.get('name')}' の値")
             for x in require_list(s.get("values"), f"bar series '{s.get('name')}' の values")]
        if len(v) != nc:
            raise SpecError(f"bar series '{s.get('name')}' の値数が categories と不一致")
        vals.append(v)

    # スケール範囲: 量を長さで表すため必ず 0 を含める（axis integrity）
    if mode == "stacked":
        # stacked は各カテゴリの合計を積み上げの長さで表すため、欠損（null）を
        # 0 として積むと存在しない合計値を発明する（Do not invent data 規約違反。
        # データ表は — と表示するため SVG と食い違う）。grouped / line と異なり
        # stacked では欠損を gap として表現できないため、null は拒否する。
        for si, row in enumerate(vals):
            for v in row:
                if v is None:
                    raise SpecError(
                        f"stacked bar '{chart.get('title')}' の series[{si}]"
                        f"（{series[si].get('name')!r}）に欠損値（null）がある。"
                        "stacked は欠損を表現できないため grouped を使用すること")
                if v < 0:
                    raise SpecError("stacked bar に負値は使用できない")
        totals = [sum(vals[j][i] for j in range(ns)) for i in range(nc)]
        vmin, vmax = 0, max(totals + [0])
    else:
        flat = [v for row in vals for v in row if v is not None]
        vmin, vmax = min(flat + [0]), max(flat + [0])
    ticks = nice_ticks(vmin, vmax)
    lo, hi = ticks[0], ticks[-1]

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{nc}カテゴリ・{ns}系列の棒グラフ。単位: {unit or 'なし'}。詳細はデータ表を参照。")
    out = []

    if orient == "horizontal":
        left = min(240, max(90, max(est_w(c) for c in cats) + 12))
        right, top, bottom = 56, 26, 30
        n_bars = 1 if mode == "stacked" else ns
        band = max(30, 14 * n_bars + 14)
        H = top + band * nc + bottom
        plot_w = CHART_W - left - right

        def x(v):
            return left + (v - lo) / (hi - lo) * plot_w

        out.append(svg_open(CHART_W, H, tid, did, chart["title"], desc))
        out.append(f'<text x="{left}" y="16" class="axis-unit">{esc(unit)}</text>' if unit else "")
        for t in ticks:
            tx = x(t)
            out.append(f'<line x1="{tx:.1f}" y1="{top}" x2="{tx:.1f}" y2="{H - bottom}" stroke="var(--grid)"/>')
            out.append(f'<text x="{tx:.1f}" y="{H - bottom + 16}" text-anchor="middle" class="tick">{fmt(t)}</text>')
        zx = x(0)
        out.append(f'<line x1="{zx:.1f}" y1="{top}" x2="{zx:.1f}" y2="{H - bottom}" stroke="var(--fg)" stroke-width="1"/>')
        for i, cat in enumerate(cats):
            y0 = top + i * band
            out.append(f'<text x="{left - 8}" y="{y0 + band / 2 + 4:.1f}" text-anchor="end" class="cat">{esc(cat)}</text>')
            if mode == "stacked":
                acc = 0.0
                for j in range(ns):
                    v = vals[j][i]  # stacked は入力検証で null を拒否済み（非 None 保証）
                    x0, x1 = x(acc), x(acc + v)
                    out.append(f'<rect x="{x0:.1f}" y="{y0 + 7:.1f}" width="{x1 - x0:.1f}" '
                               f'height="{band - 14}" fill="{SERIES_VARS[j % 8]}"/>')
                    acc += v
                out.append(f'<text x="{x(acc) + 5:.1f}" y="{y0 + band / 2 + 4:.1f}" class="val">{fmt(acc)}</text>')
            else:
                bh = (band - 12) / ns
                for j in range(ns):
                    v = vals[j][i]
                    if v is None:
                        continue
                    x0, x1 = sorted((x(0), x(v)))
                    by = y0 + 6 + j * bh
                    out.append(f'<rect x="{x0:.1f}" y="{by:.1f}" width="{max(x1 - x0, 0.5):.1f}" '
                               f'height="{bh - 2:.1f}" fill="{SERIES_VARS[j % 8]}"/>')
                    if mode == "single":  # single は直接ラベルで正確な値を示す（report-spec.md 契約）
                        anchor_x = x1 + 5 if v >= 0 else x0 - 5
                        anchor = "start" if v >= 0 else "end"
                        out.append(f'<text x="{anchor_x:.1f}" y="{by + bh / 2 + 3:.1f}" '
                                   f'text-anchor="{anchor}" class="val">{fmt(v)}</text>')
        out.append("</svg>")
    else:  # vertical
        left, right, top, bottom = 56, 16, 26, 34
        rotate = any(est_w(c, 12) > (CHART_W - left - right) / nc - 8 for c in cats)
        if rotate:
            bottom = 30 + min(90, int(max(est_w(c, 12) for c in cats) * 0.6))
        H = 300 + bottom
        plot_w, plot_h = CHART_W - left - right, H - top - bottom

        def y(v):
            return top + (hi - v) / (hi - lo) * plot_h

        out.append(svg_open(CHART_W, H, tid, did, chart["title"], desc))
        out.append(f'<text x="{left}" y="16" class="axis-unit">{esc(unit)}</text>' if unit else "")
        for t in ticks:
            ty = y(t)
            out.append(f'<line x1="{left}" y1="{ty:.1f}" x2="{CHART_W - right}" y2="{ty:.1f}" stroke="var(--grid)"/>')
            out.append(f'<text x="{left - 6}" y="{ty + 4:.1f}" text-anchor="end" class="tick">{fmt(t)}</text>')
        zy = y(0)
        out.append(f'<line x1="{left}" y1="{zy:.1f}" x2="{CHART_W - right}" y2="{zy:.1f}" stroke="var(--fg)"/>')
        band = plot_w / nc
        for i, cat in enumerate(cats):
            cx = left + band * (i + 0.5)
            if rotate:
                out.append(f'<text x="{cx:.1f}" y="{H - bottom + 14}" text-anchor="end" class="tick" '
                           f'transform="rotate(-35 {cx:.1f} {H - bottom + 14})">{esc(cat)}</text>')
            else:
                out.append(f'<text x="{cx:.1f}" y="{H - bottom + 16}" text-anchor="middle" class="tick">{esc(cat)}</text>')
            if mode == "stacked":
                acc = 0.0
                bw = band * 0.6
                for j in range(ns):
                    v = vals[j][i]  # stacked は入力検証で null を拒否済み（非 None 保証）
                    y0, y1 = y(acc + v), y(acc)
                    out.append(f'<rect x="{cx - bw / 2:.1f}" y="{y0:.1f}" width="{bw:.1f}" '
                               f'height="{y1 - y0:.1f}" fill="{SERIES_VARS[j % 8]}"/>')
                    acc += v
            else:
                bw = band * 0.8 / ns
                for j in range(ns):
                    v = vals[j][i]
                    if v is None:
                        continue
                    y0, y1 = sorted((y(0), y(v)))
                    bx = cx - band * 0.4 + j * bw
                    out.append(f'<rect x="{bx:.1f}" y="{y0:.1f}" width="{bw - 2:.1f}" '
                               f'height="{max(y1 - y0, 0.5):.1f}" fill="{SERIES_VARS[j % 8]}"/>')
        out.append("</svg>")

    legend = legend_html([(swatch_box(SERIES_VARS[j % 8]), series[j].get("name", f"系列{j + 1}"))
                          for j in range(ns)]) if ns > 1 else ""
    unit_sfx = f"（{unit}）" if unit else ""
    cols = ["項目"] + [f"{s.get('name', '値')}{unit_sfx}" for s in series]
    rows = [[(cats[i], False)] + [(fmt(vals[j][i]), True) for j in range(ns)] for i in range(nc)]
    table = data_table(f"{chart['title']}（データ）", cols, rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: line（複数系列・欠損は gap・annotation）
# ---------------------------------------------------------------------------

def render_line(chart, ids, interactive):
    xs = require_list(chart.get("x"), f"line chart '{chart.get('title')}' の x")
    series = require_list(chart.get("series"), f"line chart '{chart.get('title')}' の series")
    if not xs or not series:
        raise SpecError(f"line chart '{chart.get('title')}' に x / series がない")
    unit = chart.get("unit", "")
    nc = len(xs)

    vals = []
    for si, s in enumerate(series):
        require_dict(s, f"line chart '{chart.get('title')}' の series[{si}]")
        v = [finite(x, f"line '{s.get('name')}' の値")
             for x in require_list(s.get("values"), f"line series '{s.get('name')}' の values")]
        if len(v) != nc:
            raise SpecError(f"line series '{s.get('name')}' の値数が x と不一致")
        vals.append(v)
    flat = [v for row in vals for v in row if v is not None]
    if not flat:
        raise SpecError(f"line chart '{chart.get('title')}' に有効な値がない")
    ticks = nice_ticks(min(flat), max(flat))
    lo, hi = ticks[0], ticks[-1]

    # 左余白は全 tick ラベルの最大表示幅で決める。ticks[-1]（最大値）だけを見ると
    # 負値域の長いラベル（例: -12,000）が viewBox 左端で切れる。
    left = max(46, max(est_w(fmt(t), 12) for t in ticks) + 14)
    right, top, bottom = 20, 30, 40
    H = 320
    plot_w, plot_h = CHART_W - left - right, H - top - bottom

    def px(i):
        return left + (i * plot_w / (nc - 1) if nc > 1 else plot_w / 2)

    def py(v):
        return top + (hi - v) / (hi - lo) * plot_h

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{len(series)}系列・{nc}時点の折れ線グラフ。欠損区間は線を途切れさせて表現。詳細はデータ表を参照。")
    out = [svg_open(CHART_W, H, tid, did, chart["title"], desc)]
    if unit:
        out.append(f'<text x="{left}" y="16" class="axis-unit">{esc(unit)}</text>')
    for t in ticks:
        ty = py(t)
        out.append(f'<line x1="{left}" y1="{ty:.1f}" x2="{CHART_W - right}" y2="{ty:.1f}" stroke="var(--grid)"/>')
        out.append(f'<text x="{left - 6}" y="{ty + 4:.1f}" text-anchor="end" class="tick">{fmt(t)}</text>')
    # X ラベルは最大 10 個程度に間引く（重なり防止）
    step = max(1, math.ceil(nc / 10))
    for i in range(0, nc, step):
        out.append(f'<text x="{px(i):.1f}" y="{H - bottom + 18}" text-anchor="middle" class="tick">{esc(xs[i])}</text>')
    out.append(f'<line x1="{left}" y1="{H - bottom}" x2="{CHART_W - right}" y2="{H - bottom}" stroke="var(--fg)"/>')

    for j, s in enumerate(series):
        color, dash = SERIES_VARS[j % 8], DASHES[j % len(DASHES)]
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        # 欠損（null）は gap: 連続する非欠損区間ごとに polyline を分割する
        seg = []
        segments = []
        for i, v in enumerate(vals[j]):
            if v is None:
                if seg:
                    segments.append(seg)
                seg = []
            else:
                seg.append((px(i), py(v)))
        if seg:
            segments.append(seg)
        for pts in segments:
            if len(pts) > 1:
                pstr = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
                out.append(f'<polyline points="{pstr}" fill="none" stroke="{color}" stroke-width="2.5"{dash_attr}/>')
            for x, y in pts:
                out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}"/>')

    # annotation: 指定 x 位置に縦破線 + 短いラベル
    for ai, a in enumerate(require_list(chart.get("annotations"),
                                        f"line chart '{chart.get('title')}' の annotations")):
        require_dict(a, f"line chart '{chart.get('title')}' の annotations[{ai}]")
        label = a.get("label", "")
        ax = a.get("x")
        if ax in xs:
            idx = xs.index(ax)
        else:
            idx = finite(a.get("x_index"), f"annotation '{label}' の x_index")
            if idx is None:
                # x がどのラベルとも一致せず x_index もない annotation を黙って
                # 落とすと「描いたつもり」の欠落に気付けないため spec 段階で弾く
                raise SpecError(
                    f"annotation '{label}' の x {ax!r} が x のラベルに一致しない"
                    "（一致するラベルを指定するか x_index で位置を指定すること）")
            # x_index は 0 始まりで x 配列の要素を指す（references/report-spec.md）。
            # 小数の黙殺切り捨て・範囲外 index は誤った位置への描画（データの嘘）に
            # なるため、int() で丸めずに SpecError で拒否する。
            if idx != int(idx):
                raise SpecError(
                    f"annotation '{label}' の x_index が整数ではない: {a.get('x_index')!r}")
            idx = int(idx)
            if not 0 <= idx < nc:
                raise SpecError(
                    f"annotation '{label}' の x_index が範囲外: {idx}（0〜{nc - 1} で指定）")
        axp = px(idx)
        anchor = "start" if axp < CHART_W * 0.6 else "end"
        dx = 5 if anchor == "start" else -5
        out.append(f'<line x1="{axp:.1f}" y1="{top - 4}" x2="{axp:.1f}" y2="{H - bottom}" '
                   f'stroke="var(--muted)" stroke-dasharray="4 3"/>')
        out.append(f'<text x="{axp + dx:.1f}" y="{top + 4}" text-anchor="{anchor}" class="annot">{esc(label)}</text>')
    out.append("</svg>")

    legend = legend_html([
        (swatch_line(SERIES_VARS[j % 8], DASHES[j % len(DASHES)]), series[j].get("name", f"系列{j + 1}"))
        for j in range(len(series))
    ]) if len(series) > 1 else ""
    unit_sfx = f"（{unit}）" if unit else ""
    cols = ["時点"] + [f"{s.get('name', '値')}{unit_sfx}" for s in series]
    rows = [[(xs[i], False)] + [(fmt(vals[j][i]), True) for j in range(len(series))] for i in range(nc)]
    table = data_table(f"{chart['title']}（データ）", cols, rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: scatter（系列別マーカー形状）
# ---------------------------------------------------------------------------

def render_scatter(chart, ids, interactive):
    series = require_list(chart.get("series"), f"scatter chart '{chart.get('title')}' の series")
    if not series:
        raise SpecError(f"scatter chart '{chart.get('title')}' に series がない")
    x_label = chart.get("x_label", "X")
    y_label = chart.get("y_label", "Y")

    pts_all = []
    for si, s in enumerate(series):
        require_dict(s, f"scatter chart '{chart.get('title')}' の series[{si}]")
        pts = []
        for pi, p in enumerate(require_list(s.get("points"),
                                            f"scatter series '{s.get('name')}' の points")):
            label = None
            if isinstance(p, dict):
                px_, py_, label = p.get("x"), p.get("y"), p.get("label")
            elif isinstance(p, list) and len(p) >= 2:
                px_, py_ = p[0], p[1]
            else:
                raise SpecError(f"scatter series '{s.get('name')}' の points[{pi}] は "
                                f"object または [x, y] 配列で指定する: {p!r}")
            pts.append((require_finite(px_, "scatter x"), require_finite(py_, "scatter y"), label))
        pts_all.append(pts)
    flat = [p for pts in pts_all for p in pts]
    if not flat:
        raise SpecError(f"scatter chart '{chart.get('title')}' に点がない")
    xt = nice_ticks(min(p[0] for p in flat), max(p[0] for p in flat))
    yt = nice_ticks(min(p[1] for p in flat), max(p[1] for p in flat))
    xlo, xhi, ylo, yhi = xt[0], xt[-1], yt[0], yt[-1]

    # 左余白は Y 軸全 tick ラベルの最大表示幅で決める（負値ラベルの切れ防止）
    left = max(50, max(est_w(fmt(t), 12) for t in yt) + 16)
    right, top, bottom = 20, 30, 52
    H = 340
    plot_w, plot_h = CHART_W - left - right, H - top - bottom

    def px(v):
        return left + (v - xlo) / (xhi - xlo) * plot_w

    def py(v):
        return top + (yhi - v) / (yhi - ylo) * plot_h

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{x_label}と{y_label}の散布図（{len(series)}系列）。詳細はデータ表を参照。")
    out = [svg_open(CHART_W, H, tid, did, chart["title"], desc)]
    for t in yt:
        ty = py(t)
        out.append(f'<line x1="{left}" y1="{ty:.1f}" x2="{CHART_W - right}" y2="{ty:.1f}" stroke="var(--grid)"/>')
        out.append(f'<text x="{left - 6}" y="{ty + 4:.1f}" text-anchor="end" class="tick">{fmt(t)}</text>')
    for t in xt:
        tx = px(t)
        out.append(f'<line x1="{tx:.1f}" y1="{top}" x2="{tx:.1f}" y2="{H - bottom}" stroke="var(--grid)"/>')
        out.append(f'<text x="{tx:.1f}" y="{H - bottom + 16}" text-anchor="middle" class="tick">{fmt(t)}</text>')
    out.append(f'<text x="{left + plot_w / 2:.1f}" y="{H - 8}" text-anchor="middle" class="axis-label">{esc(x_label)}</text>')
    out.append(f'<text x="14" y="{top + plot_h / 2:.1f}" text-anchor="middle" class="axis-label" '
               f'transform="rotate(-90 14 {top + plot_h / 2:.1f})">{esc(y_label)}</text>')
    for j, pts in enumerate(pts_all):
        color, shape = SERIES_VARS[j % 8], MARKERS[j % len(MARKERS)]
        for x, y, label in pts:
            out.append(marker_svg(shape, px(x), py(y), color, 5))
            if label:
                out.append(f'<text x="{px(x) + 8:.1f}" y="{py(y) - 6:.1f}" class="annot">{esc(label)}</text>')
    out.append("</svg>")

    legend = legend_html([
        (swatch_marker(SERIES_VARS[j % 8], MARKERS[j % len(MARKERS)]), series[j].get("name", f"系列{j + 1}"))
        for j in range(len(series))
    ]) if len(series) > 1 else ""
    rows = []
    for j, pts in enumerate(pts_all):
        sname = series[j].get("name", f"系列{j + 1}")
        for x, y, label in pts:
            rows.append([(label or sname, False), (sname, False), (fmt(x), True), (fmt(y), True)])
    table = data_table(f"{chart['title']}（データ）", ["項目", "系列", x_label, y_label], rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: heatmap（Viridis 近似の連続スケール・欠損セル対応）
# ---------------------------------------------------------------------------

def _viridis(frac):
    """0..1 の割合を Viridis 近似 hex 色へ変換する。絶対色なので dark mode でもそのまま使う。"""
    frac = min(max(frac, 0.0), 1.0)
    pos = frac * (len(VIRIDIS) - 1)
    i = min(int(pos), len(VIRIDIS) - 2)
    t = pos - i
    r, g, b = (round(VIRIDIS[i][k] + (VIRIDIS[i + 1][k] - VIRIDIS[i][k]) * t) for k in range(3))
    return f"#{r:02x}{g:02x}{b:02x}", (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255


def render_heatmap(chart, ids, interactive):
    rows_lbl = require_list(chart.get("rows"), f"heatmap '{chart.get('title')}' の rows")
    cols_lbl = require_list(chart.get("cols"), f"heatmap '{chart.get('title')}' の cols")
    values = require_list(chart.get("values"), f"heatmap '{chart.get('title')}' の values")
    if not rows_lbl or not cols_lbl or len(values) != len(rows_lbl):
        raise SpecError(f"heatmap '{chart.get('title')}' の rows / cols / values が不整合")
    unit = chart.get("unit", "")
    grid = []
    for r, row in enumerate(values):
        row = require_list(row, f"heatmap 行 {rows_lbl[r]!r} の values")
        if len(row) != len(cols_lbl):
            raise SpecError(f"heatmap 行 {rows_lbl[r]!r} の値数が cols と不一致")
        grid.append([finite(v, f"heatmap [{rows_lbl[r]}]") for v in row])
    flat = [v for row in grid for v in row if v is not None]
    if not flat:
        raise SpecError(f"heatmap '{chart.get('title')}' に有効な値がない")
    vmin, vmax = min(flat), max(flat)
    span = (vmax - vmin) or 1.0

    left = min(200, max(70, max(est_w(r) for r in rows_lbl) + 12))
    top = 34
    cw = min(84, max(34, (CHART_W - left - 16) / len(cols_lbl)))
    ch = 32
    W = int(left + cw * len(cols_lbl) + 16)
    legend_h = 46
    H = int(top + ch * len(rows_lbl) + legend_h + 14)

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{len(rows_lbl)}行×{len(cols_lbl)}列のヒートマップ。色が明るいほど値が大きい。欠損セルは「—」。詳細はデータ表を参照。")
    out = [svg_open(W, H, tid, did, chart["title"], desc)]
    for c, cl in enumerate(cols_lbl):
        out.append(f'<text x="{left + cw * (c + 0.5):.1f}" y="{top - 10}" text-anchor="middle" class="tick">{esc(cl)}</text>')
    for r, rl in enumerate(rows_lbl):
        out.append(f'<text x="{left - 8}" y="{top + ch * (r + 0.5) + 4:.1f}" text-anchor="end" class="cat">{esc(rl)}</text>')
        for c in range(len(cols_lbl)):
            x, y = left + cw * c, top + ch * r
            v = grid[r][c]
            if v is None:
                # 欠損は 0 に変換せず、無色セル + em ダッシュで明示する
                out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw - 2:.1f}" height="{ch - 2}" '
                           f'fill="var(--surface)" stroke="var(--border)"/>')
                out.append(f'<text x="{x + cw / 2:.1f}" y="{y + ch / 2 + 4:.1f}" text-anchor="middle" class="tick">—</text>')
            else:
                color, lum = _viridis((v - vmin) / span)
                txt = "#ffffff" if lum < 0.55 else "#1a1a1a"
                out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw - 2:.1f}" height="{ch - 2}" fill="{color}"/>')
                # セル文字色は輝度に応じた計算色。presentation attribute（fill="..."）は
                # author CSS の `.chart text { fill: var(--fg) }` に負けるため、
                # 優先順位で勝つ inline style で適用する（暗色セル上の可読性を保証）。
                out.append(f'<text x="{x + cw / 2:.1f}" y="{y + ch / 2 + 4:.1f}" text-anchor="middle" '
                           f'class="cell" style="fill:{txt}">{fmt(v)}</text>')
    # 色スケール凡例（min/max ラベル付き）
    ly = top + ch * len(rows_lbl) + 18
    lw, seg = 180, 18
    for i in range(10):
        color, _ = _viridis(i / 9)
        out.append(f'<rect x="{left + i * seg}" y="{ly}" width="{seg}" height="10" fill="{color}"/>')
    out.append(f'<text x="{left}" y="{ly + 24}" class="tick">{fmt(vmin)}{esc(unit)}</text>')
    out.append(f'<text x="{left + lw}" y="{ly + 24}" text-anchor="end" class="tick">{fmt(vmax)}{esc(unit)}</text>')
    out.append("</svg>")

    unit_sfx = f"（{unit}）" if unit else ""
    cols = ["項目"] + [f"{c}{unit_sfx}" for c in cols_lbl]
    trows = [[(rows_lbl[r], False)] + [(fmt(grid[r][c]), True) for c in range(len(cols_lbl))]
             for r in range(len(rows_lbl))]
    table = data_table(f"{chart['title']}（データ）", cols, trows, interactive)
    return figure_html(chart, "".join(out), "", table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: waterfall（増減寄与・累積コネクタ付き）
# ---------------------------------------------------------------------------

def render_waterfall(chart, ids, interactive):
    items = require_list(chart.get("items"), f"waterfall '{chart.get('title')}' の items")
    if not items:
        raise SpecError(f"waterfall '{chart.get('title')}' に items がない")
    unit = chart.get("unit", "")

    # 累積位置を計算する。start / total は 0 起点、delta は直前の累積からの増減。
    bars = []  # (label, base, top, kind, value)
    cum = 0.0
    for ii, it in enumerate(items):
        require_dict(it, f"waterfall '{chart.get('title')}' の items[{ii}]")
        kind = it.get("type", "delta")
        # 未知の type（"Total" 等の誤記）を silent に delta 扱いすると累積が
        # 意図とずれたまま描画されるため、enum 外は spec 段階で弾く
        if kind not in ("start", "delta", "total"):
            raise SpecError(f"waterfall items[].type は start / delta / total のいずれか: {kind!r}")
        v = require_finite(it.get("value"), f"waterfall '{it.get('label')}'")
        if kind in ("start", "total"):
            bars.append((it.get("label", ""), 0.0, v, kind, v))
            cum = v
        else:
            bars.append((it.get("label", ""), cum, cum + v, kind, v))
            cum += v
    all_pts = [0.0] + [b for _, b, t, _, _ in bars for b in (b, t)]
    ticks = nice_ticks(min(all_pts), max(all_pts))
    lo, hi = ticks[0], ticks[-1]

    # 左余白は全 tick ラベルの最大表示幅で決める（負値ラベルの切れ防止）
    left = max(50, max(est_w(fmt(t), 12) for t in ticks) + 16)
    right, top = 16, 30
    labels = [b[0] for b in bars]
    bottom = 34 + (min(80, int(max(est_w(l, 12) for l in labels) * 0.6))
                   if any(est_w(l, 12) > (CHART_W - left - right) / len(bars) - 8 for l in labels) else 0)
    rotate = bottom > 34
    H = 300 + bottom
    plot_w, plot_h = CHART_W - left - right, H - top - bottom
    band = plot_w / len(bars)

    def y(v):
        return top + (hi - v) / (hi - lo) * plot_h

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{len(bars)}項目のウォーターフォール図。増加・減少の寄与と累計を示す。詳細はデータ表を参照。")
    out = [svg_open(CHART_W, H, tid, did, chart["title"], desc)]
    if unit:
        out.append(f'<text x="{left}" y="16" class="axis-unit">{esc(unit)}</text>')
    for t in ticks:
        ty = y(t)
        out.append(f'<line x1="{left}" y1="{ty:.1f}" x2="{CHART_W - right}" y2="{ty:.1f}" stroke="var(--grid)"/>')
        out.append(f'<text x="{left - 6}" y="{ty + 4:.1f}" text-anchor="end" class="tick">{fmt(t)}</text>')
    out.append(f'<line x1="{left}" y1="{y(0):.1f}" x2="{CHART_W - right}" y2="{y(0):.1f}" stroke="var(--fg)"/>')

    prev_top_y = None
    for i, (label, base, topv, kind, v) in enumerate(bars):
        cx = left + band * (i + 0.5)
        bw = band * 0.58
        y0, y1 = sorted((y(base), y(topv)))
        color = ("var(--series-8)" if kind in ("start", "total")
                 else "var(--pos)" if v >= 0 else "var(--neg)")
        out.append(f'<rect x="{cx - bw / 2:.1f}" y="{y0:.1f}" width="{bw:.1f}" '
                   f'height="{max(y1 - y0, 1):.1f}" fill="{color}"/>')
        # 直前の bar の到達値と接続する累積コネクタ（読み取り補助）
        if prev_top_y is not None:
            px0 = left + band * (i - 0.5) + bw / 2
            out.append(f'<line x1="{px0:.1f}" y1="{prev_top_y:.1f}" x2="{cx - bw / 2:.1f}" '
                       f'y2="{prev_top_y:.1f}" stroke="var(--muted)" stroke-dasharray="3 3"/>')
        prev_top_y = y(topv)
        sign = "" if kind in ("start", "total") else ("+" if v >= 0 else "")
        vy = y0 - 6 if kind in ("start", "total") or v >= 0 else y1 + 14
        out.append(f'<text x="{cx:.1f}" y="{vy:.1f}" text-anchor="middle" class="val">{sign}{fmt(v)}</text>')
        if rotate:
            out.append(f'<text x="{cx:.1f}" y="{H - bottom + 14}" text-anchor="end" class="tick" '
                       f'transform="rotate(-35 {cx:.1f} {H - bottom + 14})">{esc(label)}</text>')
        else:
            out.append(f'<text x="{cx:.1f}" y="{H - bottom + 16}" text-anchor="middle" class="tick">{esc(label)}</text>')
    out.append("</svg>")

    legend = legend_html([
        (swatch_box("var(--pos)"), "増加"),
        (swatch_box("var(--neg)"), "減少"),
        (swatch_box("var(--series-8)"), "開始・累計"),
    ])
    unit_sfx = f"（{unit}）" if unit else ""
    kind_ja = {"start": "開始", "delta": "増減", "total": "累計"}
    rows = [[(label, False), (kind_ja.get(kind, kind), False),
             (("+" if kind == "delta" and v >= 0 else "") + fmt(v), True), (fmt(topv), True)]
            for label, base, topv, kind, v in bars]
    table = data_table(f"{chart['title']}（データ）",
                       ["項目", "区分", f"値{unit_sfx}", f"累計{unit_sfx}"], rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: donut（annular sector パス・中央に合計値）
# ---------------------------------------------------------------------------

def _annular_path(cx, cy, ro, ri, a0, a1):
    """ドーナツの扇形パス。角度はラジアン（-π/2 が真上、時計回り）。"""
    large = 1 if (a1 - a0) > math.pi else 0
    p = [
        f"M {cx + ro * math.cos(a0):.2f} {cy + ro * math.sin(a0):.2f}",
        f"A {ro} {ro} 0 {large} 1 {cx + ro * math.cos(a1):.2f} {cy + ro * math.sin(a1):.2f}",
        f"L {cx + ri * math.cos(a1):.2f} {cy + ri * math.sin(a1):.2f}",
        f"A {ri} {ri} 0 {large} 0 {cx + ri * math.cos(a0):.2f} {cy + ri * math.sin(a0):.2f}",
        "Z",
    ]
    return " ".join(p)


def render_donut(chart, ids, interactive):
    slices = require_list(chart.get("slices"), f"donut '{chart.get('title')}' の slices")
    if not slices:
        raise SpecError(f"donut '{chart.get('title')}' に slices がない")
    # SKILL.md の chart 選定規約: donut は 6 分割以下（超える構成比は判読不能になる）。
    # 規約を spec 段階で強制し、多分割は bar への変更を促す。
    if len(slices) > 6:
        raise SpecError(f"donut '{chart.get('title')}' の slices が 6 件を超えている"
                        f"（{len(slices)} 件）。7 区分以上は bar を使用すること")
    unit = chart.get("unit", "")
    # donut は part-to-whole（構成比）専用のため、各 slice の値は 0 以上を必須とする。
    # 負値を許すと負の角度の SVG path・100% 超の構成比が生成され chart の契約を破る。
    vals = []
    for si, s in enumerate(slices):
        require_dict(s, f"donut '{chart.get('title')}' の slices[{si}]")
        v = require_finite(s.get("value"), f"donut '{s.get('label')}'")
        if v < 0:
            raise SpecError(f"donut '{chart.get('title')}' の slices[{si}]"
                            f"（label: {s.get('label')!r}）に負値は使用できない: {v}")
        vals.append(v)
    total = sum(vals)
    if total <= 0:
        raise SpecError(f"donut '{chart.get('title')}' の合計が 0 以下")

    W, H = 300, 230
    cx, cy, ro, ri = 150, 115, 92, 56
    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{len(slices)}区分の構成比ドーナツ。合計 {fmt(total)}{unit}。割合はデータ表を参照。")
    out = [svg_open(W, H, tid, did, chart["title"], desc)]
    angle = -math.pi / 2
    for j, v in enumerate(vals):
        frac = v / total
        a1 = angle + min(frac * 2 * math.pi, 2 * math.pi - 1e-4)
        if v > 0:
            out.append(f'<path d="{_annular_path(cx, cy, ro, ri, angle, a1)}" '
                       f'fill="{SERIES_VARS[j % 8]}" stroke="var(--bg)" stroke-width="1.5"/>')
        angle = a1
    out.append(f'<text x="{cx}" y="{cy - 2}" text-anchor="middle" class="donut-total">{fmt(total)}</text>')
    if unit:
        out.append(f'<text x="{cx}" y="{cy + 16}" text-anchor="middle" class="tick">{esc(unit)}</text>')
    out.append("</svg>")

    legend = legend_html([
        (swatch_box(SERIES_VARS[j % 8]), f"{slices[j].get('label', '')}（{vals[j] / total * 100:.1f}%）")
        for j in range(len(slices))
    ])
    unit_sfx = f"（{unit}）" if unit else ""
    rows = [[(slices[j].get("label", ""), False), (fmt(vals[j]), True),
             (f"{vals[j] / total * 100:.1f}%", True)] for j in range(len(slices))]
    table = data_table(f"{chart['title']}（データ）", ["区分", f"値{unit_sfx}", "構成比"], rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: radar（同一スケールへ正規化された多軸プロフィール）
# ---------------------------------------------------------------------------

def render_radar(chart, ids, interactive):
    axes = require_list(chart.get("axes"), f"radar '{chart.get('title')}' の axes")
    series = require_list(chart.get("series"), f"radar '{chart.get('title')}' の series")
    if len(axes) < 3 or not series:
        raise SpecError(f"radar '{chart.get('title')}' は 3 軸以上の axes と series が必要")
    vmax = require_finite(chart.get("max", 5), "radar max")
    if vmax <= 0:
        # 0 以下だと v / vmax の正規化が破綻する（0 除算・負スケール）ため spec 段階で弾く
        raise SpecError(f"radar '{chart.get('title')}' の max は 0 より大きい値が必要: {fmt(vmax)}")
    n = len(axes)

    vals = []
    for si, s in enumerate(series):
        require_dict(s, f"radar '{chart.get('title')}' の series[{si}]")
        v = [require_finite(x, f"radar '{s.get('name')}' の値")
             for x in require_list(s.get("values"), f"radar series '{s.get('name')}' の values")]
        if len(v) != n:
            raise SpecError(f"radar series '{s.get('name')}' の値数が axes と不一致")
        if any(x < 0 or x > vmax for x in v):
            raise SpecError(f"radar series '{s.get('name')}' に 0..{vmax} 範囲外の値がある")
        vals.append(v)

    W, H = 460, 340
    cx, cy, R = 230, 172, 112

    def pt(i, frac):
        a = -math.pi / 2 + 2 * math.pi * i / n
        return cx + R * frac * math.cos(a), cy + R * frac * math.sin(a)

    tid, did = ids.next("ct"), ids.next("cd")
    desc = chart_desc(chart, f"{n}軸（最大値 {fmt(vmax)}）のレーダーチャート、{len(series)}系列。正確な値はデータ表を参照。")
    out = [svg_open(W, H, tid, did, chart["title"], desc)]
    for frac in (0.25, 0.5, 0.75, 1.0):
        ring = " ".join(f"{x:.1f},{y:.1f}" for x, y in (pt(i, frac) for i in range(n)))
        out.append(f'<polygon points="{ring}" fill="none" stroke="var(--grid)"/>')
    for i, ax in enumerate(axes):
        x1, y1 = pt(i, 1.0)
        out.append(f'<line x1="{cx}" y1="{cy}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="var(--grid)"/>')
        lx, ly = pt(i, 1.16)
        anchor = "middle" if abs(lx - cx) < 12 else ("start" if lx > cx else "end")
        out.append(f'<text x="{lx:.1f}" y="{ly + 4:.1f}" text-anchor="{anchor}" class="cat">{esc(ax)}</text>')
    out.append(f'<text x="{cx + 4}" y="{cy - R - 4:.1f}" class="tick">{fmt(vmax)}</text>')
    for j, v in enumerate(vals):
        color = SERIES_VARS[j % 8]
        poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in (pt(i, v[i] / vmax) for i in range(n)))
        out.append(f'<polygon points="{poly}" fill="{color}" fill-opacity="0.14" '
                   f'stroke="{color}" stroke-width="2.5"/>')
        for i in range(n):
            x, y = pt(i, v[i] / vmax)
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="{color}"/>')
    out.append("</svg>")

    legend = legend_html([(swatch_box(SERIES_VARS[j % 8]), series[j].get("name", f"系列{j + 1}"))
                          for j in range(len(series))]) if len(series) > 1 else ""
    cols = ["軸"] + [s.get("name", "値") for s in series]
    rows = [[(axes[i], False)] + [(fmt(vals[j][i]), True) for j in range(len(series))] for i in range(n)]
    table = data_table(f"{chart['title']}（データ・最大値 {fmt(vmax)}）", cols, rows, interactive)
    return figure_html(chart, "".join(out), legend, table, interactive)


# ---------------------------------------------------------------------------
# chart renderer: gantt（phase grouping・milestone・progress・today line）
# ---------------------------------------------------------------------------

GANTT_STATUS = {
    # status キー → (色 CSS 変数, 表示ラベル)。色だけに依存させずテキストでも必ず示す。
    "done": ("var(--status-done)", "完了"),
    "in-progress": ("var(--status-active)", "進行中"),
    "planned": ("var(--status-planned)", "予定"),
    "at-risk": ("var(--status-risk)", "リスク"),
    "blocked": ("var(--status-blocked)", "ブロック"),
}


def _gantt_ticks(t0, t1):
    """期間長に応じて week（月曜）/ month（1日）/ quarter（四半期初日）の tick を自動選択する。

    閾値は references/chart-selection.md の記載に合わせる:
    120 日以下 → 週、730 日（約 2 年）以下 → 月、それ超 → 四半期（`YYYY Qn`）。
    """
    total = (t1 - t0).days
    ticks = []
    if total <= 120:
        d = t0 + datetime.timedelta(days=(7 - t0.weekday()) % 7)  # 次の月曜
        while d <= t1:
            ticks.append((d, f"{d.month}/{d.day}"))
            d += datetime.timedelta(days=7)
    elif total <= 730:
        y, m = t0.year, t0.month
        if t0.day > 1:
            m += 1
        while True:
            if m > 12:
                y, m = y + 1, 1
            d = datetime.date(y, m, 1)
            if d > t1:
                break
            ticks.append((d, f"{y}-{m:02d}"))
            m += 1
    else:
        # 四半期初日（1/4/7/10 月の 1 日）へ切り上げてから 3 か月刻みで進める
        y, m = t0.year, t0.month
        if not (m in (1, 4, 7, 10) and t0.day == 1):
            m = ((m - 1) // 3 + 1) * 3 + 1
            if m > 12:
                y, m = y + 1, m - 12
        while True:
            d = datetime.date(y, m, 1)
            if d > t1:
                break
            ticks.append((d, f"{y} Q{(m - 1) // 3 + 1}"))
            m += 3
            if m > 12:
                y, m = y + 1, m - 12
    return ticks


def _gantt_progress(t):
    """gantt task の progress を検証して返す（欠損は None）。

    SVG バーとデータ表の両方がこの検証済み値を使う契約——描画側だけ clamp して
    表と食い違う値を見せない。0.0..1.0 の範囲外は SpecError。
    """
    prog = finite(t.get("progress"), f"task '{t.get('name')}' の progress")
    if prog is not None and not (0.0 <= prog <= 1.0):
        raise SpecError(f"task '{t.get('name')}' の progress が 0.0..1.0 の範囲外: {prog}")
    return prog


def render_gantt(chart, ids, interactive):
    tasks = require_list(chart.get("tasks"), f"gantt '{chart.get('title')}' の tasks")
    if not tasks:
        raise SpecError(f"gantt '{chart.get('title')}' に tasks がない")

    # 構造の事前検証: 要素型・必須 name・id の一意性をまとめて弾く。
    # id 重複を許すと dependsOn の解決先（name_by_id）が黙って後勝ちになり
    # 依存関係テーブルが嘘をつくため、SpecError で拒否する。
    seen_task_ids = set()
    for ti, t in enumerate(tasks):
        require_dict(t, f"gantt '{chart.get('title')}' の tasks[{ti}]")
        if not t.get("name"):
            raise SpecError(f"gantt tasks[{ti}] に name がない")
        # status の enum 検証と正規化（未指定・明示 null は planned 扱い）。
        # enum 外を silent に series-8 色・未翻訳テキストへフォールバックすると
        # "Done" 等の誤記が凡例と食い違う灰色バーのまま気付かれないため、spec 段階で弾く。
        # ここで task dict へ正規化済み値を確定格納し、描画・データ表は
        # 以降 t["status"] のみを参照する（"status": null がキーとして存在すると
        # .get のデフォルトが効かず KeyError になる問題の一元対処）。
        status = t.get("status")
        if status is None:
            status = "planned"
        elif status not in GANTT_STATUS:
            raise SpecError(f"task '{t.get('name')}' の status は "
                            f"{' / '.join(GANTT_STATUS)} のいずれか: {status!r}")
        t["status"] = status
        task_id = t.get("id")
        if task_id is not None:
            if task_id in seen_task_ids:
                raise SpecError(f"gantt tasks[].id が重複している: {task_id!r}")
            seen_task_ids.add(task_id)

    # 日付範囲: 全タスク・マイルストーンの min/max に前後 2 日のパディング
    dates = []
    for t in tasks:
        if require_bool(t.get("milestone"), f"task '{t.get('name')}' の milestone"):
            dates.append(parse_date(t.get("date"), f"milestone '{t.get('name')}' の date"))
        else:
            d_start = parse_date(t.get("start"), f"task '{t.get('name')}' の start")
            d_end = parse_date(t.get("end"), f"task '{t.get('name')}' の end")
            if d_end < d_start:
                # 負期間は入力ミス確定。2px の退化バーとして黙って描かず spec 段階で弾く
                raise SpecError(f"task '{t.get('name')}' の end ({d_end.isoformat()}) が "
                                f"start ({d_start.isoformat()}) より前")
            dates.append(d_start)
            dates.append(d_end)
    t0 = min(dates) - datetime.timedelta(days=2)
    t1 = max(dates) + datetime.timedelta(days=2)
    d_total = (t1 - t0).days or 1

    # phase の出現順を保ってグルーピングする（spec 順を尊重）
    phases = []
    for t in tasks:
        p = t.get("phase", "")
        if p not in phases:
            phases.append(p)

    left = min(230, max(110, max(est_w(t.get("name", "")) for t in tasks) + 14))
    right, top = 96, 34
    row_h, phase_h = 30, 24
    n_rows = len(tasks) + sum(1 for p in phases if p)
    H = top + phase_h * 0 + row_h * len(tasks) + sum(phase_h for p in phases if p) + 26
    plot_w = CHART_W - left - right

    def x(d):
        # 座標式: X = X_start + ((t - T_start) / D_total) * W_usable（analysis-notes 準拠）
        return left + (d - t0).days / d_total * plot_w

    tid, did = ids.next("ct"), ids.next("cd")
    n_ms = sum(1 for t in tasks if t.get("milestone"))
    desc = chart_desc(chart, f"{len(tasks) - n_ms}タスク・{n_ms}マイルストーンのガントチャート。"
                             f"期間 {t0.isoformat()}〜{t1.isoformat()}。開始・終了・進捗・ステータスはデータ表を参照。")
    out = [svg_open(CHART_W, H, tid, did, chart["title"], desc)]

    for d, label in _gantt_ticks(t0, t1):
        tx = x(d)
        out.append(f'<line x1="{tx:.1f}" y1="{top}" x2="{tx:.1f}" y2="{H - 22}" stroke="var(--grid)"/>')
        out.append(f'<text x="{tx:.1f}" y="{top - 10}" text-anchor="middle" class="tick">{label}</text>')

    y = top
    for phase in phases:
        if phase:
            out.append(f'<text x="4" y="{y + phase_h - 8}" class="phase">{esc(phase)}</text>')
            out.append(f'<line x1="0" y1="{y + phase_h - 2}" x2="{CHART_W}" y2="{y + phase_h - 2}" stroke="var(--border)"/>')
            y += phase_h
        for t in tasks:
            if t.get("phase", "") != phase:
                continue
            cy_ = y + row_h / 2
            out.append(f'<text x="{left - 8}" y="{cy_ + 4:.1f}" text-anchor="end" class="cat">{esc(t.get("name", ""))}</text>')
            # status は事前検証で正規化済み（null → planned・enum 外は SpecError）のため直接引ける
            color, status_ja = GANTT_STATUS[t["status"]]
            if require_bool(t.get("milestone"), f"task '{t.get('name')}' の milestone"):
                mx = x(parse_date(t["date"]))
                s = 8
                out.append(f'<path d="M {mx:.1f} {cy_ - s:.1f} L {mx + s:.1f} {cy_:.1f} '
                           f'L {mx:.1f} {cy_ + s:.1f} L {mx - s:.1f} {cy_:.1f} Z" fill="{color}"/>')
                out.append(f'<text x="{mx + s + 5:.1f}" y="{cy_ + 4:.1f}" class="status">{esc(status_ja)}</text>')
            else:
                # end は inclusive（当日いっぱい）として扱い、翌日 0 時までをバー幅にする。
                # (end - start).days のままだと同日タスクが幅 0 に潰れ、複数日タスクも
                # 1 日分短く描画される（Bugbot Medium 指摘）
                x0, x1 = x(parse_date(t["start"])), x(parse_date(t["end"]) + datetime.timedelta(days=1))
                bh = 16
                out.append(f'<rect x="{x0:.1f}" y="{cy_ - bh / 2:.1f}" width="{max(x1 - x0, 2):.1f}" '
                           f'height="{bh}" rx="3" fill="{color}" fill-opacity="0.45"/>')
                prog = _gantt_progress(t)
                if prog is not None:
                    # planned bar の上に progress overlay（不透明）を重ねる
                    out.append(f'<rect x="{x0:.1f}" y="{cy_ - bh / 2:.1f}" width="{max((x1 - x0) * prog, 0):.1f}" '
                               f'height="{bh}" rx="3" fill="{color}"/>')
                label = status_ja + (f" {int(round(prog * 100))}%" if prog is not None else "")
                out.append(f'<text x="{x1 + 6:.1f}" y="{cy_ + 4:.1f}" class="status">{esc(label)}</text>')
            y += row_h

    # today line: spec の today が期間内にある場合のみ描画する
    today_raw = chart.get("today")
    if today_raw:
        today = parse_date(today_raw, "gantt today")
        if t0 <= today <= t1:
            tx = x(today)
            out.append(f'<line x1="{tx:.1f}" y1="{top - 4}" x2="{tx:.1f}" y2="{H - 22}" '
                       f'stroke="var(--neg)" stroke-width="1.5" stroke-dasharray="5 3"/>')
            # presentation attribute（fill="..."）は author CSS の
            # `.chart .annot { fill: var(--muted) }` に負けて常にグレーになるため、
            # heatmap セルと同様に優先順位で勝つ inline style で適用する
            out.append(f'<text x="{tx + 4:.1f}" y="{H - 8}" class="annot" style="fill:var(--neg)">本日 {today.isoformat()}</text>')
    out.append("</svg>")

    legend = legend_html(
        [(swatch_box(GANTT_STATUS[k][0]), GANTT_STATUS[k][1])
         for k in ("done", "in-progress", "planned", "at-risk", "blocked")]
    )

    # SVG と同一データの表（task / start / end / progress / status）
    rows = []
    for t in tasks:
        if require_bool(t.get("milestone"), f"task '{t.get('name')}' の milestone"):
            rows.append([(t.get("name", ""), False), (t.get("phase", "—"), False),
                         (str(t.get("date")), False), ("—", False), ("—", True),
                         (GANTT_STATUS[t["status"]][1] + "（マイルストーン）", False)])
        else:
            prog = _gantt_progress(t)
            rows.append([(t.get("name", ""), False), (t.get("phase", "—"), False),
                         (str(t.get("start")), False), (str(t.get("end")), False),
                         (f"{int(round(prog * 100))}%" if prog is not None else "—", True),
                         (GANTT_STATUS[t["status"]][1], False)])
    table = data_table(f"{chart['title']}（データ）",
                       ["タスク", "フェーズ", "開始", "終了", "進捗", "ステータス"], rows, interactive)

    # 依存関係は矢印で描かず表で示す（密集時の可読性を優先する設計判断）
    dep_html = ""
    deps = [(t.get("name", ""), d) for t in tasks
            for d in require_list(t.get("dependsOn"), f"task '{t.get('name')}' の dependsOn")]
    if deps:
        name_by_id = {t.get("id"): t.get("name", "") for t in tasks if t.get("id")}
        dep_rows = [[(n, False), (name_by_id.get(d, str(d)), False)] for n, d in deps]
        dep_html = data_table("タスク依存関係", ["タスク", "依存先（先行タスク）"], dep_rows, interactive)
    return figure_html(chart, "".join(out), legend, table + dep_html, interactive)


CHART_RENDERERS = {
    "bar": render_bar,
    "line": render_line,
    "scatter": render_scatter,
    "heatmap": render_heatmap,
    "waterfall": render_waterfall,
    "donut": render_donut,
    "radar": render_radar,
    "gantt": render_gantt,
}


# ---------------------------------------------------------------------------
# ページ部品: KPI・findings・sections・assumptions・sources・TOC
# ---------------------------------------------------------------------------

def render_kpis(kpis):
    if not kpis:
        return ""
    cards = []
    for i, k in enumerate(kpis):
        # label / value は spec（references/report-spec.md）の必須フィールド。
        # 欠落を空文字で埋めると「値のない KPI カード」が黙って出るため拒否する。
        if not k.get("label"):
            raise SpecError(f"kpis[{i}] に label がない")
        if k.get("value") is None or k.get("value") == "":
            raise SpecError(f"kpis[{i}]（label: {k.get('label')}）に value がない")
        trend = k.get("trend")
        # enum 外の trend（"Up" 等の誤記）を silent に flat 扱いしない
        if trend not in (None, "up", "down", "flat"):
            raise SpecError(f"kpis[{i}]（label: {k.get('label')}）の trend は "
                            f"up / down / flat のいずれか: {trend!r}")
        delta_html = ""
        if k.get("delta") is not None:
            arrow, cls = {"up": ("↑", "pos"), "down": ("↓", "neg")}.get(trend, ("→", "flat"))
            delta_html = f'<span class="kpi-delta {cls}">{arrow} {esc(k["delta"])}</span>'
        note = f'<span class="kpi-note">{esc(k["note"])}</span>' if k.get("note") else ""
        unit = f'<span class="kpi-unit">{esc(k["unit"])}</span>' if k.get("unit") else ""
        cards.append(
            f'<li class="kpi-card"><span class="kpi-label">{esc(k["label"])}</span>'
            f'<span class="kpi-value">{esc(k["value"])}{unit}</span>{delta_html}{note}</li>'
        )
    return (f'<section id="kpis" aria-label="主要指標">'
            f'<ul class="kpi-grid">{"".join(cards)}</ul></section>')


def render_findings(findings):
    if not findings:
        return ""
    items = []
    for i, f in enumerate(findings):
        if isinstance(f, dict):
            body = f'<strong>{esc(f.get("title", ""))}</strong> — {esc(f.get("body", ""))}'
        elif isinstance(f, str):
            body = esc(f)
        else:
            # 数値・配列等を str() で黙って文字列化せず、契約（string | object）を守らせる
            raise SpecError(f"findings[{i}] は string または object で指定する: "
                            f"{type(f).__name__} が渡された")
        items.append(f"<li>{body}</li>")
    return (f'<section id="findings"><h2>主な所見</h2>'
            f'<ol class="findings">{"".join(items)}</ol></section>')


def render_body_text(body, ctx="body"):
    """本文ブロック。string または string の配列を段落として描画する。

    契約（string | string[]）外の値を str() で黙って文字列化すると
    object や数値が「{'a': 1}」等の生表現のまま段落に混入するため、
    型を厳格に検証して SpecError で拒否する。
    """
    if body is None:
        return ""
    if isinstance(body, str):
        paras = [body]
    elif isinstance(body, list):
        for i, p in enumerate(body):
            if not isinstance(p, str):
                raise SpecError(f"{ctx}[{i}] は string で指定する: "
                                f"{type(p).__name__} が渡された")
        paras = body
    else:
        raise SpecError(f"{ctx} は string または string の配列で指定する: "
                        f"{type(body).__name__} が渡された")
    return "".join(f"<p>{esc(p)}</p>" for p in paras)


def render_section_table(tbl, interactive):
    """chart に紐付かない独立データ表。columns / rows は表示文字列のまま受け取る。"""
    tname = tbl.get("title", "データ表")
    cols = require_list(tbl.get("columns"), f"table '{tname}' の columns")
    aligns = require_list(tbl.get("align"), f"table '{tname}' の align")
    rows = []
    for ri, r in enumerate(require_list(tbl.get("rows"), f"table '{tname}' の rows")):
        r = require_list(r, f"table '{tname}' の rows[{ri}]")
        # 列数の不一致は <th scope="col"> とセルの対応が崩れた表になるため拒否する
        if len(r) != len(cols):
            raise SpecError(f"table '{tname}' の rows[{ri}] の列数 {len(r)} が "
                            f"columns の列数 {len(cols)} と一致しない")
        cells = []
        for i, cell in enumerate(r):
            # bool は int のサブクラス。JSON の true を数値 1 として整形しないよう除外する
            cell_is_num = isinstance(cell, (int, float)) and not isinstance(cell, bool)
            is_num = (aligns[i] == "num") if i < len(aligns) else cell_is_num
            if cell_is_num:
                # 他 renderer と同じ有限値ゲート。json.load は Infinity/NaN を
                # float として通すため、fmt に渡す前に SpecError で弾く。
                cell = fmt(finite(cell, f"table '{tname}' のセル値"))
            else:
                cell = str(cell)
            cells.append((cell, is_num))
        rows.append(cells)
    out = data_table(tbl.get("title", "データ表"), cols, rows, interactive)
    if tbl.get("note"):
        out += f'<p class="chart-note">{esc(tbl["note"])}</p>'
    return out


def render_sections(sections, ids, interactive):
    html_parts, toc_entries = [], []
    seen_ids = set()
    for i, sec in enumerate(sections, 1):
        require_dict(sec, f"sections[{i - 1}]")
        sid = sec.get("id") or f"sec-{i}"
        # sections[].id の契約検証（references/report-spec.md の「sections[].id の契約」参照）。
        # 明示指定は形式・予約 id を検査し、自動採番 sec-N を含む全 id で一意性を要求する。
        if sec.get("id"):
            if not VALID_HTML_ID.match(sid):
                raise SpecError(
                    f"sections[{i - 1}].id が HTML id として不正: {sid!r}"
                    "（英字始まり・英数字と - _ のみ使用可）")
            if sid in RESERVED_SECTION_IDS or RESERVED_ID_PATTERN.match(sid):
                raise SpecError(
                    f"sections[{i - 1}].id {sid!r} は renderer の予約 id と衝突する"
                    f"（予約: {', '.join(sorted(RESERVED_SECTION_IDS))} および ct-N / cd-N 形式）")
        if sid in seen_ids:
            raise SpecError(
                f"sections[].id が重複している: {sid!r}"
                "（自動採番 sec-N との衝突を含め、id はページ内で一意にすること）")
        seen_ids.add(sid)
        # heading は spec の必須フィールド。プレースホルダで埋めず欠落を明示的に拒否する
        heading = sec.get("heading")
        if not heading:
            raise SpecError(f"sections[{i - 1}] に heading がない")
        toc_entries.append((sid, heading))
        parts = [f'<section id="{esc(sid)}"><h2>{esc(heading)}</h2>']
        parts.append(render_body_text(sec.get("body"), f"sections[{i - 1}].body"))
        for j, chart in enumerate(require_list(sec.get("charts"), f"sections[{i - 1}].charts")):
            require_dict(chart, f"sections[{i - 1}].charts[{j}]")
            ctype = chart.get("type")
            renderer = CHART_RENDERERS.get(ctype)
            if renderer is None:
                raise SpecError(f"未対応の chart type: {ctype!r}（対応: {', '.join(sorted(CHART_RENDERERS))}）")
            if not chart.get("title"):
                raise SpecError(f"chart（type={ctype}）に title がない")
            parts.append(renderer(chart, ids, interactive))
        for j, tbl in enumerate(require_list(sec.get("tables"), f"sections[{i - 1}].tables")):
            require_dict(tbl, f"sections[{i - 1}].tables[{j}]")
            parts.append(render_section_table(tbl, interactive))
        parts.append("</section>")
        html_parts.append("".join(parts))
    return "".join(html_parts), toc_entries


def render_toc(entries):
    """セクションが 3 つ以上のときのみ目次を出す（短いレポートでは冗長なため）。"""
    if len(entries) < 3:
        return ""
    links = "".join(f'<li><a href="#{esc(sid)}">{esc(h)}</a></li>' for sid, h in entries)
    return f'<nav id="toc" aria-label="目次"><h2>目次</h2><ol>{links}</ol></nav>'


def render_assumptions(assumptions):
    if not assumptions:
        return ""
    # 契約は string[]（references/report-spec.md）。object・数値を str() で
    # 黙って文字列化せず、要素位置を示して拒否する。
    for i, a in enumerate(assumptions):
        if not isinstance(a, str):
            raise SpecError(f"assumptions[{i}] は string で指定する: "
                            f"{type(a).__name__} が渡された")
    items = "".join(f"<li>{esc(a)}</li>" for a in assumptions)
    return f'<section id="assumptions"><h2>前提・制約</h2><ul>{items}</ul></section>'


def render_sources(sources):
    if not sources:
        return ""
    items = []
    for s in sources:
        label = esc(s.get("label", s.get("url", "")))
        url = safe_url(s.get("url"))
        if url:
            # 出典リンクは唯一許可される外部参照。rel で opener/referrer を遮断する。
            items.append(f'<li><a href="{esc(url)}" rel="noopener noreferrer">{label}</a></li>')
        elif s.get("url"):
            # https 以外の URL はリンク化せず文字列として表示する（javascript: 等の遮断）
            items.append(f"<li>{label}（URL: <code>{esc(s['url'])}</code>）</li>")
        else:
            items.append(f"<li>{label}</li>")
    return f'<section id="sources"><h2>出典</h2><ul>{"".join(items)}</ul></section>'


# ---------------------------------------------------------------------------
# CSS / JS（インライン埋め込み・外部参照なし）
# ---------------------------------------------------------------------------

# design token を :root に集約し、dark mode は token の差し替えのみで実現する
CSS = """
:root {
  color-scheme: light dark;
  --bg: #f6f7f8; --surface: #ffffff; --fg: #1a1c1e; --muted: #5b6167;
  --border: #d5d9dd; --grid: #e4e7ea; --focus: #0b57d0; --link: #0b57d0;
  /* Okabe-Ito パレット（色覚多様性対応） */
  --series-1: #0072B2; --series-2: #E69F00; --series-3: #56B4E9; --series-4: #D55E00;
  --series-5: #009E73; --series-6: #CC79A7; --series-7: #F0E442; --series-8: #8A8F94;
  --status-done: #009E73; --status-active: #0072B2;
  --status-planned: #8A8F94; --status-risk: #D55E00;
  /* blocked は at-risk（朱）と区別するため Okabe-Ito の赤紫を割り当てる */
  --status-blocked: #CC79A7;
  --pos: #0072B2; --neg: #D55E00;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a; --surface: #1f2226; --fg: #e6e8ea; --muted: #9aa1a8;
    --border: #3a3f45; --grid: #303539; --focus: #8ab4f8; --link: #8ab4f8;
    --series-8: #a2a8ae;
    /* KPI delta・today ラベル等のテキスト色。light 用の #0072B2 / #D55E00 は
       dark 背景（#15171a / #1f2226）に対しコントラスト比 4.5:1 を割るため、
       明度を上げた色に差し替える（#4ea3dd: 6.5/5.8、#ef8a3c: 7.2/6.4）。 */
    --pos: #4ea3dd; --neg: #ef8a3c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif;
  line-height: 1.65; font-size: clamp(14px, 1.5vw, 16px);
}
main { max-width: 60rem; margin-inline: auto; padding: 0 1.25rem 3rem; }
p { max-width: 46rem; }
a { color: var(--link); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.skip-link {
  position: absolute; left: -9999px; top: 0; background: var(--surface);
  padding: 0.5rem 1rem; z-index: 10;
}
.skip-link:focus { left: 0; }
header.report-header {
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 2rem 1.25rem 1.5rem;
}
.header-inner { max-width: 60rem; margin-inline: auto; }
h1 { margin: 0 0 0.25rem; font-size: clamp(1.4rem, 3vw, 1.9rem); line-height: 1.35; }
.subtitle { color: var(--muted); margin: 0 0 0.5rem; }
.report-meta { color: var(--muted); font-size: 0.85em; margin: 0; }
h2 { font-size: 1.25rem; border-bottom: 2px solid var(--border); padding-bottom: 0.3rem; margin-top: 2.5rem; }
#toc { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1.25rem; margin-top: 1.5rem; }
#toc h2 { border: none; margin: 0 0 0.25rem; font-size: 1rem; }
#toc ol { margin: 0; padding-left: 1.4rem; }
#toc a { text-decoration: none; }
#toc a.current { font-weight: 700; }
.kpi-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem; list-style: none; padding: 0; margin: 1.5rem 0 0;
}
.kpi-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 0.15rem;
}
.kpi-label { color: var(--muted); font-size: 0.82em; }
.kpi-value { font-size: 1.6em; font-weight: 700; line-height: 1.2; }
.kpi-unit { font-size: 0.55em; font-weight: 400; margin-left: 0.2em; color: var(--muted); }
.kpi-delta { font-size: 0.85em; }
.kpi-delta.pos { color: var(--pos); }
.kpi-delta.neg { color: var(--neg); }
.kpi-note { color: var(--muted); font-size: 0.78em; }
.findings li { margin-bottom: 0.4rem; }
.chart-figure {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  margin: 1.5rem 0; padding: 1rem 1.25rem;
}
.chart-figure figcaption { font-weight: 700; margin-bottom: 0.75rem; }
.chart-wrap { max-width: 100%; overflow-x: auto; }
.chart { width: 100%; height: auto; display: block; min-width: 480px; }
.chart text { font-family: inherit; fill: var(--fg); }
.chart .tick, .chart .status, .chart .annot, .chart .axis-unit { font-size: 11px; fill: var(--muted); }
.chart .cat, .chart .axis-label { font-size: 12.5px; }
.chart .val { font-size: 11px; }
.chart .cell { font-size: 11px; }
.chart .phase { font-size: 12px; font-weight: 700; }
.chart .donut-total { font-size: 22px; font-weight: 700; }
.chart-note { color: var(--muted); font-size: 0.82em; margin: 0.5rem 0 0; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; padding: 0; margin: 0.6rem 0 0; font-size: 0.85em; }
.legend li { display: inline-flex; align-items: center; gap: 0.35rem; }
.swatch { width: 0.85em; height: 0.85em; border-radius: 2px; display: inline-block; }
.swatch-line { width: 1.7em; height: 0.8em; }
.chart-data { margin-top: 0.75rem; }
.chart-data summary { cursor: pointer; color: var(--link); font-size: 0.88em; }
.table-wrap { max-width: 100%; overflow-x: auto; margin: 0.75rem 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; background: var(--surface); }
caption { text-align: left; color: var(--muted); font-size: 0.88em; padding-bottom: 0.35rem; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; }
thead th { background: color-mix(in srgb, var(--surface) 88%, var(--fg)); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
th button.sort-btn {
  all: inherit; cursor: pointer; width: 100%; padding: 0; display: inline;
}
#assumptions ul, #sources ul { padding-left: 1.3rem; }
footer.report-footer {
  border-top: 1px solid var(--border); margin-top: 3rem; padding: 1rem 1.25rem 2rem;
  color: var(--muted); font-size: 0.82em;
}
footer.report-footer .footer-inner { max-width: 60rem; margin-inline: auto; }
@media (max-width: 640px) {
  .chart { min-width: 420px; }
}
@media print {
  @page { size: A4; margin: 14mm; }
  :root {
    --bg: #ffffff; --surface: #ffffff; --fg: #000000; --muted: #444444;
    --border: #999999; --grid: #dddddd;
  }
  body { background: #ffffff; }
  .skip-link, #toc, .chart-data summary { display: none; }
  /* 注: 閉じた details の中身は CSS（display:block 等）では印刷に出せない（ブラウザ仕様）。
     データ表の印刷可視化は、標準モード = open 属性付き出力、
     interactive モード = beforeprint / afterprint JS の開閉切替で保証する */
  .chart-figure, .kpi-card, tr { break-inside: avoid; }
  h2 { break-after: avoid; }
  * { box-shadow: none !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a { color: #000000; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
"""

# interactive: true のときのみ注入される vanilla JS。
# 制約: 外部通信 API 不使用・inline handler 不使用・untrusted 文字列を innerHTML に入れない。
INTERACTIVE_JS = """
(function () {
  "use strict";

  /* テーブルソート: th をボタン化し、数値・日付・文字列を型推論して昇降順ソートする */
  function parseCell(text) {
    var t = text.replace(/[,%\\s]/g, "");
    if (t === "" || t === "—") return { type: "empty", value: null };
    var n = Number(t);
    if (Number.isFinite(n)) return { type: "num", value: n };
    var d = Date.parse(text);
    if (!Number.isNaN(d) && /\\d{4}-\\d{2}-\\d{2}/.test(text)) return { type: "date", value: d };
    return { type: "str", value: text };
  }

  function sortTable(table, colIndex, dir) {
    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);
    rows.sort(function (a, b) {
      var ca = parseCell(a.cells[colIndex].textContent.trim());
      var cb = parseCell(b.cells[colIndex].textContent.trim());
      if (ca.type === "empty") return 1;
      if (cb.type === "empty") return -1;
      var r;
      if (ca.type === "num" && cb.type === "num") r = ca.value - cb.value;
      else if (ca.type === "date" && cb.type === "date") r = ca.value - cb.value;
      else r = String(ca.value).localeCompare(String(cb.value), "ja");
      return dir === "asc" ? r : -r;
    });
    rows.forEach(function (row) { tbody.appendChild(row); });
  }

  document.querySelectorAll("table.sortable").forEach(function (table) {
    var headers = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(headers, function (th, i) {
      var btn = document.createElement("button");
      btn.className = "sort-btn";
      btn.type = "button";
      btn.textContent = th.textContent; /* 既存テキストのみ移植（innerHTML 不使用） */
      th.textContent = "";
      th.appendChild(btn);
      btn.addEventListener("click", function () {
        var dir = th.getAttribute("aria-sort") === "ascending" ? "desc" : "asc";
        Array.prototype.forEach.call(headers, function (h) { h.removeAttribute("aria-sort"); });
        th.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
        sortTable(table, i, dir);
      });
    });
  });

  /* TOC スクロールスパイ: 表示中セクションの目次リンクを強調する */
  var toc = document.getElementById("toc");
  if (toc && "IntersectionObserver" in window) {
    var links = {};
    toc.querySelectorAll("a[href^='#']").forEach(function (a) {
      links[a.getAttribute("href").slice(1)] = a;
    });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = links[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          Object.keys(links).forEach(function (k) { links[k].classList.remove("current"); });
          link.classList.add("current");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    Object.keys(links).forEach(function (id) {
      var sec = document.getElementById(id);
      if (sec) observer.observe(sec);
    });
  }

  /* 印刷対応: 閉じた <details> の中身はブラウザ仕様で印刷されない（print CSS の
     display:block では展開できない）ため、beforeprint で閉じているデータ表を
     すべて開き、afterprint で元の開閉状態へ戻す */
  var openedForPrint = [];
  window.addEventListener("beforeprint", function () {
    openedForPrint = Array.prototype.slice.call(
      document.querySelectorAll("details.chart-data:not([open])"));
    openedForPrint.forEach(function (d) { d.open = true; });
  });
  window.addEventListener("afterprint", function () {
    openedForPrint.forEach(function (d) { d.open = false; });
    openedForPrint = [];
  });
})();
"""


# ---------------------------------------------------------------------------
# ページ全体の組み立て
# ---------------------------------------------------------------------------

def build_html(spec):
    # 型ゲート: JSON として妥当でも構造が契約と異なる spec を、traceback ではなく
    # 日本語 SpecError で拒否する（残余の構造不備は main() の安全網が正規化する）
    require_dict(spec, "spec の root")
    kpis = require_list(spec.get("kpis"), "kpis")
    for i, k in enumerate(kpis):
        require_dict(k, f"kpis[{i}]")
    findings = require_list(spec.get("findings"), "findings")
    sources = require_list(spec.get("sources"), "sources")
    for i, s in enumerate(sources):
        require_dict(s, f"sources[{i}]")
    assumptions = require_list(spec.get("assumptions"), "assumptions")
    # 明示 null は欠損（未指定）と同義に正規化する。dict 以外は型ゲートで拒否する。
    meta = spec.get("meta")
    meta = require_dict(meta, "meta") if meta is not None else {}

    ids = Ids()
    interactive = require_bool(spec.get("interactive"), "interactive")
    title = spec.get("title")
    if not title:
        raise SpecError("spec に title がない")

    sections_html, toc_entries = render_sections(
        require_list(spec.get("sections"), "sections"), ids, interactive)

    meta_bits = []
    if spec.get("date"):
        meta_bits.append(f"日付: {esc(spec['date'])}")
    if spec.get("scope"):
        meta_bits.append(f"対象: {esc(spec['scope'])}")
    meta_line = f'<p class="report-meta">{" ／ ".join(meta_bits)}</p>' if meta_bits else ""
    subtitle = f'<p class="subtitle">{esc(spec["subtitle"])}</p>' if spec.get("subtitle") else ""
    summary = ""
    if spec.get("summary"):
        summary = (f'<section id="summary"><h2>要約</h2>'
                   f'{render_body_text(spec["summary"], "summary")}</section>')

    generated_at = meta.get("generated_at") or datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    generator = meta.get("generator", "create-html-report / render_report.py")

    doc = [
        "<!doctype html>",
        f'<html lang="{esc(spec.get("lang", "ja"))}">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{esc(title)}</title>",
        f"<style>{CSS}</style>",
        "</head>",
        "<body>",
        '<a class="skip-link" href="#main">本文へスキップ</a>',
        '<header class="report-header"><div class="header-inner">',
        f"<h1>{esc(title)}</h1>",
        subtitle,
        meta_line,
        "</div></header>",
        '<main id="main">',
        render_toc(toc_entries),
        summary,
        render_kpis(kpis),
        render_findings(findings),
        sections_html,
        render_assumptions(assumptions),
        render_sources(sources),
        "</main>",
        '<footer class="report-footer"><div class="footer-inner">',
        f"<p>生成: {esc(generated_at)} ／ generator: {esc(generator)}</p>",
        "</div></footer>",
    ]
    if interactive:
        doc.append(f"<script>{INTERACTIVE_JS}</script>")
    doc.append("</body></html>")
    return "\n".join(p for p in doc if p)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="JSON report spec から自己完結 HTML レポートを生成する。")
    parser.add_argument("--spec", required=True, help="report spec JSON のパス")
    parser.add_argument("--output", required=True, help="出力 HTML のパス")
    args = parser.parse_args(argv)

    try:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
    except FileNotFoundError:
        print(f"エラー: spec ファイルが見つからない: {args.spec}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"エラー: spec の JSON が不正: {e}", file=sys.stderr)
        return 1

    try:
        html_text = build_html(spec)
    except SpecError as e:
        print(f"spec エラー: {e}", file=sys.stderr)
        return 1
    except (AttributeError, TypeError, KeyError, ValueError, IndexError,
            OverflowError, ZeroDivisionError) as e:
        # 型ゲートで網羅しきれない構造不備の安全網。traceback を露出させず
        # 「spec 不備は日本語エラー・終了コード 1」の契約に正規化する。
        # OverflowError / ZeroDivisionError は巨大値・縮退スケールの座標計算で発生し得る。
        print(f"spec エラー: spec の構造が不正で描画できない"
              f"（{type(e).__name__}: {e}）。references/report-spec.md の型契約を確認すること。",
              file=sys.stderr)
        return 1

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(html_text)
    print(f"HTML レポートを生成した: {os.path.abspath(args.output)}")
    print("次のステップ: validate_report.py で検証すること。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

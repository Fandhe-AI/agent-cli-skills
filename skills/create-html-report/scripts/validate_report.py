#!/usr/bin/env python3
"""validate_report.py — 生成 HTML レポートの機械検証。

役割と境界:
- render_report.py（または手書き HTML）の出力が SKILL.md の
  Self-contained / Accessible / Security 契約を満たすかを機械的に検証する。
- 検証のみを行い、ファイルの修正・生成は行わない（修正は renderer / spec 側の責務）。
- Python 3 標準ライブラリ（html.parser）のみで動作する。

使い方:
    python3 validate_report.py <output.html>

終了コード: 全チェック PASS で 0、1 件でも FAIL で 1。
結果は日本語の PASS/FAIL 一覧で出力する。
"""

import re
import sys
from html.parser import HTMLParser

# 自己完結契約で許可するリソース URL。
# - data: URI は「受動的な埋め込みメディア」に限り、下記の画像 MIME allowlist に
#   一致する場合のみ許可する。image/svg+xml は <script> を内包し得るため不許可。
#   text/html・text/css 等の能動コンテンツ MIME は、data: 経由で inline 検査
#   （network API・@import・url() 許可リスト）を迂回できるため不許可。
# - #fragment（SVG <use href="#id"> 等の文書内参照）は SVG 系タグと CSS url() に限り許可
# 相対 URL（style.css / image.png 等）は配布先でのファイル欠落・意図しない
# リクエストの原因になるため、http(s):// と同様に不合格として扱う。
DATA_URI_ALLOWED = re.compile(r"^\s*data:image/(png|jpeg|gif|webp)[;,]", re.IGNORECASE)
FRAGMENT_URL = re.compile(r"^\s*#")

# inline JS 内で禁止する network API のパターン
NETWORK_API = re.compile(
    r"\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.serviceWorker)"
)

# CSS 内で一律禁止する外部読み込み。url(...) は CSS_URL で全件抽出し、
# リソース属性と同じ許可リスト方式（許可画像 MIME の data: と #fragment のみ）で検査する。
CSS_IMPORT = re.compile(r"@import", re.IGNORECASE)

# CSS の url(...) トークン抽出（引用符・前後空白を許容）
CSS_URL = re.compile(r"url\(\s*(['\"]?)([^)'\"]*)\1\s*\)", re.IGNORECASE)

# javascript: URL 判定前に除去する文字（空白と C0 制御文字）。
# ブラウザは `java\tscript:` や改行・CR 混じりの scheme も実行するため、
# スペースのみの除去では検出を迂回できてしまう。
URL_IGNORABLE = re.compile(r"[\s\x00-\x1f]+")

# class="chart" を持たない SVG を検証対象へ引き戻すための子要素数しきい値。
# 凡例 swatch 等の装飾 SVG は数要素に収まるため、これ以上はデータ描画とみなす。
SEMANTIC_SVG_MIN_ELEMS = 6


def css_bad_urls(css_text):
    """CSS 中の url(...) から自己完結契約に違反する参照を抽出する。

    許可は画像 MIME allowlist（DATA_URI_ALLOWED）に一致する data: URI と
    文書内 #fragment（SVG gradient / filter 参照等）のみ。
    url(data:text/css,...) は @import 検査の迂回になるため不合格。
    url(image.png) / url(../fonts/a.woff2) のような相対 URL も配布先で
    欠落・意図しないリクエストの原因になるため、http(s) / // と同様に不合格。
    """
    bad = []
    for m in CSS_URL.finditer(css_text):
        v = m.group(2).strip()
        if not (DATA_URI_ALLOWED.match(v) or FRAGMENT_URL.match(v)):
            bad.append(f"url({v!r})")
    return bad


def is_chart_svg(s):
    """chart 相当として検証すべき SVG かを判定する。

    class="chart" の明示に加え、role="img" 宣言・子要素数の多い
    「意味論的 SVG」も対象に含める（class を外して accessible name /
    viewBox / .chart-wrap 検証を回避する抜け道を塞ぐ）。
    """
    return ("chart" in s["classes"]
            or s["attrs"].get("role") == "img"
            or s["elems"] >= SEMANTIC_SVG_MIN_ELEMS)


class ReportParser(HTMLParser):
    """検証に必要な構造情報を 1 パスで収集する parser。

    判定ロジックは持たず、収集した事実（タグ・属性・階層）を checks 側で評価する。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.has_doctype = False
        self.tags_seen = set()
        self.ids = []
        self.headings = []          # 出現順の heading レベル列 [1, 2, 2, ...]
        self.svgs = []              # {attrs, in_chart_wrap, has_title, has_desc, classes, elems}
        self.tables = []            # {has_caption, th_count, in_table_wrap}
        self.scripts = []           # inline <script> の中身
        self.styles = []            # <style> の中身
        self.bad_handlers = []      # on* 属性の出現箇所
        self.bad_js_urls = []       # javascript: URL
        self.external_refs = []     # 不許可のリソース読み込み属性（script src / link / img 等）
        self.anchor_hrefs = []      # <a href> の値（出典リンク検査用）
        self.style_attr_external = []
        self.title_text = ""
        self.meta_charset = False
        self.meta_viewport = False
        self._stack = []            # (tag, classes) の祖先スタック
        self._in = None             # "script" | "style" | "title" | "svg-title" | "svg-desc"
        self._buf = ""
        self._cur_svg = None
        self._cur_table = None

    # -- 補助 ---------------------------------------------------------------

    def _has_ancestor_class(self, cls):
        return any(cls in classes for _, classes in self._stack)

    # -- HTMLParser hooks ---------------------------------------------------

    def handle_decl(self, decl):
        if decl.lower().startswith("doctype"):
            self.has_doctype = True

    def handle_starttag(self, tag, attrs):
        ad = dict(attrs)
        classes = (ad.get("class") or "").split()
        self.tags_seen.add(tag)

        if ad.get("id"):
            self.ids.append(ad["id"])

        # inline event handler（on*）は tag を問わず全面禁止
        for name, _ in attrs:
            if name.startswith("on"):
                self.bad_handlers.append(f"<{tag} {name}>")

        # javascript: URL の検査（href / src / action / xlink:href）。
        # タブ・改行等の制御文字を挟んだ迂回も判定前に除去して検出する。
        for key in ("href", "src", "action", "xlink:href"):
            v = ad.get(key) or ""
            if URL_IGNORABLE.sub("", v.lower()).startswith("javascript:"):
                self.bad_js_urls.append(f"<{tag} {key}>")

        # リソース読み込み属性の検査（自己完結契約）。
        # 能動コンテンツ（script src / link / iframe / object / embed）は、
        # data: URI でも中身の JS / CSS / HTML が inline 検査（network API・
        # @import・url() 許可リスト）を迂回できるため、値を問わず一律不合格。
        # 受動メディア（img / source / track / audio / video / SVG image）は
        # DATA_URI_ALLOWED の画像 MIME allowlist に一致する data: のみ許可。
        # SVG <image>/<use> は文書内 #fragment 参照も許可。
        # 出典 <a href> は対象外 = 唯一の許可経路（check #9 で https / #fragment に制限）。
        if tag == "script" and "src" in ad:
            self.external_refs.append(f"<script src={ad['src']!r}>")
        if tag in ("link", "iframe", "object", "embed"):
            for key in ("href", "src", "data", "srcset"):
                if key in ad:
                    self.external_refs.append(f"<{tag} {key}={ad[key]!r}>")
        if tag in ("img", "source", "track", "audio", "video"):
            for key in ("src", "srcset"):
                if key in ad and not DATA_URI_ALLOWED.match(ad.get(key) or ""):
                    self.external_refs.append(f"<{tag} {key}={ad[key]!r}>")
        if tag in ("image", "use"):  # SVG 内のリソース参照
            for key in ("href", "xlink:href"):
                v = ad.get(key) or ""
                if key in ad and not (DATA_URI_ALLOWED.match(v) or FRAGMENT_URL.match(v)):
                    self.external_refs.append(f"<{tag} {key}={ad[key]!r}>")
        # style 属性内の CSS も <style> ブロックと同じ許可リストで検査する
        sv = ad.get("style") or ""
        if "style" in ad and (CSS_IMPORT.search(sv) or css_bad_urls(sv)):
            self.style_attr_external.append(f"<{tag} style=...>")

        if tag == "a" and ad.get("href"):
            self.anchor_hrefs.append(ad["href"])

        if tag == "meta":
            if "charset" in ad:
                self.meta_charset = True
            if ad.get("name", "").lower() == "viewport":
                self.meta_viewport = True

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.headings.append(int(tag[1]))

        # SVG 内の子要素数を数える（is_chart_svg の「意味論的 SVG」判定材料）
        if self._cur_svg is not None and tag != "svg":
            self._cur_svg["elems"] += 1
        if tag == "svg":
            self._cur_svg = {
                "attrs": ad,
                "in_chart_wrap": self._has_ancestor_class("chart-wrap"),
                "has_title": False,
                "has_desc": False,
                "classes": classes,
                "elems": 0,
            }
            self.svgs.append(self._cur_svg)
        if tag == "title" and self._cur_svg is not None:
            self._cur_svg["has_title"] = True
        if tag == "desc" and self._cur_svg is not None:
            self._cur_svg["has_desc"] = True

        if tag == "table":
            self._cur_table = {
                "has_caption": False,
                "th_count": 0,
                "in_table_wrap": self._has_ancestor_class("table-wrap"),
            }
            self.tables.append(self._cur_table)
        if tag == "caption" and self._cur_table is not None:
            self._cur_table["has_caption"] = True
        if tag == "th" and self._cur_table is not None:
            self._cur_table["th_count"] += 1

        if tag == "script":
            self._in, self._buf = "script", ""
        elif tag == "style":
            self._in, self._buf = "style", ""
        elif tag == "title" and self._cur_svg is None:
            self._in, self._buf = "title", ""

        self._stack.append((tag, classes))

    def handle_endtag(self, tag):
        # 閉じタグに対応する開始タグまでスタックを巻き戻す（多少の不整合に耐える）
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                del self._stack[i:]
                break
        if tag == "script" and self._in == "script":
            self.scripts.append(self._buf)
            self._in = None
        elif tag == "style" and self._in == "style":
            self.styles.append(self._buf)
            self._in = None
        elif tag == "title" and self._in == "title":
            self.title_text = self._buf.strip()
            self._in = None
        if tag == "svg":
            self._cur_svg = None
        if tag == "table":
            self._cur_table = None

    def handle_data(self, data):
        if self._in in ("script", "style", "title"):
            self._buf += data


# ---------------------------------------------------------------------------
# チェック本体: (チェック名, ok, 詳細) のリストを返す
# ---------------------------------------------------------------------------

def run_checks(path):
    checks = []

    def check(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    # 1. ファイル存在・non-empty
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        check("ファイルが存在し読み取り可能", False, str(e))
        return checks
    check("ファイルが存在し non-empty", len(raw.strip()) > 0,
          f"{len(raw):,} bytes")
    if not raw.strip():
        return checks

    parser = ReportParser()
    parser.feed(raw)
    parser.close()

    # 2. 文書骨格
    check("doctype 宣言がある", parser.has_doctype)
    for tag in ("html", "head", "body"):
        check(f"<{tag}> がある", tag in parser.tags_seen)
    check("meta charset がある", parser.meta_charset)
    check("meta viewport がある", parser.meta_viewport)
    check("<title> が non-empty", bool(parser.title_text), parser.title_text[:60])

    # 3. duplicate id
    dup = sorted({i for i in parser.ids if parser.ids.count(i) > 1})
    check("duplicate id がない", not dup, "重複: " + ", ".join(dup[:5]) if dup else "")

    # 4. SVG 開閉一致（parser の自動補完に頼らず raw テキストで数える）
    n_open, n_close = len(re.findall(r"<svg\b", raw)), raw.count("</svg>")
    check("<svg> の開閉タグ数が一致", n_open == n_close, f"開 {n_open} / 閉 {n_close}")

    # 5. リソース読み込み属性ゼロ（能動要素は値を問わず不合格。受動メディアは
    #    許可画像 MIME の data: と SVG 文書内 #fragment のみ許可。
    #    相対 URL も自己完結契約違反として不合格。出典 <a href> は #9 で別途検査）
    check("リソース読み込み属性がない（script / link / iframe / object / embed は一律禁止、"
          "img 等は画像 data: と #fragment のみ許可）",
          not parser.external_refs, "; ".join(parser.external_refs[:5]))
    css_all = "\n".join(parser.styles)
    css_bad = css_bad_urls(css_all)
    css_detail = (["@import"] if CSS_IMPORT.search(css_all) else []) \
        + css_bad[:3] + parser.style_attr_external[:3]
    check("CSS に @import / 不許可の url() がない（url() は画像 data: と #fragment のみ許可）",
          not css_detail, "; ".join(css_detail))

    # 6. network API 不使用
    js_all = "\n".join(parser.scripts)
    m = NETWORK_API.search(js_all)
    check("inline JS が network API を使わない", m is None, m.group(0) if m else "")

    # 7. inline event handler なし
    check("inline event handler（on* 属性）がない",
          not parser.bad_handlers, "; ".join(parser.bad_handlers[:5]))

    # 8. javascript: URL なし
    check("javascript: URL がない", not parser.bad_js_urls, "; ".join(parser.bad_js_urls[:5]))

    # 9. <a href> は https / ページ内 fragment のみ（出典リンクと外部依存の区別）
    bad_anchors = [h for h in parser.anchor_hrefs
                   if not (h.startswith("#") or h.lower().startswith("https://"))]
    check("<a href> が https または #fragment のみ",
          not bad_anchors, "; ".join(bad_anchors[:5]))

    # 10. chart SVG のアクセシブルネーム
    #     chart 相当の SVG（is_chart_svg: class="chart" / role=img / 子要素多数）は
    #     role=img + aria-labelledby + title/desc を要求。
    #     それ以外（凡例 swatch 等の装飾）は aria-hidden を要求。
    bad_svgs = []
    for i, s in enumerate(parser.svgs):
        a = s["attrs"]
        if is_chart_svg(s):
            ok = (a.get("role") == "img" and a.get("aria-labelledby")
                  and s["has_title"] and s["has_desc"])
        else:
            ok = a.get("aria-hidden") == "true"
        if not ok:
            bad_svgs.append(f"svg#{i + 1}")
    check("chart SVG に accessible name（role=img + title/desc）がある",
          not bad_svgs, "; ".join(bad_svgs[:5]))

    # 11. chart SVG の viewBox（レスポンシブ縮尺の前提）
    no_vb = [f"svg#{i + 1}" for i, s in enumerate(parser.svgs)
             if is_chart_svg(s) and not s["attrs"].get("viewbox")]
    check("chart SVG に viewBox がある", not no_vb, "; ".join(no_vb[:5]))

    # 12. table の caption / headers
    bad_tables = [f"table#{i + 1}" for i, t in enumerate(parser.tables)
                  if not (t["has_caption"] and t["th_count"] > 0)]
    check("全 table に caption と th がある", not bad_tables, "; ".join(bad_tables[:5]))

    # 13. heading 順序（h1→h3 のような飛び越しがない）
    jumps = []
    prev = 0
    for h in parser.headings:
        if prev and h > prev + 1:
            jumps.append(f"h{prev}→h{h}")
        prev = h
    check("heading レベルに飛び越しがない", not jumps, "; ".join(jumps[:5]))
    check("h1 が存在する", 1 in parser.headings)

    # 14. print CSS
    check("@media print が定義されている", "@media print" in css_all)

    # 15. body 横 overflow を誘発する既知パターン
    #     - chart SVG が .chart-wrap（overflow-x: auto）の外にある
    #     - table が .table-wrap の外にある
    #     - CSS に overflow-x: auto の受け皿がない
    naked_svg = [f"svg#{i + 1}" for i, s in enumerate(parser.svgs)
                 if is_chart_svg(s) and not s["in_chart_wrap"]]
    check("chart SVG が .chart-wrap 内にある", not naked_svg, "; ".join(naked_svg[:5]))
    naked_tbl = [f"table#{i + 1}" for i, t in enumerate(parser.tables)
                 if not t["in_table_wrap"]]
    check("table が .table-wrap 内にある", not naked_tbl, "; ".join(naked_tbl[:5]))
    check("CSS に overflow-x: auto の横スクロール受け皿がある",
          "overflow-x: auto" in css_all or "overflow-x:auto" in css_all)

    return checks


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("使い方: python3 validate_report.py <output.html>", file=sys.stderr)
        return 1

    checks = run_checks(argv[0])
    n_fail = sum(1 for _, ok, _ in checks if not ok)

    print(f"検証対象: {argv[0]}")
    print("-" * 60)
    for name, ok, detail in checks:
        mark = "PASS" if ok else "FAIL"
        line = f"[{mark}] {name}"
        if detail and not ok:
            line += f" — {detail}"
        print(line)
    print("-" * 60)
    if n_fail == 0:
        print(f"結果: PASS（全 {len(checks)} 項目通過）")
        return 0
    print(f"結果: FAIL（{n_fail} / {len(checks)} 項目が不合格）")
    print("HTML または report spec を修正して再生成・再検証すること。")
    return 1


if __name__ == "__main__":
    sys.exit(main())

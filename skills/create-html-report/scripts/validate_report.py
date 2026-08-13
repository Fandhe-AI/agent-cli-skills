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

import os
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

# inline JS 内で禁止する network API のパターン。
# 主防御は bundled JS との完全一致ゲート（bundled_js / check #6）であり、
# 本 regex は難読化（window['fetch'] 等）を完全一致が弾いた上での防御多層として残す。
NETWORK_API = re.compile(
    r"\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|navigator\.serviceWorker)"
)

# CSS escape（\69 / \00069 形式 + 継続空白 1 文字、および \x の単文字 escape）。
# `@\69mport` や `u\72l(` のような難読化で @import / url() の文字列検査を
# 迂回できるため、検査前に css_unescape で Unicode へ正規化する。
CSS_ESCAPE = re.compile(r"\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\(.)", re.DOTALL)

# CSS 内で一律禁止する外部読み込み。url(...) は CSS_URL で全件抽出し、
# リソース属性と同じ許可リスト方式（許可画像 MIME の data: と #fragment のみ）で検査する。
CSS_IMPORT = re.compile(r"@import", re.IGNORECASE)

# CSS の url(...) トークン抽出。引用付き（" / '）と無引用を別分岐でパースする
# （引用付きは値中の `)` を含み得るため、単一の文字クラスでは正しく抽出できない）。
# ここでマッチしない url( の出現は css_bad_urls が「解析不能」として不合格にする。
CSS_URL = re.compile(
    r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)""", re.IGNORECASE)

# javascript: URL 判定前に除去する文字（空白と C0 制御文字）。
# ブラウザは `java\tscript:` や改行・CR 混じりの scheme も実行するため、
# スペースのみの除去では検出を迂回できてしまう。
URL_IGNORABLE = re.compile(r"[\s\x00-\x1f]+")

# URL / リソース参照を運びうる既知属性の拒否リスト（fail-closed 設計）。
# src / href / xlink:href はタグ横断の許可リスト検査（handle_starttag）で個別検査、
# style / id / class 等は非 URL。それ以外で URL を運べる既知属性は、値のパース差異
# （srcset のカンマ区切り、<a ping> の空白区切り複数 URL 等）で許可リスト検査を
# すり抜けやすく、renderer も一切生成しないため、値を見ず「属性の存在自体」を
# 不合格にする。action は form タグ自体が禁止で他タグでは不活性だが、
# renderer が生成しない URL 運搬属性として同様に存在自体を閉じる。
# blocklist 的な個別対応ではなく、URL 運搬経路をまとめて閉じるための一覧。
URL_CARRYING_ATTRS = frozenset({
    "formaction", "ping", "poster", "cite", "background", "manifest",
    "longdesc", "srcset", "imagesrcset", "srcdoc", "data", "codebase",
    "archive", "usemap", "profile", "dynsrc", "lowsrc", "xml:base",
    "action",
})

# src 属性を（許可画像 MIME の data: URI に限り）持ってよい受動メディアタグ。
# これ以外のタグの src は値を問わず存在自体を不合格にする（タグ列挙の検査では
# <input type="image" src> / <frame src> 等の未列挙タグが fail-open になるため、
# 「src を持てるタグ」側を列挙する許可リスト方式で閉じる）。
PASSIVE_MEDIA_TAGS = ("img", "source", "track", "audio", "video")

# 存在自体を不合格にする能動コンテンツ / ナビゲーション制御タグ。
# link / iframe / object / embed / script src は従来どおり。加えて
# base は文書内の相対 URL 解決基準の書き換え、form は submit 時の外部送信、
# SVG feImage は filter 経由の外部画像読込の入口になるため、値を問わず禁止する
# （html.parser はタグ名を小文字化するため feimage で照合する）。
BANNED_TAGS = ("link", "iframe", "object", "embed", "base", "form", "feimage")

# SVG の presentation 属性のうち url(...)（FuncIRI）でペイントサーバー・
# フィルタ・カーソル画像等の外部リソースを参照できるもの。style 属性を
# 経由しない読込経路のため、値に url( を含む場合は CSS と同じ許可リスト
# （画像 data: と #fragment、css_bad_urls）で検査する。renderer が生成する
# のは色リテラルと var() 参照のみで url( は生成しない。
SVG_PAINT_ATTRS = frozenset({
    "fill", "stroke", "filter", "mask", "clip-path", "cursor",
    "marker", "marker-start", "marker-mid", "marker-end", "mask-image",
})

# SVG 内で href / xlink:href によるリソース・要素参照を持ちうるタグ。
# image / use に加え、SMIL 系（animate / set / animateMotion / mpath）の href も
# 外部 URL を指せる参照経路のため、同じ許可リスト（画像 data: と #fragment）で検査する。
SVG_REF_TAGS = ("image", "use", "animate", "set", "animatemotion", "mpath")

# CSS image-set() は url() 形式と裸文字列の双方で URL を運べ、パース差異で
# url() 許可リスト検査をすり抜けやすい。renderer は生成しないため出現自体を不合格にする。
CSS_IMAGE_SET = re.compile(r"(?:-webkit-)?image-set\s*\(", re.IGNORECASE)

# class="chart" を持たない SVG を検証対象へ引き戻すための子要素数しきい値。
# 凡例 swatch 等の装飾 SVG は数要素に収まるため、これ以上はデータ描画とみなす。
SEMANTIC_SVG_MIN_ELEMS = 6


def css_unescape(css_text):
    """CSS escape を Unicode へ展開し、検査用に正規化したテキストを返す。

    hex escape（1〜6 桁 + 任意の継続空白 1 文字）と単文字 escape の両方を展開する。
    コードポイント範囲外は U+FFFD へ倒す（CSS 仕様と同じ fail 方向）。
    @import / url() 検査は必ず本関数の出力に対して行うこと。
    """
    # CSS 仕様の入力前処理（CRLF / CR / FF → LF 正規化）を escape 展開より先に行う。
    # hex escape の継続空白は「1 文字」しか消費しないため、正規化なしでは
    # `\69` + CRLF で CR のみ消費されて `@i\nmport` となり @import 検査をすり抜ける
    # （ブラウザは正規化後の LF 1 文字を消費して @import として解釈する）。
    css_text = css_text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n")

    def repl(m):
        if m.group(1) is not None:
            try:
                return chr(int(m.group(1), 16))
            except (ValueError, OverflowError):
                return "�"
        return m.group(2)
    return CSS_ESCAPE.sub(repl, css_text)


def bundled_js():
    """renderer が注入する唯一の許可 inline JS（INTERACTIVE_JS）を返す。

    validate との比較の一次ソースとして render_report.py から import する
    （同一ディレクトリ配置が前提）。import に失敗した場合は None を返し、
    呼び出し側は「script は一切不許可」として扱う（fail-closed）。
    """
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from render_report import INTERACTIVE_JS
        return INTERACTIVE_JS
    except Exception:
        return None


def css_bad_urls(css_text):
    """CSS 中の url(...) から自己完結契約に違反する参照を抽出する。

    許可は画像 MIME allowlist（DATA_URI_ALLOWED）に一致する data: URI と
    文書内 #fragment（SVG gradient / filter 参照等）のみ。
    url(data:text/css,...) は @import 検査の迂回になるため不合格。
    url(image.png) / url(../fonts/a.woff2) のような相対 URL も配布先で
    欠落・意図しないリクエストの原因になるため、http(s) / // と同様に不合格。
    image-set() は裸文字列でも URL を運べるため出現自体を不合格にする。
    """
    css_text = css_unescape(css_text)
    bad = []
    if CSS_IMAGE_SET.search(css_text):
        bad.append("image-set(（出現自体を不許可）")
    n_matched = 0
    for m in CSS_URL.finditer(css_text):
        n_matched += 1
        v = next((g for g in m.groups() if g is not None), "").strip()
        if not (DATA_URI_ALLOWED.match(v) or FRAGMENT_URL.match(v)):
            bad.append(f"url({v!r})")
    # フォールバック: CSS_URL で抽出できなかった url( は解析不能として不合格にする
    # （regex にマッチしない書式で許可リスト検査をすり抜ける取りこぼしを塞ぐ）
    n_total = len(re.findall(r"url\(", css_text, re.IGNORECASE))
    if n_total > n_matched:
        bad.append(f"解析不能な url( が {n_total - n_matched} 件")
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

    RCDATA_CONTENT_ELEMENTS（Python 3.12 で追加された、title / textarea を
    どこに現れても無条件で RCDATA 扱いする class 変数）を、SVG 内かどうかで
    切り替える property として上書きする。ブラウザの挙動は文脈で分かれる:

    - SVG 配下（foreign-content）の title/textarea: HTML5 tree builder の
      仕様上 RCDATA へ切り替えず通常の子要素として解釈し、ネストした
      <style>/<script> を実際に適用・実行する。html.parser 3.12+ の
      RCDATA_CONTENT_ELEMENTS はこの namespace を知らず、ここでも RCDATA
      扱いしてバッファに畳み込むため、CSS/script 検査（styles / scripts
      への収集）から露出しない fail-open が生じていた（Issue #221、
      Python 3.12.12 で実測）。→ SVG 内では RCDATA を無効化して通常要素
      として解析し、ネストした要素を検査に露出させる。
    - 非 SVG（通常 HTML）の title/textarea: ブラウザは実際に RCDATA として
      扱い、開始タグが閉じた後の内容はタグとして解釈せず、リテラルな
      終了タグ文字列（`</title` 等）が現れるまでそのままテキストとして
      表示する。ここで RCDATA を無効化すると、python は逆に「通常の子要素
      解析」に切り替わってしまい、ブラウザには存在しない `<style>` 要素を
      誤って検出（過剰拒否）する一方で、title/textarea の子孫要素の
      「属性値」に含まれる literal `</title>` でブラウザ側が RCDATA を
      早期終了させ、後続の実在タグ（`<style>@import ...` 等）を適用・実行
      するケース（例: `<title><i data-x="</title><style>@import
      url(https://evil.example/x.css)</style>"></i></title>`）を python は
      `<i>` 要素の属性値としてまるごと飲み込んでしまい検査から漏らす
      （Bugbot 指摘、PR #227）。→ 非 SVG では RCDATA を有効なままにし、
      html.parser のリテラル終了タグ探索（`</`+空白+`title` 相当）でブラウザと
      同じ位置で cdata を終端させる。

    この文脈依存判定は「現在のタグスタックに svg 祖先が含まれるか」で行う
    （下記 RCDATA_CONTENT_ELEMENTS property 内の判定式）。html.parser の
    RCDATA 判定は handle_starttag 呼び出し直後（このタグ自身が _stack に push された後）
    に行われるため、判定時点の _stack を見れば「このタグの祖先に svg が
    あるか」を正しく判定できる（このタグ自身は title/textarea であり
    svg ではないため誤判定なし）。_svg_stack（開いている <svg> の入れ子
    スタック）ではなく _stack 全体を走査するのは、RCDATA 判定が
    handle_starttag 直後の呼び出しタイミングに依存し、タグスタックの方が
    判定時点の祖先関係を直接表すため（svg の追跡自体も入れ子対応の
    スタック管理であり、内側の </svg> 後も外側の追跡を維持する）。

    さらに、RCDATA_CONTENT_ELEMENTS 自体は Python 3.12+ にしか存在せず
    3.11 以前ではこの property は no-op になる。バージョン非依存の防御として、
    handle_starttag で全属性の生の値に `</title` / `</textarea`
    （大小文字問わず）が含まれる場合は、実際にそのタグが RCDATA 内か
    どうかに関わらず存在自体を不合格にする（renderer はこの文字列パターンを
    生成しないため誤検知の実害はない）。
    """

    @property
    def RCDATA_CONTENT_ELEMENTS(self):
        # SVG 祖先内では RCDATA を無効化（空タプル）、それ以外では 3.12+ の既定
        # ("textarea", "title") のままブラウザの RCDATA 挙動に追従する。
        # __init__ で super().__init__() が _stack より先に走るため、
        # 生成直後の内部呼び出しに備えて getattr で安全に参照する。
        if any(t == "svg" for t, _ in getattr(self, "_stack", ())):
            return ()
        return ("textarea", "title")

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
        self.unterminated_rawtext = None  # EOF 時に未終端だった rawtext 要素名（close で設定）
        self.meta_charset = False
        self.meta_viewport = False
        self._stack = []            # (tag, classes) の祖先スタック
        self._in = None             # "script" | "style" | "title" | "svg-title" | "svg-desc"
        self._buf = ""
        self._svg_stack = []        # 開いている <svg> の入れ子スタック（末尾が現在の svg）
        self._cur_table = None

    # -- 補助 ---------------------------------------------------------------

    def _has_ancestor_class(self, cls):
        return any(cls in classes for _, classes in self._stack)

    # -- HTMLParser hooks ---------------------------------------------------

    def handle_decl(self, decl):
        if decl.lower().startswith("doctype"):
            self.has_doctype = True

    def handle_startendtag(self, tag, attrs):
        # RAWTEXT / RCDATA 要素（style / script / title）の自己終了タグ形式は
        # 存在自体を不合格にする。html.parser は <style/> を「開始 + 即終了」と
        # 解釈して内容バッファが空になるが、実ブラウザは HTML5 パース仕様上
        # self-closing フラグを無視し </style> までの全テキストを CSS として
        # 解釈・実行する。この解析差により <style/>@import url(...)</style> が
        # CSS 検査（@import / url() 許可リスト）に一切載らない fail-open が
        # 成立するため、renderer が生成しないこの構文自体を禁止する
        # （script は check #6 の完全一致ゲートでも落ちるが、意図した防御と
        # して明示的に閉じる）。
        #
        # 評価（Issue #221）: top-level の self-closing 形式（<textarea/> 等）
        # 自体は html.parser が startendtag として処理し RCDATA モードへ
        # 入らないため、後続の <style>/<script> は通常タグとして既存の
        # CSS/script 検査に露出する（この経路に迂回はない）。SVG foreign-content
        # 内の <title>/<textarea> ネストは RCDATA_CONTENT_ELEMENTS の
        # 文脈依存 property（クラス docstring 参照）で塞いだ。属性値に
        # literal `</title` 等を仕込む exit-point 差（PR #227, Bugbot 指摘）は
        # handle_starttag 側のバージョン非依存ガード（同 docstring 参照）で
        # 別途塞いでいる。
        if tag in ("style", "script", "title"):
            self.external_refs.append(
                f"<{tag}/>（RAWTEXT/RCDATA 要素の自己終了形式はブラウザとの"
                "解析差による検査迂回のため禁止）")
        # 既定実装と同じく開始 + 終了として処理し、状態機械の整合を保つ
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_starttag(self, tag, attrs):
        # RCDATA exit-point 差のバージョン非依存ガード（クラス docstring 参照、
        # PR #227 Bugbot 指摘）。RCDATA_CONTENT_ELEMENTS property は Python
        # 3.12+ にしか存在せず、3.11 以前では常に no-op（title/textarea が
        # RCDATA 化されないため html.parser 標準の通常要素解析のみ）。
        # non-SVG の title/textarea を RCDATA のまま維持するバージョンでも、
        # その子孫要素の属性値に literal `</title` / `</textarea` を仕込むと、
        # ブラウザの RCDATA スキャンはクォート文脈を無視してその位置で
        # title/textarea を終了し、後続の実在タグ（<style>/<script> 等）を
        # 通常要素として適用・実行する。html.parser はこの属性値を最初から
        # 「まだ閉じていないタグの属性」として quote 文脈込みで解析するため
        # 位置がずれず、後続タグが丸ごと属性値に飲み込まれて検査から漏れる。
        # 重複排除前の raw attrs を見るのは、dict 畳み込み後の属性のみ
        # チェックすると同名属性の 2 個目以降（ブラウザは無視するが検査は
        # 生バイト列全体を見る必要がある）に紛れ込ませて迂回されるため。
        for _, av in attrs:
            low = (av or "").lower()
            if "</title" in low or "</textarea" in low:
                self.external_refs.append(
                    f"<{tag}>（属性値に RCDATA 終了タグ文字列を含む記述は"
                    "ブラウザとの解析差による検査迂回のため禁止）")
                break

        # 重複属性は先勝ちで畳み込む（HTML5 仕様・ブラウザ挙動と一致させる）。
        # html.parser は重複属性を除去せず list のまま返すため、dict(attrs) の
        # 後勝ちだと <a href="javascript:..." href="https://ok/"> のような重複で
        # ブラウザが実際に使う 1 個目の値が検査から漏れて迂回できてしまう。
        ad = {}
        for k, v in attrs:
            ad.setdefault(k, v)
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
        # action は URL_CARRYING_ATTRS の存在拒否でも不合格になるが、
        # javascript: の検出報告を別枠で残す防御多層として重複判定を維持する。
        for key in ("href", "src", "action", "xlink:href"):
            v = ad.get(key) or ""
            if URL_IGNORABLE.sub("", v.lower()).startswith("javascript:"):
                self.bad_js_urls.append(f"<{tag} {key}>")

        # リソース読み込みの検査（自己完結契約・fail-closed 設計）。
        # 検査は「タグ拒否 → URL 運搬属性拒否 → 個別許可リスト」の 3 層で閉じる:
        # 1) 能動コンテンツ / ナビゲーション制御タグ（BANNED_TAGS、属性付き script、
        #    meta http-equiv=refresh）は、data: URI や srcdoc 等の属性経由でも
        #    inline 検査（network API・@import・url() 許可リスト）を迂回できる
        #    ため、属性値を見ずタグの存在自体を一律不合格にする。
        # 2) URL を運びうる既知属性（URL_CARRYING_ATTRS: formaction / ping /
        #    poster / srcset / action 等）は、タグ横断で個別検査する src /
        #    href / xlink:href 以外の運搬経路をまとめて塞ぐため、存在自体を
        #    不合格にする。
        # 3) src / href / xlink:href はタグ横断の許可リスト方式:
        #    - src: 受動メディア（PASSIVE_MEDIA_TAGS）で DATA_URI_ALLOWED の
        #      画像 MIME data: のみ許可。それ以外のタグは存在自体を不合格
        #      （<input type="image" src> / <frame src> 等の fail-open を塞ぐ）。
        #    - href / xlink:href: SVG 参照タグ（SVG_REF_TAGS）は data: 画像と
        #      文書内 #fragment、その他のタグは #fragment のみ許可
        #      （SVG gradient / textPath 等の href="#id" テンプレート参照は維持）。
        # 出典 <a href> は対象外 = 唯一の許可経路（check #9 で https / #fragment に制限）。
        # <script> は属性が 1 つでも付いていたら無条件不合格にする（fail-closed）。
        # src の列挙判定だけでは SVG 2 の <script href> / xlink:href が漏れ、
        # INTERACTIVE_JS と同一の本文を併記すれば完全一致ゲート（check #6）も
        # 通過して外部 JS をロード・実行できてしまう。renderer が生成するのは
        # 「属性なしの <script>」のみのため、src / href / type 等を列挙せず
        # 属性の有無だけで一律に拒否する。
        if tag == "script" and ad:
            self.external_refs.append(
                f"<script {' '.join(sorted(ad))}>（属性付き script は一律禁止）")
        if tag in BANNED_TAGS:
            self.external_refs.append(f"<{tag}> タグ（存在自体を禁止）")
        # meta http-equiv="refresh" は content 属性の URL でリダイレクトでき、
        # href / src 系の検査経路を通らないため refresh のみ存在自体を禁止する
        # （charset / viewport / name 系 meta は従来どおり許可）。
        if tag == "meta" and (ad.get("http-equiv") or "").strip().lower() == "refresh":
            self.external_refs.append('<meta http-equiv="refresh">（存在自体を禁止）')
        for key in ad:
            if key in URL_CARRYING_ATTRS:
                self.external_refs.append(f"<{tag} {key}>（属性の存在自体を禁止）")
        if tag in PASSIVE_MEDIA_TAGS:
            if "src" in ad and not DATA_URI_ALLOWED.match(ad.get("src") or ""):
                self.external_refs.append(f"<{tag} src={ad['src']!r}>")
        elif tag != "script" and "src" in ad:
            # script の src は上の属性付き script 一律拒否で報告済み。
            # それ以外の未列挙タグ（input / frame / portal 等）の src は
            # 値を問わず存在自体を不合格にする（fail-closed）。
            self.external_refs.append(
                f"<{tag} src>（受動メディア以外の src は存在自体を禁止）")
        if tag in SVG_REF_TAGS:  # SVG 内のリソース・要素参照（SMIL 含む）
            for key in ("href", "xlink:href"):
                v = ad.get(key) or ""
                if key in ad and not (DATA_URI_ALLOWED.match(v) or FRAGMENT_URL.match(v)):
                    self.external_refs.append(f"<{tag} {key}={ad[key]!r}>")
        elif tag not in ("a", "script"):
            # <a href> は check #9（https / #fragment）、属性付き script は
            # 一律拒否で検査済み。それ以外のタグの href / xlink:href は
            # 文書内 #fragment 参照（SVG gradient / textPath 等）のみ許可する。
            for key in ("href", "xlink:href"):
                v = ad.get(key) or ""
                if key in ad and not FRAGMENT_URL.match(v):
                    self.external_refs.append(
                        f"<{tag} {key}={ad[key]!r}>（#fragment 以外は禁止）")
        # style 属性内の CSS も <style> ブロックと同じ許可リストで検査する
        # （escape 難読化を塞ぐため、@import 検査は css_unescape 後に行う）
        sv = ad.get("style") or ""
        if "style" in ad and (CSS_IMPORT.search(css_unescape(sv)) or css_bad_urls(sv)):
            self.style_attr_external.append(f"<{tag} style=...>")
        # SVG presentation 属性（fill / filter / mask / cursor 等）は style を
        # 経由せず url(...) で外部リソースを参照できるため、値に url( を含む
        # 場合は CSS と同じ許可リスト（css_bad_urls）で検査する。色リテラル・
        # var() 参照は url( を含まないため素通しになる（renderer 生成物と整合）。
        for key in SVG_PAINT_ATTRS.intersection(ad):
            v = ad.get(key) or ""
            if "url(" in css_unescape(v).lower() and css_bad_urls(v):
                self.external_refs.append(f"<{tag} {key}={v!r}>")

        # <a> は href に加えて SVG の legacy 属性 xlink:href でもリンク先を
        # 指定できる。どちらも check #9（https / #fragment のみ）の対象に
        # 収集する（xlink:href を collect しないと SVG <a xlink:href> が
        # どの検査経路にも載らない fail-open になる）。
        if tag == "a":
            for key in ("href", "xlink:href"):
                if ad.get(key):
                    self.anchor_hrefs.append(ad[key])

        if tag == "meta":
            if "charset" in ad:
                self.meta_charset = True
            if ad.get("name", "").lower() == "viewport":
                self.meta_viewport = True

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.headings.append(int(tag[1]))

        # SVG 内の子要素数を数える（is_chart_svg の「意味論的 SVG」判定材料）。
        # 入れ子 svg に備えてスタック管理し、内側の </svg> 後も外側の追跡を維持する
        # （単一値だと内側を閉じた時点で外側の elems 加算・title/desc 帰属が失われ、
        # accessible name 検査を要素数不足で迂回できる。codex P2 / Bugbot 指摘）
        if self._svg_stack and tag != "svg":
            self._svg_stack[-1]["elems"] += 1
        if tag == "svg":
            cur = {
                "attrs": ad,
                "in_chart_wrap": self._has_ancestor_class("chart-wrap"),
                "has_title": False,
                "has_desc": False,
                "classes": classes,
                "elems": 0,
                "label_ids": set(),  # この svg 直下階層の title/desc の id 集合
            }
            self._svg_stack.append(cur)
            self.svgs.append(cur)
        if tag == "title" and self._svg_stack:
            self._svg_stack[-1]["has_title"] = True
            if ad.get("id"):
                self._svg_stack[-1]["label_ids"].add(ad["id"])
        if tag == "desc" and self._svg_stack:
            self._svg_stack[-1]["has_desc"] = True
            if ad.get("id"):
                self._svg_stack[-1]["label_ids"].add(ad["id"])

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
        elif tag == "title" and not self._svg_stack:
            self._in, self._buf = "title", ""

        self._stack.append((tag, classes))

    def handle_endtag(self, tag):
        # 閉じタグに対応する開始タグまでスタックを巻き戻す（多少の不整合に耐える）。
        # 巻き戻しで svg / table の開始タグが除去される場合は追跡状態も同期して
        # 破棄する（_stack だけ巻き戻すと閉じ済み svg が _svg_stack に残り、後続の
        # title/desc が誤帰属して accessible name 検査を偽装できる。Bugbot 指摘）
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                removed = self._stack[i:]
                del self._stack[i:]
                for rtag, _ in removed:
                    if rtag == "svg" and self._svg_stack:
                        self._svg_stack.pop()
                    elif rtag == "table":
                        self._cur_table = None
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
        # svg / table の追跡破棄は上記の巻き戻し同期に一本化している（対応する
        # 開始タグが _stack に無い迷子の閉じタグでは何も pop しない。開いたままの
        # 外側 svg の追跡を誤破棄しない fail-safe）

    def handle_data(self, data):
        if self._in in ("script", "style", "title"):
            self._buf += data

    def close(self):
        # EOF 時に script/style/title が未終端のまま残っている場合の fail-closed 処理。
        # handle_endtag でしか _buf を scripts/styles へ移さないと、閉じタグを欠いた
        # `<script>fetch(...)` 等が全セキュリティ検査を素通りする（codex P0 指摘）。
        # 未終端バッファを対応する検査対象へ必ず移したうえで、未終端の事実自体も
        # unterminated_rawtext に記録し、run_checks 側で無条件に不合格へ倒す。
        super().close()
        if self._in in ("script", "style", "title"):
            self.unterminated_rawtext = self._in
            if self._in == "script":
                self.scripts.append(self._buf)
            elif self._in == "style":
                self.styles.append(self._buf)
            else:
                self.title_text = self._buf.strip()
            self._in = None


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

    # 1.5. rawtext 要素の未終端検査（fail-closed）。閉じタグのない script/style は
    # ブラウザ実装依存の解釈になり検査結果の信頼性が保てないため、内容の検査結果に
    # かかわらず無条件で不合格にする（codex P0: EOF 迂回の遮断）
    check("script/style/title が EOF まで正しく閉じている",
          parser.unterminated_rawtext is None,
          f"未終端の <{parser.unterminated_rawtext}> がある" if parser.unterminated_rawtext else "")

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
    check("リソース読み込みがない（link / iframe / object / embed / base / form / feImage / "
          "meta refresh はタグ自体・属性付き script・URL 運搬属性（formaction / ping / poster 等）は一律禁止、"
          "src / href はタグ横断検査で受動メディアの画像 data: と #fragment のみ許可）",
          not parser.external_refs, "; ".join(parser.external_refs[:5]))
    css_all = "\n".join(parser.styles)
    css_bad = css_bad_urls(css_all)
    # @import 検査は CSS escape 正規化後に行う（`@\69mport` 等の難読化対策）
    css_detail = (["@import"] if CSS_IMPORT.search(css_unescape(css_all)) else []) \
        + css_bad[:3] + parser.style_attr_external[:3]
    check("CSS に @import / image-set() / 不許可の url() がない（url() は画像 data: と #fragment のみ許可）",
          not css_detail, "; ".join(css_detail))

    # 6. inline <script> は renderer 注入の bundled JS（INTERACTIVE_JS）との
    #    完全一致のみ許容する fail-closed ゲート（主防御）。
    #    正規表現の文字列検査は window['fetch'] / createElement('script') 等の
    #    難読化を見逃すため、許可 script を renderer 生成物 1 種に限定する。
    #    render_report.py の import に失敗した場合は「script 一切不許可」へ倒す。
    allowed = bundled_js()
    allowed_set = {allowed.strip()} if allowed is not None else set()
    bad_scripts = [f"script#{i + 1}" for i, s in enumerate(parser.scripts)
                   if s.strip() not in allowed_set]
    check("inline <script> が renderer 生成の bundled JS と完全一致"
          "（renderer 生成以外の script は許可されない）",
          not bad_scripts, "; ".join(bad_scripts[:3]))

    # 6b. network API 不使用（完全一致ゲートの防御多層）
    js_all = "\n".join(parser.scripts)
    m = NETWORK_API.search(js_all)
    check("inline JS が network API を使わない", m is None, m.group(0) if m else "")

    # 7. inline event handler なし
    check("inline event handler（on* 属性）がない",
          not parser.bad_handlers, "; ".join(parser.bad_handlers[:5]))

    # 8. javascript: URL なし
    check("javascript: URL がない", not parser.bad_js_urls, "; ".join(parser.bad_js_urls[:5]))

    # 9. <a href> は https / ページ内 fragment のみ（出典リンクと外部依存の区別。
    #    SVG の <a xlink:href> も同じ収集経路（anchor_hrefs）でここへ載る）
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
            # aria-labelledby は空でないだけでなく、全トークンが同一 SVG 内の
            # title/desc の実在 id を参照していることまで検証する（存在しない
            # ID の参照は accessible name 不成立。codex P2 指摘）
            # 値なし属性（<svg aria-labelledby>）は html.parser が None を返すため
            # or "" で正規化する（None.split() のクラッシュ防止。Bugbot 指摘）
            labelledby = a.get("aria-labelledby") or ""
            tokens = labelledby.split()
            ok = (a.get("role") == "img" and bool(tokens)
                  and s["has_title"] and s["has_desc"]
                  and all(t in s["label_ids"] for t in tokens))
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

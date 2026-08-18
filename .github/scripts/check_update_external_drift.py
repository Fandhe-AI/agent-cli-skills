#!/usr/bin/env python3
"""Fandhe-AI 配下リポジトリの ``update-external.yml`` 乖離検知。

このスクリプトの役割
--------------------
下流リポジトリの ``.github/workflows/update-external.yml`` が、上流 reusable
workflow（``Fandhe-AI/actions/.github/workflows/update-external.yml``）の薄い
wrapper として健全に保たれているか、かつその定期実行自体が生きているかを
5 つの軸で実測し、Markdown レポートを返す。
``.github/workflows/update-external-drift.yml`` から日次で呼ばれる。

なぜ「マーカーの grep」ではなく 5 軸なのか（イシュー #260 / #261 / #304）
------------------------------------------------------------------
#260 の当初案は ``persist-credentials`` / ``source-token`` /
``auto-merge-immediate-fallback`` / ``skills-version`` / ``node-version`` /
pin SHA を**各下流ファイルから**抽出する設計だった。#261 で下流 19 リポが
上流 reusable workflow の薄い wrapper へ移行した結果、これらの設定は下流
ファイルにもう存在せず上流が集中管理する。旧マーカーのまま検査すると全リポが
「全項目未適合」に誤判定される。

そこで旧マーカーの**意図**（強化設定が劣化していないこと）は軸 4 として上流
1 ファイルの検査へ畳み、下流側は「wrapper であること」「pin が新しいこと」
「vendor しているのに CI が無い状態でないこと」を見る 3 軸へ再定義した。

#304 では、ファイル内容が正しくても GitHub が「一定期間リポジトリ活動が無い」
scheduled workflow を自動無効化する（``disabled_inactivity``）ことが判明した。
軸 1-4 はファイル内容しか見ないためこの停止を検出できず、無告知で同期が
止まる。軸 5 はこの穴を埋める。

  軸 1  wrapper か否か          … 手管理ファイルへの逆戻り（LEGACY）を検知
  軸 2  pin の鮮度              … 上流を強化しても pin が古いと届かない
  軸 3  同期 CI の欠落          … skills を vendor しているのに workflow が無い
  軸 4  上流 reusable の劣化    … 旧マーカーの意図。18 リポ分の grep が 1 ファイルへ
                                （#302 でマーカーを 1 件追加。上流内の全 uses が
                                 SHA 固定か＝可動参照への退行検知。鮮度は対象外）
  軸 5  定期実行の生存          … ファイルは正しいのに schedule が無告知停止した状態を検知

設計上の約束
------------
- **fail-closed。** 「乖離 0 件」と「検査できなかった」を絶対に混同しない。
  リポ列挙・上流 SHA 解決・上流ファイル取得の失敗はスキャン全体の失敗
  （終了コード 1）。個別リポの取得失敗は ``UNKNOWN`` として集計に残し、
  黙って除外しない。
- **純粋関数と I/O の分離。** 判定ロジック（``classify_workflow`` /
  ``evaluate_pin`` / ``check_upstream_markers`` / ``evaluate_schedule``）は
  GitHub API に触れない純粋関数として切り出し、
  ``test_check_update_external_drift.py`` が fixture に対して直接実行できる
  ようにしてある。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

import yaml

# ---------------------------------------------------------------------------
# 除外設定（なぜ除外なのかを issue 番号付きで明示する）
# ---------------------------------------------------------------------------

# リポ名による除外は現在 0 件。
#
# ここへ追加してよいのは「スコープ外」という**運用判断**だけであり、「そもそも wrapper では
# ない」という構造的事実はハードコードに頼らず下の workflow_call 自動判定で扱う。
#
# **未解決 issue を根拠に追加してはならない。** issue が閉じても除外は残り続け、当該リポの
# 乖離を恒久的に検知できなくなる（実例: `yadori` はイシュー #263 を根拠に除外していたが、
# #263 は close 済みで yadori は PR Fandhe-AI/yadori#665 により wrapper へ移行済みだった。
# 除外を解除するまで検知対象外のままだった)。除外が必要な場合は archived・reusable 定義本体の
# ような**観測可能で恒久的な条件**を使い、可能ならリポ名ではなく構造条件で判定する。
EXCLUDED_REPOS: dict[str, str] = {}

# ``Fandhe-AI/actions`` の ``update-external.yml`` は reusable 定義本体であり
# wrapper ではない。除外はリポ名だけに頼らず、``UPSTREAM_REPO`` であることと
# ``on: workflow_call`` を持つことの **AND** で判定する（``classify_workflow``）。
# 構造条件だけにすると下流が ``workflow_call`` を足すだけで検査を逃れられ、
# リポ名だけにすると構造的な根拠が無くなるため。
# （軸 4 は別途この定義本体そのものを検査対象にしている。）

# 下流 wrapper が参照すべき上流 reusable workflow。
UPSTREAM_REPO = "Fandhe-AI/actions"
UPSTREAM_WORKFLOW_PATH = ".github/workflows/update-external.yml"
WORKFLOW_PATH = ".github/workflows/update-external.yml"

# Actions API（``actions/workflows/{workflow_id}``）に渡すファイル名。上の
# ``WORKFLOW_PATH`` はリポジトリ内の相対パス（contents API 用）だが、Actions API
# の ``workflow_id`` パラメータは workflow の数値 ID か**ワークフローファイルの
# ベース名**のみを受け付ける仕様であり（GitHub REST 仕様上、任意のディレクトリを
# 含む相対パスは保証されていない）、`.github/workflows/` 配下という前提のため
# 両者は現状同じ文字列になる。コメント上の混同を避けるため意味の異なる用途ごとに
# 定数を分けてある。
WORKFLOW_FILENAME = "update-external.yml"

# リポジトリ名を GitHub API のパス（contents API・Actions API 双方）へ埋め込む
# 前の検証（OWASP A03）。``gh repo list`` 由来で通常は安全な文字列のみだが、
# 想定外の文字が来た場合に別エンドポイントへ化けないよう構造的に保証する。
# scan() 内で ``result.scanned += 1`` より前に置いてあるため、軸 5 専用ではなく
# 軸 1-4（contents API によるファイル取得）もまとめて保護している。
_REPO_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# レポートを集約する固定タイトルの issue。日次で新規 issue を作らず、
# 常にこの 1 件を更新する。
REPORT_ISSUE_TITLE = "chore(ci): update-external の乖離検知レポート"

# ``gh repo list`` の取得上限。到達したら打ち切られた可能性があるため
# fail-closed で止める（``list_target_repos``）。2026-08-17 時点の実測は 119 件。
REPO_LIST_LIMIT = 500

# 下流 wrapper の job-level ``uses`` が指すべき参照先（``@<ref>`` を除いた部分）。
REUSABLE_WORKFLOW_REF = f"{UPSTREAM_REPO}/{UPSTREAM_WORKFLOW_PATH}"

_SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")

# 軸 4 でジョブを同定するための composite action 接頭辞。
# **ジョブ名（jobs.skills / jobs.submodule）では引かない。** ジョブ名は
# リネーム可能な表層であり、この軸の主張は「構造的に skills ジョブを特定して
# その checkout を見ている」ことにあるため、実際に呼ぶ action で同定する。
# **前方一致では同定しない。** startswith だと
# `Fandhe-AI/actions/skills-update-malicious@main` や `actions/checkout-wrapper@main`
# のような別 action まで正規 action として認識してしまう。`@` より前のパスを
# 完全一致で比較する（`_uses_action`）。
SKILLS_ACTION = "Fandhe-AI/actions/skills-update"
SUBMODULE_ACTION = "Fandhe-AI/actions/submodule-update"
CHECKOUT_ACTION = "actions/checkout"
SETUP_NODE_ACTION = "actions/setup-node"


def _uses_action(value: object, action_path: str) -> bool:
    """``uses`` の値が指定 action（``@ref`` を除いたパス）と完全一致するか。"""
    text = norm(value)
    if not text:
        return False
    return text.split("@", 1)[0] == action_path


# ---------------------------------------------------------------------------
# YAML 正規化ヘルパ
# ---------------------------------------------------------------------------


def norm(value: object) -> str:
    """YAML の値を比較用の文字列へ正規化する。

    PyYAML は ``persist-credentials: false``（引用符なし）を Python の ``False``
    へ、``auto-merge-immediate-fallback: 'false'``（引用符あり）を文字列
    ``"false"`` へ落とす。同様に ``node-version: 20`` は ``int`` の ``20`` になる。
    どちらか一方の型だけを前提に ``== "false"`` や ``is False`` で比較すると、
    書き方の違いだけで判定が反転するため、比較の直前に必ずここを通す。
    ``${{ ... }}`` 式はそのまま文字列として残る。
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip()


def workflow_on(spec: dict) -> object:
    """workflow の ``on:`` セクションを取り出す。

    YAML 1.1 では裸の ``on`` が真偽値として解釈されるため、PyYAML は
    ``on:`` キーを Python の ``True`` として格納する（本リポの ``.yamllint`` が
    ``truthy: check-keys: false`` を置いているのも同じ事情）。``spec["on"]``
    だけを見ると reusable 定義本体の ``workflow_call`` を取りこぼし、定義本体が
    LEGACY として乖離報告される——という静かな誤報につながるため、
    両方のキーを見る。
    """
    if "on" in spec:
        return spec["on"]
    return spec.get(True)


def has_workflow_call(spec: dict) -> bool:
    """``on: workflow_call`` を持つ（= reusable 定義本体である）かを判定する。"""
    on = workflow_on(spec)
    if isinstance(on, dict):
        return "workflow_call" in on
    if isinstance(on, list):
        return "workflow_call" in on
    return on == "workflow_call"


def has_schedule_trigger(spec: dict) -> bool:
    """``on:`` に ``schedule`` トリガを持つかを判定する（軸 5 の対象判定）。

    ``workflow_dispatch`` のみの wrapper は軸 5 の対象外（構造的に schedule が
    無いので「定期実行の生存」を問うこと自体が無意味）。``workflow_on`` を経由
    することで、裸の ``on`` が PyYAML により ``True`` キーへ落ちるケース
    （軸 1 の ``has_workflow_call`` と同じ事情）も取りこぼさない。
    """
    on = workflow_on(spec)
    if isinstance(on, dict):
        return "schedule" in on
    if isinstance(on, list):
        return "schedule" in on
    return on == "schedule"


# ---------------------------------------------------------------------------
# 軸 1: wrapper か否かの分類（純粋関数）
# ---------------------------------------------------------------------------

# 分類の種別。``excluded`` が真のものは乖離として数えない。
KIND_REUSABLE_DEFINITION = "REUSABLE-DEFINITION"
KIND_WRAPPER = "WRAPPER"
KIND_WRAPPER_UNPINNED = "WRAPPER-UNPINNED"
KIND_LEGACY = "LEGACY"
KIND_UNPARSEABLE = "UNPARSEABLE"


def _split_job_uses(value: object) -> str | None:
    """job-level ``uses`` が上流 reusable workflow を指していれば ref を返す。

    ``uses: <owner>/<repo>/<path>@<ref>`` を ``@`` の**最後**の出現で割る
    （path 側に ``@`` は現れないが ref 側にも現れないため右端割りが安全）。
    行末の ``# main`` 等のコメントは PyYAML が既に除去している。
    """
    text = norm(value)
    if "@" not in text:
        return None
    path, _, ref = text.rpartition("@")
    if path != REUSABLE_WORKFLOW_REF:
        return None
    return ref.strip()


def classify_workflow(text: str, is_upstream: bool = False) -> dict:
    """``update-external.yml`` の本文を分類する。

    戻り値は ``{"kind", "pin", "reason"}``。``kind`` は上の ``KIND_*``。

    ``is_upstream`` は「このリポジトリが reusable 定義を提供する上流本体
    （``UPSTREAM_REPO``）か」。定義本体は自分自身への ``uses:`` を持たないため、
    素直に判定すると LEGACY へ落ちて乖離として誤報される。

    除外条件は **``is_upstream`` と ``workflow_call`` の AND** にしてある。
    ``workflow_call`` 単独を除外条件にすると、下流リポジトリが
    ``update-external.yml`` に ``workflow_call`` を足しただけで検査対象から
    消え、wrapper を参照していなくても LEGACY にならない（全下流を wrapper
    として監視するという契約に対する偽陰性）。逆にリポ名だけを条件にすると
    構造的な根拠がなくなる。両方を要求すれば、上流が移設されたときは
    ``UPSTREAM_REPO`` の更新だけで追随でき、下流の偽陰性も生まれない。
    """
    try:
        spec = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        # パースできない = 検査不能。green には倒さない。
        return {
            "kind": KIND_UNPARSEABLE, "pin": None,
            "reason": f"YAML パース失敗: {exc}", "has_schedule": False,
        }

    if not isinstance(spec, dict):
        return {
            "kind": KIND_UNPARSEABLE, "pin": None,
            "reason": "YAML マッピングではない", "has_schedule": False,
        }

    # 軸 5 の対象判定はここで一度だけ行い、以降の全ての return に含める。
    # kind 分岐（LEGACY / WRAPPER / REUSABLE-DEFINITION 等）と独立した情報
    # だが、呼び出し側（scan）が「kind による早期 continue の前に軸 5 を
    # 判定する」契約を守れるよう、戻り値のスキーマを揃えておく。
    has_schedule = has_schedule_trigger(spec)

    if is_upstream and has_workflow_call(spec):
        return {
            "kind": KIND_REUSABLE_DEFINITION,
            "pin": None,
            "reason": f"{UPSTREAM_REPO} の on: workflow_call を持つ reusable 定義本体"
            "のため検査対象外",
            "has_schedule": has_schedule,
        }

    jobs = spec.get("jobs")
    if not isinstance(jobs, dict):
        return {
            "kind": KIND_UNPARSEABLE, "pin": None,
            "reason": "jobs セクションが無い", "has_schedule": has_schedule,
        }

    # **YAML 原文への正規表現ではなくパース済みの jobs.<job>.uses を見る。**
    # 原文 grep だと、コメントアウトされた `uses:` 行や導入手順を貼っただけの
    # コメントブロックにマッチして手管理 workflow が WRAPPER と誤認される。
    # その SHA がたまたま最新なら wrappers_ok に入り、軸 1 の LEGACY 検知を
    # まるごと迂回してしまう。reusable workflow の正しい呼び出し位置は
    # job-level の `uses` だけなので、そこだけを見る。
    ref: str | None = None
    for job in jobs.values():
        if not isinstance(job, dict):
            continue
        path_ref = _split_job_uses(job.get("uses"))
        if path_ref is not None:
            ref = path_ref
            break

    if ref is None:
        return {
            "kind": KIND_LEGACY,
            "pin": None,
            "reason": "上流 reusable workflow を job-level の uses で参照していない"
            "（手管理テンプレートのまま）",
            "has_schedule": has_schedule,
        }


    if not _SHA40_RE.match(ref):
        # reusable は参照しているが ref が 40 桁 hex ではない（``@main`` 等）。
        # LEGACY とは原因も直し方も違うので別種別として報告する。
        return {
            "kind": KIND_WRAPPER_UNPINNED,
            "pin": ref,
            "reason": f"reusable への参照が SHA 固定されていない（@{ref}）",
            "has_schedule": has_schedule,
        }

    return {"kind": KIND_WRAPPER, "pin": ref, "reason": "", "has_schedule": has_schedule}


# ---------------------------------------------------------------------------
# 軸 2: pin の鮮度（純粋関数）
# ---------------------------------------------------------------------------

PIN_CURRENT = "current"
PIN_BEHIND = "behind"
PIN_UNREACHABLE = "unreachable"
PIN_ANOMALY = "anomaly"


def evaluate_pin(pin: str, upstream_sha: str, compare: dict | None) -> dict:
    """wrapper の pin SHA が上流 main に対してどの位置にあるかを判定する。

    ``compare`` は ``GET /repos/{o}/{r}/compare/{pin}...main`` の結果
    （``{"status", "ahead_by", "behind_by"}``）。SHA が解決できず 404 になった
    場合は ``None`` を渡す。

    **``ahead_by`` の向きに注意。** compare は ``base...head`` で head が base より
    何コミット先行しているかを ``ahead_by`` に入れる。ここでは base=pin・head=main
    なので、``ahead_by`` は「main が pin より先行している数」= **pin が遅れている数**
    である（``behind_by`` ではない）。本リポの ``update-external.yml`` 冒頭にある
    実測記録 ``compare/fed9c07...main → status "ahead", ahead_by=7, behind_by=0``
    が同じ読み方を裏づけている。

    ``status`` が ``ahead`` 以外のときに素通ししないよう、全ケースを列挙する。
    特に ``diverged`` と 404 は「squash マージで消えた PR ブランチの SHA を掴んで
    いる」到達不能な pin であり、乖離として扱う。
    """
    if pin == upstream_sha:
        return {"state": PIN_CURRENT, "behind": 0, "detail": "上流 main と一致"}

    if compare is None:
        return {
            "state": PIN_UNREACHABLE,
            "behind": None,
            "detail": "pin SHA が上流で解決できない（compare が 404）。"
            "squash マージ等で消えたコミットを指している可能性がある",
        }

    status = compare.get("status")
    ahead_by = compare.get("ahead_by")
    behind_by = compare.get("behind_by")

    if status == "identical":
        return {"state": PIN_CURRENT, "behind": 0, "detail": "上流 main と同一"}
    if status == "ahead":
        # base=pin から見て head=main が ahead。すなわち pin が ahead_by だけ遅れている。
        return {
            "state": PIN_BEHIND,
            "behind": ahead_by,
            "detail": f"上流 main に {ahead_by} コミット遅れている",
        }
    if status == "diverged":
        return {
            "state": PIN_UNREACHABLE,
            "behind": None,
            "detail": f"pin が上流 main の祖先ではない（diverged / "
            f"ahead_by={ahead_by}, behind_by={behind_by}）。到達不能な pin",
        }
    if status == "behind":
        # pin が main の子孫。main へ入っていないコミットを指しており異常。
        return {
            "state": PIN_ANOMALY,
            "behind": None,
            "detail": f"pin が上流 main より先行している（behind / behind_by={behind_by}）。"
            "main へ未マージのコミットを指している",
        }
    return {
        "state": PIN_ANOMALY,
        "behind": None,
        "detail": f"compare の status が想定外（{status!r}）",
    }


# ---------------------------------------------------------------------------
# 軸 4: 上流 reusable workflow 自身の劣化検知（純粋関数）
# ---------------------------------------------------------------------------


def _steps(job: object) -> list[dict]:
    if not isinstance(job, dict):
        return []
    steps = job.get("steps")
    if not isinstance(steps, list):
        return []
    return [s for s in steps if isinstance(s, dict)]


def _find_job_by_action(jobs: dict, action_path: str) -> tuple[str | None, dict | None]:
    """指定の composite action を呼ぶステップを含むジョブを探す。

    ジョブ名ではなく呼び出す action で同定する。軸 4 の主張は「skills ジョブの
    checkout だけを見ている（submodule ジョブの既定 true を誤判定しない）」こと
    なので、``jobs["skills"]`` のような名前依存は主張を弱めるうえリネームで壊れる。
    """
    for name, job in jobs.items():
        for step in _steps(job):
            if _uses_action(step.get("uses"), action_path):
                return name, job
    return None, None


def _find_step_by_action(job: dict | None, action_path: str) -> dict | None:
    for step in _steps(job):
        if _uses_action(step.get("uses"), action_path):
            return step
    return None


def _with(step: dict | None) -> dict:
    if not isinstance(step, dict):
        return {}
    w = step.get("with")
    return w if isinstance(w, dict) else {}


# マーカー (6) 用の分類。``_classify_uses_pin`` の戻り値としてのみ使う内部値
# （他モジュールへの公開契約にはしない。冒頭 4 マーカーの ``PIN_*`` 等と違い
# レポートの列挙値としては現れず、``check_upstream_markers`` 内で detail 文字列へ
# 畳んでから外へ出すため）。
_USES_PIN_OK = "ok"
_USES_PIN_UNPINNED = "unpinned"
_USES_PIN_EXEMPT = "exempt"


def _stringify_uses(value: object) -> str:
    """``uses`` の値を分類・表示用の文字列へ正規化する。

    正規の ``uses`` は非空文字列だが、YAML の型崩れ（数値・真偽値・``null``・
    空文字列等）を分母から黙って落とすと、その異常値が「未固定一覧」にも
    「固定済みの分母」にも入らず ``check_upstream_markers`` が
    「全て 40 桁 SHA 固定」と誤判定し得る（イシュー #302 レビュー指摘）。
    ここで非文字列も必ず文字列化して ``_collect_all_uses`` の戻り値に含め、
    後段の ``_classify_uses_pin`` に判定を委ねる——非文字列は
    ``_SHA40_RE`` に一致しようがなく必然的に未固定へ落ちるため、
    「fail-closed で不正値も報告に出す」という契約が自然に満たされる。

    同じ理由で ``jobs`` の YAML キー（``job_name``）も非文字列（``yaml.safe_load``
    は ``1:`` のような非文字列キーを許容する）があり得るため、
    ``_collect_all_uses`` はこの関数を ``job_name`` の正規化にも流用する
    （PR #355 レビュー指摘: 非文字列 ``job_name`` を素通しすると、後段の
    ``_sanitize_for_detail`` の ``str.replace`` 呼び出しが ``AttributeError`` で
    落ち、drift check 全体が例外終了して fail-closed 契約に反する）。
    """
    if isinstance(value, str):
        return value
    return repr(value)


def _collect_all_uses(jobs: dict) -> list[tuple[str, str, str]]:
    """``jobs`` 配下の全 ``uses``（job-level + step-level）を平坦化して集める。

    マーカー (6)（上流 action の SHA 固定）の入力。YAML を構造走査するのは、
    原文への正規表現だと実際の上流ファイル冒頭コメントに実在する
    ``# uses: ...@<SHA>`` のような手順メモ行まで拾ってしまうため
    （軸 1 の ``classify_workflow`` が同じ理由でパース済み構造を見ているのと
    同じ設計判断）。戻り値は ``(ジョブ名, ステップ表示名, uses 文字列)`` の
    タプル列。ステップ表示名は ``name`` が無ければ ``uses`` 自体で代替する
    （detail に埋めたとき人間が該当箇所を特定できることを優先し、
    索引番号だけの表示は避ける）。

    収集条件は「``uses`` キーが存在するか」であり、値の型・非空性では
    絞り込まない（絞り込むと非文字列・空文字列の異常値が分母からも
    未固定一覧からも消え、fail-closed 契約に反して green に見えてしまう。
    ``_stringify_uses`` のドキュメント参照）。
    """
    collected: list[tuple[str, str, str]] = []
    for raw_job_name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        # `jobs.<id>` の YAML キーも非文字列（数値・真偽値等）があり得るため、
        # 後段（`_sanitize_for_detail` 等）へ渡す前にここで文字列化しておく
        # （`_stringify_uses` の docstring 参照）。
        job_name = _stringify_uses(raw_job_name)
        # reusable workflow 呼び出し（`jobs.<id>.uses`）。イシュー #302 の要件は
        # 「全 uses」であり、このジョブ形式を対象から外す理由が無い。
        if "uses" in job:
            collected.append((job_name, job_name, _stringify_uses(job.get("uses"))))
        for step in _steps(job):
            if "uses" not in step:
                continue
            step_uses = _stringify_uses(step.get("uses"))
            step_name = step.get("name")
            display = step_name if isinstance(step_name, str) and step_name else step_uses
            collected.append((job_name, display, step_uses))
    return collected


def _classify_uses_pin(uses: str) -> str:
    """1 件の ``uses`` 値が SHA 固定されているかを分類する。

    ``check_upstream_markers`` のマーカー (6) から呼ばれる。分類根拠（非ゴール
    を含む）:

    - ``./`` で始まるローカル action は同一リポ内参照であり ``@ref`` の概念が
      無いので検査対象外（exempt）。可動参照へ退行するリスクが構造的に無い。
      ``$/`` で始まる文字列は GitHub Actions の ``uses`` 構文として非対応
      （公式にサポートされる同一リポジトリ参照は ``./...`` のみ）であり、
      「本質的に固定されている」という前提が成立しない。免除すると不正値を
      green 扱いにする偽陰性になるため（PR #355 レビュー指摘）、``$/`` は
      exempt に含めず、``@`` を含まない他の値と同様に未固定として扱う。
    - ``docker://`` はこの関数では SHA 形式を判定できないため fail-closed で
      未固定扱いにする。上流に現存しないため誤報にはならず、将来出現したときに
      人間のレビューを促す（本ファイル冒頭の「fail-closed」設計方針と同じ）。
    - それ以外は ``@`` の**最後**の出現で右側を ref として取り出し
      （``_split_job_uses`` と同じ ``rsplit`` 相当の理由——パス側に ``@`` は
      現れないが逆はあり得るため）、既存の ``_SHA40_RE``（小文字 40 桁 hex）に
      厳密一致するかで判定する。大文字混じりは意図的に fail にする（表記ゆれの
      通過を許すと退行検知としての意味が薄れる）。
    - **鮮度は見ない（非ゴール）。** 「形式が 40 桁 hex か」だけを判定し、
      「その SHA が古い」は判定しない。pin の鮮度は軸 2 の役割であり、この
      reusable workflow が内部で pin する composite action
      （skills-update / submodule-update）の SHA は、上流側に bump 慣習が
      無く本リポからは鮮度判定できない（workflow 本体の SHA と内部 pin は別物）。
    """
    text = uses.strip()
    if text.startswith("./"):
        return _USES_PIN_EXEMPT
    if text.startswith("docker://"):
        return _USES_PIN_UNPINNED
    if "@" not in text:
        return _USES_PIN_UNPINNED
    _, _, ref = text.rpartition("@")
    if _SHA40_RE.match(ref.strip()):
        return _USES_PIN_OK
    return _USES_PIN_UNPINNED


def _sanitize_for_detail(text: str) -> str:
    """detail に埋め込む値を Markdown 表セルへ安全に埋め込める形へ潰す。

    detail はリモート（上流ファイル）由来の文字列（``uses`` だけでなく
    ``jobs.<id>`` の YAML キーである job_name や ``step.name`` 由来の
    display も含む）をほぼ逐語で含む。この値は ``render_report`` が
    Markdown 表の 1 セルへそのまま差し込むため、``|`` が残っていると表の
    列がずれ、改行が残っていると行が壊れる。上流編集者が悪意を持って
    ``uses``・ジョブ名・ステップ名のいずれかに ``|`` や改行を仕込めば、
    報告 issue の Markdown 構造を壊す・誤情報を注入する経路になり得る
    （OWASP A03 相当）。3 箇所すべてでここを通してから detail へ渡す。

    呼び出し側（マーカー (6)）は job_name・step_name・uses_str の全てを
    バッククォートで囲んでコードスパンとして埋め込む（PR #355 レビュー
    指摘: 以前は uses_str だけコードスパンの外に生のまま出力しており、
    上流編集者が uses 文字列へ Markdown 構文を仕込めばコードスパンの
    保護なしにそのまま注入され得た）。バッククォート自体がここでも
    素通しだと、上流編集者がジョブ名・ステップ名・uses にバッククォート
    を仕込むことでコードスパンを途中終了させ、以降の文字列を通常の
    Markdown として解釈させられる（コードスパン脱出による Markdown
    injection）。``|`` と同様にバッククォートも表示用の記号へ置換して
    無害化する。
    """
    escaped = text.replace("|", "\\|").replace("`", "'")
    collapsed = re.sub(r"\s+", " ", escaped).strip()
    if len(collapsed) > 120:
        collapsed = collapsed[:120] + "…"
    return collapsed


def check_upstream_markers(text: str) -> list[dict]:
    """上流 reusable workflow の強化マーカーが劣化していないかを検査する。

    旧 #260 マーカーの意図をここへ畳んでいる。戻り値は
    ``[{"marker", "ok", "detail"}, ...]``。

    重要: ``persist-credentials`` は**ジョブ単位**で判定する。submodule ジョブは
    private submodule の fetch に checkout の資格情報を使うため既定 ``true`` が
    正しく、ファイル全体の grep では skills ジョブの ``false`` と混ざって誤判定
    する（#260 本文が明示している要件）。ここでは skills ジョブの checkout の
    ``with.persist-credentials`` だけを見て、submodule ジョブ側には何も要求しない。

    マーカー (6)（#302）は上記 (1)〜(5) と異なり skills / submodule ジョブに
    限定せず、``jobs`` 配下の全 ``uses``（job-level + step-level）を対象に
    ``@ref`` が 40 桁 SHA かどうかだけを見る。判定できるのは**可動参照への退行**
    （``@main`` 等）であり、**pin の鮮度は対象外**（古い SHA でも形式が hex なら
    ok。鮮度は軸 2 の役割）。
    """
    results: list[dict] = []

    def add(marker: str, ok: bool, detail: str) -> None:
        results.append({"marker": marker, "ok": ok, "detail": detail})

    try:
        spec = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        add("YAML パース", False, f"パース失敗: {exc}")
        return results

    jobs = spec.get("jobs") if isinstance(spec, dict) else None
    if not isinstance(jobs, dict):
        add("jobs セクション", False, "jobs セクションが見つからない")
        return results

    skills_name, skills_job = _find_job_by_action(jobs, SKILLS_ACTION)
    submodule_name, submodule_job = _find_job_by_action(jobs, SUBMODULE_ACTION)

    if skills_job is None:
        add(
            "skills ジョブの同定",
            False,
            f"{SKILLS_ACTION} を呼ぶジョブが見つからない",
        )
    else:
        add(
            "skills ジョブの同定",
            True,
            f"ジョブ `{skills_name}` が {SKILLS_ACTION} を呼ぶ",
        )

    # --- (1) skills ジョブの persist-credentials: false（ジョブ単位判定）---
    skills_checkout = _find_step_by_action(skills_job, CHECKOUT_ACTION)
    if skills_checkout is None:
        add(
            "skills ジョブの persist-credentials: false",
            False,
            "skills ジョブに actions/checkout ステップが無く判定できない",
        )
    else:
        value = norm(_with(skills_checkout).get("persist-credentials"))
        ok = value == "false"
        sub_note = ""
        if submodule_job is not None:
            sub_checkout = _find_step_by_action(submodule_job, CHECKOUT_ACTION)
            sub_value = _with(sub_checkout).get("persist-credentials")
            sub_note = (
                f"（参考: submodule ジョブ `{submodule_name}` は "
                f"{'未指定=既定 true' if sub_value is None else norm(sub_value)}。"
                "こちらは既定 true が正しく検査対象外）"
            )
        add(
            "skills ジョブの persist-credentials: false",
            ok,
            (f"skills ジョブの checkout は "
             f"{'未指定=既定 true' if not value else value}{sub_note}"),
        )

    # --- (2) skills ジョブの source-token 明示 ---
    skills_step = _find_step_by_action(skills_job, SKILLS_ACTION)
    source_token = norm(_with(skills_step).get("source-token"))
    add(
        "skills ジョブの source-token 明示",
        bool(source_token),
        source_token or "未指定（書き込み PAT が流用され資格情報の境界が広がる）",
    )

    # --- (3) auto-merge-immediate-fallback: 'false'（submodule / skills 両方）---
    for label, step, job_name in (
        ("skills", skills_step, skills_name),
        ("submodule", _find_step_by_action(submodule_job, SUBMODULE_ACTION), submodule_name),
    ):
        marker = f"{label} ジョブの auto-merge-immediate-fallback: 'false'"
        if step is None:
            add(marker, False, f"{label} の composite action ステップが見つからない")
            continue
        value = norm(_with(step).get("auto-merge-immediate-fallback"))
        add(
            marker,
            value == "false",
            f"ジョブ `{job_name}` の値は {value or '未指定（既定 true = fail-open）'}",
        )

    # --- (4) skills-version の固定（latest 追従でない）---
    skills_version = norm(_with(skills_step).get("skills-version"))
    if not skills_version:
        add("skills-version の固定", False, "未指定（npm latest 追従で挙動が無告知に変わる）")
    elif skills_version.lower() == "latest":
        add("skills-version の固定", False, "latest 指定（固定されていない）")
    else:
        add("skills-version の固定", True, skills_version)

    # --- (5) node-version が LTS のフル指定 ---
    setup_node = _find_step_by_action(skills_job, SETUP_NODE_ACTION)
    node_version = norm(_with(setup_node).get("node-version"))
    if not node_version:
        add("node-version の LTS フル指定", False, "setup-node の node-version が未指定")
    elif not _SEMVER_RE.match(node_version):
        # ``'20'`` のようなメジャーのみ指定は解決先パッチ版が日々変動し再現性がない。
        add(
            "node-version の LTS フル指定",
            False,
            f"{node_version}（メジャーのみ等の部分指定。解決先パッチ版が変動する）",
        )
    else:
        major = int(node_version.split(".")[0])
        # Node.js は偶数メジャーのみが LTS 系列になる。ネットワークに出ずに
        # LTS 性を近似できる唯一の構造的手掛かりなのでこれを使う
        # （nodejs.org/dist を引くと fail-closed なジョブに外部依存を増やす）。
        add(
            "node-version の LTS フル指定",
            major % 2 == 0,
            f"{node_version}"
            + ("" if major % 2 == 0 else "（奇数メジャーは LTS 系列ではない）"),
        )

    # --- (6) 上流 action の SHA 固定（イシュー #302）------------------------
    # `@main` 等の可動参照への退行を検知する。skills / submodule ジョブに限定
    # せず `jobs` 全体を対象にする（要件が「全 uses」であるため。既存 (1)〜(5)
    # のようにジョブ名・action で絞り込まない）。
    #
    # 分母を必ず出す。`uses` が 1 件も無い上流は検査対象として構造的に異常
    # であり、`unbound == 0` を無条件に green と読ませない
    # （`.claude/rules/ruleset-policy.md` が同じ罠を「total と unbound を
    # 併記し、空配列の join で両者を混同しない」と教訓化している。ここでも
    # `N == 0` を「全て SHA 固定」と誤読しないよう、0 件は明示的に fail にする）。
    all_uses = _collect_all_uses(jobs)
    total = len(all_uses)
    if total == 0:
        add(
            "上流 action の SHA 固定",
            False,
            "uses が 1 件も無い（検査対象として異常。fail-closed で不適合とする）",
        )
    else:
        # `./` ローカル action は _classify_uses_pin が exempt（検査対象外）
        # として分類する。exempt は「SHA 固定を確認できた」わけではなく
        # 「@ref の概念が無く判定不能」なだけなので、分母 total には含めた
        # まま unpinned から除外しても ok（固定確認済み）とは数えない。
        # unpinned が空でも exempt が混ざっていれば「全 N 件すべて SHA
        # 固定」と言い切るのは誤表示になる（PR #355 レビュー指摘: ok /
        # exempt / unpinned を分離集計する）。
        exempt_count = sum(
            1
            for _job_name, _step_name, uses_str in all_uses
            if _classify_uses_pin(uses_str) == _USES_PIN_EXEMPT
        )
        unpinned = [
            (job_name, step_name, uses_str)
            for job_name, step_name, uses_str in all_uses
            if _classify_uses_pin(uses_str) == _USES_PIN_UNPINNED
        ]
        if not unpinned:
            ok_count = total - exempt_count
            if exempt_count:
                add(
                    "上流 action の SHA 固定",
                    True,
                    f"全 {total} 件中 {ok_count} 件が 40 桁 SHA 固定"
                    f"（{exempt_count} 件はローカル action で対象外）",
                )
            else:
                add(
                    "上流 action の SHA 固定", True, f"全 {total} 件すべて 40 桁 SHA 固定"
                )
        else:
            # 列挙は先頭 5 件で打ち切るが、打ち切っても総件数は必ず数値で出す
            # （「他 K 件」）。Markdown 表破壊防止のため job_name・step_name・
            # uses_str の 3 者すべてを `_sanitize_for_detail` に通したうえで
            # コードスパン（バッククォート）へ入れる（job_name は
            # `jobs.<id>` の YAML キー、step_name は `step.name`（display）
            # 由来で、どちらも上流編集者が自由に設定できる文字列のため
            # uses と同じ脅威モデルが成立する）。uses_str をコードスパンの
            # 外に生で出すと、値自体が Markdown 構文なら保護なしにそのまま
            # 注入され得るため、他 2 者と同様にバッククォートで囲む
            # （PR #355 レビュー指摘）。
            shown = unpinned[:5]
            entries = [
                f"`{_sanitize_for_detail(job_name)}`/"
                f"`{_sanitize_for_detail(step_name)}`: "
                f"`{_sanitize_for_detail(uses_str)}`"
                for job_name, step_name, uses_str in shown
            ]
            remaining = len(unpinned) - len(shown)
            suffix = f"、他 {remaining} 件" if remaining > 0 else ""
            add(
                "上流 action の SHA 固定",
                False,
                f"全 {total} 件中 {len(unpinned)} 件が未固定: "
                + "; ".join(entries)
                + suffix,
            )

    return results


# ---------------------------------------------------------------------------
# 軸 5: 定期実行の生存（純粋関数）
# ---------------------------------------------------------------------------

SCHED_OK = "SCHED_OK"
SCHED_DISABLED = "SCHED_DISABLED"
SCHED_STALE = "SCHED_STALE"
SCHED_FAILING = "SCHED_FAILING"
SCHED_UNKNOWN = "SCHED_UNKNOWN"

# schedule 実行の ``conclusion`` のうち「実行はされたが成果物として失敗」を表す値。
# ``None``（実行中）や ``success`` はここに含めない。復旧手順ドキュメント
# （docs/update-external-schedule.md 手順4）が復旧確認の根拠として ``conclusion``
# を使っているのに対し、検知ロジック側は #304 当初実装では発火（timestamp）しか
# 見ておらず、「発火はしているがジョブ内部が権限エラー等で連日失敗」というケース
# （軸 1-4 はファイル内容しか見ないため green に見える）を取りこぼしていた。
_FAILING_CONCLUSIONS = {"failure", "timed_out", "startup_failure", "cancelled", "action_required"}

# 直近何件の schedule 実行が「全て失敗」であれば SCHED_FAILING と判定するか。
# 1 件だけで判定すると単発の flaky failure を過検知するため、連続失敗の実測
# （＝一時的な障害ではない）を要求する。偽陽性（レポートに 1 行増えるだけ）より
# 偽陰性（無告知停止の見逃し）のコストが高いという #304 と同じ非対称性から、
# 極端に大きくはしない。
SCHED_FAILING_STREAK_MIN = 2

# 実測（2026-08-17）の健全なギャップは約 19 時間。検知ジョブと update-external の
# cron の間には約 3 時間のずれがある。N=3 だと「2 回連続で日次実行が飛んだ」状態
# を green に読んでしまう実測ケースがあったため N=2 を既定にする。偽陽性
# （レポートに 1 行増えるだけ）より偽陰性（無告知停止の見逃し）のコストが高い
# という非対称性が根拠（詳細: docs/update-external-schedule.md）。
SCHEDULE_STALE_DAYS_DEFAULT = 2

# GitHub の scheduled workflow 自動無効化の理由別 state。値は Actions API の
# ``workflow.state`` フィールドがそのまま返す文字列。
_SCHED_DISABLED_STATES = {
    "disabled_inactivity": "無活動により自動無効化された",
    "disabled_manually": "手動で無効化された",
    "disabled_fork": "fork のため schedule トリガが動作しない",
}


def _parse_ts(value: object) -> datetime | None:
    """ISO 8601 タイムスタンプを aware な ``datetime`` へ変換する。

    Actions API はエンドポイントによって形式が異なる（実測: workflow オブジェクト
    は ``2026-06-14T17:59:22.000+09:00``、runs は ``2026-08-14T02:00:09Z``）。
    ``datetime.fromisoformat`` は Python 3.11+ で ``Z`` サフィックスを解釈できるが、
    本番実行の Python バージョンに依存させないため事前に ``+00:00`` へ置換する。

    パース失敗（``ValueError``）や、naive な文字列（``tzinfo is None``。
    aware な ``now`` との比較が ``TypeError`` になり fail-closed のメッセージを
    出せないままスキャンを落としてしまう）は ``None`` に落とし、呼び出し側で
    ``SCHED_UNKNOWN`` として扱わせる。例外は絶対に外へ投げない。
    """
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None
    return dt


def evaluate_schedule(
    state: str,
    last_run_iso: str | None,
    created_at_iso: str | None,
    now: datetime,
    threshold_days: int,
    recent_conclusions: list[str | None] | None = None,
) -> dict:
    """workflow の schedule トリガが生きているかを判定する（軸 5 の核心）。

    GitHub API に一切触れない純粋関数。``now`` を引数で受けてテストを決定的に
    する（``datetime.now()`` を内部で呼ばない）。

    判定は ``state`` と「直近の schedule 実行からの経過日数」の**両方**を使う。
    ``state`` 単独では検出できない実例（``template-articles`` は ``state`` が
    ``active`` のまま schedule が約 3.7 日止まっていた、2026-08-17 実測）が
    軸 5 導入の根拠であるため、``active`` であることは「乖離が無い」の必要条件
    でしかない。

    ``recent_conclusions`` は直近の schedule 実行の ``conclusion`` を新しい順に
    並べたもの（``fetch_schedule_health`` が渡す）。**発火の新しさだけでは
    「同期が動いている」ことの証明にならない。** schedule トリガ自体は生きて
    毎日発火していても、ジョブ内部が権限エラー等で連日失敗し続けていれば
    ``last_run_iso`` は最新のタイムスタンプを返すため、conclusion を見なければ
    SCHED_OK に誤判定される。直近 ``SCHED_FAILING_STREAK_MIN`` 件が全て
    ``_FAILING_CONCLUSIONS`` に該当する場合のみ SCHED_FAILING とし、単発の
    flaky failure を過検知しない。

    戻り値は ``{"state", "detail"}``。``detail`` には最終実行タイムスタンプと
    経過日数を必ず含める（読み手がしきい値を信用せず自分で判断できるように
    するため。docs/update-external-schedule.md 参照）。
    """
    if state in _SCHED_DISABLED_STATES:
        return {
            "state": SCHED_DISABLED,
            "detail": f"{_SCHED_DISABLED_STATES[state]}（state={state}）",
        }
    if state != "active":
        return {"state": SCHED_UNKNOWN, "detail": f"想定外の state（{state!r}）"}

    if last_run_iso is not None:
        last_run = _parse_ts(last_run_iso)
        if last_run is None:
            return {
                "state": SCHED_UNKNOWN,
                "detail": f"最終 schedule 実行のタイムスタンプを解析できない（{last_run_iso!r}）",
            }
        delta_days = (now - last_run).total_seconds() / 86400
        detail = (
            f"最終 schedule 実行: {last_run_iso}（{delta_days:.1f} 日経過、"
            f"しきい値 {threshold_days} 日）"
        )
        if delta_days >= threshold_days:
            return {"state": SCHED_STALE, "detail": detail}

        # 発火は新しいが、直近の実行結果が連続失敗なら OK に倒さない。
        if (
            recent_conclusions
            and len(recent_conclusions) >= SCHED_FAILING_STREAK_MIN
            and all(c in _FAILING_CONCLUSIONS for c in recent_conclusions)
        ):
            return {
                "state": SCHED_FAILING,
                "detail": detail + f"。直近 {len(recent_conclusions)} 件の schedule 実行が"
                f"連続失敗（conclusion: {', '.join(str(c) for c in recent_conclusions)}）",
            }
        return {"state": SCHED_OK, "detail": detail}

    # schedule 実行が 1 件も見つからない（Actions API が total_count == 0 を
    # 返した）。Actions の実行履歴には保持期間があるため、これは「一度も
    # 実行されていない」ことの証明にはならない。ここでは断定せず、workflow の
    # 導入直後かどうかを ``created_at`` で猶予判定する。
    if created_at_iso is None:
        return {"state": SCHED_UNKNOWN, "detail": "workflow の created_at が取得できない"}
    created_at = _parse_ts(created_at_iso)
    if created_at is None:
        return {
            "state": SCHED_UNKNOWN,
            "detail": f"workflow の created_at を解析できない（{created_at_iso!r}）",
        }
    delta_days = (now - created_at).total_seconds() / 86400
    if delta_days < threshold_days:
        return {
            "state": SCHED_OK,
            "detail": f"導入から {delta_days:.1f} 日（猶予期間中。直近の schedule 実行は未確認）",
        }
    return {
        "state": SCHED_STALE,
        "detail": (
            f"直近の schedule 実行を確認できない（workflow 導入から "
            f"{delta_days:.1f} 日経過、しきい値 {threshold_days} 日）"
        ),
    }


# ---------------------------------------------------------------------------
# I/O レイヤ（ここから下は GitHub API に触れる）
# ---------------------------------------------------------------------------


class ScanError(RuntimeError):
    """スキャン全体を失敗させるべきエラー（fail-closed）。"""


def _run(args: list[str], token: str | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if token:
        env["GH_TOKEN"] = token
    return subprocess.run(args, capture_output=True, text=True, env=env)


def gh_json(path: str, token: str, jq: str | None = None) -> object:
    """``gh api`` を叩いて JSON を返す。失敗は ScanError。

    ``--jq`` は引数を 1 つしか取らないため、フィルタ式は必ず 1 文字列で渡す
    （``--jq -r`` は "accepts 1 arg(s), received 2" で失敗する）。
    """
    args = ["gh", "api", path]
    if jq:
        args += ["--jq", jq]
    proc = _run(args, token)
    if proc.returncode != 0:
        raise ScanError(f"gh api {path} が失敗: {proc.stdout.strip()} {proc.stderr.strip()}")
    out = proc.stdout.strip()
    if jq:
        return out
    return json.loads(out) if out else None


def gh_get_with_status(path: str, token: str, raw: bool = False) -> tuple[int | None, str]:
    """HTTP status と本文を返す。

    ``gh api`` は HTTP エラーを一律 exit 1 に潰し、しかもエラー本文を stdout へ
    書く。終了コードだけでは 404（対象なし = 軸 3 へ進む）と 403/5xx（検査不能
    = UNKNOWN）を区別できず、トークンのスコープ不足が「乖離 0 件」に化ける。
    ``-i`` でレスポンスヘッダを取り、status 行から実際のコードを読む。
    """
    args = ["gh", "api", "-i"]
    if raw:
        args += ["-H", "Accept: application/vnd.github.raw"]
    args.append(path)
    proc = _run(args, token)
    stdout = proc.stdout
    status: int | None = None
    if stdout.startswith("HTTP/"):
        parts = stdout.split("\n", 1)[0].split()
        if len(parts) >= 2 and parts[1].isdigit():
            status = int(parts[1])
    # ヘッダと本文は空行で区切られる。CRLF / LF 双方を考慮する。
    body = ""
    for sep in ("\r\n\r\n", "\n\n"):
        if sep in stdout:
            body = stdout.split(sep, 1)[1]
            break
    return status, body


def list_target_repos(org: str, token: str) -> list[str]:
    """組織の非アーカイブリポジトリを全件列挙する。

    **「直近 1 週間に push があった」フィルタは使わない。** 2026-08-17 の
    スイープで、最終 push が 2026-05-03 の ``hobby-keyboard`` が skills を
    vendor していながら同期 CI 未導入であることが判明した。乖離は push で
    生まれるとは限らず「放置されて古いまま」も乖離であるため、1 週間フィルタ
    では取りこぼす。全非アーカイブリポ（約 120）を対象にする。
    """
    proc = _run(
        [
            "gh", "repo", "list", org,
            "--limit", str(REPO_LIST_LIMIT),
            "--json", "name,isArchived",
            # **アーカイブ除外を jq 側で行わない。** `--limit` は API 取得件数
            # （フィルタ前）の上限であり、窓の中にアーカイブ済みリポが混じると
            # フィルタ後の件数は上限を下回る。フィルタ後の件数で打ち切り判定を
            # すると、実際には打ち切られているのにガードが発火せず、残りの
            # 非アーカイブリポが未検査のまま「乖離 0 件」に化ける。
            # 取得行そのものを数えるため、フィルタは Python 側で行う。
            "--jq", '.[] | [.name, (.isArchived | tostring)] | @tsv',
        ],
        token,
    )
    if proc.returncode != 0:
        raise ScanError(
            f"リポジトリ列挙に失敗: {proc.stdout.strip()} {proc.stderr.strip()}"
        )
    rows = [line for line in proc.stdout.splitlines() if line.strip()]
    if not rows:
        raise ScanError("リポジトリ列挙が 0 件を返した（列挙失敗と区別できないため失敗扱い）")
    # 打ち切り判定は**取得行数**（フィルタ前）で行う。上限に達していたら
    # 残りが黙って検査対象外になり「非アーカイブ全件を見た」という主張が崩れる。
    if len(rows) >= REPO_LIST_LIMIT:
        raise ScanError(
            f"リポジトリ列挙が上限 {REPO_LIST_LIMIT} 件に達した。"
            "全件を列挙できたか確認できないため失敗扱いにする"
            "（REPO_LIST_LIMIT を引き上げるかページネーションへ切り替えること）"
        )

    names: list[str] = []
    for line in rows:
        name, _, archived = line.partition("\t")
        if archived.strip().lower() != "true":
            names.append(name.strip())
    if not names:
        raise ScanError("非アーカイブのリポジトリが 0 件（列挙失敗と区別できないため失敗扱い）")
    return sorted(names)


def get_claude_skills_tree_mode(repo: str, token: str) -> str:
    """``.claude/skills`` の git tree mode を返す。

    ``120000`` = symlink / ``040000`` = 実ディレクトリ。

    **どちらでも同期 CI は成立する。** 実ディレクトリだと日次で失敗するという当初の想定は
    3 リポジトリでの実測で否定された（`.claude/rules/skill-vendoring-layout.md`）。
    したがってこの値は SYNC-CI-ABSENT の報告へ**情報として併記するだけ**であり、
    導入可否の判断には使わない。
    """
    status, body = gh_get_with_status(f"repos/{repo}/git/trees/HEAD", token)
    if status != 200:
        return f"不明（HTTP {status}）"
    try:
        tree = json.loads(body).get("tree", [])
    except json.JSONDecodeError:
        return "不明（tree の JSON 解析失敗）"
    entry = next((e for e in tree if e.get("path") == ".claude"), None)
    if entry is None:
        return ".claude なし"
    if entry.get("type") != "tree":
        return f".claude 自体が {entry.get('mode')}（{entry.get('type')}）"

    status, body = gh_get_with_status(f"repos/{repo}/git/trees/{entry['sha']}", token)
    if status != 200:
        return f"不明（HTTP {status}）"
    try:
        sub = json.loads(body).get("tree", [])
    except json.JSONDecodeError:
        return "不明（tree の JSON 解析失敗）"
    skills = next((e for e in sub if e.get("path") == "skills"), None)
    if skills is None:
        return ".claude/skills なし"
    return f"{skills.get('mode')} ({skills.get('type')})"


def fetch_schedule_health(repo: str, token: str) -> tuple[str, object]:
    """Actions API から軸 5 の判定に必要な情報を取得する。

    戻り値は ``("ok", {"state", "created_at", "last_run", "recent_conclusions"})`` /
    ``("forbidden", 理由)`` / ``("error", 理由)`` の 3 値。403 だけを別値に
    しているのは、``scan()`` が「軸 5 候補の全リポジトリが 403」を
    ``SUBMODULE_PAT`` の Actions: read 権限不足による系統的失敗として検出する
    ため（他の失敗と畳むと原因が読み取れない ``UNKNOWN`` の山になる）。

    ``state`` が ``active`` のときだけ実行履歴 API を追加で叩く。``disabled_*``
    のときは呼んでも意味がなく、API 消費を無駄に増やすだけのため。

    ``recent_conclusions`` は直近 ``SCHED_FAILING_STREAK_MIN`` 件の schedule
    実行の ``conclusion`` を新しい順に並べたもの。発火の timestamp だけでは
    「schedule トリガ自体は生きているがジョブ内部が連日失敗している」状態を
    区別できない（``evaluate_schedule`` の docstring 参照）ため、``per_page`` を
    1 件から必要最小限（``SCHED_FAILING_STREAK_MIN``）へ広げて取得する。
    """
    status, body = gh_get_with_status(
        f"repos/{repo}/actions/workflows/{WORKFLOW_FILENAME}", token
    )
    if status == 403:
        return "forbidden", "workflow メタデータ取得が HTTP 403"
    if status != 200:
        return "error", f"workflow メタデータ取得が HTTP {status}"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return "error", "workflow メタデータの JSON 解析に失敗"

    wf_state = data.get("state")
    created_at = data.get("created_at")

    last_run_iso = None
    recent_conclusions: list[str | None] = []
    if wf_state == "active":
        r_status, r_body = gh_get_with_status(
            f"repos/{repo}/actions/workflows/{WORKFLOW_FILENAME}/runs"
            f"?event=schedule&per_page={SCHED_FAILING_STREAK_MIN}",
            token,
        )
        if r_status == 403:
            return "forbidden", "schedule 実行履歴取得が HTTP 403"
        if r_status != 200:
            return "error", f"schedule 実行履歴取得が HTTP {r_status}"
        try:
            runs_data = json.loads(r_body)
        except json.JSONDecodeError:
            return "error", "schedule 実行履歴の JSON 解析に失敗"
        runs = runs_data.get("workflow_runs") or []
        if runs:
            last_run_iso = runs[0].get("created_at")
            recent_conclusions = [r.get("conclusion") for r in runs]

    return "ok", {
        "state": wf_state,
        "created_at": created_at,
        "last_run": last_run_iso,
        "recent_conclusions": recent_conclusions,
    }


# ---------------------------------------------------------------------------
# スキャン本体
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    repo: str
    category: str
    detail: str


@dataclass
class ScanResult:
    upstream_sha: str = ""
    upstream_markers: list[dict] = field(default_factory=list)
    wrappers_ok: list[str] = field(default_factory=list)
    excluded: list[tuple[str, str]] = field(default_factory=list)
    no_workflow_ok: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    unknowns: list[Finding] = field(default_factory=list)
    scanned: int = 0
    # 軸 5: 定期実行の生存。schedule_ok は乖離なしの下流リポ、schedule_candidates
    # は軸 5 の対象件数（has_schedule な wrapper/legacy）、schedule_forbidden は
    # Actions API が 403 を返した件数（全候補 403 なら scan() が ScanError にする）。
    schedule_ok: list[str] = field(default_factory=list)
    schedule_candidates: int = 0
    schedule_forbidden: int = 0


def scan(
    org: str,
    token: str,
    schedule_stale_days: int = SCHEDULE_STALE_DAYS_DEFAULT,
) -> ScanResult:
    result = ScanResult()
    # 軸 5 の「経過日数」判定を 1 スキャン内で決定的にする（ループの途中で
    # now が進み、同じスキャン内で境界を跨いで判定がぶれることを避ける）。
    scan_now = datetime.now(timezone.utc)

    # --- 上流 main SHA の解決（失敗はスキャン全体の失敗）---
    upstream_sha = str(
        gh_json(f"repos/{UPSTREAM_REPO}/commits/main", token, ".sha")
    ).strip()
    if not _SHA40_RE.match(upstream_sha):
        raise ScanError(f"上流 main SHA の解決結果が不正: {upstream_sha!r}")
    result.upstream_sha = upstream_sha

    # --- 軸 4: 上流 reusable workflow 自身の検査 ---
    status, upstream_text = gh_get_with_status(
        f"repos/{UPSTREAM_REPO}/contents/{UPSTREAM_WORKFLOW_PATH}?ref=main",
        token,
        raw=True,
    )
    if status != 200:
        raise ScanError(
            f"上流 reusable workflow を取得できない（HTTP {status}）。"
            "軸 4 を検査できないためスキャンを失敗させる"
        )
    result.upstream_markers = check_upstream_markers(upstream_text)

    repos = list_target_repos(org, token)

    # pin ごとの compare 結果キャッシュ。19 個の wrapper が同じ pin を共有する
    # ことが多く、リポごとに compare を叩くとレート制限を無駄に消費する。
    #
    # 戻り値は ``("ok", data)`` / ``("absent", None)`` / ``("error", 理由)`` の
    # 3 値。**404 とそれ以外の失敗を畳まない。** 404 は「その SHA が上流に存在
    # しない」という判定結果（到達不能な pin = 乖離）だが、403 / 429 / 5xx や
    # 200 応答の JSON 解析失敗は単に検査できなかっただけで、pin が壊れている
    # 証拠にはならない。両者を None に畳むと、レート制限や一時障害が
    # PIN-UNREACHABLE として報告され「個別取得失敗は UNKNOWN」という本スキルの
    # 契約と食い違う（乖離を捏造する側に倒れる）。
    compare_cache: dict[str, tuple[str, object]] = {}

    def compare_pin(pin: str) -> tuple[str, object]:
        if pin in compare_cache:
            return compare_cache[pin]
        st, body = gh_get_with_status(
            f"repos/{UPSTREAM_REPO}/compare/{pin}...main", token
        )
        outcome: tuple[str, object]
        if st == 200:
            try:
                data = json.loads(body)
                outcome = ("ok", {
                    "status": data.get("status"),
                    "ahead_by": data.get("ahead_by"),
                    "behind_by": data.get("behind_by"),
                })
            except json.JSONDecodeError:
                outcome = ("error", "compare の 200 応答を JSON として解析できない")
        elif st == 404:
            outcome = ("absent", None)
        else:
            outcome = ("error", f"compare の取得が HTTP {st}")
        compare_cache[pin] = outcome
        return outcome

    for name in repos:
        repo = f"{org}/{name}"
        if name in EXCLUDED_REPOS:
            result.excluded.append((repo, EXCLUDED_REPOS[name]))
            continue

        if not _REPO_NAME_RE.match(name):
            # `gh repo list` 由来で通常はここに来ないが、来た場合に不正な
            # 文字列をそのまま API パスへ埋め込んで別エンドポイントへ化けるのを
            # 構造的に防ぐ（OWASP A03）。検査不能として扱い、黙って除外しない。
            result.unknowns.append(
                Finding(repo, "UNKNOWN", f"リポジトリ名が想定外の文字を含む: {name!r}")
            )
            print(f"::warning::{repo}: リポジトリ名が想定外の文字を含むため検査をスキップ")
            continue

        result.scanned += 1
        status, text = gh_get_with_status(
            f"repos/{repo}/contents/{WORKFLOW_PATH}", token, raw=True
        )

        if status == 200:
            info = classify_workflow(text, is_upstream=(repo == UPSTREAM_REPO))
            kind = info["kind"]

            # --- 軸 5: 定期実行の生存 ---
            # kind による早期 continue（LEGACY / UNPARSEABLE / WRAPPER_UNPINNED
            # 等）の**前**に実行する。LEGACY でも schedule トリガを持つリポは
            # 軸 5 の対象であり（手管理のままでも同期自体は動いている場合と、
            # 同期どころか schedule 自体が死んでいる場合は障害の種類も直し方も
            # 違うため、1 リポが軸 1 と軸 5 の両方で報告されるのは意図どおり）、
            # REUSABLE-DEFINITION（上流本体・schedule 概念が無い）と
            # UNPARSEABLE（YAML として schedule の有無を判定できない）だけを除く。
            if kind not in (KIND_REUSABLE_DEFINITION, KIND_UNPARSEABLE) and info["has_schedule"]:
                result.schedule_candidates += 1
                sched_outcome, sched_payload = fetch_schedule_health(repo, token)
                if sched_outcome == "forbidden":
                    result.schedule_forbidden += 1
                    result.unknowns.append(Finding(repo, "SCHED_UNKNOWN", sched_payload))
                    print(f"::warning::{repo}: {sched_payload}")
                elif sched_outcome == "error":
                    result.unknowns.append(Finding(repo, "SCHED_UNKNOWN", sched_payload))
                    print(f"::warning::{repo}: {sched_payload}")
                else:
                    verdict = evaluate_schedule(
                        sched_payload["state"],
                        sched_payload["last_run"],
                        sched_payload["created_at"],
                        scan_now,
                        schedule_stale_days,
                        sched_payload.get("recent_conclusions"),
                    )
                    if verdict["state"] == SCHED_OK:
                        result.schedule_ok.append(repo)
                    elif verdict["state"] == SCHED_DISABLED:
                        result.findings.append(
                            Finding(repo, "SCHEDULE-DISABLED", verdict["detail"])
                        )
                    elif verdict["state"] == SCHED_STALE:
                        result.findings.append(
                            Finding(repo, "SCHEDULE-STALE", verdict["detail"])
                        )
                    elif verdict["state"] == SCHED_FAILING:
                        result.findings.append(
                            Finding(repo, "SCHEDULE-FAILING", verdict["detail"])
                        )
                    else:
                        result.unknowns.append(
                            Finding(repo, "SCHED_UNKNOWN", verdict["detail"])
                        )
                        print(f"::warning::{repo}: {verdict['detail']}")

            if kind == KIND_REUSABLE_DEFINITION:
                # 軸 1 の自動除外。リポ名のハードコードに頼らない構造判定。
                result.excluded.append((repo, info["reason"]))
                continue

            if kind == KIND_LEGACY:
                result.findings.append(Finding(repo, "LEGACY", info["reason"]))
                continue

            if kind == KIND_UNPARSEABLE:
                result.unknowns.append(Finding(repo, "UNKNOWN", info["reason"]))
                print(f"::warning::{repo}: {info['reason']}")
                continue

            if kind == KIND_WRAPPER_UNPINNED:
                result.findings.append(Finding(repo, kind, info["reason"]))
                continue

            # --- 軸 2: pin の鮮度 ---
            pin = info["pin"]
            outcome, payload = compare_pin(pin)
            if outcome == "error":
                # 検査できなかっただけ。壊れた pin として乖離を捏造しない。
                msg = f"pin `{pin[:12]}` の鮮度を確認できない（{payload}）"
                result.unknowns.append(Finding(repo, "UNKNOWN", msg))
                print(f"::warning::{repo}: {msg}")
                continue

            verdict = evaluate_pin(pin, upstream_sha, payload)
            if verdict["state"] == PIN_CURRENT:
                result.wrappers_ok.append(repo)
            elif verdict["state"] == PIN_BEHIND:
                result.findings.append(
                    Finding(repo, "PIN-STALE", f"`{pin[:12]}` — {verdict['detail']}")
                )
            else:
                result.findings.append(
                    Finding(
                        repo,
                        "PIN-UNREACHABLE" if verdict["state"] == PIN_UNREACHABLE else "PIN-ANOMALY",
                        f"`{pin[:12]}` — {verdict['detail']}",
                    )
                )
            continue

        if status == 404:
            # --- 軸 3: skills を vendor しているのに workflow が無い ---
            lock_status, _ = gh_get_with_status(
                f"repos/{repo}/contents/skills-lock.json", token, raw=True
            )
            if lock_status == 404:
                result.no_workflow_ok.append(repo)
                continue
            if lock_status != 200:
                msg = f"skills-lock.json の確認が HTTP {lock_status}"
                result.unknowns.append(Finding(repo, "UNKNOWN", msg))
                print(f"::warning::{repo}: {msg}")
                continue
            mode = get_claude_skills_tree_mode(repo, token)
            result.findings.append(
                Finding(
                    repo,
                    "SYNC-CI-ABSENT",
                    f"skills-lock.json はあるが update-external.yml が無い。"
                    f"`.claude/skills` の tree mode = {mode}"
                    f"（配置差は同期可否を左右しない。"
                    f"`.claude/rules/skill-vendoring-layout.md` 参照）",
                )
            )
            continue

        # 200 / 404 以外は検査不能。黙って除外して「全リポ green」に見せない。
        msg = f"update-external.yml の取得が HTTP {status}"
        result.unknowns.append(Finding(repo, "UNKNOWN", msg))
        print(f"::warning::{repo}: {msg}")

    # 軸 5 候補の全件が 403 なら、個別 UNKNOWN の山として見せず PAT のスコープ
    # 不足という系統的原因として ScanError にする（`SUBMODULE_PAT` の
    # Actions: read 権限不足を名指しする）。候補の一部だけが 403 の場合は
    # 正常系（他リポの判定）を巻き込まないよう UNKNOWN に留める。
    if result.schedule_candidates > 0 and result.schedule_forbidden == result.schedule_candidates:
        raise ScanError(
            "軸 5（定期実行の生存）の候補リポジトリ全件で Actions API が 403 を返した。"
            "`SUBMODULE_PAT` に Actions: read 権限が必要"
        )

    return result


# ---------------------------------------------------------------------------
# レポート生成
# ---------------------------------------------------------------------------


def render_report(result: ScanResult, run_url: str = "") -> str:
    """Markdown レポートを組み立てる。

    ``$GITHUB_STEP_SUMMARY`` と報告 issue の本文で同じものを使う。乖離 0 件でも
    「0 件だった」と明記する（出力が無いことと 0 件であることを混同させない）。

    長さの上限: 軸 5 追加により 1 リポが軸 1-3 と軸 5 の両方で findings 行を
    持ちうる（例: SYNC-CI-ABSENT かつ SCHEDULE-STALE）ため、全 119 リポが
    最長行 × 2 件になった合成の最悪ケースで 43,513 文字を実測
    （2026-08-18、軸 5 追加後に再計測）。GitHub issue 本文の上限 65,536 文字に
    対し十分な余裕があるため切り詰めは行わない。
    """
    marker_fail = [m for m in result.upstream_markers if not m["ok"]]
    drift = len(result.findings) + len(marker_fail)

    lines: list[str] = []
    lines.append("## update-external 乖離検知レポート")
    lines.append("")
    lines.append(f"- 上流 main SHA: `{result.upstream_sha}`")
    lines.append(f"- 検査対象リポジトリ: {result.scanned} 件（非アーカイブ全件）")
    lines.append(f"- 乖離: **{drift} 件**（下流 {len(result.findings)} / 上流マーカー {len(marker_fail)}）")
    lines.append(f"- 検査不能 (UNKNOWN): **{len(result.unknowns)} 件**")
    lines.append(
        f"- 軸 5 対象（schedule トリガあり）: {result.schedule_candidates} 件"
        f"・生存確認 (schedule_ok): {len(result.schedule_ok)} 件"
    )
    if run_url:
        lines.append(f"- 実行: {run_url}")
    lines.append("")

    # 乖離 0 件でも必ず明示する（「出力が無い」と「0 件だった」を混同させない）。
    lines.append("### 軸 1-3・5: 下流リポジトリ")
    lines.append("")
    if result.findings:
        lines.append("| リポジトリ | 分類 | 詳細 |")
        lines.append("| --- | --- | --- |")
        for f in sorted(result.findings, key=lambda x: (x.category, x.repo)):
            lines.append(f"| `{f.repo}` | {f.category} | {f.detail} |")
        if any(
            f.category in ("SCHEDULE-DISABLED", "SCHEDULE-STALE", "SCHEDULE-FAILING")
            for f in result.findings
        ):
            lines.append("")
            lines.append(
                "軸 5（定期実行の生存）の乖離が見つかった。復旧手順は "
                "`docs/update-external-schedule.md` を参照。"
            )
    else:
        # 軸 5 の生存確認を「全件確認済み」と断定してよいのは、候補が漏れなく
        # schedule_ok へ入っており、かつ schedule 系の UNKNOWN が 1 件も無い場合に
        # 限る。findings が空でも unknowns に SCHED_UNKNOWN（Actions API の 5xx、
        # 部分的な 403、想定外 state、タイムスタンプ解析失敗）が残っていれば、
        # 集計値（schedule_ok: 1/2 等）と本文が矛盾する。検査できていないものを
        # 「確認済み」と読ませない（fail-closed の表示版）。
        sched_unknown = sum(
            1 for u in result.unknowns if u.category == "SCHED_UNKNOWN"
        )
        sched_all_confirmed = (
            result.schedule_candidates == len(result.schedule_ok)
            and sched_unknown == 0
        )
        base = ("乖離 **0 件**。全ての下流リポジトリが最新 pin の wrapper、"
                "または skills を vendor していない。")
        if sched_all_confirmed:
            lines.append(base + "schedule トリガを持つ wrapper は全て直近実行を"
                                "確認できている。")
        else:
            lines.append(
                base
                + f"ただし**検査不能あり**: schedule 候補 {result.schedule_candidates} 件中 "
                f"{len(result.schedule_ok)} 件のみ生存を確認できた"
                f"（schedule 系 UNKNOWN {sched_unknown} 件）。"
                "残りは「乖離なし」ではなく「未確認」である。"
            )
    lines.append("")

    lines.append("### 軸 4: 上流 reusable workflow の強化マーカー")
    lines.append("")
    lines.append("| マーカー | 判定 | 詳細 |")
    lines.append("| --- | --- | --- |")
    for m in result.upstream_markers:
        lines.append(f"| {m['marker']} | {'✅' if m['ok'] else '❌'} | {m['detail']} |")
    lines.append("")

    lines.append("### 検査不能 (UNKNOWN)")
    lines.append("")
    if result.unknowns:
        lines.append("以下は取得に失敗しており、**乖離が無いことを確認できていない**。")
        lines.append("")
        lines.append("| リポジトリ | 詳細 |")
        lines.append("| --- | --- |")
        for f in sorted(result.unknowns, key=lambda x: x.repo):
            lines.append(f"| `{f.repo}` | {f.detail} |")
    else:
        lines.append("検査不能なリポジトリは **0 件**。")
    lines.append("")

    lines.append("<details><summary>適合したリポジトリ・除外</summary>")
    lines.append("")
    lines.append(f"**最新 pin の wrapper ({len(result.wrappers_ok)} 件)**: "
                 + (", ".join(f"`{r}`" for r in result.wrappers_ok) or "なし"))
    lines.append("")
    lines.append(f"**workflow なし・skills 未 vendor ({len(result.no_workflow_ok)} 件)**: "
                 + (", ".join(f"`{r}`" for r in result.no_workflow_ok) or "なし"))
    lines.append("")
    lines.append(f"**除外 ({len(result.excluded)} 件)**:")
    for repo, reason in result.excluded:
        lines.append(f"- `{repo}` — {reason}")
    lines.append("")
    lines.append("</details>")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Issue の更新（作成ではなく更新。毎日新しい issue を作らない）
# ---------------------------------------------------------------------------


def drift_count(result: ScanResult) -> int:
    """乖離件数（下流の findings + 上流マーカーの不適合）。"""
    return len(result.findings) + len([m for m in result.upstream_markers if not m["ok"]])


def has_drift(result: ScanResult) -> bool:
    """報告 issue を open のままにすべきか。

    UNKNOWN が 1 件でも残っている間は「乖離が解消した」と言えない。検査できて
    いないリポジトリを 0 件扱いして issue を close すると、まさにこのスキルが
    避けたい「検査不能を green に倒す」ことになるため close 条件に含める。
    """
    return drift_count(result) > 0 or len(result.unknowns) > 0


def find_report_issue(repo: str, token: str) -> tuple[int | None, str]:
    """固定タイトルの報告 issue を open / closed の**両方**から探す。

    戻り値は ``(番号, 状態)``。見つからない場合は ``(None, "")``。

    **closed も探すのが要点。** open だけを見ると、乖離が解消して close した後に
    乖離が再発したとき既存 issue を発見できず、同じタイトルの issue が新規作成
    される。「常にこの 1 件を更新する」という契約が壊れ、再発のたびに重複 issue が
    積み上がる。closed が見つかった場合は reopen して使い回す。

    ``--search`` は曖昧検索なので、これは **候補を server 側で絞る用途にだけ**
    使い、どれを掴むかは Python 側の**完全一致**で決める。`--state all` を
    件数上限だけで引くと古い固定 issue を取りこぼすため、絞り込みと完全一致の
    両方を使う。
    """
    proc = _run(
        ["gh", "issue", "list", "--repo", repo, "--state", "all",
         "--search", f"{REPORT_ISSUE_TITLE} in:title",
         "--limit", "200", "--json", "number,title,state"],
        token,
    )
    if proc.returncode != 0:
        raise ScanError(f"issue 一覧の取得に失敗: {proc.stdout.strip()} {proc.stderr.strip()}")

    matches = [
        issue
        for issue in json.loads(proc.stdout or "[]")
        if issue.get("title") == REPORT_ISSUE_TITLE
    ]
    if not matches:
        return None, ""
    # 万一重複が生まれていても open を優先し、次いで番号の小さい（= 最初に作られた）
    # ものを正とする。日替わりで掴む issue が変わらないよう順序を決め打ちする。
    matches.sort(key=lambda i: (str(i.get("state", "")).upper() != "OPEN", i.get("number", 0)))
    return matches[0].get("number"), str(matches[0].get("state", "")).upper()


def sync_report_issue(repo: str, token: str, body_file: str, has_drift: bool) -> str:
    number, state = find_report_issue(repo, token)

    if has_drift:
        if number is None:
            proc = _run(
                ["gh", "issue", "create", "--repo", repo,
                 "--title", REPORT_ISSUE_TITLE, "--body-file", body_file],
                token,
            )
            if proc.returncode != 0:
                raise ScanError(f"issue 作成に失敗: {proc.stdout} {proc.stderr}")
            return f"issue を新規作成: {proc.stdout.strip()}"

        reopened = ""
        if state == "CLOSED":
            # 乖離が再発した。新規作成せず既存 issue を再利用する。
            proc = _run(["gh", "issue", "reopen", str(number), "--repo", repo], token)
            if proc.returncode != 0:
                raise ScanError(f"issue の再オープンに失敗: {proc.stdout} {proc.stderr}")
            reopened = "（乖離が再発したため再オープン）"

        proc = _run(
            ["gh", "issue", "edit", str(number), "--repo", repo, "--body-file", body_file],
            token,
        )
        if proc.returncode != 0:
            raise ScanError(f"issue 更新に失敗: {proc.stdout} {proc.stderr}")
        return f"issue #{number} の本文を更新{reopened}"

    if number is None:
        return "乖離 0 件・報告 issue も無し（何もしない）"
    if state == "CLOSED":
        return f"乖離 0 件・報告 issue #{number} は既に closed（何もしない）"

    _run(
        ["gh", "issue", "comment", str(number), "--repo", repo,
         "--body", "乖離が 0 件になったため close する。詳細は最新の実行サマリを参照。"],
        token,
    )
    proc = _run(["gh", "issue", "close", str(number), "--repo", repo], token)
    if proc.returncode != 0:
        raise ScanError(f"issue クローズに失敗: {proc.stdout} {proc.stderr}")
    return f"乖離 0 件のため issue #{number} をクローズ"


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------


def main() -> int:
    org = os.environ.get("TARGET_ORG", "Fandhe-AI")
    report_repo = os.environ.get("REPORT_REPO", "")
    read_token = os.environ.get("READ_TOKEN", "")
    issue_token = os.environ.get("ISSUE_TOKEN", "")
    run_url = os.environ.get("RUN_URL", "")

    # PAT 不在は「黙って 0 件検出」と区別できないため必ず失敗させる。
    if not read_token:
        print(
            "::error::組織シークレット SUBMODULE_PAT (visibility: all) が未設定。"
            "GITHUB_TOKEN では他リポジトリを読み取れず、検査したのか"
            "乖離が無いのかを区別できないため fail-closed で停止する。"
        )
        return 1

    # 軸 5 のしきい値。不正値・0 以下を既定へ黙ってフォールバックさせない
    # （運用ミスで緩い値のまま走り続けるのを避ける。A05 設定ミス対策）。
    schedule_stale_days_raw = os.environ.get("SCHEDULE_STALE_DAYS", "")
    if schedule_stale_days_raw:
        try:
            schedule_stale_days = int(schedule_stale_days_raw)
        except ValueError:
            print(
                f"::error::SCHEDULE_STALE_DAYS の値が不正（{schedule_stale_days_raw!r}）。"
                "整数を指定すること。"
            )
            return 1
        if schedule_stale_days <= 0:
            print(
                f"::error::SCHEDULE_STALE_DAYS は正の整数にすること"
                f"（指定値: {schedule_stale_days}）。"
            )
            return 1
    else:
        schedule_stale_days = SCHEDULE_STALE_DAYS_DEFAULT

    try:
        result = scan(org, read_token, schedule_stale_days)
    except ScanError as exc:
        print(f"::error::スキャンに失敗した（乖離 0 件と区別できないため失敗扱い）: {exc}")
        return 1

    report = render_report(result, run_url)

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(report + "\n")
    else:
        print(report)

    drift = drift_count(result)
    open_issue = has_drift(result)

    if report_repo:
        body_file = os.environ.get("REPORT_BODY_FILE", "drift-report.md")
        with open(body_file, "w", encoding="utf-8") as fh:
            fh.write(report)
        try:
            print(sync_report_issue(report_repo, issue_token, body_file, open_issue))
        except ScanError as exc:
            print(f"::error::報告 issue の同期に失敗: {exc}")
            return 1

    print(f"乖離 {drift} 件 / UNKNOWN {len(result.unknowns)} 件 / 検査 {result.scanned} リポ")
    # 乖離が見つかったこと自体ではジョブを失敗させない（報告が仕事）。
    return 0


if __name__ == "__main__":
    sys.exit(main())

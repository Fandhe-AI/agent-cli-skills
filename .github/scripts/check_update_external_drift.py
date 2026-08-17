#!/usr/bin/env python3
"""Fandhe-AI 配下リポジトリの ``update-external.yml`` 乖離検知。

このスクリプトの役割
--------------------
下流リポジトリの ``.github/workflows/update-external.yml`` が、上流 reusable
workflow（``Fandhe-AI/actions/.github/workflows/update-external.yml``）の薄い
wrapper として健全に保たれているかを 4 つの軸で実測し、Markdown レポートを返す。
``.github/workflows/update-external-drift.yml`` から日次で呼ばれる。

なぜ「マーカーの grep」ではなく 4 軸なのか（イシュー #260 / #261）
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

  軸 1  wrapper か否か          … 手管理ファイルへの逆戻り（LEGACY）を検知
  軸 2  pin の鮮度              … 上流を強化しても pin が古いと届かない
  軸 3  同期 CI の欠落          … skills を vendor しているのに workflow が無い
  軸 4  上流 reusable の劣化    … 旧マーカーの意図。18 リポ分の grep が 1 ファイルへ

設計上の約束
------------
- **fail-closed。** 「乖離 0 件」と「検査できなかった」を絶対に混同しない。
  リポ列挙・上流 SHA 解決・上流ファイル取得の失敗はスキャン全体の失敗
  （終了コード 1）。個別リポの取得失敗は ``UNKNOWN`` として集計に残し、
  黙って除外しない。
- **純粋関数と I/O の分離。** 判定ロジック（``classify_workflow`` /
  ``evaluate_pin`` / ``check_upstream_markers``）は GitHub API に触れない
  純粋関数として切り出し、``test_check_update_external_drift.py`` が
  fixture に対して直接実行できるようにしてある。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

import yaml

# ---------------------------------------------------------------------------
# 除外設定（なぜ除外なのかを issue 番号付きで明示する）
# ---------------------------------------------------------------------------

# yadori はイシュー #263 によりスコープ外。#263 の決着まで検査対象に含めない。
# （リポ名で除外してよいのは「スコープ外」という運用判断だけであり、
#   「そもそも wrapper ではない」という構造的事実はハードコードに頼らず
#   下の workflow_call 自動判定で扱う。）
EXCLUDED_REPOS: dict[str, str] = {
    "yadori": "イシュー #263 によりスコープ外",
}

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

# レポートを集約する固定タイトルの issue。日次で新規 issue を作らず、
# 常にこの 1 件を更新する。
REPORT_ISSUE_TITLE = "chore(ci): update-external の乖離検知レポート"

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
        return {"kind": KIND_UNPARSEABLE, "pin": None, "reason": f"YAML パース失敗: {exc}"}

    if not isinstance(spec, dict):
        return {"kind": KIND_UNPARSEABLE, "pin": None, "reason": "YAML マッピングではない"}

    if is_upstream and has_workflow_call(spec):
        return {
            "kind": KIND_REUSABLE_DEFINITION,
            "pin": None,
            "reason": f"{UPSTREAM_REPO} の on: workflow_call を持つ reusable 定義本体"
            "のため検査対象外",
        }

    jobs = spec.get("jobs")
    if not isinstance(jobs, dict):
        return {"kind": KIND_UNPARSEABLE, "pin": None, "reason": "jobs セクションが無い"}

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
        }


    if not _SHA40_RE.match(ref):
        # reusable は参照しているが ref が 40 桁 hex ではない（``@main`` 等）。
        # LEGACY とは原因も直し方も違うので別種別として報告する。
        return {
            "kind": KIND_WRAPPER_UNPINNED,
            "pin": ref,
            "reason": f"reusable への参照が SHA 固定されていない（@{ref}）",
        }

    return {"kind": KIND_WRAPPER, "pin": ref, "reason": ""}


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


def check_upstream_markers(text: str) -> list[dict]:
    """上流 reusable workflow の強化マーカーが劣化していないかを検査する。

    旧 #260 マーカーの意図をここへ畳んでいる。戻り値は
    ``[{"marker", "ok", "detail"}, ...]``。

    重要: ``persist-credentials`` は**ジョブ単位**で判定する。submodule ジョブは
    private submodule の fetch に checkout の資格情報を使うため既定 ``true`` が
    正しく、ファイル全体の grep では skills ジョブの ``false`` と混ざって誤判定
    する（#260 本文が明示している要件）。ここでは skills ジョブの checkout の
    ``with.persist-credentials`` だけを見て、submodule ジョブ側には何も要求しない。
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

    return results


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
            "--limit", "500",
            "--json", "name,isArchived",
            "--jq", ".[] | select(.isArchived | not) | .name",
        ],
        token,
    )
    if proc.returncode != 0:
        raise ScanError(
            f"リポジトリ列挙に失敗: {proc.stdout.strip()} {proc.stderr.strip()}"
        )
    names = [n.strip() for n in proc.stdout.splitlines() if n.strip()]
    if not names:
        raise ScanError("リポジトリ列挙が 0 件を返した（列挙失敗と区別できないため失敗扱い）")
    return sorted(names)


def get_claude_skills_tree_mode(repo: str, token: str) -> str:
    """``.claude/skills`` の git tree mode を返す。

    ``120000`` = symlink / ``040000`` = 実ディレクトリ。後者はイシュー #256 の
    対象で、そのまま同期 CI を入れると日次で必ず失敗する。SYNC-CI-ABSENT を
    報告するとき、単に「CI を入れればよい」のか「先に #256 の解消が要るのか」を
    読み手が区別できるように併記する。
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


def scan(org: str, token: str) -> ScanResult:
    result = ScanResult()

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

        result.scanned += 1
        status, text = gh_get_with_status(
            f"repos/{repo}/contents/{WORKFLOW_PATH}", token, raw=True
        )

        if status == 200:
            info = classify_workflow(text, is_upstream=(repo == UPSTREAM_REPO))
            kind = info["kind"]

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
            note = ""
            if mode.startswith("040000"):
                note = (
                    "。**イシュー #256 の対象**（実ディレクトリのため、"
                    "そのまま同期 CI を入れると日次で失敗する）"
                )
            result.findings.append(
                Finding(
                    repo,
                    "SYNC-CI-ABSENT",
                    f"skills-lock.json はあるが update-external.yml が無い。"
                    f"`.claude/skills` の tree mode = {mode}{note}",
                )
            )
            continue

        # 200 / 404 以外は検査不能。黙って除外して「全リポ green」に見せない。
        msg = f"update-external.yml の取得が HTTP {status}"
        result.unknowns.append(Finding(repo, "UNKNOWN", msg))
        print(f"::warning::{repo}: {msg}")

    return result


# ---------------------------------------------------------------------------
# レポート生成
# ---------------------------------------------------------------------------


def render_report(result: ScanResult, run_url: str = "") -> str:
    """Markdown レポートを組み立てる。

    ``$GITHUB_STEP_SUMMARY`` と報告 issue の本文で同じものを使う。乖離 0 件でも
    「0 件だった」と明記する（出力が無いことと 0 件であることを混同させない）。

    長さの上限: 全 119 リポが最長の SYNC-CI-ABSENT 行になった最悪ケースで
    23,502 文字を実測（2026-08-17）。GitHub issue 本文の上限 65,536 文字に対し
    十分な余裕があるため切り詰めは行わない。
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
    if run_url:
        lines.append(f"- 実行: {run_url}")
    lines.append("")

    # 乖離 0 件でも必ず明示する（「出力が無い」と「0 件だった」を混同させない）。
    lines.append("### 軸 1-3: 下流リポジトリ")
    lines.append("")
    if result.findings:
        lines.append("| リポジトリ | 分類 | 詳細 |")
        lines.append("| --- | --- | --- |")
        for f in sorted(result.findings, key=lambda x: (x.category, x.repo)):
            lines.append(f"| `{f.repo}` | {f.category} | {f.detail} |")
    else:
        lines.append("乖離 **0 件**。全ての下流リポジトリが最新 pin の wrapper、"
                     "または skills を vendor していない。")
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

    try:
        result = scan(org, read_token)
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

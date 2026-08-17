#!/usr/bin/env python3
"""``check_update_external_drift.py`` の判定ロジックを fixture で検証する。

このワークフローは「検出できること」が仕事なので、ジョブが緑になるだけでは
何も証明しない。ここでは GitHub API に触れない純粋関数
（``classify_workflow`` / ``evaluate_pin`` / ``check_upstream_markers``）を
インラインの fixture へ直接当て、各分類・pin 比較・軸 4 のジョブ単位判定が
意図どおりに転ぶことを実測する。

実行:
    python3 .github/scripts/test_check_update_external_drift.py

標準ライブラリの unittest のみを使う（本リポには Python の依存管理が無いため。
PyYAML だけは検査対象そのものが YAML 構造走査であり代替不能）。
"""

from __future__ import annotations

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import check_update_external_drift as cud  # noqa: E402
from check_update_external_drift import (  # noqa: E402
    KIND_LEGACY,
    KIND_REUSABLE_DEFINITION,
    KIND_WRAPPER,
    KIND_WRAPPER_UNPINNED,
    PIN_BEHIND,
    PIN_CURRENT,
    PIN_UNREACHABLE,
    check_upstream_markers,
    classify_workflow,
    evaluate_pin,
    norm,
)

UPSTREAM_SHA = "fed9c07d98367f77e5e2b63bca38843f46feee96"
OLD_PIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
# compare が 429 を返す pin。「検査できなかった」であって「壊れた pin」ではない。
RATE_LIMITED_PIN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

# --- fixture: 上流 reusable workflow を SHA 固定で呼ぶ薄い wrapper ---------
FIXTURE_WRAPPER = """
name: Update external sources
on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  update-external:
    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{pin} # main
    secrets:
      SUBMODULE_PAT: ${{{{ secrets.SUBMODULE_PAT }}}}
"""

# --- fixture: reusable を参照しているが @main で未 pin -----------------------
FIXTURE_WRAPPER_UNPINNED = """
name: Update external sources
on:
  workflow_dispatch:
jobs:
  update-external:
    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@main
"""

# --- fixture: 手管理テンプレートのまま（workflow_call を持たない）-----------
FIXTURE_LEGACY = """
name: Update external sources
on:
  schedule:
    - cron: '0 0 * * *'
jobs:
  skills:
    name: Update agent skills
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
        with:
          persist-credentials: false
      - uses: Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96
        with:
          skills-version: '1.5.22'
"""

# --- fixture: reusable 定義本体（on: workflow_call を持つ）------------------
# ここで PyYAML が `on:` キーを Python の True へ落とす挙動を踏む。
# spec["on"] だけを見る実装だとこの fixture が LEGACY へ転び、定義本体が
# 乖離として誤報される。
FIXTURE_REUSABLE_DEFINITION = """
name: Update external sources (reusable)
on:
  workflow_call:
    inputs:
      target:
        type: string
        required: false
        default: all
jobs:
  skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
"""

# --- fixture: 軸 4 の本命。skills ジョブだけ persist-credentials: false、
#     submodule ジョブは **キー自体が無い**（= 既定 true）。ファイル全体の
#     grep だと `persist-credentials: false` が 1 件見つかるだけで両ジョブを
#     区別できず、逆に「両方 false であること」を要求する実装だと誤って落ちる。
FIXTURE_UPSTREAM_OK = """
name: Update external sources (reusable)
on:
  workflow_call: {}
jobs:
  submodule:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
        with:
          submodules: recursive
          token: ${{ secrets.SUBMODULE_PAT }}
      - name: Update submodules and open PR
        uses: Fandhe-AI/actions/submodule-update@fed9c07d98367f77e5e2b63bca38843f46feee96
        with:
          auto-merge-immediate-fallback: 'false'
  skills:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with:
          node-version: '24.19.0'
      - name: Update skills and open PR
        uses: Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96
        with:
          source-token: ${{ github.token }}
          skills-version: '1.5.22'
          auto-merge-immediate-fallback: 'false'
"""

# 同じ内容で submodule ジョブ側が **明示的に true** を書いている版。
# 「キーが無い」と「true と書いてある」の両方の綴りで適合すること。
FIXTURE_UPSTREAM_OK_EXPLICIT_TRUE = FIXTURE_UPSTREAM_OK.replace(
    """          submodules: recursive""",
    """          submodules: recursive
          persist-credentials: true""",
)

# --- fixture: 劣化版。skills ジョブが persist-credentials を落とし、
#     source-token 未指定、skills-version が latest、node-version がメジャーのみ、
#     auto-merge-immediate-fallback が未指定（既定 true = fail-open）。
FIXTURE_UPSTREAM_DEGRADED = """
name: Update external sources (reusable)
on:
  workflow_call: {}
jobs:
  submodule:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
      - uses: Fandhe-AI/actions/submodule-update@fed9c07d98367f77e5e2b63bca38843f46feee96
  skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with:
          node-version: 20
      - uses: Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96
        with:
          skills-version: latest
"""


def markers_map(text: str) -> dict[str, dict]:
    return {m["marker"]: m for m in check_upstream_markers(text)}


class TestNorm(unittest.TestCase):
    def test_yaml_bool_and_string_and_int(self):
        # PyYAML は引用符なし false を bool、'false' を str、20 を int にする。
        # 比較の前に必ず同じ土俵へ載せる。
        self.assertEqual(norm(False), "false")
        self.assertEqual(norm("false"), "false")
        self.assertEqual(norm(True), "true")
        self.assertEqual(norm(20), "20")
        self.assertEqual(norm(None), "")


class TestAxis1Classification(unittest.TestCase):
    def test_wrapper_pinned(self):
        info = classify_workflow(FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA))
        self.assertEqual(info["kind"], KIND_WRAPPER)
        self.assertEqual(info["pin"], UPSTREAM_SHA)

    def test_wrapper_unpinned_is_drift_not_legacy(self):
        info = classify_workflow(FIXTURE_WRAPPER_UNPINNED)
        self.assertEqual(info["kind"], KIND_WRAPPER_UNPINNED)
        self.assertEqual(info["pin"], "main")

    def test_legacy(self):
        info = classify_workflow(FIXTURE_LEGACY)
        self.assertEqual(info["kind"], KIND_LEGACY)

    def test_reusable_uses_inside_comment_is_still_legacy(self):
        # 原文への正規表現だと、導入手順を貼っただけのコメントにマッチして
        # 手管理 workflow が WRAPPER と誤認される。その SHA がたまたま最新なら
        # wrappers_ok に入り LEGACY 検知をまるごと迂回してしまう。
        # 判定はパース済みの jobs.<job>.uses だけを見ること。
        commented = FIXTURE_LEGACY.replace(
            "jobs:",
            "# 移行手順:\n"
            "#     uses: Fandhe-AI/actions/.github/workflows/update-external.yml@"
            + UPSTREAM_SHA
            + " # main\njobs:",
        )
        self.assertIn(
            "Fandhe-AI/actions/.github/workflows/update-external.yml", commented
        )  # 原文 grep なら WRAPPER になる
        info = classify_workflow(commented)
        self.assertEqual(info["kind"], KIND_LEGACY)
        self.assertIsNone(info["pin"])

    def test_step_level_uses_is_not_a_wrapper(self):
        # reusable workflow の呼び出しは job-level uses のみ。step の uses に
        # 同じ文字列があっても wrapper ではない。
        stepwise = """
name: Update external sources
on:
  workflow_dispatch:
jobs:
  bogus:
    runs-on: ubuntu-latest
    steps:
      - uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{sha}
""".format(sha=UPSTREAM_SHA)
        self.assertEqual(classify_workflow(stepwise)["kind"], KIND_LEGACY)





    def test_reusable_definition_is_excluded(self):
        # 上流本体でのみ除外される（on: が True キーへ落ちても検出できること）。
        info = classify_workflow(FIXTURE_REUSABLE_DEFINITION, is_upstream=True)
        self.assertEqual(info["kind"], KIND_REUSABLE_DEFINITION)

    def test_real_upstream_definition_is_excluded(self):
        info = classify_workflow(FIXTURE_UPSTREAM_OK, is_upstream=True)
        self.assertEqual(info["kind"], KIND_REUSABLE_DEFINITION)

    def test_downstream_workflow_call_is_not_excluded(self):
        # 下流が update-external.yml に workflow_call を足しただけで検査対象から
        # 消えてはならない（全下流を wrapper として監視する契約への偽陰性）。
        info = classify_workflow(FIXTURE_REUSABLE_DEFINITION, is_upstream=False)
        self.assertEqual(info["kind"], KIND_LEGACY)

    def test_upstream_without_workflow_call_is_not_excluded(self):
        # 上流リポでも workflow_call が無ければ除外しない（AND 条件であること）。
        info = classify_workflow(FIXTURE_LEGACY, is_upstream=True)
        self.assertEqual(info["kind"], KIND_LEGACY)


class TestAxis2Pin(unittest.TestCase):
    def test_pin_current_by_equality(self):
        v = evaluate_pin(UPSTREAM_SHA, UPSTREAM_SHA, None)
        self.assertEqual(v["state"], PIN_CURRENT)

    def test_pin_current_by_identical_status(self):
        v = evaluate_pin(OLD_PIN, UPSTREAM_SHA,
                         {"status": "identical", "ahead_by": 0, "behind_by": 0})
        self.assertEqual(v["state"], PIN_CURRENT)

    def test_pin_behind_reports_ahead_by(self):
        # compare(base=pin, head=main) の ahead_by は「main が pin より先行した数」
        # = pin が遅れている数。behind_by ではない。
        v = evaluate_pin(OLD_PIN, UPSTREAM_SHA,
                         {"status": "ahead", "ahead_by": 7, "behind_by": 0})
        self.assertEqual(v["state"], PIN_BEHIND)
        self.assertEqual(v["behind"], 7)

    def test_pin_diverged_is_unreachable(self):
        v = evaluate_pin(OLD_PIN, UPSTREAM_SHA,
                         {"status": "diverged", "ahead_by": 3, "behind_by": 2})
        self.assertEqual(v["state"], PIN_UNREACHABLE)

    def test_pin_404_is_unreachable_not_green(self):
        v = evaluate_pin(OLD_PIN, UPSTREAM_SHA, None)
        self.assertEqual(v["state"], PIN_UNREACHABLE)


class TestAxis4JobScoped(unittest.TestCase):
    MARKER_PC = "skills ジョブの persist-credentials: false"

    def test_healthy_upstream_all_markers_ok(self):
        for m in check_upstream_markers(FIXTURE_UPSTREAM_OK):
            self.assertTrue(m["ok"], f"{m['marker']}: {m['detail']}")

    def test_job_scoped_persist_credentials_absent_submodule_key(self):
        # skills ジョブだけ false・submodule ジョブはキー無し（既定 true）→ 適合。
        m = markers_map(FIXTURE_UPSTREAM_OK)[self.MARKER_PC]
        self.assertTrue(m["ok"], m["detail"])

    def test_job_scoped_persist_credentials_explicit_true_submodule(self):
        # submodule ジョブが明示的に true → それでも適合（検査対象外だから）。
        m = markers_map(FIXTURE_UPSTREAM_OK_EXPLICIT_TRUE)[self.MARKER_PC]
        self.assertTrue(m["ok"], m["detail"])

    def test_job_identified_by_action_not_name(self):
        # ジョブ名を変えても composite action で同定できること。
        renamed = FIXTURE_UPSTREAM_OK.replace("  skills:", "  agent-skill-sync:")
        m = markers_map(renamed)[self.MARKER_PC]
        self.assertTrue(m["ok"], m["detail"])

    def test_lookalike_action_is_not_accepted(self):
        # 前方一致だと skills-update-malicious まで正規 action として認識される。
        # `@` より前のパスの完全一致で同定すること。
        lookalike = FIXTURE_UPSTREAM_OK.replace(
            "Fandhe-AI/actions/skills-update@", "Fandhe-AI/actions/skills-update-malicious@"
        )
        mm = markers_map(lookalike)
        self.assertFalse(mm["skills ジョブの同定"]["ok"])

    def test_lookalike_checkout_is_not_accepted(self):
        lookalike = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Checkout\n        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10\n        with:\n          persist-credentials: false",
            "      - name: Checkout\n        uses: actions/checkout-wrapper@df4cb1c069e1874edd31b4311f1884172cec0e10\n        with:\n          persist-credentials: false",
        )
        mm = markers_map(lookalike)
        self.assertFalse(mm["skills ジョブの persist-credentials: false"]["ok"])

    def test_degraded_upstream_flags_every_marker(self):
        mm = markers_map(FIXTURE_UPSTREAM_DEGRADED)
        self.assertFalse(mm[self.MARKER_PC]["ok"])
        self.assertFalse(mm["skills ジョブの source-token 明示"]["ok"])
        self.assertFalse(mm["skills ジョブの auto-merge-immediate-fallback: 'false'"]["ok"])
        self.assertFalse(mm["submodule ジョブの auto-merge-immediate-fallback: 'false'"]["ok"])
        self.assertFalse(mm["skills-version の固定"]["ok"])
        # node-version: 20（引用符なし int）はメジャーのみ指定として落ちる。
        self.assertFalse(mm["node-version の LTS フル指定"]["ok"])

    def test_naive_grep_would_pass_degraded_but_job_scope_catches_it(self):
        # submodule ジョブにだけ persist-credentials: false を書いた偽陽性ケース。
        # ファイル全体 grep なら「false がある」で通ってしまうが、skills ジョブの
        # checkout には無いので不適合と判定されなければならない。
        misplaced = FIXTURE_UPSTREAM_OK.replace(
            """      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
        with:
          persist-credentials: false""",
            """      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10""",
        ).replace(
            """          submodules: recursive""",
            """          submodules: recursive
          persist-credentials: false""",
        )
        self.assertIn("persist-credentials: false", misplaced)  # grep なら通る
        m = markers_map(misplaced)[self.MARKER_PC]
        self.assertFalse(m["ok"], m["detail"])


class TestScanEndToEnd(unittest.TestCase):
    """``scan()`` を偽の GitHub API に当て、軸 1-4 を通しで確認する。

    軸 3（ファイル無し + skills-lock あり + tree mode）はネットワーク I/O の
    分岐そのものなので、純粋関数だけでは検証できない。``gh_*`` を差し替えて
    HTTP status のシナリオを与える。
    """

    def _fake_api(self, repos: dict[str, dict]):
        """``gh_get_with_status`` の代替を返す。

        ``repos`` は ``{リポ名: {"workflow": (status, text), "lock": status,
        "tree": mode}}``。
        """
        def fake(path: str, token: str, raw: bool = False):
            if path.startswith(f"repos/{cud.UPSTREAM_REPO}/contents/"):
                return 200, FIXTURE_UPSTREAM_OK
            if path.startswith(f"repos/{cud.UPSTREAM_REPO}/compare/"):
                pin = path.split("/compare/")[1].split("...")[0]
                if pin == OLD_PIN:
                    return 200, '{"status":"ahead","ahead_by":7,"behind_by":0}'
                if pin == RATE_LIMITED_PIN:
                    # レート制限。pin が壊れている証拠にはならない。
                    return 429, ""
                return 404, ""
            for name, cfg in repos.items():
                prefix = f"repos/Fandhe-AI/{name}/"
                if not path.startswith(prefix):
                    continue
                if path.endswith(cud.WORKFLOW_PATH):
                    return cfg["workflow"]
                if path.endswith("skills-lock.json"):
                    return cfg.get("lock", 404), ""
                if path.endswith("git/trees/HEAD"):
                    return 200, ('{"tree":[{"path":".claude","type":"tree",'
                                 '"mode":"040000","sha":"deadbeef"}]}')
                if "git/trees/deadbeef" in path:
                    mode = cfg.get("tree", "040000")
                    return 200, ('{"tree":[{"path":"skills","type":"tree","mode":"'
                                 + mode + '"}]}')
            raise AssertionError(f"想定外の API 呼び出し: {path}")
        return fake

    def _run_scan(self, repos: dict[str, dict]):
        orig = (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos)
        cud.gh_get_with_status = self._fake_api(repos)
        cud.gh_json = lambda path, token, jq=None: UPSTREAM_SHA
        cud.list_target_repos = lambda org, token: sorted(repos)
        try:
            return cud.scan("Fandhe-AI", "fake-token")
        finally:
            (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos) = orig

    def test_all_four_axes(self):
        result = self._run_scan({
            # 軸 1+2: 最新 pin の wrapper → 乖離なし
            "fresh-wrapper": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA)),
            },
            # 軸 2: 旧 pin → behind 件数付きで乖離
            "stale-wrapper": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin=OLD_PIN)),
            },
            # 軸 1: 手管理のまま → 乖離
            "legacy-repo": {"workflow": (200, FIXTURE_LEGACY)},
            # 軸 1: reusable 定義本体 → 除外
            "actions": {"workflow": (200, FIXTURE_UPSTREAM_OK)},
            # 軸 3: ファイル無し + lock あり + 実ディレクトリ → SYNC-CI-ABSENT + #256
            "vendored-no-ci": {"workflow": (404, ""), "lock": 200, "tree": "040000"},
            # 軸 3: ファイル無し + lock あり + symlink → SYNC-CI-ABSENT（#256 対象外）
            "vendored-symlink": {"workflow": (404, ""), "lock": 200, "tree": "120000"},
            # ファイル無し + lock 無し → 対象外（乖離ではない）
            "unrelated": {"workflow": (404, ""), "lock": 404},
            # 下流が workflow_call を足しても除外されない（偽陰性の防止）
            "sneaky-workflow-call": {"workflow": (200, FIXTURE_REUSABLE_DEFINITION)},
            # 検査不能 → UNKNOWN（黙って green にしない）
            "forbidden": {"workflow": (403, "")},
            # 除外リスト（イシュー #263）
            "yadori": {"workflow": (200, FIXTURE_LEGACY)},
        })

        cats = {f.repo.split("/")[1]: (f.category, f.detail) for f in result.findings}

        self.assertEqual(result.wrappers_ok, ["Fandhe-AI/fresh-wrapper"])
        self.assertEqual(cats["stale-wrapper"][0], "PIN-STALE")
        self.assertIn("7 コミット遅れている", cats["stale-wrapper"][1])
        self.assertEqual(cats["legacy-repo"][0], "LEGACY")
        self.assertEqual(cats["sneaky-workflow-call"][0], "LEGACY")

        self.assertEqual(cats["vendored-no-ci"][0], "SYNC-CI-ABSENT")
        self.assertIn("040000", cats["vendored-no-ci"][1])
        self.assertIn("#256", cats["vendored-no-ci"][1])

        self.assertEqual(cats["vendored-symlink"][0], "SYNC-CI-ABSENT")
        self.assertIn("120000", cats["vendored-symlink"][1])
        self.assertNotIn("#256", cats["vendored-symlink"][1])

        self.assertNotIn("actions", cats)
        self.assertNotIn("unrelated", cats)
        self.assertNotIn("yadori", cats)
        self.assertIn("Fandhe-AI/unrelated", result.no_workflow_ok)

        excluded = {r.split("/")[1] for r, _ in result.excluded}
        self.assertEqual(excluded, {"actions", "yadori"})

        self.assertEqual([f.repo for f in result.unknowns], ["Fandhe-AI/forbidden"])
        # 軸 4 は健全な fixture を上流としているため全マーカー適合。
        self.assertTrue(all(m["ok"] for m in result.upstream_markers))

        # レポートは乖離 0 件でも全量を出す契約。ここでは 4 件出ることを確認する。
        report = cud.render_report(result, "https://example.invalid/run/1")
        self.assertIn("乖離: **5 件**", report)
        self.assertIn("検査不能 (UNKNOWN): **1 件**", report)

    def test_compare_error_is_unknown_not_unreachable(self):
        # compare が 429。到達不能な pin (乖離) ではなく UNKNOWN として扱う。
        result = self._run_scan({
            "rate-limited": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin=RATE_LIMITED_PIN)),
            },
        })
        self.assertEqual(result.findings, [])
        self.assertEqual(len(result.unknowns), 1)
        self.assertIn("HTTP 429", result.unknowns[0].detail)
        self.assertTrue(cud.has_drift(result))  # UNKNOWN が残る間は close しない

    def test_compare_404_is_unreachable_pin_drift(self):
        # 404 は「その SHA が上流に存在しない」= 到達不能な pin。乖離として扱う。
        result = self._run_scan({
            "ghost-pin": {"workflow": (200, FIXTURE_WRAPPER.format(pin="c" * 40))},
        })
        self.assertEqual(result.unknowns, [])
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].category, "PIN-UNREACHABLE")

    def test_zero_drift_report_says_zero(self):
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA))},
        })
        report = cud.render_report(result)
        self.assertIn("乖離: **0 件**", report)
        self.assertIn("乖離 **0 件**", report)
        self.assertIn("検査不能なリポジトリは **0 件**", report)
        # 乖離も UNKNOWN も無いときだけ issue を close してよい。
        self.assertEqual(cud.drift_count(result), 0)
        self.assertFalse(cud.has_drift(result))

    def test_unknown_alone_keeps_issue_open(self):
        # 乖離 0 件だが検査不能が 1 件。「解消した」と言えないので close しない。
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA))},
            "forbidden": {"workflow": (403, "")},
        })
        self.assertEqual(cud.drift_count(result), 0)
        self.assertEqual(len(result.unknowns), 1)
        self.assertTrue(cud.has_drift(result))

    def test_upstream_marker_failure_alone_is_drift(self):
        # 下流が全て健全でも、上流 reusable が劣化していれば乖離として扱う。
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA))},
        })
        result.upstream_markers = [{"marker": "dummy", "ok": False, "detail": "劣化"}]
        self.assertEqual(cud.drift_count(result), 1)
        self.assertTrue(cud.has_drift(result))


class TestRepoEnumeration(unittest.TestCase):
    """列挙の不完全さを「乖離 0 件」に化けさせない。"""

    def _with_stdout(self, stdout: str):
        class Proc:
            returncode = 0
            stderr = ""
            def __init__(self, out): self.stdout = out
        orig = cud._run
        cud._run = lambda args, token=None: Proc(stdout)
        return orig

    def test_hitting_the_limit_is_fail_closed(self):
        # 上限ちょうど = 打ち切られた可能性。残りが黙って検査対象外になる。
        names = "\n".join(f"repo-{i}\tfalse" for i in range(cud.REPO_LIST_LIMIT))
        orig = self._with_stdout(names)
        try:
            with self.assertRaises(cud.ScanError) as ctx:
                cud.list_target_repos("Fandhe-AI", "tok")
            self.assertIn(str(cud.REPO_LIST_LIMIT), str(ctx.exception))
        finally:
            cud._run = orig

    def test_empty_enumeration_is_fail_closed(self):
        orig = self._with_stdout("")
        try:
            with self.assertRaises(cud.ScanError):
                cud.list_target_repos("Fandhe-AI", "tok")
        finally:
            cud._run = orig

    def test_limit_check_counts_rows_not_post_filter_names(self):
        # --limit は API 取得件数（フィルタ前）の上限。窓にアーカイブ済みが
        # 混じるとフィルタ後の件数は上限を下回るため、フィルタ後で判定すると
        # 実際には打ち切られているのにガードが発火しない。
        rows = [f"repo-{i}\ttrue" for i in range(cud.REPO_LIST_LIMIT // 2)]
        rows += [f"repo-{i}\tfalse" for i in range(cud.REPO_LIST_LIMIT - len(rows))]
        self.assertEqual(len(rows), cud.REPO_LIST_LIMIT)
        # フィルタ後は上限の半分しかないが、取得行数は上限ちょうど。
        orig = self._with_stdout("\n".join(rows))
        try:
            with self.assertRaises(cud.ScanError):
                cud.list_target_repos("Fandhe-AI", "tok")
        finally:
            cud._run = orig

    def test_archived_repos_are_filtered_out(self):
        orig = self._with_stdout("live\tfalse\ndead\ttrue\n")
        try:
            self.assertEqual(cud.list_target_repos("Fandhe-AI", "tok"), ["live"])
        finally:
            cud._run = orig

    def test_normal_enumeration_is_sorted(self):
        orig = self._with_stdout("zeta\tfalse\nalpha\tfalse\n")
        try:
            self.assertEqual(cud.list_target_repos("Fandhe-AI", "tok"), ["alpha", "zeta"])
        finally:
            cud._run = orig


class TestReportIssueLifecycle(unittest.TestCase):
    """報告 issue は「常に 1 件を更新する」契約。新規作成を繰り返さない。"""

    def _fake_run(self, issues: list[dict]):
        """``_run`` の代替。呼ばれた gh コマンドを記録して返す。"""
        calls: list[list[str]] = []

        class Proc:
            def __init__(self, stdout=""):
                self.returncode = 0
                self.stdout = stdout
                self.stderr = ""

        def fake(args, token=None):
            calls.append(args)
            if args[:3] == ["gh", "issue", "list"]:
                return Proc(json.dumps(issues))
            return Proc("https://example.invalid/issues/1")

        return fake, calls

    def _sync(self, issues: list[dict], has_drift: bool):
        fake, calls = self._fake_run(issues)
        orig = cud._run
        cud._run = fake
        try:
            msg = cud.sync_report_issue("o/r", "tok", "body.md", has_drift)
        finally:
            cud._run = orig
        verbs = [a[2] for a in calls if a[:2] == ["gh", "issue"]]
        return msg, verbs

    def test_searches_closed_issues_too(self):
        # --state all で引かないと closed の固定 issue を見つけられない。
        fake, calls = self._fake_run([])
        orig = cud._run
        cud._run = fake
        try:
            cud.find_report_issue("o/r", "tok")
        finally:
            cud._run = orig
        self.assertIn("--state", calls[0])
        self.assertEqual(calls[0][calls[0].index("--state") + 1], "all")

    def test_reopens_closed_issue_instead_of_creating_new(self):
        # 乖離の再発。close 済みの既存 issue を reopen して使い回す。
        msg, verbs = self._sync(
            [{"number": 42, "title": cud.REPORT_ISSUE_TITLE, "state": "CLOSED"}],
            has_drift=True,
        )
        self.assertIn("reopen", verbs)
        self.assertIn("edit", verbs)
        self.assertNotIn("create", verbs)
        self.assertIn("#42", msg)

    def test_updates_open_issue_without_reopen(self):
        msg, verbs = self._sync(
            [{"number": 42, "title": cud.REPORT_ISSUE_TITLE, "state": "OPEN"}],
            has_drift=True,
        )
        self.assertIn("edit", verbs)
        self.assertNotIn("reopen", verbs)
        self.assertNotIn("create", verbs)

    def test_creates_only_when_no_issue_exists(self):
        msg, verbs = self._sync([], has_drift=True)
        self.assertIn("create", verbs)

    def test_ignores_titles_that_are_not_exact_matches(self):
        # --search は曖昧検索。掴む issue は Python 側の完全一致で決める。
        msg, verbs = self._sync(
            [{"number": 7, "title": cud.REPORT_ISSUE_TITLE + " (旧)", "state": "OPEN"}],
            has_drift=True,
        )
        self.assertIn("create", verbs)

    def test_closes_open_issue_when_clean(self):
        msg, verbs = self._sync(
            [{"number": 42, "title": cud.REPORT_ISSUE_TITLE, "state": "OPEN"}],
            has_drift=False,
        )
        self.assertIn("comment", verbs)
        self.assertIn("close", verbs)

    def test_already_closed_issue_is_left_alone(self):
        msg, verbs = self._sync(
            [{"number": 42, "title": cud.REPORT_ISSUE_TITLE, "state": "CLOSED"}],
            has_drift=False,
        )
        self.assertNotIn("close", verbs)
        self.assertNotIn("comment", verbs)

    def test_prefers_open_when_duplicates_exist(self):
        msg, verbs = self._sync(
            [
                {"number": 9, "title": cud.REPORT_ISSUE_TITLE, "state": "CLOSED"},
                {"number": 42, "title": cud.REPORT_ISSUE_TITLE, "state": "OPEN"},
            ],
            has_drift=True,
        )
        self.assertIn("#42", msg)
        self.assertNotIn("reopen", verbs)


if __name__ == "__main__":
    unittest.main(verbosity=2)

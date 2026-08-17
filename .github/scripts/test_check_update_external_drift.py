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

    def test_reusable_definition_is_excluded(self):
        # リポ名のハードコードなしで除外できること（on: が True キーに落ちても）。
        info = classify_workflow(FIXTURE_REUSABLE_DEFINITION)
        self.assertEqual(info["kind"], KIND_REUSABLE_DEFINITION)

    def test_real_upstream_definition_is_excluded(self):
        info = classify_workflow(FIXTURE_UPSTREAM_OK)
        self.assertEqual(info["kind"], KIND_REUSABLE_DEFINITION)


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
        self.assertIn("乖離: **4 件**", report)
        self.assertIn("検査不能 (UNKNOWN): **1 件**", report)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)

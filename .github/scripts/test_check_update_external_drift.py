#!/usr/bin/env python3
"""``check_update_external_drift.py`` の判定ロジックを fixture で検証する。

このワークフローは「検出できること」が仕事なので、ジョブが緑になるだけでは
何も証明しない。ここでは GitHub API に触れない純粋関数
（``classify_workflow`` / ``evaluate_latest_tag`` / ``check_upstream_markers``）を
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
    KIND_WRAPPER_BADREF,
    TAG_CURRENT,
    TAG_STALE,
    SCHED_DISABLED,
    SCHED_FAILING,
    SCHED_OK,
    SCHED_STALE,
    SCHED_UNKNOWN,
    check_upstream_markers,
    classify_workflow,
    evaluate_latest_tag,
    evaluate_schedule,
    has_schedule_trigger,
    norm,
)
from datetime import datetime, timedelta, timezone

UPSTREAM_SHA = "fed9c07d98367f77e5e2b63bca38843f46feee96"
OLD_PIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# 上流 `latest` タグの既定応答（軸 2 = タグの鮮度）。健全状態を既定にし、
# stale / 取得失敗を検証するテストだけがこの値を差し替える。
LATEST_TAG_RESPONSE: tuple[int, str] = (
    200, '{"object": {"sha": "' + UPSTREAM_SHA + '", "type": "commit"}}'
)
# compare が 429 を返す pin。「検査できなかった」であって「壊れた pin」ではない。

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
    def test_wrapper_latest_is_ok(self):
        info = classify_workflow(FIXTURE_WRAPPER.format(pin="latest"))
        self.assertEqual(info["kind"], KIND_WRAPPER)
        self.assertEqual(info["pin"], "latest")

    def test_wrapper_sha_pin_is_drift_not_legacy(self):
        # SHA pin へ戻すのは方針からの退行。LEGACY とは直し方が違うので別種別。
        info = classify_workflow(FIXTURE_WRAPPER.format(pin=UPSTREAM_SHA))
        self.assertEqual(info["kind"], KIND_WRAPPER_BADREF)
        self.assertEqual(info["pin"], UPSTREAM_SHA)

    def test_wrapper_branch_ref_is_drift_not_legacy(self):
        info = classify_workflow(FIXTURE_WRAPPER_UNPINNED)
        self.assertEqual(info["kind"], KIND_WRAPPER_BADREF)
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


class TestAxis2LatestTag(unittest.TestCase):
    def test_tag_current(self):
        v = evaluate_latest_tag(UPSTREAM_SHA, UPSTREAM_SHA)
        self.assertEqual(v["state"], TAG_CURRENT)

    def test_tag_stale_reports_both_shas(self):
        # move-latest-tag.yml が止まると latest が古いコミットに据え置かれ、
        # 全下流が静かに古い実装で動き続ける。これを乖離として報告する。
        v = evaluate_latest_tag(OLD_PIN, UPSTREAM_SHA)
        self.assertEqual(v["state"], TAG_STALE)
        self.assertIn(OLD_PIN[:12], v["detail"])
        self.assertIn(UPSTREAM_SHA[:12], v["detail"])


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

    def test_upstream_action_sha_pin_ok_denominator(self):
        # 健全 fixture は 5 件の uses（submodule: checkout + submodule-update、
        # skills: checkout + setup-node + skills-update）を持ち、全て 40 桁 SHA。
        # 実装前に実測で確認した値（`check_upstream_markers` を直接叩いて確認済み）
        # に依拠する。分母を出さないと「N == 0 で green」の誤読を検出できない。
        m = markers_map(FIXTURE_UPSTREAM_OK)["上流 action の SHA 固定"]
        self.assertTrue(m["ok"], m["detail"])
        self.assertIn("全 5 件すべて 40 桁 SHA 固定", m["detail"])

    def test_upstream_action_sha_regression_to_movable_ref(self):
        # 1 件だけ @main へ退行させると不適合になり、detail に該当 uses が出る。
        regressed = FIXTURE_UPSTREAM_OK.replace(
            "Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96",
            "Fandhe-AI/actions/skills-update@main",
        )
        m = markers_map(regressed)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("全 5 件中 1 件が未固定", m["detail"])
        self.assertIn("skills-update@main", m["detail"])

    def test_upstream_action_sha_degraded_fixture_stays_pinned(self):
        # FIXTURE_UPSTREAM_DEGRADED の uses は全て 40 桁 hex のまま（劣化させて
        # いるのは persist-credentials 等の他マーカーのみ）。このマーカーだけは
        # ok に転ぶことを確認し、既存の test_degraded_upstream_flags_every_marker
        # にこのマーカーの assertFalse を足さないことの根拠を固定する。
        m = markers_map(FIXTURE_UPSTREAM_DEGRADED)["上流 action の SHA 固定"]
        self.assertTrue(m["ok"], m["detail"])

    def test_upstream_action_sha_zero_uses_is_not_green(self):
        # `uses` が 1 件も無い上流（jobs はあるが run: のみ）は「全て SHA 固定」
        # に見えてはならない。分母 0 を green と誤読させない fail-closed 経路。
        no_uses = """
name: Update external sources (reusable)
on:
  workflow_call: {}
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
"""
        m = markers_map(no_uses)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("uses が 1 件も無い", m["detail"])

    def test_upstream_action_sha_local_action_is_exempt(self):
        # `./` で始まるローカル action は @ref の概念が無いので exempt。
        exempt = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
            "      - name: Local helper\n"
            "        uses: ./.github/actions/foo\n"
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        )
        m = markers_map(exempt)["上流 action の SHA 固定"]
        self.assertTrue(m["ok"], m["detail"])
        # exempt（`./` ローカル action）が混ざる場合は「全 N 件すべて SHA
        # 固定」と言い切らず、ok / exempt を分離して表示する
        # （PR #355 レビュー指摘: 誤表示の是正）。
        self.assertIn("全 6 件中 5 件が 40 桁 SHA 固定", m["detail"])
        self.assertIn("1 件はローカル action で対象外", m["detail"])

    def test_upstream_action_sha_all_pinned_without_exempt_says_all(self):
        # exempt が 0 件のときは従来通り「全 N 件すべて SHA 固定」と簡潔に
        # 表示する（exempt が無いのに ok/exempt 分離表記を出すと冗長）。
        m = markers_map(FIXTURE_UPSTREAM_OK)["上流 action の SHA 固定"]
        self.assertTrue(m["ok"], m["detail"])
        self.assertIn("全 5 件すべて 40 桁 SHA 固定", m["detail"])
        self.assertNotIn("対象外", m["detail"])

    def test_upstream_action_sha_docker_ref_is_fail_closed(self):
        # `docker://` は SHA 形式を判定できないため fail-closed で未固定扱い。
        docker_ref = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
            "      - name: Docker step\n"
            "        uses: docker://alpine:3\n"
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        )
        m = markers_map(docker_ref)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("docker://alpine:3", m["detail"])

    def test_upstream_action_sha_ignores_uses_in_comments(self):
        # YAML コメント行に uses: foo@main を含めても構造走査なら不適合にならない
        # （grep 実装への退行を検知するテスト。実上流ファイルの先頭コメントに
        # 実在するパターンを模している）。
        commented = "# 移行手順: uses: foo/bar@main\n" + FIXTURE_UPSTREAM_OK
        m = markers_map(commented)["上流 action の SHA 固定"]
        self.assertTrue(m["ok"], m["detail"])

    def test_upstream_action_sha_uppercase_hex_fails(self):
        # 大文字混じり hex は厳密な _SHA40_RE 不一致で fail にする。
        uppercase = FIXTURE_UPSTREAM_OK.replace(
            "Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96",
            "Fandhe-AI/actions/skills-update@FED9C07D98367F77E5E2B63BCA38843F46FEEE96",
        )
        m = markers_map(uppercase)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])

    def test_upstream_action_sha_job_level_uses_is_checked(self):
        # job-level uses（reusable workflow 呼び出し）も検査対象になること。
        job_level = FIXTURE_UPSTREAM_OK.replace(
            "jobs:\n  submodule:",
            "jobs:\n  extra:\n"
            "    uses: owner/repo/.github/workflows/x.yml@main\n"
            "  submodule:",
        )
        m = markers_map(job_level)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("x.yml@main", m["detail"])

    def test_upstream_action_sha_non_string_uses_counted_as_unpinned(self):
        # `uses: 123`（非文字列）は分母からも未固定一覧からも黙って除外されて
        # はならない。除外すると、他の全 uses が SHA 固定済みのとき
        # 「全て 40 桁 SHA 固定」と誤判定される（イシュー #302 レビュー指摘）。
        non_string = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
            "      - name: Malformed uses\n"
            "        uses: 123\n"
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        )
        m = markers_map(non_string)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"], m["detail"])
        self.assertIn("全 6 件中 1 件が未固定", m["detail"])

    def test_upstream_action_sha_empty_string_uses_counted_as_unpinned(self):
        # `uses: ""`（空文字列）も同様に分母へ含め、未固定として報告する。
        # `uses` が非空文字列の場合だけ 1 件も無い上流と同じ扱い（除外）に
        # 倒すと、「原因の異なる異常」（空文字列 vs uses 皆無）を区別できない。
        empty_uses = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
            "      - name: Empty uses\n"
            '        uses: ""\n'
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        )
        m = markers_map(empty_uses)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"], m["detail"])
        self.assertIn("全 6 件中 1 件が未固定", m["detail"])

    def test_upstream_action_sha_non_string_job_name_does_not_crash(self):
        # `jobs:` の YAML キーは `yaml.safe_load` が非文字列（数値等）を
        # 許容する。非文字列 job_name をそのまま `_sanitize_for_detail` へ
        # 渡すと `str.replace` が `AttributeError` で落ち、drift check 全体が
        # 例外終了して fail-closed 契約に反する（PR #355 レビュー指摘）。
        non_string_job = FIXTURE_UPSTREAM_OK.replace(
            "jobs:\n  submodule:",
            "jobs:\n  1:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - name: Untrusted job\n"
            "        uses: owner/repo@main\n"
            "  submodule:",
        )
        m = markers_map(non_string_job)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"], m["detail"])
        self.assertIn("`1`", m["detail"])

    def test_upstream_action_sha_dollar_slash_is_not_exempt(self):
        # `$/...` は GitHub Actions の `uses` 構文としてサポートされない
        # （公式にサポートされる同一リポジトリ参照は `./...` のみ）。
        # 「本質的に固定されている」という前提が成立しないため免除せず、
        # `@` を含まない他の値と同様に未固定として扱う
        # （PR #355 レビュー指摘: 偽陰性の是正）。
        self_repo = FIXTURE_UPSTREAM_OK.replace(
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
            "      - name: Self-repo helper\n"
            "        uses: $/.github/actions/foo\n"
            "      - name: Setup Node.js\n"
            "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        )
        m = markers_map(self_repo)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"], m["detail"])
        self.assertIn("全 6 件中 1 件が未固定", m["detail"])

    def test_upstream_action_sha_detail_escapes_pipe_for_markdown(self):
        # detail は render_report で Markdown 表の 1 セルへそのまま差し込まれる。
        # `|` を含む uses 相当の文字列がエスケープされていることを確認する
        # （上流編集者による Markdown 表破壊の防止）。
        piped = FIXTURE_UPSTREAM_OK.replace(
            "Fandhe-AI/actions/skills-update@fed9c07d98367f77e5e2b63bca38843f46feee96",
            "Fandhe-AI/actions/skills-update@main | injected",
        )
        m = markers_map(piped)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("\\|", m["detail"])
        self.assertNotIn("main | injected", m["detail"])

    def test_upstream_action_sha_detail_escapes_pipe_in_job_and_step_name(self):
        # detail は uses だけでなく job_name（`jobs.<id>` の YAML キー）と
        # display（`step.name`）も埋め込む。両方とも上流編集者が自由に
        # 設定できる文字列であり、`|` や改行を仕込むと Markdown 表破壊・
        # 誤情報注入が成立する（uses と同じ脅威モデル）。
        job_and_step_piped = FIXTURE_UPSTREAM_OK.replace(
            "jobs:\n  submodule:",
            'jobs:\n  "evil | job":\n'
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            '      - name: "bad | injected row"\n'
            "        uses: owner/repo@main\n"
            "  submodule:",
        )
        m = markers_map(job_and_step_piped)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertNotIn("evil | job", m["detail"])
        self.assertNotIn("bad | injected row", m["detail"])
        self.assertIn("evil \\| job", m["detail"])
        self.assertIn("bad \\| injected row", m["detail"])

    def test_upstream_action_sha_detail_neutralizes_backtick_code_span_escape(self):
        # job_name・step_name・uses はいずれもバッククォートで囲んで
        # コードスパンとして detail へ埋め込む。値自体にバッククォートが
        # 混ざっていると、コードスパンを途中終了させて以降を通常の
        # Markdown として解釈させられる（コードスパン脱出による Markdown
        # injection）。バッククォートが無害化され、注入した Markdown 構文
        # （リンク記法）がそのまま解釈可能な形で残らないことを確認する
        # （PR #355 レビュー指摘）。
        backticked = FIXTURE_UPSTREAM_OK.replace(
            "jobs:\n  submodule:",
            'jobs:\n  "evil` [click](javascript:1) `job":\n'
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            '      - name: "bad` step"\n'
            "        uses: owner/repo`@main\n"
            "  submodule:",
        )
        m = markers_map(backticked)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        # 値に仕込んだバッククォートが無害化され、コードスパンのデリミタと
        # して解釈され得るバッククォートは detail 中に固定 3 個
        # （job_name/step_name/uses それぞれの開始・終了 = 6 個…ではなく、
        # 隣接するセルの終端が次セルの開始と重ならないため実際は 6 個）
        # ちょうどしか残らない（＝値由来の追加バッククォートが 0 個）こと
        # を確認する。
        self.assertEqual(m["detail"].count("`"), 6)
        self.assertIn("evil' [click](javascript:1) 'job", m["detail"])
        self.assertIn("bad' step", m["detail"])
        self.assertIn("owner/repo'@main", m["detail"])

    def test_upstream_action_sha_truncates_to_five_with_total_count(self):
        # 未固定エントリが 5 件を超えても、列挙は先頭 5 件で打ち切りつつ
        # 総件数（分母 N と未固定数）は必ず数値で出す。
        many_unpinned = """
name: Update external sources (reusable)
on:
  workflow_call: {}
jobs:
  many:
    runs-on: ubuntu-latest
    steps:
      - uses: owner/repo1@main
      - uses: owner/repo2@main
      - uses: owner/repo3@main
      - uses: owner/repo4@main
      - uses: owner/repo5@main
      - uses: owner/repo6@main
"""
        m = markers_map(many_unpinned)["上流 action の SHA 固定"]
        self.assertFalse(m["ok"])
        self.assertIn("全 6 件中 6 件が未固定", m["detail"])
        self.assertIn("他 1 件", m["detail"])

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


class TestScheduleTriggerDetection(unittest.TestCase):
    """``has_schedule_trigger`` — 軸 5 の対象判定（wrapper かどうかは問わない）。"""

    def test_wrapper_with_schedule_is_true(self):
        spec_text = FIXTURE_WRAPPER.format(pin="latest")
        import yaml as _yaml
        self.assertTrue(has_schedule_trigger(_yaml.safe_load(spec_text)))

    def test_dispatch_only_wrapper_is_false(self):
        import yaml as _yaml
        self.assertFalse(has_schedule_trigger(_yaml.safe_load(FIXTURE_WRAPPER_UNPINNED)))

    def test_legacy_with_schedule_is_true(self):
        import yaml as _yaml
        self.assertTrue(has_schedule_trigger(_yaml.safe_load(FIXTURE_LEGACY)))


class TestAxis5Schedule(unittest.TestCase):
    """``evaluate_schedule`` — GitHub API に触れない純粋関数を fixture で検証する。"""

    NOW = datetime(2026, 8, 17, 19, 3, tzinfo=timezone.utc)

    def _iso(self, delta: timedelta) -> str:
        return (self.NOW - delta).strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_disabled_inactivity(self):
        v = evaluate_schedule("disabled_inactivity", None, "2020-01-01T00:00:00Z", self.NOW, 2)
        self.assertEqual(v["state"], SCHED_DISABLED)
        self.assertIn("disabled_inactivity", v["detail"])

    def test_disabled_manually(self):
        v = evaluate_schedule("disabled_manually", None, "2020-01-01T00:00:00Z", self.NOW, 2)
        self.assertEqual(v["state"], SCHED_DISABLED)
        self.assertIn("disabled_manually", v["detail"])

    def test_disabled_fork(self):
        v = evaluate_schedule("disabled_fork", None, "2020-01-01T00:00:00Z", self.NOW, 2)
        self.assertEqual(v["state"], SCHED_DISABLED)
        self.assertIn("disabled_fork", v["detail"])

    def test_disabled_reasons_have_distinct_detail(self):
        # 3 種の disabled state が同じ文言に潰れていないこと。
        details = {
            evaluate_schedule(s, None, "2020-01-01T00:00:00Z", self.NOW, 2)["detail"]
            for s in ("disabled_inactivity", "disabled_manually", "disabled_fork")
        }
        self.assertEqual(len(details), 3)

    def test_active_stale_3_days(self):
        v = evaluate_schedule(
            "active", self._iso(timedelta(days=3)), None, self.NOW, 2
        )
        self.assertEqual(v["state"], SCHED_STALE)
        self.assertIn("3.0 日経過", v["detail"])

    def test_active_ok_12_hours(self):
        v = evaluate_schedule(
            "active", self._iso(timedelta(hours=12)), None, self.NOW, 2
        )
        self.assertEqual(v["state"], SCHED_OK)

    def test_no_run_recent_created_at_is_ok_grace_period(self):
        v = evaluate_schedule(
            "active", None, self._iso(timedelta(days=1)), self.NOW, 2
        )
        self.assertEqual(v["state"], SCHED_OK)

    def test_no_run_old_created_at_is_stale_without_claiming_never_run(self):
        v = evaluate_schedule(
            "active", None, self._iso(timedelta(days=30)), self.NOW, 2
        )
        self.assertEqual(v["state"], SCHED_STALE)
        self.assertIn("直近の schedule 実行を確認できない", v["detail"])
        self.assertNotIn("一度も実行されていない", v["detail"])

    def test_timezone_offset_and_z_are_equivalent(self):
        # 実測: workflow オブジェクトは +09:00、runs は Z。同じ経過日数なら
        # 同じ判定になること。
        z = evaluate_schedule("active", "2026-08-14T02:00:09Z", None, self.NOW, 2)
        offset = evaluate_schedule(
            "active", "2026-08-14T11:00:09+09:00", None, self.NOW, 2
        )
        self.assertEqual(z["state"], offset["state"])
        self.assertEqual(z["state"], SCHED_STALE)

    def test_naive_timestamp_is_unknown_not_exception(self):
        v = evaluate_schedule("active", "2026-08-14T02:00:09", None, self.NOW, 2)
        self.assertEqual(v["state"], SCHED_UNKNOWN)

    def test_invalid_string_is_unknown_not_exception(self):
        v = evaluate_schedule("active", "not-a-date", None, self.NOW, 2)
        self.assertEqual(v["state"], SCHED_UNKNOWN)

    def test_unexpected_state_is_unknown(self):
        v = evaluate_schedule("deleted", None, "2020-01-01T00:00:00Z", self.NOW, 2)
        self.assertEqual(v["state"], SCHED_UNKNOWN)

    def test_threshold_boundary_just_under_is_ok(self):
        v = evaluate_schedule(
            "active", self._iso(timedelta(days=1, hours=21, minutes=36)), None, self.NOW, 2
        )
        # 1.9 日 (1日21.6時間) < N=2 → OK
        self.assertEqual(v["state"], SCHED_OK)

    def test_threshold_boundary_just_over_is_stale(self):
        v = evaluate_schedule(
            "active", self._iso(timedelta(days=2, hours=2, minutes=24)), None, self.NOW, 2
        )
        # 2.1 日 > N=2 → STALE
        self.assertEqual(v["state"], SCHED_STALE)

    def test_missing_created_at_when_no_run_is_unknown(self):
        v = evaluate_schedule("active", None, None, self.NOW, 2)
        self.assertEqual(v["state"], SCHED_UNKNOWN)

    def test_fresh_run_with_consecutive_failures_is_failing_not_ok(self):
        # イシュー #304 レビュー指摘: schedule は発火しているがジョブ内部が
        # 連日失敗しているケース。発火の timestamp だけでは SCHED_OK に誤判定される。
        v = evaluate_schedule(
            "active", self._iso(timedelta(hours=12)), None, self.NOW, 2,
            recent_conclusions=["failure", "failure"],
        )
        self.assertEqual(v["state"], SCHED_FAILING)
        self.assertIn("連続失敗", v["detail"])

    def test_fresh_run_with_single_failure_is_still_ok(self):
        # 単発の flaky failure は連続失敗と区別し、過検知しない。
        v = evaluate_schedule(
            "active", self._iso(timedelta(hours=12)), None, self.NOW, 2,
            recent_conclusions=["failure"],
        )
        self.assertEqual(v["state"], SCHED_OK)

    def test_fresh_run_with_mixed_conclusions_is_ok(self):
        # 直近の一部が成功していれば「連続失敗」ではないため OK のまま。
        v = evaluate_schedule(
            "active", self._iso(timedelta(hours=12)), None, self.NOW, 2,
            recent_conclusions=["failure", "success"],
        )
        self.assertEqual(v["state"], SCHED_OK)

    def test_stale_run_with_failures_stays_stale_not_failing(self):
        # 経過日数超過（STALE）が既に検出済みの場合は conclusion を見ずに STALE
        # を優先する（STALE と FAILING の二重報告をしない）。
        v = evaluate_schedule(
            "active", self._iso(timedelta(days=3)), None, self.NOW, 2,
            recent_conclusions=["failure", "failure"],
        )
        self.assertEqual(v["state"], SCHED_STALE)

    def test_no_recent_conclusions_defaults_to_ok(self):
        # recent_conclusions 未指定（既存呼び出し互換）は従来どおり OK 判定。
        v = evaluate_schedule("active", self._iso(timedelta(hours=12)), None, self.NOW, 2)
        self.assertEqual(v["state"], SCHED_OK)


class TestScanEndToEnd(unittest.TestCase):
    """``scan()`` を偽の GitHub API に当て、軸 1-4 を通しで確認する。

    軸 3（ファイル無し + skills-lock あり + tree mode）はネットワーク I/O の
    分岐そのものなので、純粋関数だけでは検証できない。``gh_*`` を差し替えて
    HTTP status のシナリオを与える。
    """

    @staticmethod
    def _fake_api(repos: dict[str, dict]):
        """``gh_get_with_status`` の代替を返す。

        ``staticmethod`` にしてあるのは、``TestScheduleSystemicForbidden`` が
        インスタンス化せずに ``TestScanEndToEnd._fake_api(...)`` として直接
        再利用するため（``self`` を一切参照しない純粋なファクトリ関数）。

        ``repos`` は ``{リポ名: {"workflow": (status, text), "lock": status,
        "tree": mode, "sched": (state, created_at, runs_status, last_run) または
        (status_code だけの forbidden/error シミュレーション用タプル)}}``。
        ``sched`` を指定しないリポは軸 5 の Actions API 応答として
        ``("active", "2020-01-01T00:00:00Z", 200, _ago(0))``（直近実行あり・健全）
        を既定にする。**最終実行の既定値は固定日付にしない。** ``scan()`` は
        ``datetime.now(timezone.utc)`` と比較して ``SCHEDULE_STALE_DAYS``（既定 2）
        を超えたら SCHEDULE-STALE を出すため、固定日付を置くと実時間がその日付から
        2 日を過ぎた時点で、既定の健全 schedule に依存する全 E2E テスト
        （``test_all_four_axes`` / 乖離 0 件 / compare・unknown 系）が一斉に落ちる
        時限爆弾になる（PR #347 Cursor Bugbot 指摘）。
        """
        def fake(path: str, token: str, raw: bool = False):
            # **分岐順に注意**: `repos/…/actions/workflows/update-external.yml` は
            # `.github/workflows/update-external.yml`（cud.WORKFLOW_PATH）の
            # `endswith` には一致しない（"actions/workflows/update-external.yml"
            # は ".github/workflows/update-external.yml" で終わらない）ため、
            # 先に判定しても contents API の分岐と衝突しない。ここでは明確化の
            # ため意図的に先頭で分岐する。
            if "/actions/workflows/" in path:
                return _fake_actions_api(path, repos)
            if path.startswith(f"repos/{cud.UPSTREAM_REPO}/contents/"):
                return 200, FIXTURE_UPSTREAM_OK
            if path == f"repos/{cud.UPSTREAM_REPO}/git/ref/tags/latest":
                # 既定は「タグが main の先頭を指している」健全状態。個別テストは
                # モジュール変数 LATEST_TAG_RESPONSE を差し替えて stale / 取得失敗を作る
                # （_fake_api は staticmethod のため self を参照できない）。
                return LATEST_TAG_RESPONSE
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

        def _fake_actions_api(path: str, repos: dict[str, dict]):
            for name, cfg in repos.items():
                prefix = f"repos/Fandhe-AI/{name}/actions/workflows/{cud.WORKFLOW_FILENAME}"
                if not path.startswith(prefix):
                    continue
                # sched タプルは (state, created_at, runs_status, last_run[, conclusions])。
                # 5 要素目の conclusions は直近 schedule 実行の conclusion を新しい順に
                # 並べたもので、省略時は全件 "success" とみなす。scan() 経由の
                # エンドツーエンドテストでも本番と同じ形の workflow_runs を返さないと、
                # evaluate_schedule の SCHED_FAILING 判定（conclusion を消費する経路）を
                # 一度も通らないまま緑になるため、キーごと欠落させない。
                sched = cfg.get(
                    "sched",
                    # 最終実行は「今」からの相対値にする。固定日付だと実時間の経過で
                    # SCHEDULE-STALE へ倒れ、既定の健全 schedule に依存する全 E2E
                    # テストが一斉に落ちる（上記 docstring 参照）。
                    (
                        "active",
                        "2020-01-01T00:00:00Z",
                        200,
                        TestScanEndToEnd._ago(0),
                    ),
                )
                if sched[0] == "forbidden_meta":
                    return 403, ""
                if sched[0] == "forbidden_runs" and "/runs" in path:
                    return 403, ""
                if "/runs" in path:
                    runs_status = sched[2]
                    last_run = sched[3]
                    if runs_status != 200:
                        return runs_status, ""
                    if last_run is None:
                        return 200, '{"workflow_runs":[]}'
                    conclusions = (
                        sched[4]
                        if len(sched) > 4
                        else ["success"] * cud.SCHED_FAILING_STREAK_MIN
                    )
                    return 200, json.dumps(
                        {
                            "workflow_runs": [
                                {"created_at": last_run, "conclusion": c}
                                for c in conclusions
                            ]
                        }
                    )
                # workflow メタデータ本体
                state, created_at = sched[0], sched[1]
                return 200, json.dumps({"state": state, "created_at": created_at})
            raise AssertionError(f"想定外の Actions API 呼び出し: {path}")

        return fake

    def _run_scan(self, repos: dict[str, dict], schedule_stale_days: int = 2):
        orig = (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos)
        cud.gh_get_with_status = self._fake_api(repos)
        cud.gh_json = lambda path, token, jq=None: UPSTREAM_SHA
        cud.list_target_repos = lambda org, token: sorted(repos)
        try:
            return cud.scan("Fandhe-AI", "fake-token", schedule_stale_days)
        finally:
            (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos) = orig

    @staticmethod
    def _findings_by_repo(result) -> dict[str, list[tuple[str, str]]]:
        """1 リポが複数 findings を持ちうる（軸 5 の追加で LEGACY かつ
        SCHEDULE-STALE のような 2 件出得る）。repo 名をキーにした単一タプルの
        dict だと後勝ちで静かに 1 件が落ちるため、リストへ集約する。"""
        cats: dict[str, list[tuple[str, str]]] = {}
        for f in result.findings:
            cats.setdefault(f.repo.split("/")[1], []).append((f.category, f.detail))
        return cats

    def test_all_four_axes(self):
        result = self._run_scan({
            # 軸 1: @latest 参照の wrapper → 乖離なし
            "fresh-wrapper": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
            },
            # 軸 1: SHA pin へ戻した wrapper → 方針からの退行として乖離
            "stale-wrapper": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin=OLD_PIN)),
            },
            # 軸 1: 手管理のまま → 乖離
            "legacy-repo": {"workflow": (200, FIXTURE_LEGACY)},
            # 軸 1: reusable 定義本体 → 除外
            "actions": {"workflow": (200, FIXTURE_UPSTREAM_OK)},
            # 軸 3: ファイル無し + lock あり + 実ディレクトリ → SYNC-CI-ABSENT
            # （tree mode は情報として併記するだけで、導入可否の判断には使わない）
            "vendored-no-ci": {"workflow": (404, ""), "lock": 200, "tree": "040000"},
            # 軸 3: ファイル無し + lock あり + symlink → SYNC-CI-ABSENT（扱いは同じ）
            "vendored-symlink": {"workflow": (404, ""), "lock": 200, "tree": "120000"},
            # ファイル無し + lock 無し → 対象外（乖離ではない）
            "unrelated": {"workflow": (404, ""), "lock": 404},
            # 下流が workflow_call を足しても除外されない（偽陰性の防止）
            "sneaky-workflow-call": {"workflow": (200, FIXTURE_REUSABLE_DEFINITION)},
            # 検査不能 → UNKNOWN（黙って green にしない）
            "forbidden": {"workflow": (403, "")},
            # 旧・恒久除外リポ。除外解除により通常判定へ戻る（LEGACY として検知される）
            "yadori": {"workflow": (200, FIXTURE_LEGACY)},
        })

        cats = self._findings_by_repo(result)

        self.assertEqual(result.wrappers_ok, ["Fandhe-AI/fresh-wrapper"])
        self.assertEqual(len(cats["stale-wrapper"]), 1)
        self.assertEqual(cats["stale-wrapper"][0][0], KIND_WRAPPER_BADREF)
        self.assertIn("@latest ではない", cats["stale-wrapper"][0][1])
        self.assertEqual(len(cats["legacy-repo"]), 1)
        self.assertEqual(cats["legacy-repo"][0][0], "LEGACY")
        self.assertEqual(len(cats["sneaky-workflow-call"]), 1)
        self.assertEqual(cats["sneaky-workflow-call"][0][0], "LEGACY")

        self.assertEqual(len(cats["vendored-no-ci"]), 1)
        self.assertEqual(cats["vendored-no-ci"][0][0], "SYNC-CI-ABSENT")
        self.assertIn("040000", cats["vendored-no-ci"][0][1])
        # 実ディレクトリでも「導入すると失敗する」という判断を書かない（イシュー #344）。
        # 解決済み issue 番号を根拠にした但し書きは導入を不必要に止める誤誘導になる。
        self.assertNotIn("#256", cats["vendored-no-ci"][0][1])
        self.assertNotIn("日次で失敗", cats["vendored-no-ci"][0][1])

        self.assertEqual(len(cats["vendored-symlink"]), 1)
        self.assertEqual(cats["vendored-symlink"][0][0], "SYNC-CI-ABSENT")
        self.assertIn("120000", cats["vendored-symlink"][0][1])
        self.assertNotIn("#256", cats["vendored-symlink"][0][1])

        # tree mode 以外の本文は両者で同一であること（配置差で扱いを変えていない）
        self.assertEqual(
            cats["vendored-no-ci"][0][1].replace("040000", "MODE"),
            cats["vendored-symlink"][0][1].replace("120000", "MODE"),
        )

        self.assertNotIn("actions", cats)
        self.assertNotIn("unrelated", cats)
        self.assertIn("Fandhe-AI/unrelated", result.no_workflow_ok)

        # yadori の恒久除外を解除した（イシュー #344）。通常判定へ戻り LEGACY として検知される
        self.assertEqual(len(cats["yadori"]), 1)
        self.assertEqual(cats["yadori"][0][0], "LEGACY")

        excluded = {r.split("/")[1] for r, _ in result.excluded}
        self.assertEqual(excluded, {"actions"})

        self.assertEqual([f.repo for f in result.unknowns], ["Fandhe-AI/forbidden"])
        # 軸 4 は健全な fixture を上流としているため全マーカー適合。
        self.assertTrue(all(m["ok"] for m in result.upstream_markers))

        # 軸 5: schedule トリガを持つ 4 リポ（fresh-wrapper / stale-wrapper /
        # legacy-repo / yadori）が候補になり、既定の健全な sched fixture で全て OK。
        # yadori は恒久除外の解除（イシュー #344）により軸 5 の対象へも戻る。
        self.assertEqual(result.schedule_candidates, 4)
        self.assertEqual(result.schedule_forbidden, 0)
        self.assertEqual(
            set(result.schedule_ok),
            {
                "Fandhe-AI/fresh-wrapper",
                "Fandhe-AI/stale-wrapper",
                "Fandhe-AI/legacy-repo",
                "Fandhe-AI/yadori",
            },
        )

        # レポートは乖離 0 件でも全量を出す契約。除外解除で yadori の LEGACY が 1 件増え 6 件。
        report = cud.render_report(result, "https://example.invalid/run/1")
        self.assertIn("乖離: **6 件**", report)
        self.assertIn("検査不能 (UNKNOWN): **1 件**", report)

    def test_latest_tag_fetch_error_is_unknown_not_drift(self):
        # タグ取得が 429。乖離の証拠にはならないため UNKNOWN として扱う。
        global LATEST_TAG_RESPONSE
        orig = LATEST_TAG_RESPONSE
        LATEST_TAG_RESPONSE = (429, "")
        try:
            result = self._run_scan({
                "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
            })
        finally:
            LATEST_TAG_RESPONSE = orig
        self.assertEqual(result.findings, [])
        self.assertEqual(len(result.unknowns), 1)
        self.assertIn("HTTP 429", result.unknowns[0].detail)
        self.assertTrue(cud.has_drift(result))  # UNKNOWN が残る間は close しない

    def test_latest_tag_behind_main_is_drift(self):
        # move-latest-tag.yml が止まって latest が古いコミットのままなら乖離。
        global LATEST_TAG_RESPONSE
        orig = LATEST_TAG_RESPONSE
        LATEST_TAG_RESPONSE = (
            200, '{"object": {"sha": "' + OLD_PIN + '", "type": "commit"}}'
        )
        try:
            result = self._run_scan({
                "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
            })
        finally:
            LATEST_TAG_RESPONSE = orig
        self.assertEqual(result.unknowns, [])
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].category, "LATEST-TAG-STALE")

    def test_zero_drift_report_says_zero(self):
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
        })
        report = cud.render_report(result)
        self.assertIn("乖離: **0 件**", report)
        self.assertIn("乖離 **0 件**", report)
        self.assertIn("検査不能なリポジトリは **0 件**", report)
        # 候補が全件 schedule_ok で SCHED_UNKNOWN も無いときだけ「全て確認できている」
        # と断定してよい。
        self.assertIn("全て直近実行を確認できている", report)
        # 乖離も UNKNOWN も無いときだけ issue を close してよい。
        self.assertEqual(cud.drift_count(result), 0)
        self.assertFalse(cud.has_drift(result))

    def test_zero_drift_with_schedule_unknown_does_not_claim_all_confirmed(self):
        # 候補 2 件のうち 1 件が Actions API 500。乖離は 0 件だが、生存を確認できたのは
        # 1 件だけ。「schedule トリガを持つ wrapper は全て直近実行を確認できている」と
        # 断定すると集計値（schedule_ok: 1/2）と矛盾するため、検査不能を明示する。
        result = self._run_scan({
            "ok-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
            "api-500": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": ("active", "2020-01-01T00:00:00Z", 500, None),
            },
        })
        self.assertEqual(result.findings, [])
        self.assertEqual(result.schedule_candidates, 2)
        self.assertEqual(len(result.schedule_ok), 1)
        self.assertEqual(
            [u.category for u in result.unknowns], ["SCHED_UNKNOWN"]
        )
        report = cud.render_report(result)
        self.assertIn("乖離 **0 件**", report)
        self.assertNotIn("全て直近実行を確認できている", report)
        self.assertIn("検査不能あり", report)
        self.assertIn("schedule 候補 2 件中 1 件", report)
        # UNKNOWN が残る間は issue を close しない（既存契約）。
        self.assertTrue(cud.has_drift(result))

    def test_unknown_alone_keeps_issue_open(self):
        # 乖離 0 件だが検査不能が 1 件。「解消した」と言えないので close しない。
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
            "forbidden": {"workflow": (403, "")},
        })
        self.assertEqual(cud.drift_count(result), 0)
        self.assertEqual(len(result.unknowns), 1)
        self.assertTrue(cud.has_drift(result))

    def test_upstream_marker_failure_alone_is_drift(self):
        # 下流が全て健全でも、上流 reusable が劣化していれば乖離として扱う。
        result = self._run_scan({
            "fresh-wrapper": {"workflow": (200, FIXTURE_WRAPPER.format(pin="latest"))},
        })
        result.upstream_markers = [{"marker": "dummy", "ok": False, "detail": "劣化"}]
        self.assertEqual(cud.drift_count(result), 1)
        self.assertTrue(cud.has_drift(result))

    # --- 軸 5 の scan() 組み込み ---------------------------------------

    @staticmethod
    def _ago(days: float) -> str:
        return (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def test_schedule_stale_wrapper_is_flagged(self):
        # ファイル内容は最新 pin で健全（軸 1+2 は乖離なし）だが、直近の
        # schedule 実行が 5 日前 → 軸 5 のみが乖離を報告する。
        result = self._run_scan({
            "stale-schedule": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": ("active", "2020-01-01T00:00:00Z", 200, self._ago(5)),
            },
        })
        cats = self._findings_by_repo(result)
        self.assertEqual(len(cats["stale-schedule"]), 1)
        self.assertEqual(cats["stale-schedule"][0][0], "SCHEDULE-STALE")
        # 軸 1+2（ファイル内容）は最新 pin の wrapper として健全 → wrappers_ok
        # にも計上される。軸 5 の乖離と軸 1+2 の健全は独立に共存する。
        self.assertIn("Fandhe-AI/stale-schedule", result.wrappers_ok)

    def test_schedule_disabled_inactivity_is_flagged(self):
        result = self._run_scan({
            "disabled-schedule": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": ("disabled_inactivity", "2020-01-01T00:00:00Z", 200, None),
            },
        })
        cats = self._findings_by_repo(result)
        self.assertEqual(len(cats["disabled-schedule"]), 1)
        self.assertEqual(cats["disabled-schedule"][0][0], "SCHEDULE-DISABLED")

    def test_schedule_failing_wrapper_is_flagged(self):
        # 発火は新しい（19 時間前）が直近 2 件が連続失敗 → SCHEDULE-FAILING。
        # last_run だけを見る実装では SCHEDULE-OK に倒れるケースを、scan() 経由
        # （フェイク Actions API が conclusion を返す経路）で押さえる。
        result = self._run_scan({
            "failing-schedule": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": (
                    "active", "2020-01-01T00:00:00Z", 200, self._ago(0.8),
                    ["failure", "failure"],
                ),
            },
        })
        cats = self._findings_by_repo(result)
        self.assertEqual(len(cats["failing-schedule"]), 1)
        self.assertEqual(cats["failing-schedule"][0][0], "SCHEDULE-FAILING")
        # detail には連続失敗の conclusion が列挙される（読み手がしきい値を
        # 信用せず自分で判断できるようにするため）。
        self.assertIn("failure", cats["failing-schedule"][0][1])

    def test_schedule_single_failure_is_not_flagged(self):
        # 単発の flaky failure は過検知しない（直近 2 件が「全て」失敗のときのみ）。
        result = self._run_scan({
            "flaky-schedule": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": (
                    "active", "2020-01-01T00:00:00Z", 200, self._ago(0.8),
                    ["failure", "success"],
                ),
            },
        })
        cats = self._findings_by_repo(result)
        categories = {c for c, _ in cats.get("flaky-schedule", [])}
        self.assertNotIn("SCHEDULE-FAILING", categories)
        self.assertIn("Fandhe-AI/flaky-schedule", result.wrappers_ok)

    def test_legacy_repo_with_stale_schedule_reports_two_findings(self):
        # LEGACY（軸 1）と SCHEDULE-STALE（軸 5）は原因も直し方も違うため、
        # 同一リポで 2 findings が出るのが意図どおり。
        result = self._run_scan({
            "legacy-and-stale": {
                "workflow": (200, FIXTURE_LEGACY),
                "sched": ("active", "2020-01-01T00:00:00Z", 200, self._ago(5)),
            },
        })
        cats = self._findings_by_repo(result)
        categories = {c for c, _ in cats["legacy-and-stale"]}
        self.assertEqual(categories, {"LEGACY", "SCHEDULE-STALE"})
        self.assertEqual(len(cats["legacy-and-stale"]), 2)

    def test_dispatch_only_wrapper_is_not_a_schedule_candidate(self):
        # workflow_dispatch のみの wrapper は軸 5 の対象外。SCHEDULE-* が
        # 出ないだけでなく、Actions API も一切呼ばれない（候補外の構造判定）。
        result = self._run_scan({
            "dispatch-only": {"workflow": (200, FIXTURE_WRAPPER_UNPINNED)},
        })
        cats = self._findings_by_repo(result)
        categories = {c for c, _ in cats.get("dispatch-only", [])}
        self.assertNotIn("SCHEDULE-STALE", categories)
        self.assertNotIn("SCHEDULE-DISABLED", categories)
        self.assertEqual(result.schedule_candidates, 0)

    def test_partial_actions_forbidden_is_unknown_not_scan_error(self):
        # 候補の一部だけが 403。正常系（他リポの判定）を巻き込まず UNKNOWN に
        # 留め、ScanError にはしない。
        result = self._run_scan({
            "healthy-wrapper": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
            },
            "actions-forbidden": {
                "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                "sched": ("forbidden_meta",),
            },
        })
        self.assertEqual(result.schedule_forbidden, 1)
        self.assertEqual(result.schedule_candidates, 2)
        unknown_repos = {f.repo for f in result.unknowns}
        self.assertIn("Fandhe-AI/actions-forbidden", unknown_repos)
        self.assertIn("Fandhe-AI/healthy-wrapper", result.schedule_ok)


class TestScheduleSystemicForbidden(unittest.TestCase):
    """軸 5 候補の全件が 403 の場合は個別 UNKNOWN ではなく ScanError にする。"""

    def _run_scan(self, repos: dict[str, dict]):
        orig = (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos)
        cud.gh_get_with_status = TestScanEndToEnd._fake_api(repos)
        cud.gh_json = lambda path, token, jq=None: UPSTREAM_SHA
        cud.list_target_repos = lambda org, token: sorted(repos)
        try:
            return cud.scan("Fandhe-AI", "fake-token")
        finally:
            (cud.gh_get_with_status, cud.gh_json, cud.list_target_repos) = orig

    def test_all_candidates_forbidden_raises_scan_error(self):
        with self.assertRaises(cud.ScanError) as ctx:
            self._run_scan({
                "wrapper-a": {
                    "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                    "sched": ("forbidden_meta",),
                },
                "wrapper-b": {
                    "workflow": (200, FIXTURE_WRAPPER.format(pin="latest")),
                    "sched": ("forbidden_meta",),
                },
            })
        self.assertIn("Actions: read", str(ctx.exception))

    def test_no_candidates_does_not_raise(self):
        # 軸 5 の対象（schedule トリガあり）が 0 件なら 403 の分母も 0。
        # 0/0 を「全件 403」と誤判定しないこと。
        result = self._run_scan({
            "dispatch-only": {"workflow": (200, FIXTURE_WRAPPER_UNPINNED)},
        })
        self.assertEqual(result.schedule_candidates, 0)


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



class ExcludedReposPolicyTest(unittest.TestCase):
    """除外リストが issue 番号を根拠に増えていないことを固定する（イシュー #344）。

    未解決 issue を根拠にリポ名を除外すると、issue が閉じても除外だけが残り、当該リポの
    乖離を恒久的に検知できなくなる（実例: yadori / イシュー #263）。除外は archived や
    reusable 定義本体のような観測可能で恒久的な条件に限る。
    """

    def test_excluded_repos_has_no_issue_number_rationale(self) -> None:
        for repo, reason in cud.EXCLUDED_REPOS.items():
            self.assertNotRegex(
                reason,
                r"#\d+",
                f"{repo}: 除外理由に issue 番号を書かない（issue が閉じても除外が残る）",
            )

    def test_yadori_is_not_permanently_excluded(self) -> None:
        self.assertNotIn("yadori", cud.EXCLUDED_REPOS)

if __name__ == "__main__":
    unittest.main(verbosity=2)

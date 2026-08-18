#!/usr/bin/env python3
"""``bump_update_external_pin.py`` の純粋関数を fixture で検証する（イシュー #343）。

I/O 部分（PR 作成・ブランチ作成等）はネットワークに触れるためここでは検証しない。
``replace_job_uses_ref`` / ``workflow_call_contract`` / ``check_wrapper_contract`` /
``branch_name`` / ``parse_only_repo`` という、GitHub API に触れない判定ロジックだけを
対象にする（``check_update_external_drift.py`` の既存テストと同じ方針）。

実行:
    python3 .github/scripts/test_bump_update_external_pin.py
"""

from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import bump_update_external_pin as bump  # noqa: E402
import check_update_external_drift as cud  # noqa: E402

UPSTREAM_SHA = "fed9c07d98367f77e5e2b63bca38843f46feee96"
NEW_SHA = "1" * 39 + "a"  # 40 桁 hex

WRAPPER_TEXT = """
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
    with:
      target: all
      runner-json: '"ubuntu-latest"'
    secrets:
      SUBMODULE_PAT: ${{{{ secrets.SUBMODULE_PAT }}}}
      SKILLS_PAT: ${{{{ secrets.SKILLS_PAT }}}}
""".format(pin=UPSTREAM_SHA)

UPSTREAM_WITH_CONTRACT = """
name: Update external sources (reusable)
on:
  workflow_call:
    inputs:
      target:
        type: string
        required: false
      runner-json:
        type: string
        required: false
    secrets:
      SUBMODULE_PAT:
        required: false
      SKILLS_PAT:
        required: false
jobs:
  submodule:
    runs-on: ubuntu-latest
"""


class TestReplaceJobUsesRef(unittest.TestCase):
    def test_replaces_only_the_uses_line(self):
        new_text, err = bump.replace_job_uses_ref(WRAPPER_TEXT, NEW_SHA)
        self.assertIsNone(err)
        self.assertIn(f"@{NEW_SHA} # main", new_text)
        self.assertNotIn(UPSTREAM_SHA, new_text)

    def test_other_lines_are_unchanged(self):
        # 検証記録コメント内に SHA 文字列があっても、それは触らない
        # （本スクリプトは job-level uses: 行だけを対象にする設計）。
        text_with_comment_sha = (
            f"# 参照 SHA の検証記録: {UPSTREAM_SHA}\n" + WRAPPER_TEXT
        )
        new_text, err = bump.replace_job_uses_ref(text_with_comment_sha, NEW_SHA)
        self.assertIsNone(err)
        # コメント行の SHA はそのまま残る。
        self.assertIn(f"# 参照 SHA の検証記録: {UPSTREAM_SHA}", new_text)
        # job-level uses: 行だけが新 SHA に変わる。
        self.assertIn(f"uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{NEW_SHA}", new_text)

    def test_commented_out_uses_line_is_not_matched(self):
        commented = (
            "jobs:\n"
            "  x:\n"
            f"    # uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{UPSTREAM_SHA}\n"
            "    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@"
            + NEW_SHA
            + "\n"
        )
        new_text, err = bump.replace_job_uses_ref(commented, "2" * 40)
        self.assertIsNone(err)
        # コメント行の旧 pin は変更されない。
        self.assertIn(f"# uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{UPSTREAM_SHA}", new_text)

    def test_zero_matches_is_an_error(self):
        no_uses = "name: x\non:\n  push:\njobs:\n  x:\n    runs-on: ubuntu-latest\n"
        new_text, err = bump.replace_job_uses_ref(no_uses, NEW_SHA)
        self.assertIsNone(new_text)
        self.assertIsNotNone(err)
        self.assertIn("0 件", err)

    def test_two_matches_is_an_error(self):
        two_uses = (
            "jobs:\n"
            "  a:\n"
            f"    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{UPSTREAM_SHA}\n"
            "  b:\n"
            f"    uses: Fandhe-AI/actions/.github/workflows/update-external.yml@{UPSTREAM_SHA}\n"
        )
        new_text, err = bump.replace_job_uses_ref(two_uses, NEW_SHA)
        self.assertIsNone(new_text)
        self.assertIn("複数", err)

    def test_self_verification_after_replace(self):
        # 置換後の本文が classify_workflow で KIND_WRAPPER + 新 SHA として
        # 再検出できることを直接確認する（replace_job_uses_ref 内部の自己検証と
        # 同じ経路を外側からも固定する）。
        new_text, err = bump.replace_job_uses_ref(WRAPPER_TEXT, NEW_SHA)
        self.assertIsNone(err)
        info = cud.classify_workflow(new_text)
        self.assertEqual(info["kind"], cud.KIND_WRAPPER)
        self.assertEqual(info["pin"], NEW_SHA)

    def test_invalid_new_sha_is_rejected(self):
        new_text, err = bump.replace_job_uses_ref(WRAPPER_TEXT, "not-a-sha")
        self.assertIsNone(new_text)
        self.assertIn("40 桁", err)


class TestWorkflowCallContract(unittest.TestCase):
    def test_extracts_inputs_and_secrets(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_CONTRACT)
        self.assertEqual(contract["inputs"], {"target", "runner-json"})
        self.assertEqual(contract["secrets"], {"SUBMODULE_PAT", "SKILLS_PAT"})

    def test_missing_workflow_call_returns_empty_sets(self):
        contract = bump.workflow_call_contract("name: x\non:\n  push:\n")
        self.assertEqual(contract["inputs"], set())
        self.assertEqual(contract["secrets"], set())


class TestCheckWrapperContract(unittest.TestCase):
    def test_wrapper_within_contract_has_no_violations(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_CONTRACT)
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertEqual(violations, [])

    def test_wrapper_with_unknown_with_key_is_a_violation(self):
        contract = {"inputs": {"target"}, "secrets": {"SUBMODULE_PAT", "SKILLS_PAT"}}
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertTrue(any("runner-json" in v for v in violations))

    def test_wrapper_with_unknown_secret_key_is_a_violation(self):
        contract = {"inputs": {"target", "runner-json"}, "secrets": {"SUBMODULE_PAT"}}
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertTrue(any("SKILLS_PAT" in v for v in violations))

    def test_non_reusable_job_is_ignored(self):
        other_job = "jobs:\n  x:\n    runs-on: ubuntu-latest\n    with:\n      foo: bar\n"
        violations = bump.check_wrapper_contract(other_job, {"inputs": set(), "secrets": set()})
        self.assertEqual(violations, [])


class TestBranchName(unittest.TestCase):
    def test_deterministic_and_prefixed(self):
        self.assertEqual(
            bump.branch_name(NEW_SHA), f"chore/update-external-pin-{NEW_SHA[:12]}"
        )

    def test_rejects_non_sha(self):
        with self.assertRaises(ValueError):
            bump.branch_name("main")


class TestParseOnlyRepo(unittest.TestCase):
    def test_valid_owner_repo(self):
        self.assertEqual(bump.parse_only_repo("Fandhe-AI/template-ideas"), ("Fandhe-AI", "template-ideas"))

    def test_rejects_missing_slash(self):
        self.assertIsNone(bump.parse_only_repo("template-ideas"))

    def test_rejects_path_traversal_like_input(self):
        self.assertIsNone(bump.parse_only_repo("Fandhe-AI/../secrets"))

    def test_rejects_extra_segments(self):
        self.assertIsNone(bump.parse_only_repo("Fandhe-AI/repo/extra"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

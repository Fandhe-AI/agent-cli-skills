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

UPSTREAM_WITH_NEW_REQUIRED_INPUT = """
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
      new-required-flag:
        type: string
        required: true
    secrets:
      SUBMODULE_PAT:
        required: false
      SKILLS_PAT:
        required: false
      NEW_REQUIRED_SECRET:
        required: true
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

    def test_all_optional_contract_has_no_required_keys(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_CONTRACT)
        self.assertEqual(contract["required_inputs"], set())
        self.assertEqual(contract["required_secrets"], set())

    def test_extracts_required_keys(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_NEW_REQUIRED_INPUT)
        self.assertEqual(contract["required_inputs"], {"new-required-flag"})
        self.assertEqual(contract["required_secrets"], {"NEW_REQUIRED_SECRET"})

    def test_missing_workflow_call_returns_empty_sets(self):
        contract = bump.workflow_call_contract("name: x\non:\n  push:\n")
        self.assertEqual(contract["inputs"], set())
        self.assertEqual(contract["secrets"], set())
        self.assertEqual(contract["required_inputs"], set())
        self.assertEqual(contract["required_secrets"], set())
        self.assertFalse(contract["ok"])

    def test_extracted_contract_is_marked_ok(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_CONTRACT)
        self.assertTrue(contract["ok"])

    def test_yaml_parse_failure_is_not_ok(self):
        contract = bump.workflow_call_contract("jobs: [unclosed")
        self.assertFalse(contract["ok"])
        self.assertEqual(contract["inputs"], set())

    def test_non_mapping_yaml_is_not_ok(self):
        contract = bump.workflow_call_contract("- a\n- b\n")
        self.assertFalse(contract["ok"])


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

    def test_new_required_input_not_supplied_by_wrapper_is_a_violation(self):
        # イシュー #343 Review 指摘の回帰テスト: 新 SHA で required: true に
        # なった input を wrapper が渡していない片方向欠落を検出できること。
        contract = bump.workflow_call_contract(UPSTREAM_WITH_NEW_REQUIRED_INPUT)
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertTrue(any("new-required-flag" in v for v in violations))

    def test_new_required_secret_not_supplied_by_wrapper_is_a_violation(self):
        contract = bump.workflow_call_contract(UPSTREAM_WITH_NEW_REQUIRED_INPUT)
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertTrue(any("NEW_REQUIRED_SECRET" in v for v in violations))

    def test_required_key_supplied_by_wrapper_has_no_violation(self):
        # 必須キーであっても wrapper が渡していれば違反にならない。
        contract = bump.workflow_call_contract(UPSTREAM_WITH_CONTRACT)
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
        self.assertEqual(violations, [])

    def test_contract_without_required_keys_field_skips_required_check(self):
        # 後方互換: {"inputs": set(...), "secrets": set(...)} のみの契約
        # （required_inputs/required_secrets 無し）では方向 2 の判定を
        # 素通りし、方向 1（契約外キー）の判定のみ効く。
        contract = {"inputs": {"target", "runner-json"}, "secrets": {"SUBMODULE_PAT", "SKILLS_PAT"}}
        violations = bump.check_wrapper_contract(WRAPPER_TEXT, contract)
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


class TestClassifyReusedBranch(unittest.TestCase):
    """422（ref 既存）時の所有関係判定（イシュー #343 Review P0 指摘）。

    ``apply_bump`` は ``ref_status == 422`` のとき、default branch の元本文
    （``old_text``）と既存ブランチの現在の本文を ``classify_reused_branch``
    へ渡して再利用可否を決める。ここではその純粋関数だけを検証する
    （ブランチ取得自体は API 呼び出しのためこのテストの対象外）。
    """

    def test_branch_already_has_new_sha_is_already_bumped(self):
        # 前回 run が PUT まで成功し、PR 作成以降で失敗した残骸。
        branch_text = WRAPPER_TEXT.replace(UPSTREAM_SHA, NEW_SHA)
        self.assertEqual(
            bump.classify_reused_branch(WRAPPER_TEXT, branch_text, NEW_SHA),
            "already-bumped",
        )

    def test_branch_still_at_base_is_unbumped_retry(self):
        # 前回 run が ref 作成のみ成功し PUT 前に失敗した残骸。
        # ブランチの内容は default branch の元本文と完全一致する。
        self.assertEqual(
            bump.classify_reused_branch(WRAPPER_TEXT, WRAPPER_TEXT, NEW_SHA),
            "unbumped-retry",
        )

    def test_unrelated_branch_content_is_foreign(self):
        # このスクリプトが書いた内容とは断定できない場合は fail-closed。
        unrelated_text = "name: unrelated\non:\n  push: {}\njobs: {}\n"
        self.assertEqual(
            bump.classify_reused_branch(WRAPPER_TEXT, unrelated_text, NEW_SHA),
            "foreign",
        )

    def test_branch_with_different_pin_than_target_is_foreign(self):
        # 別の（この run が狙う new_sha とは異なる）SHA へ既に書き換わって
        # いる場合も、この run にとっては所有関係を確認できないため foreign。
        other_sha = "2" * 39 + "b"
        branch_text = WRAPPER_TEXT.replace(UPSTREAM_SHA, other_sha)
        self.assertEqual(
            bump.classify_reused_branch(WRAPPER_TEXT, branch_text, NEW_SHA),
            "foreign",
        )


class TestScopeByOnlyRepo(unittest.TestCase):
    """ONLY_REPO 指定時の targets/skipped 絞り込み（cursor Bugbot 指摘）。

    絞り込み前は targets のみが絞られ skipped が org 全体のまま残っていた
    ため、無関係な他リポの API エラーが単一リポ限定の run を巻き込んで
    失敗させ得た。skipped も同じリポへ絞られることを確認する。
    """

    def test_targets_and_skipped_are_both_scoped(self):
        targets = [
            bump.BumpTarget("Fandhe-AI/a", "0" * 40, "old", "new", "blob"),
            bump.BumpTarget("Fandhe-AI/b", "0" * 40, "old", "new", "blob"),
        ]
        skipped = [
            bump.BumpOutcome("Fandhe-AI/a", "skipped-scan-error", "対象リポの障害"),
            bump.BumpOutcome("Fandhe-AI/b", "skipped-scan-error", "無関係な他リポの障害"),
        ]
        scoped_targets, scoped_skipped = bump.scope_by_only_repo(
            targets, skipped, ("Fandhe-AI", "a")
        )
        self.assertEqual([t.repo for t in scoped_targets], ["Fandhe-AI/a"])
        self.assertEqual([s.repo for s in scoped_skipped], ["Fandhe-AI/a"])

    def test_no_match_yields_empty_lists(self):
        targets = [bump.BumpTarget("Fandhe-AI/a", "0" * 40, "old", "new", "blob")]
        skipped = [bump.BumpOutcome("Fandhe-AI/b", "skipped-scan-error", "他リポの障害")]
        scoped_targets, scoped_skipped = bump.scope_by_only_repo(
            targets, skipped, ("Fandhe-AI", "c")
        )
        self.assertEqual(scoped_targets, [])
        self.assertEqual(scoped_skipped, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

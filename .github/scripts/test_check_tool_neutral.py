#!/usr/bin/env python3
"""``check-tool-neutral.sh`` の回帰テスト。

静的検査は「検出できること」が仕事なので、緑になるだけでは何も証明しない。
一時ディレクトリへ fixture のリポジトリ（skills/ と .claude/agents/）を作り、
bash スクリプトを subprocess で実行して終了コードと結果行を確かめる。

実行:
    python3 .github/scripts/test_check_tool_neutral.py

使う bash は環境変数 ``TOOL_NEUTRAL_BASH``（既定 ``bash``）で切り替える。
macOS の /bin/bash（3.2）と PATH 上の bash 5 の両方で通すための口。
標準ライブラリの unittest のみを使う。
"""

from __future__ import annotations

import os
import pathlib
import re
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-tool-neutral.sh"
BASH = os.environ.get("TOOL_NEUTRAL_BASH", "bash")
MARKER = "<!-- tool-neutral: allow -->"
RESULT_RE = re.compile(
    r"^TOOL_NEUTRAL_RESULT violations=(\d+) missing_sandbox=(\d+) allowed=(\d+)$",
    re.MULTILINE,
)

CLEAN_BODY = "# 手順\n\n## sandbox 環境での実行\n\n許可された範囲で実行する。\n"


def run(root: pathlib.Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(SCRIPT), *args, str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


def counts(proc: subprocess.CompletedProcess) -> tuple[int, int, int]:
    m = RESULT_RE.search(proc.stdout)
    assert m, f"結果行が無い: stdout={proc.stdout!r} stderr={proc.stderr!r}"
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


class CheckToolNeutralTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = pathlib.Path(self._tmp.name)
        # 固有名の一覧を .claude/agents の name: から作ることも検査するためのダミー。
        agent = self.root / ".claude" / "agents" / "x" / "dummy.md"
        agent.parent.mkdir(parents=True)
        agent.write_text("---\nname: dummy-agent\ndescription: d\n---\n本文\n")

    def skill(self, name: str, body: str, ref: str | None = None) -> None:
        d = self.root / "skills" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(f"---\nname: {name}\n---\n{body}")
        if ref is not None:
            (d / "references").mkdir(exist_ok=True)
            (d / "references" / "r.md").write_text(ref)

    def test_1_violations(self) -> None:
        self.skill("a", CLEAN_BODY + "Agent ツール で委譲する\n")
        self.skill("b", CLEAN_BODY + "dummy-agent に渡す\n", ref="subagent_type: x\n")
        strict = run(self.root, "--strict")
        self.assertEqual(strict.returncode, 1, strict.stdout)
        v, m, a = counts(strict)
        self.assertGreaterEqual(v, 3)
        self.assertIn("skills/b/SKILL.md:", strict.stdout)
        self.assertIn(": dummy-agent", strict.stdout)
        warn = run(self.root)
        self.assertEqual(warn.returncode, 0, warn.stdout)
        self.assertGreaterEqual(counts(warn)[0], 1)

    def test_2_allow_marker(self) -> None:
        self.skill("a", CLEAN_BODY + f"例: AskUserQuestion {MARKER}\n")
        proc = run(self.root, "--strict")
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(counts(proc), (0, 0, 1))

    def test_3_excluded_skill(self) -> None:
        self.skill("a", CLEAN_BODY)
        self.skill("init-claude", "Agent ツール subagent_type\n")  # sandbox 節も無い
        proc = run(self.root, "--strict")
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(counts(proc), (0, 0, 0))

    def test_4_missing_sandbox(self) -> None:
        self.skill("a", "# 手順\n\n本文のみ\n")
        proc = run(self.root, "--strict")
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(counts(proc), (0, 1, 0))
        self.assertIn("skills/a/SKILL.md: missing sandbox section", proc.stdout)

    def test_5_usage_errors(self) -> None:
        self.skill("a", CLEAN_BODY)
        self.assertEqual(run(self.root, "--bogus").returncode, 2)
        self.assertEqual(run(self.root / "no-such-dir").returncode, 2)

    def test_6_claude_specific_phrases(self) -> None:
        # 4 語を 1 行ずつ書くと 4 件。「Claude Code が／は」は固定文字列に一致しない。
        lines = 'isolation: "worktree"\nBash ツール\nClaude が\nClaude は\n'
        self.skill("a", CLEAN_BODY + lines)
        proc = run(self.root, "--strict")
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(counts(proc), (4, 0, 0))
        for term in ('isolation: "worktree"', "Bash ツール", "Claude が", "Claude は"):
            self.assertIn(f": {term}\n", proc.stdout)

        self.skill("a", CLEAN_BODY + "Claude Code が実行する\nClaude Code は読む\n")
        ok = run(self.root, "--strict")
        self.assertEqual(ok.returncode, 0, ok.stdout)
        self.assertEqual(counts(ok), (0, 0, 0))

    def test_clean_repo(self) -> None:
        self.skill("a", CLEAN_BODY)
        proc = run(self.root, "--strict")
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(counts(proc), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()

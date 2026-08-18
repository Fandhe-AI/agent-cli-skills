#!/usr/bin/env python3
"""下流 wrapper の pin SHA を上流 main へ自動追従させる（イシュー #343）。

このスクリプトの役割
--------------------
``check_update_external_drift.py``（軸 2 拡張・実効差分ゲート）が「乖離あり」と
判定した wrapper（＝コミット数で遅れていて、かつ pin 側ファイルの内容が main と
実際に異なる）だけを対象に、``uses:`` 行の SHA 40 桁を新しい上流 main SHA へ
書き換え、ブランチ・commit・PR を各リポジトリへ作成する。
``.github/workflows/update-external-pin-bump.yml`` から日次で呼ばれる。

判定ロジック（対象の絞り込み）は ``check_update_external_drift`` の
``classify_workflow`` / ``evaluate_pin`` / ``evaluate_pin_impact`` をそのまま
import して再利用する（同モジュールは ``if __name__ == "__main__"`` ガード済み
で import に副作用が無い）。判定基準を 2 箇所に重複させないための構造。

安全策の要点（詳細は docs/update-external-pin.md）:
- 書き換えるのは ``uses:`` 行の SHA 1 箇所のみ。書き換え後に
  ``classify_workflow`` で自己検証してからコミットする
- 入力契約ゲート（``check_wrapper_contract``）: 新 SHA の ``workflow_call``
  契約に無い ``with:`` / ``secrets:`` キーを渡す wrapper はスキップする。
  reusable workflow は契約外キーを渡されるとジョブ起動前に
  ``Invalid input, <name> is not defined in the referenced workflow`` で
  失敗し、これを踏むと対象リポ全体の同期が一斉停止する
- auto-merge は付けない。生成する PR は人間のレビューを必須にする
- 対象は ``KIND_WRAPPER`` かつ実効差分ありのリポのみ。``LEGACY`` /
  ``UNPARSEABLE`` / ``WRAPPER-UNPINNED`` には一切触らない
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass

import yaml

import check_update_external_drift as cud

# ---------------------------------------------------------------------------
# 純粋関数（テスト対象）
# ---------------------------------------------------------------------------

# ``uses:`` 行だけを対象にする。コメント行（先頭が # のこと。前置空白は許容）は
# 除外する。行頭からの完全一致でキーを取るため、YAML の値側に同じ文字列が
# 出現しても（通常あり得ないが）誤爆しない。
_USES_PIN_LINE_RE = re.compile(
    r"^(?P<indent>[ \t]*uses:[ \t]*)"
    r"Fandhe-AI/actions/\.github/workflows/update-external\.yml@"
    r"(?P<sha>[0-9a-f]{40})"
    r"(?P<suffix>.*)$"
)


def replace_job_uses_ref(text: str, new_sha: str) -> tuple[str | None, str | None]:
    """wrapper 本文の job-level ``uses:`` 行の SHA だけを ``new_sha`` へ差し替える。

    戻り値は ``(新本文, エラー理由)``。一致 0 件・2 件以上・自己検証失敗は
    ``(None, 理由)`` を返し、呼び出し側はそのリポをスキップする（黙って
    書き換えない）。

    自己検証: 置換後の本文を ``classify_workflow`` へ通し、``KIND_WRAPPER`` で
    かつ ``pin == new_sha`` であることを確認する。行の書き換え自体が正しくても
    YAML としての構文を壊していないか・意図した箇所を書き換えたかを、この
    スクリプト自身の判定ロジックで再確認する。
    """
    if not cud._SHA40_RE.match(new_sha):
        return None, f"new_sha が 40 桁 hex ではない: {new_sha!r}"

    lines = text.split("\n")
    matches: list[int] = []
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        if _USES_PIN_LINE_RE.match(line):
            matches.append(i)

    if len(matches) == 0:
        return None, "uses: 行が見つからない（0 件）"
    if len(matches) >= 2:
        return None, f"uses: 行が複数見つかった（{len(matches)} 件）。手動確認が必要"

    i = matches[0]
    m = _USES_PIN_LINE_RE.match(lines[i])
    assert m is not None  # 上の走査と同じ正規表現なので必ず一致する
    lines[i] = (
        f"{m.group('indent')}"
        f"Fandhe-AI/actions/.github/workflows/update-external.yml@{new_sha}"
        f"{m.group('suffix')}"
    )
    new_text = "\n".join(lines)

    info = cud.classify_workflow(new_text)
    if info["kind"] != cud.KIND_WRAPPER or info["pin"] != new_sha:
        return None, (
            f"置換後の自己検証に失敗（kind={info['kind']!r}, pin={info['pin']!r}）。"
            "書き換えをコミットしない"
        )
    return new_text, None


_EMPTY_CONTRACT: dict = {
    "inputs": set(),
    "secrets": set(),
    "required_inputs": set(),
    "required_secrets": set(),
}


def _required_keys(entries: dict) -> set[str]:
    """``workflow_call.inputs``/``secrets`` マッピングから ``required: true`` のキーだけを抽出する。

    GitHub Actions の仕様では ``required`` 省略時のデフォルトは ``false``
    （明示的に ``true`` と書かれたキーのみ必須）。値がマッピングでない
    エントリ（不正な YAML）は必須扱いにしない（fail-closed 方向は
    「契約に無いキー」側の判定に委ねる。ここで誤検出すると存在しない
    必須違反を作ってしまう）。
    """
    required: set[str] = set()
    for key, entry in entries.items():
        if isinstance(entry, dict) and entry.get("required") is True:
            required.add(key)
    return required


def workflow_call_contract(upstream_text: str) -> dict:
    """上流 reusable workflow 本文から ``workflow_call`` の inputs/secrets 契約を取り出す。

    戻り値は ``{"inputs": set[str], "secrets": set[str],
    "required_inputs": set[str], "required_secrets": set[str]}``。
    ``required_*`` は ``required: true`` が明示されたキーのみ（イシュー #343
    Review 指摘: 新 SHA で追加された必須 input/secrets を wrapper が渡して
    いないと、GitHub はジョブ起動前に "Required input <name> is not
    supplied" で失敗し、対象リポ全体の同期が一斉停止する。この片方向欠落を
    ``check_wrapper_contract`` 側で検出するための土台）。
    パース失敗・``workflow_call`` が無い場合は全集合空を返す（fail-closed。
    ``inputs``/``secrets`` が空なら ``check_wrapper_contract`` は wrapper の
    全 ``with``/``secrets`` キーを「契約外」として検出し、bump をスキップ
    する側に倒れる。``required_*`` が空なら必須欠落判定は素通りするが、
    それは「契約自体が読めない」ケースであり既存の契約外キー判定が
    fail-closed を担保する）。
    """
    try:
        spec = yaml.safe_load(upstream_text)
    except yaml.YAMLError:
        return dict(_EMPTY_CONTRACT)
    if not isinstance(spec, dict):
        return dict(_EMPTY_CONTRACT)

    on = cud.workflow_on(spec)
    wc = on.get("workflow_call") if isinstance(on, dict) else None
    if not isinstance(wc, dict):
        return dict(_EMPTY_CONTRACT)

    inputs_spec = wc.get("inputs") if isinstance(wc.get("inputs"), dict) else {}
    secrets_spec = wc.get("secrets") if isinstance(wc.get("secrets"), dict) else {}
    return {
        "inputs": set(inputs_spec.keys()),
        "secrets": set(secrets_spec.keys()),
        "required_inputs": _required_keys(inputs_spec),
        "required_secrets": _required_keys(secrets_spec),
    }


def check_wrapper_contract(wrapper_text: str, contract: dict) -> list[str]:
    """wrapper が渡す ``with:`` / ``secrets:`` キーが新 SHA の契約と両方向で整合するかを確認する。

    契約違反の一覧を返す（空リスト = 違反なし）。reusable workflow の呼び出しは
    次の 2 方向どちらでもジョブ起動前に失敗する仕様のため、両方向を検証する
    （片方向のみだと防げない失敗シナリオがある。イシュー #343 Review 指摘）:

    1. wrapper が渡すキーが呼び先の ``on.workflow_call.inputs``/``secrets``
       に無い（契約外キー）→ "Invalid input, <name> is not defined..."
    2. 新 SHA で ``required: true`` になった input/secrets を wrapper の
       ``with:``/``secrets:`` が渡していない（必須キー欠落）→
       "Required input <name> is not supplied"

    ``contract`` に ``required_inputs``/``required_secrets`` が無い場合
    （テスト等で ``{"inputs": set(...), "secrets": set(...)}`` のみを渡す
    呼び出し）は空集合扱いとし、方向 2 の判定は素通りする（後方互換。
    方向 1 の判定は従来どおり必ず効く）。
    """
    try:
        spec = yaml.safe_load(wrapper_text)
    except yaml.YAMLError as exc:
        return [f"wrapper の YAML パース失敗: {exc}"]
    if not isinstance(spec, dict):
        return ["wrapper が YAML マッピングではない"]

    jobs = spec.get("jobs")
    if not isinstance(jobs, dict):
        return ["jobs セクションが無い"]

    required_inputs = contract.get("required_inputs", set())
    required_secrets = contract.get("required_secrets", set())

    violations: list[str] = []
    for job in jobs.values():
        if not isinstance(job, dict):
            continue
        uses = cud.norm(job.get("uses"))
        if not uses.split("@", 1)[0] == cud.REUSABLE_WORKFLOW_REF:
            continue
        with_ = job.get("with") if isinstance(job.get("with"), dict) else {}
        for key in with_:
            if key not in contract["inputs"]:
                violations.append(f"with.{key} は新 SHA の workflow_call.inputs 契約に無い")
        for key in required_inputs:
            if key not in with_:
                violations.append(
                    f"with.{key} は新 SHA で必須 (required: true) になったが wrapper が渡していない"
                )
        secrets_ = job.get("secrets") if isinstance(job.get("secrets"), dict) else {}
        for key in secrets_:
            if key not in contract["secrets"]:
                violations.append(f"secrets.{key} は新 SHA の workflow_call.secrets 契約に無い")
        for key in required_secrets:
            if key not in secrets_:
                violations.append(
                    f"secrets.{key} は新 SHA で必須 (required: true) になったが wrapper が渡していない"
                )
    return violations


def branch_name(new_sha: str) -> str:
    """bump PR のブランチ名を決定的に生成する（同一 SHA への重複 PR を防ぐ）。"""
    if not cud._SHA40_RE.match(new_sha):
        raise ValueError(f"new_sha が 40 桁 hex ではない: {new_sha!r}")
    return f"chore/update-external-pin-{new_sha[:12]}"


_FULL_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")


def parse_only_repo(only: str) -> tuple[str, str] | None:
    """``--only owner/repo`` の値を検証して ``(owner, name)`` を返す。

    ``cud._REPO_NAME_RE`` はスラッシュを含まない単一セグメント用の正規表現
    であり、``owner/repo`` 形式にはそのまま使えない（そのまま使うと ``only``
    が常に不正値扱いになり実行不能になる）。ここでは ``/`` で分割したうえで、
    owner・repo 名それぞれを ``cud._REPO_NAME_RE`` で検証する（API パスへの
    埋め込み前の構造的なインジェクション対策。OWASP A03）。
    """
    if not _FULL_REPO_RE.match(only):
        return None
    owner, _, name = only.partition("/")
    if not cud._REPO_NAME_RE.match(owner) or not cud._REPO_NAME_RE.match(name):
        return None
    return owner, name


# ---------------------------------------------------------------------------
# I/O レイヤ
# ---------------------------------------------------------------------------


@dataclass
class BumpTarget:
    repo: str
    old_pin: str
    new_text: str
    blob_sha: str  # 現行ファイルの blob sha（PUT の sha パラメータに必要）


@dataclass
class BumpOutcome:
    repo: str
    action: str  # "created" / "skipped-existing-pr" / "skipped-contract" /
    # "skipped-replace-error" / "failed"
    detail: str


def find_bump_candidates(
    org: str, token: str, upstream_sha: str, upstream_text: str
) -> tuple[list[BumpTarget], list[BumpOutcome]]:
    """乖離検知と同じ判定基準（軸 1・軸 2・実効差分ゲート）で bump 対象を選ぶ。

    ``check_update_external_drift.scan`` を丸ごと呼ばない理由: scan() は軸 3-5
    （SYNC-CI-ABSENT・上流マーカー・schedule 生存）まで含めた重い走査で、
    bump 対象の選定に不要な API 呼び出し（Actions API 等）を大量に発生させる。
    ここでは軸 1（WRAPPER）+ 軸 2（PIN_BEHIND）+ 実効差分ゲート（equivalent
    でない）の 3 条件だけを、乖離検知と**同じ純粋関数**を使って再判定する。
    """
    targets: list[BumpTarget] = []
    skipped: list[BumpOutcome] = []

    repos = cud.list_target_repos(org, token)
    compare_cache: dict[str, tuple[str, object]] = {}
    pin_content_cache: dict[str, str | None] = {}

    def compare_pin(pin: str) -> tuple[str, object]:
        if pin in compare_cache:
            return compare_cache[pin]
        st, body = cud.gh_get_with_status(
            f"repos/{cud.UPSTREAM_REPO}/compare/{pin}...main", token
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

    def fetch_pin_workflow(pin: str) -> str | None:
        if pin in pin_content_cache:
            return pin_content_cache[pin]
        st, body = cud.gh_get_with_status(
            f"repos/{cud.UPSTREAM_REPO}/contents/{cud.UPSTREAM_WORKFLOW_PATH}?ref={pin}",
            token,
            raw=True,
        )
        text = body if st == 200 else None
        pin_content_cache[pin] = text
        return text

    for name in repos:
        if name in cud.EXCLUDED_REPOS:
            continue
        if not cud._REPO_NAME_RE.match(name):
            continue
        repo = f"{org}/{name}"
        if repo == cud.UPSTREAM_REPO:
            continue

        status, text = cud.gh_get_with_status(
            f"repos/{repo}/contents/{cud.WORKFLOW_PATH}", token, raw=True
        )
        if status != 200:
            continue  # ファイル無し・取得不能はそもそも bump 対象ではない

        info = cud.classify_workflow(text)
        if info["kind"] != cud.KIND_WRAPPER:
            continue  # LEGACY / UNPARSEABLE / WRAPPER_UNPINNED / 上流本体は対象外

        pin = info["pin"]
        outcome, payload = compare_pin(pin)
        if outcome != "ok":
            continue  # compare できない = 乖離検知側で UNKNOWN 扱いの範囲。触らない

        verdict = cud.evaluate_pin(pin, upstream_sha, payload)
        if verdict["state"] != cud.PIN_BEHIND:
            continue  # 最新 pin・到達不能・異常はここでは扱わない（乖離検知が報告する）

        pin_text = fetch_pin_workflow(pin)
        impact = cud.evaluate_pin_impact(pin_text, upstream_text)
        if impact["equivalent"]:
            continue  # 実効差分なし。bump する意味が無い

        new_text, err = replace_job_uses_ref(text, upstream_sha)
        if err is not None:
            skipped.append(BumpOutcome(repo, "skipped-replace-error", err))
            continue

        contract = workflow_call_contract(upstream_text)
        violations = check_wrapper_contract(new_text, contract)
        if violations:
            skipped.append(
                BumpOutcome(
                    repo, "skipped-contract",
                    "入力契約ゲートに違反: " + "; ".join(violations),
                )
            )
            continue

        # PUT に必要な現行ファイルの blob sha は contents API の raw 取得では
        # 得られないため、非 raw で改めて取得する（サイズ的に軽微な追加呼び出し）。
        blob_status, blob_body = cud.gh_get_with_status(
            f"repos/{repo}/contents/{cud.WORKFLOW_PATH}", token, raw=False
        )
        if blob_status != 200:
            skipped.append(
                BumpOutcome(repo, "skipped-replace-error", f"blob sha 取得が HTTP {blob_status}")
            )
            continue
        try:
            blob_sha = json.loads(blob_body).get("sha", "")
        except json.JSONDecodeError:
            blob_sha = ""
        if not blob_sha:
            skipped.append(
                BumpOutcome(repo, "skipped-replace-error", "blob sha を JSON から取得できない")
            )
            continue

        targets.append(BumpTarget(repo, pin, new_text, blob_sha))

    return targets, skipped


def apply_bump(target: BumpTarget, new_sha: str, token: str, dry_run: bool) -> BumpOutcome:
    """1 リポジトリへ bump PR を作成する（冪等: 既存 open PR があればスキップ）。

    手順は計画（docs/update-external-pin.md）どおり: 既存 PR 確認 →
    ブランチ base 解決 → ref 作成（422 なら既存ブランチとしてスキップ）→
    ファイル更新 → PR 作成。
    """
    branch = branch_name(new_sha)

    # 1. 既存 open PR 確認（冪等）。
    status, body = cud.gh_get_with_status(
        f"repos/{target.repo}/pulls?head={target.repo.split('/')[0]}:{branch}&state=open",
        token,
    )
    if status == 200:
        try:
            existing = json.loads(body)
        except json.JSONDecodeError:
            existing = []
        if existing:
            return BumpOutcome(
                target.repo, "skipped-existing-pr",
                f"branch `{branch}` に open PR #{existing[0].get('number')} が既に存在",
            )

    if dry_run:
        return BumpOutcome(
            target.repo, "dry-run",
            f"branch `{branch}` を作成し PR を出す想定（pin `{target.old_pin[:12]}` → `{new_sha[:12]}`）",
        )

    # 2. base sha 解決（default_branch を決め打ちしない）。
    default_branch = cud.gh_json(f"repos/{target.repo}", token, ".default_branch")
    if not isinstance(default_branch, str) or not default_branch:
        return BumpOutcome(target.repo, "failed", "default_branch を解決できない")
    base_sha = cud.gh_json(
        f"repos/{target.repo}/git/ref/heads/{default_branch}", token, ".object.sha"
    )
    if not isinstance(base_sha, str) or not cud._SHA40_RE.match(base_sha):
        return BumpOutcome(target.repo, "failed", f"base sha を解決できない: {base_sha!r}")

    # 3. ブランチ作成。422 = 既存（前回失敗の残骸等）→ そのブランチを使い回す。
    ref_payload = json.dumps({"ref": f"refs/heads/{branch}", "sha": base_sha})
    ref_status, ref_body = _gh_api_post_status(
        f"repos/{target.repo}/git/refs", ref_payload, token
    )
    if ref_status not in (201, 422):
        return BumpOutcome(target.repo, "failed", f"ブランチ作成が HTTP {ref_status}: {ref_body}")

    # 4. ファイル更新。
    commit_message = (
        f"chore(ci): update-external の pin を {new_sha[:12]} へ更新\n\n"
        f"上流 `{cud.UPSTREAM_WORKFLOW_PATH}` の内容が旧 pin `{target.old_pin[:12]}` から"
        "変化しており、実効差分ゲート（イシュー #343）で乖離ありと判定された。\n\n"
        "Refs #343"
    )
    put_payload = json.dumps({
        "message": commit_message,
        "content": _b64encode(target.new_text),
        "sha": target.blob_sha,
        "branch": branch,
    })
    put_status, put_body = _gh_api_put_status(
        f"repos/{target.repo}/contents/{cud.WORKFLOW_PATH}", put_payload, token
    )
    if put_status not in (200, 201):
        # 403/422（PAT の Workflows: write 不足）はここで名指しして失敗させる。
        # ブランチだけ残ると次回実行が 422 スキップに化けて気づけないため、
        # 作成したブランチを削除してから失敗を返す。
        _delete_ref_best_effort(target.repo, branch, token)
        hint = ""
        if put_status in (403, 422):
            hint = "（PAT に Workflows: write 権限が必要な可能性。docs/update-external-pin.md 参照）"
        return BumpOutcome(
            target.repo, "failed", f"ファイル更新が HTTP {put_status}{hint}: {put_body}"
        )

    # 5. PR 作成。
    pr_body = (
        "## Summary\n"
        f"- `{cud.WORKFLOW_PATH}` の `uses:` pin を `{target.old_pin[:12]}` から "
        f"`{new_sha[:12]}` へ更新（自動生成）\n"
        "- 上流 reusable workflow の内容に実効差分があることを実効差分ゲート"
        "（イシュー #343）で確認済み\n\n"
        "## Test plan\n"
        "- [ ] CI green を確認\n"
        "- [ ] 差分が `uses:` 行 1 行のみであることを確認\n\n"
        "Refs #343"
    )
    pr_payload = json.dumps({
        "title": f"chore(ci): update-external の pin を {new_sha[:12]} へ更新",
        "head": branch,
        "base": default_branch,
        "body": pr_body,
    })
    pr_status, pr_body_resp = _gh_api_post_status(
        f"repos/{target.repo}/pulls", pr_payload, token
    )
    if pr_status != 201:
        # PUT（ファイル更新）は成功済みのため、ここで削除しないと新 SHA へ
        # 更新済みのコミットを持つ open PR の無いブランチが残る。次回実行時、
        # find_bump_candidates は乖離判定を default branch の内容から行うため
        # このブランチの存在自体は再判定に影響しないが、apply_bump の
        # 「既存 open PR 確認」（冪等チェック）はこのブランチを見ないため
        # 再実行のたびに ref 作成が 422 を返すだけの残骸になる。PUT 失敗時と
        # 同様に削除して次回実行をクリーンな状態に保つ（イシュー #343
        # Review 指摘）。
        _delete_ref_best_effort(target.repo, branch, token)
        return BumpOutcome(target.repo, "failed", f"PR 作成が HTTP {pr_status}: {pr_body_resp}")

    try:
        pr_number = json.loads(pr_body_resp).get("number")
    except json.JSONDecodeError:
        pr_number = "?"
    return BumpOutcome(target.repo, "created", f"PR #{pr_number} を作成（branch `{branch}`）")


def _b64encode(text: str) -> str:
    import base64

    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _gh_api_post_status(path: str, payload: str, token: str) -> tuple[int | None, str]:
    return _gh_api_write_status(["gh", "api", "-i", "--method", "POST", path, "--input", "-"], payload, token)


def _gh_api_put_status(path: str, payload: str, token: str) -> tuple[int | None, str]:
    return _gh_api_write_status(["gh", "api", "-i", "--method", "PUT", path, "--input", "-"], payload, token)


def _gh_api_write_status(args: list[str], payload: str, token: str) -> tuple[int | None, str]:
    """書き込み系 ``gh api`` 呼び出しの共通実装。

    リクエストボディは ``--input -`` で stdin から渡す（``-f key=value`` の
    文字列連結・シェル展開を経由させない。OWASP A03）。``-i`` でレスポンス
    ヘッダを取り、``gh_get_with_status`` と同じ理由で終了コードではなく
    HTTP status を読む（403/422 と 5xx を区別するため）。
    """
    import subprocess

    env = dict(os.environ)
    env["GH_TOKEN"] = token
    proc = subprocess.run(args, input=payload, capture_output=True, text=True, env=env)
    stdout = proc.stdout
    status: int | None = None
    if stdout.startswith("HTTP/"):
        parts = stdout.split("\n", 1)[0].split()
        if len(parts) >= 2 and parts[1].isdigit():
            status = int(parts[1])
    body = ""
    for sep in ("\r\n\r\n", "\n\n"):
        if sep in stdout:
            body = stdout.split(sep, 1)[1]
            break
    return status, body


def _delete_ref_best_effort(repo: str, branch: str, token: str) -> None:
    import subprocess

    env = dict(os.environ)
    env["GH_TOKEN"] = token
    subprocess.run(
        ["gh", "api", "--method", "DELETE", f"repos/{repo}/git/refs/heads/{branch}"],
        capture_output=True, text=True, env=env,
    )


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------


def main() -> int:
    org = os.environ.get("TARGET_ORG", "Fandhe-AI")
    token = os.environ.get("READ_TOKEN", "")
    dry_run = os.environ.get("DRY_RUN", "true").strip().lower() != "false"
    limit_raw = os.environ.get("BUMP_LIMIT", "5")
    only_raw = os.environ.get("ONLY_REPO", "").strip()

    if not token:
        print(
            "::error::組織シークレット SUBMODULE_PAT (visibility: all) が未設定。"
            "他リポジトリの読み取り・書き込みができないため fail-closed で停止する。"
        )
        return 1

    try:
        limit = int(limit_raw)
    except ValueError:
        print(f"::error::BUMP_LIMIT の値が不正（{limit_raw!r}）。整数を指定すること。")
        return 1
    if limit <= 0:
        print(f"::error::BUMP_LIMIT は正の整数にすること（指定値: {limit}）。")
        return 1

    only_repo: tuple[str, str] | None = None
    if only_raw:
        only_repo = parse_only_repo(only_raw)
        if only_repo is None:
            print(f"::error::ONLY_REPO の値が owner/repo 形式ではない: {only_raw!r}")
            return 1

    upstream_sha = str(cud.gh_json(f"repos/{cud.UPSTREAM_REPO}/commits/main", token, ".sha")).strip()
    if not cud._SHA40_RE.match(upstream_sha):
        print(f"::error::上流 main SHA の解決結果が不正: {upstream_sha!r}")
        return 1

    status, upstream_text = cud.gh_get_with_status(
        f"repos/{cud.UPSTREAM_REPO}/contents/{cud.UPSTREAM_WORKFLOW_PATH}?ref=main",
        token, raw=True,
    )
    if status != 200:
        print(f"::error::上流 reusable workflow を取得できない（HTTP {status}）")
        return 1

    targets, skipped = find_bump_candidates(org, token, upstream_sha, upstream_text)

    if only_repo is not None:
        want = f"{only_repo[0]}/{only_repo[1]}"
        targets = [t for t in targets if t.repo == want]

    for s in skipped:
        print(f"::warning::{s.repo}: [{s.action}] {s.detail}")

    print(f"bump 対象候補: {len(targets)} 件（上流 main: {upstream_sha[:12]}）")

    applied = 0
    outcomes: list[BumpOutcome] = []
    for target in targets:
        if not dry_run and applied >= limit:
            print(f"::notice::BUMP_LIMIT={limit} に到達。残り {len(targets) - applied} 件は次回実行へ持ち越し")
            break
        outcome = apply_bump(target, upstream_sha, token, dry_run)
        outcomes.append(outcome)
        print(f"{outcome.repo}: [{outcome.action}] {outcome.detail}")
        if outcome.action == "created":
            applied += 1

    failed = [o for o in outcomes if o.action == "failed"]
    if failed:
        print(f"::error::{len(failed)} 件のリポジトリで bump に失敗した（上記ログ参照）")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

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
    "ok": False,
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
    戻り値には ``"ok": bool`` を含む。``ok`` が ``False`` なのは「パース失敗」
    「マッピングでない」「``workflow_call`` が無い/マッピングでない」のいずれか
    ＝**契約そのものを解析できなかった**ケースであり、この場合
    ``inputs``/``secrets``/``required_*`` はすべて空集合を返す（イシュー #343
    Review 指摘: この空集合を「新 SHA は reusable workflow だが inputs/secrets
    契約が空」という**有効な契約**と区別せずに ``check_wrapper_contract`` へ
    渡すと、``with:``/``secrets:`` を一切渡さない wrapper では violations が
    常に空になり、実際には reusable workflow でない・契約を解析できない SHA
    への bump がそのまま素通りしてしまう。呼び出し側（``find_bump_candidates``）
    は ``ok`` が ``False`` の場合、``check_wrapper_contract`` の結果を待たず
    ``skipped-contract`` として bump をスキップしなければならない）。
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
        "ok": True,
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


def scope_by_only_repo(
    targets: list, skipped: list, only_repo: tuple[str, str]
) -> tuple[list, list]:
    """``ONLY_REPO`` 指定時に ``targets``/``skipped`` を対象リポだけへ絞り込む。

    cursor Bugbot 指摘（イシュー #343 Review）: ``targets`` だけ絞って
    ``skipped`` を絞らないと、``main()`` の ``scan_errors``（org 全体の
    検査不能を run 失敗の判定に使う）が無関係な他リポの一時的な API エラー
    まで拾ってしまい、単一リポ限定の run がそれに巻き込まれて失敗する。
    両方を同じ ``want`` で絞り込むことで、ONLY_REPO の走査結果を本当に
    その 1 リポだけへ閉じ込める。
    """
    want = f"{only_repo[0]}/{only_repo[1]}"
    return (
        [t for t in targets if t.repo == want],
        [s for s in skipped if s.repo == want],
    )


@dataclass
class BumpTarget:
    repo: str
    old_pin: str
    old_text: str  # 置換前の wrapper 本文（default branch の内容）。422 時の所有関係検証に使う
    new_text: str
    blob_sha: str  # 現行ファイルの blob sha（PUT の sha パラメータに必要）


def classify_reused_branch(
    old_text: str, branch_text: str, new_sha: str, compare: dict | None
) -> str:
    """422（ref 既存）で再利用しようとしているブランチの所有関係を判定する。

    ブランチ名は新 SHA から決定的に生成される（``branch_name``）ため、既存 PR
    の冪等判定（head ブランチ名で検索）が成立する。その代償として同名の無関係な
    ブランチが存在し得るため、再利用の前に**内容だけでなく差分の形そのもの**を
    検証する（イシュー #343 Review P1 指摘: workflow ファイルの本文一致だけでは、
    同じブランチに別ファイルの変更や追加コミットが載っていても検出できない）。

    引数 ``compare`` は ``GET /repos/{repo}/compare/{default_branch}...{branch}``
    の応答（JSON を dict にしたもの）。取得できなかった場合は ``None`` を渡す。
    検査不能は「所有関係を確認できない」であって「無関係ではない」ではないため、
    いずれも fail-closed で ``"foreign"`` に倒す。

    所有関係の判定は 2 段階で行う。

    1. **差分の形**（``compare``）: base からの差分が「0 コミット・0 ファイル」か
       「1 コミット・``WORKFLOW_PATH`` 1 ファイルのみ・+1/-1 行」のいずれかである
       こと。本スクリプトが作る差分は Contents API の PUT 1 回による単一コミットで、
       変更行は ``uses:`` の pin 1 行だけなので、この 2 形だけが自分の残骸であり得る。
    2. **内容**（``branch_text``）: 上記を満たしたうえで、本文が期待どおりか。

    戻り値:
    - ``"already-bumped"``: ブランチは既にこの ``new_sha`` へ bump 済み
      （前回 run が PUT まで成功したが PR 作成 or その後で失敗した残骸）。
      呼び出し側は PUT をスキップして PR 作成へ進んでよい（cursor Bugbot
      指摘「Reused branch blocks bump retries」の再発防止 — ここでブロック
      すると retry のたびに 422 → 中断を繰り返し、収束しない）。
    - ``"unbumped-retry"``: ブランチが base と完全一致。前回 run が ref 作成のみ
      成功し PUT 前に失敗した残骸。この run が改めて PUT してよい（ただし blob
      sha はブランチ側から取り直す必要がある。default branch 側の blob sha とは
      異なり得るため）。
    - ``"foreign"``: どちらでもない、または検査不能。このスクリプトが書いた内容
      とは断定できないため、呼び出し側は書き込みも削除も行わず中断する。
    """
    if not isinstance(compare, dict):
        return "foreign"

    files = compare.get("files")
    files = files if isinstance(files, list) else []
    # ``total_commits`` はページング上限（250 件）で切り詰められる ``commits``
    # 配列と違い、常に全件数を返す。件数判定には必ずこちらを使う。
    total_commits = compare.get("total_commits")
    if not isinstance(total_commits, int):
        return "foreign"

    if total_commits == 0:
        # base と同一の ref。PUT 前に落ちた残骸であり得る。
        if files:
            return "foreign"
        return "unbumped-retry" if branch_text == old_text else "foreign"

    if total_commits != 1 or len(files) != 1:
        return "foreign"
    f = files[0]
    if not isinstance(f, dict):
        return "foreign"
    if f.get("filename") != cud.WORKFLOW_PATH:
        return "foreign"
    if f.get("status") != "modified":
        return "foreign"
    # pin の書き換えは 1 行の置換なので +1/-1 に限る。これ以外は本スクリプトの
    # 生成物ではない。
    if f.get("additions") != 1 or f.get("deletions") != 1:
        return "foreign"

    info = cud.classify_workflow(branch_text)
    if info["kind"] == cud.KIND_WRAPPER and info["pin"] == new_sha:
        return "already-bumped"
    return "foreign"


@dataclass
class BumpOutcome:
    repo: str
    action: str  # "created" / "skipped-existing-pr" / "skipped-contract" /
    # "skipped-replace-error" / "skipped-scan-error" / "failed"
    # "skipped-scan-error" は API 障害等で検査そのものができなかったケース
    # （404 によるファイル不在等の正当な対象外とは区別する）。main() はこの
    # action を「検査不能」として扱い、run 全体を失敗させる（イシュー #343
    # Review 指摘: 検査不能を候補 0 件の成功扱いに畳んで自動追従の停止を
    # 見逃さないため）。
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
        # イシュー #343 Review 指摘: head を可変の ``main`` にすると、呼び出し元
        # main() が固定取得した ``upstream_sha``/``upstream_text`` と、ここで
        # 取得する ahead_by/behind_by の基準点がずれ得る（呼び出しまでの間に
        # main が進む TOCTOU）。head も同じ ``upstream_sha`` に固定する
        # （check_update_external_drift.scan() の compare_pin と同じ修正）。
        st, body = cud.gh_get_with_status(
            f"repos/{cud.UPSTREAM_REPO}/compare/{pin}...{upstream_sha}", token
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
        if status == 404:
            continue  # ファイル無し = このリポは wrapper で管理されていない。対象外
        if status != 200:
            # イシュー #343 Review 指摘: 404（ファイル無し）と 403/429/5xx
            # （検査不能）を同一の continue で畳むと、API 障害で全対象を検査
            # できなくても候補 0 件のまま成功扱いになり、自動追従の停止に
            # 気づけない。404 以外は理由を記録した上でこのリポをスキップし、
            # main() 側で「検査不能があった run は失敗させる」判定に使う。
            skipped.append(
                BumpOutcome(
                    repo, "skipped-scan-error",
                    f"wrapper ファイル取得が HTTP {status}。検査不能",
                )
            )
            continue

        info = cud.classify_workflow(text)
        if info["kind"] != cud.KIND_WRAPPER:
            continue  # LEGACY / UNPARSEABLE / WRAPPER_UNPINNED / 上流本体は対象外

        pin = info["pin"]
        outcome, payload = compare_pin(pin)
        if outcome == "absent":
            continue  # pin が上流に存在しない（compare 404）= 乖離検知側で扱う範囲
        if outcome != "ok":
            # 403/429/5xx や JSON 解析失敗は「compare できない」だけで、pin が
            # 壊れている証拠にはならない（check_update_external_drift.py の
            # compare_pin と同じ理由）。検査不能として記録し、run 全体を
            # 失敗させる判定材料にする（イシュー #343 Review 指摘）。
            skipped.append(
                BumpOutcome(
                    repo, "skipped-scan-error",
                    f"pin `{pin[:12]}` の compare 取得が失敗: {payload}",
                )
            )
            continue

        verdict = cud.evaluate_pin(pin, upstream_sha, payload)
        if verdict["state"] != cud.PIN_BEHIND:
            continue  # 最新 pin・到達不能・異常はここでは扱わない（乖離検知が報告する）

        pin_text = fetch_pin_workflow(pin)
        if pin_text is None:
            # イシュー #343 Review 指摘: fetch_pin_workflow が 403/429/5xx で
            # None を返した場合、evaluate_pin_impact(None, upstream_text) は
            # fail-closed で equivalent=False を返す。これは「実効差分あり」
            # と区別が付かず、そのまま bump・PR 作成へ進んでしまう。取得不能を
            # 検査不能として記録し、pin_text と upstream_text の不一致を実際に
            # 確認できた場合のみ書き込み対象にする。
            skipped.append(
                BumpOutcome(
                    repo, "skipped-scan-error",
                    f"pin `{pin[:12]}` の workflow 本文取得に失敗。検査不能なため bump しない",
                )
            )
            continue
        impact = cud.evaluate_pin_impact(pin_text, upstream_text)
        if impact["equivalent"]:
            continue  # 実効差分なし。bump する意味が無い

        new_text, err = replace_job_uses_ref(text, upstream_sha)
        if err is not None:
            skipped.append(BumpOutcome(repo, "skipped-replace-error", err))
            continue

        contract = workflow_call_contract(upstream_text)
        if not contract.get("ok", True):
            # イシュー #343 Review 指摘: 契約が解析不能（パース失敗・
            # マッピングでない・workflow_call 不在）な場合、空集合の契約を
            # そのまま check_wrapper_contract に渡すと with:/secrets: を
            # 渡さない wrapper では violations が空になり素通りしてしまう。
            # 「有効な空契約」と区別し、ここで明示的にスキップする。
            skipped.append(
                BumpOutcome(
                    repo, "skipped-contract",
                    "新 SHA の workflow_call 契約を解析できない"
                    "（パース失敗/マッピングでない/workflow_call 不在）。"
                    "fail-closed のためスキップ",
                )
            )
            continue
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

        targets.append(BumpTarget(repo, pin, text, new_text, blob_sha))

    return targets, skipped


def apply_bump(target: BumpTarget, new_sha: str, token: str, dry_run: bool) -> BumpOutcome:
    """1 リポジトリへ bump PR を作成する（冪等: 既存 open PR があればスキップ）。

    手順は計画（docs/update-external-pin.md）どおり: 既存 PR 確認 →
    ブランチ base 解決 → ref 作成（422 なら既存ブランチとしてスキップ）→
    ファイル更新 → PR 作成。
    """
    branch = branch_name(new_sha)

    # 1. 既存 open PR 確認（冪等）。
    #
    # イシュー #343 Review 指摘: 403/5xx や JSON 解析失敗を「既存 PR なし」と
    # 同一視して処理を続けると、実際には存在する既存 PR を見落として
    # ブランチ再作成・ファイル更新・PR 作成を試み、最終的に
    # ``_delete_ref_best_effort`` が既存 PR の head ブランチを削除し得る。
    # 一覧 API が 200 以外を返した時点で fail-closed に倒し、このリポの
    # bump を中断する（次回実行で再判定される）。
    status, body = cud.gh_get_with_status(
        f"repos/{target.repo}/pulls?head={target.repo.split('/')[0]}:{branch}&state=open",
        token,
    )
    if status != 200:
        return BumpOutcome(
            target.repo, "failed",
            f"既存 PR 確認が HTTP {status}。安全のため中断（既存 PR 誤削除を避けるため fail-closed）",
        )
    try:
        existing = json.loads(body)
    except json.JSONDecodeError:
        return BumpOutcome(
            target.repo, "failed",
            "既存 PR 確認の応答を JSON として解析できない。安全のため中断",
        )
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

    # 3. ブランチ作成。422 = 既存（前回失敗の残骸等）。
    ref_payload = json.dumps({"ref": f"refs/heads/{branch}", "sha": base_sha})
    ref_status, ref_body = _gh_api_post_status(
        f"repos/{target.repo}/git/refs", ref_payload, token
    )
    if ref_status not in (201, 422):
        return BumpOutcome(target.repo, "failed", f"ブランチ作成が HTTP {ref_status}: {ref_body}")

    # イシュー #343 Review P0 指摘: 422（既存ブランチ再利用）はこの実行で
    # 作成したブランチとは限らない（前回失敗の残骸のこともあれば、既存 PR
    # の head ブランチが手順1の確認をすり抜けて再利用されるケースもあり
    # 得る）。ブランチ名は new_sha から決定的に生成されるため無関係な衝突は
    # 起きにくいが、それでも中身を確認せずに書き込み・削除すると無関係な
    # コミット混入やブランチ消失を招く。ここでは削除は一切この実行が
    # 実際に ref を作成した（201）場合に限定し（``created_ref_this_run``）、
    # 422 の場合はブランチ内容を取得して ``classify_reused_branch`` で
    # 所有関係を検証できたときだけ再利用する。検証できなければ書き込みも
    # 削除もせず fail-closed で中断する。
    created_ref_this_run = ref_status == 201
    blob_sha_for_put = target.blob_sha
    skip_put = False

    if ref_status == 422:
        branch_status, branch_body = cud.gh_get_with_status(
            f"repos/{target.repo}/contents/{cud.WORKFLOW_PATH}?ref={branch}", token, raw=True,
        )
        if branch_status != 200:
            return BumpOutcome(
                target.repo, "failed",
                f"既存ブランチ `{branch}` の内容取得が HTTP {branch_status}。"
                "所有関係を検証できないため中断（ブランチには一切触れない）",
            )
        # 差分の形（コミット数・変更ファイル・変更行数）まで検証するため、
        # 本文だけでなく compare 応答も渡す（イシュー #343 Review P1 指摘）。
        cmp_status, cmp_body = cud.gh_get_with_status(
            f"repos/{target.repo}/compare/{default_branch}...{branch}", token,
        )
        compare_payload: dict | None = None
        if cmp_status == 200:
            try:
                parsed = json.loads(cmp_body)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                compare_payload = parsed
        reuse = classify_reused_branch(
            target.old_text, branch_body, new_sha, compare_payload
        )
        if reuse == "foreign":
            return BumpOutcome(
                target.repo, "failed",
                f"branch `{branch}` は既存だが、本スクリプトが作る差分の形"
                "（base と同一、または `uses:` 1 行のみを変える単一コミット）と一致しない、"
                "もしくは compare を取得できず検証不能。"
                "所有関係を確認できないため中断（上書きも削除もしない。手動確認が必要）",
            )
        if reuse == "already-bumped":
            # PUT は不要。前回 run が PUT まで成功し PR 作成以降で失敗した
            # 残骸。ここで中断すると retry のたびに 422 → 中断を繰り返し
            # 収束しない（cursor Bugbot 指摘「Reused branch blocks bump
            # retries」の再発防止）。PR 作成へそのまま進む。
            skip_put = True
        else:  # "unbumped-retry"
            # 前回 run が ref 作成のみ成功して PUT 前に失敗した残骸。
            # ブランチは default branch 時点のまま止まっているため、この
            # run が改めて PUT する。書き込み対象の blob sha はブランチ側
            # から取り直す（default branch 側の blob sha とは異なり得る）。
            blob_status2, blob_body2 = cud.gh_get_with_status(
                f"repos/{target.repo}/contents/{cud.WORKFLOW_PATH}?ref={branch}", token, raw=False,
            )
            if blob_status2 != 200:
                return BumpOutcome(
                    target.repo, "failed", f"既存ブランチの blob sha 取得が HTTP {blob_status2}"
                )
            try:
                blob_sha_for_put = json.loads(blob_body2).get("sha", "")
            except json.JSONDecodeError:
                blob_sha_for_put = ""
            if not blob_sha_for_put:
                return BumpOutcome(
                    target.repo, "failed", "既存ブランチの blob sha を JSON から取得できない"
                )

    # 4. ファイル更新（``already-bumped`` の場合は不要なのでスキップ）。
    if not skip_put:
        commit_message = (
            f"chore(ci): update-external の pin を {new_sha[:12]} へ更新\n\n"
            f"上流 `{cud.UPSTREAM_WORKFLOW_PATH}` の内容が旧 pin `{target.old_pin[:12]}` から"
            "変化しており、実効差分ゲート（イシュー #343）で乖離ありと判定された。\n\n"
            "Refs #343"
        )
        put_payload = json.dumps({
            "message": commit_message,
            "content": _b64encode(target.new_text),
            "sha": blob_sha_for_put,
            "branch": branch,
        })
        put_status, put_body = _gh_api_put_status(
            f"repos/{target.repo}/contents/{cud.WORKFLOW_PATH}", put_payload, token
        )
        if put_status not in (200, 201):
            # 403/422（PAT の Workflows: write 不足）はここで名指しして失敗させる。
            # 削除はこの実行が実際に ref を作成した（201）場合のみ行う。422 で
            # 再利用したブランチ（所有関係は検証済みだが、それでも「削除して
            # よい」とは別の判断）は削除せず、失敗メッセージで手動確認を促す
            # （残骸クリーンアップより誤削除防止を優先する。イシュー #343
            # Review P0 指摘）。
            detail_suffix = ""
            if created_ref_this_run:
                _delete_ref_best_effort(target.repo, branch, token)
            else:
                detail_suffix = f"（branch `{branch}` はこの実行が作成したものではないため削除せず残置。手動確認推奨）"
            hint = ""
            if put_status in (403, 422):
                hint = "（PAT に Workflows: write 権限が必要な可能性。docs/update-external-pin.md 参照）"
            return BumpOutcome(
                target.repo, "failed",
                f"ファイル更新が HTTP {put_status}{hint}: {put_body}{detail_suffix}",
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
        # イシュー #343 Review P0 指摘: 「4. ファイル更新」の失敗経路と同じ
        # 理由で、削除はこの実行が実際に ref を作成した（201）場合のみに
        # 限定する。422 で再利用したブランチは ``classify_reused_branch`` で
        # 所有関係を確認済みだが、それは「書き込んでよい」の判断であって
        # 「削除してよい」の判断ではない——他 run・他プロセスが同じブランチへ
        # 並行して触れている可能性を排除できないため、誤削除防止を優先する。
        #
        # これにより「以降の run が同じブランチ名へ ref 作成 → 422 →
        # PR 未作成のまま滞留する」問題（cursor Bugbot 指摘「Reused branch
        # blocks bump retries」）は削除では解決しない。代わりに、この
        # ブランチは既に new_sha へ bump 済みの内容を持つため、次回 run は
        # 422 → ``classify_reused_branch`` が ``"already-bumped"`` と判定して
        # PUT をスキップし、そのまま PR 作成へ進む（上の 3-4 節）。つまり
        # retry の収束は「削除して作り直す」ではなく「内容が既にゴールと
        # 一致していれば PUT を省略する」ことで担保する。
        if created_ref_this_run:
            _delete_ref_best_effort(target.repo, branch, token)
        return BumpOutcome(
            target.repo, "failed",
            f"PR 作成が HTTP {pr_status}: {pr_body_resp}",
        )

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
        # イシュー #343 Review P1 指摘: 組織共有の SUBMODULE_PAT を、この
        # 新しい「組織横断でブランチ・workflow ファイル・PR を書き込む」
        # 経路へ転用しない。対象リポジトリと必要権限だけに絞った専用 PAT を
        # 必須とし、共有 PAT へのフォールバックは設けない（最小権限）。
        print(
            "::error::シークレット WORKFLOW_PIN_PAT が未設定。"
            "pin bump 専用 PAT（対象リポジトリのみ・Contents: write / "
            "Pull requests: write / Workflows: write）を設定すること。"
            "共有の SUBMODULE_PAT へのフォールバックは意図的に設けていない。"
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

    # イシュー #343 Review 指摘: ここを ``ref=main`` で再取得すると、上の
    # commits/main 呼び出しから本呼び出しまでの間に main が動いた場合、
    # ``upstream_sha``（pin 対象として書き込む SHA）と本文の内容が食い違う
    # （TOCTOU）。以降 ``find_bump_candidates``/``check_wrapper_contract`` は
    # この本文を「``upstream_sha`` 時点の内容」として実効差分・契約判定に
    # 使うため、ref を ``upstream_sha`` に固定して両者を一致させる。
    status, upstream_text = cud.gh_get_with_status(
        f"repos/{cud.UPSTREAM_REPO}/contents/{cud.UPSTREAM_WORKFLOW_PATH}?ref={upstream_sha}",
        token, raw=True,
    )
    if status != 200:
        print(f"::error::上流 reusable workflow を取得できない（HTTP {status}）")
        return 1

    targets, skipped = find_bump_candidates(org, token, upstream_sha, upstream_text)

    if only_repo is not None:
        targets, skipped = scope_by_only_repo(targets, skipped, only_repo)

    for s in skipped:
        level = "error" if s.action == "skipped-scan-error" else "warning"
        print(f"::{level}::{s.repo}: [{s.action}] {s.detail}")

    # イシュー #343 Review 指摘: 候補走査で API 障害等により検査できなかった
    # リポがあっても、targets が正当に 0 件のケースと区別が付かないまま
    # 素通りすると「候補 0 件 = 乖離なし」に見えてしまい、自動追従の停止に
    # 気づけない。検査不能が 1 件でもあれば run を失敗させる。
    scan_errors = [s for s in skipped if s.action == "skipped-scan-error"]

    print(f"bump 対象候補: {len(targets)} 件（上流 main: {upstream_sha[:12]}）")

    applied = 0
    outcomes: list[BumpOutcome] = []
    for target in targets:
        if not dry_run and applied >= limit:
            print(f"::notice::BUMP_LIMIT={limit} に到達。残り {len(targets) - applied} 件は次回実行へ持ち越し")
            break
        # イシュー #343 Review 指摘: apply_bump 内の cud.gh_json 呼び出し
        # （default_branch・base sha 解決）は API 失敗時に ``cud.ScanError``
        # を送出する。ここで捕捉しないと 1 リポの API 失敗がループ全体を
        # 中断させ、以降の bump 対象リポが一切処理されなくなる（1 リポの
        # 失敗が他へ波及しない設計意図に反する）。捕捉して failed 扱いに
        # 変換し、次のリポへ処理を続ける。
        try:
            outcome = apply_bump(target, upstream_sha, token, dry_run)
        except cud.ScanError as exc:
            outcome = BumpOutcome(target.repo, "failed", f"予期しない API 失敗で中断: {exc}")
        outcomes.append(outcome)
        print(f"{outcome.repo}: [{outcome.action}] {outcome.detail}")
        if outcome.action == "created":
            applied += 1

    failed = [o for o in outcomes if o.action == "failed"]
    if failed:
        print(f"::error::{len(failed)} 件のリポジトリで bump に失敗した（上記ログ参照）")
        return 1

    if scan_errors:
        print(
            f"::error::{len(scan_errors)} 件のリポジトリで検査不能（API 障害等）だった"
            "（上記ログ参照）。自動追従の停止を検知できないため run を失敗させる"
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

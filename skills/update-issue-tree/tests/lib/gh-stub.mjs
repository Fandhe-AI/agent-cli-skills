// gh-stub.mjs — reassign-sub-issue.sh の決定的回帰テスト用に、実 API を叩かずに `gh` を
// 差し替えるスタブを生成する。テストは実行ログ（$GH_CALL_LOG）に対して直接アサートすることで、
// 「DELETE が失敗したら POST が 1 件も呼ばれない」等の呼び出し順序・回数の契約を検証する。
//
// スタブは対象 issue への GET を 1 回目=事前確認・2 回目以降=事後確認として区別する
// （reassign-sub-issue.sh は必ず「事前 GET → [DELETE] → [POST] → 事後 GET」の順で呼ぶため）。

import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// シェルの単一引用符リテラル内に安全に埋め込むためのエスケープ（ ' → '\'' ）
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * @param {object} fixture
 * @param {boolean} [fixture.authFail] gh auth status を失敗させる
 * @param {boolean} [fixture.getFail] 事前 GET（1 回目）を失敗させる
 * @param {boolean} [fixture.verifyGetFail] 事後 GET（2 回目）を失敗させる
 * @param {string} [fixture.issueId] GET が返す database id
 * @param {string} [fixture.parentBefore] 事前 GET が返す現在の親 issue 番号（'' = 親なし）
 * @param {string} [fixture.parentAfter] 事後 GET が返す親 issue 番号（未指定なら parentBefore を継続）
 * @param {string} [fixture.parentRepo] 親が属する owner/repo（既定 'o/r' = 対象 issue と同一）
 * @param {number} [fixture.deleteExit] DELETE の終了コード
 * @param {string} [fixture.deleteBody] DELETE 失敗時に stderr へ出す本文
 * @param {number} [fixture.postExit] POST の終了コード
 * @param {string} [fixture.postBody] POST 失敗時に stderr へ出す本文（"only have one parent" 判定に使う）
 */
export function createGhStub(fixture = {}) {
  const f = {
    authFail: false,
    getFail: false,
    verifyGetFail: false,
    issueId: '999',
    parentBefore: '',
    parentAfter: undefined,
    // 親が属するリポジトリ。既定は対象 issue と同一（repository_url の o/r と一致）。
    // 'other/repo' 等を渡すと cross-repository sub-issue を再現できる
    parentRepo: 'o/r',
    deleteExit: 0,
    deleteBody: '',
    postExit: 0,
    postBody: '',
    ...fixture,
  }
  if (f.parentAfter === undefined) f.parentAfter = f.parentBefore

  const dir = mkdtempSync(join(tmpdir(), 'reassign-gh-stub-'))
  const ghPath = join(dir, 'gh')
  const logPath = join(dir, 'calls.log')
  const getCountPath = join(dir, 'get_count')
  writeFileSync(getCountPath, '0')

  const authBranch = f.authFail ? 'exit 1' : 'exit 0'
  const getFailBranch = f.getFail ? "echo 'stub: get failed' >&2; exit 1" : ':'
  const verifyGetFailBranch = f.verifyGetFail ? "echo 'stub: verify get failed' >&2; exit 1" : ':'

  const script = `#!/usr/bin/env bash
# 生成スタブ。実 gh の代わりに PATH の先頭へ差し込んで使う（テスト専用・実行ビット付き）
set -u
echo "$*" >> ${shQuote(logPath)}
cmd="\${1:-}"

if [[ "\${cmd}" == "auth" ]]; then
  ${authBranch}
fi

if [[ "\${cmd}" != "api" ]]; then
  exit 0
fi
shift

method="GET"
path=""
while [[ $# -gt 0 ]]; do
  case "\${1:-}" in
    --method) method="$2"; shift 2 ;;
    -F) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done

if [[ "\${path}" == *"/sub_issue" && "\${method}" == "DELETE" ]]; then
  printf '%s' ${shQuote(f.deleteBody)} >&2
  exit ${f.deleteExit}
fi

if [[ "\${path}" == *"/sub_issues" && "\${method}" == "POST" ]]; then
  printf '%s' ${shQuote(f.postBody)} >&2
  exit ${f.postExit}
fi

# GET issue（事前確認 1 回目 / 事後確認 2 回目以降）
count=$(cat ${shQuote(getCountPath)})
count=$((count + 1))
echo "\${count}" > ${shQuote(getCountPath)}

if [[ "\${count}" -eq 1 ]]; then
  ${getFailBranch}
  parent=${shQuote(f.parentBefore)}
else
  ${verifyGetFailBranch}
  parent=${shQuote(f.parentAfter)}
fi

if [[ -n "\${parent}" ]]; then
  printf '{"id": ${f.issueId}, "repository_url": "https://api.github.com/repos/o/r", "parent_issue_url": "https://api.github.com/repos/${f.parentRepo}/issues/%s"}\\n' "\${parent}"
else
  printf '{"id": ${f.issueId}, "repository_url": "https://api.github.com/repos/o/r", "parent_issue_url": null}\\n'
fi
`

  writeFileSync(ghPath, script)
  chmodSync(ghPath, 0o755)

  return {
    dir,
    ghPath,
    logPath,
    env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
  }
}

// agent-guard.sh の照合（grep）と分割（tr）の失敗を fail-closed に倒す回帰テスト。
//
// 契約: grep の終了コードは 0（一致）/ 1（不一致）/ 2 以上（構文エラー・入出力エラー）。2 以上を
// 不一致と同じに扱うと、deny の証拠照合が黙って不成立になり許可へ倒れる（fail-open）。ガードは
// 2 以上を見たら `AGENT_GUARD_RESULT deny internal-error`（終了 2）を返す。レビュー承認の検査に使う
// tr の失敗（空の結果で event・-a の検査を飛ばす）も同じく deny にする。
// 偽の grep / tr はテストごとの一時ディレクトリに置き、PATH の先頭に足す。
//   - always: 常に exit 2 する grep（subagent の判定は最初の照合で deny になる）
//   - selective: 引数のどれかが鍵の文字列を含む呼び出しだけ exit 2、それ以外は本物の grep へ渡す
//     （照合の箇所を 1 つずつ壊し、その箇所の deny が出ることを確かめる）
// 入力はいずれも、本物の grep では deny の判定が grep の照合に依存するもの。subagent が true と null
// （判別不能）の両方で、/bin/bash（3.2）と PATH の bash（5 系）で流す。merge-guard-hook.sh 側の同じ
// 判定は implement-issue-tree の tests/merge-guard-grep-failclosed.test.mjs が見る。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')

const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]
const which = (c) => execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim()
const REAL_GREP = which('grep')
const REAL_TR = which('tr')

function writeExe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function run(bash, command, subagent, { pathPrefix, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [GUARD], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PATH: `${pathPrefix}:${process.env.PATH}` },
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l !== '')
      resolve({ code, last: lines[lines.length - 1] ?? '' })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(JSON.stringify({ command, subagent }))
  })
}

function expectAllow(r) {
  assert.equal(r.last, 'AGENT_GUARD_RESULT allow')
  assert.equal(r.code, 0)
}
function expectDeny(r, reason) {
  assert.equal(r.last, `AGENT_GUARD_RESULT deny ${reason}`)
  assert.equal(r.code, 2)
}

const REVIEW_COMMENT_GQL = `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:COMMENT}){clientMutationId}}'`

// [壊す照合の鍵（その grep の引数にだけ含まれる文字列）, 入力]。どれも deny internal-error を期待する
const SITES = [
  ["[$]'", 'gh pr view 5'],
  ['{?IFS', 'gh pr view 5'],
  ['pulls/.*/merge', 'gh api -X PUT repos/o/r/pulls/1/merge'],
  ['[^[:space:]=-][^[:space:]=]*=', 'gh api repos/o/r/rulesets/1 -f name=x'],
  ['(^|[[:space:]])--input(', 'gh api repos/o/r/pulls/5/reviews --input body.json'],
  ['(^|[[:space:]])--input(', 'gh api graphql --input q.json'],
  ['=[[:space:]]*@', REVIEW_COMMENT_GQL],
  ['[Gg][Ee][Tt]([^A-Za-z]|$)', 'gh api -X GET repos/o/r/rulesets/1 -f x=1'],
  ['--approve([[:space:]]|$|=)', 'gh pr review 5 --approve'],
  // 変更前から rc を受けていた 2 箇所（event の取り出し）。回帰の対照
  ['event[[:space:]]*=', 'gh api repos/o/r/pulls/5/reviews -f event=COMMENT'],
  ['event[[:space:]]*:', REVIEW_COMMENT_GQL],
]

// 本物の grep では許可、または grep を使わずに deny が決まらない入力（以前は grep が壊れると許可に倒れた）
const ALWAYS_DENY = [
  'gh pr view 5',
  'ls',
  'gh pr review 5 --approve',
  'gh api -X PUT repos/o/r/pulls/1/merge',
  'gh api repos/o/r/rulesets/1 -f name=x',
  "echo $'\\x67\\x68' pr merge 5",
]

for (const bash of BASHES) {
  describe(`agent-guard.sh の grep / tr の失敗は deny internal-error（${bash}）`, () => {
    let dir
    let alwaysDir
    let selectiveDir
    let trDir
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-guard-grepfail-'))
      alwaysDir = join(dir, 'always')
      selectiveDir = join(dir, 'selective')
      trDir = join(dir, 'tr')
      for (const d of [alwaysDir, selectiveDir, trDir]) mkdirSync(d)
      writeExe(join(alwaysDir, 'grep'), '#!/bin/sh\nexit 2\n')
      writeExe(join(selectiveDir, 'grep'), [
        '#!/bin/sh',
        'key=${GREP_FAIL_KEY-}',
        'for a in "$@"; do',
        '  case "$a" in *"$key"*) [ -n "$key" ] && exit 2 ;; esac',
        'done',
        `exec '${REAL_GREP}' "$@"`,
        '',
      ].join('\n'))
      // `tr ' ' '\n'`（トークンを 1 行ずつにする分割）だけを失敗させる。他の tr は本物へ渡す
      writeExe(join(trDir, 'tr'), [
        '#!/bin/sh',
        `if [ "$#" -eq 2 ] && [ "$1" = ' ' ] && [ "$2" = '\\n' ]; then exit 2; fi`,
        `exec '${REAL_TR}' "$@"`,
        '',
      ].join('\n'))
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    for (const subagent of [true, null]) {
      describe(`subagent=${subagent}`, () => {
        describe('常に exit 2 する grep', { concurrency: 8 }, () => {
          for (const cmd of ALWAYS_DENY) {
            it(`deny internal-error: ${cmd}`, async () => {
              expectDeny(await run(bash, cmd, subagent, { pathPrefix: alwaysDir }), 'internal-error')
            })
          }
        })

        describe('照合の箇所を 1 つずつ壊す（その箇所の grep だけ exit 2）', { concurrency: 8 }, () => {
          for (const [key, cmd] of SITES) {
            it(`deny internal-error: 鍵 ${key} / ${cmd}`, async () => {
              const r = await run(bash, cmd, subagent, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: key } })
              expectDeny(r, 'internal-error')
            })
          }
          // 偽の grep が本物へ素通しすることの対照（鍵が一致しなければ判定は本物の grep と同じ）
          it('素通しの対照: allow: gh pr view 5', async () => {
            expectAllow(await run(bash, 'gh pr view 5', subagent, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: 'ZZ_NEVER_MATCH_ZZ' } }))
          })
          it(`素通しの対照: allow: ${REVIEW_COMMENT_GQL}`, async () => {
            expectAllow(await run(bash, REVIEW_COMMENT_GQL, subagent, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: 'ZZ_NEVER_MATCH_ZZ' } }))
          })
          it('素通しの対照: deny merge-guard: gh pr review 5 --approve', async () => {
            expectDeny(await run(bash, 'gh pr review 5 --approve', subagent, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: 'ZZ_NEVER_MATCH_ZZ' } }), 'merge-guard')
          })
        })

        describe('レビュー承認の検査に使う tr の失敗', { concurrency: 8 }, () => {
          it('引用符を追えない形の event 検査（norm を分割する tr）が失敗したら deny internal-error', async () => {
            const cmd = "gh api repos/o/r/pulls/5/reviews -f event=APPROVE # it's"
            expectDeny(await run(bash, cmd, subagent, { pathPrefix: trDir }), 'internal-error')
          })
          it('-a の flat 走査（tokenized を分割する tr）が失敗したら deny internal-error', async () => {
            expectDeny(await run(bash, "bash -c 'gh pr review 5 -a'", subagent, { pathPrefix: trDir }), 'internal-error')
          })
          it('分割を使わない入力は本物の tr と同じ判定（許可）', async () => {
            expectAllow(await run(bash, 'gh pr view 5', subagent, { pathPrefix: trDir }))
          })
        })
      })
    }

    it('main セッション（subagent=false）は grep に到達せず許可のまま', async () => {
      expectAllow(await run(bash, 'ls', false, { pathPrefix: alwaysDir }))
    })
  })
}

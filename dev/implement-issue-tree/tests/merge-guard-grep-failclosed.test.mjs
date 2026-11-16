// merge-guard-hook.sh の照合（grep）と分割（tr）の失敗を fail-closed に倒す回帰テスト。
//
// 契約: grep の終了コードは 0（一致）/ 1（不一致）/ 2 以上（構文エラー・入出力エラー）。2 以上を
// 不一致と同じに扱うと、deny の証拠照合が黙って不成立になり許可へ倒れる（fail-open）。hook は
// 2 以上を見たら deny を返す。レビュー承認の検査に使う tr の失敗（空の結果で event・-a の検査を
// 飛ばす）も同じく deny にする。
// 偽の grep / tr はテストごとの一時ディレクトリに置き、PATH の先頭に足す。
//   - always: 常に exit 2 する grep（subagent の判定は最初の照合で deny になる）
//   - selective: 引数のどれかが鍵の文字列を含む呼び出しだけ exit 2、それ以外は本物の grep へ渡す
//     （照合の箇所を 1 つずつ壊し、その箇所の deny が出ることを確かめる）
// 入力はいずれも、本物の grep では deny の判定が grep の照合に依存するもの（gh pr merge のように
// grep を使わずに止まる形は証拠にならないので使わない）。/bin/bash（3.2）と PATH の bash（5 系）で流す。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'implement-issue-tree', 'scripts', 'merge-guard-hook.sh')

const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]
const which = (c) => execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim()
const REAL_GREP = which('grep')
const REAL_TR = which('tr')

const GREP_REASON = 'implement-issue-tree-merge-guard: 判定の照合（grep）に失敗したため deny（fail-closed）'
const TR_REASON = 'implement-issue-tree-merge-guard: 判定の分割（tr）に失敗したため deny（fail-closed）'

function writeExe(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function run(bash, command, { agentId = 'agent-1', pathPrefix, env = {} } = {}) {
  const input = { tool_name: 'Bash', tool_input: { command } }
  if (agentId) input.agent_id = agentId
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PATH: `${pathPrefix}:${process.env.PATH}` },
    })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}`))
      if (out.trim() === '') return resolve({ decision: 'allow' })
      const o = JSON.parse(out)
      resolve({ decision: o.hookSpecificOutput.permissionDecision, reason: o.hookSpecificOutput.permissionDecisionReason })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(JSON.stringify(input))
  })
}

const REVIEW_COMMENT_GQL = `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:COMMENT}){clientMutationId}}'`

// [壊す照合の鍵（その grep の引数にだけ含まれる文字列）, 入力, 期待する deny の理由]
const SITES = [
  ["[$]'", 'gh pr view 5', GREP_REASON],
  ['{?IFS', 'gh pr view 5', GREP_REASON],
  ['pulls/.*/merge', 'gh api -X PUT repos/o/r/pulls/1/merge', GREP_REASON],
  ['[^[:space:]=-][^[:space:]=]*=', 'gh api repos/o/r/rulesets/1 -f name=x', GREP_REASON],
  ['(^|[[:space:]])--input(', 'gh api repos/o/r/pulls/5/reviews --input body.json', GREP_REASON],
  ['(^|[[:space:]])--input(', 'gh api graphql --input q.json', GREP_REASON],
  ['=[[:space:]]*@', REVIEW_COMMENT_GQL, GREP_REASON],
  ['[Gg][Ee][Tt]([^A-Za-z]|$)', 'gh api -X GET repos/o/r/rulesets/1 -f x=1', GREP_REASON],
  ['--approve([[:space:]]|$|=)', 'gh pr review 5 --approve', GREP_REASON],
  // 変更前から rc を受けていた 2 箇所（event の取り出し）。回帰の対照
  ['event[[:space:]]*=', 'gh api repos/o/r/pulls/5/reviews -f event=COMMENT', 'implement-issue-tree-merge-guard: event の検査（grep）に失敗したため deny（fail-closed）'],
  ['event[[:space:]]*:', REVIEW_COMMENT_GQL, 'implement-issue-tree-merge-guard: GraphQL の event の検査（grep）に失敗したため deny（fail-closed）'],
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
  describe(`merge-guard-hook.sh の grep / tr の失敗は deny（${bash}）`, () => {
    let dir
    let alwaysDir
    let selectiveDir
    let trDir
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'mg-grepfail-'))
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

    describe('常に exit 2 する grep', { concurrency: 8 }, () => {
      for (const cmd of ALWAYS_DENY) {
        it(`deny: ${cmd}`, async () => {
          const r = await run(bash, cmd, { pathPrefix: alwaysDir })
          assert.equal(r.decision, 'deny', cmd)
          assert.equal(r.reason, GREP_REASON, cmd)
        })
      }
      it('main スレッド（agent_id なし）は grep に到達せず許可のまま', async () => {
        assert.equal((await run(bash, 'ls', { agentId: null, pathPrefix: alwaysDir })).decision, 'allow')
      })
    })

    describe('照合の箇所を 1 つずつ壊す（その箇所の grep だけ exit 2）', { concurrency: 8 }, () => {
      for (const [key, cmd, reason] of SITES) {
        it(`deny: 鍵 ${key} / ${cmd}`, async () => {
          const r = await run(bash, cmd, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: key } })
          assert.equal(r.decision, 'deny', cmd)
          assert.equal(r.reason, reason, cmd)
        })
      }
      // 偽の grep が本物へ素通しすることの対照（鍵が一致しなければ判定は本物の grep と同じ）
      for (const [cmd, want] of [['gh pr view 5', 'allow'], [REVIEW_COMMENT_GQL, 'allow'], ['gh pr review 5 --approve', 'deny']]) {
        it(`素通しの対照: ${want}: ${cmd}`, async () => {
          const r = await run(bash, cmd, { pathPrefix: selectiveDir, env: { GREP_FAIL_KEY: 'ZZ_NEVER_MATCH_ZZ' } })
          assert.equal(r.decision, want, cmd)
        })
      }
    })

    describe('レビュー承認の検査に使う tr の失敗', { concurrency: 8 }, () => {
      it('引用符を追えない形の event 検査（norm を分割する tr）が失敗したら deny', async () => {
        const cmd = "gh api repos/o/r/pulls/5/reviews -f event=APPROVE # it's"
        const r = await run(bash, cmd, { pathPrefix: trDir })
        assert.equal(r.decision, 'deny')
        assert.equal(r.reason, TR_REASON)
      })
      it('-a の flat 走査（tokenized を分割する tr）が失敗したら deny', async () => {
        const r = await run(bash, "bash -c 'gh pr review 5 -a'", { pathPrefix: trDir })
        assert.equal(r.decision, 'deny')
        assert.equal(r.reason, TR_REASON)
      })
      it('分割を使わない入力は本物の tr と同じ判定（許可）', async () => {
        assert.equal((await run(bash, 'gh pr view 5', { pathPrefix: trDir })).decision, 'allow')
      })
    })
  })
}

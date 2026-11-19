// agent-guard.sh の secret_var が、大文字を 1 つも含まない変数名を秘密変数とみなさない変更（Issue #885）の回帰テスト。
// 環境変数として届く秘密値（GH_TOKEN・GITHUB_TOKEN 等）は大文字の名前なので、secret_count・token_hits のような
// 小文字だけの普通のシェル変数は通す。大小混在・大文字だけの名前、既定値の中の参照、間接参照、heredoc 本文は止めたままにする。
// 受け入れた残余リスク: 小文字の変数に秘密を入れた値の表示（$gh_token）は止まらない（取り出し元は別の検査が止める）。
// subagent=true / null は認証情報の読み出しを止める側、false は止めない側。/bin/bash（3.2）と PATH の bash で同じ結果になることを確かめる。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function run(bash, command, subagent) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [GUARD], { stdio: ['pipe', 'pipe', 'pipe'] })
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

// 小文字だけの変数名。subagent の全値で通る。
const ALLOW = [
  'echo "$secret_count"',
  "printf '%s' \"${token_hits}\"",
  'echo ${#api_key}',
  'echo "${secret_count}"',
  'echo ${token_hits%x}',
  'echo ${token_hits:-0}',
]

// 大小混在・大文字だけ・既定値の中の参照・間接参照・heredoc 本文。subagent=true / null で止める。
const DENY = [
  'echo $GH_TOKEN',
  'echo "${GITHUB_TOKEN}"',
  'echo $GitHub_Token',
  'echo ${GitHub_Token}',
  'echo ${#GH_TOKEN}',
  'echo ${x:-$GH_TOKEN}',
  'echo ${secret_count:-$GH_TOKEN}',
  'echo ${x:-${GH_TOKEN}}',
  'echo ${!x}',
  'echo $secret_count $GH_TOKEN',
  'cat <<EOF\n$GITHUB_TOKEN\nEOF',
  'cat <<EOF\n${GITHUB_TOKEN}\nEOF',
  'cat <<< "$GH_TOKEN"',
]

describe('secret_var: 小文字だけの変数名 (#885)', () => {
  for (const bash of BASHES) {
    for (const sub of [true, null, false]) {
      for (const c of ALLOW) {
        it(`${bash} subagent=${sub} 通る: ${JSON.stringify(c)}`, async () => {
          const r = await run(bash, c, sub)
          assert.equal(r.last, 'AGENT_GUARD_RESULT allow')
          assert.equal(r.code, 0)
        })
      }
    }
    for (const sub of [true, null]) {
      for (const c of DENY) {
        it(`${bash} subagent=${sub} 止める: ${JSON.stringify(c)}`, async () => {
          const r = await run(bash, c, sub)
          assert.equal(r.last, 'AGENT_GUARD_RESULT deny credential-read')
          assert.equal(r.code, 2)
        })
      }
    }
  }
})

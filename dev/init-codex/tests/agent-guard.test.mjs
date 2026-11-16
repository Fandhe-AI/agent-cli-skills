// agent-guard.sh（Codex PreToolUse hook と OpenCode plugin が共通に呼ぶコマンド禁止ガード）の回帰テスト。
//
// 契約: stdin の {"command", "subagent"} を判定し、最後の 1 行が
// `AGENT_GUARD_RESULT allow`（終了 0）か `AGENT_GUARD_RESULT deny <理由コード>`（終了 2）。
// 全セッションで git の --no-verify・force push を deny、subagent が true / null のときだけ
// merge-guard-hook.sh 由来のマージ系・設定変更系・難読化を deny する。
// 判定表は /bin/bash（3.2）と PATH の bash（5 系）の両方で同じ結果になることを確かめる。
// 子プロセスは並列に流し、実時間の待機は行わない。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, symlinkSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')

// 同じ bash が重複しないよう実パスで束ねる。
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function runRaw(bash, stdin, env = process.env) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [GUARD], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l !== '')
      resolve({ code, out, err, last: lines[lines.length - 1] ?? '' })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(stdin)
  })
}

const run = (bash, command, subagent) => runRaw(bash, JSON.stringify({ command, subagent }))

function expectAllow(r) {
  assert.equal(r.last, 'AGENT_GUARD_RESULT allow')
  assert.equal(r.code, 0)
}
function expectDeny(r, reason) {
  assert.equal(r.last, `AGENT_GUARD_RESULT deny ${reason}`)
  assert.equal(r.code, 2)
}

import {
  GIT_DENY,
  GIT_ALLOW,
  FIX_DENY,
  FIX_ALLOW,
  nestSub,
  MANY_SUBS,
  NEST_DENY,
  NEST_ALLOW,
  PARSE_DENY,
  PARSE_ALLOW,
  PARSE_ALLOW_MAIN,
  MG_REPO_DENY,
  MG_MERGE_DENY,
  MG_OBFUSCATED_DENY,
  MG_ALLOW,
  CRED_DENY,
  CRED_ALLOW,
  ENQUEUE_DENY,
  HOOKCONF_DENY,
  HOOKCONF_ALLOW,
  FP805_FLIP,
  FP805_STAY_DENY,
  FP805_AUDIT_DENY,
} from './lib/agent-guard-cases.mjs'

for (const bash of BASHES) {
  describe(`agent-guard.sh (${bash})`, { concurrency: 8 }, () => {
    for (const subagent of [false, true, null]) {
      describe(`subagent=${subagent}: git の規則は全セッションで有効`, { concurrency: 8 }, () => {
        for (const [cmd, reason] of GIT_DENY) {
          it(`deny ${reason}: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of GIT_ALLOW) {
          it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of FIX_DENY) {
          it(`deny ${reason}: ${JSON.stringify(cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of FIX_ALLOW) {
          it(`allow: ${JSON.stringify(cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of HOOKCONF_DENY) {
          it(`[hookconf] deny ${reason}: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of HOOKCONF_ALLOW) {
          it(`[hookconf] allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of NEST_DENY) {
          it(`deny ${reason}: ${JSON.stringify(cmd.length > 200 ? `${cmd.slice(0, 60)}…(${cmd.length}字)` : cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of NEST_ALLOW) {
          it(`allow: ${JSON.stringify(cmd.length > 200 ? `${cmd.slice(0, 60)}…(${cmd.length}字)` : cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of PARSE_DENY) {
          it(`[parse] deny ${reason}: ${JSON.stringify(cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of PARSE_ALLOW) {
          it(`[parse] allow: ${JSON.stringify(cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        if (subagent === false) {
          for (const cmd of PARSE_ALLOW_MAIN) {
            it(`[parse] allow: ${JSON.stringify(cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
          }
        }
      })
    }

    describe('subagent=false: マージ系・設定変更系・難読化は対象外', { concurrency: 8 }, () => {
      for (const cmd of [...MG_REPO_DENY, ...MG_MERGE_DENY, ...MG_OBFUSCATED_DENY]) {
        it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, false)))
      }
    })

    describe('subagent=false: 認証情報の読み出しは利用者操作として対象外', { concurrency: 8 }, () => {
      for (const cmd of CRED_DENY) {
        it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, false)))
      }
    })

    for (const subagent of [true, null]) {
      describe(`subagent=${subagent}: merge-guard の deny 対象`, { concurrency: 8 }, () => {
        for (const cmd of MG_REPO_DENY) {
          it(`deny repo-settings: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'repo-settings'))
        }
        for (const cmd of MG_MERGE_DENY) {
          it(`deny merge-guard: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'merge-guard'))
        }
        for (const cmd of ENQUEUE_DENY) {
          it(`deny merge-guard（マージキュー投入）: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'merge-guard'))
        }
        for (const cmd of CRED_DENY) {
          it(`deny credential-read: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'credential-read'))
        }
        for (const cmd of CRED_ALLOW) {
          it(`allow（誤検出なし）: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const cmd of MG_OBFUSCATED_DENY) {
          it(`deny obfuscated: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'obfuscated'))
        }
        for (const cmd of MG_ALLOW) {
          it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        // Issue #805: 誤検出の形だけが通り、迂回の試行は止まったまま（旧版との差分は agent-guard-805.test.mjs）
        for (const cmd of FP805_FLIP) {
          it(`[805] allow: ${JSON.stringify(cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of FP805_STAY_DENY) {
          it(`[805] deny ${reason}: ${JSON.stringify(cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const [cmd, reason] of FP805_AUDIT_DENY) {
          it(`[805 監査] deny ${reason}: ${JSON.stringify(cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
      })
    }

    it('subagent キー欠落は null と同じ（マージ系を deny）', async () => {
      expectDeny(await runRaw(bash, JSON.stringify({ command: 'gh pr merge 5' })), 'merge-guard')
      expectAllow(await runRaw(bash, JSON.stringify({ command: 'gh pr view 5' })))
    })

    describe('入力が不正なら fail-closed（bad-input）', { concurrency: 8 }, () => {
      const BAD = [
        ['空', ''],
        ['空白のみ', '   \n'],
        ['JSON でない', 'not json'],
        ['JSON が途中で切れている', '{"command":"ls"'],
        ['空オブジェクト', '{}'],
        ['配列', '[]'],
        ['文字列', '"ls"'],
        ['command が数値', '{"command":5,"subagent":false}'],
        ['command が null', '{"command":null,"subagent":false}'],
        ['command が配列', '{"command":["ls"],"subagent":false}'],
        ['subagent が文字列', '{"command":"ls","subagent":"yes"}'],
        ['subagent が数値', '{"command":"ls","subagent":1}'],
        // Codex の PreToolUse stdin をそのまま渡した場合（command がトップレベルに無い）
        ['Codex の hook JSON そのまま', '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo MAIN-MARK"}}'],
      ]
      for (const [name, stdin] of BAD) {
        it(`deny bad-input: ${name}`, async () => expectDeny(await runRaw(bash, stdin), 'bad-input'))
      }
    })

    describe('jq が無い環境', () => {
      let dir
      before(() => {
        // jq 以外の必要なコマンドだけを置いた PATH を作る（システムの PATH に jq があっても外れる）。
        dir = mkdtempSync(join(tmpdir(), 'agent-guard-nojq-'))
        for (const c of ['cat', 'awk', 'sed', 'tr', 'grep']) {
          const p = execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim()
          symlinkSync(p, join(dir, c))
        }
        assert.equal(existsSync(join(dir, 'jq')), false)
      })
      after(() => rmSync(dir, { recursive: true, force: true }))

      it('allow できるコマンドでも deny no-jq', async () => {
        const r = await runRaw(bash, JSON.stringify({ command: 'ls', subagent: false }), { PATH: dir })
        expectDeny(r, 'no-jq')
      })
      it('main セッションの通常コマンドでも deny no-jq（fail-closed）', async () => {
        const r = await runRaw(bash, JSON.stringify({ command: 'git status', subagent: false }), { PATH: dir })
        expectDeny(r, 'no-jq')
      })
    })

    describe('判定に必要な基盤コマンドが無い環境（subagent のマージ系判定は fail-closed）', () => {
      for (const missing of ['awk', 'grep', 'sed', 'tr']) {
        it(`${missing} が無ければ deny internal-error`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'agent-guard-nocmd-'))
          try {
            for (const c of ['cat', 'awk', 'sed', 'tr', 'grep', 'jq']) {
              if (c === missing) continue
              symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim(), join(dir, c))
            }
            const r = await runRaw(bash, JSON.stringify({ command: 'gh pr view 5', subagent: true }), { PATH: dir })
            expectDeny(r, 'internal-error')
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        })
      }
    })

    it('結果を出さずに異常終了したら（未定義変数）EXIT trap が deny internal-error を出す', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-guard-trap-'))
      try {
        const src = readFileSync(GUARD, 'utf8')
        const needle = "| jq -r '.subagent | tostring') || finish deny bad-input\n"
        assert.ok(src.includes(needle))
        const mod = join(dir, 'agent-guard.sh')
        writeFileSync(mod, src.replace(needle, `${needle}: "$__ag_undefined_var"\n`))
        chmodSync(mod, 0o755)
        const r = await new Promise((resolve, reject) => {
          const p = spawn(bash, [mod], { stdio: ['pipe', 'pipe', 'ignore'] })
          let out = ''
          p.stdout.on('data', (d) => { out += d })
          p.on('error', reject)
          p.on('close', (code) => resolve({ code, out, last: out.split('\n').filter((l) => l !== '').pop() ?? '' }))
          p.stdin.end(JSON.stringify({ command: 'ls', subagent: false }))
        })
        expectDeny(r, 'internal-error')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    describe('出力に入力の文字列を含めない', { concurrency: 8 }, () => {
      const MARK = 'ZZ_SECRET_MARKER_ZZ'
      const cases = [
        [`git commit --no-verify -m ${MARK}`, false],
        [`git push --force origin ${MARK}`, false],
        [`gh pr merge 5 --body ${MARK}`, true],
        [`gh api -X PUT repos/o/r/rulesets/1 -f name=${MARK}`, null],
        [`echo $'${MARK}'`, true],
        [`echo ${MARK}`, false],
      ]
      for (const [cmd, subagent] of cases) {
        it(`marker が出ない: ${cmd}`, async () => {
          const r = await run(bash, cmd, subagent)
          assert.ok(!r.out.includes(MARK), 'stdout に入力が含まれる')
          assert.ok(!r.err.includes(MARK), 'stderr に入力が含まれる')
          assert.match(r.last, /^AGENT_GUARD_RESULT (allow|deny [a-z-]+)$/)
        })
      }
      it('不正な JSON の中身も出さない', async () => {
        const r = await runRaw(bash, `{"command":"${MARK}"`)
        assert.ok(!r.out.includes(MARK) && !r.err.includes(MARK))
        expectDeny(r, 'bad-input')
      })
    })

    it('結果行は stdout の最後の 1 行で、その行は 1 つだけ', async () => {
      const r = await run(bash, 'git push -f', false)
      const hits = r.out.split('\n').filter((l) => l.startsWith('AGENT_GUARD_RESULT'))
      assert.equal(hits.length, 1)
      assert.equal(r.out.trimEnd().split('\n').pop(), r.last)
    })
  })
}

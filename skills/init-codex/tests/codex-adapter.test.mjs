// codex-pretooluse.sh（Codex PreToolUse hook のアダプタ）と同梱の Codex 設定資産の回帰テスト。
//
// 入力の形は Codex 0.164.0 の実機 hook stdin に合わせる（パス・ID は短いダミーに置換）。
// subagent 内のツール呼び出しにだけ agent_id が付く。deny は stdout の hookSpecificOutput JSON
// （exit 0）、allow は出力なし（exit 0）。agent-guard.sh が無い・入力が壊れている場合は deny。
// 子プロセスは並列に流し、/bin/bash（3.2）と PATH の bash の両方で確かめる。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, copyFileSync, rmSync, readFileSync, readdirSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const HOOKS = join(ASSETS, 'hooks')
const ADAPTER = join(HOOKS, 'codex-pretooluse.sh')

const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function runAdapter(bash, stdin, script = ADAPTER) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out }))
    p.stdin.on('error', () => {})
    p.stdin.end(stdin)
  })
}

// 実機 fixture（c2-pretooluse-bash-main / -subagent）の形。
const base = {
  session_id: 'sess-1',
  turn_id: 'turn-1',
  transcript_path: null,
  cwd: '/path/to/repo',
  hook_event_name: 'PreToolUse',
  model: 'model-x',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_use_id: 'exec-1',
}
const mainEvent = (command) => JSON.stringify({ ...base, tool_input: { command } })
const subEvent = (command) =>
  JSON.stringify({ ...base, agent_id: 'agent-1', agent_type: 'default', tool_input: { command } })

const denyOf = (out) => {
  const j = JSON.parse(out)
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(j.hookSpecificOutput.permissionDecisionReason.length > 0)
  return j
}

for (const bash of BASHES) {
  describe(`codex-pretooluse.sh (${bash})`, () => {
    it('main の git push --force は deny JSON（exit 0）', async () => {
      const r = await runAdapter(bash, mainEvent('git push --force origin main'))
      assert.equal(r.code, 0)
      denyOf(r.out)
    })
    it('subagent の gh pr merge は deny', async () => {
      const r = await runAdapter(bash, subEvent('gh pr merge 1 --squash'))
      assert.equal(r.code, 0)
      denyOf(r.out)
    })
    it('main の gh pr merge は出力なし', async () => {
      const r = await runAdapter(bash, mainEvent('gh pr merge 1 --squash'))
      assert.equal(r.code, 0)
      assert.equal(r.out, '')
    })
    it('main の git status は出力なし', async () => {
      const r = await runAdapter(bash, mainEvent('git status'))
      assert.equal(r.code, 0)
      assert.equal(r.out, '')
    })
    it('subagent の git status は出力なし', async () => {
      const r = await runAdapter(bash, subEvent('git status'))
      assert.equal(r.code, 0)
      assert.equal(r.out, '')
    })
    it('不正 JSON は deny', async () => {
      for (const bad of ['not json', '', '{"tool_input":']) {
        const r = await runAdapter(bash, bad)
        assert.equal(r.code, 0)
        denyOf(r.out)
      }
    })
    it('command が無い・文字列でない入力は deny', async () => {
      for (const bad of ['{}', '{"tool_input":{"command":5}}']) {
        const r = await runAdapter(bash, bad)
        denyOf(r.out)
      }
    })
    it('agent-guard.sh が無ければ deny（アダプタだけを置いた一時ディレクトリ）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-'))
      try {
        const copy = join(dir, 'codex-pretooluse.sh')
        copyFileSync(ADAPTER, copy)
        chmodSync(copy, 0o755)
        const r = await runAdapter(bash, mainEvent('git status'), copy)
        assert.equal(r.code, 0)
        denyOf(r.out)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
    it('出力に入力コマンドを含めない', async () => {
      const marker = 'SECRET-MARKER-123'
      const r = await runAdapter(bash, mainEvent(`git push --force origin ${marker}`))
      denyOf(r.out)
      assert.ok(!r.out.includes(marker))
      assert.ok(!r.out.includes('git push'))
    })
  })
}

describe('同梱の Codex 設定資産', () => {
  it('hooks.json は妥当な JSON で SessionStart と PreToolUse を持つ', () => {
    const j = JSON.parse(readFileSync(join(ASSETS, 'codex', 'hooks.json'), 'utf8'))
    assert.deepEqual(Object.keys(j.hooks).sort(), ['PreToolUse', 'SessionStart'])
    const pre = j.hooks.PreToolUse[0]
    assert.equal(pre.matcher, '^Bash$')
    assert.match(pre.hooks[0].command, /codex-pretooluse\.sh/)
    assert.match(j.hooks.SessionStart[0].hooks[0].command, /codex-session-start\.sh/)
  })

  it('SessionStart スクリプトは日本語のリマインダーを出す', () => {
    const r = spawnSync('/bin/bash', [join(HOOKS, 'codex-session-start.sh')], { input: '{}' })
    assert.equal(r.status, 0)
    assert.match(r.stdout.toString(), /Conventional Commits/)
  })

  it('標準 agent の toml は必須キーを持ち model を固定しない', () => {
    const dir = join(ASSETS, 'codex', 'agents')
    const files = readdirSync(dir).filter((f) => f.endsWith('.toml')).sort()
    assert.deepEqual(files, ['implementer.toml', 'researcher.toml', 'reviewer.toml'])
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8')
      assert.match(t, /^name = "/m)
      assert.match(t, /^description = "/m)
      assert.match(t, /^developer_instructions = """/m)
      assert.doesNotMatch(t, /^model = /m)
    }
  })

  const hasCodex = spawnSync('codex', ['--version']).status === 0
  const RULES = join(ASSETS, 'codex', 'rules', 'agent-guard.rules')
  const check = (...cmd) => {
    const r = spawnSync('codex', ['execpolicy', 'check', '--rules', RULES, '--', ...cmd])
    assert.equal(r.status, 0, r.stderr.toString())
    return JSON.parse(r.stdout.toString())
  }
  it('rules: 禁止形は forbidden、通常の push は一致なし', { skip: !hasCodex && 'codex が PATH に無い' }, () => {
    for (const cmd of [
      ['git', 'push', '--force', 'origin', 'main'],
      ['git', 'push', '-f', 'origin', 'main'],
      ['git', 'push', '--force-with-lease', 'origin', 'main'],
      ['git', 'push', '--force-if-includes', 'origin', 'main'],
      ['git', 'push', '--no-verify'],
      ['git', 'commit', '--no-verify', '-m', 'x'],
      ['git', 'commit', '-n', '-m', 'x'],
    ]) {
      assert.equal(check(...cmd).decision, 'forbidden', cmd.join(' '))
    }
    for (const cmd of [
      ['git', 'push', 'origin', 'main'],
      ['git', 'commit', '-m', 'x'],
    ]) {
      assert.notEqual(check(...cmd).decision, 'forbidden', cmd.join(' '))
    }
  })
})

// 起動コマンドの fail-closed（実機 0.164.0: コマンドが exit 127 / exit 1 / stderr 無しの exit 2 で終わると
// Codex は非ブロックの hook エラーとして扱い、そのまま実行する。stderr に理由つきの exit 2 だけがブロック）。
describe('hooks.json の PreToolUse 起動コマンド（fail-closed）', () => {
  const cmd = JSON.parse(readFileSync(join(ASSETS, 'codex', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
  const payload = (c) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } })

  function setup({ adapter }) {
    const dir = mkdtempSync(join(tmpdir(), 'codex-launch-'))
    execFileSync('git', ['init', '-q', dir])
    const hooks = join(dir, '.codex', 'hooks')
    execFileSync('mkdir', ['-p', hooks])
    if (adapter === 'real') {
      copyFileSync(ADAPTER, join(hooks, 'codex-pretooluse.sh'))
      copyFileSync(join(HOOKS, 'agent-guard.sh'), join(hooks, 'agent-guard.sh'))
    } else if (adapter === 'exit1') {
      writeFileSync(join(hooks, 'codex-pretooluse.sh'), '#!/bin/sh\nexit 1\n')
    }
    return dir
  }
  const run = (sh, dir, c, env = {}) =>
    spawnSync(sh, ['-c', cmd], { cwd: dir, input: payload(c), env: { ...process.env, ...env } })

  for (const sh of ['/bin/sh', ...BASHES]) {
    it(`正常な allow / deny は従来どおり (${sh})`, () => {
      const dir = setup({ adapter: 'real' })
      try {
        const ok = run(sh, dir, 'git status')
        assert.equal(ok.status, 0)
        assert.equal(ok.stdout.toString(), '')
        const ng = run(sh, dir, 'git push --force origin main')
        assert.equal(ng.status, 0)
        assert.equal(JSON.parse(ng.stdout.toString()).hookSpecificOutput.permissionDecision, 'deny')
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    for (const [name, opt, env] of [
      ['スクリプトが無い', { adapter: 'none' }, {}],
      ['アダプタが exit 1 で終わる', { adapter: 'exit1' }, {}],
      ['git rev-parse が失敗する', { adapter: 'real' }, { GIT_DIR: '/nonexistent-codex-test' }],
    ]) {
      it(`${name}と、stderr に理由つきの exit 2 でブロックする (${sh})`, () => {
        const dir = setup(opt)
        try {
          const r = run(sh, dir, 'git push --force origin main', env)
          assert.equal(r.status, 2)
          assert.match(r.stderr.toString(), /fail-closed/)
          assert.equal(r.stdout.toString(), '')
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })
    }
  }
})

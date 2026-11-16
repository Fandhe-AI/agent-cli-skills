// ランナーの起動口（skills/implement-issue-tree/runner/run.mjs）の回帰テスト。
//   - CLI として起動: 引数の誤りは終了コード 2、gh の認証が通らなければ 3（偽の gh を PATH の先頭に置く。
//     アダプタの有無に依存しないよう、アダプタを読む前の段で止まる経路を使う）。どちらも _/iit-runner を作らない。
//   - main() を import して外部とのやりとり（gh・アダプタ・生成物・メイン worktree）を差し替え、2 / 3 / 1 / 0 の
//     各経路・result.json と stdout の形・meta.json・アダプタの start / close を確かめる。
// 本物の gh・codex・opencode は起動しない。メイン worktree は一時ディレクトリに差し替える（本物の _/ に書かない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { BASE_ARGS, buildTree } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { AdapterError } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { ADAPTERS_DIR, importAdapter, main, parseCli, UsageError } from '../../../skills/implement-issue-tree/runner/run.mjs'

const RUN_MJS = fileURLToPath(new URL('../../../skills/implement-issue-tree/runner/run.mjs', import.meta.url))
const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-run-'))))
const RUN_ID = 'wf_0123abcd-4ef'
let seq = 0
const newMain = () => {
  const d = join(root, `main-${++seq}`)
  mkdirSync(d)
  return d
}
const argsFile = (obj, name = `args-${++seq}.json`) => {
  const p = join(root, name)
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
  return p
}

// 偽の gh（常に認証失敗）。PATH の先頭に置く
const fakeBin = join(root, 'bin')
mkdirSync(fakeBin)
writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\necho "not logged in" >&2\nexit 1\n')
chmodSync(join(fakeBin, 'gh'), 0o755)

function cli(argv) {
  const cwd = newMain()
  const r = spawnSync(process.execPath, [RUN_MJS, ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GH_HOST: 'gh.invalid' },
  })
  return { ...r, wrote: existsSync(join(cwd, '_')) }
}

test('CLI: 引数の誤りは終了コード 2（使い方を stderr に出し、何も書かない）', () => {
  const ok = argsFile({ parent: 1 })
  for (const argv of [[], ['--tool', 'claude', '--args', ok], ['--tool', 'codex'], ['--tool', 'codex', '--args'], ['--tool', 'codex', '--args', ok, '--bogus'],
    ['--tool', 'codex', '--args', ok, '--max-parallel', '0'], ['--tool', 'codex', '--args', join(root, 'missing.json')], ['--tool', 'codex', '--args', argsFile('[1]')],
    ['--tool', 'codex', '--args', argsFile('{')], ['--tool', 'codex', '--args', ok, '--config', argsFile({ version: 2 })], ['--tool', 'codex', '--args', argsFile({ skillDir: 'rel' })]]) {
    const r = cli(argv)
    assert.equal(r.status, 2, `${argv.join(' ')}\n${r.stderr}`)
    assert.match(r.stderr, /ランナー: /)
    assert.equal(r.stdout, '')
    assert.equal(r.wrote, false)
  }
})

test('CLI: gh の認証が通らなければ終了コード 3（アダプタ・生成物を読む前に止まり、何も書かない）', () => {
  for (const tool of ['codex', 'opencode']) {
    const r = cli(['--tool', tool, '--args', argsFile({ parent: 1 }), '--no-build-check'])
    assert.equal(r.status, 3, r.stderr)
    assert.match(r.stderr, /前提の不足: gh auth status が終了コード 1/)
    assert.equal(r.stdout, '')
    assert.equal(r.wrote, false)
  }
})

test('parseCli: 既定値と各フラグ', () => {
  assert.deepEqual(parseCli(['--tool', 'opencode', '--args', 'a.json']), { tool: 'opencode', argsPath: 'a.json', configPath: null, maxParallel: null, dryRun: false, buildCheck: true })
  assert.deepEqual(parseCli(['--args', 'a.json', '--tool', 'codex', '--config', 'c.json', '--max-parallel', '3', '--dry-run', '--no-build-check']),
    { tool: 'codex', argsPath: 'a.json', configPath: 'c.json', maxParallel: 3, dryRun: true, buildCheck: false })
  assert.throws(() => parseCli(['--tool', 'codex', '--args', 'a', '--max-parallel', '1.5']), UsageError)
})

// main() の差し替え一式。workflow を渡さなければ本物の生成物を読む
function deps({ mainRoot = newMain(), mod, workflow, gh = { ok: true }, build = { ok: true } } = {}) {
  const out = []
  const err = []
  const calls = { build: 0 }
  const d = {
    stdout: async (s) => { out.push(s) },
    stderr: (s) => { err.push(s) },
    cwd: root,
    ghAuth: () => gh,
    build: () => { calls.build++; return build },
    loadAdapter: async () => mod,
    mainRootOf: () => mainRoot,
    makeRunId: () => RUN_ID,
    onSignal: () => {},
    env: { HOME: '/nonexistent' },
  }
  if (workflow) d.load = () => workflow
  return { d, out, err, mainRoot, calls, runDir: join(mainRoot, '_', 'iit-runner', RUN_ID) }
}
const tinyWorkflow = (run) => ({ path: '/x.js', bytes: 1, sha256: 'f'.repeat(64), run })
const SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }

test('main: アダプタが無い・読み込みで例外・生成物を読めない・鮮度の照合に失敗は 3 で、_/iit-runner を作らない', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const cases = [
    deps({ mod: null }),
    (() => { const x = deps({ mod: a }); x.d.loadAdapter = async () => { throw new SyntaxError('bad adapter') }; return x })(),
    (() => { const x = deps({ mod: a }); x.d.load = () => { throw new Error('SHA-256 が期待値と一致しない') }; return x })(),
    deps({ mod: a, build: { ok: false, reason: 'build-workflow.mjs --check が終了コード 1' } }),
    deps({ mod: a, gh: { ok: false, reason: 'gh を起動できない（ENOENT）' } }),
  ]
  for (const x of cases) {
    assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 })], x.d), 3, x.err.join(''))
    assert.match(x.err.join(''), /前提の不足/)
    assert.equal(existsSync(join(x.mainRoot, '_')), false)
    assert.deepEqual(x.out, [])
  }
  assert.equal(a.instances.length, 0, 'アダプタを作っていない')
})

test('main: --no-build-check が無ければ鮮度の照合を呼ぶ', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: tinyWorkflow(async () => 'done') })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 })], x.d), 0)
  assert.equal(x.calls.build, 1)
  const y = deps({ mod: a, workflow: tinyWorkflow(async () => 'done') })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--no-build-check'], y.d), 0)
  assert.equal(y.calls.build, 0)
})

test('main: アダプタの生成・start() の失敗は 3。result.json に error を書き、close を呼ぶ', async () => {
  const startFail = makeFakeAdapterModule()
  const orig = startFail.createAdapter
  startFail.createAdapter = (cfg) => ({ ...orig(cfg), start: async () => { throw new AdapterError('prereq', 'codex が古い') } })
  const ctorFail = { createAdapter: () => { throw new AdapterError('prereq', 'opencode が無い') } }
  for (const [mod, re] of [[startFail, /アダプタの起動に失敗: prereq: codex が古い/], [ctorFail, /アダプタを作れない: prereq: opencode が無い/]]) {
    const x = deps({ mod, workflow: tinyWorkflow(async () => { throw new Error('呼ばれない') }) })
    assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 })], x.d), 3)
    const body = JSON.parse(readFileSync(join(x.runDir, 'result.json'), 'utf8'))
    assert.equal(body.exitCode, 3)
    assert.equal(body.result, null)
    assert.match(body.error, re)
    assert.deepEqual(JSON.parse(x.out.join('')), body)
  }
  assert.equal(startFail.instances[0].closed, 1)
})

test('main: ホストが例外で終われば 1（result.json に error・アダプタは close）', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: tinyWorkflow(async (args, agent) => { await agent('p', { label: 'x', schema: SCHEMA }); throw new Error('木が壊れている') }) })
  assert.equal(await main(['--tool', 'opencode', '--args', argsFile({ parent: 1 })], x.d), 1)
  const body = JSON.parse(readFileSync(join(x.runDir, 'result.json'), 'utf8'))
  assert.equal(body.exitCode, 1)
  assert.equal(body.tool, 'opencode')
  assert.equal(body.result, null)
  assert.match(body.error, /木が壊れている/)
  assert.equal(a.instances[0].started, 1)
  assert.equal(a.instances[0].closed, 1)
})

test('main: 正常終了は 0。result.json・stdout・meta.json の形、アダプタへ渡す cfg', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  let seen
  const x = deps({ mod: a, workflow: tinyWorkflow(async (args, agent, log, phase) => {
    seen = args
    phase('Plan')
    log('進捗')
    return { done: [await agent('p', { label: 'plan:#2', schema: SCHEMA })] }
  }) })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1, autoMerge: true }), '--max-parallel', '2', '--no-build-check'], x.d), 0)
  const body = JSON.parse(readFileSync(join(x.runDir, 'result.json'), 'utf8'))
  assert.deepEqual(Object.keys(body).sort(), ['endedAt', 'exitCode', 'result', 'runId', 'startedAt', 'tool', 'workflowSha256'])
  assert.equal(body.runId, RUN_ID)
  assert.equal(body.exitCode, 0)
  assert.equal(body.workflowSha256, 'f'.repeat(64))
  assert.deepEqual(body.result, { done: [{ ok: true }] })
  assert.ok(Date.parse(body.startedAt) <= Date.parse(body.endedAt))
  assert.equal(x.out.length, 1)
  assert.equal(x.out[0].trimEnd().includes('\n'), false, 'stdout は 1 行')
  assert.deepEqual(JSON.parse(x.out[0]), body)
  const meta = JSON.parse(readFileSync(join(x.runDir, 'agents', '0001-plan_2', 'meta.json'), 'utf8'))
  assert.equal(meta.label, 'plan:#2')
  assert.equal(meta.seq, 1)
  assert.equal(meta.outcome, 'ok')
  assert.equal(typeof meta.sessionRef, 'string')
  assert.match(readFileSync(join(x.runDir, 'host.log'), 'utf8'), /== phase: Plan\n進捗\n/)
  // アダプタへ渡す cfg（契約の形）
  const cfg = a.instances[0].cfg
  assert.deepEqual(Object.keys(cfg).sort(), ['env', 'guard', 'mainRoot', 'runDir', 'skillDir', 'toolConfig'])
  assert.equal(cfg.mainRoot, x.mainRoot)
  assert.equal(cfg.runDir, x.runDir)
  assert.equal(typeof cfg.guard.codexRules, 'function')
  assert.equal(typeof cfg.guard.opencodeRules, 'function')
  assert.equal(cfg.toolConfig.deleteSessions, true)
  assert.equal(seen.skillDir, realpathSync(join(RUN_MJS, '..', '..')), 'args.skillDir の既定はこのスキル')
  assert.equal(a.calls[0].allowMerge, false, 'plan は autoMerge でもマージを許さない')
  assert.equal(a.instances[0].closed, 1)
})

test('main: --dry-run で本物の生成物を流すと、result に見積り（startable・blocked）がそのまま入る', async () => {
  const args = { ...BASE_ARGS }
  const a = makeFakeAdapterModule({ defaults: { args: { ...args, dryRun: true }, nodes: buildTree([2, 3]) } })
  const x = deps({ mod: a })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile(args), '--dry-run', '--no-build-check'], x.d), 0, x.err.join(''))
  const body = JSON.parse(x.out[0])
  assert.equal(body.result.dryRun, true)
  assert.equal(body.result.startable.count, 3)
  assert.equal(typeof body.result.blocked.count, 'number')
  assert.match(body.workflowSha256, /^[0-9a-f]{64}$/)
  assert.equal(readdirSync(join(x.runDir, 'agents')).length, 8)
})

test('importAdapter: 実ファイルの動的 import。無い・createAdapter を持たないものは null、正しい形はモジュール', async () => {
  const dir = join(root, 'adapters')
  mkdirSync(dir)
  writeFileSync(join(dir, 'codex.mjs'), 'export const name = "x"\n')
  writeFileSync(join(dir, 'opencode.mjs'), 'export function createAdapter(cfg) { return { name: "opencode", cfg } }\n')
  assert.equal(await importAdapter('codex', join(root, 'no-such-dir')), null)
  assert.equal(await importAdapter('codex', dir), null)
  const mod = await importAdapter('opencode', dir)
  assert.equal(typeof mod.createAdapter, 'function')
  assert.equal(mod.createAdapter({ a: 1 }).name, 'opencode')
  assert.equal(ADAPTERS_DIR, join(RUN_MJS, '..', 'adapters'))
})

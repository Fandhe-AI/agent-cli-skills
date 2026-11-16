// ランナーの起動口（skills/implement-issue-tree/runner/run.mjs）の回帰テスト。
//   - CLI として起動: 引数の誤りは終了コード 2、gh の認証が通らなければ 3（偽の gh を PATH の先頭に置く。
//     アダプタの有無に依存しないよう、アダプタを読む前の段で止まる経路を使う）。どちらも _/iit-runner を作らない。
//   - main() を import して外部とのやりとり（gh・アダプタ・生成物・メイン worktree）を差し替え、2 / 3 / 1 / 0 の
//     各経路・result.json と stdout の形・meta.json・アダプタの start / close を確かめる。
// 本物の gh・codex・opencode は起動しない。メイン worktree は一時ディレクトリに差し替える（本物の _/ に書かない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { BASE_ARGS, buildTree, makeDefaultReply } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { AdapterError } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { ADAPTERS_DIR, importAdapter, main, parseCli, registerSignals, resolveRepo, UsageError } from '../../../skills/implement-issue-tree/runner/run.mjs'
import { REQUIRED_SKILLS } from '../../../skills/implement-issue-tree/runner/lib/skills-prereq.mjs'

const RUN_MJS = fileURLToPath(new URL('../../../skills/implement-issue-tree/runner/run.mjs', import.meta.url))
const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-run-'))))
const RUN_ID = 'wf_0123abcd-4ef'
let seq = 0
// メイン worktree。既定で生成物が名指しするスキルを .agents/skills に置く（両ツールの探索先。起動時検査を通す）
const newMain = ({ skills = REQUIRED_SKILLS, skillsDir = '.agents/skills' } = {}) => {
  const d = join(root, `main-${++seq}`)
  mkdirSync(d)
  for (const n of skills) {
    mkdirSync(join(d, skillsDir, n), { recursive: true })
    writeFileSync(join(d, skillsDir, n, 'SKILL.md'), `---\nname: ${n}\n---\n`)
  }
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

test('CLI: --help / -h は使い方を stdout に出して終了コード 0（gh・アダプタを見ず、何も書かない）', () => {
  for (const argv of [['--help'], ['-h'], ['--tool', 'codex', '--help']]) {
    const r = cli(argv)
    assert.equal(r.status, 0, `${argv.join(' ')}\n${r.stderr}`)
    assert.match(r.stdout, /^使い方: node run\.mjs --tool codex\|opencode --args <args\.json>/)
    assert.match(r.stdout, /README\.md/)
    assert.equal(r.stderr, '')
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
function deps({ mainRoot = newMain(), mod, workflow, gh = { ok: true }, build = { ok: true }, repo = { ok: true, repo: 'acme/widget' } } = {}) {
  const out = []
  const err = []
  const calls = { build: 0, repoOf: [] }
  const d = {
    stdout: async (s) => { out.push(s) },
    stderr: (s) => { err.push(s) },
    cwd: root,
    ghAuth: () => gh,
    repoOf: (root, env) => { calls.repoOf.push({ root, env }); return repo },
    build: () => { calls.build++; return build },
    loadAdapter: async () => mod,
    mainRootOf: () => mainRoot,
    makeRunId: () => RUN_ID,
    onSignal: () => {},
    onExit: () => {},
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

test('main: 生成物が名指しするスキルが探索先に無ければ 3 で、足りない名前を示し、_/iit-runner を作らない', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const wf = () => tinyWorkflow(async () => { throw new Error('呼ばれない') })
  const cases = [
    ['codex', newMain({ skills: [] }), /create-commit, create-pr, implement-review/],
    ['codex', newMain({ skills: ['create-commit', 'create-pr'] }), /: implement-review（codex の探索先 \.agents\/skills/],
    // Codex は .claude/skills を読まない
    ['codex', newMain({ skillsDir: '.claude/skills' }), /create-commit, create-pr, implement-review/],
    ['opencode', newMain({ skills: ['implement-review'] }), /create-commit, create-pr（opencode の探索先/],
  ]
  for (const [tool, mainRoot, re] of cases) {
    const x = deps({ mod: a, mainRoot, workflow: wf() })
    assert.equal(await main(['--tool', tool, '--args', argsFile({ parent: 1 }), '--no-build-check'], x.d), 3, x.err.join(''))
    assert.match(x.err.join(''), /前提の不足: 必要なスキルが対象リポジトリに無い/)
    assert.match(x.err.join(''), re)
    assert.equal(existsSync(join(mainRoot, '_')), false)
    assert.deepEqual(x.out, [])
  }
  assert.equal(a.instances.length, 0, 'アダプタを作っていない')
  // OpenCode は .claude/skills にあれば通る
  const ok = deps({ mod: a, mainRoot: newMain({ skillsDir: '.claude/skills' }), workflow: tinyWorkflow(async () => 'done') })
  assert.equal(await main(['--tool', 'opencode', '--args', argsFile({ parent: 1 }), '--no-build-check'], ok.d), 0, ok.err.join(''))
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
  // 設定ファイルの toolConfig.<tool> がアダプタへ届く（既定は default.json の toolConfig.codex）
  assert.equal(cfg.toolConfig.codexBin, 'codex')
  assert.equal(cfg.toolConfig.killGraceMs, 2000)
  assert.equal(cfg.toolConfig.trustProject, false)
  assert.equal(cfg.toolConfig.command, undefined, '他ツールの toolConfig は混ざらない')
  assert.equal(seen.skillDir, realpathSync(join(RUN_MJS, '..', '..')), 'args.skillDir の既定はこのスキル')
  assert.equal(a.calls[0].allowMerge, false, 'plan は autoMerge でもマージを許さない')
  assert.equal(a.instances[0].closed, 1)
})

test('main: --dry-run で本物の生成物を流すと、result に見積り（startable・blocked）がそのまま入る', async () => {
  // skillDir はこのスキル（LOW-15 で別の場所は 2 になる。BASE_ARGS の '/repo/…' は stub-run 用の架空の値）
  const args = { ...BASE_ARGS, skillDir: realpathSync(join(RUN_MJS, '..', '..')) }
  const defaults = { args: { ...args, dryRun: true }, nodes: buildTree([2, 3]) }
  const a = makeFakeAdapterModule({ defaults })
  const x = deps({ mod: a })
  // 実行仕様の段（状態の読み込み等）はアダプタへ回らず run-verified.sh で直接実行される。deps.spawnScript で差し替え、
  // 既定応答表の値を launcher の出力の形（envelope は JSON 1 行・line:<語> は `<語> <JSON>`・exit-ok は終了コード）で返す
  const reply = makeDefaultReply(defaults)
  const launched = []
  x.d.spawnScript = async (file, argv, _opts, { label, prompt, spec }) => {
    launched.push(label)
    const v = reply(prompt, { label })
    if (spec.ret === 'exit-ok') return { code: v?.ok === true ? 0 : 1, stdout: '', stderr: '', timedOut: false, overflow: false }
    if (v === null || v === undefined) return { code: 1, stdout: '', stderr: '', timedOut: false, overflow: false }
    const line = spec.ret === 'envelope' ? JSON.stringify(v) : `${spec.ret.slice('line:'.length)} ${JSON.stringify(v)}`
    return { code: 0, stdout: `${line}\n`, stderr: '', timedOut: false, overflow: false }
  }
  assert.equal(await main(['--tool', 'codex', '--args', argsFile(args), '--dry-run', '--no-build-check'], x.d), 0, x.err.join(''))
  assert.ok(launched.length > 0, '仕様の段が deps.spawnScript を通っていない')
  assert.equal(a.calls.filter((r) => launched.includes(r.label)).length, 0, '仕様の段がアダプタへ回った')
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

test('main（MEDIUM-8）: autoMerge のときだけ start 前に gh repo view で repo を 1 回決め、agent-host の merge に渡す。失敗は 3 で _/iit-runner を作らない', async () => {
  const STEP = 'HEAD_SHA="<payload.headSha の 40 桁>"; gh pr merge 7 --squash --delete-branch --match-head-commit "$HEAD_SHA"'
  const flow = () => tinyWorkflow(async (args, agent) => ({ r: await agent(STEP, { label: 'merge-exec:#7', schema: SCHEMA }) }))
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: flow() })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1, autoMerge: true }), '--no-build-check'], x.d), 0)
  assert.equal(x.calls.repoOf.length, 1)
  assert.equal(x.calls.repoOf[0].root, x.mainRoot)
  assert.deepEqual(a.calls[0].merge, { prNumber: 7, repo: 'acme/widget' })
  assert.equal(a.calls[0].allowMerge, true)

  const b = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const y = deps({ mod: b, workflow: flow() })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--no-build-check'], y.d), 0)
  assert.equal(y.calls.repoOf.length, 0, 'autoMerge でなければ gh repo view を呼ばない')
  assert.equal(b.calls[0].allowMerge, false)
  assert.equal(b.calls[0].merge, null)

  for (const repo of [{ ok: false, reason: 'gh repo view が失敗' }, { ok: true, repo: 'bad repo' }]) {
    const c = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
    const z = deps({ mod: c, workflow: flow(), repo })
    assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1, autoMerge: true }), '--no-build-check'], z.d), 3)
    assert.equal(existsSync(join(z.mainRoot, '_', 'iit-runner')), false)
    assert.equal(c.instances.length, 0)
  }
})

test('resolveRepo（MEDIUM-8）: メイン worktree で gh repo view --json nameWithOwner を実行し、継いだ GH_REPO は外す。失敗は ok: false', () => {
  const bin = join(root, 'fake-gh-repo')
  mkdirSync(bin, { recursive: true })
  const rec = join(bin, 'rec')
  writeFileSync(join(bin, 'gh'), `#!/bin/bash\nprintf '%s\\n' "$*" "$(pwd -P)" "\${GH_REPO-unset}" > '${rec}'\n[ -f '${bin}/fail' ] && exit 4\necho acme/widget\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const where = newMain()
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_HOST: 'gh.invalid', GH_REPO: 'evil/other' }
  assert.deepEqual(resolveRepo(where, env), { ok: true, repo: 'acme/widget' })
  assert.deepEqual(readFileSync(rec, 'utf8').split('\n').slice(0, 3), ['repo view --json nameWithOwner --jq .nameWithOwner', realpathSync(where), 'unset'])
  writeFileSync(join(bin, 'fail'), '')
  const r = resolveRepo(where, env)
  assert.equal(r.ok, false)
  assert.match(r.reason, /終了コード 4/)
})

test('main（LOW-15）: args.skillDir はこのランナーのスキルと realpath が同じでなければ 2（存在しない・別のスキルの写し）。symlink 経由の同じ場所は通る', async () => {
  const other = join(root, 'other-skill')
  mkdirSync(join(other, 'scripts'), { recursive: true })
  for (const skillDir of [other, join(root, 'missing-skill'), join(realpathSync(join(RUN_MJS, '..', '..')), 'scripts')]) {
    const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
    const x = deps({ mod: a, workflow: tinyWorkflow(async () => ({})) })
    assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1, skillDir }), '--no-build-check'], x.d), 2, skillDir)
    assert.match(x.err.join(''), /args\.skillDir/)
    assert.equal(existsSync(join(x.mainRoot, '_')), false)
    assert.equal(a.instances.length, 0)
  }
  const link = join(root, 'skill-link')
  symlinkSync(realpathSync(join(RUN_MJS, '..', '..')), link)
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: tinyWorkflow(async () => ({})) })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1, skillDir: link }), '--no-build-check'], x.d), 0)
})

test('main（LOW-11）: シグナルの処理は start より前に登録し、終了時の同期 kill（アダプタと実行仕様の子）を登録する。シグナルでは kill → close → 128+番号で exit', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: tinyWorkflow(async () => ({})) })
  let handler
  let startedAtRegister
  const exits = []
  const onExit = []
  x.d.onSignal = (h) => { handler = h; startedAtRegister = a.instances[0].started }
  x.d.onExit = (fn) => { onExit.push(fn) }
  x.d.exit = (code) => { exits.push(code) }
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--no-build-check'], x.d), 0)
  assert.equal(startedAtRegister, 0, 'start() より前に登録する')
  assert.equal(onExit.length, 1)
  onExit[0]()
  assert.equal(a.instances[0].killed, 1, '終了時はアダプタの killSync を呼ぶ')
  // シグナル（close 済みのランでも kill は走り、close は 1 回だけ）
  await handler('SIGHUP')
  assert.equal(a.instances[0].killed, 2)
  assert.equal(a.instances[0].closed, 1)
  assert.deepEqual(exits, [129])
})

test('main（LOW-11）: シグナルの close が進行中に本流が close を呼んでも、同じ後片づけの完了を待ってから戻る', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  let closeDone = false
  const mod = {
    createAdapter(cfg) {
      const ad = a.createAdapter(cfg)
      return { ...ad, async close() { await new Promise((r) => setTimeout(r, 50)); closeDone = true } }
    },
  }
  let handler
  let signalDone
  const x = deps({ mod, workflow: tinyWorkflow(async () => { signalDone = handler('SIGTERM'); return {} }) })
  x.d.onSignal = (h) => { handler = h }
  const exits = []
  x.d.exit = (code) => { exits.push(code) }
  await main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--no-build-check'], x.d)
  assert.equal(closeDone, true, '本流は進行中の close を待つ（セッション削除の途中で戻らない）')
  await signalDone
  assert.deepEqual(exits, [143])
})

test('main（LOW-11）: start 後の想定外の例外（結果の書き出しの失敗）でもアダプタを close する', async () => {
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const x = deps({ mod: a, workflow: tinyWorkflow(async () => ({})) })
  x.d.stdout = async () => { throw new Error('EPIPE') }
  await assert.rejects(main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--no-build-check'], x.d), /EPIPE/)
  assert.equal(a.instances[0].closed, 1)
})

test('registerSignals（LOW-11）: SIGINT・SIGTERM・SIGHUP を 1 回ずつ登録し、シグナル名をハンドラへ渡す', () => {
  const seen = []
  const proc = { once: (sig, fn) => seen.push([sig, fn]) }
  const got = []
  registerSignals((s) => got.push(s), proc)
  assert.deepEqual(seen.map((x) => x[0]), ['SIGINT', 'SIGTERM', 'SIGHUP'])
  for (const [sig, fn] of seen) fn()
  assert.deepEqual(got, ['SIGINT', 'SIGTERM', 'SIGHUP'])
})

test('main（PR #851 の P0）: アダプタを作る前にガード等の内容を固定し agent-host へ渡す。start 以降に書き換われば段を実行しない', async () => {
  const guard = join(root, `guard-${++seq}.sh`)
  writeFileSync(guard, '#!/bin/bash\nexit 0\n')
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../../../skills/implement-issue-tree/runner/config/default.json', import.meta.url)), 'utf8'))
  base.toolConfig = { ...(base.toolConfig ?? {}), codex: { ...(base.toolConfig?.codex ?? {}), guardScript: guard } }
  const a = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  // start の時点（固定の後・エージェントの前）でガードが書き換わった想定
  const mod = { createAdapter: (cfg) => { const ad = a.createAdapter(cfg); const s0 = ad.start; ad.start = async () => { await s0(); writeFileSync(guard, '#!/bin/bash\nexit 0 # 書き換え\n') }; return ad } }
  let got
  const x = deps({ mod, workflow: tinyWorkflow(async (args, agent) => { got = await agent('p', { label: 'plan:#2', schema: SCHEMA }); return {} }) })
  assert.equal(await main(['--tool', 'codex', '--args', argsFile({ parent: 1 }), '--config', argsFile(base), '--no-build-check'], x.d), 0)
  assert.equal(got, null)
  assert.equal(a.calls.length, 0, 'アダプタを呼ばない')
  const meta = JSON.parse(readFileSync(join(x.runDir, 'agents', '0001-plan_2', 'meta.json'), 'utf8'))
  assert.equal(meta.reason, 'pin-mismatch')
  assert.match(meta.detail, /guard-\d+\.sh/)
  const hl = readFileSync(join(x.runDir, 'host.log'), 'utf8')
  assert.match(hl, /内容を固定したファイル 4 件（run-verified\.sh=[0-9a-f]{12} signed-output\.sh=[0-9a-f]{12} guard-\d+\.sh=[0-9a-f]{12} codex-hook\.sh=[0-9a-f]{12}）/)
})

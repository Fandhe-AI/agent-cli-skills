// ランナーの OpenCode アダプタ（runner/adapters/opencode.mjs）の回帰テスト。
// 実の opencode は起動せず、偽 serve（lib/fake-opencode-server.mjs）を起動コマンドとして差し替える。
// 確かめること: 渡す設定（allow-all が無い・deny が入る・allowMerge で merge-exec 用だけ外れる）、SSE での完了、
// SSE の取りこぼし時の突き合わせ、修復ターン（同じセッションへ追記）、ask → denied、時間切れ → interrupt、
// 失敗の分類、close が自分のセッションだけを消し自分の serve だけを止めること。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { MERGE_RES, createAdapter, credentialReadRules, opencodeConfigDirs, protectRules } from '../../../skills/implement-issue-tree/runner/adapters/opencode.mjs'
import { AdapterError } from '../../../skills/implement-issue-tree/runner/lib/adapter-error.mjs'
import { createAgentHost } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { loadConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'
import { MERGE_EXEC_COMMAND, READ_ALLOW_FORMS, codexRules, mergeExecCommandFor, opencodeRules } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'

const PLUGIN_DIR = join(SKILL_DIR, 'runner', 'adapters', 'opencode-plugin')
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'fake-opencode-server.mjs')

function setup(extra = {}) {
  const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-oc-adapter-'))))
  const mainRoot = join(root, 'main')
  const runDir = join(root, 'run')
  mkdirSync(mainRoot, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  const log = join(root, 'fake.log')
  const adapter = createAdapter({
    skillDir: SKILL_DIR,
    mainRoot,
    runDir,
    toolConfig: { command: [process.execPath, FAKE], pollMs: 20, startTimeoutMs: 10000, deleteSessions: true, ...extra.toolConfig },
    guard: { codexRules, opencodeRules },
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GH_REPO')), FAKE_OC_LOG: log, ...extra.env },
  })
  let n = 0
  const req = (over = {}) => {
    n += 1
    const logDir = join(root, `agent-${n}`)
    return { prompt: 'hello', schema: {}, model: null, effort: null, cwd: mainRoot, label: `t${n}`, allowMerge: false, timeoutMs: 10000, resume: null, logDir, ...over }
  }
  const records = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { root, mainRoot, runDir, adapter, req, records }
}

const starts = (recs) => recs.filter((r) => r.ev === 'start')

// allow は READ_ALLOW_FORMS の完全一致の shell の読み取りだけで、permissions・policies とも shell の全 deny より後ろにある（後勝ち）。
// allow-all（action・resource の `*`）や wildcard つきの allow は無い。
function assertOnlyReadAllows(cfg) {
  for (const [key, toRes] of [['permissions', (r) => r], ['policies', (r) => `shell:${r}`]]) {
    const list = cfg[key]
    const allows = list.filter((r) => r.effect === 'allow')
    assert.deepEqual(allows.map((r) => r.resource), READ_ALLOW_FORMS.map(toRes), `${key}: allow は読み取りの完全一致の形だけ`)
    for (const r of allows) assert.ok(!/[*?]/.test(r.resource) && r.action !== '*', `${key}: wildcard の allow がある`)
    const isShell = (r) => r.action === 'shell' || r.resource.startsWith('shell:')
    const lastShellDeny = list.findLastIndex((r) => isShell(r) && r.effect === 'deny')
    assert.ok(list.findIndex((r) => r.effect === 'allow') > lastShellDeny, `${key}: allow が shell の deny より前にある`)
  }
}
const kindOf = async (p) => { try { await p } catch (e) { return e } throw new Error('失敗するはずが成功した') }

test('設定: allow-all が無く（allow は hooksPath の読み取りの完全一致だけ）、deny と plugin が入る。allowMerge の run だけ別の serve で merge の deny が外れる', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    let recs = starts(t.records())
    assert.equal(recs.length, 1, 'start では通常用の serve だけ')
    const cfg = recs[0].config
    assert.ok(recs[0].hasPassword)
    assertOnlyReadAllows(cfg)
    assert.equal(cfg.permissions.some((r) => r.action === '*'), false)
    assert.ok(cfg.permissions.some((r) => r.effect === 'deny' && r.resource === 'gh pr merge*'))
    assert.ok(cfg.policies.some((r) => r.action === 'tool.use' && r.resource === 'shell:gh pr merge*'))
    assert.equal(cfg.plugins.length, 1)
    const o = cfg.plugins[0].options
    assert.equal(cfg.plugins[0].package, PLUGIN_DIR, 'ランナー専用 plugin（配布物の plugin ではない）')
    assert.ok(existsSync(join(cfg.plugins[0].package, 'index.js')))
    assert.deepEqual(o.mergeRes, [], '通常用は merge の素通しを持たない')
    assert.ok(existsSync(o.guardScript) && /agent-guard\.sh$/.test(o.guardScript))
    assert.match(o.nonce, /^[0-9a-f]{32}$/)
    const marks = readFileSync(o.markerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(marks, [{ nonce: o.nonce, directory: t.mainRoot }], 'plugin が mainRoot の location で目印を書いた')
    assert.equal(o.callLog, join(dirname(o.markerPath), 'opencode-calls-normal.log'))

    await t.adapter.run(t.req())
    assert.equal(starts(t.records()).length, 1, 'allowMerge でない run では merge 用 serve を起動しない')

    await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 7, repo: 'octo/repo' } }))
    recs = starts(t.records())
    assert.equal(recs.length, 2)
    const [normal, merge] = recs
    assert.notEqual(normal.port, merge.port)
    assert.equal(merge.config.permissions.some((r) => r.resource === 'gh pr merge*'), false, 'merge 用は gh pr merge の deny が無い')
    assert.equal(merge.config.policies.some((r) => r.resource === 'shell:gh pr merge*'), false)
    assert.ok(merge.config.permissions.some((r) => /gh pr review\*--approve/.test(r.resource)), '承認の deny は残る')
    assert.ok(merge.config.permissions.some((r) => r.resource.includes('--admin')), '--admin の deny は残る')
    assertOnlyReadAllows(merge.config)
    assert.deepEqual(merge.config.plugins[0].options.mergeRes, [mergeExecCommandFor(7).source], 'merge 用だけ、その PR 番号で具体化した merge-exec を素通しにする')
    assert.deepEqual(MERGE_RES, [MERGE_EXEC_COMMAND.source], '完全一致の 1 形だけ（Codex の --merge-re と同じ）')
    assert.notEqual(merge.config.plugins[0].options.nonce, o.nonce, 'serve ごとに別の nonce')
  } finally { await t.adapter.close() }
})

test('保護: ガード本体・plugin の置き場・OpenCode の設定ディレクトリ・.opencode/(hooks|plugins?)/・opencode.json(c) への edit を permissions と policies で拒否する', async () => {
  const home = join(tmpdir(), 'iit-oc-home-x')
  const t = setup({ env: { HOME: home, XDG_CONFIG_HOME: '' } })
  await t.adapter.start()
  try {
    const { config: cfg } = starts(t.records())[0]
    const o = cfg.plugins[0].options
    const editDeny = cfg.permissions.filter((r) => r.action === 'edit' && r.effect === 'deny').map((r) => r.resource)
    const editPolicy = cfg.policies.filter((r) => r.action === 'tool.use' && r.resource.startsWith('edit:') && r.effect === 'deny').map((r) => r.resource.slice(5))
    const cfgDir = join(home, '.config', 'opencode')
    for (const want of [o.guardScript, cfg.plugins[0].package, `${realpathSync(cfg.plugins[0].package)}/*`, cfgDir, `${cfgDir}/*`, '*.opencode/plugins/*', '*.opencode/plugin/*', '*.opencode/hooks/*', '*opencode.jsonc', '*opencode.json']) {
      assert.ok(editDeny.includes(want), `permissions: ${want}`)
      assert.ok(editPolicy.includes(want), `policies: ${want}`)
    }
    assert.deepEqual(o.protectedPaths, [cfgDir], 'plugin の shell 判定にも効く保護は設定ディレクトリだけ')
    assert.deepEqual(o.editOnlyPaths, [SKILL_DIR], 'スキルの置き場は edit 系だけの保護として渡す')
    // 既存の shell の deny（opencodeRules）は残り、edit の deny はその後ろ（後勝ち）に置く
    const firstEdit = cfg.permissions.findIndex((r) => r.action === 'edit')
    assert.ok(firstEdit > cfg.permissions.findIndex((r) => r.resource === 'gh pr merge*'))
  } finally { await t.adapter.close() }
})

test('protectRules と opencodeConfigDirs: XDG_CONFIG_HOME・OPENCODE_CONFIG_DIR を反映し、ファイルは完全一致・ディレクトリは配下も拒否する', () => {
  assert.deepEqual(opencodeConfigDirs({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), ['/x/opencode'])
  assert.deepEqual(opencodeConfigDirs({ HOME: '/h', OPENCODE_CONFIG_DIR: '/c' }), ['/h/.config/opencode', '/c'])
  const r = protectRules({ files: ['/nonexistent-iit/g.sh'], dirs: ['/nonexistent-iit/p'] })
  const res = r.permissions.map((x) => x.resource)
  assert.ok(res.includes('/nonexistent-iit/g.sh') && !res.includes('/nonexistent-iit/g.sh/*'))
  assert.ok(res.includes('/nonexistent-iit/p') && res.includes('/nonexistent-iit/p/*'))
  assert.equal(r.policies.length, r.permissions.length)
})

test('セッション: 親セッションは作らない。model は Ref になり、model が null なら model も variant も送らずログに残す', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    await t.adapter.run(t.req({ model: 'prov/some/model-x', effort: 'low' }))
    const r2 = t.req({ allowMerge: true, merge: { prNumber: 3, repo: 'octo/repo' }, model: null, effort: 'low' })
    await t.adapter.run(r2)
    const posts = t.records().filter((r) => r.ev === 'http' && r.method === 'POST' && r.path === '/api/session')
    const child = posts.find((r) => r.body.title === 't1')
    const noModel = posts.find((r) => r.body.title === 't2')
    assert.equal(posts.some((r) => r.body.parentID), false, 'parentID を使わない')
    assert.deepEqual(child.body.model, { providerID: 'prov', id: 'some/model-x', variant: 'low' })
    assert.equal('model' in noModel.body, false)
    assert.match(readFileSync(join(r2.logDir, 'adapter.log'), 'utf8'), /model 未指定/)
    assert.equal(posts.some((r) => 'permissions' in r.body), false, 'セッションに permissions（allow-all）を付けない')
  } finally { await t.adapter.close() }
})

test('toolConfig.defaultModel があれば model が null のときに使う', async () => {
  const t = setup({ toolConfig: { defaultModel: 'bifrost/qwen' } })
  await t.adapter.start()
  try {
    await t.adapter.run(t.req({ effort: 'medium' }))
    const post = t.records().find((r) => r.ev === 'http' && r.method === 'POST' && r.path === '/api/session' && r.body.title === 't1')
    assert.deepEqual(post.body.model, { providerID: 'bifrost', id: 'qwen', variant: 'medium' })
  } finally { await t.adapter.close() }
})

test('SSE の完了で最終テキスト・sessionRef・usage を返し、ログを logDir へ書く', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const r = t.req({ prompt: 'first line\nsecond' })
    const out = await t.adapter.run(r)
    assert.equal(out.text, 'reply-1:first line')
    assert.match(out.sessionRef, /^ses_/)
    assert.deepEqual(out.usage, { input: 10, cached: 5, output: 2, reasoning: 0 })
    assert.equal(readFileSync(join(r.logDir, 'final.txt'), 'utf8'), 'reply-1:first line')
    const ev = readFileSync(join(r.logDir, 'events.jsonl'), 'utf8')
    assert.match(ev, /session\.execution\.succeeded/)
  } finally { await t.adapter.close() }
})

test('SSE の終端イベントを取りこぼしても、active と idle の突き合わせで完了を検知する', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const out = await t.adapter.run(t.req({ prompt: '[[NOSSE]] x' }))
    assert.equal(out.text, 'reply-1:[[NOSSE]] x')
  } finally { await t.adapter.close() }
})

test('修復ターンは同じセッションへ追記する（セッションを作り直さない）', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const first = await t.adapter.run(t.req({ prompt: 'p1' }))
    const second = await t.adapter.run(t.req({ resume: { sessionRef: first.sessionRef, message: 'fix it' } }))
    assert.equal(second.sessionRef, first.sessionRef)
    assert.equal(second.text, 'reply-2:fix it')
    const recs = t.records().filter((r) => r.ev === 'http')
    assert.equal(recs.filter((r) => r.method === 'POST' && r.path === '/api/session' && r.body.title !== 'iit-runner:parent').length, 1)
    assert.equal(recs.filter((r) => r.path === `/api/session/${first.sessionRef}/prompt`).length, 2)
    const e = await kindOf(t.adapter.run(t.req({ resume: { sessionRef: 'ses_unknown', message: 'x' } })))
    assert.equal(e.kind, 'api')
  } finally { await t.adapter.close() }
})

test('ask（許可要求）を検知したら interrupt して denied', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[ASK]]' })))
    assert.ok(e instanceof AdapterError)
    assert.equal(e.kind, 'denied')
    assert.ok(e.sessionRef)
    assert.ok(t.records().some((r) => r.ev === 'http' && r.path === `/api/session/${e.sessionRef}/interrupt`), 'interrupt を送った')
    assert.equal(t.records().some((r) => /\/permission\/.+\/reply$/.test(r.path ?? '')), false, 'reply（reject）は送らない')
  } finally { await t.adapter.close() }
})

test('時間切れは interrupt を送って timeout', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const r = t.req({ prompt: '[[HANG]]', timeoutMs: 300 })
    const e = await kindOf(t.adapter.run(r))
    assert.equal(e.kind, 'timeout')
    assert.ok(t.records().some((x) => x.ev === 'http' && x.path === `/api/session/${e.sessionRef}/interrupt`))
    assert.match(readFileSync(join(r.logDir, 'error.txt'), 'utf8'), /^timeout:/)
  } finally { await t.adapter.close() }
})

test('失敗の分類: failed は api、レート制限は usage-limit、serve の異常終了は exit', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[FAIL]]' })))).kind, 'api')
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[LIMIT]]' })))).kind, 'usage-limit')
    assert.equal((await kindOf(t.adapter.run(t.req({ prompt: '[[DIE]]' })))).kind, 'exit')
  } finally { await t.adapter.close() }
})

test('prereq: 起動コマンドが無い・agent-guard.sh が無い・plugin の目印が無い', async () => {
  const a = setup({ toolConfig: { command: ['/nonexistent/opencode-xyz'] } })
  assert.equal((await kindOf(a.adapter.start())).kind, 'prereq')
  await a.adapter.close()

  const noGuard = createAdapter({ skillDir: '/nonexistent/skills/x', mainRoot: a.mainRoot, runDir: a.runDir, toolConfig: { command: [process.execPath, FAKE] }, guard: { codexRules, opencodeRules }, env: process.env })
  assert.equal((await kindOf(noGuard.start())).kind, 'prereq')
  await noGuard.close()

  const c = setup({ env: { FAKE_OC_NOPLUGIN: '1' } })
  const e = await kindOf(c.adapter.start())
  assert.equal(e.kind, 'prereq')
  assert.match(e.message, /plugin/)
  await c.adapter.close()
  assert.ok(c.records().length > 0, 'serve は起動したが、目印が無いので走らせなかった')
})

test('close は自分が作ったセッションだけ削除し、自分の serve だけ止める', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  const t = setup({ env: { FAKE_OC_FOREIGN: 'ses_foreign' } })
  try {
    await t.adapter.start()
    const a = await t.adapter.run(t.req())
    const pid = starts(t.records())[0].pid
    await t.adapter.close()
    const deleted = t.records().filter((r) => r.ev === 'delete').map((r) => r.id)
    assert.ok(deleted.includes(a.sessionRef), '自分のセッションを削除した')
    assert.equal(deleted.includes('ses_foreign'), false, '他のセッションは消さない')
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false, 'serve が止まっている')
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), '無関係のプロセスは止めない')
  } finally { bystander.kill('SIGKILL') }
})

test('deleteSessions が false なら削除しない', async () => {
  const t = setup({ toolConfig: { deleteSessions: false } })
  await t.adapter.start()
  await t.adapter.run(t.req())
  await t.adapter.close()
  assert.equal(t.records().some((r) => r.ev === 'delete'), false)
})

// MEDIUM-7（監査 e670648）: plugin は location ごとに読み込まれ（v2.2.7 の実測: その location への最初の GET /api/agent か
// prompt で setup が走り、session.create では走らない）、start の確認は serve の cwd の 1 か所だけだった。
test('目印: session.create の後でその location の目印を確かめ、無ければ走らせない', async () => {
  const t = setup({ env: { FAKE_OC_NOPLUGIN_AT: 'wt-noplugin' } })
  await t.adapter.start()
  try {
    const ok = join(t.root, 'wt-ok')
    mkdirSync(ok)
    const out = await t.adapter.run(t.req({ cwd: ok }))
    assert.match(out.text, /^reply-1:/)
    const bad = join(t.root, 'wt-noplugin')
    mkdirSync(bad)
    const e = await kindOf(t.adapter.run(t.req({ cwd: bad, prompt: 'must not run' })))
    assert.equal(e.kind, 'prereq')
    assert.match(e.message, /plugin/)
    assert.equal(t.records().some((r) => r.ev === 'http' && r.path.endsWith('/prompt') && r.body?.text === 'must not run'), false, 'prompt を送らない')
  } finally { await t.adapter.close() }
})

test('件数照合: plugin を通っていない shell の実行があれば denied（ガードの欠落）。通っていれば成功', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const out = await t.adapter.run(t.req({ prompt: '[[SHELL:3]] ok' }))
    assert.match(out.text, /^reply-1:/)
    const r = t.req({ prompt: '[[SHELL:1]] [[SHELL_UNHOOKED:1]] x' })
    const e = await kindOf(t.adapter.run(r))
    assert.equal(e.kind, 'denied')
    assert.match(e.message, /ガードの欠落/)
    assert.match(readFileSync(join(r.logDir, 'error.txt'), 'utf8'), /^denied:/)
  } finally { await t.adapter.close() }
})

// MEDIUM-8（監査 e670648）: merge-exec の許可を PR 番号とリポジトリに縛る。req.merge は契約の形
// （null | { prNumber, repo }。allowMerge が true のときだけ入る）を agent-host が渡す前提で、ここでは req に直接入れる。
test('merge 用 serve: 照合を mergeExecCommandFor(prNumber) に絞り、env の GH_REPO を repo に固定する。PR ごとに別の serve', async () => {
  const t = setup({ env: { GH_REPO: 'evil/other' } })
  await t.adapter.start()
  try {
    await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 12, repo: 'octo/repo' } }))
    await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 12, repo: 'octo/repo' } }))
    await t.adapter.run(t.req({ allowMerge: true, merge: { prNumber: 13, repo: 'octo/repo' } }))
    const [normal, m12, m13, ...rest] = starts(t.records())
    assert.equal(rest.length, 0, '同じ PR は同じ serve を使う')
    assert.deepEqual(m12.config.plugins[0].options.mergeRes, [mergeExecCommandFor(12).source])
    assert.deepEqual(m13.config.plugins[0].options.mergeRes, [mergeExecCommandFor(13).source])
    const re = new RegExp(m12.config.plugins[0].options.mergeRes[0])
    const cmd = (n) => `HEAD_SHA="${'a'.repeat(40)}"; gh pr merge ${n} --squash --delete-branch --match-head-commit "$HEAD_SHA"`
    assert.ok(re.test(cmd(12)))
    assert.ok(!re.test(cmd(13)) && !re.test(cmd(1)) && !re.test(cmd(120)), '別の PR 番号は通さない')
    assert.equal(m12.ghRepo, 'octo/repo', '利用者の環境の GH_REPO より req.merge.repo を優先して固定する')
    assert.equal(m13.ghRepo, 'octo/repo')
    assert.equal(normal.ghRepo, 'evil/other', '通常用の serve の env は変えない')
    assert.notEqual(m12.config.plugins[0].options.markerPath, m13.config.plugins[0].options.markerPath, 'ファイルは serve ごとに分ける')
  } finally { await t.adapter.close() }
})

test('merge 用 serve: req.merge が null・不正なら allowMerge として扱わず、merge 用 serve を作らない（通常用で走らせる）', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    for (const merge of [undefined, null, { prNumber: 0, repo: 'o/r' }, { prNumber: 1.5, repo: 'o/r' }, { prNumber: '7', repo: 'o/r' }, { prNumber: 7, repo: 'bad' }, { prNumber: 7, repo: 'o/r;x' }, { prNumber: 7 }]) {
      const out = await t.adapter.run(t.req({ allowMerge: true, ...(merge === undefined ? {} : { merge }) }))
      assert.match(out.text, /^reply-/)
    }
    assert.equal(starts(t.records()).length, 1, '通常用の serve だけ')
  } finally { await t.adapter.close() }
})

// LOW-9（監査 e670648）: read tool で認証ファイルを読めないようにする（中身は読まない。パスだけを決める）
test('認証ファイル: gh の設定・Codex の auth.json・OpenCode の認証（auth.json・opencode.db）への read を permissions と policies で拒否する', async () => {
  const home = join(tmpdir(), 'iit-oc-home-y')
  const t = setup({ env: { HOME: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', GH_CONFIG_DIR: '', CODEX_HOME: '', OPENCODE_DB: '/nonexistent-iit/custom.db' } })
  await t.adapter.start()
  try {
    const { config: cfg } = starts(t.records())[0]
    const readDeny = cfg.permissions.filter((r) => r.action === 'read' && r.effect === 'deny').map((r) => r.resource)
    const readPolicy = cfg.policies.filter((r) => r.action === 'tool.use' && r.resource.startsWith('read:') && r.effect === 'deny').map((r) => r.resource.slice(5))
    for (const want of [
      join(home, '.config', 'gh'), `${join(home, '.config', 'gh')}/*`,
      join(home, '.codex', 'auth.json'),
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      `${join(home, '.local', 'share', 'opencode', 'opencode.db')}*`,
      '/nonexistent-iit/custom.db*',
    ]) {
      assert.ok(readDeny.includes(want), `permissions: ${want}`)
      assert.ok(readPolicy.includes(want), `policies: ${want}`)
    }
  } finally { await t.adapter.close() }
})

test('credentialReadRules: GH_CONFIG_DIR・XDG_CONFIG_HOME・CODEX_HOME・XDG_DATA_HOME を反映する', () => {
  const res = credentialReadRules({ HOME: '/h', GH_CONFIG_DIR: '/g', CODEX_HOME: '/c', XDG_DATA_HOME: '/d' }).permissions.map((r) => r.resource)
  for (const want of ['/g', '/g/*', '/c/auth.json', '/d/opencode/auth.json', '/d/opencode/opencode.db*']) assert.ok(res.includes(want), want)
  assert.ok(credentialReadRules({ HOME: '/h', XDG_CONFIG_HOME: '/x' }).permissions.some((r) => r.resource === '/x/gh/*'))
})

// 契約の追記（2026-11-17・監査修正の取り込み）: killSync は起動した serve のプロセスグループを同期で SIGKILL する。
// run.mjs がシグナル受信時と exit 時に呼ぶ（close を待てない経路）。
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitDead(pids, ms = 5000) {
  const end = Date.now() + ms
  while (pids.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  return pids.filter(alive)
}

test('killSync: 起動済みの serve（通常用と merge 用）を孫ごと同期で SIGKILL する', async () => {
  const gpid = join(trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-oc-gpid-')))), 'grandchild.pid')
  const t2 = setup({ env: { FAKE_OC_GRANDCHILD: gpid } })
  await t2.adapter.start()
  await t2.adapter.run(t2.req({ allowMerge: true, merge: { prNumber: 3, repo: 'octo/repo' } }))
  const pids = starts(t2.records()).map((r) => r.pid)
  assert.equal(pids.length, 2)
  const g = Number(readFileSync(gpid, 'utf8'))
  assert.ok([...pids, g].every(alive))
  const ret = t2.adapter.killSync()
  assert.equal(ret, undefined, '同期（Promise を返さない）')
  assert.deepEqual(await waitDead([...pids, g]), [], 'serve と同じプロセスグループの孫が止まる')
  await t2.adapter.close() // 止めた後の close も返る
})

test('killSync: 起動待ち（まだ待ち受けていない）の serve も止める。start は失敗で返る', async () => {
  const t = setup({ env: { FAKE_OC_NOLISTEN: '1' }, toolConfig: { startTimeoutMs: 20000 } })
  const p = t.adapter.start().then(() => null, (e) => e)
  const end = Date.now() + 10000
  while (starts(t.records()).length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  const [{ pid }] = starts(t.records())
  const t0 = Date.now()
  t.adapter.killSync()
  assert.deepEqual(await waitDead([pid]), [])
  const e = await p
  assert.ok(e instanceof AdapterError && e.kind === 'prereq', '起動待ちは serve の終了で prereq')
  assert.ok(Date.now() - t0 < 10000, '起動の時間切れを待たない')
  await t.adapter.close()
})

// 統合の経路（sec-host の agent-host が作る req.merge を sec-oc の OpenCode アダプタが受け取る）: 実の createAgentHost と
// 実のアダプタを偽 serve でつなぎ、merge-exec の段で PR ごとの merge 用 serve が、その PR 番号の形と GH_REPO で起動すること。
// MERGE_STEP は src の mergeExecutePrompt の手順 3 と同じ形（runner-agent-host.test.mjs と同じ）
const MERGE_STEP = (n) => `3. 次のコマンドで squash merge を実行する: HEAD_SHA="<payload.headSha の 40 桁>"; gh pr merge ${n} --squash --delete-branch --match-head-commit "$HEAD_SHA"。`
const HOST_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }

test('統合: agent-host の req.merge で、OpenCode アダプタが PR ごとの merge 用 serve を GH_REPO 固定・PR 番号の形で起動する', async () => {
  const t = setup({ env: { GH_REPO: 'evil/other' } })
  const host = (cfg) => createAgentHost({ adapter: t.adapter, cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot: t.mainRoot, runId: 'wf_0123abcd-4ef', runDir: join(t.runDir, 'host'), args: { autoMerge: true }, ...cfg } })
  await t.adapter.start()
  try {
    const agent = host({ repo: 'octo/repo' })
    await agent(MERGE_STEP(41), { label: 'merge-exec:#5', schema: HOST_SCHEMA })
    let recs = starts(t.records())
    assert.equal(recs.length, 2, '通常用 + PR 41 の merge 用')
    const m41 = recs[1]
    assert.equal(m41.ghRepo, 'octo/repo', 'agent-host の repo（cfg.repo）を merge 用 serve の GH_REPO に固定する')
    assert.deepEqual(m41.config.plugins[0].options.mergeRes, [mergeExecCommandFor(41).source])
    assert.deepEqual(recs[0].config.plugins[0].options.mergeRes, [], '通常用は素通しを持たない')
    assert.equal(recs[0].ghRepo, 'evil/other', '通常用の env は変えない')

    // 同じ PR は同じ serve、別の PR は別の serve
    await agent(MERGE_STEP(41), { label: 'merge-exec:#5', schema: HOST_SCHEMA })
    await agent(MERGE_STEP(42), { label: 'merge-exec:#6', schema: HOST_SCHEMA })
    recs = starts(t.records())
    assert.equal(recs.length, 3)
    assert.deepEqual(recs[2].config.plugins[0].options.mergeRes, [mergeExecCommandFor(42).source])

    // 決まらないとき（番号が 2 種類・回復専用の文面・merge-exec 以外の label）は merge 用 serve を作らず、通常用で走る
    await agent(`${MERGE_STEP(41)}\n${MERGE_STEP(43)}`, { label: 'merge-exec:#5', schema: HOST_SCHEMA })
    await agent('回復専用: gh pr merge の実行も行わない（常に禁止）', { label: 'merge-exec:#5', schema: HOST_SCHEMA })
    await agent(MERGE_STEP(44), { label: 'merge-verify:#5', schema: HOST_SCHEMA })
    // repo が未確定（cfg.repo なし）なら merge 用 serve を作らない
    await host({})(MERGE_STEP(45), { label: 'merge-exec:#7', schema: HOST_SCHEMA })
    // autoMerge でないランでも作らない
    await host({ repo: 'octo/repo', args: { autoMerge: false } })(MERGE_STEP(46), { label: 'merge-exec:#8', schema: HOST_SCHEMA })
    assert.equal(starts(t.records()).length, 3, '決まらない段では merge 用 serve を起動しない')
  } finally { await t.adapter.close() }
})

// --- serve が応答しないときの期限（API 要求と本文の読み取り。止まったと確認できなければ serve を終了させる）---
const dead = async (pid, ms = 3000) => (await waitDead([pid], ms)).length === 0
const elapsed = async (fn) => { const t0 = Date.now(); let err = null; try { await fn() } catch (e) { err = e } return { ms: Date.now() - t0, err } }

test('期限: prompt の応答が来なくても apiTimeoutMs で戻り、interrupt も応答しなければ serve を終了させる。次の run は新しい serve で走る', { timeout: 20000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 300 }, env: { FAKE_OC_HANGS: 'prompt,interrupt' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ timeoutMs: 60000 })))
    assert.ok(err instanceof AdapterError && err.kind === 'api', `api で失敗する: ${err?.message}`)
    assert.ok(ms < 5000, `期限（${ms} ms）が apiTimeoutMs に従う`)
    assert.ok(t.records().some((r) => r.ev === 'http' && /\/interrupt$/.test(r.path)), 'セッションを止めようとした')
    assert.ok(await dead(pid), '止まったと確認できなかったので serve を終了させた')
    const e2 = await kindOf(t.adapter.run(t.req({ timeoutMs: 60000 })))
    assert.ok(e2 instanceof AdapterError)
    assert.equal(starts(t.records()).length, 2, '終了した serve は作り直す')
  } finally { await t.adapter.close() }
})

test('期限: prompt の本文の読み取りが止まっても期限で戻る（fetch の応答だけでなく本文にも期限）', { timeout: 20000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 300 }, env: { FAKE_OC_PARTIAL: 'prompt', FAKE_OC_HANGS: 'interrupt' } })
  await t.adapter.start()
  try {
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ timeoutMs: 60000 })))
    assert.ok(err instanceof AdapterError && err.kind === 'api')
    assert.ok(ms < 5000, `本文の読み取りの期限（${ms} ms）`)
  } finally { await t.adapter.close() }
})

test('期限: 時間切れの interrupt が応答しなければ serve を終了させ、SIGTERM を無視する serve は SIGKILL で止める', { timeout: 20000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 300 }, env: { FAKE_OC_HANGS: 'interrupt', FAKE_OC_IGNORE_TERM: '1' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 400 })))
    assert.equal(err?.kind, 'timeout')
    assert.ok(ms < 8000, `戻りが期限内（${ms} ms）`)
    assert.ok(await dead(pid, 5000), 'SIGKILL で止めた')
  } finally { await t.adapter.close() }
})

test('期限: 取りこぼし突き合わせの GET が応答しなくても run の deadline で timeout に戻る', { timeout: 20000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 5000 }, env: { FAKE_OC_HANGS: 'active' } })
  await t.adapter.start()
  try {
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 500 })))
    assert.equal(err?.kind, 'timeout')
    assert.ok(ms < 3000, `各要求は残り時間で打ち切る（${ms} ms）`)
  } finally { await t.adapter.close() }
})

test('期限: close のセッション削除が応答しなくても戻り、serve を止める', { timeout: 20000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 300 }, env: { FAKE_OC_HANGS: 'delete' } })
  await t.adapter.start()
  const pid = starts(t.records())[0].pid
  await t.adapter.run(t.req())
  await t.adapter.run(t.req())
  const { ms } = await elapsed(() => t.adapter.close())
  assert.ok(ms < 6000, `close の戻り（${ms} ms）`)
  assert.ok(await dead(pid))
})

test('期限: apiTimeoutMs が無ければ timeoutsSec.default と 30 秒の小さいほう', async () => {
  // 設定からの導出だけを見る（serve への要求が通る間は結果に影響しない）。値は偽 serve の hang 時間で観測する
  const t = setup({ toolConfig: { timeoutsSec: { default: 1, byPhase: {} } }, env: { FAKE_OC_HANGS: 'prompt,interrupt' } })
  await t.adapter.start()
  try {
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ timeoutMs: 60000 })))
    assert.equal(err?.kind, 'api')
    assert.ok(ms >= 900 && ms < 6000, `timeoutsSec.default（1 秒）から決まる（${ms} ms）`)
  } finally { await t.adapter.close() }
})

// --- スキルの置き場（cfg.skillDir）の保護 ---
test('保護: cfg.skillDir（とその realpath）への edit を permissions と policies で拒否し、plugin にも渡す', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const { config: cfg } = starts(t.records())[0]
    const o = cfg.plugins[0].options
    const editDeny = cfg.permissions.filter((r) => r.action === 'edit' && r.effect === 'deny').map((r) => r.resource)
    const editPolicy = cfg.policies.filter((r) => r.resource.startsWith('edit:') && r.effect === 'deny').map((r) => r.resource.slice(5))
    for (const d of [SKILL_DIR, realpathSync(SKILL_DIR)]) {
      for (const want of [d, `${d}/*`]) {
        assert.ok(editDeny.includes(want), `permissions: ${want}`)
        assert.ok(editPolicy.includes(want), `policies: ${want}`)
      }
    }
    assert.ok(o.editOnlyPaths.includes(SKILL_DIR), 'plugin の editOnlyPaths に入る（edit だけ拒否）')
    assert.equal(o.protectedPaths.includes(SKILL_DIR), false, 'shell の判定の対象（protectedPaths）には入れない')
    assert.equal(cfg.permissions.some((r) => r.action === 'shell' && String(r.resource).includes(SKILL_DIR)), false, 'shell の permission の deny にスキルの置き場を入れない')
  } finally { await t.adapter.close() }
})

test('保護: 実の plugin が skillDir 配下の launcher への edit を拒否する（permission.evaluate）', async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const { config: cfg } = starts(t.records())[0]
    const plugin = (await import(`${new URL(`file://${join(PLUGIN_DIR, 'index.js')}`).href}?skill-protect`)).default
    let hook
    await plugin.setup({ options: { ...cfg.plugins[0].options, markerPath: join(t.runDir, 'm2'), nonce: 'n' }, location: { directory: t.mainRoot }, permission: { hook: async (n, fn) => { hook = fn } }, tool: { hook: async () => {} }, shell: { hook: async () => {} } })
    const ev = { action: 'edit', resources: [join(SKILL_DIR, 'scripts', 'run-verified.sh')] }
    await hook(ev)
    assert.equal(ev.effect, 'deny')
    const other = { action: 'edit', resources: [join(t.mainRoot, 'src', 'a.js')] }
    await hook(other)
    assert.notEqual(other.effect, 'deny')
  } finally { await t.adapter.close() }
})

// --- serve の本体の終了と、同じプロセスグループの子・孫（PR #851 の codex P1）---
// 本体の exit だけで止める対象から外すと、SIGTERM を無視する子や、本体の異常終了で残った孫に SIGKILL が届かない
const gcSetup = (extra = {}) => {
  const pidFile = join(trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-oc-gc-')))), 'grandchild.pid')
  const t = setup({ ...extra, env: { FAKE_OC_GRANDCHILD: pidFile, ...extra.env } })
  const gc = () => Number(readFileSync(pidFile, 'utf8'))
  const cleanup = () => { try { process.kill(gc(), 'SIGKILL') } catch { /* 既に無い */ } }
  return { ...t, gc, cleanup }
}

test('後片づけ: close は、本体が SIGTERM で終わっても SIGTERM を無視する同じグループの孫まで止める', { timeout: 20000 }, async () => {
  const t = gcSetup({ env: { FAKE_OC_GRANDCHILD_IGNORE_TERM: '1' } })
  try {
    await t.adapter.start()
    await t.adapter.run(t.req())
    const pid = starts(t.records())[0].pid
    assert.ok(alive(t.gc()))
    await t.adapter.close()
    assert.ok(await dead(pid), '本体は止まった')
    assert.deepEqual(await waitDead([t.gc()], 3000), [], 'SIGTERM を無視する孫が残っていない')
  } finally { t.cleanup() }
})

test('後片づけ: serve の本体が異常終了しても、同じグループに残った孫を止める（close を待たずに・close の後も残らない）', { timeout: 20000 }, async () => {
  const t = gcSetup()
  try {
    await t.adapter.start()
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[DIE]]' })))
    assert.equal(e.kind, 'exit')
    assert.deepEqual(await waitDead([t.gc()], 3000), [], '本体の終了で孫も止める')
    await t.adapter.close()
  } finally { t.cleanup() }
})

// --- 終了した serve の作り直し（PR #851 の Bugbot）: 並列の run が同時に終了済みの serve を見ても作り直しは 1 つ ---
test('作り直し: 終了した serve を並列の run が同時に見ても、作り直す serve は 1 つで、close は起動した serve をすべて止める', { timeout: 30000 }, async () => {
  const t = setup()
  let left = null
  await t.adapter.start()
  try {
    const first = starts(t.records())[0].pid
    process.kill(first, 'SIGKILL')
    assert.ok(await dead(first))
    const outs = await Promise.all([t.adapter.run(t.req()), t.adapter.run(t.req()), t.adapter.run(t.req())])
    for (const o of outs) assert.match(o.text, /^reply-1:/)
    assert.equal(starts(t.records()).length, 2, '作り直しは 1 回だけ（元の 1 つ + 作り直しの 1 つ）')
  } finally {
    await t.adapter.close()
    // 失敗しても残った serve を止める（残るとテストのプロセスが終わらない）。判定は下で行う
    left = await waitDead(starts(t.records()).map((r) => r.pid), 5000)
    for (const p of left) { try { process.kill(p, 'SIGKILL') } catch { /* 既に無い */ } }
  }
  assert.deepEqual(left, [], 'close の後に serve が残らない')
})

// --- halt の期限（PR #851 の Bugbot）: interrupt が応答しないとき、halt 全体が agent-host の watchdog の猶予（30 秒）に収まる ---
test('halt の期限: 時間切れの interrupt が応答しなくても、apiTimeoutMs を丸ごと待たずに短い期限で serve を止めて戻る', { timeout: 60000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 20000 }, env: { FAKE_OC_HANGS: 'interrupt' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 400 })))
    assert.equal(err?.kind, 'timeout')
    assert.ok(ms < 12000, `halt が apiTimeoutMs（20000 ms）を待たない（${ms} ms）`)
    assert.ok(await dead(pid), '止まったと確かめられないので serve を止めた')
  } finally { await t.adapter.close() }
})

test('halt の期限: interrupt が応答すれば、時間切れの後も serve は止めずに次の run で使い回す', { timeout: 20000 }, async () => {
  const t = setup()
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 400 })))
    assert.equal(e.kind, 'timeout')
    assert.ok(alive(pid), 'serve は生きている')
    assert.match((await t.adapter.run(t.req())).text, /^reply-1:/)
    assert.equal(starts(t.records()).length, 1, '作り直さない')
  } finally { await t.adapter.close() }
})

// --- prompt の通信エラー（PR #851 の codex P1）: 要求が届いたか分からない失敗は、期限切れでなくてもセッションを止める ---
test('prompt の通信エラー: 受理の後に接続が切れたら interrupt してから失敗を返す（serve は使い回せる）', { timeout: 20000 }, async () => {
  const t = setup({ env: { FAKE_OC_RESET: 'prompt' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 60000 })))
    assert.ok(e instanceof AdapterError && e.kind === 'api', `api で失敗する: ${e?.message}`)
    assert.ok(t.records().some((r) => r.ev === 'http' && r.path === `/api/session/${e.sessionRef}/interrupt`), '受理されたかもしれないセッションを止めた')
    assert.ok(alive(pid), 'interrupt が応答したので serve は止めない')
  } finally { await t.adapter.close() }
})

test('prompt の通信エラー: interrupt も応答しなければ serve を止めてから失敗を返す', { timeout: 30000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 500 }, env: { FAKE_OC_RESET: 'prompt', FAKE_OC_HANGS: 'interrupt' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 60000 })))
    assert.equal(e.kind, 'api')
    assert.ok(await dead(pid), '止まったと確かめられないので serve を止めた')
  } finally { await t.adapter.close() }
})

// --- prompt の 200 以外の応答（PR #851 の codex P1 の続き）: 受理されたかを確定できなければ止める ---
// OpenCode v2 の session.prompt が文書化する拒否（400 InvalidRequestError・401 UnauthorizedError・404 SessionNotFound /
// LocationNotFound）だけは受け付けていないと言えるので止めない。それ以外（409 ConflictError・5xx・200 以外の 2xx 等）は止める
test('prompt の非 200: 受理の後の 500・409・202 では interrupt してから失敗を返す（セッションが動き続けない）', { timeout: 30000 }, async () => {
  for (const code of [500, 409, 202]) {
    const t = setup({ env: { FAKE_OC_PROMPT_STATUS: String(code), FAKE_OC_PROMPT_STARTED: '1' } })
    await t.adapter.start()
    try {
      const e = await kindOf(t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 60000 })))
      assert.ok(e instanceof AdapterError && e.kind === 'api', `${code}: api で失敗する: ${e?.message}`)
      assert.ok(t.records().some((r) => r.ev === 'http' && r.path === `/api/session/${e.sessionRef}/interrupt`), `${code}: 受理されたかもしれないセッションを止めた`)
    } finally { await t.adapter.close() }
  }
})

test('prompt の非 200: 受理されたかを確かめられない 500 で interrupt も応答しなければ serve を止める', { timeout: 30000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 500 }, env: { FAKE_OC_PROMPT_STATUS: '500', FAKE_OC_PROMPT_STARTED: '1', FAKE_OC_HANGS: 'interrupt' } })
  await t.adapter.start()
  try {
    const pid = starts(t.records())[0].pid
    const e = await kindOf(t.adapter.run(t.req({ prompt: '[[HANG]]', timeoutMs: 60000 })))
    assert.equal(e.kind, 'api')
    assert.ok(await dead(pid), '止まったと確かめられないので serve を止めた')
  } finally { await t.adapter.close() }
})

test('prompt の非 200: 受け付けていない 400・401・404 では止めない（serve を使い回す）', { timeout: 30000 }, async () => {
  for (const code of [400, 401, 404]) {
    const t = setup({ env: { FAKE_OC_PROMPT_STATUS: String(code) } })
    await t.adapter.start()
    try {
      const pid = starts(t.records())[0].pid
      const e = await kindOf(t.adapter.run(t.req({ timeoutMs: 60000 })))
      assert.equal(e.kind, 'api', String(code))
      assert.match(e.message, new RegExp(`HTTP ${code}`))
      assert.equal(t.records().some((r) => r.ev === 'http' && /\/interrupt$/.test(r.path)), false, `${code}: interrupt を送らない`)
      assert.ok(alive(pid), `${code}: serve は止めない`)
    } finally { await t.adapter.close() }
  }
})

// --- 成功の後の取得の期限（PR #851 の Bugbot の続き）: shell の件数・本文・usage の取得は、ターンの残りの時間（無ければ halt と
// 同じ短い期限）で打ち切る。件数・本文を取れなければ照合できないものとしてその段を失敗にし、usage は無しにする ---
test('成功の後の期限: メッセージの取得が応答しなければ、apiTimeoutMs を待たずに件数を照合できないものとして失敗する', { timeout: 60000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 20000 }, env: { FAKE_OC_HANGS_AFTER_IDLE: 'message' } })
  await t.adapter.start()
  try {
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ prompt: '[[SHELL:1]]', timeoutMs: 400 })))
    assert.ok(err instanceof AdapterError && err.kind === 'api', `照合できないので失敗する: ${err?.message}`)
    assert.match(err.message, /件数/)
    assert.ok(ms < 12000, `apiTimeoutMs（20000 ms）を待たない（${ms} ms）`)
  } finally { await t.adapter.close() }
})

test('成功の後の期限: ターンの残りの時間があればその時間で打ち切る', { timeout: 60000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 20000 }, env: { FAKE_OC_HANGS_AFTER_IDLE: 'message' } })
  await t.adapter.start()
  try {
    const { ms, err } = await elapsed(() => t.adapter.run(t.req({ timeoutMs: 8000 })))
    assert.equal(err?.kind, 'api')
    assert.ok(ms >= 7000 && ms < 12000, `ターンの残り（約 8000 ms）で打ち切る（${ms} ms）`)
  } finally { await t.adapter.close() }
})

test('成功の後の期限: usage の取得が応答しなければ、短い期限で usage 無しの成功を返す', { timeout: 60000 }, async () => {
  const t = setup({ toolConfig: { apiTimeoutMs: 20000 }, env: { FAKE_OC_HANGS_AFTER_IDLE: 'get' } })
  await t.adapter.start()
  try {
    let value
    const { ms, err } = await elapsed(async () => { value = await t.adapter.run(t.req({ timeoutMs: 400 })) })
    assert.equal(err, null, err?.message)
    assert.match(value.text, /^reply-1:/)
    assert.equal(value.usage, undefined)
    assert.ok(ms < 12000, `apiTimeoutMs（20000 ms）を待たない（${ms} ms）`)
  } finally { await t.adapter.close() }
})

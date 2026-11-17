// ランナー（Codex 版）の worktree 掃除の複合段（state:cleanup:#N の実行仕様なしの形）を、ホストが直接実行することの回帰テスト
// （PR #851 の codex P1。runner/lib/cleanup-host.mjs と lib/agent-host.mjs）。
//
// 生成物の updateStateDetailed は、追跡中の worktree を消して状態の worktree を空にする掃除（clearWorktreeAfterCleanup）だけ、
// 実行仕様（0 行目の iit-exec v1）を付けずに「1. worktree-remove.sh remove → 2. 語が removed / not-registered / skipped のときだけ
// state.sh merge で .items["N"].worktree を空にする」をモデルへ渡す。ランナーではこの段は隔離なし・読み取りの profile で、
// writablePaths も recoverGit も無いため、モデルは worktree・gitdir の削除も状態ファイルの書き込みもできない。
//
// ここでは src の updateStateDetailed が実際に組むプロンプトを使い（プロンプトの形への依存を固定する）、実 git のリポジトリと
// 実物の run-verified.sh・worktree-remove.sh・state.sh で、ホストがモデルを介さずに 2 段を実行することを確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_ARGS, importDefinitions } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { gitEnv, makeRepo } from './lib/worktree-sandbox.mjs'
import { SCRIPT_HASH_PLACEHOLDER_RE, bundleSha256 } from '../scripts/build-workflow.mjs'
import { createAgentHost, spawnScript } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { loadConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'

const SKILL_DIR = fileURLToPath(new URL('../../../skills/implement-issue-tree', import.meta.url))
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts')
const embedHashes = (p) => p.replace(SCRIPT_HASH_PLACEHOLDER_RE, (_m, name) => bundleSha256(SCRIPTS_DIR, name))
const PARENT = 1
const RUN_ID = 'wf_0123abcd-4ef'
const CLEANUP_SCHEMA = { type: 'object', required: ['ok', 'retained'], properties: { ok: { type: 'boolean' }, retained: { type: 'boolean' }, branchSha: { type: 'string' }, worktree: { type: 'string' } } }

// src の定義部（グローバルの args・agent・log を読む）。プロンプトだけを集め、掃除の段には応答しない
const srcCalls = []
globalThis.args = { ...BASE_ARGS, parent: PARENT, repo: 'o/r', skillDir: SKILL_DIR }
globalThis.mainWorktreePath = '/repo/main'
globalThis.log = () => {}
globalThis.agent = async (prompt, opts) => {
  srcCalls.push({ prompt, opts })
  if (opts.label === 'nonce:seed') return { seedHex: '0'.repeat(64) }
  if (opts.label.startsWith('state:update')) return { ok: true }
  return { ok: true, retained: false }
}
const m = await importDefinitions(['ensureBoundaryNonceSeed', 'updateStateDetailed'], 'runner-cleanup-host')
await m.ensureBoundaryNonceSeed()

/** src の updateStateDetailed が組む掃除のプロンプト（ハッシュを埋めたもの）と label。 */
async function cleanupPromptOf(issue, patch, options) {
  srcCalls.length = 0
  await m.updateStateDetailed(issue, patch, options)
  const c = srcCalls.filter((x) => x.opts.label.startsWith('state:cleanup'))
  assert.equal(c.length, 1, '掃除の段がちょうど 1 回')
  return { prompt: embedHashes(c[0].prompt), label: c[0].opts.label }
}

/** 実 git のメイン worktree・.claude/worktrees 直下の付属 worktree・状態ファイルを作る。 */
function setup({ issue = 2, name = `${RUN_ID}-2`, record } = {}) {
  const repo = makeRepo()
  const main = realpathSync(repo.main)
  const wt = join(main, '.claude', 'worktrees', name)
  repo.addWorktree(name, { dir: wt, branch: `feat/${issue}-x` })
  const gitdir = join(main, '.git', 'worktrees', name)
  const stateFile = join(main, '_', 'issue-trees', `${PARENT}.json`)
  mkdirSync(join(main, '_', 'issue-trees'), { recursive: true })
  writeFileSync(stateFile, `${JSON.stringify({ items: { [String(issue)]: { status: 'merged', worktree: record ?? wt } } })}\n`)
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  return { repo, main, wt, gitdir, stateFile, state }
}

// failState: state.sh の起動を失敗させる（2 段目の失敗の確かめ用）。scripts は起動したスクリプト名の列
function makeHost(mainRoot, root, { failState = false } = {}) {
  const mod = makeFakeAdapterModule({ reply: () => ({ ok: true, retained: false, branchSha: '', worktree: 'removed' }) })
  const scripts = []
  const run = (file, argv, opts) => {
    scripts.push(argv[2])
    if (failState && argv[2] === 'state.sh') return Promise.resolve({ code: 1, stdout: 'STATE_RESULT {"ok":false,"reason":"x"}\n', stderr: '', timedOut: false, overflow: false })
    return spawnScript(file, argv, { ...opts, env: gitEnv(root) })
  }
  const logs = []
  const agent = createAgentHost({ adapter: mod.createAdapter({}), cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot, runId: RUN_ID, args: { parent: PARENT }, spawnScript: run, log: (x) => logs.push(x) } })
  return { agent, calls: mod.calls, logs, scripts }
}

test('正常系（superseded・マージ完了時の掃除）: モデルを介さず worktree と gitdir を消し、状態の worktree を空にする', async () => {
  const s = setup()
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  assert.equal(label, 'state:cleanup:#2')
  assert.doesNotMatch(prompt.split('\n', 1)[0], /iit-exec/, 'この掃除は実行仕様を持たない（モデルの段として渡される形）')
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0, 'アダプタ（モデル）を呼ばない')
  assert.deepEqual(got, { ok: true, retained: false, branchSha: '', worktree: 'removed' }, h.logs.join('\n'))
  assert.equal(existsSync(s.wt), false, 'worktree が消える')
  assert.equal(existsSync(s.gitdir), false, 'gitdir が消える')
  assert.equal(s.state().items['2'].worktree, '', '状態の worktree が空になる')
  assert.equal(s.state().items['2'].status, 'merged', '他のフィールドは変えない')
})

test('正常系（discard・Recover の破棄。--branch つき）: worktree・gitdir・ブランチを消し、消す前の先頭 sha を返して状態の worktree を空にする', async () => {
  const s = setup({ issue: 3, name: `${RUN_ID}-3` })
  const head = s.repo.head(s.wt)
  const { prompt, label } = await cleanupPromptOf(3, { branch: 'feat/3-x' }, { cleanupWorktree: s.wt, cleanupMode: 'discard', deleteBranch: true })
  assert.match(prompt, / --branch 'feat\/3-x' --base 'main'$/m)
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0)
  assert.deepEqual(got, { ok: true, retained: false, branchSha: head, worktree: 'removed' }, h.logs.join('\n'))
  assert.equal(existsSync(s.wt), false)
  assert.equal(existsSync(s.gitdir), false)
  assert.doesNotMatch(s.repo.git(s.main, 'branch', '--list', 'feat/3-x'), /feat/, 'ブランチも消える')
  assert.equal(s.state().items['3'].worktree, '')
})

test('正常系（実体が手で消された worktree）: 拒まずに worktree-remove.sh へ渡し、not-registered で状態の worktree を空にする', async () => {
  const s = setup()
  s.repo.git(s.main, 'worktree', 'remove', '--force', s.wt)
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0)
  assert.deepEqual(got, { ok: true, retained: false, branchSha: '', worktree: 'not-registered' }, h.logs.join('\n'))
  assert.equal(s.state().items['2'].worktree, '')
})

test('保持（discard・未コミット変更あり）: 2 段目を起動せず、状態の worktree の記録を残す', async () => {
  const s = setup()
  s.repo.write(s.wt, 'dirty.txt', 'x\n')
  const { prompt, label } = await cleanupPromptOf(2, { worktree: '' }, { cleanupWorktree: s.wt, cleanupMode: 'discard' })
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0)
  assert.equal(got.retained, true)
  assert.equal(got.worktree, 'retained-dirty')
  assert.equal(existsSync(s.wt), true)
  assert.equal(s.state().items['2'].worktree, s.wt, '保持した worktree の記録は消さない')
})

test('2 段目（state.sh）が失敗したら、1 段目の結果のまま ok だけを false にする', async () => {
  const s = setup()
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  const h = makeHost(s.main, s.repo.root, { failState: true })
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.deepEqual(got, { ok: false, retained: false, branchSha: '', worktree: 'removed' })
  assert.equal(existsSync(s.wt), false)
  assert.equal(s.state().items['2'].worktree, s.wt)
})

test('拒否（label の形が違う）: 掃除の段として扱わず、ホストは何も実行しない（従来どおりモデルへ回る）', async () => {
  for (const bad of ['state:cleanup:#02', 'state:cleanupx:#2', 'state:cleanup:#2:retry', 'state:cleanup:2', 'xstate:cleanup:#2', 'state:cleanup:#2-retry']) {
    const s = setup()
    const { prompt } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
    const h = makeHost(s.main, s.repo.root)
    await h.agent(prompt, { label: bad, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
    assert.equal(h.scripts.length, 0, `${bad}: スクリプトを起動しない`)
    assert.equal(h.calls.length, 1, `${bad}: 掃除の段として扱わない`)
    assert.equal(existsSync(s.wt), true, bad)
    assert.equal(s.state().items['2'].worktree, s.wt, bad)
  }
})

/** 拒否の共通の確かめ方: 何も起動せず（モデルへも回さず）失敗値を返し、worktree と状態の記録が残る。 */
async function assertRefused(s, prompt, label, why, reason) {
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.deepEqual(got, { ok: false, retained: true, worktree: '' }, why)
  assert.equal(h.calls.length, 0, `${why}: モデルへ回さない`)
  assert.equal(h.scripts.length, 0, `${why}: スクリプトを起動しない`)
  assert.match(h.logs.join('\n'), /worktree 掃除の段を実行しない/, why)
  assert.match(h.logs.join('\n'), reason, `${why}: 拒否の理由`)
  return h
}

test('拒否（対象の worktree が .claude/worktrees の外にある）', async () => {
  const s = setup()
  const out = s.repo.addWorktree('outside').path
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { worktree: out } } })}\n`)
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: out }, { cleanupWorktree: out })
  await assertRefused(s, prompt, label, '外のパス', /<main>\/\.claude\/worktrees\/ の直下でない/)
  assert.equal(existsSync(out), true)
  assert.equal(s.state().items['2'].worktree, out)
})

test('拒否（.claude/worktrees の直下の名前が symlink で外の worktree を指す・.claude/worktrees 自体が外を指す）', async () => {
  const s = setup()
  const out = s.repo.addWorktree('outside').path
  const link = join(s.main, '.claude', 'worktrees', 'link-1')
  symlinkSync(out, link)
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { worktree: link } } })}\n`)
  const p1 = await cleanupPromptOf(2, { status: 'merged', worktree: link }, { cleanupWorktree: link })
  await assertRefused(s, p1.prompt, p1.label, 'symlink の worktree', /symlink で外を指す/)
  assert.equal(existsSync(out), true)

  const t = setup()
  const real = join(t.repo.root, 'elsewhere')
  renameSync(join(t.main, '.claude', 'worktrees'), real)
  symlinkSync(real, join(t.main, '.claude', 'worktrees'))
  const p2 = await cleanupPromptOf(2, { status: 'merged', worktree: t.wt }, { cleanupWorktree: t.wt })
  await assertRefused(t, p2.prompt, p2.label, '.claude/worktrees が symlink', /\.claude\/worktrees がメイン worktree の外を指す/)
  assert.equal(existsSync(join(real, `${RUN_ID}-2`)), true)
})

test('拒否（gitdir の commondir を付け替えている）', async () => {
  const s = setup()
  const fake = join(s.repo.root, 'fake.git')
  mkdirSync(fake)
  writeFileSync(join(s.gitdir, 'commondir'), `${fake}\n`)
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  await assertRefused(s, prompt, label, 'commondir の付け替え', /commondir がメインの \.git を指さない/)
  assert.equal(existsSync(s.wt), true)
  assert.equal(existsSync(s.gitdir), true)
})

test('拒否（状態ファイルの記録が別の worktree・label の N と本文の numbers が違う・プロンプトに起動の行が足されている）', async () => {
  const s = setup()
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { worktree: join(s.main, '.claude', 'worktrees', 'other') } } })}\n`)
  await assertRefused(s, prompt, label, '記録が別の worktree', /記録が対象のパスでも空文字でもない/)
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { worktree: s.wt } } })}\n`)
  await assertRefused(s, prompt, 'state:cleanup:#3', 'label の N の違い', /本文が label のイシュー/)
  const extra = prompt.replace('```sh\n', `\`\`\`sh\nbash '${SKILL_DIR}/scripts/run-verified.sh' ${'0'.repeat(64)} state.sh --file _/issue-trees/1.json init\n`)
  await assertRefused(s, extra, label, '起動の行の追加', /起動する行が 2 つでない/)
  assert.equal(existsSync(s.wt), true)
})

test('label のモデル切り替えの接尾辞（:fallback-<model>）は同じ段として直接実行する', async () => {
  const s = setup()
  const { prompt } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label: 'state:cleanup:#2:fallback-sonnet', phase: 'State', model: 'sonnet', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0)
  assert.equal(got.worktree, 'removed', h.logs.join('\n'))
  assert.equal(s.state().items['2'].worktree, '')
})

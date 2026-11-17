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
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_ARGS, importDefinitions } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { gitEnv, makeRepo } from './lib/worktree-sandbox.mjs'
import { SCRIPT_HASH_PLACEHOLDER_RE, bundleSha256 } from '../scripts/build-workflow.mjs'
import { createAgentHost, spawnScript } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { checkCleanupTarget } from '../../../skills/implement-issue-tree/runner/lib/cleanup-host.mjs'
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

test('パスの綴り（末尾の /・//）: 位置は正規化した形で確かめて直接実行し、末尾の / つきの symlink・.. の区間は拒否する', async () => {
  // 生成物の sanitizeWorktreePath は末尾の / や // を通すため、状態の記録にはその綴りが残り得る
  for (const spell of [(w) => `${w}/`, (w) => w.replace('/.claude/', '//.claude/')]) {
    const s = setup()
    const rec = spell(s.wt)
    writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { worktree: rec } } })}\n`)
    const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: rec }, { cleanupWorktree: rec })
    const h = makeHost(s.main, s.repo.root)
    const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
    assert.equal(h.calls.length, 0, `${rec}: アダプタを呼ばない`)
    assert.doesNotMatch(h.logs.join('\n'), /worktree 掃除の段を実行しない/, `${rec}: ホストは拒否しない`)
    assert.deepEqual(got, { ok: true, retained: false, branchSha: '', worktree: 'removed' }, `${rec}: ${h.logs.join('\n')}`)
    assert.deepEqual(h.scripts, ['worktree-remove.sh', 'state.sh'], rec)
    assert.equal(existsSync(s.wt), false, `${rec}: worktree が消える`)
    assert.equal(existsSync(s.gitdir), false, `${rec}: gitdir が消える`)
    assert.equal(s.state().items['2'].worktree, '', `${rec}: 状態の worktree が空になる`)
  }
  // 末尾の / があると lstat が symlink を辿る。正規化した形で調べるので外を指す symlink は拒否される
  const t = setup()
  const out = t.repo.addWorktree('outside').path
  const link = `${join(t.main, '.claude', 'worktrees', 'link-1')}/`
  symlinkSync(out, link.slice(0, -1))
  writeFileSync(t.stateFile, `${JSON.stringify({ items: { 2: { worktree: link } } })}\n`)
  const p1 = await cleanupPromptOf(2, { status: 'merged', worktree: link }, { cleanupWorktree: link })
  await assertRefused(t, p1.prompt, p1.label, '末尾の / つきの symlink', /symlink で外を指す/)
  assert.equal(existsSync(out), true)
  // .. の区間（生成物の sanitizeWorktreePath が通さないため、プロンプトを直接書き換えて確かめる）
  const u = setup()
  const p2 = await cleanupPromptOf(2, { status: 'merged', worktree: u.wt }, { cleanupWorktree: u.wt })
  const dotted = u.wt.replace('/.claude/worktrees/', '/.claude/worktrees/../worktrees/')
  writeFileSync(u.stateFile, `${JSON.stringify({ items: { 2: { worktree: dotted } } })}\n`)
  await assertRefused(u, p2.prompt.split(`'${u.wt}'`).join(`'${dotted}'`), p2.label, '.. の区間', /\.\. の区間がある/)
  assert.equal(existsSync(u.wt), true)
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

// Issue #865: worktree.useRelativePaths=true（git 2.48 以降）で作った worktree は、<main>/.git/worktrees/<name>/gitdir に相対パス
// （../../../.claude/worktrees/<name>/.git）を持ち、worktree の .git も相対の gitdir を持つ。git のバージョンに頼らず手で同じ形に書き換える
// （古い git では設定が無視されて絶対パスのまま素通りするため）。絶対パスとの文字列比較では gitdir が見つからず、commondir・.git の照合を飛ばしていた
function makeRelative(s) {
  writeFileSync(join(s.gitdir, 'gitdir'), `${relative(s.gitdir, join(s.wt, '.git'))}\n`)
  writeFileSync(join(s.wt, '.git'), `gitdir: ${relative(s.wt, s.gitdir)}\n`)
  assert.match(readFileSync(join(s.gitdir, 'gitdir'), 'utf8'), /^\.\.\/\.\.\/\.\.\/\.claude\/worktrees\/[^/]+\/\.git\n$/, '前提: gitdir の中身が相対パス')
}

test('#865 相対パスの gitdir: 照合して直接実行し、worktree・gitdir を消して状態の worktree を空にする', async () => {
  const s = setup()
  makeRelative(s)
  assert.deepEqual(checkCleanupTarget({ mainRoot: s.main, path: s.wt, parent: PARENT, issue: 2 }), { ok: true })
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  const h = makeHost(s.main, s.repo.root)
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(h.calls.length, 0)
  assert.deepEqual(got, { ok: true, retained: false, branchSha: '', worktree: 'removed' }, h.logs.join('\n'))
  assert.equal(existsSync(s.wt), false)
  assert.equal(existsSync(s.gitdir), false)
  assert.equal(s.state().items['2'].worktree, '')
})

test('#865 相対パスの gitdir: commondir を別の場所へ向けたもの・worktree の .git が別の gitdir を指すもの・同じ worktree を指す gitdir が 2 つあるものは拒否する', async () => {
  // commondir の付け替え（相対の形）
  const s = setup()
  makeRelative(s)
  mkdirSync(join(s.repo.root, 'fake.git'))
  writeFileSync(join(s.gitdir, 'commondir'), `${relative(s.gitdir, join(s.repo.root, 'fake.git'))}\n`)
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: s.wt }, { cleanupWorktree: s.wt })
  await assertRefused(s, prompt, label, '相対の gitdir と commondir の付け替え', /commondir がメインの \.git を指さない/)
  assert.equal(existsSync(s.wt), true)
  assert.equal(existsSync(s.gitdir), true)
  // worktree の .git が別の gitdir を指す
  const t = setup()
  makeRelative(t)
  const other = t.repo.addWorktree('other', { dir: join(t.main, '.claude', 'worktrees', 'other') })
  writeFileSync(join(t.wt, '.git'), `gitdir: ${relative(t.wt, join(t.main, '.git', 'worktrees', 'other'))}\n`)
  assert.equal(checkCleanupTarget({ mainRoot: t.main, path: t.wt, parent: PARENT, issue: 2 }).reason, 'worktree の .git が gitdir を指さない')
  assert.equal(existsSync(other.path), true)
  // 同じ worktree を指す gitdir が 2 つ（相対と絶対）
  const u = setup()
  makeRelative(u)
  mkdirSync(join(u.main, '.git', 'worktrees', 'dup'))
  writeFileSync(join(u.main, '.git', 'worktrees', 'dup', 'gitdir'), `${u.wt}/.git\n`)
  assert.equal(checkCleanupTarget({ mainRoot: u.main, path: u.wt, parent: PARENT, issue: 2 }).reason, 'この worktree を指す gitdir が 2 つ以上ある')
})

// ---- Phase 4: ランナーが自分の pid で lock した worktree（retained-locked で残った 3 件）----
// ランナーは隔離 worktree を `claude agent <runId>-<n> (pid <ランナーの pid>)` で lock し、同じプロセスが worktree-remove.sh を
// 起動するので、lock は常に生存と判定されて保持になっていた。ホストは自分が作った worktree（作成時の lock の理由と一致するもの）
// だけを、スクリプトの前に unlock する。

/** createWorktree の差し替え: 実 git で .claude/worktrees/<runId>-<n> を作り、ランナーと同じ形で自分の pid の lock を付ける。 */
function lockedWorktreeMaker(repo, main) {
  return ({ runId, n }) => {
    const name = `${runId}-${n}`
    const dir = join(main, '.claude', 'worktrees', name)
    repo.addWorktree(name, { dir, branch: `worktree-${name}` })
    const lockReason = `claude agent ${name} (pid ${process.pid})`
    repo.git(main, 'worktree', 'lock', '--reason', lockReason, dir)
    return { path: dir, lockReason }
  }
}
/** ランナーを通さずに作った、同じ形の lock の worktree（対照）。 */
function foreignLocked(repo, main, name) {
  const dir = join(main, '.claude', 'worktrees', name)
  repo.addWorktree(name, { dir, branch: `worktree-${name}` })
  repo.git(main, 'worktree', 'lock', '--reason', `claude agent ${name} (pid ${process.pid})`, dir)
  return dir
}
const lockedOf = (repo, main, dir) => repo.git(main, 'worktree', 'list', '--porcelain').split('\n\n').some((b) => b.startsWith(`worktree ${dir}\n`) && /\nlocked/.test(b))

function hostWithWorktrees(repo, main) {
  const mod = makeFakeAdapterModule({ reply: () => ({ ok: true }) })
  const scripts = []
  const run = (file, argv, opts) => { scripts.push(argv[2]); return spawnScript(file, argv, { ...opts, env: gitEnv(repo.root) }) }
  const logs = []
  const agent = createAgentHost({ adapter: mod.createAdapter({}), cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot: main, runId: RUN_ID, args: { parent: PARENT }, spawnScript: run, createWorktree: lockedWorktreeMaker(repo, main), log: (x) => logs.push(x) } })
  return { agent, logs, scripts, mod }
}
const OK_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
const specLine = (spec) => `<!-- iit-exec v1 ${JSON.stringify(spec)} -->`
const removeSpec = (path, mode = 'superseded') => `${specLine({ v: 1, script: 'worktree-remove.sh', sha256: bundleSha256(SCRIPTS_DIR, 'worktree-remove.sh'), argv: ['remove', '--mode', mode, '--path', path], ret: 'line:WORKTREE_REMOVE_RESULT' })}\n掃除`

test('Phase 4 掃除の複合段: ランナーが作って自分の pid で lock した旧 worktree は unlock してから消す。ランナーが作っていない同じ形の lock は外さず retained-locked', async () => {
  const s = setup({ issue: 2, name: 'pre-existing' })
  const h = hostWithWorktrees(s.repo, s.main)
  await h.agent('impl', { label: 'impl:#2', schema: OK_SCHEMA, isolation: 'worktree' })
  const own = join(s.main, '.claude', 'worktrees', `${RUN_ID}-1`)
  assert.equal(lockedOf(s.repo, s.main, own), true, '作成時に lock されている')
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { status: 'merged', worktree: own } } })}\n`)
  const { prompt, label } = await cleanupPromptOf(2, { status: 'merged', worktree: own }, { cleanupWorktree: own })
  const got = await h.agent(prompt, { label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.deepEqual(got, { ok: true, retained: false, branchSha: '', worktree: 'removed' }, h.logs.join('\n'))
  assert.equal(existsSync(own), false)

  const foreign = foreignLocked(s.repo, s.main, `${RUN_ID}-99`)
  writeFileSync(s.stateFile, `${JSON.stringify({ items: { 2: { status: 'merged', worktree: foreign } } })}\n`)
  const c = await cleanupPromptOf(2, { status: 'merged', worktree: foreign }, { cleanupWorktree: foreign })
  const kept = await h.agent(c.prompt, { label: c.label, phase: 'State', model: 'haiku', effort: 'low', schema: CLEANUP_SCHEMA })
  assert.equal(kept.worktree, 'retained-locked')
  assert.equal(lockedOf(s.repo, s.main, foreign), true, '集合に無い worktree は unlock しない')
})

test('Phase 4 実行仕様の掃除（state:cleanup:#N の remove）と最終スイープ: ランナーが作った lock の worktree だけを unlock してから渡す。--require-missing と実行中の段の worktree は unlock しない', async () => {
  const s = setup({ issue: 2, name: 'pre-existing' })
  const h = hostWithWorktrees(s.repo, s.main)
  for (let i = 0; i < 4; i++) await h.agent('impl', { label: `impl:#${i + 2}`, schema: OK_SCHEMA, isolation: 'worktree' })
  const own = (n) => join(s.main, '.claude', 'worktrees', `${RUN_ID}-${n}`)
  const FAIL = { ok: false, retained: true, worktree: '' }
  const r1 = await h.agent(removeSpec(own(1)), { label: 'state:cleanup:#2', schema: CLEANUP_SCHEMA })
  assert.equal(r1.worktree, 'removed', h.logs.join('\n'))
  assert.equal(existsSync(own(1)), false)
  // --require-missing の結びつけはスクリプトが lock を外さない経路。ホストも外さない
  const req = `${specLine({ v: 1, script: 'worktree-remove.sh', sha256: bundleSha256(SCRIPTS_DIR, 'worktree-remove.sh'), argv: ['remove', '--mode', 'discard', '--path', own(2), '--require-missing'], ret: 'line:WORKTREE_REMOVE_RESULT', fail: FAIL })}\n掃除`
  await h.agent(req, { label: 'state:cleanup:#3', schema: CLEANUP_SCHEMA })
  assert.equal(lockedOf(s.repo, s.main, own(2)), true, '--require-missing では unlock しない')

  const foreign = foreignLocked(s.repo, s.main, `${RUN_ID}-98`)
  const candidates = JSON.stringify([own(3), foreign])
  const sweep = `${specLine({ v: 1, script: 'worktree-remove.sh', sha256: bundleSha256(SCRIPTS_DIR, 'worktree-remove.sh'), argv: ['sweep', '--file', `_/issue-trees/${PARENT}.json`], ret: 'line:WORKTREE_REMOVE_RESULT', stdinHex: Buffer.from(`${candidates}\n`).toString('hex') })}\nスイープ`
  const sw = await h.agent(sweep, { label: 'worktree:sweep', schema: SWEEP_SCHEMA })
  assert.deepEqual(sw.removed, [own(3)], h.logs.join('\n'))
  assert.equal(lockedOf(s.repo, s.main, foreign), true, 'スイープでも集合に無い worktree は unlock しない')
  // スクリプトが残した（discard で汚れている）自分の worktree は、作成時の理由で lock し直す
  writeFileSync(join(own(4), 'dirty.txt'), 'x\n')
  const kept = await h.agent(removeSpec(own(4), 'discard'), { label: 'state:cleanup:#5', schema: CLEANUP_SCHEMA })
  assert.equal(kept.worktree, 'retained-dirty')
  assert.equal(lockedOf(s.repo, s.main, own(4)), true, '残った worktree は lock し直す')
  assert.ok(s.repo.git(s.main, 'worktree', 'list', '--porcelain').includes(`locked claude agent ${RUN_ID}-4 (pid ${process.pid})`))

  // 実行中の隔離の段の worktree（まだエージェントが使っている）は unlock しない
  let during = null
  const busy = makeFakeAdapterModule({
    reply: async (r) => {
      during = await agent2(removeSpec(r.cwd), { label: 'state:cleanup:#9', schema: CLEANUP_SCHEMA })
      return { ok: true }
    },
  })
  const agent2 = createAgentHost({ adapter: busy.createAdapter({}), cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot: s.main, runId: 'wf_0123abcd-777', args: { parent: PARENT }, spawnScript: (f, a, o) => spawnScript(f, a, { ...o, env: gitEnv(s.repo.root) }), createWorktree: lockedWorktreeMaker(s.repo, s.main) } })
  await agent2('impl', { label: 'impl:#9', schema: OK_SCHEMA, isolation: 'worktree' })
  assert.equal(during.worktree, 'retained-locked')
})
const SWEEP_SCHEMA = { type: 'object', required: ['removed'], properties: { removed: { type: 'array', items: { type: 'string' } } } }

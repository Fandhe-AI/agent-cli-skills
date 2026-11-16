// ランナー専用 OpenCode plugin（runner/adapters/opencode-plugin）の単体テスト。
// plugin を node で読み込み、偽の ctx と偽の agent-guard.sh で permission.evaluate の判定を確かめる。
// 確かめること: subagent=true 固定で呼ぶ・allow / deny / 異常終了 / 結果行なしの扱い（fail-closed）・
// allowMerge の有無で MERGE_EXEC_COMMAND の扱いが変わる・目印ファイル・ログにコマンドを書かない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { MERGE_RES } from '../../../skills/implement-issue-tree/runner/adapters/opencode.mjs'

const plugin = (await import(pathToFileURL(join(SKILL_DIR, 'runner', 'adapters', 'opencode-plugin', 'index.js')).href)).default
const SHA = 'a'.repeat(40)
const MERGE_CMD = `HEAD_SHA="${SHA}"; gh pr merge 7 --squash --delete-branch --match-head-commit "$HEAD_SHA"`
const MERGE_TAIL = 'gh pr merge 7 --squash --delete-branch --match-head-commit "$HEAD_SHA"'

function sandbox(guardBody, { mergeRes = [] } = {}) {
  const dir = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-oc-plugin-'))))
  const guardScript = join(dir, 'agent-guard.sh')
  writeFileSync(guardScript, guardBody)
  chmodSync(guardScript, 0o755)
  const options = { guardScript, log: join(dir, 'guard.log'), mergeRes, markerPath: join(dir, 'marker'), nonce: 'nonce-1' }
  return { dir, options, stdinLog: join(dir, 'stdin.log') }
}

async function load(options) {
  let hook = null
  await plugin.setup({ options, permission: { hook: async (name, fn) => { if (name === 'evaluate') hook = fn } } })
  return async (event) => { const e = { action: 'shell', resources: [], ...event }; await hook(e); return e }
}

const allowGuard = (stdinLog) => `#!/bin/bash\ncat >> '${stdinLog}'; echo >> '${stdinLog}'\necho AGENT_GUARD_RESULT allow\n`

test('目印: setup が nonce を markerPath へ書く', async () => {
  const s = sandbox('#!/bin/bash\necho AGENT_GUARD_RESULT allow\n')
  await load(s.options)
  assert.equal(readFileSync(s.options.markerPath, 'utf8'), 'nonce-1')
})

test('subagent=true 固定でガードを呼ぶ。allow は素通し・ログにコマンドを書かない', async () => {
  const s = sandbox('')
  writeFileSync(s.options.guardScript, allowGuard(s.stdinLog))
  const ev = await load(s.options)
  const r = await ev({ resources: ['git status SECRET-TOKEN-xyz'] })
  assert.notEqual(r.effect, 'deny')
  assert.deepEqual(JSON.parse(readFileSync(s.stdinLog, 'utf8').trim()), { command: 'git status SECRET-TOKEN-xyz', subagent: true })
  const log = readFileSync(s.options.log, 'utf8')
  assert.match(log, /\tallow\n/)
  assert.equal(log.includes('SECRET'), false)
})

test('ガードの deny は拒否し、理由コードをログへ残す', async () => {
  const s = sandbox('#!/bin/bash\necho "AGENT_GUARD_RESULT deny force-push"\nexit 2\n')
  const ev = await load(s.options)
  const r = await ev({ resources: ['git push --force'] })
  assert.equal(r.effect, 'deny')
  assert.match(readFileSync(s.options.log, 'utf8'), /deny:force-push/)
})

test('fail-closed: 異常終了・結果行なし・契約外の出力・allow なのに終了コード非 0・ガードが無い・時間切れ無しの設定不備はすべて拒否', async () => {
  for (const body of [
    '#!/bin/bash\nexit 1\n',
    '#!/bin/bash\necho hello\n',
    '#!/bin/bash\necho "AGENT_GUARD_RESULT maybe"\n',
    '#!/bin/bash\necho AGENT_GUARD_RESULT allow\nexit 3\n',
  ]) {
    const s = sandbox(body)
    const ev = await load(s.options)
    assert.equal((await ev({ resources: ['ls'] })).effect, 'deny', body)
  }
  const s = sandbox('#!/bin/bash\necho AGENT_GUARD_RESULT allow\n')
  const missing = await load({ ...s.options, guardScript: join(s.dir, 'nope.sh') })
  assert.equal((await missing({ resources: ['ls'] })).effect, 'deny')
  const noOpts = await load({ ...s.options, log: '' })
  assert.equal((await noOpts({ resources: ['ls'] })).effect, 'deny')
  const badRe = await load({ ...s.options, mergeRes: ['('] })
  assert.equal((await badRe({ resources: ['ls'] })).effect, 'deny')
})

test('allowMerge でない serve では MERGE_EXEC_COMMAND もガードの判定に従う', async () => {
  const s = sandbox('#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n', { mergeRes: [] })
  const ev = await load(s.options)
  assert.equal((await ev({ resources: [MERGE_CMD] })).effect, 'deny')
})

test('allowMerge の serve では MERGE_EXEC_COMMAND の完全一致だけをガードを呼ばずに通す', async () => {
  const s = sandbox('#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n', { mergeRes: [...MERGE_RES] })
  const ev = await load(s.options)
  assert.notEqual((await ev({ resources: [MERGE_CMD] })).effect, 'deny', '完全一致の 1 形')
  assert.match(readFileSync(s.options.log, 'utf8'), /allow-mergeform/)
  for (const bad of [
    `${MERGE_CMD}; gh pr review 7 --approve`,
    `${MERGE_CMD} && gh pr review 7 --approve`,
    `${MERGE_CMD}\ngh pr review 7 --approve`,
    // 代入を除いた後半だけの形は素通しにしない（Codex の --merge-re と同じ完全一致の 1 形だけ）
    MERGE_TAIL,
    'gh pr merge 7 --squash',
    'gh pr merge 7 --squash --admin',
    MERGE_CMD.replace(SHA, 'HEAD'),
    'gh pr review 7 --approve',
  ]) assert.equal((await ev({ resources: [bad] })).effect, 'deny', bad)
})

test('resources のうち 1 つでも拒否なら全体が拒否になる。非 shell の action は触らず、ガードの置き場の編集は拒否', async () => {
  const s = sandbox('#!/bin/bash\ncmd=$(cat)\ncase "$cmd" in *evil*) echo "AGENT_GUARD_RESULT deny merge-guard"; exit 2;; esac\necho AGENT_GUARD_RESULT allow\n')
  const ev = await load(s.options)
  assert.equal((await ev({ resources: ['ls', 'evil cmd'] })).effect, 'deny')
  assert.notEqual((await ev({ resources: ['ls', 'pwd'] })).effect, 'deny')
  assert.notEqual((await ev({ action: 'read', resources: ['/etc/hosts'] })).effect, 'deny')
  assert.notEqual((await ev({ action: 'edit', resources: ['src/a.js'] })).effect, 'deny')
  assert.equal((await ev({ action: 'edit', resources: ['_/iit-runner/x/opencode-guard/y'] })).effect, 'deny')
  assert.equal((await ev({ action: 'shell', resources: 'not-array' })).effect, 'deny')
  assert.equal(existsSync(s.options.log), true)
})

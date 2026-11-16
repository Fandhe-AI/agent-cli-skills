// ランナー専用 OpenCode plugin（runner/adapters/opencode-plugin）の単体テスト。
// plugin を node で読み込み、偽の ctx と偽の agent-guard.sh で permission.evaluate の判定を確かめる。
// 確かめること: subagent=true 固定で呼ぶ・allow / deny / 異常終了 / 結果行なしの扱い（fail-closed）・
// allowMerge の有無で MERGE_EXEC_COMMAND の扱いが変わる・目印ファイル・ログにコマンドを書かない。
// merge-exec の対応づけ: tool.execute.before で全文の完全一致を確かめた呼び出しの後半だけを、同じ呼び出しの
// permission.evaluate で 1 回だけ通す（OpenCode v2.2.7 は permission に代入を落とした後半だけを渡すため）。
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

test('resources のうち 1 つでも拒否なら全体が拒否になる。非 shell の action は触らず、ガードのログの編集は拒否', async () => {
  const s = sandbox('#!/bin/bash\ncmd=$(cat)\ncase "$cmd" in *evil*) echo "AGENT_GUARD_RESULT deny merge-guard"; exit 2;; esac\necho AGENT_GUARD_RESULT allow\n')
  const ev = await load(s.options)
  assert.equal((await ev({ resources: ['ls', 'evil cmd'] })).effect, 'deny')
  assert.notEqual((await ev({ resources: ['ls', 'pwd'] })).effect, 'deny')
  assert.notEqual((await ev({ action: 'read', resources: ['/etc/hosts'] })).effect, 'deny')
  assert.notEqual((await ev({ action: 'edit', resources: ['src/a.js'] })).effect, 'deny')
  assert.equal((await ev({ action: 'edit', resources: [s.options.log] })).effect, 'deny', 'ログ')
  assert.equal((await ev({ action: 'edit', resources: [s.options.markerPath] })).effect, 'deny', '目印')
  assert.equal((await ev({ action: 'shell', resources: 'not-array' })).effect, 'deny')
  assert.equal(existsSync(s.options.log), true)
})

/** permission と tool の hook を両方受け取る。tool の hook が登録されなければ before / after は null。 */
async function loadBoth(options) {
  const h = {}
  await plugin.setup({
    options,
    permission: { hook: async (name, fn) => { h[`permission.${name}`] = fn } },
    tool: { hook: async (name, fn) => { h[`tool.${name}`] = fn } },
  })
  const evaluate = async (event) => { const e = { action: 'shell', resources: [], ...event }; await h['permission.evaluate'](e); return e }
  return { evaluate, before: h['tool.execute.before'] ?? null, after: h['tool.execute.after'] ?? null }
}

// 実測（OpenCode v2.2.7）のイベントの形に合わせる
const CALL = { sessionID: 'ses_1', messageID: 'msg_1', id: 'call_1' }
const toolEv = (command, over = {}) => ({ tool: 'shell', ...CALL, agent: 'build', input: { command }, ...over })
const permEv = (resources, over = {}) => ({ sessionID: CALL.sessionID, agent: 'build', action: 'shell', resources, metadata: {}, source: { type: 'tool', messageID: CALL.messageID, id: CALL.id }, effect: 'allow', ...over })
const MERGE_DENY = '#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n'

test('merge-exec の対応づけ: 全文の完全一致を確かめた呼び出しの後半だけを、同じ呼び出しで 1 回だけ通す', async () => {
  const s = sandbox(MERGE_DENY, { mergeRes: [...MERGE_RES] })
  const p = await loadBoth(s.options)
  assert.equal(typeof p.before, 'function', 'allowMerge の serve は tool.execute.before を登録する')
  await p.before(toolEv(MERGE_CMD))
  const ok = await p.evaluate(permEv([MERGE_TAIL]))
  assert.notEqual(ok.effect, 'deny')
  assert.deepEqual(readFileSync(s.options.log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[1]), ['allow-mergeform'], 'ガードを呼ばない')
  // 同じ記録の 2 回目は通さない（1 回限り）
  assert.equal((await p.evaluate(permEv([MERGE_TAIL]))).effect, 'deny', '2 回目')
})

test('merge-exec の対応づけ: 後半だけの形は、対応する記録が無ければ単独では通さない', async () => {
  const s = sandbox(MERGE_DENY, { mergeRes: [...MERGE_RES] })
  const deny = async (name, setup, ev) => {
    const p = await loadBoth(s.options)
    await setup(p)
    assert.equal((await p.evaluate(ev)).effect, 'deny', name)
  }
  await deny('記録なし', async () => {}, permEv([MERGE_TAIL]))
  await deny('source なし', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL], { source: undefined }))
  await deny('source.type が tool でない', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL], { source: { type: 'other', messageID: CALL.messageID, id: CALL.id } }))
  await deny('別の id', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL], { source: { type: 'tool', messageID: CALL.messageID, id: 'call_2' } }))
  await deny('別の messageID', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL], { source: { type: 'tool', messageID: 'msg_2', id: CALL.id } }))
  await deny('別の sessionID', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL], { sessionID: 'ses_2' }))
  await deny('PR 番号が違う後半', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL.replace('merge 7', 'merge 8')]))
  await deny('resources が 2 件', async (p) => p.before(toolEv(MERGE_CMD)), permEv([MERGE_TAIL, 'gh pr review 7 --approve']))
  await deny('後半の後ろに続きがある', async (p) => p.before(toolEv(MERGE_CMD)), permEv([`${MERGE_TAIL}; gh pr review 7 --approve`]))
  await deny('shell 以外の tool の記録', async (p) => p.before(toolEv(MERGE_CMD, { tool: 'bash_like' })), permEv([MERGE_TAIL]))
  await deny('全文が完全一致しない呼び出し（後ろに続きがある）', async (p) => p.before(toolEv(`${MERGE_CMD}; gh pr review 7 --approve`)), permEv([MERGE_TAIL]))
  await deny('全文が完全一致しない呼び出し（後半だけ）', async (p) => p.before(toolEv(MERGE_TAIL)), permEv([MERGE_TAIL]))
  await deny('一致の後に同じ組で不一致の呼び出しが来た', async (p) => { await p.before(toolEv(MERGE_CMD)); await p.before(toolEv('gh pr merge 7 --squash')) }, permEv([MERGE_TAIL]))
  await deny('tool.execute.after で記録が消えた後', async (p) => { await p.before(toolEv(MERGE_CMD)); await p.after({ ...toolEv(MERGE_CMD), status: 'completed' }) }, permEv([MERGE_TAIL]))
})

test('merge-exec の対応づけ: allowMerge でない serve は tool.execute.before を登録せず、後半の形はガードに従う', async () => {
  const s = sandbox(MERGE_DENY, { mergeRes: [] })
  const p = await loadBoth(s.options)
  assert.equal(p.before, null)
  assert.equal(p.after, null)
  assert.equal((await p.evaluate(permEv([MERGE_TAIL]))).effect, 'deny')
  assert.equal((await p.evaluate(permEv([MERGE_CMD]))).effect, 'deny')
})

test('merge-exec の対応づけ: ctx.tool が無くても setup は通り、後半の形は拒否のまま（fail-closed）', async () => {
  const s = sandbox(MERGE_DENY, { mergeRes: [...MERGE_RES] })
  const ev = await load(s.options)
  assert.equal((await ev(permEv([MERGE_TAIL]))).effect, 'deny')
  assert.notEqual((await ev(permEv([MERGE_CMD]))).effect, 'deny', '全文の 1 形は従来どおり')
})

test('merge-exec の対応づけ: tool.execute.before は壊れたイベントでも例外を出さず、記録しない', async () => {
  const s = sandbox(MERGE_DENY, { mergeRes: [...MERGE_RES] })
  const p = await loadBoth(s.options)
  for (const bad of [null, {}, { tool: 'shell', input: null }, toolEv(MERGE_CMD, { id: undefined }), toolEv(MERGE_CMD, { sessionID: '' }), toolEv(42)]) await p.before(bad)
  assert.equal((await p.evaluate(permEv([MERGE_TAIL]))).effect, 'deny')
})

// MEDIUM-3（監査 e670648）: ガードの置き場の保護。配布物の plugin と同じ PROTECTED_EDIT（`.opencode/(hooks|plugins?)/`・
// `opencode.json(c)`）、実際に使う guardScript と plugin 自身の置き場の realpath（完全一致と配下）、options.protectedPaths
// （アダプタが渡す ~/.config/opencode・ランのログと目印）への書き込みを、edit 系 action と shell の両方で拒否する。
const PLUGIN_REAL = realpathSync(join(SKILL_DIR, 'runner', 'adapters', 'opencode-plugin'))

async function loadAt(options, directory) {
  let hook = null
  await plugin.setup({ options, location: { directory }, permission: { hook: async (name, fn) => { if (name === 'evaluate') hook = fn } } })
  return async (event) => { const e = { action: 'shell', resources: [], ...event }; await hook(e); return e }
}

test('保護: edit 系はガード本体・plugin の置き場・設定ファイル・保護パスへの書き込みを拒否し、他は通す', async () => {
  const s = sandbox('#!/bin/bash\necho AGENT_GUARD_RESULT allow\n')
  const cfgDir = join(s.dir, 'home', '.config', 'opencode')
  const ev = await loadAt({ ...s.options, protectedPaths: [cfgDir] }, s.dir)
  for (const r of [
    s.options.guardScript,
    'agent-guard.sh', // location からの相対で guardScript に解決される
    './sub/../agent-guard.sh',
    join(PLUGIN_REAL, 'index.js'),
    PLUGIN_REAL,
    '.opencode/plugins/agent-guard/index.js',
    '.opencode/plugin/x.js',
    '../.opencode/hooks/agent-guard.sh',
    'opencode.jsonc',
    'sub/OpenCode.JSON',
    join(cfgDir, 'plugins', 'evil.js'),
    join(cfgDir, 'opencode.jsonc'),
  ]) {
    const e = await ev({ action: 'edit', resources: ['src/ok.js', r] })
    assert.equal(e.effect, 'deny', r)
  }
  for (const r of ['src/a.js', `${s.options.guardScript}.bak`, join(s.dir, 'agent-guard.sh.d', 'x'), '.opencode/agents/a.md', 'docs/opencode.md']) {
    assert.notEqual((await ev({ action: 'edit', resources: [r] })).effect, 'deny', r)
  }
  assert.match(readFileSync(s.options.log, 'utf8'), /\tdeny-protected-edit\n/)
})

test('保護: shell からの書き込み（リダイレクト・cp・mv・tee・sed -i 等）は拒否し、読み取り（cat・grep 等）は通す', async () => {
  const s = sandbox('#!/bin/bash\necho AGENT_GUARD_RESULT allow\n')
  const g = s.options.guardScript
  const ev = await loadAt({ ...s.options, protectedPaths: [join(s.dir, 'home', '.config', 'opencode')] }, s.dir)
  for (const c of [
    `echo x > ${g}`,
    `printf 'x' >> ${g}`,
    `cp /tmp/x ${g}`,
    `mv /tmp/x ${join(PLUGIN_REAL, 'index.js')}`,
    `cat /tmp/x | tee ${join(PLUGIN_REAL, 'index.js')}`,
    "sed -i '' 's/deny/allow/' .opencode/plugins/agent-guard/index.js",
    'rm -f .opencode/hooks/agent-guard.sh',
    'ln -sf /bin/true .opencode/hooks/agent-guard.sh',
    'echo {} > opencode.jsonc',
    'mkdir -p ~/.config/opencode/plugins && cp evil.js ~/.config/opencode/plugins/',
    'cat > $HOME/.config/opencode/opencode.jsonc',
    `chmod 000 ${g}`,
    'echo x > agent-guard.sh', // location からの相対
  ]) assert.equal((await ev({ resources: [c] })).effect, 'deny', c)
  for (const c of [
    `cat ${g}`,
    'grep -n deny .opencode/plugins/agent-guard/index.js',
    `head -5 ${join(PLUGIN_REAL, 'index.js')} 2>/dev/null`,
    'ls -la ~/.config/opencode',
    `wc -l ${g} && git diff --stat`,
    'echo hello > out.txt',
    'git add .opencode/plugins/x.js && git commit -m "opencode.jsonc の説明を直す"',
    'if test -f opencode.jsonc; then cat opencode.jsonc; fi',
  ]) assert.notEqual((await ev({ resources: [c] })).effect, 'deny', c)
})

// ランナーの 2 つのガード入口（Codex の PreToolUse hook = runner/adapters/codex-hook.sh、OpenCode のランナー専用 plugin =
// runner/adapters/opencode-plugin/index.js）が、同じガード出力に対して同じ判定・同じログのコード・同じ拒否の文言になることの検査。
//
// 両者は agent-guard.sh を「常に subagent=true」で呼ぶ同じ意味の写しで、アダプタはログの行数でガードの欠落を数える。
// 片方だけ文言やコードを変えると、ログを読む側（人・agent-host のレポート）がツールごとに読み分けることになるため、
// 共通のコード（allow・allow-mergeform・deny-guard-missing・deny-error・deny-noresult・deny:<理由>）と文言をここで縛る。
// allowMerge の素通し: コマンド全体が MERGE_EXEC_COMMAND に完全一致した 1 形は、両者ともガードを呼ばずに allow-mergeform で通す
// （Codex は --merge-re、plugin は mergeRes）。OpenCode v2.2.7 は permission に代入を落とした後半だけを渡すため、plugin は
// allowMerge の serve でだけ tool.execute.before で全文の完全一致を確かめた呼び出しを記録し、同じ呼び出し（sessionID・
// messageID・id の組）の後半を 1 回限り通す。後半だけの形は、対応する記録が無ければ両者ともガードに回して拒否する。
// ガードの判定そのものの写しも、#845 後の配布物の agent-guard.sh（init-codex / init-opencode の写し）で両者が一致することを確かめる。
// 合わせて、両アダプタの agent-guard.sh の探索（runner/lib/guard-script.mjs）と見つからないときの prereq の文言が共通であることも確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { MERGE_EXEC_COMMAND } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'
import { GUARD_SCRIPT_MISSING, findGuardScript } from '../../../skills/implement-issue-tree/runner/lib/guard-script.mjs'
import { MERGE_RES } from '../../../skills/implement-issue-tree/runner/adapters/opencode.mjs'

const HOOK = join(SKILL_DIR, 'runner', 'adapters', 'codex-hook.sh')
const plugin = (await import(pathToFileURL(join(SKILL_DIR, 'runner', 'adapters', 'opencode-plugin', 'index.js')).href)).default
const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-guard-parity-'))))
const SHA = 'b'.repeat(40)
const MERGE_CMD = `HEAD_SHA="${SHA}"; gh pr merge 9 --squash --delete-branch --match-head-commit "$HEAD_SHA"`

let seq = 0
function makeGuard(body) {
  const dir = join(root, `g${++seq}`)
  mkdirSync(dir)
  const guard = join(dir, 'agent-guard.sh')
  if (body !== null) {
    writeFileSync(guard, body)
    chmodSync(guard, 0o755)
  }
  return { dir, guard }
}

const codes = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => {
  assert.match(l, /^\d+\t\S+$/, 'ログ 1 行は <epoch 秒>\\t<コード>')
  return l.split('\t')[1]
})

// 配布物の agent-guard.sh（4 写しは同一。asset-sync のテストが縛る）。ランナーが既定で探す 2 つを使う
const REAL_GUARDS = ['init-codex', 'init-opencode'].map((s) => join(SKILL_DIR, '..', s, 'assets', 'hooks', 'agent-guard.sh'))

/** 偽ガードの本文（文字列・null）か、{ path } で既存のガードを指す。ログ用のディレクトリと組で返す。 */
function guardFor(g) {
  if (g && typeof g === 'object') {
    const dir = join(root, `g${++seq}`)
    mkdirSync(dir)
    return { dir, guard: g.path }
  }
  return makeGuard(g)
}

/** codex-hook.sh を 1 回呼び、{ deny, message, codes } を返す。 */
function viaHook(guardBody, command, { merge = false } = {}) {
  const { dir, guard } = guardFor(guardBody)
  const log = join(dir, 'hook.log')
  const args = [HOOK, '--guard', guard, '--log', log, ...(merge ? ['--merge-re', MERGE_EXEC_COMMAND.source] : [])]
  const r = spawnSync('bash', args, { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout.trim()
  const reason = out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecisionReason
  return { deny: out !== '', message: reason, codes: codes(log) }
}

// OpenCode v2.2.7 の実測のイベントの形（runner-opencode-plugin.test.mjs と同じ）
const CALL = { sessionID: 'ses_1', messageID: 'msg_1', id: 'call_1' }

/**
 * plugin の evaluate を呼び、{ deny, message, codes } を返す（最後の evaluate の判定。codes はログ全体）。
 * 実際の serve と同じく tool の hook も渡す。bind を与えると、先に tool.execute.before へその全文を同じ呼び出しの組で渡す。
 * times は同じ setup で同じ permission を続けて評価する回数（記録が 1 回限りかを見る）。
 */
async function viaPlugin(guardBody, command, { merge = false, bind = null, times = 1 } = {}) {
  const { dir, guard } = guardFor(guardBody)
  const log = join(dir, 'plugin.log')
  const h = {}
  await plugin.setup({
    options: { guardScript: guard, log, mergeRes: merge ? [...MERGE_RES] : [] },
    permission: { hook: async (n, fn) => { h[`permission.${n}`] = fn } },
    tool: { hook: async (n, fn) => { h[`tool.${n}`] = fn } },
  })
  if (bind !== null) {
    assert.equal(typeof h['tool.execute.before'], 'function', 'allowMerge の serve は tool.execute.before を登録する')
    // 完全一致しない全文は tool.execute.before がガードに回し、拒否なら throw する（その呼び出しは permission まで進まない）
    try {
      await h['tool.execute.before']({ tool: 'shell', ...CALL, agent: 'build', input: { command: bind } })
    } catch (err) {
      return { deny: true, message: err.message, codes: codes(log) }
    }
  }
  let e = null
  for (let i = 0; i < times; i++) {
    e = { sessionID: CALL.sessionID, agent: 'build', action: 'shell', resources: [command], metadata: {}, source: { type: 'tool', messageID: CALL.messageID, id: CALL.id }, effect: 'allow' }
    await h['permission.evaluate'](e)
  }
  return { deny: e.effect === 'deny', message: e.effect === 'deny' ? e.message : null, codes: codes(log) }
}

const CASES = [
  ['allow', '#!/bin/bash\necho AGENT_GUARD_RESULT allow\n', 'git status', { deny: false, code: 'allow' }],
  ['理由つき deny', '#!/bin/bash\necho "AGENT_GUARD_RESULT deny force-push"\nexit 2\n', 'git push -f', { deny: true, code: 'deny:force-push', message: 'iit-runner: ガードの判定により拒否した（deny:force-push）' }],
  ['理由なし deny', '#!/bin/bash\necho "AGENT_GUARD_RESULT deny"\nexit 2\n', 'x', { deny: true, code: 'deny:unknown', message: 'iit-runner: ガードの判定により拒否した（deny:unknown）' }],
  ['契約外の理由（JSON を壊し得る文字）', '#!/bin/bash\necho \'AGENT_GUARD_RESULT deny a"b\'\nexit 2\n', 'x', { deny: true, code: 'deny-noresult', message: 'iit-runner: ガードの結果を得られないため拒否した' }],
  ['allow なのに異常終了', '#!/bin/bash\necho AGENT_GUARD_RESULT allow\nexit 3\n', 'x', { deny: true, code: 'deny-error', message: 'iit-runner: ガードが異常終了したため拒否した' }],
  ['結果行なし', '#!/bin/bash\necho hello\n', 'x', { deny: true, code: 'deny-noresult', message: 'iit-runner: ガードの結果を得られないため拒否した' }],
  ['ガードが無い', null, 'x', { deny: true, code: 'deny-guard-missing', message: 'iit-runner: ガードが見つからないため拒否した' }],
]

for (const [name, body, cmd, want] of CASES) {
  test(`同じガード出力に同じ判定・コード・文言（${name}）`, async () => {
    const h = viaHook(body, cmd)
    const p = await viaPlugin(body, cmd)
    assert.deepEqual(h, p, 'hook と plugin の結果')
    assert.equal(h.deny, want.deny)
    assert.deepEqual(h.codes, [want.code])
    if (want.deny) assert.equal(h.message, want.message)
  })
}

test('allowMerge: 全文の完全一致は両者とも、ガードを呼ばずに allow-mergeform で通す。後半だけ・続きつきは記録が無ければガードに回る', async () => {
  const denyAll = '#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n'
  for (const [cmd, wantDeny] of [
    [MERGE_CMD, false],
    ['gh pr merge 9 --squash --delete-branch --match-head-commit "$HEAD_SHA"', true],
    [`${MERGE_CMD}; gh pr review 9 --approve`, true],
  ]) {
    const h = viaHook(denyAll, cmd, { merge: true })
    const p = await viaPlugin(denyAll, cmd, { merge: true })
    assert.deepEqual(h, p, cmd)
    assert.equal(h.deny, wantDeny, cmd)
    assert.deepEqual(h.codes, [wantDeny ? 'deny:merge-guard' : 'allow-mergeform'], cmd)
  }
})

test('allowMerge（plugin の対応づけ）: 全文の一致を記録した呼び出しの後半は、Codex が全文を受けたときと同じく allow-mergeform。記録は 1 回限り', async () => {
  const denyAll = '#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n'
  const tail = MERGE_CMD.slice(MERGE_CMD.indexOf('; ') + 2)
  // Codex は全文を受ける。OpenCode は記録つきで後半を受ける。どちらも同じ結果になる
  const h = viaHook(denyAll, MERGE_CMD, { merge: true })
  const p = await viaPlugin(denyAll, tail, { merge: true, bind: MERGE_CMD })
  assert.deepEqual(h, p)
  assert.deepEqual(p.codes, ['allow-mergeform'])
  // 同じ記録で 2 回目の permission は通さず、ガードに回る
  const twice = await viaPlugin(denyAll, tail, { merge: true, bind: MERGE_CMD, times: 2 })
  assert.equal(twice.deny, true)
  assert.deepEqual(twice.codes, ['allow-mergeform', 'deny:merge-guard'])
  // 全文が完全一致しない呼び出し（続きつき）の記録では、後半を通さない
  const tailed = await viaPlugin(denyAll, tail, { merge: true, bind: `${MERGE_CMD}; gh pr review 9 --approve` })
  assert.equal(tailed.deny, true)
  assert.deepEqual(tailed.codes, ['deny:merge-guard'])
  // allowMerge でない serve では、記録の経路そのものが無い
  const off = await viaPlugin(denyAll, tail)
  assert.equal(off.deny, true)
  assert.deepEqual(off.codes, ['deny:merge-guard'])
})

// #845 後の配布物の agent-guard.sh の判定（probe で実測した値）を、両アダプタが同じコード・同じ文言で写すこと。
// 認証情報の読み出しとマージキュー投入は #845 より前のガードでは allow だった（ランナーは rules / permissions だけで止めていた）。
const REAL_CASES = [
  ['git status', {}, 'allow'],
  ['gh pr view 9 --json state', {}, 'allow'],
  ['gh auth token', {}, 'deny:credential-read'],
  ['printenv GH_TOKEN', {}, 'deny:credential-read'],
  ['git credential fill', {}, 'deny:credential-read'],
  ['cat ~/.codex/auth.json', {}, 'deny:credential-read'],
  ['cd ~/.config/gh;cat hosts.yml', {}, 'deny:credential-read'],
  ["gh api graphql -f query='mutation { enqueuePullRequest(input:{}) { clientMutationId } }'", {}, 'deny:merge-guard'],
  ['git push --force origin x', {}, 'deny:force-push'],
  [MERGE_CMD, {}, 'deny:merge-guard'],
  [MERGE_CMD, { merge: true }, 'allow-mergeform'],
  [MERGE_CMD.slice(MERGE_CMD.indexOf('; ') + 2), { merge: true }, 'deny:merge-guard'],
]

for (const path of REAL_GUARDS) {
  test(`配布物の agent-guard.sh（${path.split('/skills/')[1]}）に対しても両者の判定・コード・文言が同じ`, async () => {
    for (const [cmd, opt, code] of REAL_CASES) {
      const h = viaHook({ path }, cmd, opt)
      const p = await viaPlugin({ path }, cmd, opt)
      assert.deepEqual(h, p, cmd)
      assert.deepEqual(h.codes, [code], cmd)
      assert.equal(h.deny, code.startsWith('deny'), cmd)
      if (h.deny) assert.equal(h.message, `iit-runner: ガードの判定により拒否した（${code}）`, cmd)
    }
  })
}

test('agent-guard.sh の探索: 明示の guardScript はそれだけを見る・既定は init-codex / init-opencode の配布物と導入先', () => {
  const base = join(root, 'find')
  const skillDir = join(base, 'skills', 'implement-issue-tree')
  const mainRoot = join(base, 'repo')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(mainRoot, { recursive: true })
  assert.equal(findGuardScript({ skillDir, mainRoot }), null)
  const put = (p) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '#!/bin/bash\n'); return p }
  const oc = put(join(mainRoot, '.opencode', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), oc, '導入先（.opencode/hooks）')
  const cx = put(join(mainRoot, '.codex', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), cx, '.codex/hooks が .opencode/hooks より先')
  const dist = put(join(base, 'skills', 'init-opencode', 'assets', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), dist, 'スキルと同じ置き場の配布物が導入先より先')
  // 明示した場所に無ければ、他の写しへ倒さず null（= prereq）
  assert.equal(findGuardScript({ toolConfig: { guardScript: join(base, 'nope.sh') }, skillDir, mainRoot }), null)
  assert.equal(findGuardScript({ toolConfig: { guardScript: cx }, skillDir, mainRoot }), cx)
  // ディレクトリはガードとして扱わない
  assert.equal(findGuardScript({ toolConfig: { guardScript: base }, skillDir, mainRoot }), null)
  assert.match(GUARD_SCRIPT_MISSING, /init-codex/)
  assert.match(GUARD_SCRIPT_MISSING, /init-opencode/)
  assert.match(GUARD_SCRIPT_MISSING, /toolConfig\.<tool>\.guardScript/)
})

// ランナーの 2 つのガード入口（Codex の PreToolUse hook = runner/adapters/codex-hook.sh、OpenCode のランナー専用 plugin =
// runner/adapters/opencode-plugin/index.js）が、同じガード出力に対して同じ判定・同じログのコード・同じ拒否の文言になることの検査。
//
// 両者は agent-guard.sh を「常に subagent=true」で呼ぶ同じ意味の写しで、アダプタはログの行数でガードの欠落を数える。
// 片方だけ文言やコードを変えると、ログを読む側（人・agent-host のレポート）がツールごとに読み分けることになるため、
// 共通のコード（allow・allow-mergeform・deny-guard-missing・deny-error・deny-noresult・deny:<理由>）と文言をここで縛る。
// allowMerge の素通しは両者とも MERGE_EXEC_COMMAND の完全一致の 1 形だけ（Codex は --merge-re、plugin は mergeRes）。
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

/** codex-hook.sh を 1 回呼び、{ deny, message, codes } を返す。 */
function viaHook(guardBody, command, { merge = false } = {}) {
  const { dir, guard } = makeGuard(guardBody)
  const log = join(dir, 'hook.log')
  const args = [HOOK, '--guard', guard, '--log', log, ...(merge ? ['--merge-re', MERGE_EXEC_COMMAND.source] : [])]
  const r = spawnSync('bash', args, { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout.trim()
  const reason = out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecisionReason
  return { deny: out !== '', message: reason, codes: codes(log) }
}

/** plugin の evaluate を 1 回呼び、{ deny, message, codes } を返す。 */
async function viaPlugin(guardBody, command, { merge = false } = {}) {
  const { dir, guard } = makeGuard(guardBody)
  const log = join(dir, 'plugin.log')
  let hook = null
  await plugin.setup({ options: { guardScript: guard, log, mergeRes: merge ? [...MERGE_RES] : [] }, permission: { hook: async (n, fn) => { if (n === 'evaluate') hook = fn } } })
  const e = { action: 'shell', resources: [command] }
  await hook(e)
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

test('allowMerge: 両者とも MERGE_EXEC_COMMAND の完全一致だけを、ガードを呼ばずに allow-mergeform で通す', async () => {
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

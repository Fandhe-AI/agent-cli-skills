// ランナーのガード入口（Codex の PreToolUse hook = runner/adapters/codex-hook.sh）の検査。
//
// hook は agent-guard.sh を「常に subagent=true」で呼ぶ写しで、アダプタはログの行数でガードの欠落を数える。
// ログのコード（allow・allow-mergeform・deny-guard-missing・deny-error・deny-noresult・deny:<理由>）と拒否の文言をここで縛る。
// allowMerge の素通し: コマンド全体が MERGE_EXEC_COMMAND に完全一致した 1 形は、ガードを呼ばずに allow-mergeform で通す（--merge-re）。
// ガードの判定そのものも、#845 後の配布物の agent-guard.sh（init-codex の写し）で確かめる。
// 合わせて、agent-guard.sh の探索（runner/lib/guard-script.mjs）と見つからないときの prereq の文言も確かめる。
// OpenCode のランナー専用 plugin との一致の検査は、OpenCode を外した（Issue #853）ため持たない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackTmp } from './lib/tmp-track.mjs'
import { SKILL_DIR } from './lib/paths.mjs'
import { MERGE_EXEC_COMMAND } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'
import { GUARD_SCRIPT_MISSING, findGuardScript } from '../../../skills/implement-issue-tree/runner/lib/guard-script.mjs'

const HOOK = join(SKILL_DIR, 'runner', 'adapters', 'codex-hook.sh')
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

// 配布物の agent-guard.sh（写しは同一。asset-sync のテストが縛る）。ランナーが既定で探すものを使う
const REAL_GUARDS = ['init-codex'].map((s) => join(SKILL_DIR, '..', s, 'assets', 'hooks', 'agent-guard.sh'))

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
  test(`ガード出力に対する判定・コード・文言（${name}）`, () => {
    const h = viaHook(body, cmd)
    assert.equal(h.deny, want.deny)
    assert.deepEqual(h.codes, [want.code])
    if (want.deny) assert.equal(h.message, want.message)
  })
}

test('allowMerge: 全文の完全一致は、ガードを呼ばずに allow-mergeform で通す。後半だけ・続きつきはガードに回る', () => {
  const denyAll = '#!/bin/bash\necho "AGENT_GUARD_RESULT deny merge-guard"\nexit 2\n'
  for (const [cmd, wantDeny] of [
    [MERGE_CMD, false],
    ['gh pr merge 9 --squash --delete-branch --match-head-commit "$HEAD_SHA"', true],
    [`${MERGE_CMD}; gh pr review 9 --approve`, true],
  ]) {
    const h = viaHook(denyAll, cmd, { merge: true })
    assert.equal(h.deny, wantDeny, cmd)
    assert.deepEqual(h.codes, [wantDeny ? 'deny:merge-guard' : 'allow-mergeform'], cmd)
  }
})

// #845 後の配布物の agent-guard.sh の判定（probe で実測した値）を、hook が同じコード・同じ文言で写すこと。
// 認証情報の読み出しとマージキュー投入は #845 より前のガードでは allow だった。
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
  test(`配布物の agent-guard.sh（${path.split('/skills/')[1]}）に対する hook の判定・コード・文言`, () => {
    for (const [cmd, opt, code] of REAL_CASES) {
      const h = viaHook({ path }, cmd, opt)
      assert.deepEqual(h.codes, [code], cmd)
      assert.equal(h.deny, code.startsWith('deny'), cmd)
      if (h.deny) assert.equal(h.message, `iit-runner: ガードの判定により拒否した（${code}）${HINTS[code] ?? ''}`, cmd)
    }
  })
}

// 理由コードごとの言い直しの手がかり（Phase 3 で、モデルが理由コードだけでは原因を特定できず中止した 2 つ）。
// 文言はここで固定する（手がかりは言い直しの方法だけで、止められた操作を別の綴りで迂回しないことを添える）。
const HINTS = {
  'deny:obfuscated': "。手がかり: 単一引用符の文字列の末尾に $ を置かない（正規表現は全体を括弧で包み、'(…$)' の形にする）。$'…' と $IFS は使わない。止められた操作そのものを別の綴りで迂回しない。",
  'deny:credential-read': '。手がかり: 名前に TOKEN・SECRET・PASSWORD・KEY などを含む変数は、展開も表示もしない。件数などは、そうした語を含まない名前（例: hits）の変数に入れる。止められた操作そのものを別の綴りで迂回しない。',
}

// 手がかりの対の実測: 左は配布物のガードが該当の理由で止める形、右は手がかりどおりに言い直した形（ガードは allow）。
const HINT_PAIRS = [
  ['deny:obfuscated', `pat='(token|secret)$'; n=$(grep -cE "$pat" f); echo "$n"`, `pat='((token|secret)$)'; n=$(grep -cE "$pat" f); echo "$n"`],
  ['deny:obfuscated', String.raw`n=$(git diff | grep -cE '^\+.*foo$'); echo $n`, String.raw`n=$(git diff | grep -cE '(^\+.*foo$)'); echo $n`],
  ['deny:credential-read', 'TOKEN_HITS=$(grep -c token f); echo $TOKEN_HITS', 'hits=$(grep -c token f); echo $hits'],
]

test('拒否の文言: obfuscated と credential-read には言い直しの手がかりを 1 文足す（hook の JSON）', () => {
  for (const [code, hint] of Object.entries(HINTS)) {
    assert.ok(hint.includes('止められた操作そのものを別の綴りで迂回しない'), code)
    assert.ok(!/["\\\u0000-\u001f]/.test(hint), `${code}: JSON に埋めるため " と \\ と制御文字を含めない`)
    const body = `#!/bin/bash\necho "AGENT_GUARD_RESULT deny ${code.slice(5)}"\nexit 2\n`
    const want = `iit-runner: ガードの判定により拒否した（${code}）${hint}`
    const h = viaHook(body, 'x')
    assert.equal(h.message, want, 'hook（JSON.parse 後の permissionDecisionReason）')
  }
  // 手がかりを持たない理由は従来どおり理由コードだけ
  const plain = viaHook('#!/bin/bash\necho "AGENT_GUARD_RESULT deny no-verify"\nexit 2\n', 'x')
  assert.equal(plain.message, 'iit-runner: ガードの判定により拒否した（deny:no-verify）')
})

for (const path of REAL_GUARDS) {
  test(`手がかりは配布物の agent-guard.sh（${path.split('/skills/')[1]}）に対して正しい: 止められる形は該当の理由で deny、言い直した形は allow`, () => {
    for (const [code, bad, good] of HINT_PAIRS) {
      const hb = viaHook({ path }, bad)
      assert.deepEqual(hb.codes, [code], bad)
      assert.equal(hb.message, `iit-runner: ガードの判定により拒否した（${code}）${HINTS[code]}`, bad)
      const hg = viaHook({ path }, good)
      assert.deepEqual(hg.codes, ['allow'], good)
    }
  })
}

test('agent-guard.sh の探索: 明示の guardScript はそれだけを見る・既定は init-codex の配布物と導入先', () => {
  const base = join(root, 'find')
  const skillDir = join(base, 'skills', 'implement-issue-tree')
  const mainRoot = join(base, 'repo')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(mainRoot, { recursive: true })
  assert.equal(findGuardScript({ skillDir, mainRoot }), null)
  const put = (p) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, '#!/bin/bash\n'); return p }
  put(join(mainRoot, '.opencode', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), null, '.opencode/hooks は探索先に無い')
  const cx = put(join(mainRoot, '.codex', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), cx, '導入先（.codex/hooks）')
  const dist = put(join(base, 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh'))
  assert.equal(findGuardScript({ skillDir, mainRoot }), dist, 'スキルと同じ置き場の配布物が導入先より先')
  // 明示した場所に無ければ、他の写しへ倒さず null（= prereq）
  assert.equal(findGuardScript({ toolConfig: { guardScript: join(base, 'nope.sh') }, skillDir, mainRoot }), null)
  assert.equal(findGuardScript({ toolConfig: { guardScript: cx }, skillDir, mainRoot }), cx)
  // ディレクトリはガードとして扱わない
  assert.equal(findGuardScript({ toolConfig: { guardScript: base }, skillDir, mainRoot }), null)
  assert.match(GUARD_SCRIPT_MISSING, /init-codex/)
  assert.match(GUARD_SCRIPT_MISSING, /toolConfig\.<tool>\.guardScript/)
})

// Review ループの fix が commitFailed で終端するときの worktree の扱い（Issue #731・PR #733 の Bugbot 指摘）の回帰テスト。
//  1. 旧 worktree の破棄は --expect-branch つき（on-branch だけ消す）。前回 fix の detached な worktree は唯一のコミットを持ち得るので消させない。
//  2. Recover が引き取る新しい detached fix worktree は使い捨て（fix-terminal）として記録・案内しない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScript, BASE_ARGS } from './lib/stub-run.mjs'

const SHA = 'c'.repeat(40)

async function run(extra = () => undefined) {
  let reviews = 0
  let fixes = 0
  return runScript({
    args: BASE_ARGS,
    override: (label, opts, prompt) => {
      const e = extra(label, opts, prompt)
      if (e !== undefined) return e
      if (label === 'review:#2') { reviews++; return { state: 'needs-fix', highestSeverity: 'high', summary: '指摘あり', worktreePath: '/repo/wt/r2' } }
      if (label === 'fix:#2') {
        fixes++
        return fixes === 1
          ? { pushed: false, summary: 'fixed', worktreePath: '/repo/wt/f2a' }
          : { pushed: false, commitFailed: true, summary: 'ブランチ反映失敗 HEAD ' + SHA, worktreePath: '/repo/wt/f2b' }
      }
      return undefined
    },
  })
}

test('commitFailed 終端: 旧 worktree は --expect-branch つきの discard で渡し、新しい detached fix worktree を使い捨てとして記録しない', async () => {
  const { calls, logs, result } = await run()
  assert.equal(result.done.find((r) => r.issue === 2).status, 'failed')
  const writes = calls.filter((c) => c.opts.label.startsWith('state:')).map((c) => c.prompt)
  const cleanup = writes.filter((p) => p.includes('/repo/wt/f2a') && p.includes('worktree-remove.sh') && p.includes('discard'))
  assert.ok(cleanup.length >= 1, '旧 detached worktree の discard 呼び出しがない')
  for (const p of cleanup) assert.ok(p.includes('--expect-branch') && p.includes('feat/2-x'), '--expect-branch <branch> が付いていない')
  assert.ok(!logs.some((l) => l.includes('fix-terminal') && l.includes('/repo/wt/f2b')), '新しい detached worktree を fix-terminal として記録してはならない')
  assert.ok(!logs.some((l) => /^\s+#2 \(fix-terminal\): \/repo\/wt\/f2b/.test(l)), '終了時ログが新しい worktree を使い捨てとして案内してはならない')
})

const warnLine = (logs, ...needles) => logs.find((l) => l.includes('⚠️ issue #2:') && needles.every((n) => l.includes(n)))

test('commitFailed 終端 (a): 状態書込み失敗は新旧パスと HEAD sha を警告と失敗記録に出す（Issue #743）', async () => {
  const { logs, result } = await run((label, _o, prompt) =>
    label === 'state:update:#2' && prompt.includes('/repo/wt/f2b') ? { ok: false } : undefined)
  assert.ok(warnLine(logs, '状態の書込みに失敗', '/repo/wt/f2b', '/repo/wt/f2a', SHA), '警告に新旧パスと sha がない')
  const note = result.done.find((r) => r.issue === 2).note
  for (const n of ['状態の書込みに失敗', '/repo/wt/f2b', '/repo/wt/f2a', SHA]) assert.ok(note.includes(n), `note に ${n} がない`)
})

test('commitFailed 終端 (b): 旧 worktree が保持されたら旧パスとブランチを警告と失敗記録に出す（Issue #743）', async () => {
  const { logs, result } = await run((label, _o, prompt) =>
    label.startsWith('state:cleanup:#2') && prompt.includes('/repo/wt/f2a') ? { ok: false, retained: true, worktree: 'retained-locked' } : undefined)
  assert.ok(warnLine(logs, '削除を確認できない', '/repo/wt/f2a', 'feat/2-x', '/repo/wt/f2b'), '警告に旧パスとブランチがない')
  const note = result.done.find((r) => r.issue === 2).note
  for (const n of ['/repo/wt/f2a', 'feat/2-x']) assert.ok(note.includes(n), `note に ${n} がない`)
})

test('commitFailed 終端 対照: 書込み成功かつ旧を削除できたら追記しない（Issue #743）', async () => {
  const { logs, result } = await run((label) =>
    label.startsWith('state:cleanup:#2') ? { ok: true, retained: false, worktree: 'removed' } : undefined)
  for (const n of ['状態の書込みに失敗', '削除を確認できない']) {
    assert.ok(!logs.some((l) => l.includes(n)), `ログに ${n} が出ている`)
    assert.ok(!result.done.find((r) => r.issue === 2).note.includes(n), `note に ${n} が出ている`)
  }
})

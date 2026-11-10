// Review ループの fix が commitFailed で終端するときの worktree の扱い（Issue #731・PR #733 の Bugbot 指摘）の回帰テスト。
//  1. 旧 worktree の破棄は --expect-branch つき（on-branch だけ消す）。前回 fix の detached な worktree は唯一のコミットを持ち得るので消させない。
//  2. Recover が引き取る新しい detached fix worktree は使い捨て（fix-terminal）として記録・案内しない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScript, BASE_ARGS } from './lib/stub-run.mjs'

async function run() {
  let reviews = 0
  let fixes = 0
  return runScript({
    args: BASE_ARGS,
    override: (label) => {
      if (label === 'review:#2') { reviews++; return { state: 'needs-fix', highestSeverity: 'high', summary: '指摘あり', worktreePath: '/repo/wt/r2' } }
      if (label === 'fix:#2') {
        fixes++
        return fixes === 1
          ? { pushed: false, summary: 'fixed', worktreePath: '/repo/wt/f2a' }
          : { pushed: false, commitFailed: true, summary: 'ブランチ反映失敗', worktreePath: '/repo/wt/f2b' }
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

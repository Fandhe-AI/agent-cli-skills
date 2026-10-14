// implement が返した branch の受理ゲート（implBranchViolation）の回帰テスト。
//
// 実ランで、implement が命名規約 <type>/<issueNumber>-<short-name> のブランチを作らず worktree の既定ブランチ
// （worktree-wf_…-37）のまま返した。従来のゲートは文字種（isValidBranchName）だけで、このブランチ名も通ったため Review・push・PR 作成
// まで進み、後段の checkPrBinding で初めて blocked になった（命名違反のリモートブランチと、ホストが追跡できない PR が残った）。
// 契約: Review・push より前に branchMatchesIssue まで検証し、通らなければ push も PR 作成もせず blocked で止める。
// 状態ファイルへ違反 branch を書かない（再実行が savedBranchMismatch で詰まらないように）。worktree は台帳に載せ、自動削除しない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importDefinitions, runScript, BASE_ARGS, source } from './lib/stub-run.mjs'

globalThis.args = { parent: 1, skillDir: '/opt/skills/implement-issue-tree' }
const m = await importDefinitions(['implBranchViolation', 'sha256Hex', 'canonicalJson'], 'impl-branch-guard')

test('implBranchViolation: 命名規約に合う branch は通る', () => {
  assert.equal(m.implBranchViolation('feat/628-x', 628), '')
  assert.equal(m.implBranchViolation('docs/627-testing-md-measured', 627), '')
  assert.equal(m.implBranchViolation('fix/2-a/b.c', 2), '')
})

test('implBranchViolation: worktree の既定ブランチ名・別イシューの番号・番号の前方一致・大文字の type を弾く', () => {
  assert.match(m.implBranchViolation('worktree-wf_ccc43988-8bf-37', 628), /命名規約/)
  assert.match(m.implBranchViolation('feat/627-x', 628), /命名規約/)
  assert.match(m.implBranchViolation('feat/6280-x', 628), /命名規約/)
  assert.match(m.implBranchViolation('Feat/628-x', 628), /命名規約/)
})

test('implBranchViolation: 文字種が不正・空・非文字列は「不正」で弾く', () => {
  for (const bad of ['', undefined, null, 'feat/628-x;rm', 'feat/..628-x', 5]) assert.match(m.implBranchViolation(bad, 628), /不正/, String(bad))
})

const violating = (n) => `worktree-wf_test-${n}`
const stateWrites = (calls) => calls.filter((c) => c.opts.label.startsWith('state:')).map((c) => c.prompt)
// 違反名が branch / worktree の値として書かれていないこと（note の説明文に名前が出るのは可）
const wroteAsBranch = (prompt, name) => new RegExp(`"(branch|worktree)":\\s*"[^"]*${name}`).test(prompt)

test('通常経路: 命名違反の branch は Review・push・PR 作成を起動せず blocked で止まり、状態へ branch を書かない', async () => {
  const { result, calls } = await runScript({
    args: BASE_ARGS,
    override: (label) => (label === 'impl:#2' ? { branch: violating(2), summary: 's', worktreePath: '/repo/wt/2' } : undefined),
  })
  const labels = calls.map((c) => c.opts.label)
  assert.ok(labels.includes('impl:#2'))
  for (const l of labels) assert.ok(!/^(review|security-review|fix|pr-create|pr-bind|merge):#2/.test(l), `起動してはならない: ${l}`)
  const writes = stateWrites(calls)
  assert.ok(writes.length > 0)
  for (const w of writes) assert.ok(!wroteAsBranch(w, violating(2)), '違反 branch を状態ファイルへ書いてはならない')
  assert.ok(writes.some((w) => w.includes('blocked') && w.includes('命名規約')), 'blocked と理由を書く')
  const entry = result.done.find((r) => r.issue === 2)
  assert.equal(entry.status, 'blocked')
  assert.match(entry.note, /命名規約/)
  assert.equal(entry.worktree, '/repo/wt/2')
  assert.equal(entry.pr, undefined)
})

test('blocked は halt を数えない（違反が 3 イシュー連続しても新規着手を止めない）', async () => {
  const { result } = await runScript({
    args: BASE_ARGS,
    leaves: [2, 3, 4, 5],
    override: (label) => {
      const n = Number(/#(\d+)/.exec(label)?.[1])
      if (label.startsWith('impl:#') && n !== 5) return { branch: violating(n), summary: 's', worktreePath: `/repo/wt/${n}` }
      return undefined
    },
  })
  assert.equal(result.halted, null, 'halt してはならない')
  assert.deepEqual(result.done.filter((r) => r.note && /命名規約/.test(r.note)).map((r) => r.issue).sort(), [2, 3, 4])
  assert.ok(result.done.some((r) => r.issue === 5), '4 件目も着手された')
})

test('回復経路: 回復 Implement が命名違反の branch を返しても同じゲートで止まる', async () => {
  const item = { status: 'failed', branch: 'feat/2-x', worktree: '/repo/wt/old' }
  const hashes = { 2: m.sha256Hex(m.canonicalJson(item)) }
  const keysSha = m.sha256Hex(m.canonicalJson(Object.keys(hashes).sort()))
  const { result, calls } = await runScript({
    args: BASE_ARGS,
    override: (label) => {
      if (label === 'state:load') return { ok: true, fileExisted: true, items: { 2: item }, highWaterBytes: 0, highWaterVersion: 0 }
      if (label === 'state:load-verify') return { fileExists: true, hashes, keysSha256: keysSha, keysCount: 1, highWaterBytes: 0, highWaterVersion: 0 }
      if (label === 'recover:#2') return { decision: 'continue', branch: 'feat/2-x', wipCommitted: true, worktreeMissing: false, reason: 'test', brief: { done: 'd', remaining: 'r', broken: '' } }
      if (label === 'state:cleanup:#2') return { ok: true, retained: false }
      if (label === 'impl:#2') return { branch: violating(2), summary: 's', worktreePath: '/repo/wt/2' }
      return undefined
    },
  })
  const labels = calls.map((c) => c.opts.label)
  assert.ok(labels.includes('impl:#2'), '回復 Implement まで進んでいない（テストの前提が崩れた）')
  for (const l of labels) assert.ok(!/^(review|fix|pr-create|pr-bind|merge):#2/.test(l), `起動してはならない: ${l}`)
  for (const w of stateWrites(calls)) assert.ok(!wroteAsBranch(w, violating(2)))
  const entry = result.done.find((r) => r.issue === 2)
  assert.equal(entry.status, 'blocked')
  assert.match(entry.note, /回復 Implement/)
})

test('配線: implement の 2 つの受理地点が同じ implBranchViolation を経由し、文字種だけの旧ゲートが残っていない', () => {
  assert.equal(source.split('implBranchViolation(impl.branch, item.number)').length - 1, 2)
  assert.ok(!/if \(!isValidBranchName\(impl\.branch \?\? ''\)\)/.test(source))
})

test('implement のプロンプトの返却仕様に branch の命名要件がある', async () => {
  const { calls } = await runScript({ args: BASE_ARGS })
  const p = calls.find((c) => c.opts.label === 'impl:#2').prompt
  assert.match(p, /返却: branch（<type>\/2-<short-name> 形式のみ受理/)
})

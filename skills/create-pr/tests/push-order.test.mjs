// push-order.test.mjs — create-pr の SKILL.md が「セキュリティチェックの後に push する」順序を保つことの静的回帰テスト。
//
// 検証する契約: リモートへの push はこのスキル自身が Step 5 で行い、Step 2 のセキュリティチェックより後・
// `gh pr create` より前に置く。前提条件で「push 済み」を要求しない（要求すると確認前の差分が公開される）。
// push の拒否を force 系で上書きしない。sandbox 節は `git push` と `.git` への書き込みを明記する。
// Step 2 の番号は implement-issue-tree（scripts/implement-issue-tree.src.js・tests/pr-push-prompt.test.mjs）が
// 「create-pr SKILL.md Step 2」として参照しているため変えない。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = readFileSync(join(HERE, '..', 'SKILL.md'), 'utf8')

// 見出し行から次の同レベル以上の見出しまでを返す。見つからなければテストを失敗させる。
function section(heading, level) {
  const start = SKILL.indexOf(`\n${heading}`)
  assert.ok(start >= 0, `見出し「${heading}」が無い`)
  const rest = SKILL.slice(start + 1)
  const next = rest.slice(heading.length).search(new RegExp(`\\n#{1,${level}} `))
  return next < 0 ? rest : rest.slice(0, heading.length + next)
}

// bash フェンスの中身を、SKILL.md 内の開始位置つきで返す。
const fences = [...SKILL.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => ({ at: m.index, body: m[1] }))
const fencesWith = (re) => fences.filter((f) => re.test(f.body))

test('Step 2 の見出しはセキュリティチェックのまま番号を変えない', () => {
  assert.match(SKILL, /\n### Step 2: セキュリティチェック（必須）\n/)
})

test('git push は Step 2 より後・gh pr create より前の Step 5 に 1 回だけある', () => {
  const step2 = SKILL.indexOf('\n### Step 2:')
  const step5 = SKILL.indexOf('\n### Step 5:')
  const pushes = fencesWith(/(^|\n)\s*git push\b/)
  const creates = fencesWith(/(^|\n)\s*gh pr create\b/)
  assert.equal(pushes.length, 1, 'git push のフェンスはちょうど 1 つ')
  assert.equal(creates.length, 1, 'gh pr create のフェンスはちょうど 1 つ')
  const push = pushes[0]
  assert.match(push.body, /^git push -u origin HEAD$/m)
  assert.ok(step2 >= 0 && step5 > step2, 'Step 2 と Step 5 の見出しがこの順にある')
  assert.ok(push.at > step2, 'git push は Step 2 より後')
  assert.ok(push.at > step5, 'git push は Step 5 の中')
  assert.ok(push.at < creates[0].at, 'git push は gh pr create より前')
})

test('Step 5 は Step 2 で HIGH / MEDIUM が無いと確かめた後にだけ push し、拒否されても force しない', () => {
  const step5 = section('### Step 5:', 3)
  assert.match(step5, /Step 2 のセキュリティチェックで HIGH \/ MEDIUM が無いと確かめた後にだけ/)
  assert.match(step5, /`--force`・`--force-with-lease` を含む force 系の push で上書きしない/)
  assert.match(step5, /拒否の内容を報告して止める/)
  for (const f of fences) assert.doesNotMatch(f.body, /--force/, 'フェンスに force 系の push が無い')
})

test('前提条件に「push 済み」の要求が無い', () => {
  const pre = section('## 前提条件', 2)
  assert.doesNotMatch(pre, /push\s*済み/)
  assert.doesNotMatch(pre, /push\s*し(て|ておく)[^\n]*こと/)
})

test('sandbox 節は git push と .git への書き込みを明記し、「.git へ書き込まない」とは書かない', () => {
  const sb = section('## sandbox 環境での実行', 2)
  assert.match(sb, /`git push`/)
  assert.match(sb, /`git push -u origin HEAD` はネットワークを使ううえ、`\.git` にも書き込む/)
  assert.match(sb, /報告して止める/)
  assert.doesNotMatch(sb, /`\.git`・`\.agents`・`\.codex` へ書き込まない/)
})

test('よくある失敗に「セキュリティチェックの前に push する」がある', () => {
  const mistakes = section('## よくある失敗', 2)
  assert.match(mistakes, /先に `git push` してから Step 2 のセキュリティチェックを行い/)
})

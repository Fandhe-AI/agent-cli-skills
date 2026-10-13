// スキル同梱のシェルスクリプト（scripts/*.sh と scripts/lib/*.sh）が、禁止された操作の綴りを含まないことを検査する静的ガード
// （Issue #603 第 3 弾）。
//
// なぜ必要か: scripts/merge-guard-hook.sh は subagent の Bash の『コマンド文字列』を見てマージ系・設定変更系を拒否するが、
// スクリプトの中で実行されるコマンドは hook から見えない。第 3 弾で push を含むスクリプト（base-merge.sh）が入り、
// 以降の弾でも増える。スクリプトの内容は run-verified.sh のハッシュで固定されるので、『レビューした内容から変わっていない』
// ことは保証できるが、『レビューした内容が安全か』は保証できない。そこで、hook が拒否する操作と、hook を通さない近道
// （--force 系の push・フック回避）の綴りが、スクリプトのコード行に無いことをテストで固定する。
//
// 対象はコメント行を除いたコード行。merge-guard-hook.sh は拒否すべき綴りの定義そのものを持つため対象外（唯一の除外）。
// 検査パターン自身が壊れていないことは、各パターンが『悪い例』に発火する自己検査で固定する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const EXCLUDED = new Set(['merge-guard-hook.sh'])

const PATTERNS = [
  // マージ・クローズ
  ['gh pr merge', /\bgh\b[^\n|;&]*\bpr\b[^\n|;&]*\bmerge\b/],
  ['gh pr close / gh issue close', /\bgh\b[^\n|;&]*\b(pr|issue)\b[^\n|;&]*\bclose\b/],
  ['REST のマージ API', /pulls\/[^\s'"]*\/merge|\/merges\b|\/merge['"\s]*$/],
  ['GraphQL のマージ mutation', /mergePullRequest|enablePullRequestAutoMerge|mergeBranch|closePullRequest/],
  // 承認
  ['approve', /--approve\b|\bgh\b[^\n|;&]*\bpr\b[^\n|;&]*\breview\b|\bevent=APPROVE\b|\bAPPROVE\b|submitPullRequestReview|addPullRequestReview/],
  // リポジトリ設定・ruleset・branch protection の変更
  ['ruleset / branch protection / リポジトリ設定', /\/rulesets\b|branches\/[^\s'"]*\/protection|\bgh\b[^\n|;&]*\brepo\b[^\n|;&]*\b(edit|rename|archive|unarchive|delete)\b|updateRepository|deleteRepository|archiveRepository|ruleset\w*Mutation|createRuleset|updateRuleset/],
  ['書き込み系の HTTP メソッド', /(--method|-X)[ =]+['"]?(?!GET\b)[A-Za-z]+/i],
  ['GraphQL の mutation', /\bmutation\b/],
  // push の近道
  ['git push の --force 系', /\bgit\b[^\n|;&]*\bpush\b[^\n]*(--force\b|--force-with-lease|--mirror|--delete\b|--prune\b|--force-if-includes)/],
  ['git push の -f 系短縮オプション', /\bgit\b[^\n|;&]*\bpush\b[^\n]*\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)/],
  ['git push の + refspec', /\bgit\b[^\n|;&]*\bpush\b[^\n]*\s['"]?\+/],
  // フック回避
  ['--no-verify', /--no-verify\b/],
]

function targets() {
  const out = []
  for (const dir of [SCRIPTS, join(SCRIPTS, 'lib')]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.sh') || EXCLUDED.has(f)) continue
      out.push({ name: dir === SCRIPTS ? f : `lib/${f}`, path: join(dir, f) })
    }
  }
  return out
}
const codeLines = (text) => text.split('\n').map((l, i) => ({ n: i + 1, l })).filter(({ l }) => !/^\s*#/.test(l))

test('走査の対象にスクリプト一式（scripts/*.sh と scripts/lib/*.sh）が含まれ、除外は merge-guard-hook.sh だけ', () => {
  const names = targets().map((t) => t.name)
  for (const must of ['base-merge.sh', 'observe-pr.sh', 'measure-residual-bytes.sh', 'measure-free-disk.sh', 'run-verified.sh', 'preview-tree.sh', 'lib/signed-output.sh', 'lib/push-verify.sh']) {
    assert.ok(names.includes(must), `${must} が走査の対象にない（${names.join(', ')}）`)
  }
  assert.ok(!names.includes('merge-guard-hook.sh'))
  assert.deepEqual([...EXCLUDED], ['merge-guard-hook.sh'])
  assert.ok(readdirSync(SCRIPTS).includes('merge-guard-hook.sh'), '除外の根拠（hook が実在する）')
})

test('スクリプトのコード行に、マージ・承認・設定変更・force push・フック回避の綴りが無い', () => {
  const hits = []
  for (const { name, path } of targets()) {
    for (const { n, l } of codeLines(readFileSync(path, 'utf8'))) {
      for (const [label, re] of PATTERNS) if (re.test(l)) hits.push(`${name}:${n} [${label}] ${l.trim()}`)
    }
  }
  assert.deepEqual(hits, [], `禁止された綴りがスクリプトにある:\n${hits.join('\n')}`)
})

test('自己検査: 各パターンは悪い例に発火する（パターンが壊れて何も検出しなくなっていない）', () => {
  const bad = {
    'gh pr merge': ['gh pr merge 12 --squash', 'gh -R o/r pr merge 12', 'gh --repo o/r pr merge'],
    'gh pr close / gh issue close': ['gh pr close 3', 'gh issue close 4'],
    'REST のマージ API': ['gh api repos/o/r/pulls/3/merge -X PUT', 'gh api repos/o/r/merges'],
    'GraphQL のマージ mutation': ['mergePullRequest(input:{})', 'enablePullRequestAutoMerge'],
    approve: ['gh pr review 3 --approve', 'gh pr review 3', '-f event=APPROVE', '"event": "APPROVE"'],
    'ruleset / branch protection / リポジトリ設定': ['gh api repos/o/r/rulesets/1', 'gh api repos/o/r/branches/main/protection', 'gh repo edit --visibility public', 'gh repo delete o/r'],
    '書き込み系の HTTP メソッド': ['gh api -X PUT repos/o/r/x', 'gh api --method POST repos/o/r/x', 'gh api --method=DELETE x'],
    'GraphQL の mutation': ['mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{id} } }'],
    'git push の --force 系': ['git push --force origin HEAD', 'git push origin HEAD --force-with-lease', 'git push --mirror', 'git push origin --delete x'],
    'git push の -f 系短縮オプション': ['git push -f origin HEAD', 'git push origin HEAD -f', 'git push -uf origin HEAD'],
    'git push の + refspec': ['git push origin +HEAD:refs/heads/x', 'git push origin "+HEAD:refs/heads/x"'],
    '--no-verify': ['git commit --no-verify -m x', 'git push --no-verify'],
  }
  for (const [label, re] of PATTERNS) {
    assert.ok(bad[label], `${label}: 悪い例がない`)
    for (const line of bad[label]) assert.ok(re.test(line), `${label} が発火しない: ${line}`)
  }
  assert.equal(Object.keys(bad).length, PATTERNS.length)
})

test('自己検査: 正当な行（読み取りの gh api・GET・HEAD:refs/heads/<branch> の push・APPROVED の状態語）には発火しない', () => {
  const good = [
    'gh api "${repo_path}/commits/${HEAD}/check-runs?per_page=1"',
    'gh api --paginate "${repo_path}/rules/branches/${enc}"',
    'gh api -X GET repos/o/r/x',
    'git push origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?',
    "map(select(. == \"APPROVED\"))",
    'gh pr view "${pr}" --json number,headRefName',
    'git merge --no-ff --no-edit -F "${msgfile}" "${base_ref}"',
    'git merge --abort',
    'git fetch origin "${base}:refs/remotes/origin/${base}"',
  ]
  for (const line of good) for (const [label, re] of PATTERNS) assert.ok(!re.test(line), `${label} が正当な行に発火: ${line}`)
})

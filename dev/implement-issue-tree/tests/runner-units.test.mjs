// ランナー共通層の純関数（guard・preamble・models・extract-json）の表テスト。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MERGE_EXEC_COMMAND, mergeExecCommandFor, DENY_FORMS, activeForms, codexRules, expandPrefix, opencodePatterns, opencodeRules } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'
import { buildPreamble, buildRepairPrompt, buildSchemaInstruction, buildWorktreeNotice, composePrompt } from '../../../skills/implement-issue-tree/runner/lib/preamble.mjs'
import { DEFAULT_CONFIG_PATH, IIT_EFFORTS, IIT_MODELS, loadConfig, resolveModel, resolveTimeoutMs, validateConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'
import { extractLastJson } from '../../../skills/implement-issue-tree/runner/lib/extract-json.mjs'

// ---------------------------------------------------------------------------
// guard（deny する形の一覧と、そこから作る Codex rules / OpenCode permissions）
//
// コマンドの判定は配布済みの agent-guard.sh が行う。ここでは一覧の各形を、Codex の PreToolUse hook の
// アダプタ（codex-pretooluse.sh）経由で実際に起動した agent-guard.sh に渡し、deny になることを確かめる。
// 入力は JSON を標準入力に渡すだけで、対象のコマンドは実行しない。
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(40)
const MERGE_EXEC = `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"`

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'init-codex', 'assets', 'hooks')

// Codex の PreToolUse 入力。agent_id があれば subagent=true（ランナーのエージェントはこの形）。
function codexHook(command, { subagent = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('bash', [join(HOOKS, 'codex-pretooluse.sh')], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', (code) => {
      let decision = 'allow'
      if (out.trim() !== '') decision = JSON.parse(out).hookSpecificOutput.permissionDecision
      resolve({ code, decision })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(subagent ? { agent_id: 'agent-1' } : {}) }))
  })
}

// 形の id ごとに、agent-guard.sh が deny する例。バイパス形（演算子・制御構文・ラッパー・リダイレクト・オプションの位置）を含む。
const GUARD_DENY = {
  'pr-merge': [
    'gh pr merge 1 --squash', 'gh pr merge 1', "bash -c 'gh pr merge 1'", 'echo ok && gh pr merge 1', '(gh pr merge 1)',
    'gh -R o/r pr merge 1', 'gh pr -Rowner/repo merge 1', '/usr/local/bin/gh pr merge 1', 'command gh pr merge 1',
    'if true; then gh pr merge 1; fi', 'for i in 1; do gh pr merge $i; done', '{ gh pr merge 1; }', '>/dev/null gh pr merge 1',
    'env -u X gh pr merge 1', 'command -p gh pr merge 1', 'nice -n 10 gh pr merge 1', 'timeout 10 gh pr merge 1',
  ],
  'pr-merge-bypass': ['gh pr merge 1 --admin', 'gh pr merge 1 --auto --squash'],
  'pr-approve': ['gh pr review 1 --approve', 'gh pr review 1 -a', "bash -c 'gh pr review 1 --approve'", "gh api repos/o/r/pulls/1/reviews -f event=APPROVE -f body='-X GET'"],
  'api-merge': [
    'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api repos/o/r/pulls/1/merge -X PUT', 'gh api -X POST repos/o/r/merges', 'gh api repos/o/r/merges -f base=main -f head=x',
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { mergeBranch(input:{}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enqueuePullRequest(input:{}) { clientMutationId } }'",
  ],
  'api-review': [
    "gh api graphql -f query='mutation { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }'",
    'gh api graphql --input q.json', 'gh api graphql --input=q.json', 'gh api graphql -Fquery=@q', 'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
  ],
  'gh-alias-extension': ["gh alias set m 'pr merge'", 'gh alias import a.yml', 'gh extension install o/r', 'gh extension exec x'],
  'git-force-push': [
    'git push --force origin x', 'git push -f origin x', 'git push --force-with-lease origin x', 'git push origin +x:y',
    'git -C /repo push --force origin x', 'git push -fu origin x', 'git push --force-with origin x',
  ],
  'git-no-verify': ['git commit --no-verify -m x', 'git commit -n -m x', 'git push --no-verify', 'git commit -nm x', 'git -c core.hooksPath=/dev/null commit -m x'],
  'auth-token': ['gh auth token', 'gh auth status --show-token', 'printenv GH_TOKEN', 'printenv'],
  'git-credential': ['git credential fill'],
  'auth-file': ['cat ~/.config/gh/hosts.yml', 'cat ~/.codex/auth.json', 'cd ~/.config/gh && cat hosts.yml', 'cd ~/.config/gh;cat hosts.yml', 'cd ~/.config/gh&&cat hosts.yml', 'cd ~/.config/gh|cat', '(cd ~/.config/gh)', 'cat "$HOME/.config/gh"/hosts.yml', 'base64 ~/.config/gh/hosts.yml'],
}

// agent-guard.sh が（subagent=true でも）まだ止めない形。配布物のガードの穴で、rules / permissions だけが止める。
// ガードが直ると下のテストが落ちるので、その時点でこの表から GUARD_DENY へ移す（DENY_FORMS の guardGap も外す）。
// enqueuePullRequest・認証トークンの表示・git credential・認証ファイルの読み取りは PR #845 で塞いで GUARD_DENY へ移した。
const GUARD_GAPS = {}

const GUARD_ALLOW = [
  'gh pr view 1 --json state', 'gh pr create --title t --body-file b.md', 'gh api -X GET repos/o/r/pulls/1/reviews', 'gh pr checks 1',
  'git push origin feat/1-x', 'git commit -m "docs: マージの説明"', 'git status', "bash -c 'git status && gh pr view 1'", 'ls -la', 'node --test x.mjs',
]

test('guard: 一覧の各形の例は、実際に起動した agent-guard.sh（Codex hook 経由・subagent=true）で deny になる', async () => {
  const rows = Object.entries(GUARD_DENY).flatMap(([id, cmds]) => cmds.map((cmd) => [id, cmd]))
  const results = await Promise.all(rows.map(async ([id, cmd]) => [id, cmd, await codexHook(cmd)]))
  for (const [id, cmd, r] of results) {
    assert.equal(r.decision, 'deny', `${id}: ${cmd}`)
    assert.equal(r.code, 0, `${id}: ${cmd}`)
  }
})

test('guard: 通常の作業コマンドは agent-guard.sh で allow（誤検出しない）', async () => {
  const results = await Promise.all(GUARD_ALLOW.map(async (cmd) => [cmd, await codexHook(cmd)]))
  for (const [cmd, r] of results) assert.equal(r.decision, 'allow', cmd)
})

test('guard: git の規則は subagent でなくても有効で、マージ系は subagent のときだけ止まる（ランナーは常に subagent=true で呼ぶ前提）', async () => {
  assert.equal((await codexHook('git push --force origin x', { subagent: false })).decision, 'deny')
  assert.equal((await codexHook('git commit --no-verify -m x', { subagent: false })).decision, 'deny')
  assert.equal((await codexHook('gh pr merge 1', { subagent: false })).decision, 'allow')
  assert.equal((await codexHook('gh pr merge 1', { subagent: true })).decision, 'deny')
})

test('guard: agent-guard.sh がまだ止めない形（配布物のガードの穴）の現状を固定する。穴を塞いだらこの表を GUARD_DENY へ移す', async () => {
  const rows = Object.entries(GUARD_GAPS).flatMap(([id, cmds]) => cmds.map((cmd) => [id, cmd]))
  const results = await Promise.all(rows.map(async ([id, cmd]) => [id, cmd, await codexHook(cmd)]))
  for (const [id, cmd, r] of results) assert.equal(r.decision, 'allow', `${id}: ${cmd}（ガードが直った。GUARD_DENY へ移す）`)
})

test('guard: DENY_FORMS の id は一意で、全形が GUARD_DENY か GUARD_GAPS に例を持ち、guardGap の形は GUARD_GAPS に載る', () => {
  const ids = DENY_FORMS.map((f) => f.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const f of DENY_FORMS) {
    assert.ok(f.prefixes.length + f.globs.length > 0, `${f.id}: パターンが無い`)
    assert.ok(GUARD_DENY[f.id] || GUARD_GAPS[f.id], `${f.id}: 例が無い`)
    assert.equal(Boolean(f.guardGap), Boolean(GUARD_GAPS[f.id]), `${f.id}: guardGap と GUARD_GAPS が食い違う`)
  }
  for (const id of [...Object.keys(GUARD_DENY), ...Object.keys(GUARD_GAPS)]) assert.ok(ids.includes(id), id)
  assert.deepEqual(DENY_FORMS.filter((f) => f.mergeOnly).map((f) => f.id), ['pr-merge'])
  assert.match(MERGE_EXEC, MERGE_EXEC_COMMAND)
})

test('guard: 追加した形（/merges・mergeBranch・enqueuePullRequest・gh alias・gh extension）が一覧にある', () => {
  const all = opencodePatterns().join('\n')
  for (const needle of ['gh api*mergePullRequest(*', 'gh api*mergeBranch(*', 'gh api*enablePullRequestAutoMerge(*', 'gh api*enqueuePullRequest(*', 'gh alias set*', 'gh alias import*', 'gh extension install*', 'gh extension exec*', 'gh ext install*']) {
    assert.ok(all.includes(needle), needle)
  }
})

// src の各エージェントのプロンプトが指示している gh / git の読み取りコマンド（dev/implement-issue-tree/scripts/implement-issue-tree.src.js）。
// rules / permissions が、これらを拒否しないこと（読み取りを巻き込む粗い形を一覧に入れない）を縛る。
const READ_COMMANDS = [
  'gh api --paginate "repos/{owner}/{repo}/pulls/12/reviews"',
  'gh api --paginate "repos/{owner}/{repo}/pulls/12/comments"',
  'gh api --paginate "repos/{owner}/{repo}/issues/7/sub_issues?per_page=100"',
  `gh api repos/{owner}/{repo}/compare/${SHA}...${'b'.repeat(40)} --jq '{status:.status,files:[.files[].filename]}'`,
  'gh api rate_limit',
  'gh api repos/o/r/issues/7',
  "gh api graphql -F owner='{owner}' -F name='{repo}' -F n=7 -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){number parent{number}}}}' --jq '.data'",
  "gh api graphql -F owner='{owner}' -F name='{repo}' -F n=12 -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body url}}}}}}}'",
  'gh pr view 12 --json state,headRefOid,mergeCommit',
  'gh pr view 12 --json state,mergeable',
  'gh pr view 12 --json files',
  'gh pr checks 12',
  'gh issue view 7 --json number,state',
  'gh run view 99 --log-failed',
  'git fetch origin',
  'git diff --check',
  'git log -1 --format=%s',
  'git remote get-url origin',
]

// OpenCode の glob（`*` は任意の文字列）を全体一致の正規表現にする。
const globToRegExp = (g) => new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

test('guard: src のプロンプトが指示する gh / git の読み取りコマンドは、Codex rules にも OpenCode permissions にも掛からない', () => {
  for (const opts of [{}, { allowMerge: true }]) {
    const globs = opencodePatterns(opts).map(globToRegExp)
    const argvs = activeForms(opts).flatMap((f) => f.prefixes.flatMap(expandPrefix)).map((a) => a.join(' '))
    for (const cmd of READ_COMMANDS) {
      assert.ok(!globs.some((re) => re.test(cmd)), `OpenCode の glob に掛かる: ${cmd}`)
      assert.ok(!argvs.some((a) => cmd === a || cmd.startsWith(`${a} `)), `Codex の prefix_rule に掛かる: ${cmd}`)
    }
  }
})

test('guard: レビューの読み取りを巻き込む `gh api *reviews*` は一覧に無い（書き込みは agent-guard.sh が止める）', async () => {
  assert.ok(!opencodePatterns().some((p) => p.includes('reviews')))
  assert.equal((await codexHook('gh api repos/o/r/pulls/1/reviews -f event=APPROVE')).decision, 'deny')
  assert.equal((await codexHook('gh api --paginate "repos/o/r/pulls/1/reviews"')).decision, 'allow')
})

// 利用者が決める文字列（owner / repo・ブランチ・パス・タイトル・本文）に merge・review・approve・admin・auto・force・delete・token 等が
// 入った読み取りと通常の書き込み。rules / permissions のどれにも掛からないこと（掛かると導入先の通常作業を止める）。
const USER_STRING_COMMANDS = [
  'gh api repos/acme/merge-tool/issues/7',
  'gh api repos/acme/MergeTool/issues/7',
  'gh api repos/acme/merges-app/pulls/3/files',
  'gh api --paginate repos/acme/enqueue-queue/pulls',
  'gh api repos/review-org/approve-app/pulls/3/files',
  'gh api repos/review-org/approve-app/pulls/3/reviews',
  'gh api repos/acme/graphql-js/issues -F body=@note.md',
  'gh api repos/acme/auth-token-service/issues/1',
  'gh api repos/acme/mergeBranch-demo/branches/main',
  'gh pr view 5 -R admin/auto-merge',
  'gh pr view 5 --json mergeCommit,autoMergeRequest',
  'gh pr create --title "fix: merge の扱い" --body "approve と --approve の説明。auto-merge と force push の注意"',
  'gh pr create --base release/auto-merge --head feat/delete-branch',
  'gh issue create --title "docs: pr merge の手順" --body "gh pr review の -a は使わない"',
  'gh pr review 5 --comment --body "use -abc and merge notes"',
  'gh pr comment 5 --body "reviews / approve / admin の話"',
  'git push origin feat/merge-queue',
  'git push -u origin feat/admin-token',
  'git push origin feat/force-update:feat/force-update',
  'git fetch origin release/force-update',
  'git checkout -b feat/no-verify-docs',
  'git commit -m "fix: credential の扱いと hosts.yml の説明"',
  'git add ansible/hosts.yml docs/auth-token.md .codex/author-notes.md',
  'cat ansible/hosts.yml',
  'cat docs/config/ghost/readme.md',
  'git log --oneline -- skills/merge-tool',
  'git diff origin/main -- src/review/approve.ts',
]

test('guard: 利用者が決める名前にキーワード（merge・review・approve・admin・auto・force・token 等）を含む読み取り・通常操作は、Codex rules にも OpenCode permissions / policies にも掛からない', () => {
  for (const opts of [{}, { allowMerge: true }]) {
    const rules = opencodeRules(opts)
    const globs = opencodePatterns(opts).map(globToRegExp)
    const argvs = activeForms(opts).flatMap((f) => f.prefixes.flatMap(expandPrefix)).map((a) => a.join(' '))
    for (const cmd of USER_STRING_COMMANDS) {
      assert.ok(!globs.some((re) => re.test(cmd)), `OpenCode の glob に掛かる: ${cmd}`)
      assert.ok(!rules.permissions.some((p) => globToRegExp(p.resource).test(cmd)), `permissions に掛かる: ${cmd}`)
      assert.ok(!rules.policies.some((p) => globToRegExp(p.resource.replace(/^shell:/, '')).test(cmd)), `policies に掛かる: ${cmd}`)
      assert.ok(!argvs.some((a) => cmd === a || cmd.startsWith(`${a} `)), `Codex の prefix_rule に掛かる: ${cmd}`)
    }
  }
})

test('guard: 一覧の glob は広い部分一致（`gh api *…`・`gh * …` 型の前置き・`*hosts.yml*`・`*.config/gh*`・`*.codex/auth*`）を含まない', () => {
  const broad = new Set(['*hosts.yml*', '*.config/gh*', '*.codex/auth*', 'gh api *merge*', 'gh api *Merge*'])
  for (const g of opencodePatterns()) {
    assert.ok(!broad.has(g), g)
    assert.ok(!/^gh api \*/.test(g), `gh api の直後が * の広い形: ${g}`)
    assert.ok(!/^(gh|git) \* /.test(g), `直後の語が - 始まりでない前置きの形: ${g}`)
  }
})

// agent-guard.sh に任せた形（rules / permissions からは外した）。rules には出ないが、ガードは subagent で deny する。
const GUARD_ONLY_DENY = [
  'gh api -X PUT repos/acme/merge-tool/pulls/1/merge',
  'gh api --method PUT repos/o/r/pulls/1/merge',
  'gh api -XPUT repos/o/r/pulls/1/merge',
  'gh api repos/o/r/pulls/1/merge -f merge_method=squash',
  'gh api -X POST repos/o/r/merges -f base=main -f head=x',
  'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
  'gh api -X POST repos/o/r/pulls/1/reviews -f event=APPROVE',
  "gh api graphql -f query='mutation { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }'",
]

test('guard: rules から外した REST の形は rules に出ず、agent-guard.sh（subagent=true）が deny する', async () => {
  const all = opencodePatterns().map(globToRegExp)
  const results = await Promise.all(GUARD_ONLY_DENY.map(async (cmd) => [cmd, await codexHook(cmd)]))
  for (const [cmd, r] of results) {
    if (/graphql/.test(cmd)) continue
    assert.ok(!all.some((re) => re.test(cmd)), `rules に掛かる（外したはず）: ${cmd}`)
    assert.equal(r.decision, 'deny', `ガードが止めない: ${cmd}`)
  }
  const graphql = results.filter(([cmd]) => /graphql/.test(cmd))
  for (const [cmd, r] of graphql) assert.equal(r.decision, 'deny', cmd)
})

test('guard: 認証ファイルの読み取りと GraphQL の enqueuePullRequest は、agent-guard.sh に加えて rules / permissions も止める', () => {
  const globs = opencodePatterns().map(globToRegExp)
  const enqueue = GUARD_DENY['api-merge'].filter((cmd) => cmd.includes('enqueuePullRequest'))
  assert.equal(enqueue.length, 1)
  for (const cmd of [...GUARD_DENY['auth-file'], ...enqueue]) assert.ok(globs.some((re) => re.test(cmd)), cmd)
})

test('guard: スレッドへの返信 mutation（addPullRequestReviewThreadReply）と resolveReviewThread は rules に掛からず、レビュー本体の mutation は掛かる', () => {
  const globs = opencodePatterns().map(globToRegExp)
  const reply = "gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input:{}) { clientMutationId } }'"
  const resolve = "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { clientMutationId } }'"
  const add = "gh api graphql -f query='mutation { addPullRequestReview(input:{}) { clientMutationId } }'"
  const addSp = "gh api graphql -f query='mutation { addPullRequestReview (input:{}) { clientMutationId } }'"
  assert.ok(!globs.some((re) => re.test(reply)))
  assert.ok(!globs.some((re) => re.test(resolve)))
  assert.ok(globs.some((re) => re.test(add)))
  assert.ok(globs.some((re) => re.test(addSp)))
})

test('guard: opencodeRules は permissions と policies を同じパターンで作る', () => {
  const rules = opencodeRules()
  assert.equal(rules.permissions.length, rules.policies.length)
  for (const p of rules.permissions) assert.deepEqual(Object.keys(p), ['action', 'resource', 'effect']), assert.equal(p.effect, 'deny')
  for (const p of rules.policies) assert.match(p.resource, /^shell:/)
  assert.deepEqual(rules.permissions.map((p) => p.resource), opencodePatterns())
  assert.deepEqual(rules.policies.map((p) => p.resource), opencodePatterns().map((r) => `shell:${r}`))
})

test('guard: allowMerge では gh pr merge の素の形だけを外し、--admin・--auto・承認・REST/GraphQL のマージ・認証は残す', () => {
  const deny = opencodePatterns()
  const merge = opencodePatterns({ allowMerge: true })
  assert.ok(deny.includes('gh pr merge*') && deny.includes('gh -* pr merge*'))
  assert.ok(!merge.includes('gh pr merge*') && !merge.includes('gh -* pr merge*'))
  for (const keep of ['gh pr merge*--admin*', 'gh pr merge*--auto*', 'gh -* pr merge*--admin*', 'gh pr review*--approve*', 'gh api*mergePullRequest(*', 'gh api*enqueuePullRequest(*', 'gh auth token*', 'git push --force*', 'gh alias set*']) {
    assert.ok(merge.includes(keep), keep)
  }
  assert.deepEqual(deny.filter((p) => !merge.includes(p)), ['gh pr merge*', 'gh -* pr merge*'])
})

test('guard: Codex rules と OpenCode permissions は同じ一覧から作られ、prefixes の全組み合わせが両方にあり、allowMerge の外し方も同じ', () => {
  for (const opts of [{}, { allowMerge: true }]) {
    const codex = codexRules(opts)
    const oc = opencodePatterns(opts)
    const forms = activeForms(opts)
    const argvs = forms.flatMap((f) => f.prefixes.flatMap(expandPrefix))
    assert.equal((codex.match(/^prefix_rule\(/gm) ?? []).length, forms.flatMap((f) => f.prefixes).length)
    for (const argv of argvs) {
      assert.ok(codex.includes(JSON.stringify(argv.join(' '))), `Codex に無い: ${argv.join(' ')}`)
      assert.ok(oc.includes(`${argv.join(' ')}*`), `OpenCode に無い: ${argv.join(' ')}`)
    }
    // globs は OpenCode だけ。Codex には出ない
    for (const f of forms) for (const g of f.globs) assert.ok(oc.includes(g), g)
    assert.ok(codex.includes('decision = "forbidden"'))
    assert.ok(!/decision = "(allow|prompt)"/.test(codex))
  }
  const merge = codexRules({ allowMerge: true })
  assert.ok(codexRules().includes('["gh", "pr", "merge"]'))
  assert.ok(!merge.includes('["gh", "pr", "merge"]'))
  assert.ok(merge.includes('["gh", "auth", "token"]'))
})

test('guard: expandPrefix は選択肢の全組み合わせを展開する', () => {
  assert.deepEqual(expandPrefix(['git', 'push', ['--force', '-f']]), [['git', 'push', '--force'], ['git', 'push', '-f']])
  assert.deepEqual(expandPrefix(['gh', ['a', 'b'], ['x', 'y']]).length, 4)
})

// ---------------------------------------------------------------------------
// preamble
// ---------------------------------------------------------------------------

test('preamble: StructuredOutput と Bash の読み替えを含む', () => {
  const p = buildPreamble()
  assert.match(p, /StructuredOutput/)
  assert.match(p, /Bash/)
  assert.match(p, /JSON/)
})

test('preamble: 形式の指示は additionalProperties: true の object（動的キーのマップ）のキーを禁じない', () => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'object', additionalProperties: true } } }
  const text = buildSchemaInstruction(schema)
  assert.ok(!text.includes('schema に無いキーは足さない'))
  assert.match(text, /additionalProperties に従う/)
  assert.match(text, /true[^。]*の object は[^。]*キーを自由に持てる/)
  assert.match(text, /false の object には properties に無いキーを足さない/)
})

test('preamble: worktree の通知は絶対パスだけ受け付ける', () => {
  assert.match(buildWorktreeNotice('/m/.claude/worktrees/wf_x-1'), /\/m\/\.claude\/worktrees\/wf_x-1/)
  for (const bad of ['rel/path', '', undefined, 3]) assert.throws(() => buildWorktreeNotice(bad), /絶対パス/)
})

test('preamble: composePrompt は 前置き → (worktree) → 元のプロンプト → schema の順で、元のプロンプトを改変しない', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const prompt = 'StructuredOutput へ ok を返す\n$(echo "x")'
  const out = composePrompt({ prompt, schema, worktreePath: '/w' })
  const iPre = out.indexOf('実行環境の読み替え')
  const iWt = out.indexOf('作業ディレクトリ')
  const iPrompt = out.indexOf(prompt)
  const iSchema = out.indexOf('最終応答の形式')
  assert.ok(iPre >= 0 && iPre < iWt && iWt < iPrompt && iPrompt < iSchema)
  assert.ok(!composePrompt({ prompt, schema }).includes('作業ディレクトリ'))
  assert.ok(out.includes(JSON.stringify(schema, null, 2)))
  assert.throws(() => composePrompt({ prompt: 1, schema }), /文字列/)
})

test('preamble: 大きい schema は整形せず 1 行で埋め込む', () => {
  const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, { type: 'string', description: 'x'.repeat(20) }])) }
  const text = buildSchemaInstruction(big)
  assert.ok(text.includes(JSON.stringify(big)))
})

test('preamble: 修復プロンプトは errors を列挙し、空なら JSON 取り出し失敗の文を使い、20 件で切る', () => {
  const p = buildRepairPrompt(['$.a: 必須キー "a" が無い'])
  assert.match(p, /- \$\.a: 必須キー/)
  assert.match(buildRepairPrompt([]), /取り出せなかった/)
  const many = buildRepairPrompt(Array.from({ length: 30 }, (_, i) => `e${i}`))
  assert.equal((many.match(/^- e/gm) ?? []).length, 20)
})

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

test('models: 既定の設定ファイルは検査を通り、全ツール × 全モデル名の表がある', () => {
  const c = loadConfig()
  assert.equal(DEFAULT_CONFIG_PATH.endsWith('runner/config/default.json'), true)
  for (const tool of ['codex', 'opencode']) for (const m of IIT_MODELS) assert.ok(c.models[tool][m], `${tool}.${m}`)
})

test('models: Codex の対応表（phase0 の 0-7）', () => {
  const c = loadConfig()
  const at = (model, effort) => resolveModel(c, 'codex', { model, effort })
  assert.deepEqual(at('haiku', 'low'), { name: 'haiku', model: 'gpt-6-luna', effort: 'low', variant: null })
  assert.deepEqual(at('sonnet', 'medium'), { name: 'sonnet', model: 'gpt-6.1-sol', effort: 'medium', variant: null })
  assert.deepEqual(at('opus', 'high'), { name: 'opus', model: 'gpt-6.1-sol', effort: 'high', variant: null })
  assert.deepEqual(at('fable', 'high'), { name: 'fable', model: 'gpt-6-astra', effort: 'high', variant: null })
  // effort は opts を優先し、省略時は表の値
  assert.equal(at('opus', 'low').effort, 'low')
  assert.equal(at('opus', undefined).effort, 'high')
})

test('models: OpenCode は variant の梯子で段を代用し、model は null（利用者の既定）。fable は opus と同じ', () => {
  const c = loadConfig()
  const at = (m) => resolveModel(c, 'opencode', { model: m })
  assert.deepEqual(at('haiku'), { name: 'haiku', model: null, effort: null, variant: 'low' })
  assert.equal(at('sonnet').variant, 'medium')
  assert.equal(at('opus').variant, null)
  assert.deepEqual({ ...at('fable'), name: 'opus' }, at('opus'))
})

test('models: model 省略は sessionModel の段（plan・recover の継承に当たる）', () => {
  const c = loadConfig()
  assert.equal(resolveModel(c, 'codex', { effort: 'high' }).name, c.sessionModel)
  assert.equal(resolveModel(c, 'codex').model, 'gpt-6.1-sol')
})

test('models: 未知のツール・モデル名・effort は例外（fail-closed）', () => {
  const c = loadConfig()
  assert.throws(() => resolveModel(c, 'claude', {}), /未知のツール/)
  for (const m of ['gpt', 'Opus', '', null]) assert.throws(() => resolveModel(c, 'codex', { model: m }), /未知のモデル名/, String(m))
  for (const e of ['xhigh', 'LOW', '', null]) assert.throws(() => resolveModel(c, 'codex', { model: 'opus', effort: e }), /未知の effort/, String(e))
  assert.deepEqual([...IIT_EFFORTS], ['low', 'medium', 'high'])
})

test('models: validateConfig は表の欠落・未知のモデル名・不正な limits を拒否', () => {
  const base = () => JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'))
  const mutations = [
    (c) => { c.version = 2 },
    (c) => { c.sessionModel = 'gpt' },
    (c) => { delete c.models.codex.fable },
    (c) => { c.models.opencode.extra = { model: null } },
    (c) => { c.models.codex.opus.effort = 'xhigh' },
    (c) => { c.models.codex.opus.model = '' },
    (c) => { c.limits.maxParallel = 0 },
    (c) => { c.timeoutsSec.byPhase.Plan = -1 },
    (c) => { c.cleanup.deleteSessions = 'yes' },
    (c) => { delete c.models.opencode },
    (c) => { c.toolConfig = [] },
    (c) => { c.toolConfig.claude = {} },
    (c) => { c.toolConfig.codex = 'codex' },
    (c) => { c.toolConfig.opencode.deleteSessions = false },
    (c) => { c.toolConfig.codex.models = {} },
  ]
  for (const mutate of mutations) {
    const c = base()
    mutate(c)
    assert.throws(() => validateConfig(c), /ランナー設定が不正/, mutate.toString())
  }
  assert.doesNotThrow(() => validateConfig(base()))
  assert.doesNotThrow(() => validateConfig((({ toolConfig: _, ...c }) => c)(base())), 'toolConfig は省ける')
})

test('models: 時間切れは phase ごとの表、無ければ default（ミリ秒）', () => {
  const c = loadConfig()
  assert.equal(resolveTimeoutMs(c, { phase: 'Implement' }), c.timeoutsSec.byPhase.Implement * 1000)
  assert.equal(resolveTimeoutMs(c, { phase: 'State' }), c.timeoutsSec.default * 1000)
  assert.equal(resolveTimeoutMs(c, {}), c.timeoutsSec.default * 1000)
  assert.equal(resolveTimeoutMs(c, { phase: 'constructor' }), c.timeoutsSec.default * 1000)
})

// ---------------------------------------------------------------------------
// extract-json
// ---------------------------------------------------------------------------

test('extract-json: 応答全体が object・単一のコードフェンス・文章に 1 つだけ埋まった object を取り出す', () => {
  assert.deepEqual(extractLastJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractLastJson('  \n{"a":1}\n  '), { a: 1 })
  assert.deepEqual(extractLastJson('```json\n{"a": 1}\n```'), { a: 1 })
  assert.deepEqual(extractLastJson('結果は次のとおり。\n```json\n{"a": 1, "b": {"c": [1,2]}}\n```\n以上'), { a: 1, b: { c: [1, 2] } })
})

test('extract-json: 外側の候補が 2 つ以上あるときは採用しない（最後の 1 つを拾わない）', () => {
  assert.equal(extractLastJson('先に {"a":1} を出し、最終は {"a":2} である'), undefined)
  assert.equal(extractLastJson('{"a":1}\n{"b":2}'), undefined)
  assert.equal(extractLastJson('```json\n{"a":1}\n```\n```json\n{"a":2}\n```'), undefined)
  // 応答全体が object なら、中の引用文は候補にならない
  assert.deepEqual(extractLastJson('{"note":"前は {\\"a\\":1} だった","a":2}'), { note: '前は {"a":1} だった', a: 2 })
})

test('extract-json: 文字列内の波括弧・エスケープ・日本語を正しく扱い、外側が読めるとき内側の部分 object を返さない', () => {
  assert.deepEqual(extractLastJson('{"s":"}{ \\" }","t":"日本語"}'), { s: '}{ " }', t: '日本語' })
  assert.deepEqual(extractLastJson('{"outer":{"inner":1}}'), { outer: { inner: 1 } })
})

test('extract-json: 壊れた塊は飛ばして内側の有効な object を探し、無ければ undefined', () => {
  assert.deepEqual(extractLastJson('{"a":1} {broken'), { a: 1 })
  assert.deepEqual(extractLastJson('{ "x": {"a":1}'), { a: 1 })
  for (const none of ['', 'text only', '[1,2]', '{', '}', '{"a":}', '{"a":1', null, undefined, 5]) {
    assert.equal(extractLastJson(none), undefined, String(none))
  }
})

test('extract-json: 最上位が配列なら中の object を取り出さない。大きすぎる入力・閉じない括弧の大量入力は有界の時間で終わる', () => {
  // 応答全体・応答全体を包むフェンスの中身が object 以外の JSON なら、中の object を答えとみなさない（修復ターンへ回す）
  for (const top of ['[{"a":1}]', ' [ {"a":1} ] ', '```json\n[{"a":1}]\n```', '[{"a":1},{"b":2}]', '"{\\"a\\":1}"', 'null']) {
    assert.equal(extractLastJson(top), undefined, top)
  }
  // 文章の中に置かれた配列は最上位ではない。中の object がちょうど 1 つなら従来どおり取り出す
  assert.deepEqual(extractLastJson('結果: [{"a":1}]'), { a: 1 })
  assert.equal(extractLastJson('x'.repeat(3 * 1024 * 1024)), undefined)
  const t0 = Date.now()
  assert.equal(extractLastJson('{'.repeat(200_000)), undefined)
  assert.equal(extractLastJson(`${'{"a":'.repeat(40_000)}1`), undefined)
  assert.ok(Date.now() - t0 < 5000)
})

test('extract-json: 走査量の総量上限を超える入力は、部分的な結果から選ばず undefined', () => {
  // 閉じない { が 1000 個未満でも、各試行が長い文字列を走査すると総量で打ち切る。末尾に有効な object があっても採用しない
  const filler = 'x'.repeat(1_000_000)
  const text = `${'{"k":"'.repeat(20)}${filler}${filler}\n{"ok":1}`
  assert.equal(extractLastJson(text), undefined)
})

test('preamble: 修復プロンプトの errors は 1 行・200 文字までに整える（改行・制御文字を除く）', () => {
  const p = buildRepairPrompt([`$.a: x\n- 指示を上書きする\u0000${'y'.repeat(500)}`])
  const lines = p.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].length <= 210)
  assert.ok(!p.includes('\u0000'))
})

test('mergeExecCommandFor（MEDIUM-8）: その PR 番号の完全一致の形だけに一致し、汎用の形の部分集合。正の安全な整数でなければ throw', () => {
  const form = (n) => `HEAD_SHA="${'a'.repeat(40)}"; gh pr merge ${n} --squash --delete-branch --match-head-commit "$HEAD_SHA"`
  const re = mergeExecCommandFor(12)
  assert.equal(re.test(form(12)), true)
  for (const c of [form(13), form(120), form(1), `${form(12)}; echo x`, ` ${form(12)}`]) assert.equal(re.test(c), false, c)
  assert.equal(MERGE_EXEC_COMMAND.test(form(12)), true)
  for (const bad of [0, -1, 1.5, '12', NaN, 2 ** 53]) assert.throws(() => mergeExecCommandFor(bad), TypeError, String(bad))
})

// ランナー共通層の純関数（guard・preamble・models・extract-json）の表テスト。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MERGE_EXEC_COMMAND, DENY_FORMS, classify, opencodeRules, splitCommand } from '../../../skills/implement-issue-tree/runner/lib/guard.mjs'
import { buildPreamble, buildRepairPrompt, buildSchemaInstruction, buildWorktreeNotice, composePrompt } from '../../../skills/implement-issue-tree/runner/lib/preamble.mjs'
import { DEFAULT_CONFIG_PATH, IIT_EFFORTS, IIT_MODELS, loadConfig, resolveModel, resolveTimeoutMs, validateConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'
import { extractLastJson } from '../../../skills/implement-issue-tree/runner/lib/extract-json.mjs'

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(40)
const MERGE_EXEC = `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"`

// [コマンド, 拒否する形]。マージ・承認の素の形と、bash -c・env・eval・入れ子・クォート分割・グローバルフラグの包みを含む
const DENY_TABLE = [
  ['gh pr merge 1 --squash', 'pr-merge'],
  ['gh pr merge 1', 'pr-merge'],
  ["bash -c 'gh pr merge 1 --squash'", 'pr-merge'],
  ['sh -c "gh pr merge 1"', 'pr-merge'],
  ["bash -lc 'gh pr merge 1'", 'pr-merge'],
  ["bash -c \"bash -c 'gh pr merge 1'\"", 'pr-merge'],
  ["env GH_HOST=x bash -c 'gh pr merge 1'", 'pr-merge'],
  ["env -S 'gh pr merge 1'", 'pr-merge'],
  ["eval 'gh pr merge 1'", 'pr-merge'],
  ['echo ok && gh pr merge 1', 'pr-merge'],
  ['echo ok; gh pr merge 1', 'pr-merge'],
  ['(gh pr merge 1)', 'pr-merge'],
  ['x=$(gh pr merge 1)', 'pr-merge'],
  ["gh pr 'mer'ge 1", 'pr-merge'],
  ['gh -R o/r pr merge 1', 'pr-merge'],
  ['gh --repo o/r pr merge 1', 'pr-merge'],
  ['/usr/local/bin/gh pr merge 1', 'pr-merge'],
  ['command gh pr merge 1', 'pr-merge'],
  [`HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"`, 'pr-merge'], // allowMerge なしでは拒否
  ['gh pr review 1 --approve', 'pr-approve'],
  ['gh pr review 1 -a', 'pr-approve'],
  ['gh pr review 1 -a -b ok', 'pr-approve'],
  ["bash -c 'gh pr review 1 --approve'", 'pr-approve'],
  ['gh api -X PUT repos/o/r/pulls/1/merge', 'api-merge'],
  ['gh api repos/o/r/pulls/1/merge -X PUT', 'api-merge'],
  ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", 'api-merge'],
  ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'", 'api-merge'],
  ["gh api graphql -f query='mutation { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }'", 'api-review'],
  ['gh api graphql --input q.json', 'api-review'],
  ['gh api repos/o/r/pulls/1/reviews -f event=APPROVE', 'api-review'],
  ['gh api repos/o/r/pulls/1/reviews', 'api-review'], // メソッドが読めない形は拒否側に倒す（GET を明示した形だけ通す）
  ['gh api -X POST repos/o/r/pulls/1/reviews', 'api-review'],
  ['gh auth token', 'auth-token'],
  ['gh auth status --show-token', 'auth-token'],
  ['gh auth status -t', 'auth-token'],
  ['printenv GH_TOKEN', 'auth-token'],
  ['cat ~/.config/gh/hosts.yml', 'auth-file'],
  ["bash -c 'cat ~/.codex/auth.json'", 'auth-file'],
  ['git push --force origin x', 'git-force-push'],
  ['git push -f origin x', 'git-force-push'],
  ['git push --force-with-lease origin x', 'git-force-push'],
  ['git push origin +x:y', 'git-force-push'],
  ['git commit --no-verify -m x', 'git-no-verify'],
  ['git commit -n -m x', 'git-no-verify'],
  ['git push --no-verify', 'git-no-verify'],
]

const ALLOW_TABLE = [
  'gh pr view 1 --json state',
  'gh pr create --title t --body-file b.md',
  'gh api -X GET repos/o/r/pulls/1/reviews',
  'gh pr review 1 --comment --body x',
  'gh pr checks 1',
  'git push origin feat/1-x',
  'git commit -m "docs: マージの説明"',
  'git status',
  "bash -c 'git status && gh pr view 1'",
  'echo "gh pr merge"', // 引用符の中の文字列は実行ではない
  'ls -la',
  'node --test x.mjs',
]

test('guard: 拒否する形の表（bash -c・env・eval・入れ子・クォート分割・括弧・絶対パスの包みを含む）', () => {
  for (const [cmd, form] of DENY_TABLE) {
    assert.deepEqual(classify(cmd), { decision: 'deny', form }, cmd)
  }
})

test('guard: 通す形の表（誤検出しない）', () => {
  for (const cmd of ALLOW_TABLE) assert.deepEqual(classify(cmd), { decision: 'allow' }, cmd)
})

test('guard: merge-exec の完全一致の 1 形だけが allowMerge で通り、それ以外のマージ系はすべて拒否のまま', () => {
  assert.match(MERGE_EXEC, MERGE_EXEC_COMMAND)
  assert.deepEqual(classify(MERGE_EXEC, { allowMerge: true }), { decision: 'allow' })
  assert.deepEqual(classify(MERGE_EXEC, { allowMerge: false }).decision, 'deny')
  const variants = [
    `${MERGE_EXEC}; gh pr review 12 --approve`,
    `${MERGE_EXEC} && gh pr review 12 --approve`,
    `${MERGE_EXEC}\ngh pr review 12 --approve`,
    `echo x; ${MERGE_EXEC}`,
    `bash -c '${MERGE_EXEC}'`,
    `HEAD_SHA="${'b'.repeat(39)}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"`,
    `HEAD_SHA="${SHA}"; gh pr merge 12 --merge --delete-branch --match-head-commit "$HEAD_SHA"`,
    `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --match-head-commit "$HEAD_SHA"`,
    `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA" --admin`,
    'gh pr merge 12 --squash',
    `HEAD_SHA="${SHA}"; gh pr merge 012 --squash --delete-branch --match-head-commit "$HEAD_SHA"`,
    `HEAD_SHA="${SHA}"; gh pr merge 12 --squash --delete-branch --match-head-commit "$HEAD_SHA"\n`,
  ]
  for (const cmd of variants) assert.equal(classify(cmd, { allowMerge: true }).decision, 'deny', cmd)
  // allowMerge でも承認・認証・force は通らない
  for (const cmd of ['gh pr review 1 --approve', 'gh auth token', 'git push --force origin x']) {
    assert.equal(classify(cmd, { allowMerge: true }).decision, 'deny', cmd)
  }
})

test('guard: 入れ子が深すぎる・文字列でない入力は拒否側（fail-closed）', () => {
  let cmd = 'gh pr view 1'
  for (let i = 0; i < 12; i++) cmd = `bash -c ${JSON.stringify(cmd)}`
  assert.deepEqual(classify(cmd), { decision: 'deny', form: 'nesting-limit' })
  for (const bad of [undefined, null, 5, {}]) assert.deepEqual(classify(bad), { decision: 'deny', form: 'bad-input' })
})

test('guard: splitCommand は区切りで分け、クォートを外して連結する', () => {
  assert.deepEqual(splitCommand("a b; c 'd e' \"f\\\"g\" h'i'j && k | l"), [['a', 'b'], ['c', 'd e', 'f"g', 'hij'], ['k'], ['l']])
  assert.deepEqual(splitCommand(''), [])
})

test('guard: DENY_FORMS は id が一意で、mergeOnly はマージ系だけ。OpenCode のパターンは全形が持つ', () => {
  const ids = DENY_FORMS.map((f) => f.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(DENY_FORMS.filter((f) => f.mergeOnly).map((f) => f.id), ['pr-merge', 'api-merge'])
  for (const f of DENY_FORMS) assert.ok(f.opencode.length > 0, f.id)
  // 表で拒否する形の id は全部 DENY_FORMS にある
  const known = new Set([...ids, 'nesting-limit', 'bad-input'])
  for (const [, form] of DENY_TABLE) assert.ok(known.has(form), form)
})

test('guard: opencodeRules は permissions と policies を同じパターンで作り、allowMerge ではマージ系だけを外す', () => {
  const deny = opencodeRules()
  const merge = opencodeRules({ allowMerge: true })
  assert.equal(deny.permissions.length, deny.policies.length)
  for (const p of deny.permissions) assert.deepEqual(Object.keys(p), ['action', 'resource', 'effect']), assert.equal(p.effect, 'deny')
  for (const p of deny.policies) assert.match(p.resource, /^shell:/)
  const res = (rules) => rules.permissions.map((p) => p.resource)
  assert.ok(res(deny).includes('gh pr merge*'))
  assert.ok(!res(merge).includes('gh pr merge*'))
  assert.ok(res(merge).includes('gh pr review*--approve*'), '承認は merge-exec でも拒否')
  assert.ok(res(merge).includes('gh auth token*'))
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
  ]
  for (const mutate of mutations) {
    const c = base()
    mutate(c)
    assert.throws(() => validateConfig(c), /ランナー設定が不正/, mutate.toString())
  }
  assert.doesNotThrow(() => validateConfig(base()))
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

test('extract-json: 素の JSON・コードフェンス・前後の文章つき・最後のオブジェクトを取り出す', () => {
  assert.deepEqual(extractLastJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractLastJson('結果は次のとおり。\n```json\n{"a": 1, "b": {"c": [1,2]}}\n```\n以上'), { a: 1, b: { c: [1, 2] } })
  assert.deepEqual(extractLastJson('先に {"a":1} を出し、最終は {"a":2} である'), { a: 2 })
  assert.deepEqual(extractLastJson('{"a":1}\n{"b":2}'), { b: 2 })
})

test('extract-json: 文字列内の波括弧・エスケープ・日本語を正しく扱い、外側が読めるとき内側の部分 object を返さない', () => {
  assert.deepEqual(extractLastJson('{"s":"}{ \\" }","t":"日本語"}'), { s: '}{ " }', t: '日本語' })
  assert.deepEqual(extractLastJson('{"outer":{"inner":1}}'), { outer: { inner: 1 } })
})

test('extract-json: 壊れた塊は飛ばして内側・前の有効な object を探し、無ければ undefined', () => {
  assert.deepEqual(extractLastJson('{"a":1} {broken'), { a: 1 })
  assert.deepEqual(extractLastJson('{ "x": {"a":1}'), { a: 1 })
  for (const none of ['', 'text only', '[1,2]', '{', '}', '{"a":}', '{"a":1', null, undefined, 5]) {
    assert.equal(extractLastJson(none), undefined, String(none))
  }
})

test('extract-json: 配列の中の object は取り出す。大きすぎる入力・閉じない括弧の大量入力は有界の時間で終わる', () => {
  assert.equal(extractLastJson('[{"a":1}]')?.a, 1, '配列の中の object は object として取り出される')
  assert.equal(extractLastJson('x'.repeat(3 * 1024 * 1024)), undefined)
  const t0 = Date.now()
  assert.equal(extractLastJson('{'.repeat(200_000)), undefined)
  assert.ok(Date.now() - t0 < 5000)
})

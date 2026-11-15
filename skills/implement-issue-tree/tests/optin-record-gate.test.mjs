// opt-in テスト記録ゲート（Issue #495）の観測を scripts/observe-pr.sh --mode optin-record へ移した（Issue #603）ことのホスト側の回帰テスト。
//
// 背景: 以前は gh pr view・本文の正規化・コマンドごとの固定文字列 grep を 1 KB 超のインラインのコマンド列としてエージェントに書き写させていた。
// 書き写しの誤り（バックスラッシュの半減・\n の n 化など）が結果を黙って変える経路をなくすため、スクリプトへ移し、結果は封筒で返らせてホストが照合する。
// 検証する契約:
//   - 封筒の照合（nonce・sha256・入力のハッシュ = モード・PR・repo・宣言コマンドの個数と並び）に通った観測だけを採る（classifyOptinRecordObservation）
//   - 観測の失敗（照合・取得・形）は観測 agent を sonnet で 1 回だけ取り直し、なお失敗なら全件不合格 = blocked に倒す（fail-closed）
//   - 判定（pass が 1 件以上かつ pass 以外が 0 件）は従来どおり classifyOptinRecordGate。封筒の headSha が merge-exec の期待 HEAD になる
//   - プロンプトは固定コマンドの実行と封筒の転記だけを指示する
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_ARGS, definitionPart, importDefinitions, runScript } from './lib/stub-run.mjs'
import { availableBashes, inputSha256, makeEnvelope, nonceOf, toolExists } from './lib/signed-output.mjs'
import { createObserveStub } from './lib/gh-observe-stub.mjs'
import { bundleSha256 } from '../scripts/build-workflow.mjs'

const { classifyOptinRecordObservation, classifyOptinRecordGate, observeInputText, observeCommand } = await importDefinitions(
  ['classifyOptinRecordObservation', 'classifyOptinRecordGate', 'observeInputText', 'observeCommand'],
  'optin-record-gate',
)

const NONCE = 'or1n2o3n4c5e'
const SHA = 'a'.repeat(40)
const CMDS = ['make e2e', 'cargo test -- --ignored']
const marker = (sha, result, cmd) => `<!-- optin-test-record: ${sha} ${result} ${cmd} -->`
const inputOf = (pr, cmds, repo = '') => ['observe-pr', 'optin-record', String(pr), repo, '', '', '', '', '', String(cmds.length), ...cmds].join('\n')
const payloadOf = (pr, cmds, over = {}) => ({
  mode: 'optin-record', inputSha256: inputSha256(inputOf(pr, cmds)), outcome: 'observed', err: 0, headSha: SHA,
  pass: cmds.map(() => 1), nonPass: cmds.map(() => 0), ...over,
})

test('入力の定義: ホストの observeInputText はスクリプトの定義（9 行 + 個数 + 各コマンド）と一致する', () => {
  assert.equal(observeInputText({ mode: 'optin-record', pr: 7, optinCommands: CMDS }), inputOf(7, CMDS))
})

test('classifyOptinRecordObservation: 照合に通った観測を classifyOptinRecordGate が読む { headRefOid, counts } の形へ直す', () => {
  const env = makeEnvelope(NONCE, payloadOf(7, CMDS, { pass: [2, 0], nonPass: [0, 3] }))
  const c = classifyOptinRecordObservation(env, NONCE, inputSha256(inputOf(7, CMDS)), CMDS)
  assert.equal(c.kind, 'ok')
  assert.deepEqual(c.verify, { headRefOid: SHA, counts: [{ index: 0, pass: 2, nonPass: 0 }, { index: 1, pass: 0, nonPass: 3 }] })
  assert.deepEqual(classifyOptinRecordGate(CMDS, c.verify), { ok: false, missing: [1] })
  const ok = classifyOptinRecordObservation(makeEnvelope(NONCE, payloadOf(7, CMDS)), NONCE, inputSha256(inputOf(7, CMDS)), CMDS)
  assert.deepEqual(classifyOptinRecordGate(CMDS, ok.verify), { ok: true, missing: [] })
})

test('classifyOptinRecordObservation: 封筒の欠落・nonce・sha256・入力の不一致は skip（観測できなかった）', () => {
  const sha = inputSha256(inputOf(7, CMDS))
  const good = makeEnvelope(NONCE, payloadOf(7, CMDS))
  const c = (raw, nonce = NONCE, input = sha, cmds = CMDS) => classifyOptinRecordObservation(raw, nonce, input, cmds)
  assert.equal(c(null).reason, 'envelope:missing')
  assert.equal(c({ payload: good.payload }).reason, 'envelope:missing')
  assert.equal(c(good, 'othernonce').reason, 'envelope:nonce')
  assert.equal(c({ ...good, sha256: '0'.repeat(64) }).reason, 'envelope:sha256')
  // 宣言コマンドの一部が書き写しで欠けたまま実行された（スクリプトは欠けた入力で正しい封筒を作る）→ ホストが期待する入力と違う
  assert.equal(c(makeEnvelope(NONCE, payloadOf(7, [CMDS[0]]))).reason, 'envelope:input')
  // 順序の入れ替え・別の PR・別の repo も同じ
  assert.equal(c(makeEnvelope(NONCE, payloadOf(7, [CMDS[1], CMDS[0]]))).reason, 'envelope:input')
  assert.equal(c(makeEnvelope(NONCE, payloadOf(8, CMDS))).reason, 'envelope:input')
  assert.equal(c(makeEnvelope(NONCE, { ...payloadOf(7, CMDS), inputSha256: inputSha256(inputOf(7, CMDS, 'o/r')) })).reason, 'envelope:input')
})

test('classifyOptinRecordObservation: モード違い・取得失敗・形の不正は skip（件数を採らない）', () => {
  const sha = inputSha256(inputOf(7, CMDS))
  const c = (over) => classifyOptinRecordObservation(makeEnvelope(NONCE, payloadOf(7, CMDS, over)), NONCE, sha, CMDS)
  assert.equal(c({ mode: 'policy-paths' }).reason, 'mode')
  assert.equal(c({ err: 1, outcome: 'error', headSha: '', pass: [], nonPass: [] }).reason, 'fetch-error')
  assert.equal(c({ outcome: 'error' }).reason, 'fetch-error')
  assert.equal(c({ outcome: 'pending' }).reason, 'fetch-error')
  for (const over of [
    { headSha: '' }, { headSha: 'A'.repeat(40) }, { headSha: 'a'.repeat(39) }, { headSha: 5 },
    { pass: [1] }, { pass: [1, 1, 1] }, { nonPass: [0] }, { pass: 1 }, { nonPass: null }, { pass: '1,1' },
    { pass: [1, -1] }, { pass: [1, 1.5] }, { pass: ['1', 1] }, { nonPass: [0, 100001] }, { pass: [null, 1] },
  ]) {
    assert.equal(c(over).reason, 'payload', JSON.stringify(over))
  }
})

// ホストが組み立てる実際のコマンド行を、エージェントが実行するのと同じくシェルへ渡して走らせる（引数の配列ではなく文字列）。run-verified.sh の
// ハッシュ照合・単一引用符つきの空白を含む引数・`--` を含むコマンドが、封筒をホストの照合に通すところまで壊れないことの確認
for (const bash of availableBashes()) {
  test(`[${bash}] 実コマンド行: observeCommand の文字列を bash -c で run-verified.sh 経由で実行した封筒を、ホストの照合が受理する`, { skip: !toolExists('jq') }, () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const scriptsDir = join(here, '..', 'scripts')
    const cmds = ['make e2e', 'cargo test -- --ignored', 'cargo test -p a_b --features x=1,y -- --ignored']
    const f = { mode: 'optin-record', pr: 7, optinCommands: cmds }
    const nonce = 'e2ecommand0nonce1'
    const line = observeCommand(nonce, f)
      .replace("'<skillDir>/scripts/run-verified.sh'", `'${join(scriptsDir, 'run-verified.sh')}'`)
      .replace('@@SCRIPT_SHA256:observe-pr.sh@@', bundleSha256(scriptsDir, 'observe-pr.sh'))
    assert.ok(!line.includes('<skillDir>') && !line.includes('@@'), line)
    const body = [marker(SHA, 'pass', cmds[0]), marker(SHA, 'pass', cmds[1]), marker(SHA, 'fail', cmds[1]), marker('b'.repeat(40), 'pass', cmds[2])].join('\n')
    const stub = createObserveStub({ prview: { out: JSON.stringify({ body, headRefOid: SHA }) } })
    const r = spawnSync(bash, ['-c', line], { encoding: 'utf8', env: stub.env() })
    assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
    const c = classifyOptinRecordObservation(JSON.parse(r.stdout), nonce, inputSha256(observeInputText(f)), cmds)
    assert.equal(c.kind, 'ok', c.reason)
    assert.deepEqual(c.verify.counts, [{ index: 0, pass: 1, nonPass: 0 }, { index: 1, pass: 1, nonPass: 1 }, { index: 2, pass: 0, nonPass: 0 }])
    assert.deepEqual(classifyOptinRecordGate(cmds, c.verify), { ok: false, missing: [1, 2] })
    // コマンドを 1 件欠いて実行すると（書き写しの誤り）、スクリプトは欠けた入力で正しい封筒を作るが、ホストの照合が拒否する
    const dropped = line.replace(" --optin-cmd 'make e2e'", '')
    assert.notEqual(dropped, line)
    const r2 = spawnSync(bash, ['-c', dropped], { encoding: 'utf8', env: stub.env() })
    assert.equal(r2.status, 0)
    assert.equal(classifyOptinRecordObservation(JSON.parse(r2.stdout), nonce, inputSha256(observeInputText(f)), cmds).reason, 'envelope:input')
  })
}

test('プロンプトの配線: 観測は observeGate を extra（label・common）つきで呼び、旧プロンプトの手順は残っていない', () => {
  assert.match(definitionPart, /label: `optin-record-verify:#\$\{item\.number\}`, common: \[MERGE_CONTEXT_COMMON\]/)
  assert.ok(!definitionPart.includes('OPTIN_RECORD_VERIFY_SCHEMA'))
  assert.ok(!definitionPart.includes('function optinRecordVerifyPrompt'))
  assert.ok(!definitionPart.includes('grep -cxF -- "${OPTIN_RECORD_MARKER_PREFIX}$H'), '固定文字列 grep の手順はスクリプトの lib にある')
})

// ---- 結合: 宣言ありのイシュー #2 を autoMerge で ready まで進める ----
const HEAD = SHA
const ARGS = { ...BASE_ARGS, autoMerge: true, externalChecks: [], optinTestCommands: ['make e2e'] }
const TREE = [
  { number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: 1 },
  { number: 2, title: 'issue 2', state: 'open', parent: 1, siblingIndex: 0, dependsOn: [], subIssuesTotal: 0, optinTests: ['make e2e'] },
]
const cmdsOf = (prompt) => [...prompt.matchAll(/ --optin-cmd '([^']*)'/g)].map((m) => m[1])
// 正直なエージェント（コマンドをそのまま実行して転記した）の応答。入力のハッシュはプロンプトのコマンドから作る
const honest = (prompt, over = {}) => {
  const pr = Number(/--pr (\d+)/.exec(prompt)[1])
  const cmds = cmdsOf(prompt)
  return makeEnvelope(nonceOf(prompt), payloadOf(pr, cmds, over))
}
async function runGate(reply) {
  const observed = []
  const out = await runScript({
    args: ARGS,
    override: (label, opts, prompt) => {
      if (label === 'plan:issue-tree') return { nodes: structuredClone(TREE) }
      if (label.startsWith('pr-bind:#') || label.startsWith('merged-probe:#')) return { state: 'OPEN', headRefOid: HEAD, headRefName: 'feat/2-x', baseRefName: 'main', isCrossRepository: false, closingIssues: [2] }
      if (label.startsWith('merge:#')) return { state: 'ready', summary: 'マージ条件充足', headSha: HEAD }
      if (label.startsWith('optin-record-verify:#')) {
        observed.push({ model: opts.model, prompt })
        return reply({ prompt, call: observed.length })
      }
      if (label.startsWith('merge-exec:#')) return { merged: false, reason: 'not-mergeable', summary: '見送り', issueClosed: false }
      return undefined
    },
  })
  return { ...out, observed }
}
const labelsOf = (calls) => calls.map((c) => c.opts.label)
const resultOf = (result) => [...(result.done ?? []), ...(result.failed ?? []), ...(result.blocked ?? [])].find((d) => d.issue === 2)

test('結合: 記録が揃っていれば封筒を採って merge-exec へ進み、封筒の headSha が期待 HEAD として渡る', async () => {
  const { calls, observed } = await runGate(({ prompt }) => honest(prompt))
  assert.equal(observed.length, 1)
  assert.equal(observed[0].model, 'haiku')
  assert.deepEqual(cmdsOf(observed[0].prompt), ['make e2e'])
  const labels = labelsOf(calls)
  assert.ok(labels.indexOf('merge-exec:#2') > labels.indexOf('optin-record-verify:#2'))
  assert.ok(calls.find((c) => c.opts.label === 'merge-exec:#2').prompt.includes(HEAD))
})

test('結合: プロンプトは固定コマンドの実行と封筒の転記だけを指示する（gh・jq・grep の手順を書き写させない）', async () => {
  const { observed } = await runGate(({ prompt }) => honest(prompt))
  const p = observed[0].prompt
  assert.match(p, /scripts\/run-verified\.sh' (?:[0-9a-f]{64}|@@SCRIPT_SHA256:observe-pr\.sh@@) observe-pr\.sh --nonce [0-9a-z]+ --mode optin-record --pr \d+ --optin-cmd 'make e2e'\n```/)
  const cmdPart = p.slice(p.indexOf('次のコマンドを'))
  assert.doesNotMatch(cmdPart, /gh pr view|jq |grep|tr -d|sed -e/)
  assert.match(p, /一字一句そのまま/)
  assert.match(p, /nonce・payload・sha256/)
})

test('結合: pass が無い・pass 以外がある記録は、封筒が正しくても merge-exec を起動せず blocked', async () => {
  for (const over of [{ pass: [0], nonPass: [0] }, { pass: [1], nonPass: [1] }, { pass: [0], nonPass: [2] }]) {
    const { calls, observed, result } = await runGate(({ prompt }) => honest(prompt, over))
    assert.equal(observed.length, 1, '正しい封筒の不合格は取り直さない')
    assert.ok(!labelsOf(calls).includes('merge-exec:#2'))
    const r = resultOf(result)
    assert.equal(r.status, 'blocked')
    assert.match(r.note, /opt-in テストの実行記録.*が PR 本文に確認できないためマージを停止した/)
  }
})

test('結合: 観測できない（封筒の欠落・nonce・sha256・入力の不一致・取得失敗・例外・null）ときは haiku → sonnet の 1 回だけ取り直し、なお駄目なら blocked（fail-closed）', async () => {
  const bad = {
    sha256不一致: ({ prompt }) => ({ ...honest(prompt), sha256: '0'.repeat(64) }),
    nonce違い: ({ prompt }) => makeEnvelope('othernonce1', honest(prompt).payload),
    宣言コマンドの欠け: ({ prompt }) => makeEnvelope(nonceOf(prompt), payloadOf(Number(/--pr (\d+)/.exec(prompt)[1]), [], { pass: [], nonPass: [] })),
    取得失敗: ({ prompt }) => honest(prompt, { err: 1, outcome: 'error', headSha: '', pass: [], nonPass: [] }),
    封筒なし: () => ({ counts: [{ index: 0, pass: 1, nonPass: 0 }], headRefOid: HEAD }),
    例外: () => { throw new Error('boom') },
    null: () => null,
  }
  for (const [name, reply] of Object.entries(bad)) {
    const { calls, observed, result } = await runGate(reply)
    assert.deepEqual(observed.map((o) => o.model), ['haiku', 'sonnet'], name)
    assert.equal(new Set(observed.map((o) => nonceOf(o.prompt))).size, 2, `${name}: nonce は呼び出しごとに別`)
    assert.ok(!labelsOf(calls).includes('merge-exec:#2'), name)
    const r = resultOf(result)
    assert.equal(r.status, 'blocked', name)
    assert.match(r.note, /が PR 本文に確認できないためマージを停止した/, name)
  }
})

test('結合: 1 回目だけ失敗しても取り直しで通れば続行する。前の呼び出しの封筒の流用は通らない', async () => {
  const flaky = await runGate(({ prompt, call }) => (call === 1 ? { ...honest(prompt), sha256: '0'.repeat(64) } : honest(prompt)))
  assert.deepEqual(flaky.observed.map((o) => o.model), ['haiku', 'sonnet'])
  assert.ok(labelsOf(flaky.calls).includes('merge-exec:#2'))
  let first = null
  const replay = await runGate(({ prompt, call }) => {
    if (call === 1) {
      first = honest(prompt)
      return { ...first, sha256: '0'.repeat(64) }
    }
    return first
  })
  assert.ok(!labelsOf(replay.calls).includes('merge-exec:#2'), '別の nonce の封筒は通らない')
})

test('結合: 宣言のないイシューでは観測エージェントを起動しない（既定無効）', async () => {
  const { calls } = await runScript({
    args: { ...BASE_ARGS, autoMerge: true, externalChecks: [] },
    override: (label) => {
      if (label.startsWith('pr-bind:#') || label.startsWith('merged-probe:#')) return { state: 'OPEN', headRefOid: HEAD, headRefName: 'feat/2-x', baseRefName: 'main', isCrossRepository: false, closingIssues: [2] }
      if (label.startsWith('merge:#')) return { state: 'ready', summary: 'ok', headSha: HEAD }
      if (label.startsWith('merge-exec:#')) return { merged: false, reason: 'not-mergeable', summary: '見送り', issueClosed: false }
      return undefined
    },
  })
  assert.ok(labelsOf(calls).includes('merge-exec:#2'))
  assert.ok(!labelsOf(calls).some((l) => l.startsWith('optin-record-verify')))
})

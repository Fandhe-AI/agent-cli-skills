// ランナーの生成物読み込み（skills/implement-issue-tree/runner/lib/load-workflow.mjs）の回帰テスト。
//
// 契約: (1) 生成物を無変更で読み、先頭の `export const meta` だけを外して AsyncFunction で評価する。
// (2) 生成物のバイト列の SHA-256 とバイト数を返す。(3) meta が無い・meta 以外の export が残る本体は拒否。
// (4) 評価結果は、既存テストの stub-run が生成物を評価した結果と同じ（同じ args・同じ偽 agent で JSON 全体が一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadWorkflow, stripMeta, DEFAULT_WORKFLOW_PATH } from '../../../skills/implement-issue-tree/runner/lib/load-workflow.mjs'
import { SHIPPED_SCRIPTS } from './lib/paths.mjs'
import { BASE_ARGS, DIST_PATH, buildTree, makeDefaultReply, runScript } from './lib/stub-run.mjs'

test('既定の読み込み先は配布する生成物と同じファイル', () => {
  assert.equal(DEFAULT_WORKFLOW_PATH, join(SHIPPED_SCRIPTS, 'implement-issue-tree.js'))
  assert.equal(DEFAULT_WORKFLOW_PATH, DIST_PATH)
})

test('バイト数と SHA-256 は生成物のバイト列そのもの（読み込みで変換しない）', () => {
  const raw = readFileSync(DEFAULT_WORKFLOW_PATH)
  const wf = loadWorkflow()
  assert.equal(wf.bytes, raw.length)
  assert.equal(wf.sha256, createHash('sha256').update(raw).digest('hex'))
  assert.match(wf.sha256, /^[0-9a-f]{64}$/)
})

test('stripMeta: 先頭の meta の export だけを外す', () => {
  assert.equal(stripMeta('export const meta={a:1}\nreturn 1'), 'const meta={a:1}\nreturn 1')
})

test('stripMeta: meta が無い・先頭でない・文字列でないものは拒否', () => {
  for (const bad of ['return 1', '\nexport const meta={}', 'const meta={}', undefined, null, 5]) {
    assert.throws(() => stripMeta(bad), /export const meta/, String(bad))
  }
})

test('stripMeta: meta 以外の top-level export が残る本体は拒否（ランタイムが受理しない形）', () => {
  assert.throws(() => stripMeta('export const meta={}\nexport const x = 1\nreturn 1'), /meta 以外の top-level export/)
})

test('run: args はパース済みのオブジェクト、agent・log・phase は関数でなければ拒否', () => {
  const wf = loadWorkflow()
  const noop = () => {}
  for (const bad of ['{"parent":1}', null, [], 3]) assert.throws(() => wf.run(bad, noop, noop, noop), /args/)
  assert.throws(() => wf.run({}, null, noop, noop), /関数/)
})

test('run: 生成物の dryRun は、同じ偽 agent の stub-run（生成物を評価）と JSON 全体が一致し、agent 呼び出し列も同じ', async () => {
  const args = { ...BASE_ARGS, dryRun: true }
  const nodes = buildTree([2, 3])
  const reply = makeDefaultReply({ args, nodes })
  const calls = []
  const agent = async (prompt, opts) => { calls.push(opts.label); return reply(prompt, opts) }
  const result = await loadWorkflow().run(args, agent, () => {}, () => {})

  const ref = await runScript({ args, leaves: [2, 3], target: 'dist' })
  assert.deepEqual(result, ref.result)
  assert.deepEqual(calls, ref.calls.map((c) => c.opts.label))
  assert.equal(result.dryRun, true)
})

test('dryRun の返却値は、src を評価した stub-run と生成物を評価した結果で一致する（受入基準 1 の見積りの比較）', async () => {
  const args = { ...BASE_ARGS, dryRun: true }
  const src = await runScript({ args, leaves: [2, 3, 4], target: 'src' })
  const dist = await runScript({ args, leaves: [2, 3, 4], target: 'dist' })
  assert.deepEqual(dist.result, src.result)
})

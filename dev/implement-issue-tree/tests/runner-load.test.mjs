// ランナーの生成物読み込み（skills/implement-issue-tree/runner/lib/load-workflow.mjs）の回帰テスト。
//
// 契約: (1) 生成物を無変更で読み、先頭の `export const meta` だけを外して AsyncFunction で評価する。
// (2) 生成物のバイト列の SHA-256 とバイト数を返す。(3) meta が無い・meta 以外の export が残る本体は拒否。
// (4) 評価結果は、既存テストの stub-run が生成物を評価した結果と同じ（同じ args・同じ偽 agent で JSON 全体が一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { trackTmp } from './lib/tmp-track.mjs'
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

// path 指定の読み込み（評価はコードの実行になるため、期待 SHA-256 とスキルディレクトリ内の制約を課す）
const GOOD = 'export const meta={a:1}\nreturn args.x'
const sha = (t) => createHash('sha256').update(t).digest('hex')
function tmpWorkflow(text) {
  const dir = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-load-'))))
  const file = join(dir, 'w.js')
  writeFileSync(file, text)
  return { dir, file }
}

test('path を指定するときは expectedSha256 が必須（無い・形が不正なら評価せず例外）', () => {
  const { file } = tmpWorkflow(GOOD)
  for (const bad of [undefined, '', 'abc', sha(GOOD).toUpperCase(), `${sha(GOOD)}0`]) {
    assert.throws(() => loadWorkflow({ path: file, expectedSha256: bad, allowOutsideSkillDir: true }), /expectedSha256/, String(bad))
  }
})

test('path 指定: SHA-256 が一致しなければ評価せず例外、一致すれば読める', async () => {
  const { file } = tmpWorkflow(GOOD)
  assert.throws(() => loadWorkflow({ path: file, expectedSha256: '0'.repeat(64), allowOutsideSkillDir: true }), /一致しない/)
  const wf = loadWorkflow({ path: file, expectedSha256: sha(GOOD), allowOutsideSkillDir: true })
  assert.equal(wf.sha256, sha(GOOD))
  assert.equal(await wf.run({ x: 7 }, () => {}, () => {}, () => {}), 7)
})

test('path 指定: スキルディレクトリの外は、テスト用フラグが無ければ拒否（SHA が一致していても）', () => {
  const { file } = tmpWorkflow(GOOD)
  assert.throws(() => loadWorkflow({ path: file, expectedSha256: sha(GOOD) }), /スキルディレクトリの外/)
})

test('path 指定: スキルディレクトリ内のシンボリックリンクが外を指していても拒否（realpath で判定）', () => {
  const { file } = tmpWorkflow(GOOD)
  const link = join(DEFAULT_WORKFLOW_PATH, '..', `.link-test-${process.pid}.js`)
  symlinkSync(file, link)
  try {
    assert.throws(() => loadWorkflow({ path: link, expectedSha256: sha(GOOD) }), /スキルディレクトリの外/)
  } finally {
    rmSync(link, { force: true })
  }
})

test('path 指定: スキルディレクトリ内の実体は読める（既定の生成物を明示パス + 期待値で）', () => {
  const raw = readFileSync(DEFAULT_WORKFLOW_PATH)
  const wf = loadWorkflow({ path: DEFAULT_WORKFLOW_PATH, expectedSha256: createHash('sha256').update(raw).digest('hex') })
  assert.equal(wf.bytes, raw.length)
})

test('既定パス: 期待値が無くても読め（SHA-256 を返して記録する）、expectedSha256 を渡せば照合する', () => {
  assert.match(loadWorkflow().sha256, /^[0-9a-f]{64}$/)
  assert.throws(() => loadWorkflow({ expectedSha256: '0'.repeat(64) }), /一致しない/)
})

// 実物の stage1（src から作る現行のビルド結果）を改名器に通し、独立の検証器で α 同値と判定されることを確かめる
// （ビルドには未接続。コミット済みの生成物は変えない）。あわせて、改名済みの参照を 1 か所ずつ差し替えた
// 決定的な変異体を検証器が全件止めること（束縛判定が実物で働いている証拠）を確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKFLOW_SCRIPT_BUDGET_BYTES } from './lib/workflow-script-contract.mjs'
import { buildStage1, mangleText, alphaVerify, refswapMutants } from './lib/mangle-harness.mjs'

const stage1 = buildStage1()
const mangledOnce = mangleText(stage1)

test('実物: 改名で縮み、予算未満・行数一致・先頭の export const meta を保つ', async () => {
  const { code, stats } = await mangledOnce
  const before = Buffer.byteLength(stage1)
  const after = Buffer.byteLength(code)
  assert.ok(after < before, `縮んでいない: ${before} → ${after}`)
  assert.ok(after < WORKFLOW_SCRIPT_BUDGET_BYTES, `予算 ${WORKFLOW_SCRIPT_BUDGET_BYTES} B を超えた: ${after}`)
  assert.equal(code.split('\n').length, stage1.split('\n').length)
  assert.match(code, /^export const meta\b/)
  assert.ok(stats.renamed > 0 && stats.renamed <= stats.bindings)
  // ランタイム注入名のうち実物が参照するものは自由変数のまま残る
  for (const n of ['agent', 'args', 'log', 'phase']) assert.ok(stats.free.includes(n), `${n} が自由変数でない`)
})

test('実物: 同じ入力から同じ出力（別プロセスで 2 回）', async () => {
  const [{ code: a }, { code: b }] = await Promise.all([mangledOnce, mangleText(stage1)])
  assert.equal(a, b)
})

test('実物: stage1 ↔ 改名器の出力が独立の検証器で α 同値（module・script の両ゴール）', async () => {
  const { code } = await mangledOnce
  const r = await alphaVerify([{ name: 'real', before: stage1, after: code }])
  assert.equal(r.get('real').ok, true, r.get('real').detail)
})

test('実物の変異: 参照を別の束縛・自由なグローバル・未宣言の名前へ 1 か所差し替えると検証器が全件止める', async () => {
  const { code } = await mangledOnce
  const mutants = await refswapMutants(code, 24, 20261116)
  assert.equal(mutants.length, 24)
  assert.deepEqual(new Set(mutants.map((m) => m.kind)), new Set(['other-binding', 'free-global', 'undeclared']))
  const r = await alphaVerify(mutants.map((m, i) => ({ name: `m${i}`, before: stage1, after: m.text })))
  const survived = mutants.filter((m, i) => r.get(`m${i}`).ok).map((m) => `${m.kind} ${m.from}→${m.to} @${m.at}`)
  assert.deepEqual(survived, [])
  // 止めた理由が束縛の判定であること（関数の名前・ソースの観測の一律の拒否は束縛の確認より後に見るので、
  // ここに当たる変異体は束縛の判定をすり抜けている）
  const byObservation = mutants.filter((m, i) => /観測し得る構文/.test(r.get(`m${i}`).detail)).map((m) => `${m.kind} ${m.from}→${m.to} @${m.at}`)
  assert.deepEqual(byObservation, [])
})

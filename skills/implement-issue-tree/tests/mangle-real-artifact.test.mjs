// 実物の stage1（src から作る現行のビルド結果）を改名器に通し、独立の検証器で α 同値と判定されることを確かめる
// （ビルドには未接続。コミット済みの生成物は変えない）。あわせて、改名済みの参照を 1 か所ずつ差し替えた
// 決定的な変異体を検証器が全件止めること（束縛判定が実物で働いている証拠）を確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKFLOW_SCRIPT_BUDGET_BYTES } from './lib/workflow-script-contract.mjs'
import { buildStage1, mangleText, alphaVerify, refswapMutants, patchKnownObservation } from './lib/mangle-harness.mjs'

const stage1 = buildStage1()
const mangledOnce = mangleText(stage1)
// 検証器の照合には、一律の拒否に当たる既知の 1 か所（h.toString(36)）を件数・offset・前後の文字列を確かめてから
// (h>>>0).toString(36) に置き換えた stage1 を使う。PR 3 で src の該当行を書き換えると件数が 0 になり
// patchKnownObservation が落ちるので、そのとき置き換えを外して stage1・mangledOnce をそのまま使う
const verifiable = patchKnownObservation(stage1)
const verifiableMangled = verifiable.then(mangleText)

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
  const before = await verifiable
  const { code } = await verifiableMangled
  const r = await alphaVerify([{ name: 'real', before, after: code }])
  assert.equal(r.get('real').ok, true, r.get('real').detail)
})

test('実物の変異: 参照を別の束縛・自由なグローバル・未宣言の名前へ 1 か所差し替えると検証器が全件止める', async () => {
  const before = await verifiable
  const { code } = await verifiableMangled
  const mutants = await refswapMutants(code, 24, 20261116)
  assert.equal(mutants.length, 24)
  assert.deepEqual(new Set(mutants.map((m) => m.kind)), new Set(['other-binding', 'free-global', 'undeclared']))
  const r = await alphaVerify(mutants.map((m, i) => ({ name: `m${i}`, before, after: m.text })))
  const survived = mutants.filter((m, i) => r.get(`m${i}`).ok).map((m) => `${m.kind} ${m.from}→${m.to} @${m.at}`)
  assert.deepEqual(survived, [])
  // 止めた理由が束縛の判定であること（関数の名前・ソースの観測の一律の拒否は束縛の確認より後に見るので、
  // ここに当たる変異体は束縛の判定をすり抜けている）
  const byObservation = mutants.filter((m, i) => /観測し得る構文/.test(r.get(`m${i}`).detail)).map((m) => `${m.kind} ${m.from}→${m.to} @${m.at}`)
  assert.deepEqual(byObservation, [])
})

test('実物の置き換え: 既知の 1 か所だけを置き換え、一律の拒否が 1 件以外・既知の箇所以外なら置き換えずに落ちる', async () => {
  const patched = await verifiable
  assert.equal(patched.split('(h>>>0).toString(36)').length, 2)
  assert.equal(patched.length, stage1.length + '(h>>>0)'.length - 'h'.length)
  // 末尾の行に足す（行数を変えない）
  const append = (text, extra) => {
    const ls = text.split('\n')
    ls[ls.length - 1] += extra
    return ls.join('\n')
  }
  await assert.rejects(patchKnownObservation(patched), /想定の形でない/) // 0 件（PR 3 で src を直した後の形）
  await assert.rejects(patchKnownObservation(append(stage1, ';use(o.name)')), /2 件（1 件のはず）/)
  await assert.rejects(patchKnownObservation(append(patched, ';use(o.toString())')), /既知の箇所でない/)
})

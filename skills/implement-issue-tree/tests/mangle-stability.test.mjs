// 安定名方式の性質のテスト: src の小さな編集で生成物の差分が玉突きで広がらないこと。
// 実物の stage1 に (1) 最上位の関数を 1 つ足す (2) 既存の関数の本体に局所を 1 つ足す 編集をして、改名後の
// 変化行を数える。iit の毎 PR の生成物の差分（Bugbot の上限・並列 PR のコンフリクト）を抑えるための契約。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStage1, mangleText, functionBodyStarts } from './lib/mangle-harness.mjs'

const stage1 = buildStage1()
const base = mangleText(stage1)

// 同じ行数の 2 テキストで内容が違う行の番号（1 始まり）
const changedLines = (a, b) => {
  const x = a.split('\n')
  const y = b.split('\n')
  assert.equal(x.length, y.length)
  return x.flatMap((l, i) => (l === y[i] ? [] : [i + 1]))
}

test('最上位の関数を 1 つ足しても、既存の行の変化はごく少数（衝突の鎖の分だけ）', async () => {
  const lines = stage1.split('\n')
  // 最後の行として足す（関数宣言は巻き上がるので位置は意味に影響しない）
  const edited = `${stage1}\nfunction addedTopLevelHelper(value){return value+1}`
  const [{ code: a }, { code: b }] = await Promise.all([base, mangleText(edited)])
  const changed = changedLines(a, b.split('\n').slice(0, lines.length).join('\n'))
  // 改名なしなら変化は足した 1 行だけ。鎖で 1 つの最上位名が動いた場合の参照行を見込んでも、全体の 1% に満たない
  assert.ok(changed.length <= Math.ceil(lines.length * 0.01), `変化行 ${changed.length} / ${lines.length}`)
})

test('関数の本体に局所を 1 つ足しても、変化はその関数の行の中に収まる', async () => {
  const fns = await functionBodyStarts(stage1)
  // 複数行にわたり局所を持つ関数を、実物の中ほどから決定的に選ぶ
  const multi = fns.filter((f) => f.endLine - f.startLine >= 5)
  assert.ok(multi.length > 0)
  const target = multi[Math.floor(multi.length / 2)]
  const edited = stage1.slice(0, target.insertAt) + 'const addedLocal=1;' + stage1.slice(target.insertAt)
  const [{ code: a }, { code: b }] = await Promise.all([base, mangleText(edited)])
  const changed = changedLines(a, b)
  assert.ok(changed.length >= 1)
  const outside = changed.filter((n) => n < target.startLine || n > target.endLine)
  assert.deepEqual(outside, [], `関数 ${target.name}（${target.startLine}〜${target.endLine} 行）の外が変わった`)
})

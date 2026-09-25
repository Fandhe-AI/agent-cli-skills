// 本文の依存宣言の機械抽出（DECLARED_DEPS_JQ・collectDeclaredDeps・mergeDeclaredDeps）の
// 決定的回帰テスト。optin-tests-gate.test.mjs と同じスライス方式（DRIVER マーカーより上を切り出し
// export を付与して import する）で、モデル出力に依存しない純粋関数と jq フィルタ自体を検証する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'implement-issue-tree.src.js',
)
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-declared-deps-'))
const slicePath = join(sliceDir, 'implement-issue-tree-declared-deps-defs.mjs')
const SLICE_EXPORTS = [
  'DECLARED_DEPS_JQ',
  'DECLARED_DEPS_MAX_PER_NODE',
  'declaredDepsPrompt',
  'collectDeclaredDeps',
  'mergeDeclaredDeps',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const {
  DECLARED_DEPS_JQ,
  DECLARED_DEPS_MAX_PER_NODE,
  declaredDepsPrompt,
  collectDeclaredDeps,
  mergeDeclaredDeps,
} = await import(pathToFileURL(slicePath).href)

// プロンプトに埋め込むのと同じ形（{number, deps}）で jq を実行する。
function runFilter(body) {
  const out = execFileSync(
    'jq',
    ['-c', `{number: .number, deps: (${DECLARED_DEPS_JQ})}`],
    { input: JSON.stringify({ number: 1, body }) },
  )
  return JSON.parse(out.toString()).deps
}

test('依存見出し節の #N を抽出し、`## 依存クレート` 等の別見出しは拾わない', () => {
  const body = [
    '## 概要', '#1 とは無関係の説明', '',
    '## 依存', '', '先行完了が必要な issue:', '', '- #78（TASK-12）', '- #85（TASK-13）', '',
    '## 依存クレート', '', '承認 issue #999 に従う',
  ].join('\n')
  assert.deepEqual(runFilter(body), [78, 85])
})

test('英語見出し・見出しレベル違い・CRLF・末尾コロンを受理する', () => {
  assert.deepEqual(runFilter('### Depends on:\r\n- #3\r\n- #2\r\n## Next\r\n- #9\r\n'), [2, 3])
  assert.deepEqual(runFilter('## Blocked by\n#7, #5\n'), [5, 7])
})

test('GitHub 流のインライン記法（Depends on #N / Blocked by #N）を節外でも抽出する', () => {
  assert.deepEqual(runFilter('本文\nDepends on #12\nblocked by: #4\nsee #100\n'), [4, 12])
})

test('インライン記法の複数番号（カンマ・読点・and 区切り）をすべて抽出する', () => {
  assert.deepEqual(runFilter('Depends on #12, #13 and #14\nBlocked by #20、#21\n'), [12, 13, 14, 20, 21])
})

test('#0 は抽出しない（assertInt で決定的に停止させないため）', () => {
  assert.deepEqual(runFilter('## 依存\n- #0\n- #5\nDepends on #0\n'), [5])
})

test('依存節内でも行頭以外の参照・関連/参考/否定の行は依存辺にしない', () => {
  assert.deepEqual(runFilter('## 依存\n\n依存なし。関連 issue #42\n'), [])
  assert.deepEqual(
    runFilter('## 依存\n- 関連: #42\n- #42（関連のみ）\n- #7（TASK-1）\n- [ ] #8\n1. #9, #10\n参考 #11\n* #12 optional\n'),
    [7, 8, 9, 10],
  )
})

test('インライン記法の否定（not / no longer）は除外し、none を含む別単語は除外しない', () => {
  assert.deepEqual(
    runFilter('Not blocked by #3\nno longer depends on #4\nnonetheless depends on #5\n'),
    [5],
  )
})

test('依存宣言がなければ空配列・body が null でも失敗しない', () => {
  assert.deepEqual(runFilter('## 概要\n#5 を参照\n'), [])
  assert.deepEqual(runFilter(null), [])
})

test('declaredDepsPrompt は整数の対象番号と jq フィルタを単一引用符で埋め込む', () => {
  const p = declaredDepsPrompt([34, 45])
  assert.match(p, /for n in 34 45; do gh issue view "\$n" --json number,body --jq '/)
  assert.ok(p.includes(DECLARED_DEPS_JQ))
  assert.ok(!DECLARED_DEPS_JQ.includes("'"), 'jq フィルタに単一引用符を含めない（シェル埋め込みが壊れる）')
})

test('declaredDepsPrompt は gh を sandbox 無効で実行する指示を含む', () => {
  assert.match(declaredDepsPrompt([1]), /sandbox 無効/)
})

test('collectDeclaredDeps: 全件返却なら missing は空・欠落は missing に出る', () => {
  const r = collectDeclaredDeps([1, 2, 3], { entries: [{ number: 1, deps: [5] }, { number: 3, deps: [] }] })
  assert.deepEqual([...r.byNumber.get(1)], [5])
  assert.deepEqual([...r.byNumber.get(3)], [])
  assert.deepEqual(r.missing, [2])
  assert.deepEqual(collectDeclaredDeps([1], null).missing, [1])
})

test('collectDeclaredDeps: 依頼外番号・非整数・上限超過は throw する', () => {
  assert.throws(() => collectDeclaredDeps([1], { entries: [{ number: 2, deps: [] }] }), /依頼外/)
  assert.throws(() => collectDeclaredDeps([1], { entries: [{ number: 1, deps: ['3'] }] }), /正の整数/)
  const many = Array.from({ length: DECLARED_DEPS_MAX_PER_NODE + 1 }, (_, i) => i + 1)
  assert.throws(() => collectDeclaredDeps([1], { entries: [{ number: 1, deps: many }] }), /上限/)
})

test('mergeDeclaredDeps: 既存 dependsOn と和集合を取り、自己参照は除く', () => {
  const nodes = [
    { number: 34, dependsOn: [] },
    { number: 91, dependsOn: [78] },
    { number: 21, dependsOn: [] },
  ]
  const added = mergeDeclaredDeps(nodes, new Map([
    [34, new Set([21])],
    [91, new Set([78, 85, 91])],
  ]))
  assert.deepEqual(nodes.map((n) => n.dependsOn), [[21], [78, 85], []])
  assert.deepEqual(added, [{ from: 34, to: 21 }, { from: 91, to: 85 }])
})

test('駆動部は Tree 検証後・byParent 構築前に抽出結果を取り込み、欠落時は停止する', () => {
  const mergeIdx = driverPart.indexOf('mergeDeclaredDeps(tree.nodes, declaredByNumber)')
  const byParentIdx = driverPart.indexOf('const byParent = new Map()')
  assert.ok(mergeIdx > 0 && byParentIdx > mergeIdx, 'depsMap の元になる byParent 構築より前に取り込むこと')
  assert.ok(driverPart.includes('本文の依存宣言を抽出できなかったイシューがある'), '欠落時の fail-closed 停止')
})

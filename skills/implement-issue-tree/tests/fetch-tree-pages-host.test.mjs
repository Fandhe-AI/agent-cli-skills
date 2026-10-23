// ツリー取得のページ経路（Issue #690）を、stub agent で実装スクリプト全体を走らせて確かめる回帰テスト。
//
// 封筒の pages が 2 以上のとき、ホストはページごとに別のエージェントで fetch-tree.sh --page を実行させ、ページの封筒で照合してから連結する
// （1 体のエージェントに全件を書き写させない）。期待する封筒は tests/lib/signed-output.mjs が node:crypto で独立に計算する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScript, BASE_ARGS } from './lib/stub-run.mjs'
import { treePagesFetchReply, treePageReply } from './lib/signed-output.mjs'

const LEAVES = [2, 3, 4, 5]
const truth = () => [
  { number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: LEAVES.length },
  ...LEAVES.map((n, i) => ({ number: n, title: `issue ${n}`, state: 'open', parent: 1, siblingIndex: i, dependsOn: [], subIssuesTotal: 0 })),
]
const chunk = (nodes, size) => Array.from({ length: Math.ceil(nodes.length / size) }, (_, i) => nodes.slice(i * size, (i + 1) * size))
const TSV = 'a'.repeat(64)
const DIR = '/tmp/iit-tree.AbC123'
const POST = /^(detect:external-checks|plan:declared-deps|plan:root-ancestors|plan:out-of-tree-deps)/
const isMain = (l) => l === 'plan:issue-tree' || l === 'plan:issue-tree-retry'
const isPage = (l) => l.startsWith('plan:issue-tree-page-')
const names = (calls) => calls.map((c) => c.opts.label)
const pageOf = (prompt) => Number(/--page (\d+)/.exec(prompt)[1])

// main: 取得の応答、page(label, prompt, pages): ページ読みの応答、release: 片づけの応答
function run({ main, page, args = BASE_ARGS, leaves = LEAVES, all = truth(), size = 2, dir = DIR } = {}) {
  const parts = chunk(all, size)
  const releases = []
  return runScript({
    args,
    leaves,
    override: (label, _opts, prompt) => {
      if (isMain(label)) return main ? main(prompt, parts) : treePagesFetchReply(prompt, all, { pages: parts.length, dir, tsvSha: TSV })
      if (isPage(label)) return page ? page(label, prompt, parts) : treePageReply(prompt, parts[pageOf(prompt) - 1], TSV)
      if (label === 'plan:issue-tree-release') { releases.push(prompt); return { ok: true } }
      return undefined
    },
  }).then((r) => ({ ...r, releases }), (e) => { e.releases = releases; throw e })
}

test('3 ページの正直な返却: ページごとのエージェントで読み、連結し、最後に片づける', async () => {
  const { result, calls, releases } = await run()
  assert.equal(result.treeFetch.pages, 3)
  assert.equal(result.treeFetch.attempts, 1)
  assert.equal(result.treeFetch.titleMismatch, false)
  const treeLabels = names(calls).filter((l) => l.startsWith('plan:issue-tree'))
  assert.equal(treeLabels[0], 'plan:issue-tree')
  assert.deepEqual(treeLabels.slice(1, 4).sort(), ['plan:issue-tree-page-1', 'plan:issue-tree-page-2', 'plan:issue-tree-page-3'])
  assert.equal(treeLabels[4], 'plan:issue-tree-release')
  assert.equal(treeLabels.length, 5)
  // 後続の agent は片づけの後に起動する
  const firstPost = names(calls).findIndex((l) => POST.test(l))
  assert.ok(firstPost > names(calls).indexOf('plan:issue-tree-release'))
  // 取得のプロンプトは --page を起動させない。ページのプロンプトは launcher 経由・単一引用符で囲んだ dir・ページごとに違う nonce
  const pagePrompts = calls.filter((c) => isPage(c.opts.label)).map((c) => c.prompt)
  const nonces = pagePrompts.map((p) => /--nonce ([0-9a-z]{28}) --page/.exec(p)[1])
  assert.equal(new Set(nonces).size, 3)
  for (const p of pagePrompts) assert.match(p, /run-verified\.sh' [0-9a-f]*\S* fetch-tree\.sh --nonce [0-9a-z]{28} --page \d+ --dir '\/tmp\/iit-tree\.AbC123'\n/)
  assert.equal(releases.length, 1)
  assert.match(releases[0], /fetch-tree\.sh --release --dir '\/tmp\/iit-tree\.AbC123'/)
})

test('1 ページだけ書き写しを誤ると、そのページだけを取り直して続行する（nonce は試行ごとに違う）', async () => {
  let n = 0
  const prompts = []
  const { result, calls } = await run({
    page: (label, prompt, parts) => {
      const p = pageOf(prompt)
      prompts.push([label, prompt])
      if (p === 2 && n++ === 0) return treePageReply(prompt, parts[1].map((x, i) => (i === 0 ? { ...x, siblingIndex: 7 } : x)), TSV, { digestNodes: parts[1] })
      return treePageReply(prompt, parts[p - 1], TSV)
    },
  })
  assert.equal(result.treeFetch.pages, 3)
  const ls = names(calls)
  assert.equal(ls.filter((l) => l === 'plan:issue-tree-page-2-retry').length, 1)
  assert.equal(ls.filter((l) => l.endsWith('-retry')).length, 1)
  const nn = (label) => /--nonce ([0-9a-z]{28})/.exec(prompts.find(([l]) => l === label)[1])[1]
  assert.notEqual(nn('plan:issue-tree-page-2'), nn('plan:issue-tree-page-2-retry'))
})

test('同じページが 2 回とも構造不一致なら停止し、後続 agent は 0 件・片づけは呼ばれる', async () => {
  const bad = (label, prompt, parts) => {
    const p = pageOf(prompt)
    if (p !== 3) return treePageReply(prompt, parts[p - 1], TSV)
    return treePageReply(prompt, parts[2].map((x) => ({ ...x, state: 'closed' })), TSV, { digestNodes: parts[2] })
  }
  await assert.rejects(run({ page: bad }).catch((e) => { assert.equal(e.releases.length, 1); throw e }), /ページ 3: .*検査値/)
  const seen = []
  await assert.rejects(runScript({ args: BASE_ARGS, leaves: LEAVES, override: (label, _o, prompt) => { seen.push(label); return isMain(label) ? treePagesFetchReply(prompt, truth(), { pages: 3, dir: DIR, tsvSha: TSV }) : isPage(label) ? bad(label, prompt, chunk(truth(), 2)) : label === 'plan:issue-tree-release' ? { ok: true } : undefined } }))
  assert.ok(!seen.some((l) => POST.test(l)))
})

test('ページの title だけの不一致は取り直しのあと警告つきで続行する（titleMismatch: true）', async () => {
  const titleOff = (label, prompt, parts) => {
    const p = pageOf(prompt)
    if (p !== 1) return treePageReply(prompt, parts[p - 1], TSV)
    return treePageReply(prompt, parts[0].map((x) => (x.number === 2 ? { ...x, title: 'issue 2 ' } : x)), TSV, { digestNodes: parts[0] })
  }
  const { result, calls, logs } = await run({ page: titleOff })
  assert.equal(result.treeFetch.titleMismatch, true)
  assert.equal(names(calls).filter((l) => l.startsWith('plan:issue-tree-page-1')).length, 2)
  assert.ok(logs.some((l) => l.includes('title の一部が取得スクリプトの出力と違う可能性')))
})

test('ページの封筒が別ページの入力に束縛されていると拒否する（流用の検出）', async () => {
  const swapped = (label, prompt, parts) => {
    const p = pageOf(prompt)
    // ページ 1 の内容を、ページ 2 の入力の束縛で返す = 別の呼び出し（別ページ）の出力の流用
    if (p === 2) return treePageReply(prompt, parts[1], TSV, { payload: { inputSha256: 'f'.repeat(64) } })
    return treePageReply(prompt, parts[p - 1], TSV)
  }
  await assert.rejects(run({ page: swapped }), /ページ 2: .*input/)
})

for (const bad of ['relative/iit-tree.x', '/tmp/iit-tree.a b', "/tmp/iit-tree.x'y", '/tmp/../iit-tree.x', '/tmp/./iit-tree.x', '/tmp/other.x', '/tmp/iit-tree.', '/tmp/iit-tree.x;rm', '']) {
  test(`dir が不正（${JSON.stringify(bad)}）ならページ読みを起動せず停止する`, async () => {
    const seen = []
    await assert.rejects(
      runScript({ args: BASE_ARGS, leaves: LEAVES, override: (label, _o, prompt) => { seen.push(label); return isMain(label) ? treePagesFetchReply(prompt, truth(), { pages: 3, dir: bad, tsvSha: TSV }) : undefined } }),
      /封筒が不正/,
    )
    assert.ok(!seen.some(isPage))
  })
}

for (const [name, payload] of [['ページ数が 31', { pages: 31 }], ['tsvSha256 が 16 進でない', { tsvSha256: 'zz' }]]) {
  test(`${name}ならページ読みを起動せず停止する`, async () => {
    const seen = []
    await assert.rejects(
      runScript({ args: BASE_ARGS, leaves: LEAVES, override: (label, _o, prompt) => { seen.push(label); return isMain(label) ? treePagesFetchReply(prompt, truth(), { pages: 3, dir: DIR, tsvSha: TSV, payload }) : label === 'plan:issue-tree-release' ? { ok: true } : undefined } }),
      /封筒が不正/,
    )
    assert.ok(!seen.some(isPage))
  })
}

test('呼び出し数の上限が小さいと、ページ読みの前の事前検査が数値つきで止める（片づけは呼ぶ）', async () => {
  const seen = []
  await assert.rejects(
    runScript({
      args: { ...BASE_ARGS, agentCallLimit: 81 },
      leaves: LEAVES,
      override: (label, _o, prompt) => { seen.push(label); return isMain(label) ? treePagesFetchReply(prompt, truth(), { pages: 30, dir: DIR, tsvSha: TSV }) : label === 'plan:issue-tree-release' ? { ok: true } : undefined },
    }),
    /必要なエージェント呼び出し数（\d+）が残り（\d+）を超える（30 ページ・5 ノード）/,
  )
  assert.ok(!seen.some(isPage))
  assert.ok(seen.includes('plan:issue-tree-release'))
})

test('ページごとの照合に通っても取得時の封筒と食い違えば、取得を取り直さずに停止する', async () => {
  const skewed = truth().map((x) => (x.number === 3 ? { ...x, siblingIndex: 9 } : x))
  const seen = []
  await assert.rejects(
    runScript({
      args: BASE_ARGS,
      leaves: LEAVES,
      override: (label, _o, prompt) => {
        seen.push(label)
        if (isMain(label)) return treePagesFetchReply(prompt, skewed, { pages: 3, dir: DIR, tsvSha: TSV })
        if (isPage(label)) return treePageReply(prompt, chunk(truth(), 2)[pageOf(prompt) - 1], TSV)
        return label === 'plan:issue-tree-release' ? { ok: true } : undefined
      },
    }),
    /連結した結果が取得時の検査値と一致しない/,
  )
  assert.ok(!seen.includes('plan:issue-tree-retry'))
  assert.ok(seen.includes('plan:issue-tree-release'))
  assert.ok(!seen.some((l) => POST.test(l)))
})

test('約 1460 ノードの合成ツリー（10 ページ）が通る。ツリー取得系のエージェントは 1 + ページ数 + 1', async () => {
  const leaves = Array.from({ length: 1459 }, (_, i) => i + 2)
  const all = [
    { number: 1, title: 'root', state: 'open', parent: 0, siblingIndex: 0, dependsOn: [], subIssuesTotal: leaves.length },
    ...leaves.map((n, i) => ({ number: n, title: `issue ${n}`, state: 'open', parent: 1, siblingIndex: i, dependsOn: [], subIssuesTotal: 0 })),
  ]
  const { result, calls } = await run({ args: { ...BASE_ARGS, dryRun: true }, leaves, all, size: 146 })
  assert.ok(result)
  assert.equal(names(calls).filter((l) => l.startsWith('plan:issue-tree')).length, 1 + 10 + 1)
})

test('1 ページのツリーではページ用・片づけ用のエージェントを起動しない', async () => {
  const { calls } = await runScript({ args: BASE_ARGS, leaves: LEAVES })
  assert.ok(!names(calls).some((l) => isPage(l) || l === 'plan:issue-tree-release'))
})

// ランナー（Codex 版）の状態ファイル読み込みの段（state:load・state:load-fill）を、ホストが状態ファイルから直接読むことの
// 回帰テスト（runner/lib/state-read.mjs と lib/agent-host.mjs）。
//
// 事象: 実機のランで、state:load のモデルが note の中の 40 桁の sha を 39 桁に写し、state:load-verify（state.sh verify の
// 項目ハッシュ）との照合が不成立になった。state:load-fill の 2 巡も同じ形で写し損ね、state-unverified のままラン終了時の
// 孤立 worktree の記録・削除が見送られた。
//
// ここでは src の loadState を、ランナーの agent-host（実物の run-verified.sh・state.sh verify を直接実行する）につないで流し、
// どの段の値もモデルの書き写しを通らないことを確かめる。偽アダプタは呼ばれたら 40 桁の sha を 39 桁に落とした値を返す
// （モデルが写し損ねる形）ので、モデルへ回った段があれば照合が不成立になる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { BASE_ARGS, importDefinitions } from './lib/stub-run.mjs'
import { makeFakeAdapterModule } from './lib/fake-adapter.mjs'
import { trackTmp } from './lib/tmp-track.mjs'
import { SCRIPT_HASH_PLACEHOLDER_RE, bundleSha256 } from '../scripts/build-workflow.mjs'
import { createAgentHost } from '../../../skills/implement-issue-tree/runner/lib/agent-host.mjs'
import { loadConfig } from '../../../skills/implement-issue-tree/runner/lib/models.mjs'

const SKILL_DIR = fileURLToPath(new URL('../../../skills/implement-issue-tree', import.meta.url))
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts')
const embedHashes = (p) => p.replace(SCRIPT_HASH_PLACEHOLDER_RE, (_m, name) => bundleSha256(SCRIPTS_DIR, name))
const PARENT = 11
const RUN_ID = 'wf_0123abcd-4ef'
const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-state-read-'))))

globalThis.args = { ...BASE_ARGS, parent: PARENT, skillDir: SKILL_DIR }
globalThis.log = () => {}
globalThis.agent = async () => ({ seedHex: '0'.repeat(64) })
const m = await importDefinitions(['ensureBoundaryNonceSeed', 'loadState', 'canonicalJson', 'sha256Hex'], 'runner-state-read')
await m.ensureBoundaryNonceSeed()

const sha = (i) => `${'0123456789abcdef'.repeat(3).slice(i % 16, (i % 16) + 32)}${String(i).padStart(8, '0')}`
// 実機の #13 の項目を模した長い note（40 桁の sha を複数・日本語・エスケープの要る文字・ソートされていないキー順）
const longNote = (i) => [
  `チェック2件成功・失敗0件。PR #${i} はマージ条件充足。`,
  `独立確認: state=MERGED / headRefOid=${sha(i)}`,
  `base=${sha(i + 1)} merge=${sha(i + 2)}`,
  'quote " backslash \\ tab \t 改行\n終わり',
].join('。。')
const ITEMS = {
  13: { type: 'implement', status: 'merged', pr: 14, branch: 'feat/13-chunk', worktree: '', fixCount: 1, note: longNote(13), outOfScopeLog: [], lastUnresolvedComments: [] },
  12: { status: 'merged', type: 'implement', pr: 15, note: longNote(12), planPolicyPaths: ['a/b.md'], pushMergeable: 'MERGEABLE' },
  11: { type: 'verify-close', status: 'closed', pr: 0, note: '子イシュー #12・#13 はすべて closed。' },
}
const STATE = { parent: PARENT, baseBranch: 'main', parallel: 2, updatedAt: '2026-11-17T12:00:00Z', perWorktreeByteReserveHighWater: 81920, perWorktreeByteReserveHighWaterVersion: 2, items: ITEMS }

let caseSeq = 0
/** メイン worktree（git でなくてよい。状態ファイルの置き場だけ使う）を作る。content が null なら書かない・文字列ならそのまま・オブジェクトなら JSON で書く。 */
function setup(content = STATE) {
  const main = join(root, `case-${++caseSeq}`)
  mkdirSync(join(main, '_', 'issue-trees'), { recursive: true })
  const file = join(main, '_', 'issue-trees', `${PARENT}.json`)
  if (content !== null) writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  return { main, file }
}

// モデルが写し損ねる形: 40 桁の 16 進を 39 桁に落とす
const corrupt = (v) => JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{40}/g, (s) => s.slice(0, 39)))

function makeHost(main, { args = { parent: PARENT } } = {}) {
  const mod = makeFakeAdapterModule({
    reply: (req) => {
      let st = null
      try { st = JSON.parse(readFileSync(join(main, '_', 'issue-trees', `${PARENT}.json`), 'utf8')) } catch { /* 無い・壊れている */ }
      const items = corrupt(st?.items ?? {})
      return /^state:load-fill/.test(req.label) ? { items } : { ok: true, fileExisted: st !== null, items, highWaterBytes: st?.perWorktreeByteReserveHighWater ?? 0, highWaterVersion: st?.perWorktreeByteReserveHighWaterVersion ?? 0 }
    },
  })
  const logs = []
  const agent = createAgentHost({ adapter: mod.createAdapter({}), cfg: { config: loadConfig(), skillDir: SKILL_DIR, mainRoot: main, runId: RUN_ID, args, log: (x) => logs.push(x) } })
  return { agent, calls: mod.calls, logs }
}

/**
 * src の loadState を host につないで流す。intercept(label, prompt, opts) が undefined 以外を返したらそれを src へ返す
 * （host へ回さない。モデルが写し損ねた state:load の再現に使う）。呼び出しの記録（label と、host へ回したか）を返す。
 */
async function runLoadState(host, intercept = () => undefined) {
  const seen = []
  globalThis.agent = async (prompt, opts) => {
    const p = embedHashes(prompt)
    const v = intercept(opts.label, p, opts)
    seen.push({ label: opts.label, prompt: p, opts, host: v === undefined })
    return v === undefined ? host.agent(p, opts) : v
  }
  try {
    return { value: await m.loadState(), seen }
  } catch (error) {
    return { error, seen }
  }
}

/** 実物の state.sh verify が返す項目ハッシュ（k → h）。 */
function verifyHashes(main) {
  const r = spawnSync('bash', [join(SCRIPTS_DIR, 'state.sh'), '--nonce', 'testnonce', '--file', `_/issue-trees/${PARENT}.json`, 'verify', '--page', '0'], { cwd: main, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.equal(env.payload.outcome, 'ok')
  return Object.fromEntries(env.payload.entries.map(({ k, h }) => [k, h]))
}

test('state:load: 40 桁の sha を複数含む長い note の項目を、モデルを起動せずに状態ファイルのまま返し、state:load-verify と全件一致する', async () => {
  const s = setup()
  const h = makeHost(s.main)
  const r = await runLoadState(h)
  assert.equal(r.error, undefined, `${r.error?.message}\n${h.logs.join('\n')}`)
  assert.equal(h.calls.length, 0, `モデル（アダプタ）を起動しない: ${h.calls.map((c) => c.label).join(', ')}`)
  assert.deepEqual(r.seen.map((x) => x.label), ['state:load', 'state:load-verify'], '照合が一致するので state:load-fill は起きない')
  assert.equal(r.value.verified, true, h.logs.join('\n'))
  assert.deepEqual(r.value.unverified, [])
  assert.deepEqual(r.value.items, JSON.parse(readFileSync(s.file, 'utf8')).items)
  assert.deepEqual(r.value.keys.sort(), ['11', '12', '13'])
  assert.equal(r.value.highWaterBytes, 81920)
  assert.equal(r.value.highWaterVersion, 2)
  // 返した値の正規形のハッシュが、実物の state.sh verify のハッシュと項目ごとに一致する
  const want = verifyHashes(s.main)
  for (const [k, v] of Object.entries(r.value.items)) assert.equal(m.sha256Hex(m.canonicalJson(v)), want[k], `#${k}`)
})

test('state:load-fill: state:load の値が欠けた・写し損ねた項目を、モデルを起動せずに状態ファイルから取り直して照合を成立させる', async () => {
  const s = setup()
  const h = makeHost(s.main)
  // state:load だけ、モデルが #13 の sha を写し損ね・#12 を読み落とした値を返したことにする
  const bad = { ok: true, fileExisted: true, items: { 13: corrupt(ITEMS[13]), 11: ITEMS[11] }, highWaterBytes: 81920, highWaterVersion: 2 }
  const r = await runLoadState(h, (label) => (label === 'state:load' ? structuredClone(bad) : undefined))
  assert.equal(r.error, undefined, `${r.error?.message}\n${h.logs.join('\n')}`)
  assert.equal(h.calls.length, 0, `モデル（アダプタ）を起動しない: ${h.calls.map((c) => c.label).join(', ')}`)
  assert.deepEqual(r.seen.filter((x) => x.host).map((x) => x.label), ['state:load-verify', 'state:load-fill'])
  assert.equal(r.value.verified, true, h.logs.join('\n'))
  assert.deepEqual(r.value.unverified, [])
  assert.deepEqual(r.value.items, JSON.parse(readFileSync(s.file, 'utf8')).items)
})

/** src が組む state:load-fill のプロンプト（前の test と同じ取り方。host は呼ばない）。 */
async function fillPrompt() {
  const s = setup()
  const h = makeHost(s.main)
  const r = await runLoadState(h, (label) => (label === 'state:load' ? { ok: true, fileExisted: true, items: {}, highWaterBytes: 0, highWaterVersion: 0 } : label.startsWith('state:load-fill') ? { items: {} } : undefined))
  const f = r.seen.find((x) => x.label === 'state:load-fill')
  assert.ok(f, 'state:load-fill が呼ばれる')
  return f
}
async function loadPrompt() {
  const r = await runLoadState(null, () => null)
  const f = r.seen.find((x) => x.label === 'state:load')
  assert.ok(f, 'state:load が呼ばれる')
  return f
}
const FILL_FAIL = { items: {} }
const LOAD_FAIL = { ok: false, fileExisted: true, items: {}, highWaterBytes: 0, highWaterVersion: 0 }

test('fail-closed: 状態ファイルが無い・壊れた JSON・形が違う・置き場の外（symlink）のとき、モデルを起動せずに照合不成立に倒れる値を返す', async () => {
  const fill = await fillPrompt()
  const load = await loadPrompt()
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'issue-trees'), { recursive: true })
  writeFileSync(join(outside, `${PARENT}.json`), JSON.stringify(STATE))
  writeFileSync(join(outside, 'issue-trees', `${PARENT}.json`), JSON.stringify(STATE))
  const cases = [
    ['壊れた JSON', () => setup('{"items": {"13": {"note": "abc"'), LOAD_FAIL],
    ['空のファイル', () => setup(''), LOAD_FAIL],
    ['JSON の値が 2 つ', () => setup('{"items":{}}\n{"items":{}}\n'), LOAD_FAIL],
    ['最上位が配列', () => setup('[]'), LOAD_FAIL],
    ['items が配列', () => setup({ items: [] }), LOAD_FAIL],
    ['高水位が文字列', () => setup({ items: ITEMS, perWorktreeByteReserveHighWater: '4096' }), LOAD_FAIL],
    ['状態ファイルが置き場の外を指す symlink', () => { const s = setup(null); symlinkSync(join(outside, `${PARENT}.json`), s.file); return s }, LOAD_FAIL],
    ['_/issue-trees が置き場の外を指す symlink', () => { const s = setup(null); rmSync(join(s.main, '_', 'issue-trees'), { recursive: true }); symlinkSync(join(outside, 'issue-trees'), join(s.main, '_', 'issue-trees')); return s }, LOAD_FAIL],
    ['状態ファイルがディレクトリ', () => { const s = setup(null); mkdirSync(s.file); return s }, LOAD_FAIL],
    ['状態ファイルが無い', () => setup(null), null],
  ]
  for (const [name, make, loadWant] of cases) {
    const s = make()
    const h = makeHost(s.main)
    assert.deepEqual(await h.agent(fill.prompt, fill.opts), FILL_FAIL, `${name}（state:load-fill）`)
    if (loadWant !== null) assert.deepEqual(await h.agent(load.prompt, load.opts), loadWant, `${name}（state:load）`)
    assert.equal(h.calls.length, 0, `${name}: モデル（アダプタ）を起動しない`)
  }
})

test('fail-closed（src の loadState まで）: 壊れた状態ファイルは state:load がモデルを介さず ok: false を返し、loadState が停止する', async () => {
  const s = setup('{"items": {')
  const h = makeHost(s.main)
  const r = await runLoadState(h)
  assert.match(String(r.error?.message), /読み込みまたは JSON パースに失敗した/)
  assert.equal(h.calls.length, 0)
})

test('読む対象を決められない（args の parent が無い・プロンプトが同じ状態ファイルを指さない）ときは何も読まずに null（モデルも起動しない）', async () => {
  const s = setup()
  const fill = await fillPrompt()
  const load = await loadPrompt()
  for (const args of [{}, { parent: 'x' }, { parent: 0 }, { parent: 1.5 }, { parent: -11 }]) {
    const h = makeHost(s.main, { args })
    assert.equal(await h.agent(load.prompt, load.opts), null, JSON.stringify(args))
    assert.equal(await h.agent(fill.prompt, fill.opts), null, JSON.stringify(args))
    assert.equal(h.calls.length, 0)
  }
  // src と同じく parent の別名 issue も受ける
  assert.deepEqual((await makeHost(s.main, { args: { issue: PARENT } }).agent(fill.prompt, fill.opts)).items, JSON.parse(readFileSync(s.file, 'utf8')).items)
  const other = makeHost(s.main, { args: { parent: PARENT + 1 } })
  assert.equal(await other.agent(load.prompt, load.opts), null, 'args の parent とプロンプトの状態ファイルが違う')
  assert.equal(other.calls.length, 0)
})

// 状態ファイルが無いときの置き場の symlink（下流の Bugbot 指摘 H04）。absent は初期化をモデルの段へ回し、置き場を書き込み可で
// 渡す経路なので、ファイルがあるときの置き場の検査と同じく bad に倒す。リンク先には状態ファイルを置かない（ファイルがある
// ときの検査とは別の経路を確かめる）
const NOFILE_OUT = join(root, 'outside-nofile')
mkdirSync(join(NOFILE_OUT, 'under', 'issue-trees'), { recursive: true })
mkdirSync(join(NOFILE_OUT, 'trees'), { recursive: true })
const newMain = (withUnderscore) => {
  const main = join(root, `case-${++caseSeq}`)
  mkdirSync(withUnderscore ? join(main, '_') : main, { recursive: true })
  return main
}

/** 状態ファイルが無く置き場が symlink のメイン worktree で、state:load・state:load-fill がモデルを起動せず照合不成立に倒れること。 */
async function assertNoFileSymlinkRefused(cases) {
  const load = await loadPrompt()
  const fill = await fillPrompt()
  for (const [name, make] of cases) {
    const main = make()
    const h = makeHost(main)
    assert.deepEqual(await h.agent(load.prompt, load.opts), LOAD_FAIL, `${name}（state:load）`)
    assert.deepEqual(await h.agent(fill.prompt, fill.opts), FILL_FAIL, `${name}（state:load-fill）`)
    assert.equal(h.calls.length, 0, `${name}: モデル（アダプタ）を起動しない`)
    assert.ok(h.logs.some((x) => x.includes('symlink')), `${name}: 理由をログに出す\n${h.logs.join('\n')}`)
  }
}

test('fail-closed（状態ファイルが無い）: `_` が symlink（外を指す・リンク先が無い）なら、初期化をモデルへ回さず照合不成立に倒れる値を返す', async () => {
  await assertNoFileSymlinkRefused([
    ['_ が外を指す symlink', () => { const main = newMain(false); symlinkSync(join(NOFILE_OUT, 'under'), join(main, '_')); return main }],
    ['_ がリンク先の無い symlink', () => { const main = newMain(false); symlinkSync(join(NOFILE_OUT, 'missing'), join(main, '_')); return main }],
  ])
})

test('fail-closed（状態ファイルが無い）: `_/issue-trees` が symlink（外を指す・リンク先が無い）なら、初期化をモデルへ回さず照合不成立に倒れる値を返す', async () => {
  await assertNoFileSymlinkRefused([
    ['_/issue-trees が外を指す symlink', () => { const main = newMain(true); symlinkSync(join(NOFILE_OUT, 'trees'), join(main, '_', 'issue-trees')); return main }],
    ['_/issue-trees がリンク先の無い symlink', () => { const main = newMain(true); symlinkSync(join(NOFILE_OUT, 'missing'), join(main, '_', 'issue-trees')); return main }],
  ])
})

test('状態ファイルが無く置き場の途中も無い（_ が無い・_ だけある）ときは従来どおり absent で、初期化をモデルの段へ回す', async () => {
  const load = await loadPrompt()
  for (const main of [newMain(false), newMain(true)]) {
    const h = makeHost(main)
    await h.agent(load.prompt, load.opts)
    assert.deepEqual(h.calls.map((c) => c.label), ['state:load'])
    assert.deepEqual(h.calls[0].writablePaths, [join(main, '_', 'issue-trees')])
  }
})

test('初回（状態ファイルが無い）の state:load だけは従来どおりモデルの段へ回し、初期化のための書き込み可パスを渡す', async () => {
  const s = setup(null)
  const load = await loadPrompt()
  const h = makeHost(s.main)
  const got = await h.agent(load.prompt, load.opts)
  assert.deepEqual(h.calls.map((c) => c.label), ['state:load'])
  assert.deepEqual(h.calls[0].writablePaths, [join(s.main, '_', 'issue-trees')])
  assert.equal(got.fileExisted, false)
})

// 状態ファイルの長い note と照合ハッシュの回帰テスト（Issue #878 追記）。
//
// 事象: 約 530〜593 文字の日本語の note を持つ項目だけが state:load の内容照合（state:load-verify の sha256 との突き合わせ）に
// 落ち、再取得 2 巡でも直らず state-unverified で着手が止まった。
// 原因の切り分け: (A) ホスト側の純 JS（canonicalJson + sha256Hex）と state.sh verify（jq -jcS + sha256sum）のハッシュが
// 長い日本語の note で食い違う（正規化のバグ）か、(B) 一致する（= 読込エージェントが長い文字列を書き写し違える）か。
// 第 1 群が (A) を決定的に判定する: 純 JS の再計算と state.sh verify は、note を含む完全な項目では一致した（= 正規化のバグではなく、
// 原因は (B) 読込エージェントの書き写し違い）。第 2 群が修正を固定する: 読込側・検証側・ホストの再計算の 3 つに同じ射影（note を除く）を
// 掛け、note を書き写させない。state.sh verify のハッシュは note の内容に依らず、ホストは返された note を捨てて照合する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { availableBashes, toolExists } from './lib/signed-output.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, '..', 'scripts', 'implement-issue-tree.src.js')
const STATE_SH = join(HERE, '..', '..', '..', 'skills', 'implement-issue-tree', 'scripts', 'state.sh')
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'
const FILE = '_/issue-trees/1.json'
const NONCE = 'abc123nonce'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
globalThis.args = { parent: 1, skillDir: '/skill' }
const sliceDir = trackTmp(mkdtempSync(join(tmpdir(), 'iit-state-note-hash-')))
const slicePath = join(sliceDir, 'defs.mjs')
writeFileSync(slicePath, `${definitionPart}\nexport { sha256Hex, canonicalJson, verifyLoadedItems, projectStateItem, capStateText, capStatePatchText, mergeStateVerify, isValidStateVerifyEnvelope, isUnchangedStatePatch }\n`)
const { sha256Hex, canonicalJson, verifyLoadedItems, projectStateItem, capStateText, capStatePatchText, mergeStateVerify, isValidStateVerifyEnvelope, isUnchangedStatePatch } = await import(slicePath)

// merge-exec・fix の要約に似た約 590 文字の note（句読点・括弧・#123・バッククォート・全角記号・引用符・バックスラッシュ・絵文字を含む）
const LONG_NOTE =
  '2 巡目の fix で codex P1（#123 の状態ファイル照合）に対応し、`state.sh verify` のハッシュと「純 JS の再計算」が一致することを確認した。' +
  '対象外としたスレッド: PRRT_kwDOAbc123（命名の整理は別 issue 〔#456〕へ）、PRRT_kwDOAbc124（※ 既存仕様どおり）。' +
  'CI は全 green（lint・unit・e2e の 3 件）、Bugbot のレビューも到着済み。squash merge は merge-exec が自己取得した mergeable=MERGEABLE を確認してから実行し、' +
  'マージ後の base 先頭が PR の head と一致することも観測した。\\n は改行ではなく文字列の「\\n」。"引用符" と \'単引用符\' と <角括弧> & アンパサンド、' +
  '全角記号（～、・、！、？、＠、＃、％）と絵文字 🚀 と結合文字（が）を含む。' +
  '後続の issue #789 は前提 #123 の完了を待って着手する。以上の経緯を踏まえ、残件はない。次の巡回で再確認する。' +
  'monitor は PR #101 の head sha を観測し、fix は 2 回、base 取り込みは 0 回で、いずれも push 済みの先端と一致した。worktree は merge-exec の後で削除済み（残置なし）。'

const makeItem = (note) => ({
  type: 'implement', status: 'merged', pr: 101, branch: 'feat/43-add-auth-api', worktree: '', fixCount: 2, baseMergeCount: 0,
  note, outOfScopeLog: ['threadId: PRRT_kwDOAbc123 / reason: 別 issue'], lastUnresolvedInfo: '', lastUnresolvedComments: [],
})

const BASHES = availableBashes()
const jq = toolExists('jq')

function stateShVerify(bash, items) {
  return Object.fromEntries(stateShVerifyEntries(bash, items).map((e) => [e.k, e.h]))
}

function stateShVerifyEntries(bash, items) {
  const root = trackTmp(mkdtempSync(join(tmpdir(), 'iit-state-note-sb-')))
  mkdirSync(join(root, '_', 'issue-trees'), { recursive: true })
  mkdirSync(join(root, 'tmp'))
  writeFileSync(join(root, FILE), JSON.stringify({ parent: 1, items }))
  const r = spawnSync(bash, [STATE_SH, '--nonce', NONCE, '--file', FILE, 'verify', '--page', '0'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: join(root, 'tmp') },
  })
  assert.equal(r.status, 0, r.stderr)
  const env = JSON.parse(r.stdout.trim())
  return env.payload.entries
}

test('前提: テストの note は 550〜650 文字', () => {
  assert.ok(LONG_NOTE.length >= 550 && LONG_NOTE.length <= 650, `長さ ${LONG_NOTE.length}`)
})

const { note: _drop, ...rest } = makeItem('')
void _drop

for (const bash of BASHES) {
  test(`[${bash}] 原因の切り分け: note を含む完全な項目の純 JS の sha256 は、jq -jcS の sha256sum と一致する（正規化のバグではない。長い note の書き写しが原因）`, { skip: !jq }, () => {
    for (const note of [LONG_NOTE, '短い note']) {
      const item = makeItem(note)
      const r2 = spawnSync(bash, ['-c', 'printf %s "$1" | jq -jcS ".a" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d" " -f1', 'x', JSON.stringify({ a: item })], { encoding: 'utf8' })
      assert.equal(r2.status, 0, r2.stderr)
      assert.equal(r2.stdout.trim(), sha256Hex(canonicalJson(item)), `note ${note.length} 文字`)
    }
  })

  test(`[${bash}] 修正: state.sh verify のハッシュは note を除いた項目のもの（note の内容・長さに依らない）で、ホストの射影後の再計算と一致する`, { skip: !jq }, () => {
    const items = { 43: makeItem(LONG_NOTE), 44: makeItem('短い note'), 45: makeItem(LONG_NOTE.slice(0, 225)), 46: makeItem('') }
    const hashes = stateShVerify(bash, items)
    for (const k of Object.keys(items)) {
      assert.equal(sha256Hex(canonicalJson(projectStateItem(items[k]))), hashes[k], `項目 ${k}`)
      assert.equal(hashes[k], sha256Hex(canonicalJson(rest)), `note 以外が同じ項目は note の内容に依らず同じハッシュ（項目 ${k}）`)
    }
    // note 欄そのものが無い項目と、note が空の項目も同じ
    const noNote = stateShVerify(bash, { 43: rest })
    assert.equal(noNote[43], hashes[43])
    // 読込エージェントが note を落として返しても、note 付きのまま返しても採用される（ホストが note を捨てて照合する）
    const check = { fileExists: true, hashes }
    for (const loaded of [Object.fromEntries(Object.keys(items).map((k) => [k, rest])), items]) {
      const r = verifyLoadedItems(loaded, check)
      assert.equal(r.verified, true)
      assert.deepEqual(r.unverified, [])
      for (const v of Object.values(r.adopted)) assert.ok(!('note' in v), '採用した項目に note を持たない（未照合の値を使わない）')
    }
    // note 以外の欄の書き換え・書き写し違いは従来どおり不一致で落ちる（fail-closed は崩れない）
    const tampered = { ...items, 43: { ...makeItem(LONG_NOTE), pr: 999 } }
    assert.deepEqual(verifyLoadedItems(tampered, check).unverified, ['43'])
    const tamperedList = { ...items, 44: { ...makeItem('x'), outOfScopeLog: ['threadId: PRRT_x / reason: 違う'] } }
    assert.deepEqual(verifyLoadedItems(tamperedList, check).unverified, ['44'])
  })
}

test('projectStateItem: note だけを除き、object でない値はそのまま返す', () => {
  assert.deepEqual(projectStateItem({ status: 'merged', note: 'x', pr: 1 }), { status: 'merged', pr: 1 })
  assert.deepEqual(projectStateItem({ status: 'merged' }), { status: 'merged' })
  for (const v of ['s', 5, null, [1, { note: 1 }]]) assert.deepEqual(projectStateItem(v), v)
})

test('状態ファイルの note は読み込み後の判断に使われない（ソースに entry/saved の note の読み出しが無い）', () => {
  assert.doesNotMatch(source, /\bsaved\??\.note\b|savedEntry\??\.note\b|savedItems\[[^\]]*\]\??\.note\b/)
})

test('state:load・state:load-fill のプロンプトは note を書き写させない（除いて返す）', () => {
  assert.ok(source.includes('各項目から note 欄は除いて返す（書き写さない'))
  assert.ok(source.includes('map_values(if type == "object" then del(.note) else . end)'))
})

for (const bash of BASHES) {
  test(`[${bash}] 読込で note を落としても、後の state.sh merge は状態ファイルの note を消さない（欄単位のマージ）`, { skip: !jq }, () => {
    const root = trackTmp(mkdtempSync(join(tmpdir(), 'iit-state-note-merge-')))
    mkdirSync(join(root, '_', 'issue-trees'), { recursive: true })
    mkdirSync(join(root, 'tmp'))
    writeFileSync(join(root, FILE), JSON.stringify({ parent: 1, items: { 43: makeItem(LONG_NOTE) } }))
    const env = { ...process.env, TMPDIR: join(root, 'tmp') }
    const patch = JSON.stringify([{ numbers: [43], patch: { status: 'closed', fixCount: 3 } }])
    const r = spawnSync(bash, [STATE_SH, '--file', FILE, 'merge'], { cwd: root, encoding: 'utf8', env, input: patch })
    assert.equal(r.status, 0, r.stderr)
    const after = JSON.parse(readFileSync(join(root, FILE), 'utf8')).items[43]
    assert.equal(after.note, LONG_NOTE)
    assert.equal(after.status, 'closed')
    assert.equal(after.fixCount, 3)
  })
}

// 第 3 群: note 以外の自由文（lastUnresolvedInfo・outOfScopeLog・lastUnresolvedComments）。再開時に復元して使うので射影からは外さず、
// 状態ファイルへ書くときに短い上限（文字単位）へ切る。
test('capStateText: 上限以内は変えず、超えたら接尾辞込みで上限ちょうどに切る。文字単位でサロゲートペアを割らず、再適用しても変わらない', () => {
  assert.equal(capStateText('短い'), '短い')
  const long = 'あ'.repeat(1000)
  const c = capStateText(long)
  assert.equal(Array.from(c).length, 300)
  assert.ok(c.endsWith('（省略）'))
  assert.equal(capStateText(c), c, '冪等')
  const emoji = '🚀'.repeat(400)
  const e = capStateText(emoji)
  assert.equal(Array.from(e).length, 300)
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(e), '孤立したサロゲートが無い')
  assert.equal(capStateText(123), 123, '文字列以外は触らない')
})

test('capStatePatchText: 3 欄だけを切り、ほかの欄・件数・threadId・url は変えない。元の patch を書き換えない', () => {
  const patch = {
    status: 'failed', pr: 7, note: 'n'.repeat(900),
    lastUnresolvedInfo: 'x'.repeat(2000),
    outOfScopeLog: ['y'.repeat(450), '（他 3 件省略）'],
    lastUnresolvedComments: [{ threadId: 'PRRT_a', text: 'z'.repeat(300), url: 'https://github.com/o/r/pull/7#x' }],
  }
  const before = JSON.stringify(patch)
  const out = capStatePatchText(patch)
  assert.equal(JSON.stringify(patch), before, '入力は不変')
  assert.equal(Array.from(out.lastUnresolvedInfo).length, 300)
  assert.equal(Array.from(out.outOfScopeLog[0]).length, 300)
  assert.equal(out.outOfScopeLog[1], '（他 3 件省略）')
  assert.equal(Array.from(out.lastUnresolvedComments[0].text).length, 200)
  assert.equal(out.lastUnresolvedComments[0].threadId, 'PRRT_a')
  assert.equal(out.lastUnresolvedComments[0].url, 'https://github.com/o/r/pull/7#x')
  assert.equal(out.note, patch.note, 'note はここでは触らない（別途射影から外している）')
  assert.equal(out.status, 'failed')
  assert.deepEqual(capStatePatchText({ status: 'x' }), { status: 'x' }, '3 欄が無い patch はそのまま')
})

test('updateStateDetailed の書き込み patch は capStatePatchText を通る（mergePatch の唯一の生成点）', () => {
  assert.match(source, /const mergePatch = capStatePatchText\(/)
  assert.equal((source.match(/patch: mergePatch/g) ?? []).length, 1)
})

// 第 4 群: 封筒の n（保存済みの note の sha256）。blocked の一括記録が「保存済みと同じ note」かを、note を読み込まずに判定するために使う
// （isUnchangedStatePatch。Issue #878 の副作用の是正）。
const NOTE_CASES = {
  長い日本語: LONG_NOTE,
  絵文字と結合文字: '🚀 が（が） 👨‍👩‍👧 🇯🇵',
  改行: '一行目\n二行目\r\n三行目',
  末尾の改行: '末尾に改行\n',
  DEL: 'a\u007fb\u007f',
  '引用符とバックスラッシュ': '"q" \\ \\n \'s\' <t> &',
  空文字: '',
}

for (const bash of BASHES) {
  test(`[${bash}] state.sh verify の n は note の生のバイト列の sha256 で、ホストの sha256Hex と一致する（長い日本語・絵文字・改行・DEL）`, { skip: !jq }, () => {
    const items = Object.fromEntries(Object.values(NOTE_CASES).map((note, i) => [String(50 + i), makeItem(note)]))
    const entries = stateShVerifyEntries(bash, items)
    assert.equal(entries.length, Object.keys(NOTE_CASES).length)
    for (const [i, note] of Object.values(NOTE_CASES).entries()) {
      const e = entries.find((x) => x.k === String(50 + i))
      assert.equal(e.n, note === '' ? sha256Hex('') : sha256Hex(note), `note ${JSON.stringify(note).slice(0, 20)}`)
    }
  })

  test(`[${bash}] state.sh verify の n: note が無い・文字列でない・項目が文字列の項目は印の -（空文字は出さない）。n は h に影響しない`, { skip: !jq }, () => {
    const items = { 60: rest, 61: { ...rest, note: 5 }, 62: { ...rest, note: null }, 63: 'text', 64: { ...rest, note: ['x'] }, 65: makeItem('x') }
    const entries = stateShVerifyEntries(bash, items)
    const byK = Object.fromEntries(entries.map((e) => [e.k, e]))
    for (const k of ['60', '61', '62', '63', '64']) assert.equal(byK[k].n, '-', `項目 ${k}`)
    assert.equal(byK[65].n, sha256Hex('x'))
    assert.equal(byK[60].h, sha256Hex(canonicalJson(rest)))
    assert.equal(byK[61].h, sha256Hex(canonicalJson(rest)), 'note が数値の項目も note を除いたハッシュ')
    assert.equal(byK[63].h, sha256Hex('text'), '項目が文字列の従来の扱いは変わらない')
  })
}

const HEX = 'a'.repeat(64)
test('isValidStateVerifyEnvelope・mergeStateVerify: n は 64 桁 16 進か空文字だけ。n が無い・不正な封筒は受理しない', () => {
  const nonce = 'abc123nonce'
  const payload = (entries) => ({ entries, highWaterBytes: 0, highWaterVersion: 0, inputSha256: sha256Hex(`${FILE}\n0`), keysCount: entries.length, keysSha256: HEX, mode: 'verify', outcome: 'ok', page: 0, pages: 1 })
  const env = (pl) => ({ nonce, payload: pl, sha256: sha256Hex(`${nonce}\n${canonicalJson(pl)}`) })
  const ok = (entries) => isValidStateVerifyEnvelope(env(payload(entries)), nonce, 0)
  assert.equal(ok([{ h: HEX, k: '1', n: HEX }]), true)
  assert.equal(ok([{ h: HEX, k: '1', n: '-' }]), true, '印の - は note なし')
  assert.equal(ok([{ h: HEX, k: '1', n: '' }]), false, '空文字は書き写しで落ちる欄なので封筒として受理しない')
  assert.equal(ok([{ h: HEX, k: '1', n: '--' }]), false)
  assert.equal(ok([{ h: HEX, k: '1' }]), false, 'n が無い旧封筒')
  assert.equal(ok([{ h: HEX, k: '1', n: 'zz' }]), false)
  assert.equal(ok([{ h: HEX, k: '1', n: 'A'.repeat(64) }]), false, '大文字は不可')
  assert.equal(ok([{ h: HEX, k: '1', n: HEX + 'a' }]), false)
  const merged = mergeStateVerify([payload([{ h: HEX, k: '1', n: HEX }, { h: HEX, k: '2', n: '-' }])])
  assert.deepEqual(merged.noteHashes, { 1: HEX, 2: '' }, '印は note なし（内部では空）。isUnchangedStatePatch は patch に note があれば変化あり')
  assert.equal(isUnchangedStatePatch({ status: 'blocked' }, { status: 'blocked', note: 'x' }, merged.noteHashes[2]), false)
  assert.equal(isUnchangedStatePatch({ status: 'blocked' }, { status: 'blocked' }, merged.noteHashes[2]), true)
  assert.equal(mergeStateVerify([payload([{ h: HEX, k: '1', n: '' }])])?.noteHashes[1], '', '合成した空文字は受理されても note なし扱い')
})

test('verifyLoadedItems: note のハッシュは照合を通った項目にだけ付き、項目そのものには混ざらない（メモリ上だけの別表）', () => {
  const items = { 43: makeItem(LONG_NOTE), 44: makeItem('短い') }
  const hashes = { 43: sha256Hex(canonicalJson(projectStateItem(items[43]))), 44: sha256Hex(canonicalJson(projectStateItem(items[44]))) }
  const noteHashes = { 43: sha256Hex(LONG_NOTE), 44: sha256Hex('短い') }
  const r = verifyLoadedItems({ 43: projectStateItem(items[43]), 44: { ...projectStateItem(items[44]), pr: 999 } }, { fileExists: true, hashes, noteHashes })
  assert.deepEqual(Object.keys(r.adoptedNoteHashes), ['43'], '不一致で落ちた 44 のハッシュは付けない')
  assert.equal(r.adoptedNoteHashes[43], sha256Hex(LONG_NOTE))
  assert.deepEqual(r.adopted[43], projectStateItem(items[43]), '採用した項目は note もハッシュも持たない')
  assert.ok(!JSON.stringify(r.adopted).includes(noteHashes[43]), '項目にハッシュが混ざらない（updateState の patch に載らない）')
  // noteHashes の無い照合入力（旧形式）でも落ちず、ハッシュなし = 書き直しに倒れる
  const old = verifyLoadedItems({ 43: projectStateItem(items[43]) }, { fileExists: true, hashes: { 43: hashes[43] } })
  assert.deepEqual(old.adoptedNoteHashes, {})
  assert.equal(isUnchangedStatePatch(old.adopted[43], { note: LONG_NOTE }, old.adoptedNoteHashes[43]), false)
})

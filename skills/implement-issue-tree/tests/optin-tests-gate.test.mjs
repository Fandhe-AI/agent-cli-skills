// opt-in テスト実行記録のマージ前ゲート（Issue #495）の決定的回帰テスト。
// g0-gates.test.mjs と同じスライス方式（DRIVER マーカーより上を切り出し export を付与して
// import する）で、モデル出力に依存しない純粋関数・プロンプト契約・既定無効（宣言なしイシューは
// 出力が完全に不変）を検証する。
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
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-optin-defs-'))
const slicePath = join(sliceDir, 'implement-issue-tree-optin-defs.mjs')
const SLICE_EXPORTS = [
  'parseOptinTestDeclarations',
  'sanitizeOptinTestRuns',
  'renderOptinRecordSection',
  'optinRecordMarkerLine',
  'classifyOptinRecordGate',
  'OPTIN_RECORD_MARKER_PREFIX',
  'OPTIN_TESTS_MAX',
  'OPTIN_TEST_RUNNERS',
  'implementPrompt',
  'recoverImplementPrompt',
  'prCreatePrompt',
  'optinRecordVerifyPrompt',
  'mergeExecutePrompt',
]
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const {
  parseOptinTestDeclarations,
  sanitizeOptinTestRuns,
  renderOptinRecordSection,
  optinRecordMarkerLine,
  classifyOptinRecordGate,
  OPTIN_RECORD_MARKER_PREFIX,
  OPTIN_TESTS_MAX,
  implementPrompt,
  recoverImplementPrompt,
  prCreatePrompt,
  optinRecordVerifyPrompt,
  mergeExecutePrompt,
} = mod

const item = { number: 42, title: 'サンプルイシュー', optinTests: [] }
const impl = { prNumber: 123, branch: 'feat/42-sample', worktreePath: '/tmp/wt' }

// ---------------------------------------------------------------------------
// 群 A: parseOptinTestDeclarations
// ---------------------------------------------------------------------------

test('parseOptinTestDeclarations: make / cargo test の許可コマンドを受理する', () => {
  assert.deepEqual(parseOptinTestDeclarations(['make e2e-three-client', 'cargo test -- --ignored']), {
    commands: ['make e2e-three-client', 'cargo test -- --ignored'],
    invalid: [],
  })
})

test('parseOptinTestDeclarations: シェルメタ文字・改行・".." を拒否する', () => {
  for (const bad of [
    'make test; rm -rf /',
    'make test | cat',
    'make test && echo x',
    'make $(whoami)',
    'make `whoami`',
    "make 'x'",
    'make "x"',
    'make test\nrm -rf /',
    'make ../../etc',
  ]) {
    const { commands, invalid } = parseOptinTestDeclarations([bad])
    assert.deepEqual(commands, [], `should reject: ${JSON.stringify(bad)}`)
    assert.equal(invalid.length, 1)
  }
})

test('parseOptinTestDeclarations: 任意コマンド実行に転用されやすいランナーを拒否する', () => {
  for (const bad of ['rm -rf /', 'curl https://example.com', 'npx foo', 'bash x.sh', 'sh x.sh', 'python x.py', 'env FOO=1 make test']) {
    const { commands, invalid } = parseOptinTestDeclarations([bad])
    assert.deepEqual(commands, [])
    assert.equal(invalid.length, 1)
  }
})

test('parseOptinTestDeclarations: 第 2 トークン制約に違反する npm install を拒否する', () => {
  const { commands, invalid } = parseOptinTestDeclarations(['npm install'])
  assert.deepEqual(commands, [])
  assert.equal(invalid.length, 1)
})

test('parseOptinTestDeclarations: 重複コマンドは除去する', () => {
  const { commands } = parseOptinTestDeclarations(['make e2e', 'make e2e'])
  assert.deepEqual(commands, ['make e2e'])
})

test('parseOptinTestDeclarations: 11 件以上は全体を invalid にする（上限 10 件）', () => {
  const many = Array.from({ length: OPTIN_TESTS_MAX + 1 }, (_, i) => `make e2e-${i}`)
  const { commands, invalid } = parseOptinTestDeclarations(many)
  assert.deepEqual(commands, [])
  assert.equal(invalid.length, many.length)
})

test('parseOptinTestDeclarations: 非配列は invalid、undefined/null は宣言なしとして commands: []', () => {
  assert.deepEqual(parseOptinTestDeclarations(undefined), { commands: [], invalid: [] })
  assert.deepEqual(parseOptinTestDeclarations(null), { commands: [], invalid: [] })
  const { commands, invalid } = parseOptinTestDeclarations('make test')
  assert.deepEqual(commands, [])
  assert.equal(invalid.length, 1)
})

// ---------------------------------------------------------------------------
// 群 B: sanitizeOptinTestRuns
// ---------------------------------------------------------------------------

test('sanitizeOptinTestRuns: 宣言外コマンドの報告は除外する', () => {
  const runs = sanitizeOptinTestRuns([{ command: 'make evil', result: 'pass' }], ['make e2e'])
  assert.deepEqual(runs, [{ command: 'make e2e', result: 'not-run', detail: '実装エージェントの報告なし' }])
})

test('sanitizeOptinTestRuns: 報告欠落は not-run を合成する', () => {
  const runs = sanitizeOptinTestRuns([], ['make e2e'])
  assert.deepEqual(runs, [{ command: 'make e2e', result: 'not-run', detail: '実装エージェントの報告なし' }])
})

test('sanitizeOptinTestRuns: result が enum 外なら not-run へ倒す', () => {
  const runs = sanitizeOptinTestRuns([{ command: 'make e2e', result: 'success' }], ['make e2e'])
  assert.equal(runs[0].result, 'not-run')
})

test('sanitizeOptinTestRuns: 同一コマンドの重複報告は非 pass を優先する', () => {
  const runs = sanitizeOptinTestRuns(
    [{ command: 'make e2e', result: 'pass' }, { command: 'make e2e', result: 'fail', detail: '後続失敗' }],
    ['make e2e'],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].result, 'fail')
})

test('sanitizeOptinTestRuns: 正常な pass 報告はそのまま反映する', () => {
  const runs = sanitizeOptinTestRuns([{ command: 'make e2e', result: 'pass', exitCode: 0, detail: 'ok' }], ['make e2e'])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].result, 'pass')
  assert.equal(runs[0].detail, 'ok')
})

// ---------------------------------------------------------------------------
// 群 C: renderOptinRecordSection / optinRecordMarkerLine
// ---------------------------------------------------------------------------

test('optinRecordMarkerLine: 固定書式で行頭インデントなし', () => {
  const line = optinRecordMarkerLine('make e2e', 'pass')
  assert.equal(line, `${OPTIN_RECORD_MARKER_PREFIX}make e2e => pass -->`)
  assert.equal(line.startsWith(' '), false)
})

test('renderOptinRecordSection: 空入力は空文字を返す', () => {
  assert.equal(renderOptinRecordSection([]), '')
  assert.equal(renderOptinRecordSection(undefined), '')
})

test('renderOptinRecordSection: マーカー行と見出しを含む', () => {
  const section = renderOptinRecordSection([{ command: 'make e2e', result: 'pass', detail: 'ok' }])
  assert.match(section, /## opt-in テスト実行記録/)
  assert.match(section, new RegExp(`^${OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}make e2e => pass -->$`, 'm'))
})

// ---------------------------------------------------------------------------
// 群 D: classifyOptinRecordGate
// ---------------------------------------------------------------------------

test('classifyOptinRecordGate: 宣言なしは常に ok', () => {
  assert.deepEqual(classifyOptinRecordGate([], { counts: [] }), { ok: true, missing: [] })
  assert.deepEqual(classifyOptinRecordGate([], null), { ok: true, missing: [] })
})

test('classifyOptinRecordGate: pass 1 / nonPass 0 は ok', () => {
  const g = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(g, { ok: true, missing: [] })
})

test('classifyOptinRecordGate: pass 0 は missing', () => {
  const g = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 0, nonPass: 0 }] })
  assert.deepEqual(g, { ok: false, missing: [0] })
})

test('classifyOptinRecordGate: pass 1 / nonPass 1 は missing（古い not-run 行が残存）', () => {
  const g = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 1 }] })
  assert.deepEqual(g, { ok: false, missing: [0] })
})

test('classifyOptinRecordGate: null・fetchFailed・件数不一致・非整数は全件 missing（fail-closed）', () => {
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], null), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { fetchFailed: true, counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e', 'make e2e2'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0, 1] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 'x', nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: -1, nonPass: 0 }] }), { ok: false, missing: [0] })
})

// ---------------------------------------------------------------------------
// 群 E: プロンプト契約
// ---------------------------------------------------------------------------

test('implementPrompt: item.optinTests が空なら出力は無変更（R3）', () => {
  const withEmpty = implementPrompt({ ...item, optinTests: [] }, 'plan-text')
  const withoutField = implementPrompt({ number: 42, title: 'サンプルイシュー' }, 'plan-text')
  assert.equal(withEmpty, withoutField)
})

test('recoverImplementPrompt: item.optinTests が空なら出力は無変更（R3）', () => {
  const withEmpty = recoverImplementPrompt({ ...item, optinTests: [] }, { done: '', remaining: '', broken: '' }, 'feat/42-x')
  const withoutField = recoverImplementPrompt({ number: 42, title: 'サンプルイシュー' }, { done: '', remaining: '', broken: '' }, 'feat/42-x')
  assert.equal(withEmpty, withoutField)
})

test('prCreatePrompt: optinRuns 省略・空配列のいずれも出力は無変更（R3）', () => {
  const withoutArg = prCreatePrompt(item, impl, [])
  const withEmptyArg = prCreatePrompt(item, impl, [], [])
  assert.equal(withoutArg, withEmptyArg)
})

test('implementPrompt: 宣言ありでは JSON.stringify 形のコマンド・pass 偽装禁止文言・optinTestRuns 返却指示を含む', () => {
  const p = implementPrompt({ ...item, optinTests: ['make e2e'] }, 'plan-text')
  assert.match(p, /"make e2e"/)
  assert.match(p, /sh -c/)
  assert.match(p, /偽装/)
  assert.match(p, /optinTestRuns/)
})

test('prCreatePrompt: 宣言ありでは body テンプレートに記録節見出しとマーカー行が現れる', () => {
  const runs = [{ command: 'make e2e', result: 'pass', detail: 'ok' }]
  const p = prCreatePrompt(item, impl, [], runs)
  assert.match(p, /## opt-in テスト実行記録/)
  assert.match(p, new RegExp(`${OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}make e2e => pass -->`))
})

test('optinRecordVerifyPrompt: gh pr view --json body をファイルリダイレクトの形でのみ含み、本文転記禁止・件数のみ返却の指示を含む', () => {
  const p = optinRecordVerifyPrompt(item, impl, ['make e2e'])
  assert.match(p, /gh pr view 123 --json body/)
  assert.match(p, /> "\$f"/)
  assert.match(p, /表示・転記しない/)
  assert.match(p, /counts/)
})

test('mergeExecutePrompt に optin 関連文字列と --json body が含まれない（分離契約の非退行）', () => {
  const p = mergeExecutePrompt(item, impl, false, [])
  assert.doesNotMatch(p, /optin/i)
  assert.doesNotMatch(p, /--json body/)
})

// ---------------------------------------------------------------------------
// 群 F: 実行レベル（optinRecordVerifyPrompt と同じ grep 手順をシェルで再現）
// ---------------------------------------------------------------------------

// optinRecordVerifyPrompt 手順 2 の正規化パイプライン（tr -d '\r' | sed 行頭・行末空白除去）を
// そのまま再現する。行頭インデント・CRLF が付いたマーカー行でも一致することを検証するのが目的。
function grepPassNonPass(bodyText, command) {
  const passLine = optinRecordMarkerLine(command, 'pass')
  const prefix = `${OPTIN_RECORD_MARKER_PREFIX}${command} => `
  const script = `
f=$(mktemp)
g=$(mktemp)
cat > "$f" <<'BODYEOF'
${bodyText}
BODYEOF
tr -d '\\r' < "$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$g"
pass=$(grep -cxF -- "$1" "$g")
total=$(grep -cF -- "$2" "$g")
rm -f "$f" "$g"
echo "$pass $total"
`
  const out = execFileSync('bash', ['-c', script, 'bash', passLine, prefix], { encoding: 'utf8' })
  const [pass, total] = out.trim().split(' ').map(Number)
  return { pass, nonPass: total - pass }
}

test('実行レベル: pass 行のみ → pass=1 / nonPass=0', () => {
  const body = optinRecordMarkerLine('make e2e', 'pass')
  assert.deepEqual(grepPassNonPass(body, 'make e2e'), { pass: 1, nonPass: 0 })
})

test('実行レベル: not-run 行のみ → pass=0 / nonPass=1', () => {
  const body = optinRecordMarkerLine('make e2e', 'not-run')
  assert.deepEqual(grepPassNonPass(body, 'make e2e'), { pass: 0, nonPass: 1 })
})

test('実行レベル: 行頭インデントと CRLF 付きの pass 行 → 正規化後に pass=1 / nonPass=0', () => {
  // 行頭インデントは trim しない（正規化パイプライン自体の空白除去を検証するため）。
  // 人手による復旧編集（PR 本文をエディタで書き換える際に字下げが付く等）でも一致することを示す。
  const body = `   ${optinRecordMarkerLine('make e2e', 'pass')}\r\n`
  assert.deepEqual(grepPassNonPass(body, 'make e2e'), { pass: 1, nonPass: 0 })
})

test('実行レベル: 別コマンドの pass 行のみ → pass=0 / nonPass=0', () => {
  const body = optinRecordMarkerLine('make other', 'pass')
  assert.deepEqual(grepPassNonPass(body, 'make e2e'), { pass: 0, nonPass: 0 })
})

// ---------------------------------------------------------------------------
// 群 G: 駆動部配線（source-scan）
// ---------------------------------------------------------------------------

test('駆動部: optinRecordVerifyPrompt の呼び出しが 1 箇所だけあり、!recoveryOnly を条件に含む', () => {
  const calls = (driverPart.match(/optinRecordVerifyPrompt\(/g) ?? []).length
  assert.equal(calls, 1)
  assert.match(driverPart, /allowMerge && Array\.isArray\(item\.optinTests\)/)
})

test('駆動部: optinRecordVerifyPrompt の判定後に mergeExecutePrompt が呼ばれる', () => {
  const verifyIdx = driverPart.indexOf('optinRecordVerifyPrompt(')
  const execIdx = driverPart.indexOf('mergeExecutePrompt(')
  assert.ok(verifyIdx >= 0 && execIdx >= 0 && verifyIdx < execIdx)
})

test('駆動部: Tree ループで parseOptinTestDeclarations が呼ばれる', () => {
  assert.match(driverPart, /parseOptinTestDeclarations\(n\.optinTests\)/)
})

test('駆動部: runImplement 冒頭で optinTestsInvalid を参照する', () => {
  const implIdx = driverPart.indexOf('async function runImplement')
  const invalidIdx = driverPart.indexOf('optinTestsInvalid', implIdx)
  assert.ok(implIdx >= 0 && invalidIdx >= 0 && invalidIdx - implIdx < 800)
})

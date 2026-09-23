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
  'validateOptinCommandForm',
  'parseOptinTestCommands',
  'parseOptinTestDeclarations',
  'sanitizeOptinTestRuns',
  'restoreOptinFixState',
  'renderOptinRecordSection',
  'optinRecordMarkerLine',
  'classifyOptinRecordGate',
  'combineOptinRecordGate',
  'OPTIN_RECORD_MARKER_PREFIX',
  'OPTIN_TESTS_MAX',
  'OPTIN_TEST_COMMANDS_MAX',
  'OPTIN_TEST_RUNNERS',
  'implementPrompt',
  'recoverImplementPrompt',
  'prCreatePrompt',
  'optinRecordVerifyPrompt',
  'mergeExecutePrompt',
  'fixPrompt',
]
// fixPrompt は boundaryNonce() を内部で使う。本番では ensureBoundaryNonceSeed() が agent() 経由で
// 乱数 seed を注入してから呼ばれるが、agent はこのスライスに未注入のため、テスト専用の setter を
// 同一モジュールスコープへ追記して非 export の module-scope let（boundaryNonceSeed）へ疑似乱数値を
// 直接注入する（conflict-prepush-gate.test.mjs / g0-gates.test.mjs と同一パターン）。
const TEST_ONLY_SETTER =
  'export function __setBoundaryNonceSeedForTest(v) { boundaryNonceSeed = v }\n'
writeFileSync(
  slicePath,
  `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n${TEST_ONLY_SETTER}`,
)

const mod = await import(pathToFileURL(slicePath).href)
const {
  validateOptinCommandForm,
  parseOptinTestCommands,
  parseOptinTestDeclarations,
  sanitizeOptinTestRuns,
  restoreOptinFixState,
  renderOptinRecordSection,
  optinRecordMarkerLine,
  classifyOptinRecordGate,
  combineOptinRecordGate,
  OPTIN_RECORD_MARKER_PREFIX,
  OPTIN_TESTS_MAX,
  OPTIN_TEST_COMMANDS_MAX,
  implementPrompt,
  recoverImplementPrompt,
  prCreatePrompt,
  optinRecordVerifyPrompt,
  mergeExecutePrompt,
  fixPrompt,
  __setBoundaryNonceSeedForTest,
} = mod
__setBoundaryNonceSeedForTest('test-seed-optin-tests-gate')

const item = { number: 42, title: 'サンプルイシュー', optinTests: [] }
const impl = { prNumber: 123, branch: 'feat/42-sample', worktreePath: '/tmp/wt' }

// ---------------------------------------------------------------------------
// 群 A0: validateOptinCommandForm / parseOptinTestCommands（args.optinTestCommands の
// 起動時検証。PR #503 codex P0 で承認一覧が唯一の実行許可根拠になったため、許可形式の
// 判定は承認一覧側で行う。宣言側（群 A）は正規化 + 完全一致のみを行う）
// ---------------------------------------------------------------------------

test('parseOptinTestCommands: make / cargo test の許可コマンドを受理する', () => {
  assert.deepEqual(parseOptinTestCommands(['make e2e-three-client', 'cargo test -- --ignored']), [
    'make e2e-three-client', 'cargo test -- --ignored',
  ])
})

test('parseOptinTestCommands: シェルメタ文字・改行・".." は起動時エラーで停止する（fail-closed）', () => {
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
    assert.throws(() => parseOptinTestCommands([bad]), /許可形式ではない/, `should throw: ${JSON.stringify(bad)}`)
  }
})

test('parseOptinTestCommands: 任意コマンド実行に転用されやすいランナーは起動時エラーで停止する', () => {
  for (const bad of ['rm -rf /', 'curl https://example.com', 'npx foo', 'bash x.sh', 'sh x.sh', 'python x.py', 'env FOO=1 make test']) {
    assert.throws(() => parseOptinTestCommands([bad]), /許可形式ではない/)
  }
})

test('parseOptinTestCommands: Go の "./..." 全パッケージ指定は受理する（".." 拒否の対象外）', () => {
  assert.deepEqual(parseOptinTestCommands(['go test ./...', 'go test ./pkg/...']), [
    'go test ./...', 'go test ./pkg/...',
  ])
})

test('parseOptinTestCommands: パス成分としての ".."（区切り直後・短オプション接着を含む）は拒否する', () => {
  for (const bad of [
    'npm test ../x',
    'pytest a/../b',
    'pytest ..',
    'cargo test --manifest-path=../x/Cargo.toml',
    'pytest --rootdir=..',
    'npm test a,../b',
    'pytest x:../y',
    // PR #503 Bugbot Medium: 短オプションに接着した ".."（区切り文字の列挙ではすり抜ける）。
    'make -C..',
    'pytest -I../x',
  ]) {
    assert.throws(() => parseOptinTestCommands([bad]), /許可形式ではない/, `should throw: ${JSON.stringify(bad)}`)
  }
})

test('parseOptinTestCommands: mvn の GAV 形式ゴール指定は起動時エラーで停止する（Issue #495 監査 Medium B）', () => {
  for (const bad of [
    'mvn org.codehaus.mojo:exec-maven-plugin:exec',
    'mvn test org.codehaus.mojo:exec-maven-plugin:exec',
  ]) {
    assert.throws(() => parseOptinTestCommands([bad]), /許可形式ではない/)
  }
  assert.deepEqual(parseOptinTestCommands(['mvn test', 'mvn verify -DskipITs=true', 'gradle test']), [
    'mvn test', 'mvn verify -DskipITs=true', 'gradle test',
  ])
})

test('parseOptinTestCommands: deno のリモート指定子（npm: / jsr: / http: / https:）は起動時エラーで停止する（Issue #495 監査 追加 C）', () => {
  for (const bad of ['deno test npm:some-pkg', 'deno test jsr:@x/y', 'deno test https://example.com/x.ts', 'deno test --importmap=https://example.com/map.json']) {
    assert.throws(() => parseOptinTestCommands([bad]), /許可形式ではない/)
  }
})

test('parseOptinTestCommands: 第 2 トークン制約に違反する npm install は起動時エラーで停止する', () => {
  assert.throws(() => parseOptinTestCommands(['npm install']), /許可形式ではない/)
})

test('parseOptinTestCommands: 重複コマンドは除去する', () => {
  assert.deepEqual(parseOptinTestCommands(['make e2e', 'make e2e']), ['make e2e'])
})

test('parseOptinTestCommands: 21 件以上は起動時エラーで停止する（上限 20 件）', () => {
  const many = Array.from({ length: OPTIN_TEST_COMMANDS_MAX + 1 }, (_, i) => `make e2e-${i}`)
  assert.throws(() => parseOptinTestCommands(many), /要素数が多すぎる/)
})

test('parseOptinTestCommands: 未指定（undefined / null）は空配列、非配列は throw', () => {
  assert.deepEqual(parseOptinTestCommands(undefined), [])
  assert.deepEqual(parseOptinTestCommands(null), [])
  assert.throws(() => parseOptinTestCommands('make test'), /文字列配列で指定/)
})

test('validateOptinCommandForm: 妥当な値は { ok: true, value } を返す。非文字列は { ok: false }', () => {
  assert.deepEqual(validateOptinCommandForm('make e2e'), { ok: true, value: 'make e2e' })
  assert.deepEqual(validateOptinCommandForm(123), { ok: false })
  assert.deepEqual(validateOptinCommandForm(null), { ok: false })
})

// ---------------------------------------------------------------------------
// 群 A: parseOptinTestDeclarations（イシュー本文の宣言 → 承認一覧との正規化後の
// 文字列完全一致でのみ採用。PR #503 codex P0）
// ---------------------------------------------------------------------------

test('parseOptinTestDeclarations: 承認一覧と完全一致する宣言のみ採用する', () => {
  assert.deepEqual(
    parseOptinTestDeclarations(['make e2e-three-client', 'cargo test -- --ignored'], ['make e2e-three-client', 'cargo test -- --ignored']),
    { commands: ['make e2e-three-client', 'cargo test -- --ignored'], invalid: [] },
  )
})

test('parseOptinTestDeclarations: 承認一覧が未指定 / 空の場合、宣言があれば全件 invalid（fail-closed）', () => {
  for (const approved of [undefined, null, []]) {
    const { commands, invalid } = parseOptinTestDeclarations(['make e2e'], approved)
    assert.deepEqual(commands, [])
    assert.equal(invalid.length, 1)
  }
})

test('parseOptinTestDeclarations: 承認一覧に無い宣言は invalid（形式が正しくても採用しない。PR #503 codex P0）', () => {
  const approved = ['make e2e']
  for (const bad of ['make deploy', 'npm run release', 'go test -exec=x ./...']) {
    const { commands, invalid } = parseOptinTestDeclarations([bad], approved)
    assert.deepEqual(commands, [], `should reject: ${JSON.stringify(bad)}`)
    assert.equal(invalid.length, 1)
  }
})

test('parseOptinTestDeclarations: 正規化（前後空白除去・水平空白の畳み込み）後に一致すれば採用する', () => {
  const { commands, invalid } = parseOptinTestDeclarations(['  make   e2e  '], ['make e2e'])
  assert.deepEqual(commands, ['make e2e'])
  assert.deepEqual(invalid, [])
})

test('parseOptinTestDeclarations: 垂直空白を含む宣言は承認一覧に一致し得る文字列であっても invalid', () => {
  const { commands, invalid } = parseOptinTestDeclarations(['make\ne2e'], ['make\ne2e'])
  assert.deepEqual(commands, [])
  assert.equal(invalid.length, 1)
})

test('parseOptinTestDeclarations: 重複宣言は除去する', () => {
  const { commands } = parseOptinTestDeclarations(['make e2e', 'make e2e'], ['make e2e'])
  assert.deepEqual(commands, ['make e2e'])
})

test('parseOptinTestDeclarations: 11 件以上一致すると全体を invalid にする（上限 10 件）', () => {
  const many = Array.from({ length: OPTIN_TESTS_MAX + 1 }, (_, i) => `make e2e-${i}`)
  const { commands, invalid } = parseOptinTestDeclarations(many, many)
  assert.deepEqual(commands, [])
  assert.equal(invalid.length, many.length)
})

test('parseOptinTestDeclarations: 非配列は invalid、undefined/null は宣言なしとして commands: []（承認一覧の有無によらない）', () => {
  assert.deepEqual(parseOptinTestDeclarations(undefined, ['make e2e']), { commands: [], invalid: [] })
  assert.deepEqual(parseOptinTestDeclarations(null, ['make e2e']), { commands: [], invalid: [] })
  const { commands, invalid } = parseOptinTestDeclarations('make test', ['make test'])
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
// 群 D2: combineOptinRecordGate（Issue #495 Medium 2 — post-push fix の実測による PR 本文ゲートの上書き）
// ---------------------------------------------------------------------------

test('combineOptinRecordGate: fix の opt-in 結果が fail のとき、PR 本文ゲートが ok でも不合格にする', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const fixOptinRuns = [{ command: 'make e2e', result: 'fail', detail: '' }]
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptinRuns), { ok: false, missing: [0] })
})

test('combineOptinRecordGate: fix の opt-in 結果が全 pass なら PR 本文ゲートの判定をそのまま使う（従来判定）', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const fixOptinRuns = [{ command: 'make e2e', result: 'pass', detail: '' }]
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptinRuns), bodyGateOk)

  const bodyGateMissing = { ok: false, missing: [0] }
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, fixOptinRuns), bodyGateMissing)
})

test('combineOptinRecordGate: fix 未実施（null）は PR 本文ゲートの判定のみに委ねる', () => {
  const bodyGateOk = { ok: true, missing: [] }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, null), bodyGateOk)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, []), bodyGateOk)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, undefined), bodyGateOk)
})

test('combineOptinRecordGate: 結果欠落（not-run 補完・報告なし相当）は不合格として扱う', () => {
  const bodyGateOk = { ok: true, missing: [] }
  // sanitizeOptinTestRuns が報告欠落を not-run で補完した形を模す。
  const fixOptinRuns = [
    { command: 'make e2e', result: 'not-run', detail: '実装エージェントの報告なし' },
  ]
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptinRuns), { ok: false, missing: [0] })
})

test('combineOptinRecordGate: PR 本文ゲートと fix 実測の missing 集合を重複排除して統合する', () => {
  const bodyGateMissing = { ok: false, missing: [1] }
  const fixOptinRuns = [
    { command: 'make e2e', result: 'fail', detail: '' },
    { command: 'make e2e2', result: 'pass', detail: '' },
  ]
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, fixOptinRuns), { ok: false, missing: [0, 1] })
})

// ---------------------------------------------------------------------------
// 群 D3: restoreOptinFixState（optinFixState の状態ファイル復元。PR #503 2 巡目 codex P0）
// ---------------------------------------------------------------------------

test('restoreOptinFixState: 宣言なしは常に null（ゲート自体が無効）', () => {
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: true, runs: [] } }, []), null)
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: true, runs: [] } }, undefined), null)
})

test('restoreOptinFixState: optinFixState が無い・attempted が true でない場合は null（fix 未実施）', () => {
  assert.equal(restoreOptinFixState({}, ['make e2e']), null)
  assert.equal(restoreOptinFixState({ optinFixState: null }, ['make e2e']), null)
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: false, runs: [] } }, ['make e2e']), null)
  assert.equal(restoreOptinFixState(undefined, ['make e2e']), null)
})

test('restoreOptinFixState: 永続化した pass 記録をラウンドトリップで復元する', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }] } }
  assert.deepEqual(restoreOptinFixState(saved, ['make e2e']), [{ command: 'make e2e', result: 'pass', detail: '' }])
})

test('restoreOptinFixState: attempted: true なのに runs が欠落・非配列なら宣言全件を not-run へ倒す（fail-closed）', () => {
  for (const state of [{ attempted: true }, { attempted: true, runs: null }, { attempted: true, runs: 'x' }]) {
    const restored = restoreOptinFixState({ optinFixState: state }, ['make e2e', 'cargo test'])
    assert.deepEqual(restored.map((r) => [r.command, r.result]), [['make e2e', 'not-run'], ['cargo test', 'not-run']])
  }
})

test('restoreOptinFixState: 宣言外の永続化コマンドは復元後の一覧から落ち、宣言済みで欠落しているものは not-run 補完する', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make old', result: 'pass', detail: '' }] } }
  const restored = restoreOptinFixState(saved, ['make new'])
  assert.deepEqual(restored, [{ command: 'make new', result: 'not-run', detail: '実装エージェントの報告なし' }])
})

test('統合: 再開後に永続化した fix 実測が fail のまま残っていれば PR 本文が pass でもゲート不合格', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'fail', detail: 'timeout' }] } }
  const restored = restoreOptinFixState(saved, ['make e2e'])
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored), { ok: false, missing: [0] })
})

test('統合: fix 実施済みで復元不能（state 破損）なら PR 本文が pass でもゲート不合格', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true } }, ['make e2e'])
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored), { ok: false, missing: [0] })
})

test('統合: fix 未実施の再開は従来どおり PR 本文のみで判定する（restoreOptinFixState が null を返す）', () => {
  const restored = restoreOptinFixState({}, ['make e2e'])
  assert.equal(restored, null)
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored), bodyGateOk)
  const bodyGateMissing = classifyOptinRecordGate(['make e2e'], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, restored), bodyGateMissing)
})

test('統合: 宣言なしイシューは再開後も restoreOptinFixState が null を返し combineOptinRecordGate は無介入', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'fail', detail: '' }] } }, [])
  assert.equal(restored, null)
  const bodyGateOk = classifyOptinRecordGate([], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored), bodyGateOk)
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
// 群 E2: fixPrompt の opt-in テスト再検証（Issue #495 Medium 指摘の回帰）
//
// post-push fix（pushAfterFix: true）はコード（opt-in テストが検証する挙動を含む）を変更しうるが、
// renderOptinRecordSection は prCreatePrompt でしか呼ばれず、修正後に PR 本文の pass 記録が
// 再検証されないまま残ると、マージ前ゲートが陳腐化した記録を見て通過してしまう。
// ---------------------------------------------------------------------------

const finding = { summary: '指摘内容のサンプル', unresolvedComments: [] }

test('fixPrompt: pushAfterFix=true かつ optinTests 宣言ありでは再実行手順・pass 偽装禁止・PR 本文更新指示を含む', () => {
  const p = fixPrompt({ ...item, optinTests: ['make e2e'] }, impl, finding, true)
  assert.match(p, /"make e2e"/)
  assert.match(p, /偽装/)
  assert.match(p, /optinTestRuns/)
  // PR 本文の既存マーカー行を除去してから記録節を書き直す指示（陳腐化した pass の残存防止）。
  assert.match(p, new RegExp(OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(p, /pushed: true と確認できた場合のみ実行する/)
  assert.match(p, /gh pr edit 123 --body-file/)
})

test('fixPrompt: pushAfterFix=true でも optinTests が空なら出力は無変更（R3 と同じ既定無効方針）', () => {
  const withEmpty = fixPrompt({ ...item, optinTests: [] }, impl, finding, true)
  const withoutField = fixPrompt({ number: 42, title: 'サンプルイシュー' }, impl, finding, true)
  assert.equal(withEmpty, withoutField)
})

test('fixPrompt: pushAfterFix=false（push 前 Review ループ）では optinTests 宣言ありでも再実行手順を含まない（記録節が未作成のため対象外）', () => {
  const p = fixPrompt({ ...item, optinTests: ['make e2e'] }, impl, finding, false)
  assert.doesNotMatch(p, /optinTestRuns/)
  assert.doesNotMatch(p, new RegExp(OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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

test('駆動部: Tree ループで parseOptinTestDeclarations が承認一覧 optinTestCommandsInput 付きで呼ばれる（PR #503 codex P0）', () => {
  assert.match(driverPart, /parseOptinTestDeclarations\(n\.optinTests, optinTestCommandsInput\)/)
})

test('駆動部: optinTestCommandsInput（args.optinTestCommands の起動時検証）が OPTIN_TEST_RUNNER_SUBCOMMANDS 等より後で初期化される（TDZ 回避）', () => {
  // TDZ トラップ: optinTestCommandsInput の初期化式（parseOptinTestCommands 呼び出し）は
  // OPTIN_TEST_COMMAND_RE・OPTIN_TEST_RUNNERS・OPTIN_TEST_RUNNER_SUBCOMMANDS を間接参照する
  // validateOptinCommandForm を呼ぶ。これらの const がまだ TDZ の Bootstrap セクション
  // （section 1）で定義・呼び出しを行うと、実 args が渡された時点で ReferenceError になる
  // （このテストスライスは parsedArgs が undefined のため早期 return して顕在化しない）。
  // ソース上の定義順を機械検証することで、この非顕在化パターンでの退行を検知する。
  const constIdx = definitionPart.indexOf('const optinTestCommandsInput')
  const subcommandsIdx = definitionPart.indexOf('const OPTIN_TEST_RUNNER_SUBCOMMANDS')
  assert.ok(constIdx >= 0 && subcommandsIdx >= 0)
  assert.ok(constIdx > subcommandsIdx, 'optinTestCommandsInput は OPTIN_TEST_RUNNER_SUBCOMMANDS より後で初期化されなければならない（TDZ 回避）')
})

test('駆動部: runImplement 冒頭で optinTestsInvalid を参照する', () => {
  const implIdx = driverPart.indexOf('async function runImplement')
  const invalidIdx = driverPart.indexOf('optinTestsInvalid', implIdx)
  assert.ok(implIdx >= 0 && invalidIdx >= 0 && invalidIdx - implIdx < 800)
})

test('駆動部: post-push fix 直後の updateState が optinFixState を含む（PR #503 2 巡目 codex P0）', () => {
  assert.match(driverPart, /optinFixStatePatch = \{ attempted: true, runs: fixOptinRuns \}/)
  assert.match(driverPart, /updateState\(item\.number, \{ fixCount, baseMergeCount, worktree: currentWorktreePath,/)
  assert.match(driverPart, /optinFixState: optinFixStatePatch \}, \{ cleanupWorktree: oldWorktreePath \}\)/)
})

test('駆動部: monitoring 再開パスが restoreOptinFixState(saved, item.optinTests) を runMergeLoop の initialFixOptinRuns へ渡す', () => {
  assert.match(driverPart, /restoreOptinFixState\(saved, item\.optinTests\)/)
})

test('駆動部: runMergeLoop の lastFixOptinRuns 初期値は initialFixOptinRuns を引き継ぐ（null 固定ではない）', () => {
  assert.match(driverPart, /let lastFixOptinRuns = initialFixOptinRuns/)
})

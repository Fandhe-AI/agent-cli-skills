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
  'optinRecordRemovalShellLines',
  'classifyOptinRecordGate',
  'combineOptinRecordGate',
  'isOptinLatchActive',
  'optinDeclarationFormatHint',
  'optinInvalidWarningLine',
  'OPTIN_RECORD_MARKER_PREFIX',
  'OPTIN_RECORD_END_MARKER',
  'OPTIN_TESTS_MAX',
  'OPTIN_TEST_COMMANDS_MAX',
  'OPTIN_TEST_RUNNERS',
  'OPTIN_TEST_RUNNER_SUBCOMMANDS',
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
  optinRecordRemovalShellLines,
  classifyOptinRecordGate,
  combineOptinRecordGate,
  isOptinLatchActive,
  optinDeclarationFormatHint,
  optinInvalidWarningLine,
  OPTIN_RECORD_MARKER_PREFIX,
  OPTIN_RECORD_END_MARKER,
  OPTIN_TESTS_MAX,
  OPTIN_TEST_COMMANDS_MAX,
  OPTIN_TEST_RUNNERS,
  OPTIN_TEST_RUNNER_SUBCOMMANDS,
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

// テスト全体で使う 2 つの区別可能な 40 桁 sha（PR #503 3 巡目 codex P1 のマーカー sha 束縛テスト用）。
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

test('optinRecordMarkerLine: 固定書式で行頭インデントなし（sha が先頭・PR #503 3 巡目 codex P1）', () => {
  const line = optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')
  assert.equal(line, `${OPTIN_RECORD_MARKER_PREFIX}${SHA_A} pass make e2e -->`)
  assert.equal(line.startsWith(' '), false)
})

test('renderOptinRecordSection: 空入力は空文字を返す', () => {
  assert.equal(renderOptinRecordSection([]), '')
  assert.equal(renderOptinRecordSection(undefined), '')
})

test('renderOptinRecordSection: <sha>/<result> プレースホルダ付きのマーカー行と見出しを含む（テンプレート化。PR #503 3 巡目 codex P1）', () => {
  const section = renderOptinRecordSection(['make e2e'])
  assert.match(section, /## opt-in テスト実行記録/)
  assert.match(section, new RegExp(`^${OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<sha> <result> make e2e -->$`, 'm'))
})

test('renderOptinRecordSection: 節の実際の最終行が終端マーカーと完全一致する（PR #504 codex P0: 削除側が機械生成区間を本文末尾として一意に識別する境界）', () => {
  const section = renderOptinRecordSection(['make e2e'])
  const lines = section.split('\n')
  assert.equal(lines[lines.length - 1], OPTIN_RECORD_END_MARKER)
})

// ---------------------------------------------------------------------------
// 群 D: classifyOptinRecordGate
// ---------------------------------------------------------------------------

test('classifyOptinRecordGate: 宣言なしは常に ok', () => {
  assert.deepEqual(classifyOptinRecordGate([], { headRefOid: SHA_A, counts: [] }), { ok: true, missing: [] })
  assert.deepEqual(classifyOptinRecordGate([], null), { ok: true, missing: [] })
})

test('classifyOptinRecordGate: headRefOid 妥当・pass 1 / nonPass 0 は ok', () => {
  const g = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(g, { ok: true, missing: [] })
})

test('classifyOptinRecordGate: pass 0 は missing', () => {
  const g = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 0, nonPass: 0 }] })
  assert.deepEqual(g, { ok: false, missing: [0] })
})

test('classifyOptinRecordGate: pass 1 / nonPass 1 は missing（古い not-run 行が残存）', () => {
  const g = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 1 }] })
  assert.deepEqual(g, { ok: false, missing: [0] })
})

test('classifyOptinRecordGate: null・fetchFailed・件数不一致・非整数は全件 missing（fail-closed）', () => {
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], null), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, fetchFailed: true, counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e', 'make e2e2'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0, 1] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 'x', nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: -1, nonPass: 0 }] }), { ok: false, missing: [0] })
})

test('classifyOptinRecordGate: headRefOid が空・形式不正なら counts が pass 1/nonPass 0 でも全件 missing（PR #503 3 巡目 codex P1）', () => {
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: '', counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: 'not-a-sha', counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
  assert.deepEqual(classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A.toUpperCase(), counts: [{ index: 0, pass: 1, nonPass: 0 }] }), { ok: false, missing: [0] })
})

// ---------------------------------------------------------------------------
// 群 D2: combineOptinRecordGate（Issue #495 Medium 2 → PR #503 3 巡目 codex P1 で sha 束縛を追加。
// post-push fix の実測による PR 本文ゲートの上書きは、fixOptin.headSha が gateHeadSha と一致する
// 場合のみ働く）
// ---------------------------------------------------------------------------

test('combineOptinRecordGate: fixOptin.headSha が gateHeadSha と一致し、fix の結果が fail のとき、PR 本文ゲートが ok でも不合格にする', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const fixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_A), { ok: false, missing: [0] })
})

test('combineOptinRecordGate: headSha が一致しても fix の結果が全 pass なら PR 本文ゲートの判定をそのまま使う（従来判定）', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const fixOptin = { runs: [{ command: 'make e2e', result: 'pass', detail: '' }], headSha: SHA_A }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_A), bodyGateOk)

  const bodyGateMissing = { ok: false, missing: [0] }
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, fixOptin, SHA_A), bodyGateMissing)
})

test('combineOptinRecordGate: fix 未実施（null）は PR 本文ゲートの判定のみに委ねる', () => {
  const bodyGateOk = { ok: true, missing: [] }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, null, SHA_A), bodyGateOk)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, { runs: [], headSha: SHA_A }, SHA_A), bodyGateOk)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, undefined, SHA_A), bodyGateOk)
})

test('combineOptinRecordGate: fixOptin.headSha が gateHeadSha と不一致（HEAD がさらに進んだ）なら override せず gate をそのまま返す（PR #503 3 巡目 codex P1・可用性）', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const staleFixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A }
  // gate は現在の HEAD（SHA_B）に対する検証結果。古い HEAD（SHA_A）の fix 実測は無関係。
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, staleFixOptin, SHA_B), bodyGateOk)
})

test('combineOptinRecordGate: fixOptin.headSha が未報告（空文字）なら override しない', () => {
  const bodyGateOk = { ok: true, missing: [] }
  const fixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: '' }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_A), bodyGateOk)
})

test('combineOptinRecordGate: headSha 一致時、結果欠落（not-run 補完・報告なし相当）は不合格として扱う', () => {
  const bodyGateOk = { ok: true, missing: [] }
  // sanitizeOptinTestRuns が報告欠落を not-run で補完した形を模す。
  const fixOptin = { runs: [{ command: 'make e2e', result: 'not-run', detail: '実装エージェントの報告なし' }], headSha: SHA_A }
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_A), { ok: false, missing: [0] })
})

test('combineOptinRecordGate: headSha 一致時、PR 本文ゲートと fix 実測の missing 集合を重複排除して統合する', () => {
  const bodyGateMissing = { ok: false, missing: [1] }
  const fixOptin = {
    runs: [
      { command: 'make e2e', result: 'fail', detail: '' },
      { command: 'make e2e2', result: 'pass', detail: '' },
    ],
    headSha: SHA_A,
  }
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, fixOptin, SHA_A), { ok: false, missing: [0, 1] })
})

// ---------------------------------------------------------------------------
// 群 D3: restoreOptinFixState（optinFixState の状態ファイル復元。PR #503 2 巡目 codex P0 →
// 3 巡目で { runs, headSha } を返すよう拡張）
// ---------------------------------------------------------------------------

test('restoreOptinFixState: 宣言なしは常に null（ゲート自体が無効）', () => {
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: true, runs: [], headSha: SHA_A } }, []), null)
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: true, runs: [], headSha: SHA_A } }, undefined), null)
})

test('restoreOptinFixState: optinFixState が無い・attempted が true でない場合は null（fix 未実施）', () => {
  assert.equal(restoreOptinFixState({}, ['make e2e']), null)
  assert.equal(restoreOptinFixState({ optinFixState: null }, ['make e2e']), null)
  assert.equal(restoreOptinFixState({ optinFixState: { attempted: false, runs: [], headSha: SHA_A } }, ['make e2e']), null)
  assert.equal(restoreOptinFixState(undefined, ['make e2e']), null)
})

test('restoreOptinFixState: 永続化した pass 記録と headSha をラウンドトリップで復元する（unbound: false）', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }], headSha: SHA_A } }
  assert.deepEqual(restoreOptinFixState(saved, ['make e2e']), {
    runs: [{ command: 'make e2e', result: 'pass', detail: '' }],
    headSha: SHA_A,
    unbound: false,
  })
})

test('restoreOptinFixState: attempted: true なのに runs が欠落・非配列なら宣言全件を not-run へ倒し unbound: true にする（fail-closed）', () => {
  for (const state of [{ attempted: true, headSha: SHA_A }, { attempted: true, runs: null, headSha: SHA_A }, { attempted: true, runs: 'x', headSha: SHA_A }]) {
    const restored = restoreOptinFixState({ optinFixState: state }, ['make e2e', 'cargo test'])
    assert.deepEqual(restored.runs.map((r) => [r.command, r.result]), [['make e2e', 'not-run'], ['cargo test', 'not-run']])
    assert.equal(restored.headSha, '')
    assert.equal(restored.unbound, true)
  }
})

test('restoreOptinFixState: headSha 自体を確定できない場合、runs が有効な pass 記録でも宣言全件 not-run + unbound: true へ倒す（セキュリティ監査 Medium: restore 後も不合格を維持）', () => {
  for (const state of [
    { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }] }, // headSha 自体が無い（旧形式の永続化）
    { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }], headSha: '' },
    { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }], headSha: 'not-a-sha' },
  ]) {
    const restored = restoreOptinFixState({ optinFixState: state }, ['make e2e'])
    assert.deepEqual(restored, {
      runs: [{ command: 'make e2e', result: 'not-run', detail: '状態ファイルから post-push fix の opt-in 実測（対象 HEAD sha を含む）を復元できなかった（再開時の fail-closed）' }],
      headSha: '',
      unbound: true,
    })
  }
})

test('restoreOptinFixState: 宣言外の永続化コマンドは復元後の一覧から落ち、宣言済みで欠落しているものは not-run 補完する（unbound: false）', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make old', result: 'pass', detail: '' }], headSha: SHA_A } }
  const restored = restoreOptinFixState(saved, ['make new'])
  assert.deepEqual(restored, { runs: [{ command: 'make new', result: 'not-run', detail: '実装エージェントの報告なし' }], headSha: SHA_A, unbound: false })
})

test('統合: 再開後に永続化した fix 実測が現在の HEAD に対して fail のまま残っていれば PR 本文が pass でもゲート不合格', () => {
  const saved = { optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'fail', detail: 'timeout' }], headSha: SHA_A } }
  const restored = restoreOptinFixState(saved, ['make e2e'])
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, SHA_A), { ok: false, missing: [0] })
})

test('統合: fix 実施済みで復元不能（state 破損・headSha も無し）なら unbound: true が無条件 override し、gate 自身の sha 束縛判定に関わらず不合格にする', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true } }, ['make e2e'])
  assert.equal(restored.headSha, '')
  assert.equal(restored.unbound, true)
  // PR 本文側は headRefOid を確認できないラウンド（fetchFailed 相当）を模す。
  const bodyGateFail = classifyOptinRecordGate(['make e2e'], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateFail, restored, ''), { ok: false, missing: [0] })
})

test('統合（セキュリティ監査 Medium の核心）: optinHeadSha 欠落で unbound: true になった実測は、PR 本文が現在の HEAD sha で pass していても override してゲート不合格にする', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'pass', detail: '' }] } }, ['make e2e'])
  assert.equal(restored.unbound, true)
  // PR 本文は現在の HEAD（SHA_B）に対して正しく pass 記録がある状態（bodyGateOk）を模す。
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_B, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, SHA_B), { ok: false, missing: [0] })
})

test('統合（セキュリティ監査 Medium・ライブ経路）: post-push fix が optinHeadSha を報告しなかった場合と同じ形の { runs, headSha: \'\', unbound: true } を直接渡しても、PR 本文が pass の HEAD で override して不合格にする', () => {
  // runMergeLoop の f.pushed === true かつ fixHeadSha が空のときに組み立てる lastFixOptin の
  // 実際の形（restoreOptinFixState を経由しないライブ経路）をそのまま模す。
  const liveUnboundFixOptin = {
    runs: [{ command: 'make e2e', result: 'not-run', detail: 'post-push fix が対象 HEAD sha（optinHeadSha）を報告しなかった、または不正な値だった（fail-closed）' }],
    headSha: '',
    unbound: true,
  }
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_B, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, liveUnboundFixOptin, SHA_B), { ok: false, missing: [0] })

  // 上と同じ形をそのまま optinFixState として永続化 → restore しても unbound: true が維持され、
  // 同じく PR 本文 pass を override して不合格にする（restore 後も不合格が維持される、の直接確認）。
  const savedFromLive = { optinFixState: { attempted: true, runs: liveUnboundFixOptin.runs, headSha: liveUnboundFixOptin.headSha, unbound: liveUnboundFixOptin.unbound } }
  const restoredFromLive = restoreOptinFixState(savedFromLive, ['make e2e'])
  assert.equal(restoredFromLive.unbound, true)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restoredFromLive, SHA_B), { ok: false, missing: [0] })
})

test('統合（セキュリティ監査 Medium）: unbound: true の状態は restore を経ても維持され、別ラウンド（異なる gateHeadSha）でも不合格が続く', () => {
  const savedUnbound = { optinFixState: { attempted: true, headSha: 'not-a-sha' } }
  const restored1 = restoreOptinFixState(savedUnbound, ['make e2e'])
  const restored2 = restoreOptinFixState(savedUnbound, ['make e2e'])
  for (const [restored, gateHead] of [[restored1, SHA_A], [restored2, SHA_B]]) {
    const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: gateHead, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
    assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, gateHead), { ok: false, missing: [0] })
  }
})

test('統合: fix 未実施の再開は従来どおり PR 本文のみで判定する（restoreOptinFixState が null を返す）', () => {
  const restored = restoreOptinFixState({}, ['make e2e'])
  assert.equal(restored, null)
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, SHA_A), bodyGateOk)
  const bodyGateMissing = classifyOptinRecordGate(['make e2e'], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateMissing, restored, SHA_A), bodyGateMissing)
})

test('統合: 宣言なしイシューは再開後も restoreOptinFixState が null を返し combineOptinRecordGate は無介入', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A } }, [])
  assert.equal(restored, null)
  const bodyGateOk = classifyOptinRecordGate([], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, SHA_A), bodyGateOk)
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

test('prCreatePrompt: 宣言なし（item.optinTests: []）は出力が無変更（R3）', () => {
  const withEmpty = prCreatePrompt({ ...item, optinTests: [] }, impl, [])
  const withoutField = prCreatePrompt({ number: 42, title: 'サンプルイシュー' }, impl, [])
  assert.equal(withEmpty, withoutField)
})

test('implementPrompt: 宣言ありでは JSON.stringify 形のコマンド・pass 偽装禁止文言・optinTestRuns 返却指示を含む', () => {
  const p = implementPrompt({ ...item, optinTests: ['make e2e'] }, 'plan-text')
  assert.match(p, /"make e2e"/)
  assert.match(p, /sh -c/)
  assert.match(p, /偽装/)
  assert.match(p, /optinTestRuns/)
})

test('prCreatePrompt: 宣言ありでは push 前の再実行手順（0c/0d）と body テンプレートの記録節見出し・<sha>/<result> プレースホルダが現れる（PR #503 3 巡目 codex P1: Implement 時の結果を転記せず再実行する）', () => {
  const p = prCreatePrompt({ ...item, optinTests: ['make e2e'] }, impl, [])
  assert.match(p, /"make e2e"/)
  assert.match(p, /0c\./)
  assert.match(p, /git rev-parse HEAD/)
  assert.match(p, /## opt-in テスト実行記録/)
  assert.match(p, new RegExp(`${OPTIN_RECORD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<sha> <result> make e2e -->`))
})

test('prCreatePrompt: 宣言ありではマーカー境界で安全確認してから削除する手順を含み、無条件削除の旧 sed 文字列・旧 grep -vF ベース・旧 tail -n 1 前提の文字列は含まない（PR #504 codex P0 / cursor[bot] Medium: 非信頼な既存本文の同名見出し以降を無条件削除しない・外部ツールの追記や CRLF で恒久的に削除不能にならない）', () => {
  const p = prCreatePrompt({ ...item, optinTests: ['make e2e'] }, impl, [])
  assert.ok(!p.includes("sed '/^[[:space:]]*## opt-in テスト実行記録[[:space:]]*$/,$d' \"$f\""))
  assert.ok(!p.includes('grep -vF'))
  // v1（本文の最終行が終端マーカーと完全一致することを前提にする）は Cursor Bugbot 等の
  // 追記で恒久的に成立しなくなるため廃止済み（PR #504 レビュー）。
  assert.ok(!p.includes('tail -n 1 "$f"'))
  assert.ok(p.includes(OPTIN_RECORD_END_MARKER))
  // 見出し行の最後の出現位置を対象にする（旧書式の既存 PR で見出しが増え続ける再発を防ぐ）。
  assert.ok(p.includes('tail -n 1 | cut -d: -f1'))
  // CRLF 対策（末尾 \r の除去）を含む。
  assert.ok(p.includes("tr -d '\\r'"))
  // body/s の sed 終了コードを確認せず書き戻していた codex P0 を修正: 削除の書き戻しは
  // 単一の sed 実行の終了コードで gate し、非 0 なら一時ファイルを破棄して mv しない。
  assert.ok(p.includes('if sed "${L},${E}d" "$f" > "$g"; then'))
  assert.ok(p.includes(`gt=$(mktemp); printf '%s' "$(cat "$g")" > "$gt"; mv "$gt" "$f"; rm -f "$g"`))
  // 識別できない場合は "$f" を変更せず安全側に倒す旨の説明を含む。
  assert.match(p, /識別できない場合は.*"\$f".*変更せず/)
})

test('prCreatePrompt: opt-in 記録節の除去手順は Closes 行・対象外節の追記より前に現れる（Issue #502: 除去を後回しにすると新規追記した対象外節が巻き込まれて消える）', () => {
  const p = prCreatePrompt({ ...item, optinTests: ['make e2e'] }, impl, ['対象外の項目1'])
  const removeIdx = p.indexOf('opt-in テスト記録節を安全に除去する')
  const closesIdx = p.indexOf(`grep -qF ${JSON.stringify('Closes #42')}`)
  const oosIdx = p.indexOf('## 対象外（out-of-scope）」の見出しが無い場合')
  assert.ok(removeIdx >= 0 && closesIdx >= 0 && oosIdx >= 0)
  assert.ok(removeIdx < closesIdx, '除去手順は Closes 行の追記より前に現れなければならない')
  assert.ok(removeIdx < oosIdx, '除去手順は対象外節の追記より前に現れなければならない')
})

// ---------------------------------------------------------------------------
// optinRecordRemovalShellLines の実行時回帰（PR #504 codex P0 / cursor[bot] Medium 指摘 2 件）。
// プロンプト文字列に含まれる部分文字列だけでなく、生成されたシェル断片を実際に sh -c で
// 実行して "$f" の中身を検証する。エージェントに指示を出す静的テキストのアサーションだけでは
// ロジックの回帰（CRLF・追記トレーラ・旧書式・異常終了時の fail-closed）を検出できないため。
// ---------------------------------------------------------------------------

// optinRecordRemovalShellLines() のコードフェンス（'   ```' 〜 '   ```'）を取り出し、
// 行頭の 3 space インデント（箇条書きの見た目上のもの）を剥がして実行可能な sh スクリプトへ戻す。
function extractRemovalScript() {
  const lines = optinRecordRemovalShellLines()
  const fenceStart = lines.indexOf('   ```')
  const fenceEnd = lines.indexOf('   ```', fenceStart + 1)
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, 'コードフェンスが 2 個 1 組で見つからない')
  return lines
    .slice(fenceStart + 1, fenceEnd)
    .map((l) => l.replace(/^   /, ''))
    .join('\n')
}

function runRemoval(bodyBuffer) {
  const dir = mkdtempSync(join(tmpdir(), 'optin-removal-'))
  const f = join(dir, 'body.txt')
  writeFileSync(f, bodyBuffer)
  const script = `f=${JSON.stringify(f)}\n${extractRemovalScript()}\n`
  execFileSync('sh', ['-c', script])
  return readFileSync(f, 'utf8')
}

test('optinRecordRemovalShellLines: 通常ケース（見出し〜終端マーカーが本文末尾）は節全体を削除し、書き戻しはコマンド置換で末尾の空行を持ち越さない（cursor[bot] Low の回帰）', () => {
  const before = `Closes #42\n\n## opt-in テスト実行記録\n${optinRecordMarkerLine('a'.repeat(40), 'pass', 'make e2e')}\n- コマンド: make e2e\n- 結果: pass\n- 補足: (なし)\n${OPTIN_RECORD_END_MARKER}\n`
  const after = runRemoval(before)
  // 見出しより前の内容は保持されるが、削除範囲が本文の真の末尾だったため、書き戻しの
  // コマンド置換（$(cat "$g")）が末尾の空行・改行をすべて剥がす（v1 の printf '%s' と同じ
  // 挙動を復元し、次回追記の echo; echo が積み増しで空行を増殖させないようにする）。
  assert.equal(after, 'Closes #42')
})

test('optinRecordRemovalShellLines: 終端マーカーより後ろに外部ツールの追記（Cursor Bugbot 等）があっても、記録節だけを削除しトレーラは保持する（PR #504 レビューで判明した v1 設計欠陥の回帰）', () => {
  const before = `Closes #42\n\n## opt-in テスト実行記録\n- コマンド: make e2e\n- 結果: pass\n- 補足: (なし)\n${OPTIN_RECORD_END_MARKER}\n<!-- CURSOR_SUMMARY -->\n外部ツールのコメント\n<!-- /CURSOR_SUMMARY -->\n`
  const after = runRemoval(before)
  // 削除範囲より前の空行（Closes 行の直後）は本文の真の末尾ではない（トレーラが後ろに続く）
  // ため保持される。コマンド置換で剥がれるのはファイルの真の末尾の改行のみ。
  assert.equal(after, 'Closes #42\n\n<!-- CURSOR_SUMMARY -->\n外部ツールのコメント\n<!-- /CURSOR_SUMMARY -->')
})

test('optinRecordRemovalShellLines: CRLF 本文でも終端マーカー行を識別して削除する（cursor[bot] Medium 指摘の回帰）', () => {
  const bodyLf = `Closes #42\n\n## opt-in テスト実行記録\n- コマンド: make e2e\n- 結果: pass\n- 補足: (なし)\n${OPTIN_RECORD_END_MARKER}\n`
  const bodyCrlf = bodyLf.replace(/\n/g, '\r\n')
  const after = runRemoval(bodyCrlf)
  assert.ok(!after.includes('## opt-in テスト実行記録'), 'CRLF 本文でも見出しが除去されているべき')
  assert.ok(after.startsWith('Closes #42'))
})

test('optinRecordRemovalShellLines: 終端マーカーを持たない旧書式は一切削除しない（PR #504 レビュー 2 巡目 codex P1 の直接回帰: 行の見た目だけでは所有区間と断定できない）', () => {
  const before = `Closes #42\n\n## opt-in テスト実行記録\n- コマンド: make e2e\n- 結果: pass\n- 補足: (なし)\n`
  const after = runRemoval(before)
  assert.equal(after, before, '終端マーカーが見つからない場合 "$f" は一切変更されない（v2 の EOF フォールバックは廃止）')
})

test('optinRecordRemovalShellLines: 見出しが 2 件残っている旧書式でも、最後の出現位置に対応する記録節だけを削除する（cursor[bot] Medium 指摘: 見出しが増え続ける再発の防止）', () => {
  const before = `## opt-in テスト実行記録\nユーザーが引用した過去の見出し\n\n## opt-in テスト実行記録\n- コマンド: make e2e\n- 結果: pass\n- 補足: (なし)\n${OPTIN_RECORD_END_MARKER}\n`
  const after = runRemoval(before)
  assert.equal(after, '## opt-in テスト実行記録\nユーザーが引用した過去の見出し')
})

test('optinRecordRemovalShellLines: 見出しと終端マーカーの間に未知の行（ユーザー由来コンテンツの可能性）があれば削除しない（安全側）', () => {
  const before = `## opt-in テスト実行記録\nユーザーが書いた本文\n${OPTIN_RECORD_END_MARKER}\n`
  const after = runRemoval(before)
  assert.equal(after, before, '識別できない場合 "$f" は一切変更されない')
})

test('optinRecordVerifyPrompt: gh pr view --json body,headRefOid を単一呼び出しで取得し、本文転記禁止・headRefOid 検証・件数のみ返却の指示を含む（PR #503 3 巡目 codex P1）', () => {
  const p = optinRecordVerifyPrompt(item, impl, ['make e2e'])
  assert.match(p, /gh pr view 123 --json body,headRefOid/)
  assert.match(p, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(p, /表示・転記しない/)
  assert.match(p, /counts/)
  assert.match(p, /headRefOid/)
})

test('mergeExecutePrompt に optin 関連文字列と --json body が含まれない（分離契約の非退行。expectedHeadSha 指定時も同様）', () => {
  const p1 = mergeExecutePrompt(item, impl, false, [])
  assert.doesNotMatch(p1, /optin/i)
  assert.doesNotMatch(p1, /--json body/)
  // PR #503 3 巡目 codex P1: 期待 HEAD sha（TOCTOU 対策）を渡しても分離契約は退行しない。
  const p2 = mergeExecutePrompt(item, impl, true, [], SHA_A)
  assert.doesNotMatch(p2, /optin/i)
  assert.doesNotMatch(p2, /--json body/)
  assert.match(p2, new RegExp(SHA_A))
  assert.match(p2, /head-moved/)
})

test('mergeExecutePrompt: expectedHeadSha 省略時は一致チェック文言を含まない（既存 R3 契約）', () => {
  const withDefault = mergeExecutePrompt(item, impl, true, [])
  const withEmpty = mergeExecutePrompt(item, impl, true, [], '')
  assert.equal(withDefault, withEmpty)
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

test('fixPrompt: pushAfterFix=true かつ optinTests 宣言ありではマーカー境界で安全確認してから削除する手順を含み、無条件削除の旧 sed 文字列・旧 grep -vF ベース・旧 tail -n 1 前提の文字列は含まない（PR #504 codex P0 / cursor[bot] Medium）', () => {
  const p = fixPrompt({ ...item, optinTests: ['make e2e'] }, impl, finding, true)
  assert.ok(!p.includes("sed '/^[[:space:]]*## opt-in テスト実行記録[[:space:]]*$/,$d' \"$f\""))
  assert.ok(!p.includes('grep -vF'))
  assert.ok(!p.includes('tail -n 1 "$f"'))
  assert.ok(p.includes(OPTIN_RECORD_END_MARKER))
  assert.ok(p.includes('tail -n 1 | cut -d: -f1'))
  assert.ok(p.includes("tr -d '\\r'"))
  assert.ok(p.includes('if sed "${L},${E}d" "$f" > "$g"; then'))
  assert.ok(p.includes(`gt=$(mktemp); printf '%s' "$(cat "$g")" > "$gt"; mv "$gt" "$f"; rm -f "$g"`))
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
// 群 E3: optinDeclarationFormatHint / optinInvalidWarningLine（Issue #502: blocked 理由文言の
// 検証規則案内・ノード種別に応じた警告ログの実挙動一致）
// ---------------------------------------------------------------------------

test('optinDeclarationFormatHint: 許可形式の要点（不許可サブコマンド例・パストラバーサル・"//"・SKILL.md 参照）を含む', () => {
  const hint = optinDeclarationFormatHint()
  assert.match(hint, /cargo run/)
  assert.match(hint, /\.\./)
  assert.match(hint, /\/\//)
  assert.match(hint, /SKILL\.md/)
})

test('optinDeclarationFormatHint: 許可ランナー一覧を OPTIN_TEST_RUNNERS から動的に組み立てる（ハードコード禁止・ドリフト検知）', () => {
  const hint = optinDeclarationFormatHint()
  for (const runner of OPTIN_TEST_RUNNERS) {
    assert.ok(hint.includes(runner), `許可ランナー ${runner} がヒント文言に含まれない`)
  }
})

test('optinDeclarationFormatHint: サブコマンド制限を OPTIN_TEST_RUNNER_SUBCOMMANDS から動的に組み立てる（ドリフト検知）', () => {
  const hint = optinDeclarationFormatHint()
  for (const [runner, subs] of Object.entries(OPTIN_TEST_RUNNER_SUBCOMMANDS)) {
    assert.ok(hint.includes(runner), `ランナー ${runner} の制約がヒント文言に含まれない`)
    for (const sub of subs) {
      assert.ok(hint.includes(sub), `${runner} の許可サブコマンド ${sub} がヒント文言に含まれない`)
    }
  }
})

test('optinInvalidWarningLine: hasChildren: true では blocked にはならない旨の否定文を含み「実装は起動せず blocked で停止する」を含まない', () => {
  const line = optinInvalidWarningLine(99, true, ['bad cmd'])
  assert.match(line, /blocked にはならない/)
  assert.doesNotMatch(line, /実装は起動せず blocked で停止する/)
  assert.match(line, /runVerifyClose/)
})

test('optinInvalidWarningLine: hasChildren: false では従来どおり「実装は起動せず blocked で停止する」を含む', () => {
  const line = optinInvalidWarningLine(99, false, ['bad cmd'])
  assert.match(line, /実装は起動せず blocked で停止する/)
  assert.doesNotMatch(line, /blocked にはならない/)
})

// ---------------------------------------------------------------------------
// 群 F: 実行レベル（optinRecordVerifyPrompt と同じ grep 手順をシェルで再現）
// ---------------------------------------------------------------------------

// optinRecordVerifyPrompt 手順 3 の正規化パイプライン（tr -d '\r' | sed 行頭・行末空白除去）と
// 手順 4 の 3 種類（pass/fail/not-run）固定文字列 -cxF グレップをそのまま再現する
// （PR #503 3 巡目 codex P1: sha 束縛後の実装。$H は事前に sanitizeSha 相当の形式検証を通過した
// 値という前提でシェルへ展開する）。行頭インデント・CRLF が付いたマーカー行でも一致すること、
// sha が一致しない行は一致しないことを検証するのが目的。
function grepShaResultCounts(bodyText, sha, command) {
  const script = `
f=$(mktemp)
g=$(mktemp)
cat > "$f" <<'BODYEOF'
${bodyText}
BODYEOF
tr -d '\\r' < "$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' > "$g"
H="$1"
pass=$(grep -cxF -- "${OPTIN_RECORD_MARKER_PREFIX}$H pass $2 -->" "$g")
fail=$(grep -cxF -- "${OPTIN_RECORD_MARKER_PREFIX}$H fail $2 -->" "$g")
notrun=$(grep -cxF -- "${OPTIN_RECORD_MARKER_PREFIX}$H not-run $2 -->" "$g")
rm -f "$f" "$g"
echo "$pass $fail $notrun"
`
  const out = execFileSync('bash', ['-c', script, 'bash', sha, command], { encoding: 'utf8' })
  const [pass, fail, notrun] = out.trim().split(' ').map(Number)
  return { pass, nonPass: fail + notrun }
}

test('実行レベル: 一致する sha の pass 行のみ → pass=1 / nonPass=0', () => {
  const body = optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')
  assert.deepEqual(grepShaResultCounts(body, SHA_A, 'make e2e'), { pass: 1, nonPass: 0 })
})

test('実行レベル: 一致する sha の not-run 行のみ → pass=0 / nonPass=1', () => {
  const body = optinRecordMarkerLine(SHA_A, 'not-run', 'make e2e')
  assert.deepEqual(grepShaResultCounts(body, SHA_A, 'make e2e'), { pass: 0, nonPass: 1 })
})

test('実行レベル: 行頭インデントと CRLF 付きの pass 行 → 正規化後に pass=1 / nonPass=0', () => {
  // 行頭インデントは trim しない（正規化パイプライン自体の空白除去を検証するため）。
  // 人手による復旧編集（PR 本文をエディタで書き換える際に字下げが付く等）でも一致することを示す。
  const body = `   ${optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')}\r\n`
  assert.deepEqual(grepShaResultCounts(body, SHA_A, 'make e2e'), { pass: 1, nonPass: 0 })
})

test('実行レベル: 別コマンドの pass 行のみ → pass=0 / nonPass=0', () => {
  const body = optinRecordMarkerLine(SHA_A, 'pass', 'make other')
  assert.deepEqual(grepShaResultCounts(body, SHA_A, 'make e2e'), { pass: 0, nonPass: 0 })
})

test('実行レベル: sha が異なる pass 行は存在しないものとして扱われる（PR #503 3 巡目 codex P1 の核心）', () => {
  // 古い HEAD（SHA_A）に対する pass 記録は、現在の HEAD（SHA_B）の確認では 0 件になる。
  const body = optinRecordMarkerLine(SHA_A, 'pass', 'make e2e')
  assert.deepEqual(grepShaResultCounts(body, SHA_B, 'make e2e'), { pass: 0, nonPass: 0 })
})

test('実行レベル: 新旧 2 つの sha の記録が併存しても現在の sha の分だけを数える', () => {
  const body = [
    optinRecordMarkerLine(SHA_A, 'pass', 'make e2e'),
    optinRecordMarkerLine(SHA_B, 'fail', 'make e2e'),
  ].join('\n')
  assert.deepEqual(grepShaResultCounts(body, SHA_B, 'make e2e'), { pass: 0, nonPass: 1 })
  assert.deepEqual(grepShaResultCounts(body, SHA_A, 'make e2e'), { pass: 1, nonPass: 0 })
})

// ---------------------------------------------------------------------------
// 群 F2: 実行レベル・複数回サイクル（cursor[bot] Medium 指摘の回帰: 群 F2 は従来
// safeRemoveOptinSection という「本番実装から乖離したローカル再実装」（旧 v1 契約 — 最終行が
// 終端マーカーと完全一致すること・見出しがちょうど 1 件であることを要求）を保持しており、
// F2 のテストが green でも本番実装 optinRecordRemovalShellLines の回帰を検知できなかった
// （複数見出しで削除をブロックすると期待する 1 件は現行実装の挙動と正反対だった）。
// 本番と同一のシェル断片を実行する runRemoval（群 F で定義）を再利用し、実装からの乖離を
// 構造的に防ぐ。単発ケースは群 F がカバーするため、本群は「複数節を組み合わせた本文の保持」と
// 「本番同等の追記手順（echo を重ねる方式）を挟んだ複数ラウンドの往復」に限定する。
// ---------------------------------------------------------------------------

test('optinRecordRemovalShellLines: Closes 行・対象外節を含む本文でも記録節だけを削除し、他の節は保持する', () => {
  const before = [
    '## Summary',
    '- 実装内容の要約',
    '',
    'Closes #502',
    '',
    '## 対象外（out-of-scope）',
    '- 項目1',
    '',
    '## opt-in テスト実行記録',
    optinRecordMarkerLine(SHA_A, 'pass', 'make e2e'),
    '- コマンド: make e2e',
    '- 結果: pass',
    '- 補足: (なし)',
    OPTIN_RECORD_END_MARKER,
    '',
  ].join('\n')
  const out = runRemoval(before)
  assert.match(out, /Closes #502/)
  assert.match(out, /## 対象外（out-of-scope）/)
  assert.match(out, /- 項目1/)
  assert.doesNotMatch(out, /## opt-in テスト実行記録/)
  assert.doesNotMatch(out, /- コマンド: make e2e/)
})

// 本番の追記手順（optinRecordUpdateInstructions 手順 d・prCreatePrompt）が指示する
// 「{ echo; echo; echo '## opt-in ...'; ...; } >> "$f"」パターンをそのまま再現する。
// JS 側で単純に配列を join('\n') する模擬では実際の echo 二重呼び出しの挙動
// （末尾に改行が残っているかどうかで生成される空行数が変わる）を検証できないため、
// 削除・追記の両方を実際のシェルで実行する。
function appendOptinRecordLikeProduction(filePath, sha, result, command) {
  const script = `
f=${JSON.stringify(filePath)}
{
  echo
  echo
  echo '## opt-in テスト実行記録'
  echo ${JSON.stringify(optinRecordMarkerLine(sha, result, command))}
  echo ${JSON.stringify(`- コマンド: ${command}`)}
  echo ${JSON.stringify(`- 結果: ${result}`)}
  echo '- 補足: (なし)'
  echo ${JSON.stringify(OPTIN_RECORD_END_MARKER)}
} >> "$f"
`
  execFileSync('sh', ['-c', script])
}

test('optinRecordRemovalShellLines: 本番同等の除去→追記（echo を重ねる方式）を複数ラウンド繰り返しても見出し直前の空行が増殖しない（cursor[bot] Low の回帰）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optin-round-'))
  const f = join(dir, 'body.txt')
  writeFileSync(f, '## Summary\n- 実装内容の要約\n\nCloses #502\n')
  const rounds = [
    { sha: SHA_A, result: 'fail' },
    { sha: SHA_A, result: 'not-run' },
    { sha: SHA_B, result: 'pass' },
  ]
  for (const { sha, result } of rounds) {
    // c. 既存の記録節を除去する（本番の optinRecordUpdateInstructions 手順 c と同一のシェル片）。
    execFileSync('sh', ['-c', `f=${JSON.stringify(f)}\n${extractRemovalScript()}\n`])
    // d. 今回の結果で記録節を書き足す（本番の手順 d と同じ echo を重ねる方式）。
    appendOptinRecordLikeProduction(f, sha, result, 'make e2e')
  }
  const body = readFileSync(f, 'utf8')
  const headingCount = (body.match(/## opt-in テスト実行記録/g) ?? []).length
  assert.equal(headingCount, 1, '複数ラウンドを経ても見出しは 1 個だけ残る')
  assert.doesNotMatch(body, /- 結果: fail/)
  assert.doesNotMatch(body, /- 結果: not-run/)
  assert.match(body, /- 結果: pass/)
  // 見出し直前の連続空行が 2 行を超えて増え続けないこと（本番の echo 二重呼び出しにより
  // 最大でも 2 行までは許容し、ラウンドを重ねるごとに単調増加しないことを確認する）。
  assert.doesNotMatch(body, /\n{4,}## opt-in テスト実行記録/, '見出し直前の空行がラウンドを経て増殖していない')
  // 終端マーカーは最終ラウンドでも節の実際の最終行として 1 個だけ残る。
  const endMarkerCount = (body.match(new RegExp(OPTIN_RECORD_END_MARKER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g')) ?? []).length
  assert.equal(endMarkerCount, 1)
  assert.equal(body.trimEnd().split('\n').pop(), OPTIN_RECORD_END_MARKER)
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

test('駆動部: runImplement の blocked 理由構築に optinDeclarationFormatHint の呼び出しが含まれる（Issue #502）', () => {
  const implIdx = driverPart.indexOf('async function runImplement')
  const hintIdx = driverPart.indexOf('optinDeclarationFormatHint(', implIdx)
  assert.ok(implIdx >= 0 && hintIdx >= 0 && hintIdx - implIdx < 1200)
})

test('駆動部: Tree ループの invalid 分岐が optinInvalidWarningLine を hasChildren 付きで呼ぶ（Issue #502）', () => {
  assert.match(driverPart, /optinInvalidWarningLine\(n\.number, hasChildren, n\.optinTestsInvalid\)/)
})

test('駆動部: post-push fix 直後の updateState が optinFixState（runs + headSha + unbound）を含む（PR #503 2/3 巡目 codex P0/P1）', () => {
  assert.match(driverPart, /optinFixStatePatch = \{ attempted: true, runs: fixOptinRuns, headSha: fixHeadSha, unbound: false \}/)
  assert.match(driverPart, /const optinFixPatchArgs = \{ fixCount, baseMergeCount, worktree: currentWorktreePath,/)
  assert.match(driverPart, /optinFixState: optinFixStatePatch \}/)
  assert.match(driverPart, /updateState\(item\.number, optinFixPatchArgs, \{ cleanupWorktree: oldWorktreePath \}\)/)
})

test('駆動部: post-push fix が optinHeadSha を報告しない・不正な場合は unbound: true を合成しログ警告する（セキュリティ監査 Medium）', () => {
  assert.match(driverPart, /lastFixOptin = \{ runs: unboundRuns, headSha: '', unbound: true \}/)
  assert.match(driverPart, /optinFixStatePatch = \{ attempted: true, runs: unboundRuns, headSha: '', unbound: true \}/)
})

test('駆動部: optinFixState 書込み失敗時に cleanupWorktree なしで 1 回再試行し、なお失敗すれば failMergeTerminal で終端する（PR #503 3 巡目 codex P1 / Bugbot Medium）', () => {
  assert.match(driverPart, /if \(optinFixStatePatch !== undefined && !fixStateWriteOk\)/)
  assert.match(driverPart, /const retryOk = await updateState\(item\.number, optinFixPatchArgs\)/)
  assert.match(driverPart, /if \(!retryOk\) \{/)
})

test('駆動部: failMergeTerminal の終端 updateState が lastFixOptin から optinFixState（unbound 含む）を合成し、戻り値を確認してログ警告する（PR #503 3 巡目 Bugbot Medium・セキュリティ監査 Low）', () => {
  assert.match(driverPart, /const terminalWriteOk = await updateState\(item\.number, \{ status: terminalStatus,/)
  assert.match(driverPart, /optinFixState: lastFixOptin \? \{ attempted: true, runs: lastFixOptin\.runs, headSha: lastFixOptin\.headSha, unbound: lastFixOptin\.unbound === true \} : undefined \}\)/)
  assert.match(driverPart, /if \(!terminalWriteOk\) \{/)
})

test('駆動部: monitoring 再開パスが restoreOptinFixState(saved, item.optinTests) を runMergeLoop の initialFixOptin へ渡す', () => {
  assert.match(driverPart, /restoreOptinFixState\(saved, item\.optinTests\)/)
})

test('駆動部: runMergeLoop の lastFixOptin 初期値は initialFixOptin を引き継ぐ（null 固定ではない）', () => {
  assert.match(driverPart, /let lastFixOptin = initialFixOptin/)
})

test('駆動部: merge-exec 呼び出しに optinGateHeadSha（TOCTOU 対策の期待 HEAD sha）が渡される（PR #503 3 巡目 codex P1）', () => {
  assert.match(driverPart, /mergeExecutePrompt\(item, impl, allowMerge, externalCheckEntries, optinGateHeadSha\)/)
  assert.match(driverPart, /optinGateHeadSha = sanitizeSha\(optinVerify\?\.headRefOid\)/)
})

// ---------------------------------------------------------------------------
// 群 G: opt-in 記録 latch は fail-closed で停止する（PR #503 4 巡目 codex P1 → 5 巡目 codex P0）。
// 4 巡目で一度導入した no-push latch 解除（自己申告 optinHeadSha の一致だけで採用する設計）は
// 5 巡目 codex P0 指摘（SHA 一致は実行の証明にならない）を受けて撤去した。isOptinLatchActive は
// 終端メッセージの出し分け専用として残り、latch はマージ許可に一切影響しない。latch の唯一の
// 解消経路は (a) 新しいコミットを push して pass 記録を新 HEAD へ置き換える（既存経路）、
// (b) 人間が GitHub 上で手動マージする、の 2 つのみで、状態ファイルの手動編集による迂回手順は
// どこにも存在しない。
// ---------------------------------------------------------------------------

test('isOptinLatchActive: 現在の HEAD に一致する非 pass 実測があれば true（終端メッセージの出し分けにのみ使う）', () => {
  const fixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A, unbound: false }
  assert.equal(isOptinLatchActive(fixOptin, SHA_A), true)
})

test('isOptinLatchActive: unbound: true は headSha が空でも true（gateHeadSha が確定している限り）', () => {
  const fixOptin = { runs: [{ command: 'make e2e', result: 'not-run', detail: '' }], headSha: '', unbound: true }
  assert.equal(isOptinLatchActive(fixOptin, SHA_A), true)
})

test('isOptinLatchActive: gateHeadSha が sanitizeSha を通らない場合は unbound: true でも false', () => {
  const fixOptin = { runs: [{ command: 'make e2e', result: 'not-run', detail: '' }], headSha: '', unbound: true }
  assert.equal(isOptinLatchActive(fixOptin, ''), false)
  assert.equal(isOptinLatchActive(fixOptin, 'not-a-sha'), false)
})

test('isOptinLatchActive: headSha が現在の HEAD と不一致（override が働かない）なら false', () => {
  const fixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A, unbound: false }
  assert.equal(isOptinLatchActive(fixOptin, SHA_B), false)
})

test('isOptinLatchActive: runs が全件 pass（override 自体が発生しない）なら false', () => {
  const fixOptin = { runs: [{ command: 'make e2e', result: 'pass', detail: '' }], headSha: SHA_A, unbound: false }
  assert.equal(isOptinLatchActive(fixOptin, SHA_A), false)
})

test('isOptinLatchActive: lastFixOptin が null・runs 空でも false', () => {
  assert.equal(isOptinLatchActive(null, SHA_A), false)
  assert.equal(isOptinLatchActive({ runs: [] }, SHA_A), false)
})

test('統合: latch 下（非 pass が現 HEAD に一致）では、PR 本文が同じ HEAD で pass 表示でも combineOptinRecordGate は不合格を維持する（isOptinLatchActive は true だが、マージ許可には一切影響しない）', () => {
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_A, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  const fixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A, unbound: false }
  assert.equal(isOptinLatchActive(fixOptin, SHA_A), true)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_A), { ok: false, missing: [0] })
})

test('統合: unbound な latch も同様に、PR 本文が pass でも不合格を維持する（現在の HEAD が何であれ override する）', () => {
  const bodyGateOk = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_B, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  const fixOptin = { runs: [{ command: 'make e2e', result: 'not-run', detail: '' }], headSha: '', unbound: true }
  assert.equal(isOptinLatchActive(fixOptin, SHA_B), true)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, fixOptin, SHA_B), { ok: false, missing: [0] })
})

test('統合（既存経路の回帰）: push を伴う fix が新 HEAD（SHA_B）で全件 pass を報告すれば、lastFixOptin は新 HEAD の unbound: false へ置き換わり、latch は新 HEAD では検出されず合格し得る', () => {
  // SHA_A で non-pass だった latch 状態（旧 HEAD）。
  const oldFixOptin = { runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A, unbound: false }
  assert.equal(isOptinLatchActive(oldFixOptin, SHA_A), true)
  // 新しいコミットを push した post-push fix が SHA_B で全件 pass を報告した後の状態
  // （runMergeLoop の f.pushed === true 分岐がそのまま作る形。5 巡目でも変更していない）。
  const newFixOptin = { runs: sanitizeOptinTestRuns([{ command: 'make e2e', result: 'pass', exitCode: 0, detail: '' }], ['make e2e']), headSha: SHA_B, unbound: false }
  assert.equal(isOptinLatchActive(newFixOptin, SHA_B), false, '新 HEAD では override 対象がないため latch ではない')
  const bodyGateOkAtNewHead = classifyOptinRecordGate(['make e2e'], { headRefOid: SHA_B, counts: [{ index: 0, pass: 1, nonPass: 0 }] })
  assert.deepEqual(combineOptinRecordGate(bodyGateOkAtNewHead, newFixOptin, SHA_B), bodyGateOkAtNewHead, '新 HEAD の pass 記録で override せず元の gate（合格し得る）をそのまま返す')
})

test('統合: 宣言なしイシューでは isOptinLatchActive・combineOptinRecordGate いずれも latch の影響を受けない（restoreOptinFixState が null を返す既定無効方針と一致）', () => {
  const restored = restoreOptinFixState({ optinFixState: { attempted: true, runs: [{ command: 'make e2e', result: 'fail', detail: '' }], headSha: SHA_A, unbound: false } }, [])
  assert.equal(restored, null)
  assert.equal(isOptinLatchActive(restored, SHA_A), false)
  const bodyGateOk = classifyOptinRecordGate([], null)
  assert.deepEqual(combineOptinRecordGate(bodyGateOk, restored, SHA_A), bodyGateOk)
})

// ---- fixPrompt: latch 解除専用パラメータ（optinLatchMode）が撤去され、出力が完全に不変であること ----

test('fixPrompt: latch 関連の引数・手順が存在しない（5 巡目で撤去済み）。5 引数呼び出しと 6 引数目に任意の値を渡した呼び出しが同一出力になる（余分な引数は無視される既存の JS 挙動の確認であり、6 引数目を読む分岐が存在しないことの間接確認）', () => {
  const finding = { summary: 'テスト指摘', unresolvedComments: [] }
  const item2 = { number: 42, title: 'サンプルイシュー', optinTests: ['make e2e'] }
  const withFiveArgs = fixPrompt(item2, impl, finding, true, [])
  // eslint 等の型チェックを経由しないテスト専用の直接呼び出し。6 引数目（撤去済みの
  // optinLatchMode 相当の位置）に true を渡しても出力が変わらないことを確認する。
  const withExtraArg = fixPrompt(item2, impl, finding, true, [], true)
  assert.equal(withFiveArgs, withExtraArg)
  assert.doesNotMatch(withFiveArgs, /latch の解除専用として起動されている/)
  assert.doesNotMatch(withFiveArgs, /コード変更は必須ではない/)
})

// ---- 駆動部: latch は終端メッセージの出し分けにのみ使われ、fix への再ディスパッチが存在しないこと ----

test('駆動部: latch 検出（isOptinLatchActive）は終端メッセージの出し分けにのみ使われ、gate 不合格は latch の有無に関わらず必ず failMergeTerminal(..., \'blocked\') で終端する（needs-fix への再ディスパッチは存在しない）', () => {
  const gateCheckIdx = driverPart.indexOf('const latchActive = isOptinLatchActive(lastFixOptin, optinGateHeadSha)')
  assert.ok(gateCheckIdx >= 0, 'isOptinLatchActive の呼び出しが見つからない')
  const section = driverPart.slice(gateCheckIdx, gateCheckIdx + 2500)
  assert.match(section, /return await failMergeTerminal\(optinReason, 'blocked'\)/)
  // needs-fix への再ディスパッチ（5 巡目で撤去した設計）が残っていないことを確認する。
  assert.doesNotMatch(section, /lastState = 'needs-fix'/)
  assert.doesNotMatch(section, /optinLatchRecoveryActive/)
})

test('駆動部: acceptNoPushOptinFixResult・optinLatchMode・optinLatchExpectedHeadSha・optinLatchAcceptedNoPush はソース全体に存在しない（5 巡目 codex P0 対応で撤去済み）', () => {
  for (const removed of ['acceptNoPushOptinFixResult', 'optinLatchMode', 'optinLatchExpectedHeadSha', 'optinLatchAcceptedNoPush', 'optinLatchRecoveryActive']) {
    assert.ok(!driverPart.includes(removed) && !definitionPart.includes(removed), `${removed} が撤去されずに残っている`)
  }
})

test('駆動部: fixPrompt 呼び出しは 5 引数のまま（optinLatchRecoveryActive 等の 6 引数目を渡さない）', () => {
  assert.match(driverPart, /fixPrompt\(item, impl, finding, true, permittedNoPushResolveIds\), \{ label: `fix:#\$\{item\.number\}`/)
})

test('駆動部: noPushRounds の advanceNoPushRounds 呼び出しは f.pushed === true のみを進捗判定に使う（latch 由来の特別扱いが撤去されている）', () => {
  assert.match(driverPart, /noPushRounds = advanceNoPushRounds\(noPushRounds, f\.pushed === true, newlyResolvedThisRound\)/)
  assert.doesNotMatch(driverPart, /f\.pushed === true \|\| optinLatchAcceptedNoPush/)
})

// ---- 終端メッセージ・ドキュメントに optinFixState の削除/改変手順（迂回手順）が含まれないこと ----

test('駆動部: latch 終端メッセージ文言に「削除するか」「削除してから」等の実行可能な削除指示が含まれず、迂回しない旨の否定文のみが含まれる', () => {
  const gateCheckIdx = driverPart.indexOf('const latchActive = isOptinLatchActive(lastFixOptin, optinGateHeadSha)')
  assert.ok(gateCheckIdx >= 0)
  const section = driverPart.slice(gateCheckIdx, gateCheckIdx + 2500)
  assert.doesNotMatch(section, /削除するか/)
  assert.doesNotMatch(section, /削除してから/)
  assert.doesNotMatch(section, /attempted: false へ書き換え/)
  assert.match(section, /削除・書き換えて迂回することはしないこと/)
})

test('ドキュメント: recovery.md・automerge-design.md・SKILL.md・state-example.json のいずれにも optinFixState を削除・改変して latch を迂回する実行指示（「削除するか」「エントリごと削除してから」等）が残っていない', () => {
  // dirname(import.meta.url) は skills/implement-issue-tree/tests。'..' で
  // skills/implement-issue-tree/ 相対のパスを組み立てる（SCRIPT_PATH と同じ組み立て方）。
  const files = [
    'references/recovery.md',
    'references/automerge-design.md',
    'SKILL.md',
    'sample/state-example.json',
  ]
  const forbidden = [/削除するか/, /エントリごと削除してから/, /attempted: false へ書き換えてから/]
  for (const relPath of files) {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', ...relPath.split('/')), 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${relPath} に迂回手順の指示が残っている: ${pattern}`)
    }
  }
})

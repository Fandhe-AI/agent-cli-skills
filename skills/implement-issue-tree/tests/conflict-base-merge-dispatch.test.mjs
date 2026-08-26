// Issue #441 の回帰テスト: monitor が mergeable: CONFLICTING を検出したときのホスト側分岐が
// fixCount（レビュー指摘対応・上限 6）ではなく独立予算の baseMergeCount（上限 maxBaseMerges）を
// 消費すること、base 取り込み専用エージェント（baseMergePrompt）がレビュー指摘の修正・スレッド
// resolve・PR 本文編集を一切行わない権限境界を持つこと、merge-exec の not-mergeable も同じ
// conflicting 状態へ写像されることを、モデル出力に依存しない JS 純粋部分（引数パーサ・
// プロンプト契約・状態写像・スキーマ・駆動部のソース走査）で固定する。
//
// 読み込み方式は skills/implement-issue-tree/tests/g0-gates.test.mjs と同一（マーカー切り出し
// スライス方式）。実装スクリプトは Workflow ハーネス専用文法のため module として丸ごと import
// できないための回避策であり、他のテストファイルと重複しても踏襲する。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'implement-issue-tree.js',
)
const DRIVER_MARKER = '__IMPLEMENT_ISSUE_TREE_DRIVER_START__'

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-base-merge-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
const SLICE_EXPORTS = [
  'parseMaxBaseMerges',
  'classifyMergeExecDispatch',
  'MERGE_SCHEMA',
  'MERGE_VALID_STATES',
  'BASE_MERGE_SCHEMA',
  'baseMergePrompt',
  'monitorPrompt',
  'fixPrompt',
  'isValidRepoSlug',
  'parseRepoArg',
]
// fixPrompt / baseMergePrompt はいずれも sanitize() 経由で item.title を untrusted() タグへ
// 埋め込む。boundaryNonce() 自体は fixPrompt の finding 埋め込みでのみ使うが、モジュール
// スコープの seed 未注入だと boundaryNonce() 呼び出しが失敗するため g0-gates.test.mjs と同じ
// テスト専用 setter を付与する。
const TEST_ONLY_SETTER =
  'export function __setBoundaryNonceSeedForTest(v) { boundaryNonceSeed = v }\n'
writeFileSync(
  slicePath,
  `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n${TEST_ONLY_SETTER}`,
)

const mod = await import(pathToFileURL(slicePath).href)
const {
  parseMaxBaseMerges,
  classifyMergeExecDispatch,
  MERGE_SCHEMA,
  MERGE_VALID_STATES,
  BASE_MERGE_SCHEMA,
  baseMergePrompt,
  monitorPrompt,
  fixPrompt,
  isValidRepoSlug,
  parseRepoArg,
} = mod
mod.__setBoundaryNonceSeedForTest('b'.repeat(64))

const item = { number: 441, title: 'monitor で CONFLICTING を検出し base 取り込みを自動実行する' }
const impl = { prNumber: 999, branch: 'feat/441-base-merge' }

// ---------------------------------------------------------------------------
// 構造ガード
// ---------------------------------------------------------------------------

test('構造ガード: マーカーは 1 か所のみ存在し、対象関数が副作用なく import できる', () => {
  assert.equal(source.split(DRIVER_MARKER).length - 1, 1)
  assert.equal(typeof parseMaxBaseMerges, 'function')
  assert.equal(typeof classifyMergeExecDispatch, 'function')
  assert.equal(typeof baseMergePrompt, 'function')
  assert.equal(typeof monitorPrompt, 'function')
  assert.equal(typeof MERGE_SCHEMA, 'object')
  assert.equal(typeof BASE_MERGE_SCHEMA, 'object')
  assert.equal(typeof parseRepoArg, 'function')
})

// ---------------------------------------------------------------------------
// parseMaxBaseMerges（マージゲート入力のため寛容フォールバック禁止）
// ---------------------------------------------------------------------------

test('parseMaxBaseMerges: undefined/null は既定値 3', () => {
  assert.equal(parseMaxBaseMerges(undefined), 3)
  assert.equal(parseMaxBaseMerges(null), 3)
})

test('parseMaxBaseMerges: 0〜10 の整数はそのまま受理する（境界値含む）', () => {
  assert.equal(parseMaxBaseMerges(0), 0)
  assert.equal(parseMaxBaseMerges(10), 10)
  assert.equal(parseMaxBaseMerges(5), 5)
})

test('parseMaxBaseMerges: 範囲外・非整数・文字列・真偽値は throw する', () => {
  for (const bad of [-1, 11, 1.5, '3', true, false, NaN, Infinity]) {
    assert.throws(() => parseMaxBaseMerges(bad), /args\.maxBaseMerges/, `${String(bad)} で throw しない`)
  }
})

// ---------------------------------------------------------------------------
// MERGE_SCHEMA / MERGE_VALID_STATES
// ---------------------------------------------------------------------------

test('MERGE_SCHEMA.state.enum に conflicting が含まれ、MERGE_VALID_STATES と同期する', () => {
  assert.ok(MERGE_SCHEMA.properties.state.enum.includes('conflicting'), 'state enum に conflicting がない')
  assert.ok(MERGE_VALID_STATES.has('conflicting'), 'MERGE_VALID_STATES に conflicting がない（enum との二重検証が不同期）')
})

// ---------------------------------------------------------------------------
// classifyMergeExecDispatch: not-mergeable → conflicting（needs-fix ではない）
// ---------------------------------------------------------------------------

test('classifyMergeExecDispatch: not-mergeable は conflicting へ写像し needs-fix へは写像しない', () => {
  const result = classifyMergeExecDispatch('not-mergeable', 'unrecoverable')
  assert.deepEqual(result, { lastState: 'conflicting', lastBlockedReason: 'unrecoverable' })
  assert.notEqual(result.lastState, 'needs-fix')
})

// ---------------------------------------------------------------------------
// BASE_MERGE_SCHEMA
// ---------------------------------------------------------------------------

test('BASE_MERGE_SCHEMA: required は pushed/summary/worktreePath のみ', () => {
  assert.deepEqual(BASE_MERGE_SCHEMA.required, ['pushed', 'summary', 'worktreePath'])
  assert.ok('commitFailed' in BASE_MERGE_SCHEMA.properties, 'commitFailed が定義されていない')
  assert.ok('routingError' in BASE_MERGE_SCHEMA.properties, 'routingError が定義されていない')
  assert.ok(!BASE_MERGE_SCHEMA.required.includes('commitFailed'), 'commitFailed が required に含まれている（省略可のはず）')
  assert.ok(!BASE_MERGE_SCHEMA.required.includes('routingError'), 'routingError が required に含まれている（省略可のはず）')
})

test('BASE_MERGE_SCHEMA.mergeableAfter は MERGEABLE/CONFLICTING/UNKNOWN の enum 完全一致のみ受理する', () => {
  assert.deepEqual(BASE_MERGE_SCHEMA.properties.mergeableAfter.enum, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])
})

// ---------------------------------------------------------------------------
// baseMergePrompt: プロンプト契約（fetch < merge < push < mergeable 確認の位置関係、禁止コマンド）
// ---------------------------------------------------------------------------

test('baseMergePrompt: base fetch → merge → push → mergeable 確認の順で現れる', () => {
  const prompt = baseMergePrompt(item, impl)
  // baseBranch 名はテストスライスの parsedArgs 未注入時の既定値（'main'）に依存するため、
  // 固定文字列ではなく行の並び順で検証する（refspec 保存形式の base fetch 行を特定する）。
  const baseFetchIdx = prompt.indexOf(':refs/remotes/origin/')
  const mergeIdx = prompt.indexOf('git merge --no-edit')
  const abortIdx = prompt.indexOf('git merge --abort')
  const pushIdx = prompt.indexOf('git push origin HEAD:refs/heads/')
  const mergeableIdx = prompt.indexOf('--json state,mergeable,headRefOid')
  assert.ok(baseFetchIdx >= 0, 'base fetch（保存先明示 refspec）の指示がない')
  assert.ok(mergeIdx >= 0, 'git merge --no-edit の指示がない')
  assert.ok(abortIdx >= 0, '解消不能時の git merge --abort 指示がない')
  assert.ok(pushIdx >= 0, 'git push origin HEAD:refs/heads/<branch> の指示がない')
  assert.ok(mergeableIdx >= 0, 'push 後の mergeable 再取得指示がない')
  assert.ok(baseFetchIdx < mergeIdx, 'base fetch が merge より前に現れない')
  assert.ok(mergeIdx < pushIdx, 'merge が push より前に現れない')
  assert.ok(pushIdx < mergeableIdx, 'push が mergeable 確認より前に現れない')
})

test('baseMergePrompt: submodule ポインタ指示と check-runs 起動確認を含む', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(prompt.includes('git checkout origin/'), 'submodule を base 側コミットへ合わせる指示がない')
  assert.ok(prompt.includes('git add '), 'submodule ポインタの git add 指示がない')
  assert.ok(prompt.includes('check-runs'), 'push 後の check-run 起動確認指示がない')
  assert.ok(prompt.includes('checksStarted'), 'checksStarted の返却指示がない')
})

test('baseMergePrompt: commitFailed の返却指示を含む', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(prompt.includes('commitFailed: true'), 'commitFailed: true の返却指示がない')
})

test('baseMergePrompt: gh pr merge の実行コマンド形・resolveReviewThread mutation を含まない（権限境界）', () => {
  const prompt = baseMergePrompt(item, impl)
  // 権限境界の説明文中に「gh pr merge / gh issue close / ... を実行しない」と禁止コマンド名を
  // 列挙するため、文字列そのものの不在ではなく実行可能なコマンド形の不在で判定する
  // （--squash 付きの実マージコマンド・resolveReviewThread の GraphQL mutation 呼び出し行）。
  // 「--no-verify で強行しない」という禁止の明記自体は baseMergeInstruction（fixPrompt / prCreatePrompt
  // と共用）の既存契約でありこの文字列を含むのが正しいため、ここでは検証しない。
  assert.ok(!prompt.includes('--squash --delete-branch --match-head-commit'), 'マージ実行コマンド形が混入している')
  assert.ok(!prompt.includes('mutation($tid:ID!){resolveReviewThread'), 'resolveReviewThread mutation の実行コマンド行が混入している')
})

// PR #443 codex P0（thread PRRT_kwDORuXFg86cbSqr）の回帰テスト: baseMergePrompt は PR head
// checkout 後に fmt / lint / build / test 等、PR 由来の未信頼コード実行を指示しない。PR は
// package scripts・Makefile・テストランナー設定を自由に変更できるため、これらを実行すると
// 悪意ある PR から任意コード実行 → 本エージェントの push 用 GitHub 認証情報の奪取・外部送信に
// つながる。検証は push 後に再起動される既存 CI へ委ね、コンフリクト解消後の妥当性確認は
// git diff --check 等の非実行系のみに限定する。
test('baseMergePrompt: fmt / lint / build / test 等の未信頼コード実行指示を含まない', () => {
  const prompt = baseMergePrompt(item, impl)
  // 旧実装の実行指示そのもの（「〜を通してからコミットする」という命令形）が消えていることを
  // 固定する。否定文脈での「fmt / lint / build / test」という語の言及自体（実行しない旨の
  // 説明）は許容するため、語の不在ではなく実行を命じる言い回しの不在で判定する。
  assert.ok(!prompt.includes('を通してからコミットする'), '旧実装の実行命令形（〜を通してからコミットする）が残っている')
  for (const word of ['npm run', 'npm test', 'npm ci', 'yarn ', 'pnpm ', 'make ', 'cargo test', 'cargo build', 'pytest', 'go test', 'go build']) {
    assert.ok(!prompt.includes(word), `未信頼コード実行コマンド「${word}」が混入している`)
  }
  assert.ok(prompt.includes('git diff --check'), 'conflict marker 残存確認（git diff --check）の非実行系検証指示がない')
  assert.ok(prompt.includes('既存 CI'), '検証を既存 CI へ委ねる旨の記述がない')
  assert.ok(prompt.includes('実行しない'), '未信頼コードを実行しない旨の明示がない')
})

test('baseMergePrompt: レビュー指摘の修正を行わない権限境界の文言を含む', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(prompt.includes('レビュー指摘の修正'), 'レビュー指摘の修正を行わない旨の権限境界文言がない')
})

test('baseMergePrompt: 動的な未信頼データ境界トークン（UNTRUSTED_<nonce>）を含まない', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(!/UNTRUSTED_[0-9a-f]+_BEGIN/.test(prompt), 'fixPrompt 由来の動的境界トークンが混入している（monitor summary 等の自由文を埋め込まない設計に反する）')
})

test('baseMergePrompt: worktree routing ガード（remote 確認 + PR 番号・headRefName 照合）を含む', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(prompt.includes('git remote get-url origin'), 'worktree routing ガードの remote 確認がない')
  assert.ok(prompt.includes('gh pr view'), 'PR 番号・headRefName 照合の gh pr view 指示がない')
  assert.ok(prompt.includes('headRefName'), 'headRefName による照合指示がない')
  assert.ok(prompt.includes('routingError: true'), 'routing error 時の返却指示がない')
})

// PR #443 codex P0（thread PRRT_kwDORuXFg86caswK）の回帰テスト: 8dda694 は remote 確認と
// PR 番号・headRefName 照合を追加したが、比較対象となる期待 owner/repo をプロンプトへ渡して
// いなかった（PR 番号・headRefName は別リポジトリでも偶然一致し得るため、それだけでは誤配置
// worktree から別リポジトリの同名ブランチへ push できてしまう）。expectedRepo 引数がホスト
// 検証済みの owner/repo としてプロンプトへ明示的に埋め込まれ、remote 正規化・一致確認が
// gh fetch / checkout / merge より前（手順 0）に行われることを固定する。
test('baseMergePrompt: 期待 owner/repo がプロンプトへ明示的に埋め込まれ、fetch/checkout/merge より前に一致確認する', () => {
  const prompt = baseMergePrompt(item, impl, 'Fandhe-AI/agent-cli-skills')
  assert.ok(prompt.includes('"Fandhe-AI/agent-cli-skills"'), '期待 owner/repo の値がプロンプトへ埋め込まれていない')
  const remoteIdx = prompt.indexOf('git remote get-url origin')
  const expectedRepoIdx = prompt.indexOf('"Fandhe-AI/agent-cli-skills"')
  const fetchIdx = prompt.indexOf('git fetch origin &&')
  const baseFetchIdx = prompt.indexOf(':refs/remotes/origin/')
  const mergeIdx = prompt.indexOf('git merge --no-edit')
  assert.ok(remoteIdx >= 0, 'git remote get-url origin の指示がない')
  assert.ok(expectedRepoIdx >= 0, '期待 owner/repo の埋め込みが見つからない')
  assert.ok(expectedRepoIdx < fetchIdx, '期待 owner/repo の照合指示が git fetch より前に現れない')
  assert.ok(expectedRepoIdx < baseFetchIdx, '期待 owner/repo の照合指示が base fetch より前に現れない')
  assert.ok(expectedRepoIdx < mergeIdx, '期待 owner/repo の照合指示が merge より前に現れない')
  assert.ok(prompt.includes('.git'), '.git 接尾辞の除去指示がない')
  assert.ok(prompt.includes('ssh://git@'), 'SSH 形式の正規化指示がない')
  assert.ok(prompt.includes('https://<host>/<owner>/<repo>'), 'HTTPS 形式の正規化指示がない')
})

// 期待 owner/repo が未確定（host 側で isValidRepoSlug を通らなかった／引数省略）の場合、
// 常に不一致として fail-closed する契約を固定する。空文字を「常に不一致」の番人にするため、
// 埋め込み値自体が空文字であることと、その旨の分岐説明がプロンプトに含まれることを確認する。
test('baseMergePrompt: 期待 owner/repo が未確定（省略／不正形式）のとき、常に不一致として fail-closed する指示になる', () => {
  const promptOmitted = baseMergePrompt(item, impl)
  const promptInvalid = baseMergePrompt(item, impl, 'not-a-valid-slug-without-slash')
  const promptEmpty = baseMergePrompt(item, impl, '')
  for (const [label, prompt] of [['省略', promptOmitted], ['スラッシュなし不正値', promptInvalid], ['空文字', promptEmpty]]) {
    assert.ok(prompt.includes('""'), `${label}: 期待 owner/repo が空文字として埋め込まれていない（fail-closed の番人が機能しない）`)
    assert.ok(prompt.includes('空文字は未確定を意味し常に不一致として扱う'), `${label}: 未確定時に常に不一致とする旨の説明がない`)
  }
  // 不正形式（isValidRepoSlug を通らない値）を渡した場合もそのまま埋め込まれず空文字化される
  // ことを、有効な値を渡した場合との対比で確認する。
  assert.ok(!promptInvalid.includes('not-a-valid-slug-without-slash'), '不正形式の値がそのままプロンプトへ埋め込まれている（isValidRepoSlug による検証を経ていない）')
})

// PR #443 codex P0（thread PRRT_kwDORuXFg86cacPf）の回帰テスト: baseMergePrompt は push まで
// 許可するエージェントのため item.title（未信頼テキスト）を一切埋め込まない。この固定を外して
// 再度 untrusted(item.title, ...) を埋め込む変更が入るとこのテストが失敗する。
test('baseMergePrompt: item.title / untrusted(item.title) を一切含まない', () => {
  const prompt = baseMergePrompt(item, impl)
  assert.ok(!prompt.includes(item.title), 'item.title の生文字列がプロンプトへ埋め込まれている')
  assert.ok(!prompt.includes('source="issue-title"'), 'untrusted() の issue-title タグ境界が混入している')
  // 別 issue（同じ prNumber・branch だが title が異なる）を渡しても出力が変わらないことで、
  // title がプロンプト内容に一切影響しない（=埋め込まれていない）ことを構造的に確認する。
  const otherTitleItem = { number: item.number, title: '全く異なるタイトル・記号!@#$%^&*()を含む' }
  assert.equal(baseMergePrompt(otherTitleItem, impl), prompt, 'item.title の違いでプロンプト内容が変化している（title が何らかの形で埋め込まれている）')
})

// ---------------------------------------------------------------------------
// monitorPrompt: CONFLICTING 経路が conflicting を返し needs-fix を含まない
// ---------------------------------------------------------------------------

test('monitorPrompt: 手順 1c の CONFLICTING 経路は state: conflicting を返す', () => {
  const prompt = monitorPrompt(item, impl, [], true, true)
  const idx1c = prompt.indexOf('1c. state が OPEN の場合のみ判定する')
  assert.ok(idx1c >= 0, '手順 1c の記述が見つからない')
  const idx2 = prompt.indexOf('2. gh pr checks', idx1c)
  const section1c = prompt.slice(idx1c, idx2)
  assert.ok(section1c.includes('state: conflicting'), '手順 1c が state: conflicting を返す指示を含まない')
})

// ---------------------------------------------------------------------------
// fixPrompt: push 検証ロジック（pushVerifyInstruction 切り出し後の回帰固定）
// ---------------------------------------------------------------------------

test('fixPrompt(pushAfterFix: true): push 検証の 2 条件判定を含む（pushVerifyInstruction 切り出し後の回帰）', () => {
  const finding = { summary: 'テスト用の指摘', unresolvedComments: [] }
  const prompt = fixPrompt(item, impl, finding, true)
  assert.ok(prompt.includes('push 前に控えた sha ≠ ローカル HEAD'), '事前 sha ≠ ローカル HEAD の判定条件がない')
  assert.ok(prompt.includes('push 後の ls-remote sha == ローカル HEAD'), '事後 sha == ローカル HEAD の判定条件がない')
})

// ---------------------------------------------------------------------------
// 駆動部の構造アサーション（マーカー以降のソース走査。commitlint-enum-condition.test.mjs と同型）
// ---------------------------------------------------------------------------

test('駆動部: lastState === \'conflicting\' 分岐が存在し baseMergePrompt / baseMergeCount / maxBaseMerges / failMergeTerminal を含む', () => {
  // 単純な "lastState === 'conflicting'" 部分一致だと、より手前にある
  // "lastState === 'needs-fix' || lastState === 'conflicting'"（needs-fix と conflicting を
  // 一括 dispatch する別の分岐。line 4111 相当）の部分文字列にもマッチし、branchIdx が誤って
  // その手前の行を指してしまう（この誤指定のまま次の needs-fix 境界まで切り出すと、conflicting
  // 単独分岐だけでなく needs-fix 単独分岐（noPushRounds >= 2 の blocked 判定を含む）まで
  // branchBody に混入し、後続の分岐専有アサーションが意図せず緩くなる）。
  // 本テストが対象とする単独 `} else if (lastState === 'conflicting') {` 宣言のみに一致する
  // よう `} else if (` を含めて検索する。
  const branchIdx = driverPart.indexOf("} else if (lastState === 'conflicting') {")
  assert.ok(branchIdx >= 0, "駆動部に単独の `} else if (lastState === 'conflicting') {` 分岐が見つからない")
  // 次の else if までを分岐本体として切り出す（needs-fix 分岐との境界）。
  const nextBranchIdx = driverPart.indexOf("lastState === 'needs-fix' || lastState === 'unresolved-comments'", branchIdx)
  assert.ok(nextBranchIdx > branchIdx, 'needs-fix 分岐の開始位置を特定できない（conflicting 分岐の終端が不明）')
  const branchBody = driverPart.slice(branchIdx, nextBranchIdx)
  assert.ok(branchBody.includes('baseMergePrompt('), 'conflicting 分岐が baseMergePrompt を呼んでいない')
  assert.ok(branchBody.includes('baseMergeCount++'), 'conflicting 分岐が baseMergeCount を加算していない')
  assert.ok(branchBody.includes('maxBaseMerges'), 'conflicting 分岐が maxBaseMerges 上限を参照していない')
  assert.ok(branchBody.includes('failMergeTerminal('), 'conflicting 分岐が failMergeTerminal を呼んでいない')
  assert.ok(!branchBody.includes('fixCount++'), 'conflicting 分岐が fixCount を消費している（fix 予算と独立のはず）')
  // PR #443 codex 指摘の是正: base-merge push 成功時も CONFLICTING→fix 経路（needs-fix 分岐）と
  // 同じ advanceNoPushRounds を経由して noPushRounds をリセットする必要がある。リセットしないと
  // 直前の no-push fix ラウンドで積んだカウントが base merge の push 成功後も残留し、後続の
  // no-push fix 1 回だけで noPushRounds >= 2 に達して誤って blocked 終端し得る
  // （リモートへは実際に進捗があったのに）。noPushRounds への「参照」自体は正当な進捗リセットで
  // あり禁止しないが、fix ループ専用の分岐終了条件（`noPushRounds >= 2` によるブロック判定）は
  // 引き続き conflicting 分岐に持ち込まない。
  assert.ok(branchBody.includes('advanceNoPushRounds('), 'conflicting 分岐が advanceNoPushRounds を呼んでいない（push 成功時の noPushRounds リセットが未実装）')
  assert.ok(!branchBody.includes('noPushRounds >= 2'), 'conflicting 分岐が fix ループ専用の blocked 終端条件（noPushRounds >= 2）を持ち込んでいる')
})

// ---------------------------------------------------------------------------
// 駆動部: baseMergeCount >= maxBaseMerges 上限到達時の終端分類（Issue #441 codex-review P1・PR #443
// の回帰）。'unrecoverable' を使うと terminalStatus 決定部
// （`blockedIsRecoverable = lastState === 'blocked' && lastBlockedReason === 'quality'`）が
// 'failed'（halt カウント対象）へ倒し、SKILL.md・args-example.json の「コンフリクトは即 blocked
// にする」という公開契約と不一致になり、maxBaseMerges: 0 の明示オプトアウトだけで連続失敗 halt を
// 誘発していた。上限到達専用の if ブロックのみを切り出し、'quality' を設定し 'unrecoverable' を
// 一切含まないことを固定する（同分岐内の他コメントに 'unrecoverable' という語自体が残っていても
// 誤検出しないよう、実際に代入している行を対象にする）。
// ---------------------------------------------------------------------------

test('駆動部: baseMergeCount >= maxBaseMerges 到達時は lastBlockedReason を quality に設定する（unrecoverable を代入しない）', () => {
  const capIdx = driverPart.indexOf('if (baseMergeCount >= maxBaseMerges) {')
  assert.ok(capIdx >= 0, 'baseMergeCount >= maxBaseMerges の上限到達ブロックが見つからない')
  const capEndIdx = driverPart.indexOf('\n      }', capIdx)
  assert.ok(capEndIdx > capIdx, '上限到達ブロックの終端（break を含む閉じ括弧）が見つからない')
  const capBody = driverPart.slice(capIdx, capEndIdx)
  assert.ok(capBody.includes("lastBlockedReason = 'quality'"), '上限到達ブロックが lastBlockedReason を quality に設定していない')
  assert.ok(!capBody.includes("lastBlockedReason = 'unrecoverable'"), '上限到達ブロックが lastBlockedReason に unrecoverable を代入している（blocked ではなく failed 終端へ倒れる）')
  assert.ok(capBody.includes("lastState = 'blocked'"), '上限到達ブロックが lastState を blocked に設定していない')
  assert.ok(capBody.includes('break'), '上限到達ブロックが break していない')
  // maxBaseMerges: 0 の明示オプトアウトは cap-reached と同じ if 条件（0 >= 0）を通るため、
  // 「上限到達」ではなく「無効化されている」という別文言を出し分ける契約を固定する
  // （0 回到達というメッセージは opt-out の実態と合わないため）。
  assert.ok(capBody.includes('maxBaseMerges === 0'), '上限到達ブロックが maxBaseMerges === 0 の分岐を持たない（opt-out 専用メッセージがない）')
})

test('駆動部: baseMergeCount の状態ファイル復元と runMergeLoop への引き渡しが存在する', () => {
  assert.ok(driverPart.includes('savedBaseMergeCount'), '駆動部に savedBaseMergeCount の復元が見つからない')
  assert.ok(driverPart.includes('initialBaseMergeCount'), 'runMergeLoop の initialBaseMergeCount 引数が見つからない')
})

test('駆動部: merge-loop-rescan の境界マーカー対の出現回数が変わらない（1 回のまま）', () => {
  const startCount = driverPart.split('__MERGE_MONITOR_LOOP_START__').length - 1
  assert.equal(startCount, 1, '__MERGE_MONITOR_LOOP_START__ マーカーの出現回数が 1 でない（conflicting 分岐追加でループ境界が壊れていないか確認）')
})

// ---------------------------------------------------------------------------
// isValidRepoSlug（Bugbot Medium・PR #443・thread PRRT_kwDORuXFg86ca6Y_ の回帰）: repo セグメント
// が先頭 `.` を許可し（`org/.github` のような実在の正当な名前）、`.`/`..` という特殊パス名のみ
// 除外すること。owner セグメントは英数字とハイフンのみ・先頭末尾ハイフン不可・39 文字以内。
// ---------------------------------------------------------------------------

test('isValidRepoSlug: 先頭 `.` の repo 名（`.github` 等）を受理する', () => {
  assert.equal(isValidRepoSlug('org/.github'), true)
  assert.equal(isValidRepoSlug('Fandhe-AI/.github'), true)
})

test('isValidRepoSlug: `.`/`..` という repo セグメント単体は拒否する（パストラバーサル特殊名）', () => {
  assert.equal(isValidRepoSlug('org/.'), false)
  assert.equal(isValidRepoSlug('org/..'), false)
})

test('isValidRepoSlug: owner セグメントは英数字とハイフンのみ・先頭末尾ハイフン不可', () => {
  assert.equal(isValidRepoSlug('-org/repo'), false)
  assert.equal(isValidRepoSlug('org-/repo'), false)
  assert.equal(isValidRepoSlug('org.name/repo'), false)
  assert.equal(isValidRepoSlug('a'.repeat(40) + '/repo'), false, 'owner 39 文字超は拒否')
  assert.equal(isValidRepoSlug('a'.repeat(39) + '/repo'), true, 'owner 39 文字ちょうどは受理')
})

test('isValidRepoSlug: repo セグメントは `.`/`_`/`-`（先頭ハイフン以外）を許可し 100 文字以内', () => {
  assert.equal(isValidRepoSlug('org/_private'), true)
  assert.equal(isValidRepoSlug('org/repo-name'), true)
  assert.equal(isValidRepoSlug('org/-repo'), false, 'repo 先頭ハイフンは拒否')
  assert.equal(isValidRepoSlug('org/' + 'a'.repeat(100)), true, 'repo 100 文字ちょうどは受理')
  assert.equal(isValidRepoSlug('org/' + 'a'.repeat(101)), false, 'repo 101 文字は拒否')
})

test('isValidRepoSlug: 従来どおりスラッシュなし・空文字・型不一致は拒否する', () => {
  assert.equal(isValidRepoSlug('not-a-valid-slug-without-slash'), false)
  assert.equal(isValidRepoSlug(''), false)
  assert.equal(isValidRepoSlug(undefined), false)
  assert.equal(isValidRepoSlug(null), false)
})

// ---------------------------------------------------------------------------
// parseRepoArg（PR #443 codex P0 回帰）: expectedRepo の唯一の信頼できる入力源。
// エージェント自己申告値ではなく args.repo（ホスト側明示宣言）のみを受理する。
// ---------------------------------------------------------------------------

test('parseRepoArg: undefined/null は未確定（空文字）を返す', () => {
  assert.equal(parseRepoArg(undefined), '')
  assert.equal(parseRepoArg(null), '')
})

test('parseRepoArg: owner/repo 形式はそのまま受理する', () => {
  assert.equal(parseRepoArg('Fandhe-AI/agent-cli-skills'), 'Fandhe-AI/agent-cli-skills')
  assert.equal(parseRepoArg('org/.github'), 'org/.github')
})

test('parseRepoArg: isValidRepoSlug を通らない形式は throw する（誤読み替え防止・fail-closed）', () => {
  assert.throws(() => parseRepoArg('not-a-valid-slug-without-slash'), /args\.repo/)
  assert.throws(() => parseRepoArg(''), /args\.repo/)
  assert.throws(() => parseRepoArg(123), /args\.repo/)
  assert.throws(() => parseRepoArg({ owner: 'org', repo: 'repo' }), /args\.repo/)
})

// ---------------------------------------------------------------------------
// expectedRepo の代入元（PR #443 codex P0 回帰）: エージェント自己申告値（detectResult 等）
// から代入されず、ホスト検証済みの repoArg（= args.repo 由来）からのみ代入されること。
// ---------------------------------------------------------------------------

test('expectedRepo は repoArg（args.repo 由来のホスト検証済み値）からのみ代入され、detectResult からは代入されない', () => {
  const assignIdx = source.indexOf('const expectedRepo = ')
  assert.ok(assignIdx >= 0, 'expectedRepo の代入行が見つからない')
  const lineEnd = source.indexOf('\n', assignIdx)
  const assignLine = source.slice(assignIdx, lineEnd)
  assert.equal(assignLine, 'const expectedRepo = repoArg', `expectedRepo の代入がエージェント申告値経由になっている: ${assignLine}`)
  assert.ok(!assignLine.includes('detectResult'), 'expectedRepo がエージェント自己申告値 detectResult から代入されている')
})

// ---------------------------------------------------------------------------
// 駆動部: expectedRepo 未確定時は baseMergePrompt を起動せず blocked + quality へ直接終端する
// （Bugbot High・PR #443・thread PRRT_kwDORuXFg86ca6Y1 の回帰）。cap 到達到達分岐と同じ
// 「回復可能な CONFLICTING」クラスとして扱い、routingError 経由の 'unrecoverable'（'failed' へ
// 倒れ halt カウント対象になる）を一切通らないことを固定する。
// ---------------------------------------------------------------------------

test("駆動部: conflicting 分岐は expectedRepo === '' を baseMergePrompt 起動より前に判定し、blocked + quality へ直接終端する", () => {
  const branchIdx = driverPart.indexOf("} else if (lastState === 'conflicting') {")
  assert.ok(branchIdx >= 0, "conflicting 分岐が見つからない")
  const guardIdx = driverPart.indexOf("if (expectedRepo === '') {", branchIdx)
  assert.ok(guardIdx > branchIdx, 'conflicting 分岐に expectedRepo 未確定ガードが見つからない')
  const capIdx = driverPart.indexOf('if (baseMergeCount >= maxBaseMerges) {', branchIdx)
  assert.ok(capIdx > guardIdx, 'expectedRepo 未確定ガードが cap 到達判定より後に現れている（baseMergePrompt 起動より前に判定する必要がある）')
  const guardEndIdx = driverPart.indexOf('\n      }', guardIdx)
  assert.ok(guardEndIdx > guardIdx, 'expectedRepo 未確定ガードの終端（break を含む閉じ括弧）が見つからない')
  const guardBody = driverPart.slice(guardIdx, guardEndIdx)
  assert.ok(guardBody.includes("lastBlockedReason = 'quality'"), 'expectedRepo 未確定ガードが lastBlockedReason を quality に設定していない')
  assert.ok(guardBody.includes("lastState = 'blocked'"), 'expectedRepo 未確定ガードが lastState を blocked に設定していない')
  assert.ok(guardBody.includes('break'), 'expectedRepo 未確定ガードが break していない')
  assert.ok(!guardBody.includes('baseMergePrompt('), 'expectedRepo 未確定ガードが baseMergePrompt を起動している（未起動でホスト側直接終端するはず）')
  assert.ok(!guardBody.includes("lastBlockedReason = 'unrecoverable'"), 'expectedRepo 未確定ガードが unrecoverable を代入している（failed/halt カウント対象へ倒れる）')
})

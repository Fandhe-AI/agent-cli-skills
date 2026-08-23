// implement-issue-tree の Merge ループ resolve 例外条件 (b)（push なしラウンド）の許可判定を
// ホスト側の決定的照合のみで行うことを固定する回帰テスト（Issue #430。親 #427 / codex-review
// P0 の残課題。依存 #429 は完了済みで、origin/main の AGENTS.md「例外(b)」節が本 Issue の
// 実装を前提にしている）。
//
// 対象: 従来の (b) 経路（PR #424/#426）は「過去 push 済みの修正がリモート head に反映済みで
// あること」を fix エージェント自身の git fetch + merge-base --is-ancestor 実行と自己申告に
// 依存していた。fix 申告の sha は形式検証を経ても任意の祖先 sha で ancestry 照合を通過でき、
// resolve 対象スレッドと実際の修正コミットの対応も fix 自身の未検証な判断に委ねられていた。
//
// 是正後の契約（AGENTS.md「例外(b)」節）:
//   1. host が自ら観測した push の結果 sha に対してのみ判定する（fix 申告 sha は使わない）。
//   2. リモート head への反映確認は host が実行する決定的照合（monitor が返す compareStatus。
//      ホストが渡した前回観測 sha からの gh api compare 結果）で行う。
//   3. 対象スレッドと修正コミットの対応も、fix の判断に依存せず決定的に立証できる場合に限る。
//
// 【追記・恒久無効化（Issue #430 codex-review P0 再指摘・PR #433）】: 上記 2 の compareStatus /
// changedFiles は、未信頼のレビュー本文を読む monitor エージェント（merge-verify とは異なり
// 未信頼テキスト不読ではない）の構造化出力の自己申告にすぎず、ホストはこの Workflow ランタイム
// （`export const meta` 以外の top-level export 不可・child_process 等の直接シェル実行手段なし）
// では `gh api compare` を自ら実行して裏取りできない。sanitizeSha・enum・sanitizeRepoRelPath は
// 値の形式しか検証できず真偽は検証できないため、プロンプトインジェクションを受けた monitor が
// 虚偽の compareStatus: "ahead" と都合の良い changedFiles を返すと、3 の path 対応（上界判定）
// を根拠に push なしでの resolve が許可され得た。専用の未信頼テキスト不読 proof エージェント
// （merge-verify と同型の新設。follow-up）を用意するまで、`computePermittedNoPushResolveIds`
// は proofState の内容に関わらず常に空リストを返す（fail-closed）。本ファイルの
// `applyResolveProofObservation` 系テスト（状態遷移の純粋関数契約）はこの無効化と無関係に
// 有効なまま残す。
//
// 検証の三層構造（merge-loop-rescan.test.mjs / nopush-resolve-progress.test.mjs と同じ方針）:
//   1. 純粋関数（applyResolveProofObservation / computePermittedNoPushResolveIds /
//      sanitizeRepoRelPath）のテストで状態遷移・許可算出の契約を固定する。
//   2. runMergeLoop はハーネス依存で import 不能のため、ソース走査で「proof 観測が fix 起動前に
//      行われる」「許可リストが fixPrompt へ渡る」「pushed:false の受理が許可リストで絞られる」
//      配線を機械検証する。
//   3. fixPrompt の文言で、fix 自身による反映確認（git fetch + merge-base --is-ancestor）の
//      指示が (b) 経路から削除されていることを固定する（resolve-pushed-head.test.mjs と役割分担:
//      同ファイルは fixPrompt 文言の詳細、本ファイルはホスト側の状態遷移・配線を担当する）。
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
// マーカー文字列はソース中に 1 回しか現れてはならない（g0-gates.test.mjs が出現回数を固定して
// いる）ため、リテラルを直接書かず分割して組み立てる。
const DRIVER_MARKER = ['__IMPLEMENT', 'ISSUE', 'TREE', 'DRIVER', 'START__'].join('_')

const source = readFileSync(SCRIPT_PATH, 'utf8')
const markerIndex = source.indexOf(DRIVER_MARKER)
if (markerIndex < 0) {
  throw new Error(`テスト境界マーカー ${DRIVER_MARKER} が実装スクリプトに存在しない（削除・改名は回帰テストを無効化する）`)
}
const definitionPart = source.slice(0, source.lastIndexOf('\n', markerIndex))
const driverPart = source.slice(markerIndex)
const sliceDir = mkdtempSync(join(tmpdir(), 'implement-issue-tree-resolve-proof-'))
const slicePath = join(sliceDir, 'implement-issue-tree-defs.mjs')
// 実装スクリプトは Workflow ランタイムの制約により `export const meta` 以外の top-level export を
// 持てない。定義部は非 export のまま置き、テスト側でスライスへ export 文を付与して読み込む。
// applyResolveProofObservation は MERGE_SCHEMA（同じ定義部内、後方定義）を内部参照するため、
// スライスへは定義部全体をそのまま含める（関数を単体で切り出さない）。
const SLICE_EXPORTS = ['applyResolveProofObservation', 'computePermittedNoPushResolveIds', 'sanitizeRepoRelPath', 'computeVerifiedPushed']
writeFileSync(slicePath, `${definitionPart}\nexport { ${SLICE_EXPORTS.join(', ')} }\n`)

const mod = await import(pathToFileURL(slicePath).href)
const { applyResolveProofObservation, computePermittedNoPushResolveIds, sanitizeRepoRelPath, computeVerifiedPushed } = mod

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const emptyProof = { head: '', pushHead: '', files: [] }

// ---------------------------------------------------------------------------
// sanitizeRepoRelPath: path 対応判定の入力検証
// ---------------------------------------------------------------------------

test('sanitizeRepoRelPath: 通常の相対パスはそのまま受理する', () => {
  assert.equal(sanitizeRepoRelPath('skills/foo/bar.js'), 'skills/foo/bar.js')
})

test('sanitizeRepoRelPath: 先頭 "/"・".."・制御文字を含むパスは空文字へ落とす（パストラバーサル対策）', () => {
  assert.equal(sanitizeRepoRelPath('/etc/passwd'), '')
  assert.equal(sanitizeRepoRelPath('../../etc/passwd'), '')
  assert.equal(sanitizeRepoRelPath('foo/\x00bar'), '')
  assert.equal(sanitizeRepoRelPath(''), '')
  assert.equal(sanitizeRepoRelPath(undefined), '')
})

// ---------------------------------------------------------------------------
// applyResolveProofObservation: push 実測・ancestry の状態遷移
// ---------------------------------------------------------------------------

test('applyResolveProofObservation: lastRoundPushed かつ ahead のときのみ pushHead を進め files を合算する', () => {
  const next = applyResolveProofObservation(
    emptyProof,
    { headSha: SHA_A, compareStatus: 'ahead', changedFiles: ['a.js', 'b.js'] },
    true,
  )
  assert.equal(next.head, SHA_A)
  assert.equal(next.pushHead, SHA_A)
  assert.deepEqual(next.files, ['a.js', 'b.js'])
})

test('applyResolveProofObservation: ahead でも lastRoundPushed が false なら pushHead を進めない（fix 申告への非依存）', () => {
  const prior = { head: SHA_A, pushHead: '', files: [] }
  const next = applyResolveProofObservation(
    prior,
    { headSha: SHA_B, compareStatus: 'ahead', changedFiles: ['c.js'] },
    false,
  )
  assert.equal(next.head, SHA_B, 'head 自体は観測値へ進む')
  assert.equal(next.pushHead, '', 'push 実測（lastRoundPushed）が無ければ pushHead は進めない')
  assert.deepEqual(next.files, [], 'files も合算しない')
})

test('applyResolveProofObservation: identical は push 申告はあっても前進しておらず pushHead を据え置く', () => {
  const prior = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  const next = applyResolveProofObservation(prior, { headSha: SHA_A, compareStatus: 'identical' }, true)
  assert.equal(next.pushHead, SHA_A)
  assert.deepEqual(next.files, ['a.js'])
})

test('applyResolveProofObservation: behind/diverged（force-push 等の履歴書き換え）は fail-closed で全体をリセットする', () => {
  const prior = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  for (const status of ['behind', 'diverged']) {
    const next = applyResolveProofObservation(prior, { headSha: SHA_B, compareStatus: status }, true)
    assert.equal(next.pushHead, '', `${status} は pushHead をリセットするべき`)
    assert.deepEqual(next.files, [], `${status} は files をリセットするべき`)
  }
})

test('applyResolveProofObservation: compareStatus が enum 外・欠落なら unknown として fail-closed リセットする', () => {
  const prior = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  const next = applyResolveProofObservation(prior, { headSha: SHA_B, compareStatus: 'not-a-real-status' }, true)
  assert.equal(next.pushHead, '')
  assert.deepEqual(next.files, [])
})

test('applyResolveProofObservation: headSha が sanitizeSha 不通過（40 桁 hex でない）なら head も空にして全体をリセットする', () => {
  const prior = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  const next = applyResolveProofObservation(prior, { headSha: 'not-a-sha', compareStatus: 'ahead' }, true)
  assert.equal(next.head, '')
  assert.equal(next.pushHead, '')
  assert.deepEqual(next.files, [])
})

test('applyResolveProofObservation: 複数回の ahead 観測で files が累積する（複数ラウンドにまたがる push の合算）', () => {
  let proof = emptyProof
  proof = applyResolveProofObservation(proof, { headSha: SHA_A, compareStatus: 'ahead', changedFiles: ['a.js'] }, true)
  proof = applyResolveProofObservation(proof, { headSha: SHA_B, compareStatus: 'identical' }, false)
  proof = applyResolveProofObservation(proof, { headSha: SHA_C, compareStatus: 'ahead', changedFiles: ['c.js'] }, true)
  assert.equal(proof.pushHead, SHA_C)
  assert.deepEqual(proof.files, ['a.js', 'c.js'], '過去 push 分の対応ファイルが失われず合算されている')
})

test('applyResolveProofObservation: changedFiles の path 検証不通過分は合算対象から除外する', () => {
  const next = applyResolveProofObservation(
    emptyProof,
    { headSha: SHA_A, compareStatus: 'ahead', changedFiles: ['ok.js', '../escape.js', '/abs.js'] },
    true,
  )
  assert.deepEqual(next.files, ['ok.js'])
})

// ---------------------------------------------------------------------------
// computePermittedNoPushResolveIds: (b) 経路は恒久的に無効化（常に空リスト。Issue #430
// codex-review P0 再指摘。headSha/compareStatus/changedFiles は未信頼レビュー本文を読む
// monitor の自己申告にすぎず、ホストは gh api compare を自ら実行して裏取りできない
// （Workflow ランタイムに直接シェル実行手段がない）ため、path 一致による上界判定を
// 許可根拠にできなくなった。専用の未信頼テキスト不読 proof エージェント新設までの
// fail-closed 措置）
// ---------------------------------------------------------------------------

test('computePermittedNoPushResolveIds: pushHead 未確立（proof 未成立）でも常に空リスト', () => {
  const ids = computePermittedNoPushResolveIds(emptyProof, [{ threadId: 'PRRT_a', path: 'a.js' }])
  assert.deepEqual(ids, [])
})

test('computePermittedNoPushResolveIds: proofState が push 実測済み（pushHead 確立・files 実在）でも path 一致に関わらず常に空リストを返す（(b) 経路の恒久無効化）', () => {
  const proof = { head: SHA_A, pushHead: SHA_A, files: ['a.js', 'b.js'] }
  const unresolved = [
    { threadId: 'PRRT_in_a', path: 'a.js' },
    { threadId: 'PRRT_in_b', path: 'b.js' },
    { threadId: 'PRRT_outside', path: 'c.js' },
  ]
  const ids = computePermittedNoPushResolveIds(proof, unresolved)
  assert.deepEqual(ids, [], '旧実装なら path 一致で許可されていた PRRT_in_a / PRRT_in_b も含め、無条件で空を返す')
})

test('computePermittedNoPushResolveIds: unresolvedComments が非配列・欠落でも安全に空を返す', () => {
  const proof = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  assert.deepEqual(computePermittedNoPushResolveIds(proof, undefined), [])
  assert.deepEqual(computePermittedNoPushResolveIds(proof, null), [])
})

test('computePermittedNoPushResolveIds: threadId 形式不正の要素を含んでいても（形式検証を経由しない）常に空を返す', () => {
  const proof = { head: SHA_A, pushHead: SHA_A, files: ['a.js'] }
  const ids = computePermittedNoPushResolveIds(proof, [{ threadId: 'has space', path: 'a.js' }])
  assert.deepEqual(ids, [])
})

// ---------------------------------------------------------------------------
// computeVerifiedPushed（Issue #435 派生 codex P0）: git push は「送るものが何もない」no-op
// でも exit 0 になるため、fix の pushed 自己申告だけを resolve (a) の許可根拠にすると、
// no-op push を毎ラウンド実行して pushed: true を自己申告するだけで resolve (b) の恒久
// fail-closed（本ファイルの主題）を実質迂回できてしまう。preSha/postSha（同じ fix 応答内の
// origin/<branch> push 前後 sha）で実際に head が進んだことを裏取りする。
// ---------------------------------------------------------------------------

test('computeVerifiedPushed: pushed:true かつ preSha!==postSha（head が実際に進んだ）なら true', () => {
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B), true)
})

test('computeVerifiedPushed: pushed:true でも preSha===postSha（no-op push）なら false（P0 対策の核心）', () => {
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_A), false)
})

test('computeVerifiedPushed: pushed:false は preSha/postSha の内容に関わらず false', () => {
  assert.equal(computeVerifiedPushed(false, SHA_A, SHA_B), false)
  assert.equal(computeVerifiedPushed(false, SHA_A, SHA_A), false)
})

test('computeVerifiedPushed: preSha/postSha が 40 桁 hex でない（形式不正・空・欠落）場合は pushed:true でも false（fail-closed）', () => {
  assert.equal(computeVerifiedPushed(true, '', SHA_B), false)
  assert.equal(computeVerifiedPushed(true, SHA_A, ''), false)
  assert.equal(computeVerifiedPushed(true, 'not-a-sha', SHA_B), false)
  assert.equal(computeVerifiedPushed(true, undefined, undefined), false)
})

// ---------------------------------------------------------------------------
// computeVerifiedPushed の第 4 引数 hostPreSha（PR #436 codex-review P0 対応）:
// preSha/postSha 自体が同一 fix 応答内の未検証な自己申告であるため、prompt injection を
// 受けた fix が「40 桁 hex で異なる 2 値」を単に捏造するだけで pushed: true を通過させ得る
// 懸念が残っていた。host が独立取得した preSha（runMergeLoop の resolveProof.head。fix 起動
// より前の当該ラウンドの monitor が自身の gh pr view で取得した値）と fix 申告の preSha を
// 照合し、食い違えば未検証（false）とする。
// ---------------------------------------------------------------------------

test('computeVerifiedPushed: hostPreSha 未指定（host 未取得）の場合は従来どおり自己申告のみで判定する（後方互換）', () => {
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B), true)
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B, ''), true)
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B, undefined), true)
})

test('computeVerifiedPushed: fix 申告の preSha が hostPreSha と一致すれば true', () => {
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B, SHA_A), true)
})

test('computeVerifiedPushed: fix 申告の preSha が hostPreSha と食い違う場合は pushed:true・preSha!==postSha でも false（捏造対策の核心）', () => {
  // fix が preSha=SHA_A/postSha=SHA_B という「形式上は正しい・互いに異なる」2 値を自己申告して
  // いても、host が独立観測した直前の origin/<branch> が SHA_C（SHA_A ではない）なら、fix が
  // 実際に fetch した値を報告していない疑いが強いため未検証として扱う。
  assert.equal(computeVerifiedPushed(true, SHA_A, SHA_B, SHA_C), false)
})

// ---------------------------------------------------------------------------
// 配線検証: runMergeLoop が「proof 観測 → 許可リスト算出 → fixPrompt」の順で配線され、
// pushed:false の受理が許可リストで絞られること（純粋関数テストだけでは配線なしでもグリーンになる）
// ---------------------------------------------------------------------------

test('runMergeLoop: monitor 呼び出し・proof 観測・fix 起動がこの順で配線される（proof は fix 起動前に確定する）', () => {
  const monitorCallIndex = driverPart.indexOf('monitorPrompt(item, impl,')
  assert.ok(monitorCallIndex >= 0, 'monitorPrompt の呼び出しが見つからない')
  const observeIndex = driverPart.indexOf('applyResolveProofObservation(resolveProof,', monitorCallIndex)
  assert.ok(observeIndex > monitorCallIndex, 'proof 観測（applyResolveProofObservation）が monitor 呼び出しより後ろで確定していない')
  const permittedIndex = driverPart.indexOf('computePermittedNoPushResolveIds(resolveProof,', observeIndex)
  assert.ok(permittedIndex > observeIndex, '許可リスト算出が proof 観測より前で行われている（更新前の古い proof を使ってしまう）')
  const fixCallIndex = driverPart.indexOf('fixPrompt(item, impl, finding, true, permittedNoPushResolveIds)', permittedIndex)
  assert.ok(fixCallIndex > permittedIndex, '許可リストが fixPrompt 呼び出しへ渡っていない、または算出より前で fix が起動している')
})

test('runMergeLoop: monitor 呼び出しは resolveProof.head を prevSha として渡す（host 観測の入力を host 自身が用意する）', () => {
  assert.ok(
    driverPart.includes('monitorPrompt(item, impl, externalCheckApps, externalChecksConfirmed, autoMergeEnabled && externalChecksConfirmed && externalChecksContextsConfirmed, forceThreadRescan, resolveProof.head)'),
    'monitorPrompt の呼び出しに resolveProof.head（prevSha）が渡っていない',
  )
})

test('runMergeLoop: fix 自己申告の resolvedThreadIds は当該ラウンドの finding.unresolvedComments との交差のみを resolve 候補とする（PR #436 Cursor Bugbot High）', () => {
  const branchStart = driverPart.indexOf('if (Array.isArray(f.resolvedThreadIds)) {')
  assert.ok(branchStart >= 0, 'runMergeLoop に resolvedThreadIds の処理分岐が見つからない')
  const branchEnd = driverPart.indexOf('f.outOfScopeComments', branchStart)
  assert.ok(branchEnd > branchStart, 'resolvedThreadIds 分岐の終端（outOfScopeComments 処理）が見つからない')
  const branchSource = driverPart.slice(branchStart, branchEnd)
  assert.ok(
    branchSource.includes('finding?.unresolvedComments') && branchSource.includes('unresolvedTidSet.has('),
    'resolve 候補が当該ラウンドの finding.unresolvedComments との交差に限定されていない（AGENTS.md L82-85 の契約違反）',
  )
  assert.ok(
    branchSource.includes('pushVerified'),
    // pushVerified（f.pushed を preSha/postSha で裏取りした値。Issue #435 派生 codex P0）は
    // resolvedThreadsLogLine のログ引数としてのみ参照される（PR #436 Cursor Bugbot Medium 対応で、
    // resolve 候補の生成条件からは切り離した。実際の mutation 可否は resolveVerified が単独で握る）。
    'pushVerified への参照（ログ用途）が見つからない',
  )
  assert.ok(
    !branchSource.includes('permittedNoPushResolveIds.includes('),
    // PR #436 Cursor Bugbot Medium: pushVerified 由来の許可リストで resolve 候補を空にすると、
    // 実際には push 済みでも自己申告の preSha/postSha 書式不備だけで resolveThreadsPrompt 自体が
    // 呼ばれなくなり、host 独立検証（resolveVerified）の機会が失われる。候補生成の絞り込みは
    // finding.unresolvedComments との交差のみで行う（上のアサーション）。
    'resolve 候補の生成が pushVerified 由来の許可リスト（permittedNoPushResolveIds）で再びゲートされている',
  )
})

test('runMergeLoop: resolveProof は状態ファイルへ永続化しない（resume 直後は必ず空 = fail-closed）', () => {
  // 永続化すると resume 後に前回観測を引き継いでしまい、fix 申告に依存しない再測定という
  // fail-closed 契約が崩れる（プロセス内限定のスコープであることを固定する）。
  assert.ok(!source.includes('saved.resolveProof'), '状態ファイルから resolveProof を復元する経路が追加されている')
  assert.ok(!source.includes('resolveProof }'), 'updateState のパッチへ resolveProof が紛れ込んでいる（永続化の再導入）')
})

test('runMergeLoop: lastRoundPushed は proof 観測の直後に false へ戻し、1 回限りで消費する', () => {
  const observeIndex = driverPart.indexOf('applyResolveProofObservation(resolveProof,')
  assert.ok(observeIndex >= 0, 'proof 観測の呼び出しが見つからない')
  const afterObserve = driverPart.slice(observeIndex, observeIndex + 300)
  assert.ok(
    afterObserve.includes('lastRoundPushed = false'),
    'proof 観測の直後で lastRoundPushed をリセットしていない（fix 非起動ラウンドを挟んだ次の ahead 観測を誤って再クレジットする回帰）',
  )
})

// ---------------------------------------------------------------------------
// 配線検証（PR #436 codex-review P0）: computeVerifiedPushed の呼び出しに host 独立観測の
// resolveProof.head（hostPreSha）が渡っており、fix 自己申告の preSha/postSha だけに依存して
// いないこと。純粋関数テストだけでは配線なしでもグリーンになるためソース走査で固定する。
// ---------------------------------------------------------------------------

test('runMergeLoop: computeVerifiedPushed の呼び出しに resolveProof.head（host 独立観測の preSha）を渡す', () => {
  assert.ok(
    driverPart.includes('computeVerifiedPushed(f.pushed, f.preSha, f.postSha, resolveProof.head)'),
    'computeVerifiedPushed が fix 自己申告の preSha/postSha のみで呼ばれている（host 独立観測との照合が配線されていない）',
  )
})

test('runMergeLoop: 検証済み push の postSha を次ラウンド monitor の独立観測 headSha と事後照合する（pendingPushClaim）', () => {
  assert.ok(source.includes('let pendingPushClaim = null'), 'pendingPushClaim の初期化が見つからない')
  const setIndex = driverPart.indexOf('if (pushVerified) pendingPushClaim = { postSha: sanitizeSha(f.postSha) }')
  assert.ok(setIndex >= 0, '検証済み push の postSha を pendingPushClaim へ記憶する配線が見つからない')
  const reconcileIndex = driverPart.indexOf('if (pendingPushClaim) {')
  assert.ok(reconcileIndex >= 0, '次ラウンド monitor 後の pendingPushClaim 事後照合が見つからない')
  const reconcileBlock = driverPart.slice(reconcileIndex, reconcileIndex + 600)
  assert.ok(
    reconcileBlock.includes('pendingPushClaim = null'),
    '事後照合後に pendingPushClaim をクリアしていない（次々ラウンドへ誤って持ち越す回帰）',
  )
})

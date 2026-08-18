// reassign-sub-issue.test.mjs — Issue #297 対応の決定的回帰テスト。
// 先行 PR #295（blocked）で codex に指摘された 4 弱点への直接的な回答:
//   1. 変数の初期化と参照が別コードフェンスに分かれる → 単一プロセスのスクリプトで検証可能に
//   2. DELETE 失敗検知なしに POST へ進む → ケース 6 で「POST が 1 件も呼ばれない」ことを実測
//   3. 冪等性判定が実行より 1 巡遅れる → ケース 3 で DELETE/POST 双方が呼ばれないことを実測
//   4. 事後確認のスナップショット汚染 → 事前 GET と事後 GET を呼び出しログで区別して検証
//
// 実 API には触れず、tests/lib/gh-stub.mjs が生成する差し替え gh をスクリプトへ渡す。
// スクリプトは exec ビット + shebang 経由でパス直接実行する（bash 経由のラップはしない）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGhStub } from './lib/gh-stub.mjs'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'reassign-sub-issue.sh',
)

function run(args, fixture) {
  const stub = createGhStub(fixture)
  let status = 0
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync(SCRIPT_PATH, args, {
      env: { ...process.env, ...stub.env },
      encoding: 'utf8',
    })
  } catch (err) {
    status = err.status ?? 1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  return { status, stdout, stderr, logPath: stub.logPath }
}

function calls(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
}

test('ケース1: 引数なし → exit 1、API 呼び出しゼロ', () => {
  const r = run([], {})
  assert.equal(r.status, 1)
  assert.deepEqual(calls(r.logPath), [])
})

test('ケース2: issue 番号に非数値（インジェクション試行）→ exit 1、API 呼び出しゼロ', () => {
  const r = run(['--issue', '12; rm -rf /', '--new-parent', '1'], {})
  assert.equal(r.status, 1)
  assert.deepEqual(calls(r.logPath), [])
})

test('ケース2b: --repo に不正な形式 → exit 1、API 呼び出しゼロ', () => {
  const r = run(['--issue', '1', '--new-parent', '2', '--repo', 'not a repo'], {})
  assert.equal(r.status, 1)
  assert.deepEqual(calls(r.logPath), [])
})

test('ケース3: 既に新親配下（already-attached）→ exit 0、DELETE も POST も呼ばれない', () => {
  const r = run(['--issue', '10', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '7',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=already-attached issue=10 new_parent=7 old_parent=7$/)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が呼ばれていないこと')
})

test('ケース4: 孤児（--old-parent 省略）→ exit 0 posted-only、POST のみ・DELETE なし', () => {
  const r = run(['--issue', '11', '--new-parent', '7'], {
    parentBefore: '',
    parentAfter: '7',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=posted-only issue=11 new_parent=7 old_parent=-$/)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が呼ばれていないこと')
  assert.ok(c.some((l) => l.includes('--method POST')), 'POST が呼ばれていること')
})

test('ケース5: 正常な付け替え → exit 0 reassigned、呼び出し順が GET→GET(新親)→DELETE→POST→GET', () => {
  const r = run(['--issue', '12', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '7',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=reassigned issue=12 new_parent=7 old_parent=5$/)
  const c = calls(r.logPath).filter((l) => l.startsWith('api'))
  const kinds = c.map((l) => {
    if (l.includes('--method DELETE')) return 'DELETE'
    if (l.includes('--method POST')) return 'POST'
    return 'GET'
  })
  // 2 件目の GET が Issue #333 で追加した新親の事前検証（DELETE の前に撃つ）
  assert.deepEqual(kinds, ['GET', 'GET', 'DELETE', 'POST', 'GET'])
})

test('ケース6: DELETE が非ゼロ（404） → exit 3、POST は 1 件も呼ばれない（受入条件の核）', () => {
  const r = run(['--issue', '13', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    deleteExit: 1,
    deleteBody: '404 Not Found',
  })
  assert.equal(r.status, 3)
  const c = calls(r.logPath)
  assert.ok(c.some((l) => l.includes('--method DELETE')), 'DELETE は呼ばれていること')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST は 1 件も呼ばれていないこと')
})

test('ケース7: DELETE 後の POST が非ゼロ（一般エラー）→ 補償復旧ルーチンへ入り、実測で既に旧親配下（補償 POST 不要）→ exit 10 restored（Issue #352。旧 exit 4 の契約から変更）', () => {
  // fixture で parentAfter を省略すると parentBefore（旧親）を継続するスタブの既定挙動により、
  // 復旧のための再取得 GET は「実測で既に旧親配下」を返す。この場合は補償 POST を撃たずに
  // 復旧成立として終端する（3.1 節の「親 == OLD_PARENT」分岐）
  const r = run(['--issue', '14', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    postExit: 1,
    postBody: '500 Internal Server Error',
  })
  assert.equal(r.status, 10)
  assert.match(r.stdout.trim(), /^result=restored issue=14 new_parent=7 old_parent=5$/)
  const c = calls(r.logPath)
  assert.equal(c.filter((l) => l.includes('--method POST')).length, 1, '補償 POST は撃たれていないこと（1 回目の POST のみ）')
})

test('ケース8: 事後確認 GET で対象が新親配下に見えない → exit 5', () => {
  const r = run(['--issue', '15', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '5', // POST は成功したことにするがスタブ上は親が変わっていない体
  })
  assert.equal(r.status, 5)
})

test('ケース9: 事前 GET 自体が失敗（前提不備）→ exit 2', () => {
  const r = run(['--issue', '16', '--new-parent', '7'], {
    getFail: true,
  })
  assert.equal(r.status, 2)
})

test('ケース10: DELETE 後の POST が "only have one parent" → 補償復旧ルーチンで実測すると第三者が別の親を設定済み → exit 11 で fail-closed 停止（補償 POST を撃たない。Issue #352。旧 exit 8 の契約から変更）', () => {
  // DELETE は成功しているため旧親からは外れている。エラーメッセージの文字列だけでは
  // 「第三者に取られた」のか「一時的な障害」なのか判別できないため、実測（再取得 GET）で
  // 確定させる。実測で第三者が別の親（#9）を設定済みなら、承認外の親子関係を壊さないため
  // 補償 POST を撃たずに書き込みなしで停止する（PR #314 Bugbot Medium の懸念を「無変更と
  // 誤認させない」から一歩進め、実測ベースで安全側に倒す）
  const r = run(['--issue', '17', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '9',
    postExit: 1,
    postBody: 'Validation Failed: Sub issue may only have one parent',
  })
  assert.equal(r.status, 11)
  assert.match(r.stderr, /reason=third-party-parent/)
  assert.match(r.stderr, /issues\/9/)
  const c = calls(r.logPath)
  assert.ok(c.some((l) => l.includes('--method DELETE')), 'DELETE は実行済みであること')
  assert.equal(c.filter((l) => l.includes('--method POST')).length, 1, '補償 POST が呼ばれていないこと（1 回目の POST のみ）')
})

test('ケース28: DELETE 後の POST 失敗 → 実測で孤児 → 補償 POST 成功 → exit 10 restored（Issue #352 の補償復旧成功。受入基準の核）', () => {
  const r = run(['--issue', '30', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '', // 復旧のための再取得 GET は孤児を返す
    parentAfter2: '5', // 補償 POST 後の事後確認 GET は旧親配下を返す
    postExit: 1,
    postBody: '500 Internal Server Error',
  })
  assert.equal(r.status, 10)
  assert.match(r.stdout.trim(), /^result=restored issue=30 new_parent=7 old_parent=5$/)
  const posts = calls(r.logPath).filter((l) => l.includes('--method POST'))
  assert.equal(posts.length, 2, '1 回目（新親）と 2 回目（補償・旧親）の POST が呼ばれていること')
  assert.match(posts[1], /issues\/5\/sub_issues/, '2 回目の POST の宛先パスが旧親 #5 であること')
})

test('ケース29: DELETE 後の POST 失敗 → 実測で孤児 → 補償 POST も失敗（多重障害）→ exit 8 reason=compensation-post-failed（Issue #352。孤児のまま終端）', () => {
  const r = run(['--issue', '31', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '',
    postExit: 1,
    postBody: '500 Internal Server Error',
    compPostExit: 1,
    compPostBody: '503 Service Unavailable',
  })
  assert.equal(r.status, 8)
  assert.match(r.stderr, /reason=compensation-post-failed/)
  const posts = calls(r.logPath).filter((l) => l.includes('--method POST'))
  assert.equal(posts.length, 2, '補償 POST も試みられていること')
})

test('ケース30: DELETE 後の POST 失敗 → 復旧のための実状態再取得 GET も失敗（状態不明）→ exit 8 reason=recovery-state-unknown、補償 POST は撃たれない（Issue #352）', () => {
  const r = run(['--issue', '32', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    postExit: 1,
    postBody: '500 Internal Server Error',
    verifyGetFail: true, // 対象 issue の 2 回目 GET（=復旧のための再取得）を失敗させる
  })
  assert.equal(r.status, 8)
  assert.match(r.stderr, /reason=recovery-state-unknown/)
  const c = calls(r.logPath)
  assert.equal(c.filter((l) => l.includes('--method POST')).length, 1, '補償 POST は撃たれていないこと（1 回目の POST のみ）')
})

test('ケース31: DELETE 後の POST 失敗（偽陰性）→ 実測すると既に新親配下 → exit 0 reassigned（Issue #352。通常の成功終端と同じ扱い）', () => {
  const r = run(['--issue', '33', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '7', // 復旧のための再取得 GET は既に新親配下を返す（POST は実は成立していた）
    postExit: 1,
    postBody: '500 Internal Server Error',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=reassigned issue=33 new_parent=7 old_parent=5$/)
  const c = calls(r.logPath)
  assert.equal(c.filter((l) => l.includes('--method POST')).length, 1, '補償 POST は撃たれていないこと（1 回目の POST のみ）')
})

test('ケース32: 孤児経路（DELETE なし）の POST が非ゼロ（一般エラー）→ exit 4、復旧ルーチンは発動しない（Issue #352。無変更のため補償対象外。経路の非対称固定）', () => {
  // DELETE を 1 度も撃っていない孤児経路は、DELETE 成功後の POST 失敗と異なり孤児化リスク
  // 自体が無い（対象は元から孤児）。補償復旧ルーチンは DELETE 経路の POST 失敗ブロックにのみ
  // 存在し、孤児経路のブロックからは呼ばれないため、追加の GET/POST は一切発生しない
  const r = run(['--issue', '29', '--new-parent', '7'], {
    parentBefore: '',
    postExit: 1,
    postBody: '500 Internal Server Error',
  })
  assert.equal(r.status, 4)
  const c = calls(r.logPath)
  assert.equal(c.filter((l) => l.startsWith('api') && !l.includes('--method')).length, 2, '対象 issue の事前 GET + 新親の事前検証 GET の 2 件のみであること（復旧のための追加 GET が無いこと）')
  assert.equal(c.filter((l) => l.includes('--method POST')).length, 1, '補償 POST は撃たれていないこと（1 回目の POST のみ）')
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
})

test('ケース15: 孤児経路の POST が "only have one parent" → exit 7（DELETE 未実行で無変更）', () => {
  // 事前実測では孤児だったが POST 時点で別の親が付いていたレース。DELETE を 1 度も
  // 撃っていないためツリーは無変更であり、exit 8（部分変更）とは復旧手順が異なる
  const r = run(['--issue', '21', '--new-parent', '7'], {
    parentBefore: '',
    postExit: 1,
    postBody: 'Validation Failed: Sub issue may only have one parent',
  })
  assert.equal(r.status, 7)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
})

test('ケース16: 親が別リポジトリ → exit 2、DELETE も POST も呼ばれない', () => {
  // sub-issue はリポジトリを跨いで紐付けられる。番号だけを見ると本リポ宛の DELETE を
  // 撃って失敗する（PR #314 codex P1）
  const r = run(['--issue', '22', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentRepo: 'other/repo',
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が呼ばれていないこと')
})

test('ケース16c: 親が別リポジトリ → stderr に reason=cross-repository-parent マーカーが出る（Issue #335 codex-review 指摘の再発防止固定）', () => {
  // exit 2 は gh/jq 不在・未認証・issue 取得失敗（解消可能な前提不備）とも共有するため、
  // このケース（恒久的に対象外）だけを終了コード単独では区別できない。呼び出し側が
  // SKILL.md の記述どおり (a)/(b) を機械的に判定できるよう、安定したマーカー行を固定する
  const r = run(['--issue', '22', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentRepo: 'other/repo',
  })
  assert.equal(r.status, 2)
  assert.ok(
    /^reason=cross-repository-parent$/m.test(r.stderr),
    'stderr に reason=cross-repository-parent マーカー行があること',
  )
})

test('ケース9/ケース11: 解消可能な前提不備（exit 2 (a)）では reason=cross-repository-parent マーカーが出ない', () => {
  // (b) 専用マーカーが (a) 側へ誤って漏れると、呼び出し側が恒久的な対象外と誤判定し
  // 棚卸し対象から不要に除外してしまう
  const r = run(['--issue', '22', '--new-parent', '7'], { getFail: true })
  assert.equal(r.status, 2)
  assert.ok(
    !/reason=cross-repository-parent/.test(r.stderr),
    '解消可能な前提不備で cross-repository 専用マーカーが出ていないこと',
  )
})

test('ケース16b: 親が別リポジトリで停止する際、stderr が --repo の付け替えを勧めていない（Issue #332 / PR #314 P0 の再発防止固定）', () => {
  // c4c27b9 で「--repo を親リポジトリへ変えて再実行する」という危険な案内を削除した。
  // 将来の善意の編集でこの案内が復活しないよう、stderr に --repo が出現しないことを固定する
  const r = run(['--issue', '22', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentRepo: 'other/repo',
  })
  assert.equal(r.status, 2)
  assert.ok(!/--repo/.test(r.stderr), 'stderr が --repo の付け替えを勧めていないこと')
})

test('ケース17: 別リポの親の番号が --new-parent と一致しても already-attached と誤判定しない', () => {
  // 別リポの #7 配下にあるだけで、本リポの #7 には付いていない
  const r = run(['--issue', '23', '--new-parent', '7'], {
    parentBefore: '7',
    parentRepo: 'other/repo',
  })
  assert.equal(r.status, 2)
  assert.ok(!r.stdout.includes('already-attached'), 'already-attached を返していないこと')
})

test('ケース18: 事後確認で親が別リポジトリ → exit 5（成功として報告しない）', () => {
  // POST 後の競合で対象が other/repo の同番号 issue へ移された状況。番号だけを見ると
  // VERIFY_PARENT == NEW_PARENT となり誤ったツリー状態を成功報告する（PR #314 codex P1）
  const r = run(['--issue', '24', '--new-parent', '7'], {
    parentBefore: '',
    parentAfter: '7',
    parentRepoAfter: 'other/repo',
  })
  assert.equal(r.status, 5)
  assert.ok(!r.stdout.includes('result=posted-only'), '成功の result= 行を出していないこと')
})

test('ケース11: gh auth status が非ゼロ → exit 2、API 呼び出し無し', () => {
  const r = run(['--issue', '1', '--new-parent', '2'], {
    authFail: true,
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.startsWith('api')), 'auth 失敗後は api 系呼び出しが無いこと')
})

test('ケース12: --old-parent が実測値と食い違う → exit 6 で fail-closed、DELETE も POST も呼ばれない', () => {
  // 実際の現在の親は #9（parentBefore）。呼び出し側は Step 2 で #5 からの付け替えを承認している。
  // #9 は承認されていない親であり、そこから外すと承認外の親子関係を壊すため停止する（PR #314 codex P1）
  const r = run(['--issue', '18', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '9',
    parentAfter: '7',
  })
  assert.equal(r.status, 6)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
  // 実測した親を呼び出し側へ提示できること（承認の取り直しに必要）
  assert.match(r.stderr, /#9/)
})

test('ケース13: 孤児として承認されたが実測では親が居る → exit 6 で fail-closed', () => {
  // --old-parent 省略 = 「この issue は孤児である」ことを承認した意味。実測で #9 配下に
  // あるなら、その親子関係は承認されていない
  const r = run(['--issue', '19', '--new-parent', '7'], {
    parentBefore: '9',
    parentAfter: '7',
  })
  assert.equal(r.status, 6)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
  assert.match(r.stderr, /#9/)
})

test('ケース14: --old-parent 指定だが実測は孤児 → 破壊が起きないため続行し posted-only', () => {
  // 承認された操作（#5 から外して #7 へ付ける）の部分集合。DELETE 対象が存在しないだけで
  // 承認外の親子関係は壊れないため、警告のうえ POST のみ実行する
  const r = run(['--issue', '20', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '',
    parentAfter: '7',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=posted-only issue=20 new_parent=7 old_parent=-$/)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が呼ばれていないこと')
  assert.ok(c.some((l) => l.includes('--method POST')), 'POST が呼ばれていること')
})

// --- Issue #333: DELETE 前の --new-parent 事前検証 ---

test('ケース19: --new-parent が --issue と同一（自己参照）→ exit 1、API 呼び出しゼロ', () => {
  const r = run(['--issue', '30', '--new-parent', '30'], {})
  assert.equal(r.status, 1)
  assert.deepEqual(calls(r.logPath), [])
})

test('ケース20: 新親 GET が失敗（存在しない番号）→ exit 2、DELETE も POST も呼ばれない（AC4 の核）', () => {
  const r = run(['--issue', '31', '--old-parent', '5', '--new-parent', '999'], {
    parentBefore: '5',
    newParentGetFail: true,
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
})

test('ケース21: 新親が別リポジトリ → exit 2、DELETE も POST も呼ばれない', () => {
  const r = run(['--issue', '32', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    newParentRepo: 'other/repo',
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
})

test('ケース22: 孤児経路（--old-parent 省略）で新親 GET が失敗 → exit 2、POST も呼ばれない（経路の非対称が無いこと）', () => {
  const r = run(['--issue', '33', '--new-parent', '999'], {
    parentBefore: '',
    newParentGetFail: true,
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
})

test('ケース25: 新親が Pull Request → exit 2、DELETE も POST も呼ばれない', () => {
  // issues API は PR も返す（issue と PR は番号空間を共有する）。存在確認・同一リポジトリ確認
  // だけでは PR を弾けず、DELETE 成功後に POST が失敗して孤児化する。判別は取得済み JSON の
  // `.pull_request` で行うため追加の API 呼び出しは発生しない。
  const r = run(['--issue', '35', '--old-parent', '5', '--new-parent', '77'], {
    parentBefore: '5',
    newParentIsPullRequest: true,
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Pull Request/)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
})

test('ケース26: 孤児経路でも新親が Pull Request → exit 2、POST も呼ばれない（経路の非対称が無いこと）', () => {
  const r = run(['--issue', '36', '--new-parent', '77'], {
    parentBefore: '',
    newParentIsPullRequest: true,
  })
  assert.equal(r.status, 2)
  const c = calls(r.logPath)
  assert.ok(!c.some((l) => l.includes('--method DELETE')), 'DELETE が 1 件も呼ばれていないこと')
  assert.ok(!c.some((l) => l.includes('--method POST')), 'POST が 1 件も呼ばれていないこと')
})

test('ケース27: 新親が通常の issue（.pull_request 無し）なら従来どおり付け替えが成立する（過検知していないこと）', () => {
  const r = run(['--issue', '37', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    parentAfter: '7',
  })
  assert.equal(r.status, 0)
  const c = calls(r.logPath)
  assert.ok(c.some((l) => l.includes('--method DELETE')), 'DELETE が呼ばれていること')
  assert.ok(c.some((l) => l.includes('--method POST')), 'POST が呼ばれていること')
})

test('ケース23: already-attached 経路では新親 GET を追加で撃たない（AC3 の追加コスト回避）', () => {
  const r = run(['--issue', '34', '--old-parent', '5', '--new-parent', '5'], {
    parentBefore: '5',
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout.trim(), /^result=already-attached issue=34 new_parent=5 old_parent=5$/)
  const c = calls(r.logPath).filter((l) => l.startsWith('api'))
  assert.equal(c.length, 1, 'api 呼び出しが GET 1 件のみであること')
})

test('ケース24: 承認不一致（exit 6）経路でも新親 GET を撃たない', () => {
  const r = run(['--issue', '35', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '9',
  })
  assert.equal(r.status, 6)
  const c = calls(r.logPath).filter((l) => l.startsWith('api'))
  assert.equal(c.length, 1, 'api 呼び出しが GET 1 件のみであること')
})

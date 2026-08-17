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

test('ケース5: 正常な付け替え → exit 0 reassigned、呼び出し順が GET→DELETE→POST→GET', () => {
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
  assert.deepEqual(kinds, ['GET', 'DELETE', 'POST', 'GET'])
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

test('ケース7: POST が非ゼロ（一般エラー） → exit 4', () => {
  const r = run(['--issue', '14', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    postExit: 1,
    postBody: '500 Internal Server Error',
  })
  assert.equal(r.status, 4)
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

test('ケース10: DELETE 後の POST が "only have one parent" → exit 8（部分変更を無変更と誤認させない）', () => {
  // DELETE は成功しているため旧親からは外れている。無変更を意味する exit 6 / 7 と
  // 同じコードにすると、呼び出し側が「触っていない」と誤認して復旧を誤る（PR #314 Bugbot Medium）
  const r = run(['--issue', '17', '--old-parent', '5', '--new-parent', '7'], {
    parentBefore: '5',
    postExit: 1,
    postBody: 'Validation Failed: Sub issue may only have one parent',
  })
  assert.equal(r.status, 8)
  const c = calls(r.logPath)
  assert.ok(c.some((l) => l.includes('--method DELETE')), 'DELETE は実行済みであること')
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

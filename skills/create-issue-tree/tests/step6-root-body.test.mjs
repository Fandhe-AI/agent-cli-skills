// step6-root-body.test.mjs — Issue #544 の回帰テスト。
//
// SKILL.md Step 6 の新規作成用ブロックは、`#<phase1_number>` や `N` を含む固定本文を
// そのまま `gh issue edit --body` へ渡していた。例をそのまま実行するとルート issue の
// 本文が雛形で上書きされ、実際の Phase 構成が失われる（後続の update-issue-tree /
// implement-issue-tree が読むトラッキング本文を破壊する）。
// 修正は (1) 実ツリー（sub_issues API）から表を生成、(2) プレースホルダー残りの
// 検査ガード（fail-closed）の 2 点。
//
// SKILL.md はドキュメントのため、フェンス内の bash をテキスト抽出し、PATH 先頭に
// gh スタブを差し込んで実プロセスとして実行し、gh 呼び出しと本文を観測する
// （node:test 標準ライブラリのみ）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')

// Step 6 見出し以降の bash フェンスのうち、新規作成用（gh issue edit --body-file を含み、
// --root 用の CURRENT_BODY を含まないもの）だけを抽出する。件数が 1 から変わったら落とし、
// フェンスの追加・削除の当て漏れに気づけるようにする。
function extractStep6Block() {
  const text = readFileSync(SKILL_MD, 'utf8')
  const start = text.indexOf('### Step 6')
  const end = text.indexOf('### Step 7')
  assert.ok(start >= 0 && end > start, 'Step 6 / Step 7 見出しが見つからない')
  const section = text.slice(start, end)
  const blocks = []
  const re = /```bash\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(section)) !== null) {
    if (m[1].includes('gh issue edit') && m[1].includes('--body-file') && !m[1].includes('CURRENT_BODY')) {
      blocks.push(m[1])
    }
  }
  assert.equal(blocks.length, 1, `新規作成用フェンスは 1 つであること（実際: ${blocks.length}）`)
  return blocks[0]
}

// gh スタブ。api .../issues/<n>/sub_issues?...page=<p> には fixture/sub_<n>_<p>.json を返し、
// 無ければ exit 1（API 失敗）。issue edit は引数と --body-file の中身を記録する。
const GH_STUB = `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  path="$2"
  n=$(printf '%s' "$path" | sed -E 's#.*issues/([0-9]+)/sub_issues.*#\\1#')
  p=$(printf '%s' "$path" | sed -E 's#.*page=([0-9]+).*#\\1#')
  f="$FIXTURE_DIR/sub_\${n}_\${p}.json"
  if [ -f "$f" ]; then cat "$f"; exit 0; fi
  echo "stub: no fixture for $path" >&2
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  echo "EDIT $*" >> "$GH_CALL_LOG"
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then cat "$2" > "$GH_BODY_OUT"; fi
    shift
  done
  exit 0
fi
echo "stub: unexpected $*" >&2
exit 1
`

function setup(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'step6-'))
  const bin = join(dir, 'bin')
  const fx = join(dir, 'fx')
  const tmp = join(dir, 'tmp')
  for (const d of [bin, fx, tmp]) mkdirSync(d)
  writeFileSync(join(bin, 'gh'), GH_STUB)
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, data] of Object.entries(fixtures)) {
    writeFileSync(join(fx, name), JSON.stringify(data))
  }
  return { dir, bin, fx, tmp }
}

function run(ctx) {
  const callLog = join(ctx.dir, 'calls.log')
  const bodyOut = join(ctx.dir, 'body.md')
  const r = spawnSync('bash', ['-c', extractStep6Block()], {
    cwd: ctx.dir,
    encoding: 'utf8',
    env: {
      PATH: `${ctx.bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      TMPDIR: ctx.tmp,
      FIXTURE_DIR: ctx.fx,
      GH_CALL_LOG: callLog,
      GH_BODY_OUT: bodyOut,
      ROOT_NUMBER: '100',
      GRANULARITY: '2h',
    },
  })
  const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []
  const body = existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : null
  return { r, calls, body, leftovers: readdirSync(ctx.tmp) }
}

const issue = (number, title, state = 'open') => ({ number, title, state })

const BASE = () => ({
  'sub_100_1.json': [issue(101, 'feat: 基盤整備'), issue(102, 'feat: 機能追加')],
  'sub_101_1.json': [issue(111, 'feat: DB 設計'), issue(112, 'feat: API 雛形')],
  'sub_102_1.json': [issue(121, 'feat: 画面')],
  'sub_111_1.json': [issue(1111, 'feat: テーブル定義')],
  'sub_112_1.json': [],
  'sub_121_1.json': [],
})

test('(a) 実ツリーから表を生成し、プレースホルダーなしで 1 回だけ edit する', () => {
  const ctx = setup(BASE())
  try {
    const { r, calls, body } = run(ctx)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    assert.match(calls[0], /issue edit 100 --body-file/)
    assert.ok(body.startsWith('<!-- granularity: 2h -->\n'))
    assert.match(body, /\| Phase 1 \| #101 feat: 基盤整備 \| 2 \| 3 \|/)
    assert.match(body, /\| Phase 2 \| #102 feat: 機能追加 \| 1 \| 1 \|/)
    assert.match(body, /\| #111 \| feat: DB 設計 \| sub-issue あり \|/)
    assert.match(body, /\| #112 \| feat: API 雛形 \| - \|/)
    assert.ok(!/<phase|#N\b|\(作成後に更新\)/.test(body), 'プレースホルダー残り')
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(b) タイトルの | と改行で表の列数が崩れない', () => {
  const fx = BASE()
  fx['sub_101_1.json'] = [issue(111, 'feat: a | b\nc'), issue(112, 'x')]
  const ctx = setup(fx)
  try {
    const { r, body } = run(ctx)
    assert.equal(r.status, 0, r.stderr)
    const row = body.split('\n').find((l) => l.startsWith('| #111 '))
    assert.ok(row, '#111 行がある')
    assert.equal(row, '| #111 | feat: a \\| b c | sub-issue あり |')
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(c) Phase 親が 0 件なら edit せず非ゼロ終了する', () => {
  const ctx = setup({ 'sub_100_1.json': [] })
  try {
    const { r, calls } = run(ctx)
    assert.notEqual(r.status, 0)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(d) sub_issues 取得失敗なら edit せず非ゼロ終了する', () => {
  const fx = BASE()
  delete fx['sub_102_1.json']
  const ctx = setup(fx)
  try {
    const { r, calls } = run(ctx)
    assert.notEqual(r.status, 0)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(e) 100 件ちょうどの 1 ページ目に続く 2 ページ目も取得する', () => {
  const fx = BASE()
  const page1 = Array.from({ length: 100 }, (_, i) => issue(2000 + i, `feat: c${i}`))
  fx['sub_102_1.json'] = page1
  fx['sub_102_2.json'] = [issue(3000, 'feat: 最終')]
  for (const i of page1) fx[`sub_${i.number}_1.json`] = []
  fx['sub_3000_1.json'] = []
  const ctx = setup(fx)
  try {
    const { r, calls, body } = run(ctx)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    assert.match(body, /\| Phase 2 \| #102 feat: 機能追加 \| 101 \| 101 \|/)
    assert.match(body, /\| #3000 \| feat: 最終 \| - \|/)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(g) タイトルが #N 等のプレースホルダーに見える場合も edit せず中止する', () => {
  const fx = BASE()
  fx['sub_101_1.json'] = [issue(111, '#N'), issue(112, 'x')]
  const ctx = setup(fx)
  try {
    const { r, calls } = run(ctx)
    assert.notEqual(r.status, 0)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(h) 本文を含む大きな sub_issues 応答（引数長上限超え）でも edit まで到達する', () => {
  const fx = BASE()
  const bigBody = 'x'.repeat(4000)
  const page1 = Array.from({ length: 100 }, (_, i) => ({ ...issue(2000 + i, `feat: c${i}`), body: bigBody }))
  fx['sub_102_1.json'] = page1
  fx['sub_102_2.json'] = [{ ...issue(3000, 'feat: 最終'), body: bigBody }]
  for (const i of page1) fx[`sub_${i.number}_1.json`] = []
  fx['sub_3000_1.json'] = []
  const ctx = setup(fx)
  try {
    const { r, calls, body } = run(ctx)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    assert.match(body, /\| #3000 \| feat: 最終 \| - \|/)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('(f) 一時ファイルは成功時も失敗時も残らない', () => {
  const ok = setup(BASE())
  const fx = BASE()
  delete fx['sub_102_1.json']
  const ng = setup(fx)
  try {
    assert.deepEqual(run(ok).leftovers, [])
    assert.deepEqual(run(ng).leftovers, [])
  } finally {
    rmSync(ok.dir, { recursive: true, force: true })
    rmSync(ng.dir, { recursive: true, force: true })
  }
})

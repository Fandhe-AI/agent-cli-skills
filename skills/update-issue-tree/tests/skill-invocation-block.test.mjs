// skill-invocation-block.test.mjs — Issue #335 の回帰テスト。
//
// SKILL.md の Step 3 / Step 4 は `bash "${REASSIGN_SCRIPT}" ...` の直後を
// `echo "exit=$?"` で締めていた。echo がブロック最後のコマンドになるため、
// コードブロック全体（呼び出し元がコピペ実行する単位）の終了ステータスが
// 常に 0 になり、非ゼロ終了（DELETE 済み・POST 失敗 = exit 8 等）を実行基盤が
// 「最終ステータス」で判定した場合に見落とす。SKILL.md 本文（129-130 行・
// 314 行）はこの非ゼロ終了を「1 件も握り潰さない」契約を明記しており、
// 修正後のブロックがこの契約を実際に満たすかを、行番号に依存しない形
// （フェンス抽出）で検証する。
//
// SKILL.md はドキュメントであり import 可能なモジュールではないため、
// フェンス内のシェルスクリプトをテキストとして抽出し、実プロセスとして
// bash 実行して終了ステータスを観測する（node:test 標準ライブラリのみ、
// 外部依存なし）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')

// reassign-sub-issue.sh を呼ぶ ```bash フェンスのみを抽出する。件数が 2 から
// 変化したら（新ブロック追加・削除）このテストが落ち、伝播修正の当て漏れに
// 気づける設計にする。
function extractReassignBlocks() {
  const text = readFileSync(SKILL_MD, 'utf8')
  const fenceRe = /```bash\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    if (m[1].includes('bash "${REASSIGN_SCRIPT}"')) {
      blocks.push(m[1])
    }
  }
  return blocks
}

// Step 3 の 3 レイアウト解決ループの第一候補と一致させる（スタブがここに
// あれば Step 3・Step 4 双方が同じスタブへ着地する。Step 4 は自前で
// REASSIGN_SCRIPT を解決しない仕様のため、この一致が両ブロックの前提）。
const STUB_RELATIVE = join('skills', 'update-issue-tree', 'scripts', 'reassign-sub-issue.sh')

function makeStub(tmp, exitCode) {
  const path = join(tmp, STUB_RELATIVE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`)
  // 意図的に実行ビットを付けない: vendoring で実行ビットが落ちるケース
  // （Step 3 の [[ ! -x ]] 警告分岐）を素通りさせず、bash 経由の起動が
  // その状態でも機能することを実測する。
}

function prelude({ presetScript = true } = {}) {
  const lines = [
    'ISSUE_NUMBER=123',
    'OLD_PARENT=1',
    'NEW_PARENT=2',
    'ORPHAN_NUMBER=456',
    'PHASE_NUMBER=3',
  ]
  if (presetScript) {
    // Step 4 は REASSIGN_SCRIPT を自前で解決しない（Step 3 の値を引き継ぐ
    // 仕様）ため、ここで両ブロック共通の初期値として与える。Step 3 は
    // 自身の 3 レイアウト解決ループでこの値を上書きするが、同じ相対パスへ
    // 解決されるため実害はない。未検出パスのテストでは presetScript: false
    // にして、Step 3 自身の候補探索に判定を委ねる（プリセットしたままだと
    // 「未検出→exit 1」ではなく「見つからないパスへの bash 実行失敗」という
    // 別の失敗モードに化けてしまうため）。
    lines.push(`REASSIGN_SCRIPT='${STUB_RELATIVE}'`)
  }
  return lines.join('\n')
}

function runBlock(block, cwd, preludeOpts) {
  const file = join(cwd, 'block.sh')
  writeFileSync(file, `${prelude(preludeOpts)}\n${block}`)
  let status = 0
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync('bash', [file], { cwd, encoding: 'utf8' })
  } catch (err) {
    // execFileSync は非ゼロ終了で throw する。この throw 自体が「ブロックの
    // 終了ステータスが非ゼロで返る」ことの直接証拠であり、本テストの主張の核。
    status = err.status ?? 1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  return { status, stdout, stderr }
}

test('SKILL.md から reassign-sub-issue.sh 呼び出しブロックがちょうど2件抽出できる', () => {
  const blocks = extractReassignBlocks()
  assert.equal(blocks.length, 2, 'Step 3 / Step 4 以外のブロックが増減していないか確認')
})

const blocks = extractReassignBlocks()
const labels = ['Step3(closed 親下の付け替え)', 'Step4(孤児の再配置)']

blocks.forEach((block, i) => {
  const label = labels[i] ?? `block${i}`

  test(`${label}: スタブが exit 8 → ブロックの終了ステータスも 8 で返る（修正前は 0 になる回帰）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 8)
      const r = runBlock(block, tmp)
      assert.equal(r.status, 8)
      assert.match(r.stdout, /exit=8/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test(`${label}: スタブが exit 0 → ブロックの終了ステータスも 0、stdout に exit=0`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 0)
      const r = runBlock(block, tmp)
      assert.equal(r.status, 0)
      assert.match(r.stdout, /exit=0/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

test('Step3: 3 レイアウトいずれにもスクリプトが無い cwd では exit 1（既存の未検出パスの退行防止）', () => {
  const step3 = blocks[0]
  const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
  try {
    // スタブを一切配置しない（未検出パス）。REASSIGN_SCRIPT も事前設定しない
    // ことで、Step 3 自身の 3 レイアウト解決ループに判定を委ねる。
    const r = runBlock(step3, tmp, { presetScript: false })
    assert.equal(r.status, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

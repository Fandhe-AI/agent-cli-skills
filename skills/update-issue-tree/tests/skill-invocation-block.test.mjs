// skill-invocation-block.test.mjs — Issue #335 / #372 の回帰テスト。
//
// #335: SKILL.md の Step 3 / Step 4 は `bash "${REASSIGN_SCRIPT}" ...` の直後を
//   `echo "exit=$?"` で締めていた。echo がブロック最後のコマンドになるため、
//   コードブロック全体（呼び出し元がコピペ実行する単位）の終了ステータスが
//   常に 0 になり、非ゼロ終了（DELETE 済み・POST 失敗 = exit 8 等）を実行基盤が
//   「最終ステータス」で判定した場合に見落とす。
//
// #372: その修正後も、ブロックは非ゼロ終了で無条件に `exit` する一方、
//   本文とコメントは「exit 2 のうち stderr に `reason=cross-repository-parent` が
//   あるものは対象外として次の 1 件へ進む」という契約を定めていた。
//   **ブロックが stderr を捕捉していないため、掲載どおり実行しても契約を実現できない。**
//   cross-repository 親を 1 件検出しただけで棚卸し全体が停止する。
//   修正は (1) stderr のファイル捕捉と再出力、(2) マーカー判定、(3) 対象外を表す
//   返り値 9、(4) 呼び出し側ループの掲載、の 4 点。
//
// SKILL.md はドキュメントであり import 可能なモジュールではないため、
// フェンス内のシェルスクリプトをテキストとして抽出し、実プロセスとして
// bash 実行して終了ステータスと入出力を観測する（node:test 標準ライブラリのみ）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')

// 付け替えを実行する ```bash フェンスのみを抽出する。件数が 2 から変化したら
// （新ブロック追加・削除）このテストが落ち、伝播修正の当て漏れに気づける設計にする。
// 判定キーは `reassign_one`（Step 3 が定義し Step 4 が再利用する関数名）。
// スクリプト直叩き（`bash "${REASSIGN_SCRIPT}"`）を判定キーにすると、関数化により
// Step 4 側が該当しなくなり抽出漏れを起こすため使わない。
function extractReassignBlocks() {
  const text = readFileSync(SKILL_MD, 'utf8')
  const fenceRe = /```bash\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    if (m[1].includes('reassign_one')) {
      blocks.push(m[1])
    }
  }
  return blocks
}

// Step 3 の 3 レイアウト解決ループの第一候補と一致させる。
const STUB_RELATIVE = join('skills', 'update-issue-tree', 'scripts', 'reassign-sub-issue.sh')

// exitCode と stderr 本文を指定できるスタブ。#372 の判定は stderr の内容に依存するため、
// 終了コードだけでなく stderr も制御できる必要がある。
function makeStub(tmp, exitCode, stderrText = '') {
  const path = join(tmp, STUB_RELATIVE)
  mkdirSync(dirname(path), { recursive: true })
  const emit = stderrText ? `printf '%s\\n' ${JSON.stringify(stderrText)} >&2\n` : ''
  writeFileSync(path, `#!/usr/bin/env bash\n${emit}exit ${exitCode}\n`)
  // 意図的に実行ビットを付けない: vendoring で実行ビットが落ちるケースを
  // 素通りさせず、bash 経由の起動がその状態でも機能することを実測する。
}

function prelude({ presetScript = true, plan = ['123 1 2'], orphans = ['456 3'], declarePlans = true } = {}) {
  const lines = []
  if (declarePlans) {
    lines.push(`REASSIGN_PLAN=(${plan.map((e) => JSON.stringify(e)).join(' ')})`)
    lines.push(`ORPHAN_PLAN=(${orphans.map((e) => JSON.stringify(e)).join(' ')})`)
  }
  if (presetScript) {
    lines.push(`REASSIGN_SCRIPT='${STUB_RELATIVE}'`)
  }
  return lines.join('\n')
}

// Step 4 は Step 3 が定義した reassign_one を再利用する仕様のため、単体で実行するには
// 関数定義を前置する必要がある。SKILL.md 側の構造（Step 3 で定義・Step 4 で再利用）を
// テストが暗黙に壊さないよう、定義部だけを Step 3 のブロックから切り出して前置する。
function functionDefinition(step3Block) {
  const start = step3Block.indexOf('reassign_one() {')
  if (start < 0) throw new Error('Step 3 ブロックに reassign_one の定義が見つからない')
  const end = step3Block.indexOf('\n}\n', start)
  if (end < 0) throw new Error('reassign_one 定義の終端が見つからない')
  return step3Block.slice(start, end + 3)
}

// execFileSync ではなく spawnSync を使う。execFileSync は成功時に stdout しか返さず、
// stderr は親プロセスへ素通りするため、`r.stderr` が常に空になる。#372 の判定は
// 「成功終了（status 0）しつつ stderr へ対象外を報告する」経路を検証するため、
// 成功時にも stderr を捕捉できる必要がある。
function runBlock(block, cwd, preludeOpts, extraPrefix = '') {
  const file = join(cwd, 'block.sh')
  writeFileSync(file, `${prelude(preludeOpts)}\n${extraPrefix}\n${block}`)
  // env を最小化して実行環境の偶発的な変数を拾わないようにする（Issue #335 レビュー指摘）。
  const r = spawnSync('bash', [file], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  })
  if (r.error) throw r.error
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const MARKER = 'reason=cross-repository-parent'

test('SKILL.md から付け替え実行ブロックがちょうど2件抽出できる', () => {
  const blocks = extractReassignBlocks()
  assert.equal(blocks.length, 2, 'Step 3 / Step 4 以外のブロックが増減していないか確認')
})

const blocks = extractReassignBlocks()
const step3 = blocks[0]
const step4 = blocks[1]
const defs = functionDefinition(step3)
const cases = [
  { label: 'Step3(closed 親下の付け替え)', block: step3, prefix: '' },
  { label: 'Step4(孤児の再配置)', block: step4, prefix: defs },
]

for (const { label, block, prefix } of cases) {
  test(`${label}: スタブが exit 8 → ブロックの終了ステータスも 8 で返る（#335 の回帰）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 8)
      const r = runBlock(block, tmp, undefined, prefix)
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
      const r = runBlock(block, tmp, undefined, prefix)
      assert.equal(r.status, 0)
      assert.match(r.stdout, /exit=0/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // --- #372: マーカーによる (a)/(b) の判定 ---

  test(`${label}: exit 2 + cross-repository マーカー → 中断せず 0 で完走する（#372）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 2, `エラー: 現在の親が別リポジトリにある ${MARKER}`)
      const r = runBlock(block, tmp, undefined, prefix)
      assert.equal(r.status, 0, 'cross-repository 親 1 件で棚卸し全体が停止してはならない')
      assert.match(r.stderr, /対象外（cross-repository 親）/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test(`${label}: exit 2 でマーカー無し → 解消可能な前提不備として 2 で中断する（#372）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 2, 'エラー: gh の認証が無い')
      const r = runBlock(block, tmp, undefined, prefix)
      assert.equal(r.status, 2, 'マーカーが無い exit 2 は中断しなければならない')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test(`${label}: 捕捉した stderr は握り潰さず再出力する（#372）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      const detail = 'エラー: 診断に必要な詳細メッセージ'
      makeStub(tmp, 3, detail)
      const r = runBlock(block, tmp, undefined, prefix)
      assert.equal(r.status, 3)
      assert.match(r.stderr, new RegExp(detail))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

// 複数件のループが実際に「対象外は飛ばして次へ進む」ことを、呼び出し回数で実測する。
// 単一件のテストでは「1 件目で止まった」と「1 件目を飛ばして完走した」を区別できない。
test('Step3: cross-repository 親を飛ばして残りの件も処理する（呼び出し回数で実測。#372）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
  try {
    const path = join(tmp, STUB_RELATIVE)
    mkdirSync(dirname(path), { recursive: true })
    const counter = join(tmp, 'calls.txt')
    // --issue の値で挙動を変える: 111 は cross-repository（exit 2 + マーカー）、
    // それ以外は成功。呼び出しごとに 1 行追記して回数を数える。
    writeFileSync(
      path,
      `#!/usr/bin/env bash\n`
        + `issue=""\n`
        + `while [[ $# -gt 0 ]]; do\n`
        + `  case "$1" in --issue) issue="$2"; shift 2 ;; *) shift ;; esac\n`
        + `done\n`
        + `printf '%s\\n' "\${issue}" >> ${JSON.stringify(counter)}\n`
        + `if [[ "\${issue}" == "111" ]]; then\n`
        + `  printf '%s\\n' "エラー: ${MARKER}" >&2\n`
        + `  exit 2\n`
        + `fi\n`
        + `exit 0\n`,
    )
    const r = runBlock(step3, tmp, { plan: ['111 1 2', '222 1 2', '333 1 2'] })
    assert.equal(r.status, 0)
    const calls = readFileSync(counter, 'utf8').trim().split('\n')
    assert.deepEqual(calls, ['111', '222', '333'], '対象外の 1 件目で停止せず 3 件すべて呼ばれること')
    assert.match(r.stderr, /対象外（cross-repository 親）: 111/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('Step3: 3 レイアウトいずれにもスクリプトが無い cwd では exit 1（既存の未検出パスの退行防止）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
  try {
    const r = runBlock(step3, tmp, { presetScript: false })
    assert.equal(r.status, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// `if reassign_one ...; then ... fi` は fi 直後の $? が 0 になるため使ってはならない
// （実測: bash では条件が偽で else が無い場合 $? = 0）。この形に戻ると失敗が
// すべて「成功」として読まれ、(a)/(b) の判定も中断も素通りする。
test('両ブロックとも if/fi で返り値を判定していない（$? が 0 に化ける形の検出。#372）', () => {
  for (const { label, block } of cases) {
    // コメント行を除去してから判定する。この形を禁じる注意書き自体がコメントとして
    // ブロック内に存在するため、生テキストへの照合だと自分の警告文に誤ヒットする。
    const code = block
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    assert.doesNotMatch(
      code,
      /if\s+reassign_one[\s\S]*?;\s*then/,
      `${label}: if reassign_one ...; then の形は fi 直後の $? が 0 になるため使えない`,
    )
    assert.match(code, /\|\|\s*status=\$\?/, `${label}: || status=$? による明示的な退避が必要`)
  }
})

// ---------------------------------------------------------------------------
// 計画配列の未宣言ガード（PR #374 codex P1）
// ---------------------------------------------------------------------------
// bash では未定義配列の "${REASSIGN_PLAN[@]}" が空へ展開されるため、Step 2 を実行し
// 忘れてもループが 0 回で回り、承認済みの対象があってもエラーなく完走して完了報告まで
// 進んでしまう。「対象なし（空配列を宣言済み）」と「計画未設定（未宣言）」は意味が
// 異なるため、後者は fail-closed で停止しなければならない。
for (const { label, block, prefix } of cases) {
  test(`${label}: 計画配列が未宣言なら exit 1 で停止する（0 件完走との区別。PR #374 P1）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      makeStub(tmp, 0)
      const r = runBlock(block, tmp, { declarePlans: false }, prefix)
      assert.equal(r.status, 1, '未宣言のまま 0 件完走してはならない')
      assert.match(r.stderr, /未宣言/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test(`${label}: 空配列を宣言済みなら正常に 0 件で完走する（対象なしは正常系）`, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'update-issue-tree-block-'))
    try {
      const path = join(tmp, STUB_RELATIVE)
      mkdirSync(dirname(path), { recursive: true })
      const counter = join(tmp, 'calls.txt')
      writeFileSync(path, `#!/usr/bin/env bash\nprintf 'called\\n' >> ${JSON.stringify(counter)}\nexit 0\n`)
      const r = runBlock(block, tmp, { plan: [], orphans: [] }, prefix)
      assert.equal(r.status, 0)
      // スクリプトが 1 度も呼ばれていないこと（= ループが 0 回で正常終了）
      assert.equal(existsSync(counter), false, '対象 0 件でスクリプトが呼ばれてはならない')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}

// Step 2 が計画配列の構築手順を掲載していること（ガードだけ足して構築手順が無いと、
// 実行者は「どう作ればよいか」が分からず結局 fail-closed で止まり続ける）。
test('Step 2 に REASSIGN_PLAN / ORPHAN_PLAN の構築手順が掲載されている（PR #374 P1）', () => {
  const text = readFileSync(SKILL_MD, 'utf8')
  const step2 = text.slice(text.indexOf('### Step 2:'), text.indexOf('### Step 3:'))
  assert.match(step2, /REASSIGN_PLAN=\(/, 'Step 2 に REASSIGN_PLAN の宣言例が必要')
  assert.match(step2, /ORPHAN_PLAN=\(/, 'Step 2 に ORPHAN_PLAN の宣言例が必要')
  assert.match(step2, /空配列として宣言/, '対象 0 件でも宣言する契約の明示が必要')
})

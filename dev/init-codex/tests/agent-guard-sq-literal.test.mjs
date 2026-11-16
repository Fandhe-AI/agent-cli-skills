// agent-guard.sh の `$'` の字句解析（SQ_LITERAL_AWK）のテスト。
// 1 段目の字句解析は raw の `$'` がすべて「単一引用符の末尾の `$` と閉じ引用符」で、すべての単純コマンドの先頭語が
// 評価器にならないコマンドの許可リストに入っているときだけ obfuscated の検査を外す。
// 引用符の状態を読み違えると本物の ANSI-C 引用符を見落とすので、正解を実シェルに置いて確かめる:
//   - 標準手順の実物（create-commit の Step 2 (a) のブロック）は SKILL.md から取り出して allow になること
//   - 固定語彙から組み立てた入力を /bin/bash -c と /bin/zsh -c で実行し、目印 `e$'c'ho IIT_SQ_MARK` が
//     ANSI-C 引用符として解かれた（`echo IIT_SQ_MARK` か単独の `IIT_SQ_MARK` が出た）入力は、ガードが必ず deny を返すこと。
//     逆に allow になった入力では、どちらのシェルでも目印が解かれていないこと
//   - 目印を評価器（パイプの先の bash / sh・bash -c・sh -c・eval）が連結して組み直す形も同じ語彙に入れる
// 実行するのは echo（目印が解かれると echo になる）・printf・代入・ヒアドキュメントと、目印の文字列だけを評価する
// bash / sh / eval で、入力は下の固定語彙の組み合わせに限る。
// 各入力は空の一時ディレクトリを cwd・HOME にして実行する。/bin/zsh が無い環境では実シェルの差分テストを skip する。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const GUARD = join(root, 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function run(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000)
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    p.stdin.on('error', () => {})
    p.stdin.end(input ?? '')
  })
}

async function verdict(bash, command, subagent) {
  const out = await run(bash, [GUARD], { input: JSON.stringify({ command, subagent }) })
  return (out.split('\n').filter((l) => l !== '').pop() ?? '').replace('AGENT_GUARD_RESULT ', '')
}

// 並列 n で流す（実時間の待機はしない）
async function pool(items, fn, n = 12) {
  const res = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++
      res[i] = await fn(items[i])
    }
  }))
  return res
}

// create-commit の Step 2 (a) の bash ブロック（`#### (a)` の後の最初の ```bash から ``` まで）
function createCommitStep2a() {
  const md = readFileSync(join(root, 'skills', 'create-commit', 'SKILL.md'), 'utf8')
  const m = md.match(/^#### \(a\)[^\n]*\n[\s\S]*?^```bash\n([\s\S]*?)^```$/m)
  return m && m[1].replace(/\n$/, '')
}

describe('標準手順の実物（create-commit Step 2 (a)）', () => {
  const block = createCommitStep2a()
  it('SKILL.md からブロックを取り出せる（単一引用符の末尾の `$` を含む）', () => {
    assert.ok(block, 'Step 2 (a) の bash ブロックが見つからない')
    assert.ok(block.includes("$'"), "`$'` を含まない（テストの前提が崩れた）")
  })
  for (const bash of BASHES) {
    for (const subagent of [true, null]) {
      it(`allow (${bash}, subagent=${subagent})`, async () => assert.equal(await verdict(bash, block, subagent), 'allow'))
    }
  }
})

// --- 実シェルを正解にした差分テスト ------------------------------------------------------------
const MARK = "e$'c'ho IIT_SQ_MARK"
// 目印を単一引用符の中に置いた形。引用符の外で読むと `e$cho IIT_SQ_MARK` を出すだけだが、前の断片が開いた単一引用符の
// 中で読むと、最初の ' が引用符を閉じて `$'c'` が ANSI-C 引用符になる（状態の反転を見落とす変異を捕まえる）
const MARK_SQ = "echo 'e$'c'ho IIT_SQ_MARK'"
const MARKS = [MARK, MARK_SQ]
// 目印を `$` で終わる単一引用符の文字列と後ろの語に分け、評価器に連結させて組み直す形（PR #847 の codex P0 の形）。
// 評価器が評価するのは目印の文字列（`e$'c'ho IIT_SQ_MARK`）だけ
const EVAL_MARKS = [
  `printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | bash`,
  `printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | sh`,
  `echo 'e$'"'c'ho IIT_SQ_MARK" | bash`,
  `bash -c 'e$'"'c'ho IIT_SQ_MARK"`,
  `sh -c 'e$'"'c'ho IIT_SQ_MARK"`,
  `eval 'e$'"'c'ho IIT_SQ_MARK"`,
  `echo "$(printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | bash)"`,
]
// 目印が ANSI-C 引用符として解かれたか（解かれないと `e$cho` / `e$'c'ho` のままで、この 2 つの形は出ない）
const decoded = (out) => /echo IIT_SQ_MARK|^IIT_SQ_MARK$/m.test(out)

// 固定語彙: 引用符の状態を狂わせうる断片（コメント・二重引用符の中の '・\'・ヒアドキュメント・$(...)・バッククォート・
// 単一引用符の末尾の $・閉じていない引用符・< > の直後の #・case）
const FRAG = [
  "# it's",
  "echo a# it's",
  "echo a#'",
  // 直前の文字がエスケープされている・置換や括弧の直後の #（語の途中なのでコメントではない）
  "echo a\\ #'",
  "echo a\\;#'",
  "echo a\\\n#'",
  "echo $(echo a)#'",
  "echo <(echo a)#'",
  "echo a(#'",
  "echo 'x' # it's",
  "echo \"it's\"",
  "echo it\\'s",
  "echo it's",
  "echo \"it's",
  "echo 'a$'",
  "echo 'a$' 'b$'",
  "RE='(x)$'",
  "echo \"$(echo 'a$')\"",
  "echo $(echo \"it's\")",
  "echo $(echo 'a$' # it's\n)",
  "echo `echo 'a$'`",
  "echo `echo it\\'s`",
  "echo <<EOF\nit's\nEOF",
  "echo <<'EOF'\nit's $'\nEOF",
  "echo \"x$'y\"",
  "echo >#it's",
  "case x in x) echo 'a$' ;; esac",
]
const JOIN = ['\n', ' ; ', ' && ']

function corpus() {
  const out = new Set()
  for (const m of MARKS) {
    for (const f of FRAG) {
      for (const j of JOIN) {
        out.add(f + j + m)
        out.add(m + j + f)
      }
      for (const g of FRAG) out.add(f + '\n' + m + '\n' + g)
    }
  }
  for (const m of EVAL_MARKS) {
    out.add(m)
    for (const f of FRAG) {
      for (const j of JOIN) {
        out.add(f + j + m)
        out.add(m + j + f)
      }
    }
  }
  return [...out]
}

const ZSH = '/bin/zsh'
describe('実シェルとの差分（/bin/bash -c・/bin/zsh -c）', { skip: existsSync(ZSH) ? false : '/bin/zsh が無い' }, () => {
  const inputs = corpus()
  const tmp = mkdtempSync(join(tmpdir(), 'iit-sq-mark-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))
  let rows

  it(`固定語彙から ${inputs.length} 件を生成し、両シェルとガードに流す`, async () => {
    rows = await pool(inputs, async (c) => {
      const dir = mkdtempSync(join(tmp, 'c-'))
      const env = { PATH: '/usr/bin:/bin', HOME: dir, ZDOTDIR: dir, LC_ALL: 'C' }
      const [b, z, v] = await Promise.all([
        run('/bin/bash', ['-c', c], { cwd: dir, env }),
        run(ZSH, ['-c', c], { cwd: dir, env }),
        verdict('/bin/bash', c, true),
      ])
      // echo 以外のものを実行していない（ファイルが作られていない）
      const left = readdirSync(dir)
      return { c, hit: decoded(b) || decoded(z), v, left }
    })
    assert.ok(inputs.length >= 50, `生成件数が少ない: ${inputs.length}`)
  })

  it('目印が解かれた入力はすべて deny（不一致 0 件）', () => {
    const miss = rows.filter((r) => r.hit && !r.v.startsWith('deny')).map((r) => `${r.v}: ${JSON.stringify(r.c)}`)
    assert.deepEqual(miss, [])
  })

  it('allow になった入力では、どちらのシェルでも目印が解かれていない（不一致 0 件）', () => {
    const miss = rows.filter((r) => r.v === 'allow' && r.hit).map((r) => JSON.stringify(r.c))
    assert.deepEqual(miss, [])
  })

  it('判定に内部エラー・入力エラーが無い・実行でファイルが作られていない', () => {
    // obfuscated 以外の deny（ヒアドキュメントの区切り子が見つからない nesting-limit 等）は deny として数える
    assert.deepEqual(rows.filter((r) => !/^(allow|deny [a-z-]+)$/.test(r.v) || /internal-error|bad-input|no-jq/.test(r.v)).map((r) => `${r.v}: ${JSON.stringify(r.c)}`), [])
    assert.deepEqual(rows.filter((r) => r.left.length > 0).map((r) => `${r.left.join(',')}: ${JSON.stringify(r.c)}`), [])
  })

  it('両方の向きを実際に通っている（目印が解かれる入力と、目印の文字列を含んだまま allow になる入力がある）', () => {
    assert.ok(rows.some((r) => r.hit), '目印が解かれる入力が無い')
    assert.ok(rows.some((r) => r.v === 'allow' && MARKS.some((m) => r.c.includes(m))), '目印の文字列を含んで allow になる入力が無い')
    // 評価器の形でも目印が解かれている（評価器の形の判定を実際に確かめている）
    assert.ok(rows.some((r) => r.hit && EVAL_MARKS.some((m) => r.c.includes(m))), '評価器の形で目印が解かれる入力が無い')
  })
})

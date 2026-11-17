// agent-guard.sh の `$'` の例外（認識器 SQ_DOLLAR_AWK）を Issue #849 で広げた変更のテスト。
// 広げたのは許可リストの段を ; && || 改行でつなぐ形だけ（echo の段を含む連結と、引数の "$NAME" は文法の外のまま）。
// PR #847 は例外を広げるたびに抜け道が見つかって収束しなかったので、次の 4 つで確かめる:
//   1. 抜け道 1〜6 と敵役の試行（tests/lib/agent-guard-cases.mjs の FP849_STAY_DENY）が subagent=true / null で deny のまま
//   2. 認識器を単体で取り出し、通す形（FP849_FLIP）だけを受理し、それ以外（FP849_STAY_DENY・FP849_TIGHTEN）を受理しない
//   3. 全コーパスを #849 の前（36ecad6）の判定を凍結した fixture（fixtures/agent-guard-baseline-849.json）と比べ、変わったのが
//      FP849_FLIP（deny → allow）と FP849_TIGHTEN（allow → deny）だけで、subagent=false は 1 件も変わらない
//   4. 実シェル（/bin/bash 3.2・PATH の bash・/bin/zsh）との差分:
//      (a) PR #847 の語彙（目印 `e$'c'ho IIT_SQ_MARK` を ANSI-C 引用符として解かせる形）で、目印が解かれた入力は必ず deny
//      (b) 固定語彙から組み立てた入力のうちガードが allow にしたものを、許可リストの語を引数の記録だけする偽コマンドに
//          置き換えて実行し、各シェルが渡した引数が「単一引用符の中は文字どおり（末尾の `$` も文字の `$`）」の読みと一致する
// fixture はコーパス（agent-guard-cases.mjs の全表）の全件を 36ecad6 の agent-guard.sh で /bin/bash に流した結果。
// コーパスへ形を足したときは、36ecad6 の agent-guard.sh を取り出して同じ流し方で足した形を加える（1 行 1 件・字下げ 4）。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as cases from './lib/agent-guard-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const GUARD = join(root, 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')
const BASELINE = JSON.parse(readFileSync(join(here, 'fixtures', 'agent-guard-baseline-849.json'), 'utf8')).verdicts
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]
const ZSH = '/bin/zsh'
const SHELLS = [...BASHES, ...(existsSync(ZSH) ? [ZSH] : [])]
const SUBAGENTS = [false, true, null]

const corpus = [...new Set(Object.values(cases).filter(Array.isArray).flatMap((arr) => arr.map((e) => (Array.isArray(e) ? e[0] : e))))]
const FLIP = new Set(cases.FP849_FLIP)
const TIGHTEN = new Set(cases.FP849_TIGHTEN)

// input が無いときの標準入力は /dev/null にする。node の 'pipe' は macOS ではソケットで、/bin/bash（3.2）は標準入力が
// ソケットだと遠隔シェルとみなして BASH_ENV を読まないことがある（偽コマンドへの置き換えが効かず、組み込みの echo が走る）
function run(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000)
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', () => { clearTimeout(timer); resolve(out) })
    if (p.stdin) {
      p.stdin.on('error', () => {})
      p.stdin.end(input)
    }
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

// --- 1. 抜け道と敵役（ガード全体） -----------------------------------------------------------------------
describe('Issue #849 の表（ガード全体・subagent=true / null）', () => {
  for (const bash of BASHES) {
    it(`抜け道 1〜6 と敵役の試行は deny・通す形は allow・締めた形は deny（${bash}）`, async () => {
      const jobs = [
        ...cases.FP849_STAY_DENY.map(([c, r]) => [c, `deny ${r}`]),
        ...cases.FP849_FLIP.map((c) => [c, 'allow']),
        ...cases.FP849_TIGHTEN.map((c) => [c, 'deny obfuscated']),
      ].flatMap(([c, want]) => [true, null].map((s) => [c, s, want]))
      const got = await pool(jobs, ([c, s]) => verdict(bash, c, s))
      const miss = jobs.filter((j, i) => got[i] !== j[2]).map(([c, s, want], i) => `${JSON.stringify(c)} subagent=${s}: ${want} が欲しいが ${got[i]}`)
      assert.deepEqual(miss, [])
    })
  }
  it('敵役の試行は 10 件より多い（抜け道 1〜6 の外の試行を含む）', () => {
    assert.ok(cases.FP849_STAY_DENY.length > 60, `件数: ${cases.FP849_STAY_DENY.length}`)
  })
})

// --- 2. 認識器の単体 ------------------------------------------------------------------------------------
describe('認識器 SQ_DOLLAR_AWK（単体・#849 の表）', () => {
  const src = readFileSync(GUARD, 'utf8')
  const m = src.match(/^read -r -d '' SQ_DOLLAR_AWK <<'AWK' \|\| true\n([\s\S]*?)\nAWK\n/m)
  // ガードと同じ渡し方（printf '%s\n' "$cmd"。cmd は jq -r の置換で末尾の改行が落ちている）
  const ok = (command) => {
    const r = spawnSync('awk', [m[1]], { input: `${command.replace(/\n+$/, '')}\n`, env: { ...process.env, LC_ALL: 'C' } })
    assert.equal(r.status, 0, JSON.stringify(command))
    return r.stdout.toString() === 'ok\n'
  }
  it('ガードから認識器の awk を取り出せる', () => assert.ok(m, 'SQ_DOLLAR_AWK が見つからない'))
  it('通す形（FP849_FLIP）は受理する', () => {
    assert.deepEqual(cases.FP849_FLIP.filter((c) => !ok(c)), [])
  })
  it('`$\'` を含む FP849_STAY_DENY と FP849_TIGHTEN は受理しない（前段の解析器に頼らない）', () => {
    const leaked = [...cases.FP849_STAY_DENY.map(([c]) => c), ...cases.FP849_TIGHTEN].filter((c) => c.includes("$'") && ok(c))
    assert.deepEqual(leaked, [])
  })
})

// --- 3. 旧版（36ecad6）→ 新版の差分 -----------------------------------------------------------------------
describe('旧版（36ecad6）→ 新版の差分', { concurrency: BASHES.length }, () => {
  it('fixture はコーパスの全件を覆う', () => {
    assert.deepEqual(corpus.filter((c) => BASELINE[c] === undefined).map((c) => JSON.stringify(c)), [])
  })
  it('FP849_FLIP は旧版で deny obfuscated、FP849_TIGHTEN は旧版で allow（subagent=true / null）', () => {
    for (const c of FLIP) assert.deepEqual(BASELINE[c].slice(1), ['deny obfuscated', 'deny obfuscated'], JSON.stringify(c))
    for (const c of TIGHTEN) assert.deepEqual(BASELINE[c].slice(1), ['allow', 'allow'], JSON.stringify(c))
  })
  for (const bash of BASHES) {
    // /bin/bash（3.2）は全コーパス。もう一方の bash は `$'` とマージ系に関わる表だけ（両 bash の結果が同じことは
    // agent-guard.test.mjs の表が全件で見ている）
    const SUBSET = new Set([cases.FP849_FLIP, cases.FP849_TIGHTEN, cases.FP849_STAY_DENY, cases.FP805_FLIP, cases.FP805_STAY_DENY,
      cases.MG_OBFUSCATED_DENY, cases.MG_ALLOW, cases.PARSE_ALLOW_MAIN].flatMap((arr) => arr.map((e) => (Array.isArray(e) ? e[0] : e))))
    const targets = bash === BASHES[0] ? corpus : corpus.filter((c) => SUBSET.has(c))
    it(`${bash}: 変わったのは FP849_FLIP の deny → allow と FP849_TIGHTEN の allow → deny だけで、subagent=false は 1 件も変わらない`, async () => {
      const jobs = targets.flatMap((c) => SUBAGENTS.map((s, k) => [c, s, k]))
      const got = await pool(jobs, ([c, s]) => verdict(bash, c, s))
      const diffs = []
      const flipped = new Set()
      const tightened = new Set()
      jobs.forEach(([c, s, k], i) => {
        const was = BASELINE[c][k]
        if (was === got[i]) return
        if (s !== false && FLIP.has(c) && was === 'deny obfuscated' && got[i] === 'allow') { flipped.add(c); return }
        if (s !== false && TIGHTEN.has(c) && was === 'allow' && got[i] === 'deny obfuscated') { tightened.add(c); return }
        diffs.push(`${JSON.stringify(c)} subagent=${s}: ${was} -> ${got[i]}`)
      })
      assert.deepEqual(diffs, [])
      assert.deepEqual([...FLIP].filter((c) => !flipped.has(c)), [], '通るはずが止まったまま')
      assert.deepEqual([...TIGHTEN].filter((c) => !tightened.has(c)), [], '止まるはずが通ったまま')
      assert.ok(jobs.filter(([, s]) => s === false).length >= targets.length)
    })
  }
})

// --- 4 (a). 実シェルとの差分: 目印が ANSI-C 引用符として解かれた入力は deny ---------------------------------
const MARK = "e$'c'ho IIT_SQ_MARK"
// 目印を単一引用符の中に置いた形。引用符の外で読むと文字列を出すだけだが、前の断片が開いた単一引用符の中で読むと、
// 最初の ' が引用符を閉じて `$'c'` が ANSI-C 引用符になる（状態の反転を見落とす変異を捕まえる）
const MARK_SQ = "echo 'e$'c'ho IIT_SQ_MARK'"
// 目印を `$` で終わる単一引用符の文字列と後ろの語に分け、評価器に連結させて組み直す形（PR #847 の codex P0 の形）
const EVAL_MARKS = [
  `printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | bash`,
  `printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | sh`,
  `echo 'e$'"'c'ho IIT_SQ_MARK" | bash`,
  `echo 'e$' "'c'ho IIT_SQ_MARK" | tr -d ' ' | bash`,
  `echo 'e$' | tr -d '\\n' ; echo "'c'ho IIT_SQ_MARK" | bash`,
  `bash -c 'e$'"'c'ho IIT_SQ_MARK"`,
  `sh -c 'e$'"'c'ho IIT_SQ_MARK"`,
  `eval 'e$'"'c'ho IIT_SQ_MARK"`,
  `echo "$(printf '%s%s' 'e$' "'c'ho IIT_SQ_MARK" | bash)"`,
]
const decoded = (out) => /echo IIT_SQ_MARK|^IIT_SQ_MARK$/m.test(out)
// 引用符の状態を狂わせうる断片（PR #847 の語彙）と、#849 で通すようにした形
const FRAG = [
  "# it's",
  "echo a# it's",
  "echo a#'",
  "echo a\\ #'",
  "echo a\\;#'",
  "echo a\\\n#'",
  "echo $(echo a)#'",
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
  "echo `echo 'a$'`",
  "echo <<EOF\nit's\nEOF",
  "echo <<'EOF'\nit's $'\nEOF",
  "echo \"x$'y\"",
  "case x in x) echo 'a$' ;; esac",
  "echo \"$X\" | grep 'a$'",
  "grep -c 'a$' /dev/null || echo 'b$'",
  "echo 'a$' \"${X}\" && echo 'c$'",
  "echo 'a$' | wc -l",
]
const JOIN = ['\n', ' ; ', ' && ', ' || ', ' | ']

function markCorpus() {
  const out = new Set()
  for (const m of [MARK, MARK_SQ, ...EVAL_MARKS]) {
    out.add(m)
    for (const f of FRAG) {
      for (const j of JOIN) {
        out.add(f + j + m)
        out.add(m + j + f)
      }
    }
  }
  for (const f of FRAG) for (const g of FRAG) out.add(f + '\n' + MARK_SQ + '\n' + g)
  return [...out]
}

describe('実シェルとの差分 (a): 目印が解かれた入力は deny', () => {
  const inputs = markCorpus()
  const tmp = mkdtempSync(join(tmpdir(), 'iit-sq849-mark-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))
  let rows

  it(`固定語彙から ${inputs.length} 件を生成し、${SHELLS.join('・')} とガードに流す`, async () => {
    rows = await pool(inputs, async (c) => {
      const dir = mkdtempSync(join(tmp, 'c-'))
      const env = { PATH: '/usr/bin:/bin', HOME: dir, ZDOTDIR: dir, LC_ALL: 'C', X: 'x' }
      const outs = await Promise.all(SHELLS.map((sh) => run(sh, ['-c', c], { cwd: dir, env })))
      const v = await verdict(BASHES[0], c, true)
      return { c, hit: outs.some(decoded), v, left: readdirSync(dir) }
    })
    assert.ok(inputs.length >= 500, `生成件数が少ない: ${inputs.length}`)
  })
  it('目印が解かれた入力はすべて deny（不一致 0 件）', () => {
    assert.deepEqual(rows.filter((r) => r.hit && !r.v.startsWith('deny')).map((r) => `${r.v}: ${JSON.stringify(r.c)}`), [])
  })
  it('判定に内部エラー・入力エラーが無い・実行でファイルが作られていない', () => {
    assert.deepEqual(rows.filter((r) => !/^(allow|deny [a-z-]+)$/.test(r.v) || /internal-error|bad-input|no-jq/.test(r.v)).map((r) => `${r.v}: ${JSON.stringify(r.c)}`), [])
    assert.deepEqual(rows.filter((r) => r.left.length > 0).map((r) => `${r.left.join(',')}: ${JSON.stringify(r.c)}`), [])
  })
  // 入力はすべて目印か評価器の形を含むので allow は出ない（allow の側は (b) が見る）
  it('空振りしていない（目印が解かれる入力・評価器の形で解かれる入力がある）', (t) => {
    t.diagnostic(`目印が解かれた入力 ${rows.filter((r) => r.hit).length} 件・deny ${rows.filter((r) => r.v.startsWith('deny')).length} 件`)
    assert.ok(rows.filter((r) => r.hit).length >= 100, '目印が解かれる入力が少ない')
    assert.ok(rows.some((r) => r.hit && EVAL_MARKS.some((m) => r.c.includes(m))), '評価器の形で目印が解かれる入力が無い')
  })
})

// --- 4 (b). 実シェルとの差分: allow の入力で、各シェルが渡す引数が文字どおりの読みと一致する -----------------
// 許可リストの語（echo を含む）を、引数を記録して 0 で終わる偽コマンドに置き換える。bash は BASH_ENV で組み込みの echo を
// 外し（enable -n）、zsh は ZDOTDIR の .zshenv で外す（disable）。PATH は偽コマンドの置き場だけ。
// 二重引用符の "$X" 等は文法の外だが、語彙に入れて deny になること（比べる対象に入らないこと）も兼ねる。
const ALLOWED = ['grep', 'egrep', 'fgrep', 'rg', 'wc', 'head', 'tail', 'cut', 'tr', 'uniq', 'ls', 'cat', 'echo', 'jq', 'basename', 'dirname', 'diff', 'cmp', 'comm', 'nl', 'column', 'fold']
const ENV_VARS = { X: "x$'\\x6d' y", Y: '$Z' }

// 文字どおりの読み（参照実装）。ガードが allow にした入力だけに使う。単一引用符の中は文字どおり、二重引用符の中は
// "$NAME" / "${NAME}" だけを環境の値へ置き換える。; && || 改行・| で区切り、リダイレクトは引数から除く。
// 偽コマンドはすべて 0 で終わるので、|| の後ろのパイプラインは実行されない。
function literalReading(cmd) {
  const recs = []
  let op = ';'
  let stages = []
  let words = []
  let cur = null
  const endWord = () => { if (cur !== null) { words.push(cur); cur = null } }
  const endStage = () => { endWord(); if (words.length) stages.push(words); words = [] }
  const endPipe = (next) => {
    endStage()
    if (stages.length) {
      if (op !== '||') for (const w of stages) recs.push(w.join('\x1f'))
      op = next
    }
    stages = []
  }
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]
    if (cur === null && /^[0-9]?(>>|>|<)/.test(cmd.slice(i)) || c === '>' || c === '<') {
      endWord()
      const r = cmd.slice(i).match(/^[0-9]?(>>|>|<)(&[0-9]|[ \t]*[^ \t\n;&|<>]+)/)
      i += r[0].length
      continue
    }
    if (c === "'") { const j = cmd.indexOf("'", i + 1); cur = (cur ?? '') + cmd.slice(i + 1, j); i = j + 1; continue }
    if (c === '"') {
      const j = cmd.indexOf('"', i + 1)
      const inner = cmd.slice(i + 1, j)
      const v = inner.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/)
      cur = (cur ?? '') + (v ? (ENV_VARS[v[1] ?? v[2]] ?? '') : inner)
      i = j + 1
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue }
    if (c === '\n' || c === ';') { endPipe(';'); i++; continue }
    if (cmd.startsWith('&&', i)) { endPipe('&&'); i += 2; continue }
    if (cmd.startsWith('||', i)) { endPipe('||'); i += 2; continue }
    if (c === '|') { endStage(); i++; continue }
    cur = (cur ?? '') + c
    i++
  }
  endPipe(';')
  return recs.sort()
}

function setupShimRoot(tmp) {
  const bin = join(tmp, 'bin')
  mkdirSync(bin)
  for (const name of ALLOWED) {
    const f = join(bin, name)
    // パイプラインの段は並行に走るので、1 件を変数に組み立ててから 1 回の書き込みで追記する（書き込みが混ざらない）
    writeFileSync(f, `#!/bin/sh\nus=$(printf '\\037')\nr='${name}'\nfor a in "$@"; do r="$r$us$a"; done\nprintf '%s\\036\\n' "$r" >> "$SHIM_LOG"\nexit 0\n`)
    chmodSync(f, 0o755)
  }
  writeFileSync(join(tmp, 'bash_env'), 'enable -n echo\n')
  return bin
}

async function shellArgv(sh, c, tmp, bin) {
  const dir = mkdtempSync(join(tmp, 'c-'))
  writeFileSync(join(dir, 'f'), 'x\n')
  writeFileSync(join(dir, '.zshenv'), 'disable echo\n')
  const log = join(dir, 'log')
  writeFileSync(log, '')
  const env = { PATH: bin, HOME: dir, ZDOTDIR: dir, BASH_ENV: join(tmp, 'bash_env'), SHIM_LOG: log, LC_ALL: 'C', ...ENV_VARS }
  await run(sh, ['-c', c], { cwd: dir, env })
  return readFileSync(log, 'latin1').split('\x1e\n').filter((r) => r !== '').map((r) => Buffer.from(r, 'latin1').toString('utf8')).sort()
}

// 固定語彙と固定の種から組み立てる（乱数は使わない。同じ入力が毎回できる）
function argvCorpus() {
  const CMDS = ['grep', 'echo', 'wc', 'cat', 'rg', 'head', 'cut']
  const ARGS = [`'a$'`, `'$'`, `'e$'`, `"'c'ho"`, `'x'"y"`, `-n`, `"$X"`, `"\${X}"`, `"$Y"`, `'a$'b`, `'a$''b'`, `"a$'"`, `$'a'`,
    `'it'"'"'s$'`, `'a b$'`, `'日本$'`, `'$'"x"`, `"$X"y`, `'\\x6d$'`, `--`, `f`, `'a$\\'`, `"$1"`, `'%s$'`, `'$$'`, `'$ $'`, `"x"'$'`, `'$'x`]
  const SEPS = [' | ', '|', ' ; ', ';', ' && ', '&&', ' || ', '||', '\n', '\n\n  ', ' & ', ' |& ', '\n&& ', ' |\n']
  const REDIR = ['', ' 2>&1', ' >o', ' <f', ' 2>/dev/null', '>o', ' >=x', ' 10>o', ' 3<f']
  const out = new Set()
  for (const c of CMDS) for (const a of ARGS) out.add(`${c} ${a}`)
  for (const a of ARGS) for (const b of ARGS) out.add(`echo ${a} ${b}`)
  let k = 0
  for (const a of ARGS) {
    for (const s of SEPS) {
      const c1 = CMDS[k % CMDS.length]
      const c2 = CMDS[(k * 3 + 1) % CMDS.length]
      const b = ARGS[(k * 7 + 3) % ARGS.length]
      const r = REDIR[k % REDIR.length]
      out.add(`${c1} ${a}${r}${s}${c2} ${b}`)
      out.add(`${c1} -c ${a} f${s}${c2} ${b}${s}echo ${a}`)
      k++
    }
  }
  return [...out]
}

describe('実シェルとの差分 (b): allow の入力で各シェルが渡す引数は文字どおりの読みと一致する', () => {
  const inputs = argvCorpus()
  const tmp = mkdtempSync(join(tmpdir(), 'iit-sq849-argv-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))
  const bin = setupShimRoot(tmp)
  let allowed

  it('対照: ガードを通さない本物の ANSI-C 引用符は、文字どおりの読みとの不一致として検出できる', async () => {
    for (const c of [`echo $'\\x61'`, `echo 'a'$'b'`, `grep 'a$' f; echo $'\\x6d'`]) {
      for (const sh of SHELLS) assert.notDeepEqual(await shellArgv(sh, c, tmp, bin), literalReading(c), `${sh}: ${JSON.stringify(c)}`)
    }
    // 偽コマンドに置き換わっている（組み込みの echo が外れ、引数が記録される）
    for (const sh of SHELLS) assert.deepEqual(await shellArgv(sh, `echo 'a$' "$X"`, tmp, bin), [`echo\x1fa$\x1f${ENV_VARS.X}`], sh)
  })

  it(`固定語彙から ${inputs.length} 件を生成し、allow の入力を ${SHELLS.join('・')} で実行して引数を比べる（不一致 0 件）`, async () => {
    const v = await pool(inputs, (c) => verdict(BASHES[0], c, true))
    // `$'` を含まない入力は認識器を通らない（obfuscated の判定の外）ので比べない
    allowed = inputs.filter((c, i) => v[i] === 'allow' && c.includes("$'"))
    const miss = []
    await pool(allowed, async (c) => {
      const want = literalReading(c)
      for (const sh of SHELLS) {
        const got = await shellArgv(sh, c, tmp, bin)
        if (JSON.stringify(got) !== JSON.stringify(want)) miss.push(`${sh}: ${JSON.stringify(c)} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`)
      }
    })
    assert.deepEqual(miss, [])
  })

  it('空振りしていない（allow の入力が十分あり、単一引用符の末尾の `$`・連結・パイプ・fd の複製を含む）', (t) => {
    t.diagnostic(`比べた allow の入力 ${allowed.length} 件`)
    assert.ok(allowed.length >= 100, `単一引用符の末尾の \`$\` を含む allow の件数: ${allowed.length}`)
    for (const re of [/; /, /&&/, /\|\|/, /\n/, / \| /, / 2>&1/]) assert.ok(allowed.some((c) => re.test(c) && c.includes("$'")), `allow に無い: ${re}`)
  })
})

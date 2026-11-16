// agent-guard.sh の誤検出 2 件（Issue #805）を狭めた変更の差分テスト。
//   1. 行末が `$'` になる単一引用符（`grep -c '^hi$' f`）を ANSI-C 引用符と誤認して obfuscated で止める。
//   2. 本文に merge を含む `gh pr create` / `gh pr comment` を merge-guard で止める。
// どちらの検出も防御そのものなので、狭め方を誤ると迂回路になる。完了条件は「いま止まるもののうち、通るように
// なるのは指定した誤検出の形だけ」。そこで tests/lib/agent-guard-cases.mjs の全コーパス（既存の deny / allow の表・
// 迂回の試行・誤検出の形）を、旧版の判定を凍結した fixture と新版の判定で突き合わせ、deny から allow へ変わった
// ものが FP805_FLIP と過不足なく一致すること（subagent=false では 1 件も変わらないこと）を確かめる。
// その後に `$'` の字句解析（SQ_LITERAL_AWK）で通すようにした形（SQ_LITERAL_FLIP）も、同じ旧版からの差分として数える
// （旧版から通るようになった形 = FP805_FLIP と SQ_LITERAL_FLIP の和）。
//
// 旧版の fixture（tests/fixtures/agent-guard-baseline-805.json）は Issue #805 の前（7b7dbb4）の agent-guard.sh を、
// コーパスの全コマンド × subagent {false, true, null} で流した結果。ref の存在に依らないよう凍結してある。
// コーパスへ形を足したときは、旧版を取り出して同じ流し方で fixture を作り直す（既存のキーの値は変えず、足した形だけを
// 末尾へ加える。`JSON.stringify(v, null, 2)` に改行を足して書く。.editorconfig の字下げは 2 の倍数）。fixture に無いコマンドは差分の対象外
// （通常の deny / allow の表が見る）。
// 判定は /bin/bash（3.2）と PATH の bash（5 系）の両方で同じになることを確かめる。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import * as cases from './lib/agent-guard-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const GUARD = join(here, '..', '..', '..', 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')
const BASELINE = JSON.parse(readFileSync(join(here, 'fixtures', 'agent-guard-baseline-805.json'), 'utf8')).verdicts

const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]
const SUBAGENTS = [false, true, null]

// 認証情報・マージキュー投入・git config のフック差し替えの表は #805 の凍結後に足した判定で、旧版との差分テストの対象ではない。
const POST_805 = new Set(['CRED_DENY', 'CRED_ALLOW', 'ENQUEUE_DENY', 'HOOKCONF_DENY', 'HOOKCONF_ALLOW'])
const corpus = [...new Set(Object.entries(cases).filter(([k, v]) => Array.isArray(v) && !POST_805.has(k)).map(([, v]) => v).flatMap((arr) => arr.map((e) => (Array.isArray(e) ? e[0] : e))))]

// 旧版から deny → allow へ変わってよい形
const FLIP_ALL = [...cases.FP805_FLIP, ...cases.SQ_LITERAL_FLIP]

const SUBSET = [...new Set([
  cases.FP805_FLIP,
  cases.FP805_STAY_DENY,
  cases.FP805_AUDIT_DENY,
  cases.SQ_LITERAL_FLIP,
  cases.SQ_LITERAL_DENY,
  cases.MG_REPO_DENY,
  cases.MG_MERGE_DENY,
  cases.MG_OBFUSCATED_DENY,
  cases.MG_ALLOW,
  cases.PARSE_ALLOW_MAIN,
].flatMap((arr) => arr.map((e) => (Array.isArray(e) ? e[0] : e))))]

function verdict(bash, command, subagent) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [GUARD], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', () => resolve((out.split('\n').filter((l) => l !== '').pop() ?? '').replace('AGENT_GUARD_RESULT ', '')))
    p.stdin.on('error', () => {})
    p.stdin.end(JSON.stringify({ command, subagent }))
  })
}

// 全件を n 並列で流す（実時間の待機はしない）。
async function runAll(bash, jobs, n = 12) {
  const res = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) {
      const i = next++
      res[i] = await verdict(bash, jobs[i][0], jobs[i][1])
    }
  }))
  return res
}

describe('差分テストの前提', () => {
  it('fixture はコーパスの大半を覆う（凍結が古くなっていない）', () => {
    const covered = corpus.filter((c) => BASELINE[c] !== undefined).length
    assert.ok(covered >= corpus.length - 20, `fixture が覆うのは ${covered} / ${corpus.length} 件`)
  })
  it('FP805_FLIP・FP805_STAY_DENY・FP805_AUDIT_DENY・SQ_LITERAL_FLIP・SQ_LITERAL_DENY は全件 fixture にある（旧版の判定が凍結されている）', () => {
    for (const c of FLIP_ALL) assert.ok(BASELINE[c], `fixture に無い: ${JSON.stringify(c)}`)
    for (const [c] of [...cases.FP805_STAY_DENY, ...cases.FP805_AUDIT_DENY, ...cases.SQ_LITERAL_DENY]) assert.ok(BASELINE[c], `fixture に無い: ${JSON.stringify(c)}`)
  })
  it('FP805_FLIP と SQ_LITERAL_FLIP は旧版で subagent=true / null のとき deny だった形だけ', () => {
    for (const c of FLIP_ALL) {
      assert.match(BASELINE[c][1], /^deny /, JSON.stringify(c))
      assert.match(BASELINE[c][2], /^deny /, JSON.stringify(c))
    }
  })
  it('FP805_STAY_DENY・FP805_AUDIT_DENY・SQ_LITERAL_DENY は旧版でも同じ理由で deny だった形（subagent=true / null）', () => {
    for (const [c, r] of [...cases.FP805_STAY_DENY, ...cases.FP805_AUDIT_DENY, ...cases.SQ_LITERAL_DENY]) {
      assert.equal(BASELINE[c][1], `deny ${r}`, JSON.stringify(c))
      assert.equal(BASELINE[c][2], `deny ${r}`, JSON.stringify(c))
    }
  })
})

// 認識器 GH_TEXT_AWK を単体で見る。ガード全体の判定は前段の解析器（GIT_AWK）にも止められるため、認識器の条件だけを
// 外した変異がガード全体では見えないことがある。認識器は前段から独立に安全であるべきなので、ここで直接確かめる:
// 迂回の試行（FP805_STAY_DENY・FP805_AUDIT_DENY）は全件「受理しない」か「骨格に merge の語が残る（ガードが deny する）」、
// 誤検出の形（FP805_FLIP の gh の行）は全件受理され骨格に merge の語が残らない。
describe('認識器 GH_TEXT_AWK（単体）', () => {
  const src = readFileSync(GUARD, 'utf8')
  const m = src.match(/^read -r -d '' GH_TEXT_AWK <<'AWK' \|\| true\n([\s\S]*?)\nAWK\n/m)
  const rec = (command) => spawnSync('awk', [m[1]], { input: `${command}\n`, env: { ...process.env, LC_ALL: 'C' } })
  const words = (skel) => skel.toString().trim().split(/\s+/)

  it('ガードから認識器の awk を取り出せる', () => assert.ok(m, 'GH_TEXT_AWK が見つからない'))
  it('迂回の試行は受理しないか、骨格に merge の語が残る', () => {
    const leaked = []
    for (const [c] of [...cases.FP805_STAY_DENY, ...cases.FP805_AUDIT_DENY]) {
      const r = rec(c)
      assert.equal(r.status, 0, JSON.stringify(c))
      const out = r.stdout.toString()
      if (out !== '' && !words(out).includes('merge')) leaked.push(c)
    }
    assert.deepEqual(leaked, [])
  })
  it('誤検出の形（gh の行）は受理され、骨格に merge の語が残らない', () => {
    for (const c of cases.FP805_FLIP.filter((x) => /^\s*(\/usr\/bin\/)?gh /.test(x))) {
      const out = rec(c).stdout.toString()
      assert.notEqual(out, '', `受理されない: ${JSON.stringify(c)}`)
      assert.ok(!words(out).includes('merge'), `骨格に merge が残る: ${JSON.stringify(c)} -> ${out}`)
    }
  })
  it('骨格は値を X に、標準入力の heredoc を取り除いた形', () => {
    const want = [
      ['gh pr comment 5 --body "ready to merge"', 'gh pr comment 5 --body X'],
      ["gh pr comment 5 --body=x merge -t 'a b'", 'gh pr comment 5 --body=X merge -t X'],
      ["gh pr create \\\n  --base main \\\n  --title \"fix: merge\" \\\n  --body \"$(cat <<'EOF'\n## Summary #805\n- merge (x)\nEOF\n)\"", 'gh pr create --base main --title X --body X'],
      ["gh pr comment 5 -F - <<'EOF'\nready to merge\nEOF", 'gh pr comment 5 -F -'],
    ]
    for (const [c, skel] of want) assert.equal(rec(c).stdout.toString().trim(), skel, JSON.stringify(c))
  })
})

// 認識器 SQ_DOLLAR_AWK（`$'` の例外）を単体で見る。PR #820 の codex P0（評価器の拒否リストに無い awk の system 等で
// `'gh pr $'` と別の語を連結して評価する形が通った）を受けて、例外は許可リストの文法に完全一致するときだけにした。
// 文法の各条件（コマンドの形・先頭語・引数とリダイレクトの形）について、その条件だけで落ちる形と通る対照を並べる。
describe('認識器 SQ_DOLLAR_AWK（単体）', () => {
  const src = readFileSync(GUARD, 'utf8')
  const m = src.match(/^read -r -d '' SQ_DOLLAR_AWK <<'AWK' \|\| true\n([\s\S]*?)\nAWK\n/m)
  const ok = (command) => {
    const r = spawnSync('awk', [m[1]], { input: `${command}\n`, env: { ...process.env, LC_ALL: 'C' } })
    assert.equal(r.status, 0, JSON.stringify(command))
    return r.stdout.toString() === 'ok\n'
  }
  const ALLOWED = ['grep', 'egrep', 'fgrep', 'rg', 'wc', 'head', 'tail', 'cut', 'tr', 'uniq', 'ls', 'cat', 'echo', 'jq', 'basename', 'dirname', 'diff', 'cmp', 'comm', 'nl', 'column', 'fold']
  const EVALUATORS = ['test', '[', '[[', 'printf', 'let', 'declare', 'read', 'sed', 'awk', 'gawk', 'perl', 'python', 'python3', 'ruby', 'node', 'find', 'xargs', 'env', 'git', 'gh', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'eval', 'source', '.', 'command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'timeout', 'sudo', 'sort', 'less', 'vim', 'parallel', 'watch', 'make', 'ssh']

  it('ガードから認識器の awk を取り出せる', () => assert.ok(m, 'SQ_DOLLAR_AWK が見つからない'))
  it('先頭語は許可リストの語だけ通る', () => {
    for (const c of ALLOWED) assert.ok(ok(`${c} 'a$'`), c)
    for (const c of EVALUATORS) assert.ok(!ok(`${c} 'a$'`), c)
  })
  it('誤検出の形（FP805_FLIP の `$\'` を含む行）は受理する', () => {
    for (const c of cases.FP805_FLIP.filter((x) => x.includes("$'") && !/^\s*(\/usr\/bin\/)?gh /.test(x))) assert.ok(ok(c), JSON.stringify(c))
  })
  it('迂回の試行（`$\'` を含む FP805_STAY_DENY・FP805_AUDIT_DENY・SQ_LITERAL_DENY）は受理しない', () => {
    const leaked = [...cases.FP805_STAY_DENY, ...cases.FP805_AUDIT_DENY, ...cases.SQ_LITERAL_DENY].map(([c]) => c).filter((c) => c.includes("$'") && ok(c))
    assert.deepEqual(leaked, [])
  })
  // SQ_LITERAL_FLIP を通すのは 1 段目の字句解析（SQ_LITERAL_AWK）で、この認識器の文法は変えていない
  it('SQ_LITERAL_FLIP は許可リストの文法の外（受理しない）', () => {
    assert.deepEqual(cases.SQ_LITERAL_FLIP.filter(ok), [])
  })
  // [受理する対照, 受理しない形, …]
  const PAIRS = {
    'コマンドの形（単純コマンド・| のパイプラインだけ）': [
      [`grep 'a$' f | wc -l`, `grep 'a$' f; wc -l`, `grep 'a$' f ; wc -l`, `grep 'a$' f && wc -l`, `grep 'a$' f || wc -l`, `grep 'a$' f & wc -l`, `grep 'a$' f |& wc -l`,
        `grep 'a$' f | | wc -l`, `| grep 'a$' f`, `grep 'a$' f |`, `grep 'a$' f\nwc -l`, `grep 'a$' $(f)`, `grep 'a$' \`f\``,
        `grep 'a$' <(f)`, `grep 'a$' f >(f)`, `X=1 grep 'a$' f`, `{ grep 'a$' f; }`, `(grep 'a$' f)`, `! grep 'a$' f`, `grep 'a$' f # x`],
      [`grep\t'a$'\tf`, `grep 'a$' f\r`, `grep 'a\r$' f`, `grep 'a\x0b$' f`, `grep 'a\x1b$' f`, `grep 'a$' f\x0b`, `grep 'a$' f\x7f`, `grep 'a$' f\n`],
    ],
    '先頭語（素の語の完全一致）': [
      [`grep 'a$'`, `/usr/bin/grep 'a$'`, `./grep 'a$'`, `'grep' 'a$'`, `"grep" 'a$'`, `g'rep' 'a$'`, `GREP 'a$'`, `grepx 'a$'`, `$g 'a$'`],
      [`echo 'a$' x`, `[ 'a$' = x ]`, `[[ 'a$' = x ]]`, `[x 'a$'`, `test 'a$' = x`],
    ],
    '引数（素の語・単一引用符・$ ` \\ ! を含まない二重引用符の連結）': [
      [`grep 'a$' "b" x'y'"z"`, `grep 'a$' "$b"`, `grep 'a$' "\\b"`, `grep 'a$' "\`b\`"`, `grep 'a$' "!b"`, `grep 'a$' $b`,
        `grep 'a$' f*`, `grep 'a$' ~/f`, `grep 'a$' {a,b}`, `grep 'a$' 'b`, `grep 'a$' "b`],
      [`grep 'a$' f`, `grep 'a$'b f`, `grep 'a$''b' f`, `grep 'a$'"b" f`, `grep 'a$'$'b' f`, `grep "a$'" f`, `grep $'a' f`],
    ],
    'リダイレクト（素の語か fd の複製）': [
      [`grep 'a$' <i >o 2>e >>a 2>&1 1>&2`, `grep 'a$' <<o`, `grep 'a$' <<<o`, `grep 'a$' <>o`, `grep 'a$' >|o`, `grep 'a$' &>o`,
        `grep 'a$' >&o`, `grep 'a$' > 'o'`, `grep 'a$' > "o"`, `grep 'a$' >`, `grep 'a$' 2>&1x`],
    ],
    '外部コマンドの起動・算術式の評価になるオプションとコマンド': [
      [`rg -n 'a$' .`, `rg --pre sh 'a$' .`, `rg --pre=sh 'a$' .`, `rg '--pre=sh' 'a$' .`, `rg --hostname-bin=sh 'a$' .`],
      [`echo -n 'a$'`, `printf '%s' 'a$'`, `printf -v x 'a$'`, `printf '%d' 'x[$(m=merge; gh pr $m 1)]' 'a$'`],
      [`grep -c 'a$' f`, `grep --filter='*:sh' 'a$' f`, `egrep --filter=x 'a$' f`, `fgrep --pager=sh 'a$' f`, `grep --view 'a$' f`,
        `grep --config=x 'a$' f`, `grep --save-config 'a$'`, `grep ---x 'a$' f`, `grep -@ 'a$' f`, `grep '--filter=x' 'a$' f`],
    ],
  }
  for (const [name, groups] of Object.entries(PAIRS)) {
    it(name, () => {
      for (const [good, ...bad] of groups) {
        assert.ok(ok(good), `受理されない: ${JSON.stringify(good)}`)
        assert.deepEqual(bad.filter(ok), [], `受理してしまう (${name})`)
      }
    })
  }
})

// 2 つの bash は並列に流す（各 bash の中の項目は順に実行する。結果を後続の項目が読むため）。
describe('旧版 → 新版の差分', { concurrency: BASHES.length }, () => {
  for (const bash of BASHES) {
    describe(`${bash}`, { concurrency: 1 }, () => {
      // /bin/bash（3.2）は全コーパス。もう一方の bash は $' とマージ系に関わる表だけ（全件は子プロセスの数が多く、
      // 両 bash の結果が同じことは agent-guard.test.mjs の表が全件で見ている）。
      const pool = bash === BASHES[0] ? corpus : SUBSET
      const targets = pool.filter((c) => BASELINE[c] !== undefined)
      const jobs = targets.flatMap((c) => SUBAGENTS.map((s) => [c, s]))
      let results

      it(`コーパス ${targets.length} 件 × subagent 3 通りを新版に流す`, async () => {
        results = await runAll(bash, jobs)
        assert.equal(results.length, jobs.length)
      })

      it('通るようになったのは FP805_FLIP と SQ_LITERAL_FLIP の和と過不足なく一致する（subagent=true / null）', () => {
        const flipped = { true: new Set(), null: new Set() }
        jobs.forEach(([c, s], i) => {
          if (s === false) return
          const was = BASELINE[c][SUBAGENTS.indexOf(s)]
          if (was.startsWith('deny') && results[i] === 'allow') flipped[String(s)].add(c)
        })
        for (const key of ['true', 'null']) {
          const want = new Set(FLIP_ALL)
          assert.deepEqual([...flipped[key]].filter((c) => !want.has(c)), [], `想定外に通るようになった (subagent=${key})`)
          assert.deepEqual([...want].filter((c) => !flipped[key].has(c)), [], `通るはずが止まったまま (subagent=${key})`)
        }
      })

      it('旧版と判定が変わったのは FP805_FLIP と SQ_LITERAL_FLIP の deny → allow だけ（理由コードも同じ）', () => {
        const flip = new Set(FLIP_ALL)
        const diffs = []
        jobs.forEach(([c, s], i) => {
          const was = BASELINE[c][SUBAGENTS.indexOf(s)]
          if (was === results[i]) return
          if (s !== false && flip.has(c) && was.startsWith('deny') && results[i] === 'allow') return
          diffs.push(`${JSON.stringify(c)} subagent=${s}: ${was} -> ${results[i]}`)
        })
        assert.deepEqual(diffs, [])
      })

      it('subagent=false（main セッション）の判定は 1 件も変わらない', () => {
        const diffs = []
        jobs.forEach(([c, s], i) => {
          if (s === false && BASELINE[c][0] !== results[i]) diffs.push(`${JSON.stringify(c)}: ${BASELINE[c][0]} -> ${results[i]}`)
        })
        assert.deepEqual(diffs, [])
      })
    })
  }
})

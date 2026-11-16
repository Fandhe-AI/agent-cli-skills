// スキル本文のコマンド文面が、サブエージェントでも agent-guard.sh に止められないことの回帰テスト。
//
// 背景: agent-guard.sh は subagent が true / null のとき、コマンドに `$'` があれば obfuscated で拒否する
// （例外は許可リストの単純コマンドだけ）。単一引用符の文字列が `$` で終わると、閉じ引用符と並んで `$'` になる。
// create-commit の Step 2 (a) のブロック（複数行のスクリプト）にこの形があり、OpenCode の実装エージェントが
// 標準手順どおりに実行して止められた（Phase 3 の通し確認）。ガードは変えず、文面を `$'` を含まない等価な形
// （正規表現全体を括弧で包み、末尾を `$)'` にする）へ直した。このテストはその形が戻らないことを見る。
//   - create-commit Step 2 (a) のブロックを SKILL.md から実物で取り出し、素のままと `bash <<'EOF'` で包んだ形
//     （実際に止められた形）の両方が、subagent=true / null で allow になる
//   - 同じブロックを一時 git リポジトリで 1 つのシェルとして実行し、自己テストが通って検査まで進む
//   - skills/ の Markdown のコードフェンスに `$'` が無い（ANSI-C 引用符 `$'\…'` は別の問題なので対象外）
// 判定と実行は /bin/bash（3.2）と PATH の bash（5 系）の両方で行う。子プロセスは並列に流し、実時間の待機はしない。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const GUARD = join(root, 'skills', 'init-codex', 'assets', 'hooks', 'agent-guard.sh')
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function run(cmd, args, { input, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out, err }))
    p.stdin.on('error', () => {})
    p.stdin.end(input ?? '')
  })
}

async function verdict(bash, command, subagent) {
  const { out } = await run(bash, [GUARD], { input: JSON.stringify({ command, subagent }) })
  return (out.split('\n').filter((l) => l !== '').pop() ?? '').replace('AGENT_GUARD_RESULT ', '')
}

// create-commit の Step 2 (a) の bash ブロック（`#### (a)` の後の最初の ```bash から ``` まで）
function createCommitStep2a() {
  const md = readFileSync(join(root, 'skills', 'create-commit', 'SKILL.md'), 'utf8')
  const m = md.match(/^#### \(a\)[^\n]*\n[\s\S]*?^```bash\n([\s\S]*?)^```$/m)
  return m && m[1]
}

describe('create-commit Step 2 (a) のブロック', () => {
  const block = createCommitStep2a()
  // Phase 3 で止められたのは、ブロックを引用符つき heredoc で bash へ渡す形だった
  const wrapped = `bash <<'EOF'\n${block}EOF`

  it('SKILL.md からブロックを取り出せ、`$\'` を含まない', () => {
    assert.ok(block, 'Step 2 (a) の bash ブロックが見つからない')
    assert.ok(block.includes('RE_CREDFILE='), 'RE_CREDFILE の定義が無い（取り出す範囲がずれた）')
    assert.ok(!block.includes("$'"), "ブロックに `$'` がある（サブエージェントでは obfuscated で止められる）")
  })
  for (const bash of BASHES) {
    for (const subagent of [true, null]) {
      for (const [form, command] of [['素のまま', block], ["bash <<'EOF' で包んだ形", wrapped]]) {
        it(`allow（${form}・${bash}・subagent=${subagent}）`, async () => {
          assert.equal(await verdict(bash, command, subagent), 'allow')
        })
      }
    }
  }

  const dirs = []
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  for (const bash of BASHES) {
    it(`1 つのシェルで実行すると自己テストが通り、検査まで進む（${bash}）`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-guard-skill-text-'))
      dirs.push(dir)
      const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }
      const git = (...a) => execFileSync('git', a, { cwd: dir, env })
      git('init', '-q')
      // 認証情報ファイル（.env）は検出され、公開鍵（id_rsa.pub）は除外されることまで見る
      writeFileSync(join(dir, 'notes.md'), 'hello\n')
      writeFileSync(join(dir, '.env'), 'K=v\n')
      writeFileSync(join(dir, 'id_rsa.pub'), 'x\n')
      git('add', 'notes.md', '.env', 'id_rsa.pub')
      const r = await run(bash, ['-c', block], { cwd: dir, env })
      assert.equal(r.code, 0, `終了コードが 0 でない: ${r.err}`)
      assert.ok(!r.err.includes('機能していない'), `自己テストが失敗した: ${r.err}`)
      const lines = r.out.split('\n')
      assert.ok(lines.includes('.env'), `.env が検出されない: ${r.out}`)
      assert.ok(!lines.includes('id_rsa.pub'), `id_rsa.pub が除外されない: ${r.out}`)
      assert.ok(lines.includes('高信頼パターン: 検出なし'), `検査 2 まで進んでいない: ${r.out}`)
    })
  }
})

// skills/ の Markdown のコードフェンス（行頭の空白は許す）にある `$'` を集める。`$'\` で始まる ANSI-C 引用符
// （`IFS=$'\t'` 等）は、括弧で包む書き換えでは直せない別の形なので対象外にする。
function sqDollarInFences() {
  const found = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.md')) {
        let inFence = false
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*```/.test(line)) { inFence = !inFence; return }
          if (inFence && /\$'(?!\\)/.test(line)) found.push(`${relative(root, p)}:${i + 1}: ${line.trim()}`)
        })
      }
    }
  }
  walk(join(root, 'skills'))
  return found
}

describe('skills/ の Markdown のコードフェンス', () => {
  it("単一引用符の末尾の `$` が閉じ引用符と並ぶ形（`$'`）が無い", () => {
    assert.deepEqual(sqDollarInFences(), [])
  })
})

// agents-md-block.test.mjs — assets/scripts/agents-md-block.sh の回帰テスト。
//
// 検証する契約: 区間外のバイト不変・冪等（unchanged は mtime も変えない）・codex / opencode の
// 両方から実行しても区間は 1 つ・マーカー不整合とフェンス閉じ忘れは非 0 でファイル不変・
// 32 KiB 超は警告のみで書く。スクリプトを実プロセスとして /bin/bash（3.2）と PATH の bash で流す。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'assets', 'scripts', 'agents-md-block.sh')
const TEMPLATE = join(HERE, '..', 'assets', 'agents-md-block.md')
const START = '<!-- agent-cli-skills:agents-md:start -->'
const END = '<!-- agent-cli-skills:agents-md:end -->'

const pathBash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
const BASHES = [...new Set(['/bin/bash', pathBash].filter((b) => b && existsSync(b)))]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-md-block-test-'))
  return {
    dir,
    target: join(dir, 'AGENTS.md'),
    block(name, text) {
      const p = join(dir, name)
      writeFileSync(p, text)
      return p
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// 子プロセスは非同期に起動し、テストを並列に流す（各テストは専用の一時ディレクトリを使う）。
function spawnAsync(bash, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    p.on('error', reject)
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

async function run(bash, target, block, extra = []) {
  const r = await spawnAsync(bash, [SCRIPT, '--target', target, '--block', block, ...extra])
  const lines = r.stdout.trim().split('\n')
  const last = lines[lines.length - 1]
  return { status: r.status, stderr: r.stderr, result: last.replace('AGENTS_MD_BLOCK_RESULT ', ''), last }
}

const count = (s, needle) => s.split(needle).length - 1

describe("agents-md-block", { concurrency: true }, () => {
for (const bash of BASHES) describe(`[${bash}]`, { concurrency: true }, () => {
  const tag = `[${bash}]`

  it(`${tag} ファイル無しなら区間だけで新規作成する`, async () => {
    const t = setup()
    try {
      const b = t.block('b.md', 'codex の指示\n')
      const r = await run(bash, t.target, b)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'created')
      assert.equal(readFileSync(t.target, 'utf8'), `${START}\ncodex の指示\n${END}\n`)
      assert.deepEqual(readdirSync(t.dir).sort(), ['AGENTS.md', 'b.md'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 区間無し本文への追記で既存部分のバイトが不変`, async () => {
    const t = setup()
    try {
      const orig = '# AGENTS.md\n\n## 観点\n\n- あ\n- い\n'
      writeFileSync(t.target, orig)
      const r = await run(bash, t.target, t.block('b.md', '指示 A\n'))
      assert.equal(r.result, 'appended')
      const after = readFileSync(t.target, 'utf8')
      assert.ok(after.startsWith(orig))
      assert.equal(count(after, START), 1)
      assert.equal(count(after, END), 1)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 末尾改行の無い本文でも既存バイトは不変で区間が行頭から始まる`, async () => {
    const t = setup()
    try {
      const orig = '# AGENTS.md\n末尾改行なし'
      writeFileSync(t.target, orig)
      const r = await run(bash, t.target, t.block('b.md', '指示 A'))
      assert.equal(r.result, 'appended')
      const after = readFileSync(t.target, 'utf8')
      assert.ok(after.startsWith(orig))
      assert.ok(after.slice(orig.length).startsWith(`\n\n${START}\n`))
      assert.ok(after.endsWith(`指示 A\n${END}\n`))
      assert.equal((await run(bash, t.target, t.block('b.md', '指示 A'))).result, 'unchanged')
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 2 回目は unchanged で、区間は 1 つ・mtime も不変`, async () => {
    const t = setup()
    try {
      writeFileSync(t.target, '# 本文\n')
      const b = t.block('b.md', '指示 A\n')
      assert.equal((await run(bash, t.target, b)).result, 'appended')
      const h = sha(t.target)
      const m = statSync(t.target).mtimeMs
      const r = await run(bash, t.target, b)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'unchanged')
      assert.equal(sha(t.target), h)
      assert.equal(statSync(t.target).mtimeMs, m)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 別内容（opencode 側想定）で再実行しても区間は 1 つで区間外は不変`, async () => {
    const t = setup()
    try {
      const head = '# 前\n\n前の本文\n\n'
      const tail = '\n## 後\n\n後の本文（末尾改行なし）'
      writeFileSync(t.target, `${head}${START}\n古い指示\n${END}\n${tail}`)
      const r = await run(bash, t.target, t.block('b2.md', 'opencode の指示\n2 行目\n'))
      assert.equal(r.result, 'replaced')
      const after = readFileSync(t.target, 'utf8')
      assert.equal(after, `${head}${START}\nopencode の指示\n2 行目\n${END}\n${tail}`)
      assert.equal(count(after, START), 1)
      assert.equal((await run(bash, t.target, t.block('b2.md', 'opencode の指示\n2 行目\n'))).result, 'unchanged')
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 片方のマーカー・2 組・逆順は非 0 でファイルのハッシュ不変`, async () => {
    const cases = {
      'start のみ': `# a\n${START}\nx\n`,
      'end のみ': `# a\nx\n${END}\n`,
      '2 組': `${START}\n1\n${END}\n${START}\n2\n${END}\n`,
      '逆順': `${END}\nx\n${START}\n`,
      'start 2 個 end 1 個': `${START}\n${START}\n${END}\n`,
    }
    for (const [name, body] of Object.entries(cases)) {
      const t = setup()
      try {
        writeFileSync(t.target, body)
        const h = sha(t.target)
        const r = await run(bash, t.target, t.block('b.md', '指示\n'))
        assert.equal(r.status, 4, name)
        assert.equal(r.result, 'error-markers', name)
        assert.equal(sha(t.target), h, name)
        assert.deepEqual(readdirSync(t.dir).sort(), ['AGENTS.md', 'b.md'], `${name}: 一時ファイルが残らない`)
      } finally {
        t.cleanup()
      }
    }
  })

  it(`${tag} コードフェンス内のマーカーは数えず、閉じ忘れフェンスは中止する`, async () => {
    const t = setup()
    try {
      const orig = `# 解説\n\n\`\`\`md\n${START}\n例\n${END}\n\`\`\`\n`
      writeFileSync(t.target, orig)
      const r = await run(bash, t.target, t.block('b.md', '指示\n'))
      assert.equal(r.result, 'appended')
      const after = readFileSync(t.target, 'utf8')
      assert.ok(after.startsWith(orig))
      assert.equal((await run(bash, t.target, t.block('b.md', '指示 2\n'))).result, 'replaced')
      assert.ok(readFileSync(t.target, 'utf8').startsWith(orig))
    } finally {
      t.cleanup()
    }
    const u = setup()
    try {
      writeFileSync(u.target, `# a\n\`\`\`\n${START}\n${END}\n`)
      const h = sha(u.target)
      const r = await run(bash, u.target, u.block('b.md', '指示\n'))
      assert.equal(r.status, 4)
      assert.equal(r.result, 'error-fence')
      assert.equal(sha(u.target), h)
    } finally {
      u.cleanup()
    }
  })

  it(`${tag} --block の中身にマーカーがあれば中止する`, async () => {
    const t = setup()
    try {
      writeFileSync(t.target, '# a\n')
      const h = sha(t.target)
      const r = await run(bash, t.target, t.block('b.md', `x\n${END}\n`))
      assert.equal(r.status, 4)
      assert.equal(r.result, 'error-block-marker')
      assert.equal(sha(t.target), h)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 32 KiB 超は警告を出すが書き込む`, async () => {
    const t = setup()
    try {
      writeFileSync(t.target, `# a\n${'あ'.repeat(11000)}\n`)
      const r = await run(bash, t.target, t.block('b.md', '指示\n'))
      assert.equal(r.status, 0)
      assert.equal(r.result, 'appended')
      assert.match(r.stderr, /32768/)
      assert.equal(count(readFileSync(t.target, 'utf8'), START), 1)
      const small = setup()
      try {
        const r2 = await run(bash, small.target, small.block('b.md', '指示\n'))
        assert.equal(r2.stderr, '')
      } finally {
        small.cleanup()
      }
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} CRLF 本文: 区間外の CR を保ち、既存マーカー行も保ち、冪等`, async () => {
    const t = setup()
    try {
      const head = '# a\r\n\r\n本文\r\n'
      writeFileSync(t.target, `${head}${START}\r\n古\r\n${END}\r\n後\r\n`)
      const r = await run(bash, t.target, t.block('b.md', '新\n'))
      assert.equal(r.result, 'replaced')
      assert.equal(readFileSync(t.target, 'utf8'), `${head}${START}\r\n新\n${END}\r\n後\r\n`)
      assert.equal((await run(bash, t.target, t.block('b.md', '新\n'))).result, 'unchanged')
    } finally {
      t.cleanup()
    }
    const u = setup()
    try {
      const orig = '# a\r\n本文\r\n'
      writeFileSync(u.target, orig)
      assert.equal((await run(bash, u.target, u.block('b.md', '新\n'))).result, 'appended')
      assert.ok(readFileSync(u.target, 'utf8').startsWith(orig))
    } finally {
      u.cleanup()
    }
  })

  it(`${tag} --check は書かずに結果語彙だけ返す`, async () => {
    const t = setup()
    try {
      const b = t.block('b.md', '指示\n')
      assert.equal((await run(bash, t.target, b, ['--check'])).result, 'created')
      assert.equal(existsSync(t.target), false)
      writeFileSync(t.target, '# a\n')
      const h = sha(t.target)
      assert.equal((await run(bash, t.target, b, ['--check'])).result, 'appended')
      assert.equal(sha(t.target), h)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 引数の誤りは非 0`, async () => {
    const t = setup()
    try {
      const r = await spawnAsync(bash, [SCRIPT, '--target', t.target])
      assert.equal(r.status, 1)
      assert.match(r.stdout, /AGENTS_MD_BLOCK_RESULT error-usage/)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 同梱の雛形で追記して冪等・マーカーを含まない`, async () => {
    const t = setup()
    try {
      const tpl = readFileSync(TEMPLATE, 'utf8')
      assert.ok(!tpl.includes('agent-cli-skills:agents-md'))
      writeFileSync(t.target, '# a\n')
      assert.equal((await run(bash, t.target, TEMPLATE)).result, 'appended')
      assert.equal((await run(bash, t.target, TEMPLATE)).result, 'unchanged')
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} --target がシンボリックリンクなら error-symlink で非 0 終了し実体は不変`, async () => {
    const t = setup()
    try {
      const real = join(t.dir, 'real.md')
      writeFileSync(real, '# 実体\n')
      const link = join(t.dir, 'link.md')
      symlinkSync(real, link)
      const h = sha(real)
      const r = await run(bash, link, t.block('b.md', '指示\n'))
      assert.notEqual(r.status, 0)
      assert.equal(r.result, 'error-symlink')
      assert.equal(sha(real), h)
      assert.equal(readFileSync(real, 'utf8'), '# 実体\n')
    } finally {
      t.cleanup()
    }
  })

  // ---- 走査から置換までの間の変更（lost update）の検知 ----
  // 偽のコマンドを PATH の先頭に置き、走査（awk）の直後・一時ファイルの作成（chmod）の直後に
  // AGENTS.md を書き換えさせる。本物のスクリプトにテスト用のフックは持たせない。

  function fakeBin(t, name, body) {
    const bin = join(t.dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const real = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(bin, name), `#!/bin/sh\n${body.replaceAll('REAL', real)}\n`)
    chmodSync(join(bin, name), 0o755)
    return bin
  }

  function runEnv(bash, args, env, cwd) {
    return new Promise((resolve, reject) => {
      const p = spawn(bash, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, cwd })
      let stdout = ''
      let stderr = ''
      p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
      p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
      p.on('error', reject)
      p.on('close', (status) => resolve({ status, stdout, stderr, result: stdout.trim().split('\n').pop().replace('AGENTS_MD_BLOCK_RESULT ', '') }))
    })
  }

  const noTmp = (t) => assert.deepEqual(readdirSync(t.dir).filter((f) => f.includes('.tmp.')), [], '一時ファイルが残っている')

  for (const [name, body] of [['追記', '# a\n'], ['差し替え', `# a\n${START}\n古\n${END}\n`]]) {
    it(`${tag} ${name}: 走査のあとに AGENTS.md が書き換わったら error-changed で上書きしない`, async () => {
      const t = setup()
      try {
        writeFileSync(t.target, body)
        const flag = join(t.dir, 'flag')
        const bin = fakeBin(t, 'awk', `REAL "$@"; rc=$?; if [ ! -e "$FAKE_FLAG" ]; then : > "$FAKE_FLAG"; printf 'racer\\n' >> "$FAKE_TARGET"; fi; exit $rc`)
        const r = await runEnv(bash, ['--target', t.target, '--block', t.block('b.md', '新\n')], { PATH: `${bin}:${process.env.PATH}`, FAKE_FLAG: flag, FAKE_TARGET: t.target })
        assert.equal(r.status, 2, r.stderr)
        assert.equal(r.result, 'error-changed')
        assert.equal(readFileSync(t.target, 'utf8'), `${body}racer\n`, '他者の変更が残る')
        noTmp(t)
      } finally {
        t.cleanup()
      }
    })
  }

  it(`${tag} 作成: 無いと見たあとに他者が作ったら error-changed で上書きしない`, async () => {
    const t = setup()
    try {
      const bin = fakeBin(t, 'chmod', `REAL "$@"; rc=$?; [ -e "$FAKE_TARGET" ] || printf 'racer\\n' > "$FAKE_TARGET"; exit $rc`)
      const r = await runEnv(bash, ['--target', t.target, '--block', t.block('b.md', '新\n')], { PATH: `${bin}:${process.env.PATH}`, FAKE_TARGET: t.target })
      assert.equal(r.status, 2, r.stderr)
      assert.equal(r.result, 'error-changed')
      assert.equal(readFileSync(t.target, 'utf8'), 'racer\n')
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 何も書き換わらなければ通常どおり書ける（対照）`, async () => {
    const t = setup()
    try {
      writeFileSync(t.target, '# a\n')
      const bin = fakeBin(t, 'awk', `REAL "$@"`)
      const r = await runEnv(bash, ['--target', t.target, '--block', t.block('b.md', '新\n')], { PATH: `${bin}:${process.env.PATH}` })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.result, 'appended')
    } finally {
      t.cleanup()
    }
  })

  // ---- 走査（awk）の失敗は結果語彙つきで止める ----

  it(`${tag} awk が失敗したら error-io（結果語彙つき・exit 2）でファイルは不変`, async () => {
    const t = setup()
    try {
      writeFileSync(t.target, '# a\n')
      const h = sha(t.target)
      const bin = fakeBin(t, 'awk', 'exit 2')
      const r = await runEnv(bash, ['--target', t.target, '--block', t.block('b.md', '新\n')], { PATH: `${bin}:${process.env.PATH}` })
      assert.equal(r.status, 2, r.stdout + r.stderr)
      assert.equal(r.result, 'error-io')
      assert.equal(sha(t.target), h)
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  // ---- `-` で始まるパスがオプションとして解釈されない ----

  it(`${tag} --target / --block が - 始まりの相対パスでも通常のファイルとして扱う`, async () => {
    const t = setup()
    try {
      writeFileSync(join(t.dir, '-n'), '# a\n')
      writeFileSync(join(t.dir, '-b.md'), '指示\n')
      const r = await runEnv(bash, ['--target', '-n', '--block', '-b.md'], {}, t.dir)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(r.result, 'appended')
      assert.equal(readFileSync(join(t.dir, '-n'), 'utf8'), `# a\n\n${START}\n指示\n${END}\n`)
      const r2 = await runEnv(bash, ['--target', '-new.md', '--block', '-b.md'], {}, t.dir)
      assert.equal(r2.result, 'created', r2.stdout + r2.stderr)
      assert.equal(readFileSync(join(t.dir, '-new.md'), 'utf8'), `${START}\n指示\n${END}\n`)
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  // ---- 親ディレクトリがシンボリックリンク ----

  it(`${tag} --target の親ディレクトリが symlink なら警告して実体のディレクトリへ書く`, async () => {
    const t = setup()
    try {
      const real = join(t.dir, 'real')
      mkdirSync(real)
      const link = join(t.dir, 'link')
      symlinkSync(real, link)
      writeFileSync(join(real, 'AGENTS.md'), '# a\n')
      const r = await run(bash, join(link, 'AGENTS.md'), t.block('b.md', '指示\n'))
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.result, 'appended')
      assert.match(r.stderr, /親ディレクトリ.*シンボリックリンク/)
      assert.ok(readFileSync(join(real, 'AGENTS.md'), 'utf8').includes(START))
      assert.deepEqual(readdirSync(real), ['AGENTS.md'])
      // 通常の親ディレクトリでは警告しない（対照）
      const r2 = await run(bash, t.target, t.block('b.md', '指示\n'))
      assert.doesNotMatch(r2.stderr, /シンボリックリンク/)
    } finally {
      t.cleanup()
    }
  })
})
})

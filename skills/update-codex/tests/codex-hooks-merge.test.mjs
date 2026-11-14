// codex-hooks-merge.test.mjs — assets/scripts/codex-hooks-merge.sh の回帰テスト。
//
// 検証する契約: 利用者のエントリ・他イベント・未知キーを順序ごと保持して自エントリだけを
// 追加・更新する・同一なら書かない（mtime 不変）・自エントリ重複／不正 JSON／型違いは非 0 で
// ファイル不変・symlink 拒否・--check は書かない。スクリプトを実プロセスとして
// /bin/bash（3.2）と PATH の bash で流す。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'assets', 'scripts', 'codex-hooks-merge.sh')
const TEMPLATE = join(HERE, '..', 'assets', 'codex', 'hooks.json')
const tmpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'))

const pathBash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
const BASHES = [...new Set(['/bin/bash', pathBash].filter((b) => b && existsSync(b)))]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const clone = (o) => JSON.parse(JSON.stringify(o))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-hooks-merge-test-'))
  return {
    dir,
    target: join(dir, 'hooks.json'),
    write(obj) {
      writeFileSync(join(dir, 'hooks.json'), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n')
    },
    read: () => JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')),
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

async function run(bash, target, extra = [], template = TEMPLATE) {
  const r = await spawnAsync(bash, [SCRIPT, '--target', target, '--template', template, ...extra])
  const lines = r.stdout.trim().split('\n')
  const last = lines[lines.length - 1]
  return { status: r.status, stderr: r.stderr, result: last.replace('CODEX_HOOKS_MERGE_RESULT ', ''), last }
}

const userPre = { matcher: '^Edit$', hooks: [{ type: 'command', command: 'echo user-pre', timeout: 5 }] }
const userPre2 = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'bash ./my-own-guard.sh' }] }
const selfPre = () => clone(tmpl.hooks.PreToolUse[0])
const selfStart = () => clone(tmpl.hooks.SessionStart[0])

describe('codex-hooks-merge', { concurrency: true }, () => {
for (const bash of BASHES) describe(`[${bash}]`, { concurrency: true }, () => {
  const tag = `[${bash}]`

  it(`${tag} target 無しならテンプレートのバイトのまま created`, async () => {
    const t = setup()
    try {
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'created')
      assert.equal(readFileSync(t.target, 'utf8'), readFileSync(TEMPLATE, 'utf8'))
      assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 利用者の PreToolUse と共存して追加し、利用者分は同順で残る`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [userPre, userPre2] } })
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'added')
      const j = t.read()
      assert.deepEqual(j.hooks.PreToolUse, [userPre, userPre2, selfPre()])
      assert.deepEqual(j.hooks.SessionStart, [selfStart()])
      assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 利用者の他イベントと未知のトップレベルキーを順序ごと保持する`, async () => {
    const t = setup()
    try {
      const post = [{ matcher: '*', hooks: [{ type: 'command', command: 'echo post' }] }]
      t.write({ zeta: { a: 1 }, hooks: { Stop: [], PostToolUse: post, PreToolUse: [userPre] }, alpha: [1, 2] })
      const r = await run(bash, t.target)
      assert.equal(r.result, 'added')
      const j = t.read()
      assert.deepEqual(Object.keys(j), ['zeta', 'hooks', 'alpha'])
      assert.deepEqual(Object.keys(j.hooks), ['Stop', 'PostToolUse', 'PreToolUse', 'SessionStart'])
      assert.deepEqual(j.zeta, { a: 1 })
      assert.deepEqual(j.alpha, [1, 2])
      assert.deepEqual(j.hooks.Stop, [])
      assert.deepEqual(j.hooks.PostToolUse, post)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 自エントリの古い内容だけを置き換え、同グループの利用者ハンドラと matcher は残す`, async () => {
    const t = setup()
    try {
      const old = { type: 'command', command: 'bash "$(git rev-parse --show-toplevel)/.codex/hooks/codex-pretooluse.sh"', timeout: 1 }
      const mine = { type: 'command', command: 'echo mine' }
      t.write({ hooks: { PreToolUse: [userPre, { matcher: 'Bash', hooks: [mine, old] }], SessionStart: [selfStart()] } })
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'updated')
      const j = t.read()
      assert.deepEqual(j.hooks.PreToolUse, [userPre, { matcher: 'Bash', hooks: [mine, selfPre().hooks[0]] }])
      assert.deepEqual(j.hooks.SessionStart, [selfStart()])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 2 回目は unchanged で mtime もバイトも不変`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [userPre] } })
      assert.equal((await run(bash, t.target)).result, 'added')
      const h = sha(t.target)
      const m = statSync(t.target).mtimeMs
      await new Promise((res) => setTimeout(res, 30))
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'unchanged')
      assert.equal(sha(t.target), h)
      assert.equal(statSync(t.target).mtimeMs, m)
      assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 自エントリが同じイベントに 2 つあれば error-duplicate で非 0・ファイル不変`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [selfPre(), userPre, selfPre()] } })
      const h = sha(t.target)
      const r = await run(bash, t.target)
      assert.notEqual(r.status, 0)
      assert.equal(r.result, 'error-duplicate')
      assert.equal(sha(t.target), h)
      assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 不正 JSON と空ファイルは error-json で非 0・ファイル不変`, async () => {
    for (const body of ['{ "hooks": ', '']) {
      const t = setup()
      try {
        t.write(body)
        const h = sha(t.target)
        const r = await run(bash, t.target)
        assert.notEqual(r.status, 0)
        assert.equal(r.result, 'error-json')
        assert.equal(sha(t.target), h)
      } finally {
        t.cleanup()
      }
    }
  })

  it(`${tag} 期待する型でなければ error-type で非 0・ファイル不変`, async () => {
    const bad = [
      [],
      { hooks: [] },
      { hooks: { PreToolUse: {} } },
      { hooks: { PreToolUse: null } },
      { hooks: { PreToolUse: ['x'] } },
      { hooks: { PreToolUse: [{ matcher: '*', hooks: {} }] } },
      { hooks: { PreToolUse: [{ matcher: '*', hooks: [1] }] } },
    ]
    await Promise.all(bad.map(async (obj) => {
      const t = setup()
      try {
        t.write(obj)
        const h = sha(t.target)
        const r = await run(bash, t.target)
        assert.notEqual(r.status, 0, JSON.stringify(obj))
        assert.equal(r.result, 'error-type', JSON.stringify(obj))
        assert.equal(sha(t.target), h)
        assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
      } finally {
        t.cleanup()
      }
    }))
  })

  it(`${tag} --target がシンボリックリンクなら error-symlink で非 0 終了し実体は不変`, async () => {
    const t = setup()
    try {
      const real = join(t.dir, 'real.json')
      writeFileSync(real, '{"hooks":{}}\n')
      const link = join(t.dir, 'link.json')
      symlinkSync(real, link)
      const h = sha(real)
      const r = await run(bash, link)
      assert.notEqual(r.status, 0)
      assert.equal(r.result, 'error-symlink')
      assert.equal(sha(real), h)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} --check は書かず、書いた場合の語彙だけを返す`, async () => {
    const t = setup()
    try {
      const r0 = await run(bash, t.target, ['--check'])
      assert.equal(r0.result, 'created')
      assert.equal(existsSync(t.target), false)

      t.write({ hooks: { PreToolUse: [userPre] } })
      const h = sha(t.target)
      const r1 = await run(bash, t.target, ['--check'])
      assert.equal(r1.status, 0)
      assert.equal(r1.result, 'added')
      assert.equal(sha(t.target), h)

      await run(bash, t.target)
      const h2 = sha(t.target)
      assert.equal((await run(bash, t.target, ['--check'])).result, 'unchanged')
      assert.equal(sha(t.target), h2)
      assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 使い方の誤りは error-usage で exit 1`, async () => {
    const r = await spawnAsync(bash, [SCRIPT, '--target', '/nonexistent/x.json'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /CODEX_HOOKS_MERGE_RESULT error-usage/)
  })
})
})

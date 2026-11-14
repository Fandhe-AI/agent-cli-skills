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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
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
      t.write({ hooks: { PreToolUse: [userPre, { matcher: '^Bash$', hooks: [mine, old] }], SessionStart: [selfStart()] } })
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'updated')
      const j = t.read()
      assert.deepEqual(j.hooks.PreToolUse, [userPre, { matcher: '^Bash$', hooks: [mine, selfPre().hooks[0]] }])
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

  it(`${tag} 自エントリが ^Edit$ のグループにあれば error-matcher（exit 4）でファイル不変・--check でも同じ`, async () => {
    const t = setup()
    try {
      const wrong = { ...selfPre(), matcher: '^Edit$' }
      // 内容が同一でも（unchanged になりうる形）、古い内容でも（updated になりうる形）止める。
      const stale = { matcher: '^Edit$', hooks: [{ ...selfPre().hooks[0], timeout: 1 }] }
      for (const doc of [{ hooks: { PreToolUse: [wrong] } }, { hooks: { PreToolUse: [userPre, stale] } }]) {
        t.write(doc)
        const h = sha(t.target)
        for (const extra of [[], ['--check']]) {
          const r = await run(bash, t.target, extra)
          assert.equal(r.status, 4)
          assert.equal(r.result, 'error-matcher')
          assert.equal(sha(t.target), h)
        }
        assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
      }
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} SessionStart の自エントリは matcher が違っても error-matcher にしない`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { SessionStart: [{ ...selfStart(), matcher: 'startup' }], PreToolUse: [selfPre()] } })
      const r = await run(bash, t.target)
      assert.equal(r.status, 0)
      assert.equal(r.result, 'unchanged')
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

  // ---- 複数文書（`{}{}`）は最初の文書だけを書き戻さず error-json で止める ----

  it(`${tag} 複数の JSON 文書を持つ target は error-json で非 0・ファイル不変`, async () => {
    for (const body of ['{}{}', '{"hooks":{}}\n{"hooks":{}}\n', '{} []', '{"hooks":{}} 1']) {
      const t = setup()
      try {
        t.write(body)
        const h = sha(t.target)
        for (const extra of [[], ['--check']]) {
          const r = await run(bash, t.target, extra)
          assert.equal(r.status, 4, `${JSON.stringify(body)} ${extra}: ${r.stderr}`)
          assert.equal(r.result, 'error-json')
        }
        assert.equal(sha(t.target), h)
        assert.deepEqual(readdirSync(t.dir), ['hooks.json'])
      } finally {
        t.cleanup()
      }
    }
  })

  // ---- 読み込みから置換までの間の変更（lost update）の検知 ----
  // 偽の jq・chmod を PATH の先頭に置き、マージ用の jq 実行の直後・一時ファイル作成の直後に
  // target を書き換えさせる。本物のスクリプトにテスト用のフックは持たせない。

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
      p.on('close', (status) => resolve({ status, stdout, stderr, result: stdout.trim().split('\n').pop().replace('CODEX_HOOKS_MERGE_RESULT ', '') }))
    })
  }

  const noTmp = (t) => assert.deepEqual(readdirSync(t.dir).filter((f) => f.includes('.tmp.')), [], '一時ファイルが残っている')

  it(`${tag} 読み込んだあとに target が書き換わったら error-changed で上書きしない`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [userPre] } })
      const racer = readFileSync(t.target, 'utf8') + '\n'
      const flag = join(t.dir, 'flag')
      // マージ用の jq（-f を使う呼び出し）の直後に 1 回だけ target を書き換える
      const bin = fakeBin(t, 'jq', `case " $* " in *" -f "*) REAL "$@"; rc=$?; if [ ! -e "$FAKE_FLAG" ]; then : > "$FAKE_FLAG"; printf '\\n' >> "$FAKE_TARGET"; fi; exit $rc;; *) exec REAL "$@";; esac`)
      const r = await runEnv(bash, ['--target', t.target, '--template', TEMPLATE], { PATH: `${bin}:${process.env.PATH}`, FAKE_FLAG: flag, FAKE_TARGET: t.target })
      assert.equal(r.status, 2, r.stderr)
      assert.equal(r.result, 'error-changed')
      assert.equal(readFileSync(t.target, 'utf8'), racer, '他者の変更が残る')
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 作成: 無いと見たあとに他者が作ったら error-changed で上書きしない`, async () => {
    const t = setup()
    try {
      const bin = fakeBin(t, 'chmod', `REAL "$@"; rc=$?; [ -e "$FAKE_TARGET" ] || printf '{"x":1}\\n' > "$FAKE_TARGET"; exit $rc`)
      const r = await runEnv(bash, ['--target', t.target, '--template', TEMPLATE], { PATH: `${bin}:${process.env.PATH}`, FAKE_TARGET: t.target })
      assert.equal(r.status, 2, r.stderr)
      assert.equal(r.result, 'error-changed')
      assert.equal(readFileSync(t.target, 'utf8'), '{"x":1}\n')
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  it(`${tag} 何も書き換わらなければ通常どおり書ける（対照）`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [userPre] } })
      const bin = fakeBin(t, 'jq', 'exec REAL "$@"')
      const r = await runEnv(bash, ['--target', t.target, '--template', TEMPLATE], { PATH: `${bin}:${process.env.PATH}` })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.result, 'added')
    } finally {
      t.cleanup()
    }
  })

  // ---- jq の stderr（対象データの断片を含み得る）をエラーへ載せない ----

  it(`${tag} jq の実行が失敗しても stderr の断片を結果へ出さない`, async () => {
    const t = setup()
    try {
      t.write({ hooks: { PreToolUse: [userPre] } })
      const h = sha(t.target)
      const bin = fakeBin(t, 'jq', `case " $* " in *" -f "*) echo 'Cannot index string ("SENTINEL-SECRET-VALUE")' >&2; exit 5;; *) exec REAL "$@";; esac`)
      const r = await runEnv(bash, ['--target', t.target, '--template', TEMPLATE], { PATH: `${bin}:${process.env.PATH}` })
      assert.equal(r.status, 2, r.stderr)
      assert.equal(r.result, 'error-io')
      assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL-SECRET-VALUE/)
      assert.equal(sha(t.target), h)
      noTmp(t)
    } finally {
      t.cleanup()
    }
  })

  // ---- `-` で始まるパスがオプションとして解釈されない ----

  it(`${tag} --target / --template が - 始まりの相対パスでも通常のファイルとして扱う`, async () => {
    const t = setup()
    try {
      writeFileSync(join(t.dir, '-t.json'), JSON.stringify({ hooks: { PreToolUse: [userPre] } }) + '\n')
      writeFileSync(join(t.dir, '-tmpl.json'), readFileSync(TEMPLATE))
      const r = await runEnv(bash, ['--target', '-t.json', '--template', '-tmpl.json'], {}, t.dir)
      assert.equal(r.status, 0, r.stdout + r.stderr)
      assert.equal(r.result, 'added')
      assert.deepEqual(JSON.parse(readFileSync(join(t.dir, '-t.json'), 'utf8')).hooks.PreToolUse.length, 2)
      const r2 = await runEnv(bash, ['--target', '-new.json', '--template', '-tmpl.json'], {}, t.dir)
      assert.equal(r2.result, 'created', r2.stdout + r2.stderr)
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
      writeFileSync(join(real, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [userPre] } }) + '\n')
      const r = await run(bash, join(link, 'hooks.json'))
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.result, 'added')
      assert.match(r.stderr, /親ディレクトリ.*シンボリックリンク/)
      assert.equal(JSON.parse(readFileSync(join(real, 'hooks.json'), 'utf8')).hooks.PreToolUse.length, 2)
      assert.deepEqual(readdirSync(real), ['hooks.json'])
      // 通常の親ディレクトリでは警告しない（対照）
      t.write({ hooks: {} })
      assert.doesNotMatch((await run(bash, t.target)).stderr, /シンボリックリンク/)
    } finally {
      t.cleanup()
    }
  })
})
})

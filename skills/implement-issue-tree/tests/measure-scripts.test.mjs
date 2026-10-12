// 測定スクリプト（scripts/measure-residual-bytes.sh・measure-free-disk.sh）を実際に実行する回帰テスト
// （Issue #603 第 1 弾）。一時ディレクトリにファイルを作って du / df を本当に走らせる。
//
// 検証する契約（ホスト側の判定ロジックは変えていないので、スクリプトは旧プロンプトのシェルと同じ意味を保つ）:
//   - 存在しないパスは測定失敗にせず missing に数え、kib へは 0 として加算する
//   - du の実失敗・出力欠損・許可文字集合外のパス・相対パスは err に数える（kib=0 に畳み込まない）
//   - count は処理した行数で、入力の件数と一致する（ホストが送った件数と突き合わせる）
//   - 出力は 1 行の封筒 {nonce, payload, sha256}。sha256 は nonce + 改行 + payload の正規形の SHA-256
//   - 入力はシェルに再評価されない（$(...)・バッククォート・; を含むパスは実行されず err になる）
//
// CI は Linux（GNU）、手元は macOS（BSD userland・/bin/bash は 3.2）。両方で通る書き方だけを使う:
// 利用できる bash（/bin/bash と Homebrew の bash など）をすべて回し、fake の du / df は PATH の先頭へ置く。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes, expectedSha256, toolExists } from './lib/signed-output.mjs'

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const RESIDUAL = join(SCRIPTS, 'measure-residual-bytes.sh')
const FREE = join(SCRIPTS, 'measure-free-disk.sh')
const NONCE = 'k3x9a0b1c2d4e5f6g7h8i9j0k1l2'
const BASHES = availableBashes()

function run(bash, script, args, { input = '', env = {} } = {}) {
  const r = spawnSync(bash, [script, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return r
}

// 標準出力が 1 行の封筒であることを検証して返す
function parseEnvelope(r) {
  assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
  assert.match(r.stdout, /^[^\n]+\n$/, '標準出力は 1 行（末尾の改行 1 つ）')
  const env = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(env).sort(), ['nonce', 'payload', 'sha256'])
  return env
}

function duKib(path) {
  const r = spawnSync('du', ['-sk', '--', path], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return Number(r.stdout.split(/\s/)[0])
}

// 実行する du / df の代わりに置く偽コマンドのディレクトリを作る
function fakeBin(files) {
  const dir = mkdtempSync(join(tmpdir(), 'iit-fakebin-'))
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
  }
  return dir
}

function withWork(fn) {
  const work = mkdtempSync(join(tmpdir(), 'iit-measure-'))
  try {
    return fn(work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function mkTree(work, name, kib = 8) {
  const d = join(work, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'f.bin'), Buffer.alloc(kib * 1024, 1))
  return d
}

for (const bash of BASHES) {
  const tag = `[${bash}]`

  test(`${tag} residual: 実在パスの du 合計・存在しないパスは missing・件数は入力行数と一致し、封筒の sha256 が正しい`, () => {
    withWork((work) => {
      const a = mkTree(work, 'wt-a', 64)
      const b = mkTree(work, 'wt b with space', 32) // 半角スペースは許可文字集合
      const gone = join(work, 'gone')
      const r = run(bash, RESIDUAL, ['--nonce', NONCE], { input: `${a}\n${b}\n${gone}\n` })
      const env = parseEnvelope(r)
      assert.equal(env.nonce, NONCE)
      assert.deepEqual(env.payload, { count: 3, err: 0, kib: duKib(a) + duKib(b), missing: 1 })
      assert.equal(env.sha256, expectedSha256(NONCE, env.payload))
      // payload のキー順は昇順（ホストの canonicalJson と同じ正規形）
      assert.match(r.stdout, /"payload":\{"count":\d+,"err":\d+,"kib":\d+,"missing":\d+\}/)
    })
  })

  test(`${tag} residual: 0 件は count=0・err=0・kib=0 の正常な封筒（取得失敗とは err で区別する）`, () => {
    const env = parseEnvelope(run(bash, RESIDUAL, ['--nonce', NONCE], { input: '' }))
    assert.deepEqual(env.payload, { count: 0, err: 0, kib: 0, missing: 0 })
  })

  test(`${tag} residual: 末尾の改行が無い最終行も 1 件として処理する`, () => {
    withWork((work) => {
      const a = mkTree(work, 'wt-a')
      const env = parseEnvelope(run(bash, RESIDUAL, ['--nonce', NONCE], { input: a }))
      assert.deepEqual(env.payload, { count: 1, err: 0, kib: duKib(a), missing: 0 })
    })
  })

  test(`${tag} residual: 空ディレクトリの kib は du の実測値と一致する（0 とは限らない）`, () => {
    withWork((work) => {
      const d = join(work, 'empty')
      mkdirSync(d)
      const env = parseEnvelope(run(bash, RESIDUAL, ['--nonce', NONCE], { input: `${d}\n` }))
      assert.equal(env.payload.kib, duKib(d))
      assert.equal(env.payload.err, 0)
    })
  })

  test(`${tag} residual: 許可文字集合外・相対・.. を含む・ルート直下のパスは du に渡さず err に数える（実行もされない）`, () => {
    withWork((work) => {
      const good = mkTree(work, 'wt-ok', 16)
      const marker = join(work, 'PWNED')
      const bad = [
        `/tmp/x;touch ${marker}`,
        `/tmp/$(touch ${marker})`,
        '/tmp/`touch ' + marker + '`',
        '/tmp/a|b',
        '/tmp/a*b',
        "/tmp/it's",
        '/tmp/../etc',
        'relative/path',
        '/',
        '/-rf',
        '',
      ]
      const r = run(bash, RESIDUAL, ['--nonce', NONCE], { input: [good, ...bad].join('\n') + '\n' })
      const env = parseEnvelope(r)
      assert.deepEqual(env.payload, { count: 1 + bad.length, err: bad.length, kib: duKib(good), missing: 0 })
      assert.equal(existsSync(marker), false, '入力がシェルに再評価されていない')
    })
  })

  test(`${tag} residual: du が失敗したら err に数え、成功した分の合計を kib に出す（0 に畳み込まない）`, () => {
    withWork((work) => {
      const a = mkTree(work, 'wt-a')
      const b = mkTree(work, 'wt-b')
      // wt-a だけ失敗する偽 du。それ以外は本物へ委譲する
      const real = spawnSync('sh', ['-c', 'command -v du'], { encoding: 'utf8' }).stdout.trim()
      const bin = fakeBin({ du: `case "$*" in *wt-a*) exit 1 ;; esac\nexec ${real} "$@"` })
      try {
        const r = run(bash, RESIDUAL, ['--nonce', NONCE], { input: `${a}\n${b}\n`, env: { PATH: `${bin}:${process.env.PATH}` } })
        const env = parseEnvelope(r)
        assert.deepEqual(env.payload, { count: 2, err: 1, kib: duKib(b), missing: 0 })
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })
  })

  test(`${tag} residual: du が 0 終了でも出力が数値でなければ err（出力欠損を 0 KiB にしない）`, () => {
    withWork((work) => {
      const a = mkTree(work, 'wt-a')
      for (const body of ['exit 0', 'echo notanumber /x', 'printf "\\t%s\\n" x']) {
        const bin = fakeBin({ du: body })
        try {
          const env = parseEnvelope(run(bash, RESIDUAL, ['--nonce', NONCE], { input: `${a}\n`, env: { PATH: `${bin}:${process.env.PATH}` } }))
          assert.deepEqual(env.payload, { count: 1, err: 1, kib: 0, missing: 0 }, body)
        } finally {
          rmSync(bin, { recursive: true, force: true })
        }
      }
    })
  })

  test(`${tag} residual: 多数件（400 件）でも件数と合計が崩れない`, () => {
    withWork((work) => {
      const base = mkTree(work, 'wt-base', 4)
      const lines = []
      for (let i = 0; i < 400; i++) lines.push(i % 4 === 3 ? join(work, `gone-${i}`) : base)
      const env = parseEnvelope(run(bash, RESIDUAL, ['--nonce', NONCE], { input: lines.join('\n') + '\n' }))
      assert.deepEqual(env.payload, { count: 400, err: 0, kib: duKib(base) * 300, missing: 100 })
    })
  })

  test(`${tag} residual: --nonce の欠落・形式不正・未知の引数は exit 2 で封筒を出さない`, () => {
    for (const args of [[], ['--nonce'], ['--nonce', ''], ['--nonce', 'ABC'], ['--nonce', 'a b'], ['--nonce', 'a;b'], ['--nonce', 'x'.repeat(65)], ['--bogus']]) {
      const r = run(bash, RESIDUAL, args, { input: '/tmp\n' })
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.equal(r.stdout, '', JSON.stringify(args))
    }
  })

  test(`${tag} residual: sha256sum / shasum が無ければ exit 3 で封筒を出さない`, () => {
    // dirname と du だけを置いた PATH。sha256sum / shasum は無い
    const bin = mkdtempSync(join(tmpdir(), 'iit-nohash-'))
    try {
      for (const t of ['dirname', 'du']) {
        const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
        symlinkSync(p, join(bin, t))
      }
      const r = run(bash, RESIDUAL, ['--nonce', NONCE], { input: '/tmp\n', env: { PATH: bin } })
      assert.equal(r.status, 3)
      assert.equal(r.stdout, '')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test(`${tag} free-disk: 実パスの freeKib は正の整数で err=0、封筒の sha256 が正しい`, () => {
    withWork((work) => {
      const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', work]))
      assert.equal(env.payload.err, 0)
      assert.ok(Number.isInteger(env.payload.freeKib) && env.payload.freeKib > 0, JSON.stringify(env.payload))
      assert.deepEqual(Object.keys(env.payload), ['err', 'freeKib'])
      assert.equal(env.sha256, expectedSha256(NONCE, env.payload))
      // 本物の df と同じ桁であること（実行間の変動は許容: 1 GiB 以内）
      const df = spawnSync('df', ['-Pk', '--', work], { encoding: 'utf8' }).stdout.split('\n')[1].trim().split(/\s+/)
      assert.ok(Math.abs(Number(df[3]) - env.payload.freeKib) < 1024 * 1024, `df=${df[3]} script=${env.payload.freeKib}`)
    })
  })

  test(`${tag} free-disk: 偽 df の Available 列（第 4 列）をそのまま freeKib にする`, () => {
    withWork((work) => {
      const bin = fakeBin({ df: 'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 1000000 400000 600000 40% /"' })
      try {
        const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', work], { env: { PATH: `${bin}:${process.env.PATH}` } }))
        assert.deepEqual(env.payload, { err: 0, freeKib: 600000 })
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })
  })

  test(`${tag} free-disk: 取得失敗は err=1・freeKib=0（空き 0 KiB の実測とは err で区別できる）`, () => {
    withWork((work) => {
      // df の非 0 終了 / 出力が 1 行だけ / 第 4 列が数値でない
      for (const body of ['exit 1', 'echo header-only', 'echo hdr; echo "/dev/x 1 2 abc 4% /"', 'exit 0']) {
        const bin = fakeBin({ df: body })
        try {
          const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', work], { env: { PATH: `${bin}:${process.env.PATH}` } }))
          assert.deepEqual(env.payload, { err: 1, freeKib: 0 }, body)
        } finally {
          rmSync(bin, { recursive: true, force: true })
        }
      }
      // 空き 0 の実測は err=0・freeKib=0
      const bin = fakeBin({ df: 'echo hdr; echo "/dev/x 1 1 0 100% /"' })
      try {
        const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', work], { env: { PATH: `${bin}:${process.env.PATH}` } }))
        assert.deepEqual(env.payload, { err: 0, freeKib: 0 })
      } finally {
        rmSync(bin, { recursive: true, force: true })
      }
    })
  })

  test(`${tag} free-disk: 存在しない・許可文字集合外・相対のパスは err=1 で、入力は再評価されない`, () => {
    withWork((work) => {
      const marker = join(work, 'PWNED')
      for (const p of [join(work, 'none'), `/tmp/$(touch ${marker})`, '/tmp/a;b', 'relative', '/tmp/../etc', '/']) {
        const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', p]))
        assert.deepEqual(env.payload, { err: 1, freeKib: 0 }, p)
      }
      assert.equal(existsSync(marker), false)
    })
  })

  test(`${tag} free-disk: 使い方の誤り（nonce 不正・パス 0 件・2 件・-- なし）は exit 2 で封筒を出さない`, () => {
    for (const args of [[], ['--nonce', NONCE], ['--nonce', NONCE, '--'], ['--nonce', NONCE, '--', '/tmp', '/var'], ['--nonce', 'BAD', '--', '/tmp'], ['--nonce', NONCE, '/tmp']]) {
      const r = run(bash, FREE, args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.equal(r.stdout, '', JSON.stringify(args))
    }
  })

  test(`${tag} free-disk: パスが -- の後ろにあれば先頭が - でも引数として解釈されない`, () => {
    // 先頭が - のパスは許可文字集合外（絶対パスでない）として err=1 になるだけで、df のオプションにならない
    const env = parseEnvelope(run(bash, FREE, ['--nonce', NONCE, '--', '-h']))
    assert.deepEqual(env.payload, { err: 1, freeKib: 0 })
  })
}

test('利用できる bash を 1 つ以上で実行している（macOS では /bin/bash 3.2 を含む）', () => {
  assert.ok(BASHES.length >= 1)
  assert.ok(toolExists('du') && toolExists('df') && toolExists('awk'))
})

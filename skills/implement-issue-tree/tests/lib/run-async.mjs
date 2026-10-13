// 子プロセスを非同期に走らせる共通ヘルパー（Issue #603・テストの高速化）。ファイル名が `*.test.mjs` に一致しないため
// node --test の glob には拾われない。
//
// 実時間を待つテスト（壁時計の上限で gh を kill する観測スクリプトなど）は、spawnSync で順に走らせると待ちが足し算になる。
// 検査の中身（縮尺・値・判定）を変えずに待ちだけを重ねるため、このヘルパーで非同期に走らせ、独立したケースは Promise.all か
// describe の { concurrency } で同時に走らせる。子プロセスの標準入力は閉じる（ハングする gh が入力待ちで止まらない）。
import { spawn } from 'node:child_process'

// spawnSync の戻り値と同じ形（status・signal・stdout・stderr）の Promise。タイムアウトは持たない（呼び出し側が壁時計で決める）
export function spawnAsync(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    c.stdout.setEncoding('utf8')
    c.stderr.setEncoding('utf8')
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('error', reject)
    c.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
    if (input !== undefined) c.stdin.end(input)
  })
}

// ハングする偽 gh（GH_STUB_HANG）に渡す sleep の秒数。テスト・bash ごとに一意にする。
// 残存する sleep を `sleep <秒数>` で探すので、同時に走る別のケースの sleep と取り違えないための値で、
// base（テストごとの帯の先頭）+ プロセスごとの揺らぎ + bash の通し番号。
export function hangSeconds(base, bashIndex) {
  return String(base + (process.pid % 450) * 2 + bashIndex)
}

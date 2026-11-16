// 偽 codex（テスト用）。PATH 上の `codex` として `node fake-codex.mjs` を起動する薄いラッパーを作り、
// 引数・環境・標準入力を記録し、シナリオどおりの JSONL を出力する。
//
// シナリオ（環境変数 FAKE_CODEX_SCENARIO が指す JSON）: { turns: [turn, …] }（exec / exec resume の呼び出し順に消費）
//   turn: {
//     threadId,              thread.started の ID（省略時は固定の UUID）
//     toolCalls: [cmd, …],   hook を実際に実行して（引数の hooks.PreToolUse のコマンド行を bash -c で起動）許可・拒否を決め、
//                            command_execution イベントを出す。hook が deny / 異常終了ならコマンドは実行されない
//     skipHook: true,        hook を呼ばずに command_execution だけを出す（hook が黙って読まれない状況の再現）
//     message,               最終応答のテキスト（agent_message と -o の内容）
//     noOutputFile: true,    -o へ書かない（JSONL の agent_message だけ）
//     fail: 'turn.failed' | 'error-exit' | 'exit' | 'usage-limit' | 'usage-limit-exit',  失敗の形
//     failMessage,           失敗メッセージ
//     exitCode,              終了コード（既定 0。fail 指定時は 1）
//     hang: true,            終了せず待つ（時間切れ試験）。SIGTERM を無視する
//     grandchild: <pid file>,孫プロセス（sleep）を同じプロセスグループで起動し、pid を書く
//   }
// 記録: FAKE_CODEX_LOG（JSON Lines）へ { argv, env: {…}, stdin, cwd } か { delete: id } を追記する。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const log = process.env.FAKE_CODEX_LOG
const rec = (o) => log && appendFileSync(log, `${JSON.stringify(o)}\n`)

if (argv[0] === '--version') { console.log('codex-cli 0.169.0'); process.exit(0) }
if (argv[0] === 'delete') {
  rec({ delete: argv.at(-1), force: argv.includes('--force'), env: { CODEX_HOME: process.env.CODEX_HOME } })
  console.log(`Deleted session ${argv.at(-1)}.`)
  process.exit(process.env.FAKE_CODEX_DELETE_FAIL === argv.at(-1) ? 1 : 0)
}
if (argv[0] !== 'exec') process.exit(64)

let stdin = ''
for await (const c of process.stdin) stdin += c
rec({
  argv,
  stdin,
  cwd: process.cwd(),
  env: Object.fromEntries(['CODEX_HOME', 'TMPDIR', 'HOME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'].map((k) => [k, process.env[k] ?? null])),
})

const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'))
const counterFile = `${process.env.FAKE_CODEX_SCENARIO}.n`
const idx = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0
writeFileSync(counterFile, String(idx + 1))
const turn = scenario.turns[Math.min(idx, scenario.turns.length - 1)]

const ev = (o) => console.log(JSON.stringify(o))
const threadId = turn.threadId ?? '00000000-0000-4000-8000-000000000001'
const outPath = argv[argv.indexOf('-o') + 1]
ev({ type: 'thread.started', thread_id: threadId })
ev({ type: 'turn.started' })

if (turn.grandchild) {
  const g = spawn('sleep', ['300'], { stdio: 'ignore' })
  writeFileSync(turn.grandchild, String(g.pid))
}
if (turn.hang) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

const hookArg = argv.find((a) => a.startsWith('hooks.PreToolUse='))
let n = 0
for (const cmd of turn.toolCalls ?? []) {
  const id = `item_${++n}`
  ev({ type: 'item.started', item: { id, type: 'command_execution', command: cmd, status: 'in_progress' } })
  let denied = false
  if (!turn.skipHook && hookArg) {
    const hookCmd = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hookArg)[1])
    const r = spawnSync('bash', ['-c', hookCmd], { input: JSON.stringify({ tool_input: { command: cmd } }), encoding: 'utf8' })
    denied = r.status !== 0 || r.stdout.includes('"permissionDecision":"deny"')
  }
  ev({ type: 'item.completed', item: { id, type: 'command_execution', command: cmd, exit_code: denied ? null : 0, status: denied ? 'declined' : 'completed', aggregated_output: '' } })
}

const msg = turn.message ?? '{}'
const failMsg = turn.failMessage ?? (turn.fail?.startsWith('usage-limit') ? 'You have hit your usage limit. UsageLimitExceeded' : 'boom')
if (turn.fail === 'turn.failed' || turn.fail === 'usage-limit') {
  ev({ type: 'turn.failed', error: { message: failMsg } })
  process.exit(turn.exitCode ?? 1)
}
if (turn.fail === 'error-exit' || turn.fail === 'usage-limit-exit') {
  ev({ type: 'error', message: failMsg })
  process.exit(turn.exitCode ?? 1)
}
if (turn.fail === 'exit') {
  process.stderr.write('segfault\n')
  process.exit(turn.exitCode ?? 139)
}
ev({ type: 'item.completed', item: { id: `item_${++n}`, type: 'agent_message', text: msg } })
if (!turn.noOutputFile) writeFileSync(outPath, msg)
ev({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 } })
process.exit(turn.exitCode ?? 0)

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
//     codeMode: [input, …],  セッションの記録へ code mode の呼び出し（custom_tool_call・name "exec"・input は JavaScript）を書く
//     functionCalls: [{ name, arguments }, …], セッションの記録へ直接の function_call を書く
//     noRollout: true,       セッションの記録を書かない（記録が見つからない状況）
//     extraRollout: true,    同じ ID の記録をもう 1 つ別の日付の下に書く（1 つに決まらない状況）
//     splitUtf8: true,       agent_message のイベント行を、日本語の文字の途中（バイトの境界）で 2 回に分けて書く（間に待ちを入れる）
//     flood: { stream: 'stdout'|'stderr', bytes },  指定のバイト数を改行なしで書き続けてから hang する（出力の上限の試験）
//     splitUtf8: true,       agent_message のイベント行を、日本語の文字の途中（バイトの境界）で 2 回に分けて書く（間に待ちを入れる）
//     flood: { stream: 'stdout'|'stderr', bytes },  指定のバイト数を書き続けてから hang する（出力の上限の試験。SIGTERM は無視）
//     rolloutId,             記録の session_meta の id（既定は threadId。食い違いの再現）
//   }
// セッションの記録: 実 codex と同じく <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<時刻>-<threadId>.jsonl に書く
// （resume は同じファイルへ追記する。形は 2026-11-17 の codex-cli 0.169.0 の実測を手で組んだもの）。
// 記録: FAKE_CODEX_LOG（JSON Lines）へ { argv, env: {…}, stdin, cwd } か { delete: id } を追記する。
// `features list` は下の分岐（<FAKE_CODEX_LOG>.features へ記録）。`--version` は <FAKE_CODEX_LOG>.version へ記録する。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const log = process.env.FAKE_CODEX_LOG
const rec = (o) => log && appendFileSync(log, `${JSON.stringify(o)}\n`)

// `--version`（start の最初の起動）。起動時点で TMPDIR のディレクトリがあるかを <FAKE_CODEX_LOG>.version へ記録する
if (argv[0] === '--version') {
  if (log) appendFileSync(`${log}.version`, `${JSON.stringify({ tmpdir: process.env.TMPDIR ?? null, tmpdirExists: typeof process.env.TMPDIR === 'string' && existsSync(process.env.TMPDIR) })}\n`)
  console.log('codex-cli 0.169.0')
  process.exit(0)
}
if (argv[0] === 'delete') {
  rec({ delete: argv.at(-1), force: argv.includes('--force'), env: { CODEX_HOME: process.env.CODEX_HOME } })
  console.log(`Deleted session ${argv.at(-1)}.`)
  process.exit(process.env.FAKE_CODEX_DELETE_FAIL === argv.at(-1) ? 1 : 0)
}
// `codex features list`（start の unified_exec_tty の確認）。実 codex の出力と同じ「名前 段階 有効」の表。
// 記録は FAKE_CODEX_LOG とは別の <FAKE_CODEX_LOG>.features へ書く（exec の記録の順番を変えない）。
// FAKE_CODEX_FEATURES: tty-forced（-c で false にしても true のまま。managed requirements の再現）/ no-line（行が無い）/ fail（非 0 終了）
if (argv[0] === 'features' && argv[1] === 'list') {
  if (log) appendFileSync(`${log}.features`, `${JSON.stringify({ argv, env: { CODEX_HOME: process.env.CODEX_HOME ?? null } })}\n`)
  const mode = process.env.FAKE_CODEX_FEATURES ?? ''
  if (mode === 'fail') process.exit(2)
  const off = argv.includes('features.unified_exec_tty=false')
  const tty = mode === 'tty-forced' ? 'true' : off ? 'false' : 'true'
  console.log('unified_exec                             stable             true')
  if (mode !== 'no-line') console.log(`unified_exec_tty                         stable             ${tty}`)
  console.log('unified_exec_zsh_fork                    removed            false')
  process.exit(0)
}
if (argv[0] !== 'exec') process.exit(64)

let stdin = ''
for await (const c of process.stdin) stdin += c
rec({
  argv,
  stdin,
  cwd: process.cwd(),
  env: Object.fromEntries(['CODEX_HOME', 'TMPDIR', 'TMPPREFIX', 'HOME', 'GH_REPO', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES'].map((k) => [k, process.env[k] ?? null])),
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

if (!turn.noRollout && process.env.CODEX_HOME) {
  const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '11', '17')
  const file = join(dir, `rollout-2026-11-17T04-29-58-${threadId}.jsonl`)
  mkdirSync(dir, { recursive: true })
  const lines = []
  if (!existsSync(file)) lines.push({ type: 'session_meta', payload: { id: turn.rolloutId ?? threadId, cli_version: '0.169.0', source: 'exec' } })
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tools.write_stdin({session_id:1,chars:"x"})' }] } })
  let k = 0
  for (const input of turn.codeMode ?? []) lines.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `call_${++k}`, input, status: 'completed' } })
  for (const fc of turn.functionCalls ?? []) lines.push({ type: 'response_item', payload: { type: 'function_call', call_id: `call_${++k}`, ...fc } })
  appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  if (turn.extraRollout) {
    const d2 = join(process.env.CODEX_HOME, 'sessions', '2026', '11', '18')
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, `rollout-2026-11-18T00-00-00-${threadId}.jsonl`), readFileSync(file))
  }
}

if (turn.grandchild) {
  const g = spawn('sleep', ['300'], { stdio: 'ignore' })
  writeFileSync(turn.grandchild, String(g.pid))
}
if (turn.hang) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

if (turn.flood) {
  process.on('SIGTERM', () => {})
  const out = turn.flood.stream === 'stderr' ? process.stderr : process.stdout
  const chunk = Buffer.alloc(1024 * 1024, 'x')
  for (let sent = 0; sent < turn.flood.bytes; sent += chunk.length) {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
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
if (turn.splitUtf8) {
  const line = Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { id: `item_${++n}`, type: 'agent_message', text: msg } })}\n`)
  const cut = line.indexOf(Buffer.from(msg)) + 1 // 先頭の文字の 2 バイト目（UTF-8 の途中）
  process.stdout.write(line.subarray(0, cut))
  await new Promise((r) => setTimeout(r, 100))
  process.stdout.write(line.subarray(cut))
} else {
  ev({ type: 'item.completed', item: { id: `item_${++n}`, type: 'agent_message', text: msg } })
}
if (!turn.noOutputFile) writeFileSync(outPath, msg)
ev({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 } })
process.exit(turn.exitCode ?? 0)

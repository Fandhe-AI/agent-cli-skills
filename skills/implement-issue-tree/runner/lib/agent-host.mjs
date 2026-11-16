// 生成物（implement-issue-tree.js）の `agent(prompt, opts)` を、Codex / OpenCode のアダプタで実装する境界。
//
// 役割: Workflow ランタイムが agent() で担っていたこと（StructuredOutput の強制・隔離 worktree・並列・時間切れ）を、
// ツールに依存しない形でここに集める。アダプタ（runner/adapters/<tool>.mjs）は「完成形のプロンプトを 1 回流して
// 最終テキストを得る」だけを担い、schema 検証・修復・並列制限・worktree 作成はしない
// （契約: _/local-plans/iit-runner-adapter-contract.md の「agent-host の契約」1〜5）。
//
// 返り値の規則（Phase 0-5 の決定。ホストの既存の備え — runStateAgent のモデル切り替え・agentRetryOnce・
// fail-closed — がそのまま働く値にそろえる）:
//   - schema に適合した値か null だけを返す。不適合な値は 1 件もホストへ渡さない（受入基準 4）。undefined は返さない。
//   - null: 修復 1 回の後も不適合・JSON を取り出せない・AdapterError（kind を問わない）・アダプタの想定外の例外・
//     保険の時間切れ・エージェント数の上限超過。
//   - throw: 呼び出し自体の不備（schema が対応範囲外・label が文字列でない・未知の model / effort / isolation）と、
//     隔離 worktree の作成失敗だけ。どれも副作用（worktree・プロセス）を起こす前に投げる。
//
// 実行仕様（Phase P6）: プロンプトの 0 行目が `<!-- iit-exec v1 {json} -->` なら、モデルを介さずに
// `bash <skillDir>/scripts/run-verified.sh <sha256> <script> ...argv` を shell なしで起動して結果を返す
// （仕様の正本は references/script-trust-model.md の「機械的な段の実行仕様」）。label ごとの許可表
// （EXEC_RULES）に合わない仕様は実行せず失敗値を返す。封筒の照合（nonce・sha256・入力の束縛）は従来どおり
// ホストが行い、ここは標準出力の最終行を解釈せずに返すだけである。
//
// ログ: cfg.runDir があれば、呼び出しごとに <runDir>/agents/<seq 4 桁>-<label>/ へ meta.json（通し確認の判定器が読む。
// 形は run.mjs 冒頭の「出力の形」）・request.json・prompt.txt（モデルへ回した段）・exec.json / stdout.txt / stderr.txt
// （直接実行した段）を書く。アダプタ自身のログ（stderr・JSONL・最終テキスト）は req.logDir の同じ場所に置かれる。
//
// 呼び出し元: runner/run.mjs（生成物の agent 引数に渡す）と dev/implement-issue-tree/tests/runner-*.test.mjs。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isAdapterError } from './adapter-error.mjs'
import { extractJsonObject } from './extract-json.mjs'
import { resolveModel, resolveTimeoutMs } from './models.mjs'
import { buildRepairPrompt, composePrompt } from './preamble.mjs'
import { assertSupportedSchema, sanitizeErrorLine, validate } from './schema-validate.mjs'
import { createSequencer, createWorktree, verifyWorktreeGitdir } from './worktree.mjs'

// ---- 実行仕様 ----

const SPEC_PREFIX = '<!-- iit-exec v1 '
const SPEC_SUFFIX = ' -->'
// src の guardExecSpecPrompt と同じ判定（先頭の空白・BOM・大小文字の揺れを含む）。これに当たるのに厳密な形で
// 読めない 0 行目は、偽物か壊れた仕様なので実行しない
const SPEC_LEAD_RE = /^[\s﻿]*<!--\s*iit-exec/i
const SPEC_KEYS = new Set(['v', 'script', 'sha256', 'argv', 'ret', 'stdinHex', 'fail'])
const RETS = Object.freeze(['envelope', 'exit-ok', 'line:STATE_RESULT', 'line:WORKTREE_REMOVE_RESULT'])
// 失敗値。src の EXEC_FAIL_BY_RET・EXEC_FAIL_SWEEP と同じ（仕様に fail が無い版の src でも同じ値を返すため、ここにも持つ）
const FAIL_WORKTREE = Object.freeze({ ok: false, retained: true, worktree: '' })
const FAIL_SWEEP = Object.freeze({ removed: [] })
const FAIL_BY_RET = Object.freeze({ envelope: null, 'exit-ok': { ok: false }, 'line:STATE_RESULT': { ok: false }, 'line:WORKTREE_REMOVE_RESULT': FAIL_WORKTREE })
const MAX_ARGV = 256
const MAX_ARG_BYTES = 64 * 1024
const MAX_STDIN_BYTES = 4 * 1024 * 1024
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024

// mode の取り出し方はスクリプトごとに違う（argv の形は src の execSpecLine の呼び出し側が決める）
const STATE_VALUE_OPTS = new Set(['--file', '--bytes', '--version', '--nonce', '--page'])
function stateMode(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (STATE_VALUE_OPTS.has(argv[i])) { i++; continue }
    return argv[i].startsWith('-') ? null : argv[i]
  }
  return null
}
function optionMode(argv) {
  const at = argv.indexOf('--mode')
  if (at < 0 || argv.indexOf('--mode', at + 1) >= 0 || at + 1 >= argv.length) return null
  return argv[at + 1]
}
const firstWord = (argv) => (argv.length > 0 ? argv[0] : null)
const noMode = () => null
const MODE_OF = Object.freeze({
  'state.sh': stateMode,
  'worktree-remove.sh': firstWord,
  'fetch-tree.sh': firstWord,
  'run-verified.sh': firstWord,
  'recover-prep.sh': optionMode,
  'repo-scan.sh': optionMode,
  'observe-pr.sh': optionMode,
  'measure-residual-bytes.sh': noMode,
  'measure-free-disk.sh': noMode,
})

// label の接尾辞（ホストの再試行・モデル切り替えが付ける）。runStateAgent は `:fallback-<model>`、
// agentRetryOnce は `:retry`、skip-labels などは `-retry` を足す
const SUFFIX = '(?::fallback-[a-z0-9]+|:retry|-retry)*'
const rule = (head, script, modes, ret, fail) => Object.freeze({ re: new RegExp(`^${head}${SUFFIX}$`), script, modes, ret, fail })

/**
 * label ごとの許可表（上から最初に label が一致した行だけで判定する。一致した行の script・mode・ret・fail の
 * どれかが仕様と合わなければ実行しない）。対象の段は script-trust-model.md の「対象の段」と P6 src の
 * execSpecLine の呼び出し箇所から作った。表に無い label の仕様は実行しない（fail-closed）。
 */
export const EXEC_RULES = Object.freeze([
  rule('state:cleanup:#\\d+', 'worktree-remove.sh', ['remove'], 'line:WORKTREE_REMOVE_RESULT', FAIL_WORKTREE),
  rule('state:load-verify(?::p\\d+)?', 'state.sh', ['verify'], 'envelope', null),
  rule('state:(?:update:#\\d+|update-batch:\\d+|high-water|high-water-set|init-all)', 'state.sh', ['merge', 'init', 'hw-max', 'hw-set'], 'line:STATE_RESULT', FAIL_BY_RET['line:STATE_RESULT']),
  rule('script-hash-precheck', 'run-verified.sh', ['--verify-only'], 'envelope', null),
  rule('plan:issue-tree-release', 'fetch-tree.sh', ['--release'], 'exit-ok', FAIL_BY_RET['exit-ok']),
  rule('free:#\\d+', 'recover-prep.sh', ['free'], 'exit-ok', FAIL_BY_RET['exit-ok']),
  rule('worktree:absent:#\\d+', 'worktree-remove.sh', ['check-absent'], 'line:WORKTREE_REMOVE_RESULT', FAIL_WORKTREE),
  rule('worktree:sweep', 'worktree-remove.sh', ['sweep'], 'line:WORKTREE_REMOVE_RESULT', FAIL_SWEEP),
  rule('worktree:residual-bytes', 'measure-residual-bytes.sh', [null], 'envelope', null),
  rule('worktree:free-disk-bytes', 'measure-free-disk.sh', [null], 'envelope', null),
  rule('detect:external-checks', 'repo-scan.sh', ['external-checks'], 'envelope', null),
  rule('plan:skip-labels', 'repo-scan.sh', ['skip-labels'], 'envelope', null),
  rule('merge:added-files(?::#\\d+)?', 'observe-pr.sh', ['added-files'], 'envelope', null),
  rule('merge:policy-paths(?::#\\d+)?', 'observe-pr.sh', ['policy-paths'], 'envelope', null),
  // opt-in テスト記録ゲートは observeGate の extra.label でこの名前になる（src の observeOptinRecord）。observeGate の
  // 既定の label（merge:optin-record:#N）は使われないため表に置かない（runner-exec-rules.test.mjs が全行の到達を縛る）
  rule('optin-record-(?:verify|reverify):#\\d+', 'observe-pr.sh', ['optin-record'], 'envelope', null),
])

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

/**
 * プロンプトの 0 行目から実行仕様を読む。
 * @returns {{ kind: 'none' } | { kind: 'bad', reason: string } | { kind: 'spec', spec: object }}
 *   none = 仕様ではない（モデルへ回す）/ bad = 仕様の形をしているのに厳密には読めない（実行しない）/ spec = 読めた
 */
export function parseExecSpec(prompt) {
  if (typeof prompt !== 'string') return { kind: 'none' }
  const nl = prompt.indexOf('\n')
  const line0 = nl < 0 ? prompt : prompt.slice(0, nl)
  if (!SPEC_LEAD_RE.test(line0)) return { kind: 'none' }
  const bad = (reason) => ({ kind: 'bad', reason })
  if (!line0.startsWith(SPEC_PREFIX) || !line0.endsWith(SPEC_SUFFIX)) return bad('0 行目の区切りが規定の形でない')
  let spec
  try {
    spec = JSON.parse(line0.slice(SPEC_PREFIX.length, -SPEC_SUFFIX.length))
  } catch {
    return bad('0 行目の JSON を読めない')
  }
  if (!isPlainObject(spec)) return bad('仕様がオブジェクトでない')
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) return bad(`未知のキー ${k.slice(0, 40)}`)
  if (spec.v !== 1) return bad('v が 1 でない')
  if (typeof spec.script !== 'string' || !Object.hasOwn(MODE_OF, spec.script)) return bad('script が許可リストに無い')
  if (spec.script === 'run-verified.sh') {
    if ('sha256' in spec) return bad('run-verified.sh の仕様に sha256 がある')
  } else if (typeof spec.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(spec.sha256)) {
    return bad('sha256 が 64 桁の小文字 16 進でない')
  }
  if (!Array.isArray(spec.argv) || spec.argv.length > MAX_ARGV) return bad('argv が配列でない・多すぎる')
  let argBytes = 0
  for (const a of spec.argv) {
    if (typeof a !== 'string' || a.includes('\0')) return bad('argv に文字列以外・NUL がある')
    argBytes += Buffer.byteLength(a)
  }
  if (argBytes > MAX_ARG_BYTES) return bad('argv が長すぎる')
  if (!RETS.includes(spec.ret)) return bad('ret が未知')
  if ('stdinHex' in spec && (typeof spec.stdinHex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(spec.stdinHex) || spec.stdinHex.length > MAX_STDIN_BYTES * 2)) {
    return bad('stdinHex が小文字 16 進の偶数長でない・長すぎる')
  }
  return { kind: 'spec', spec }
}

/**
 * 仕様を label の許可表に照らす。fail は表の値を正とする（仕様に fail が無い版の src でも同じ値を返す）。
 * @returns {{ ok: true, rule: object } | { ok: false, reason: string, fail: any }}
 */
export function checkExecRule(label, spec) {
  const r = EXEC_RULES.find((x) => x.re.test(label))
  // 表に無い label: 失敗値は仕様の fail を使い、無ければ ret の既定（sweep は ret だけでは決まらないので argv で見る）
  if (!r) {
    const fallback = 'fail' in spec ? spec.fail : spec.script === 'worktree-remove.sh' && spec.argv[0] === 'sweep' ? FAIL_SWEEP : FAIL_BY_RET[spec.ret] ?? null
    return { ok: false, reason: 'label が許可表に無い', fail: fallback }
  }
  const no = (reason) => ({ ok: false, reason, fail: r.fail })
  if (spec.script !== r.script) return no(`script が label の許可と違う（${r.script} のみ）`)
  if (!r.modes.includes(MODE_OF[spec.script](spec.argv))) return no('mode が label の許可と違う')
  if (spec.ret !== r.ret) return no('ret が label の許可と違う')
  if ('fail' in spec && !isDeepStrictEqual(spec.fail, r.fail)) return no('fail が label の失敗値と違う')
  return { ok: true, rule: r }
}

/**
 * スクリプトを shell なしで起動する既定の実装。detached でプロセスグループを作り、時間切れ・出力超過では
 * グループごと止める（gh などの孫プロセスを残さない）。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, overflow: boolean, error?: string }>}
 */
export function spawnScript(file, args, { cwd, input, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, overflow: false, error: String(e?.message ?? e) })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let overflow = false
    let settled = false
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 既に終了 */ } }
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, timeoutMs)
    child.stdout.on('data', (b) => {
      outBytes += b.length
      if (outBytes > MAX_STDOUT_BYTES) { overflow = true; killGroup(); return }
      out.push(b)
    })
    child.stderr.on('data', (b) => {
      if (errBytes < MAX_STDERR_BYTES) err.push(b.subarray(0, MAX_STDERR_BYTES - errBytes))
      errBytes += b.length
    })
    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, overflow, ...(error ? { error } : {}) })
    }
    child.on('error', (e) => finish(null, String(e?.message ?? e)))
    child.on('close', (code) => finish(code))
    // 標準入力を読まないスクリプトが先に閉じても落ちないようにする
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** 標準出力の最終行（末尾の改行を除いた最後の行）。 */
function lastLine(stdout) {
  const lines = stdout.replace(/\n+$/, '').split('\n')
  return lines[lines.length - 1]
}
function parseObjectLine(text) {
  try {
    const v = JSON.parse(text)
    return isPlainObject(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 終了コードと標準出力から ret に従って値を作る。非 0 終了・結果の行なし・封筒なしは undefined（呼び出し側が失敗値にする）。
 * 非 0 終了なら標準出力は見ない（結果らしい行があっても読まない）。
 */
export function interpretExecResult(ret, { code, stdout, timedOut, overflow, error }) {
  if (code !== 0 || timedOut || overflow || error) return undefined
  if (ret === 'exit-ok') return { ok: true }
  const line = lastLine(stdout)
  if (ret === 'envelope') return parseObjectLine(line)
  const word = ret.slice('line:'.length)
  if (!line.startsWith(`${word} `)) return undefined
  return parseObjectLine(line.slice(word.length + 1))
}

// ---- 共通 ----

function createLimiter(max) {
  let active = 0
  let maxActive = 0
  const queue = []
  const release = () => {
    active--
    const next = queue.shift()
    if (next) next()
  }
  return {
    async acquire() {
      if (active >= max) await new Promise((r) => queue.push(r))
      active++
      if (active > maxActive) maxActive = active
      return release
    },
    get active() { return active },
    get maxActive() { return maxActive },
  }
}

const safeLabel = (label) => label.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || '_'

/**
 * @param {{ adapter: { name: string, run: Function }, cfg: {
 *   config: object,            // models.mjs の validateConfig を通したランナー設定
 *   skillDir: string,          // 実行仕様の run-verified.sh の置き場（<skillDir>/scripts/）
 *   mainRoot: string,          // メイン worktree（実行仕様の cwd・隔離 worktree の親）
 *   runId: string,             // wf_<16 進 8>-<16 進 3>
 *   runDir?: string,           // _/iit-runner/<runId>。無ければエージェント別のログを書かない
 *   args?: object,             // 生成物に渡す args（autoMerge を読む）
 *   maxParallel?: number,      // --max-parallel。無ければ config.limits.maxParallel
 *   log?: (msg: string) => void,
 *   timeoutGraceMs?: number,   // アダプタが時間切れで止まらなかったときの保険の猶予（既定 30 秒）
 *   createWorktree?: Function, // テスト用の差し替え（既定は worktree.mjs の実物）
 *   spawnScript?: Function,    // テスト用の差し替え（既定は spawnScript）
 * } }} p
 * @returns {(prompt: string, opts: object) => Promise<object|null>} stats（calls・active・maxActive・adapterCalls）を持つ
 */
export function createAgentHost({ adapter, cfg }) {
  if (!adapter || typeof adapter.run !== 'function') throw new TypeError('adapter.run が無い')
  const { config, skillDir, mainRoot, runId, runDir } = cfg
  if (typeof skillDir !== 'string' || !isAbsolute(skillDir)) throw new TypeError('cfg.skillDir は絶対パス')
  if (typeof mainRoot !== 'string' || !isAbsolute(mainRoot)) throw new TypeError('cfg.mainRoot は絶対パス')
  const tool = adapter.name
  const log = typeof cfg.log === 'function' ? cfg.log : () => {}
  const maxParallel = cfg.maxParallel ?? config.limits.maxParallel
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new TypeError('maxParallel は正の整数')
  const repairAttempts = config.limits.repairAttempts
  const maxAgents = config.limits.maxAgents
  const graceMs = cfg.timeoutGraceMs ?? 30_000
  const makeWorktree = cfg.createWorktree ?? createWorktree
  const runScript = cfg.spawnScript ?? spawnScript
  const autoMerge = cfg.args?.autoMerge === true
  const seq = createSequencer()
  const limiter = createLimiter(maxParallel)
  let adapterCalls = 0

  // エージェント別のログ。書けなくても本処理は止めない（ログはラン後の調査用）
  const writeLog = (dir, name, data) => {
    if (!dir) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`)
    } catch (e) {
      log(`⚠️ ランナー: ログを書けない（${name}）: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  async function runDirect(spec, label, schema, prompt, logDir, timeoutMs, rec) {
    // 直接実行の段は会話が無い（sessionRef は null のまま）。成否は status に残す
    rec.outcome = 'exec-spec'
    const checked = checkExecRule(label, spec)
    if (!checked.ok) {
      log(`⚠️ ${label}: 実行仕様が許可表と合わないため実行しない（${checked.reason}）`)
      Object.assign(rec, { status: 'exec-refused', reason: checked.reason })
      return structuredClone(checked.fail)
    }
    const fail = () => structuredClone(checked.rule.fail)
    const launcher = join(skillDir, 'scripts', 'run-verified.sh')
    const args = spec.script === 'run-verified.sh' ? [launcher, ...spec.argv] : [launcher, spec.sha256, spec.script, ...spec.argv]
    const input = spec.stdinHex === undefined ? Buffer.alloc(0) : Buffer.from(spec.stdinHex, 'hex')
    writeLog(logDir, 'exec.json', { script: spec.script, argv: spec.argv, ret: spec.ret, stdinBytes: input.length, cwd: mainRoot })
    const started = Date.now()
    const r = await runScript('bash', args, { cwd: mainRoot, input, timeoutMs }, { label, prompt, spec })
    writeLog(logDir, 'stdout.txt', r.stdout ?? '')
    writeLog(logDir, 'stderr.txt', r.stderr ?? '')
    const value = interpretExecResult(spec.ret, r)
    const base = { code: r.code, timedOut: r.timedOut, overflow: r.overflow, durationMs: Date.now() - started }
    if (value === undefined) {
      log(`⚠️ ${label}: スクリプトの直接実行が失敗した（終了コード ${r.code}${r.timedOut ? '・時間切れ' : ''}${r.overflow ? '・出力超過' : ''}${r.error ? '・起動失敗' : ''}）`)
      Object.assign(rec, { status: 'exec-fail', ...base })
      return fail()
    }
    const v = validate(schema, value)
    if (!v.ok) {
      log(`⚠️ ${label}: スクリプトの出力が schema に適合しないため失敗値を返す`)
      Object.assign(rec, { status: 'exec-invalid', errors: v.errors, ...base })
      return fail()
    }
    Object.assign(rec, { status: 'exec-ok', ...base })
    return value
  }

  // アダプタ 1 回分。保険の時間切れ（timeoutMs + 猶予）を過ぎたら待つのをやめる（アダプタの停止責務の取りこぼし対策）
  async function callAdapter(req) {
    adapterCalls++
    let timer
    const watchdog = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ watchdog: true }), req.timeoutMs + graceMs)
    })
    try {
      return await Promise.race([adapter.run(req).then((value) => ({ value }), (error) => ({ error })), watchdog])
    } finally {
      clearTimeout(timer)
    }
  }

  // 応答テキストを取り出し・検証する。適合なら { ok: true, value }、不適合なら { ok: false, errors }
  function check(schema, text) {
    const obj = typeof text === 'string' ? extractJsonObject(text) : undefined
    if (obj === undefined) return { ok: false, errors: [] }
    const v = validate(schema, obj)
    return v.ok ? { ok: true, value: obj } : { ok: false, errors: v.errors }
  }

  async function runModel({ prompt, opts, label, schema, n, logDir, timeoutMs, rec }) {
    const resolved = resolveModel(config, tool, { model: opts.model, effort: opts.effort })
    let cwd = mainRoot
    let worktreePath
    // 隔離 worktree の git ディレクトリ（契約の req.worktreeGitdir。HIGH-2）。作成直後に検証した値だけを渡し、
    // アダプタは worktree の .git ファイルを読まない。修復ターン（resume）も同じ req から作るので読み直さない。
    // 作成関数が gitdir を返さない（テストの差し替え）ときは null（アダプタは git の書き込みを足さない）
    let worktreeGitdir = null
    if (opts.isolation === 'worktree') {
      // 失敗は例外のまま上げる（契約で throw してよい 2 つのうちの 1 つ。gitdir の検証失敗も作成失敗として扱う）
      const wt = makeWorktree({ mainRoot, runId, n })
      cwd = wt.path
      worktreePath = wt.path
      if (wt.gitdir !== undefined) worktreeGitdir = verifyWorktreeGitdir(mainRoot, wt.gitdir)
    }
    const req = {
      prompt: composePrompt({ prompt, schema, worktreePath }),
      schema,
      model: resolved.model,
      // OpenCode は推論の強さを variant で表す（models.mjs の表）。契約の req に variant の欄が無いため effort に入れる
      effort: tool === 'opencode' ? resolved.variant : resolved.effort,
      cwd,
      label,
      allowMerge: autoMerge && /^merge-exec(?::|$)/.test(label),
      timeoutMs,
      resume: null,
      logDir: logDir ?? '',
      worktreeGitdir,
    }
    writeLog(logDir, 'request.json', { seq: n, label, phase: opts.phase ?? null, iitModel: resolved.name, model: req.model, effort: req.effort, cwd, allowMerge: req.allowMerge, timeoutMs, worktree: worktreePath ?? null, worktreeGitdir })
    writeLog(logDir, 'prompt.txt', req.prompt)
    // meta.json の outcome は ok / null の 2 値、詳細（修復の有無・失敗の理由）は status・reason に置く
    const outcome = (status, extra = {}) => Object.assign(rec, { outcome: status === 'ok' || status === 'repaired' ? 'ok' : 'null', status, sessionRef }, extra)

    let sessionRef = null
    let errors = []
    for (let turn = 0; turn <= repairAttempts; turn++) {
      const r = await callAdapter(turn === 0 ? req : { ...req, resume: { sessionRef, message: buildRepairPrompt(errors) } })
      if (r.watchdog) {
        log(`⚠️ ${label}: アダプタが時間切れ（${timeoutMs} ms + 猶予）を過ぎても戻らないため未返却として扱う`)
        outcome('null', { reason: 'watchdog' })
        return null
      }
      if (r.error !== undefined) {
        const kind = isAdapterError(r.error) ? r.error.kind : 'unexpected'
        log(`⚠️ ${label}: アダプタが失敗した（${kind}）: ${sanitizeErrorLine(r.error?.message ?? r.error)}`)
        outcome('null', { reason: kind, ...(isAdapterError(r.error) ? { kind } : {}), sessionRef: r.error?.sessionRef ?? sessionRef })
        return null
      }
      sessionRef = typeof r.value?.sessionRef === 'string' ? r.value.sessionRef : sessionRef
      const c = check(schema, r.value?.text)
      if (c.ok) {
        outcome(turn === 0 ? 'ok' : 'repaired', { usage: r.value?.usage ?? null })
        return c.value
      }
      errors = c.errors
      // 修復ターンは同じ会話へ追記する。会話の参照が無ければ続けられない
      if (sessionRef === null) break
    }
    log(`⚠️ ${label}: 応答が schema に適合しない（修復 ${repairAttempts} 回後）ため未返却として扱う`)
    outcome('null', { reason: 'schema', errors })
    return null
  }

  async function agent(prompt, opts) {
    // 通し番号は待ちに入る前に採る（呼び出し順 = 番号。隔離しない呼び出し・直接実行の段も数える）
    const n = seq.next()
    if (!isPlainObject(opts) || typeof opts.label !== 'string' || opts.label === '') throw new TypeError('agent(): opts.label は空でない文字列')
    const { label, schema } = opts
    const logDir = runDir ? join(runDir, 'agents', `${String(n).padStart(4, '0')}-${safeLabel(label)}`) : null
    // meta.json（通し確認の判定器が読む）。outcome は ok / null / exec-spec / throw
    const rec = { label, seq: n, sessionRef: null, outcome: null, startedAt: new Date().toISOString() }
    try {
      if (typeof prompt !== 'string') throw new TypeError('agent(): prompt は文字列')
      // schema 自体の不備は例外（契約で throw してよい 2 つのうちの 1 つ）
      assertSupportedSchema(schema)
      if (opts.isolation !== undefined && opts.isolation !== 'worktree') throw new TypeError(`agent(): 未知の isolation: ${String(opts.isolation).slice(0, 40)}`)
      // 未知の model / effort は副作用の前に例外にする（黙って別のモデルへ倒さない。models.mjs の方針）
      resolveModel(config, tool, { model: opts.model, effort: opts.effort })
      const timeoutMs = resolveTimeoutMs(config, { phase: opts.phase })
      if (n > maxAgents) {
        log(`⚠️ ${label}: エージェント数の上限（${maxAgents}）を超えたため起動しない`)
        Object.assign(rec, { outcome: 'null', reason: 'max-agents' })
        return null
      }
      const parsed = parseExecSpec(prompt)
      const release = await limiter.acquire()
      try {
        if (parsed.kind === 'bad') {
          log(`⚠️ ${label}: 0 行目が実行仕様の形をしているが読めないため実行しない（${parsed.reason}）`)
          Object.assign(rec, { outcome: 'null', status: 'exec-refused', reason: parsed.reason })
          return null
        }
        if (parsed.kind === 'spec') return await runDirect(parsed.spec, label, schema, prompt, logDir, timeoutMs, rec)
        return await runModel({ prompt, opts, label, schema, n, logDir, timeoutMs, rec })
      } finally {
        release()
      }
    } catch (e) {
      Object.assign(rec, { outcome: 'throw', error: sanitizeErrorLine(e?.message ?? e) })
      throw e
    } finally {
      rec.endedAt = new Date().toISOString()
      writeLog(logDir, 'meta.json', rec)
    }
  }

  Object.defineProperty(agent, 'stats', {
    get: () => ({ calls: seq.count, active: limiter.active, maxActive: limiter.maxActive, adapterCalls }),
  })
  return agent
}

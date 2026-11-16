// iit ランナー専用の OpenCode plugin: shell 実行許可（permission.evaluate）で共通ガード agent-guard.sh を呼ぶ。
// Codex 側の codex-hook.sh と同じ意味にそろえてある。ログの形式（`<epoch 秒>\t<コード>`）・共通のコード（allow・
// allow-mergeform・deny-guard-missing・deny-error・deny-noresult・deny:<理由>）・拒否の文言も codex-hook.sh と同じ
// （runner-guard-parity.test.mjs が縛る）。plugin だけのコードは deny-bad-event・deny-protected-edit・deny-budget。
//
// 配布物の plugin（init-opencode）との違い: ランナーのセッションは親を持たない top-level になり、配布物の plugin は
// それを main とみなしてマージ・承認を制限しない。そのためここでは agent-guard.sh を「常に subagent=true」で呼ぶ。
//
// 設定は config の plugins のオブジェクト形（{ package, options }）で渡る（ctx.options）。エージェントのシェルからは変えられない。
//   guardScript  agent-guard.sh の絶対パス（必須）
//   log          呼び出しごとに 1 行を追記するログ（必須。コマンド文字列は書かない）
//   mergeRes     配列。allowMerge の serve だけに渡される正規表現（source）。1 つでも一致したコマンドは素通し
//                （merge-exec の完全一致の 1 形。正本は runner/lib/guard.mjs の MERGE_EXEC_COMMAND）。下の「merge-exec の対応づけ」も参照
//   markerPath   読み込まれた目印を書くファイル。setup のたびに `{"nonce","directory"}` を 1 行（JSONL）追記する。
//                plugin は location ごとに読み込まれるため、アダプタは start と、各セッションの location（worktree）で確かめる
//   nonce        serve ごとの乱数
//   callLog      shell の呼び出しを受けるたびに sessionID を 1 行追記するファイル（省略可）。アダプタが終了時に、
//                セッションの shell の実行件数と突き合わせる（ガードを通っていない実行の検知。監査 e670648 の MEDIUM-7）
//   protectedPaths  配列。書き込みを拒否する絶対パス（完全一致と配下）。アダプタが ~/.config/opencode・ランのログと目印を渡す。
//                guardScript と plugin 自身の置き場は options に無くても常に保護する（下の「保護」）
//
// 全文の判定（監査 e670648 の MEDIUM-6。全 serve）:
//   permission.evaluate の resource は OpenCode のスキャナが分解した後の形で、代入・export・cd だけのコマンドでは
//   permission.evaluate 自体が来ない（v2.2.7 の実測: `A=1`・`export B=2`・`cd .` は発火せず、`X=$(echo hi)` は `echo hi`
//   だけが届く）。`export HUSKY=0; git commit -m x` は全文ならガードが no-verify で止めるが、resource の `git commit -m x`
//   だけでは通る。そこで tool.execute.before に届く input.command の全文を、Codex の hook と同じくガードに通し、deny なら
//   throw で呼び出しを拒否する（throw した呼び出しは実行されない。実測）。permission.evaluate の resource ごとの判定も残す
//   （shell.create.before で書き換わった後の実際に走る形を見る）。shell で resource が 0 件の permission.evaluate は拒否する。
//   順序: (1) merge 用 serve で全文が mergeRes に完全一致したら、ガードを呼ばずに対応づけの記録だけをする（下記。
//   全文をガードに通すと merge-guard で拒否されるため）。(2) 保護パスへの書き込み（下の「保護」）は拒否。(3) 全文をガードへ。
//   ctx.tool.hook が無い版では全文を判定できないので、目印を書かない（アダプタが prereq で止める。fail-closed）。
//
// merge-exec の対応づけ（mergeRes が空でない serve だけ）:
//   OpenCode v2.2.7 の permission.evaluate に届く resource は、shell の代入（`HEAD_SHA="…";`）を落とした後半
//   （`gh pr merge N --squash --delete-branch --match-head-commit "$HEAD_SHA"`）の 1 件だけで、全文はどこにも無い
//   （2026-11-17 の実測。イベントのキーは sessionID・agent・action・resources・metadata・source・effect）。
//   全文は tool.execute.before の input.command に届き、その id・messageID は permission の source.id・source.messageID と同じ値
//   （同日の実測。hook の順は tool.execute.before → shell.create.before → permission.evaluate）。そこで:
//   1. tool.execute.before で、tool が shell かつ input.command が mergeRes に完全一致した呼び出しだけを
//      sessionID・messageID・id の組で記録する。値はその全文の `; ` より後ろ（後半）。一致しない呼び出しは同じ組の記録を消す。
//   2. permission.evaluate は、source の組が記録と一致し、resources がちょうど 1 件で記録した後半と文字列として等しいときだけ
//      allow-mergeform で通し、記録をその場で消す（1 回限り）。それ以外はこれまでどおりガードに回す。
//   後半だけの形は、対応する記録が無ければ単独では決して通さない（ガードが merge-guard で拒否する）。
//   resource は shell.create.before の書き換え後のコマンドから作られる（実測）ため、後半の完全一致が「記録した全文と実際に走る
//   コマンドが同じ」ことの確かめになる。限界: 代入の部分は resource に出ないので、同じ serve に読み込まれた別の plugin が
//   代入だけを書き換えても検知できない（エージェントからは届かない範囲）。
//
// 保護（監査 e670648 の MEDIUM-3）: ガードは呼び出しのたびに agent-guard.sh と plugin を読み直すため、エージェントがそれらを
// 書き換えると以後の判定が全部 allow になる。次への書き込みを、edit 系 action（edit・write・patch。resource はパス）と shell の
// 両方で拒否する。
//   - 配布物の plugin（init-opencode）と同じ PROTECTED_EDIT（`.opencode/(hooks|plugins?)/`・`opencode.json(c)`）
//   - guardScript と plugin 自身の置き場の realpath、自分のログ（log）と目印（markerPath）、options.protectedPaths（完全一致と配下）
//   edit の resource は location 内なら location からの相対、外なら正規化済みの絶対パスで届く（v2.2.7 の実測）ため、
//   相対は ctx.location.directory を起点に解決する。shell はコマンド文字列に保護パスが現れ、かつ読み取りだけの形
//   （READ_ONLY_COMMANDS の語だけで、出力のリダイレクトが無い）でないときに拒否する。文字列照合なので、変数・間接参照・
//   別名のパスでは抜ける（best-effort。README の既知の限界）。
// fail-closed: 設定の不備・ガードが無い・起動できない・時間切れ・異常終了・結果行なし・契約外の出力はすべて deny。
// ガードとの契約は agent-guard.sh 冒頭が正典: stdin {"command", "subagent"}、stdout 最終行 `AGENT_GUARD_RESULT allow|deny <理由>`。
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_TIMEOUT_MS = 5000
const TOTAL_BLOCK_BUDGET_MS = 10000
const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? 'bash'
const RESULT_LINE = /^AGENT_GUARD_RESULT (allow|deny(?: ([a-z-]+))?)$/

// resources がコマンドでないと分かっている組み込み action。これ以外（名前が変わった shell・MCP・plugin 定義）は
// resources をコマンドとしてガードへ渡す（配布物の plugin と同じ扱い）。
const NON_SHELL_ACTIONS = new Set([
  'read', 'glob', 'grep', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory',
  'browser', 'experimental_image_generate', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource',
])

const deny = (event, message) => { event.effect = 'deny'; event.message = message }
const MSG_PROTECTED = 'iit-runner: ガード本体・plugin・設定ファイル・ランのログは編集できない'

// 配布物の plugin（init-opencode の agent-guard/index.js）の PROTECTED_EDIT と同じ正規表現（照合前の正規化も同じ）
const PROTECTED_EDIT = [/(^|\/)\.opencode\/(hooks|plugins?)\//, /(^|\/)opencode\.jsonc?$/]
// shell のコマンド文字列に現れたら保護パスへの言及とみなす形（PROTECTED_EDIT の shell 版。~/.config/opencode も含む）
const PROTECTED_IN_SHELL = [/\.opencode\/(hooks|plugins?)(\/|\b)/, /opencode\.jsonc?\b/, /\.config\/opencode(\/|\b)/]
const PLUGIN_SELF = (() => { const d = dirname(fileURLToPath(import.meta.url)); try { return realpathSync(d) } catch { return d } })()

/** 互換文字の正規化・大文字小文字の畳み込み・区切りの統一（配布物の plugin の isProtectedEdit と同じ）。 */
const fold = (s) => s.normalize('NFKC').toUpperCase().toLowerCase().replaceAll('\\', '/')
const realOr = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }

/** 保護する絶対パスの一覧（畳み込み済み）。guardScript・plugin 自身・自分のログと目印は常に含める。 */
function protectedRoots(opts) {
  const list = [opts.guardScript, PLUGIN_SELF, opts.log, ...[opts.markerPath, opts.callLog].filter((x) => typeof x === 'string' && x !== ''), ...opts.protectedPaths]
  return [...new Set(list.flatMap((p) => [resolve(p), realOr(p)]).map(fold))]
}

const under = (p, roots) => roots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`))

/** edit 系の resource（パス）が保護対象か。相対は location を起点に解決する。 */
function isProtectedPath(resource, roots, baseDir) {
  const rel = posix.normalize(fold(resource))
  if (PROTECTED_EDIT.some((re) => re.test(rel))) return true
  const abs = isAbsolute(resource) ? resource : baseDir ? resolve(baseDir, resource) : null
  if (abs === null) return false
  return under(fold(resolve(abs)), roots) || under(fold(realOr(abs)), roots)
}

// 保護パスに触れても通す読み取りだけのコマンド（先頭の語）。sed は -i 系の無いとき、find は書き込み系の述語が無いとき、
// git は作業ツリーのファイルを書き換えないサブコマンド（読み取りと add・commit）のときだけ通す（下の readOnlySegment）。
const READ_ONLY_COMMANDS = new Set([
  'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'stat', 'file', 'diff', 'cmp',
  'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum', 'readlink', 'realpath', 'basename', 'dirname', 'test', '[', '[[',
  'echo', 'printf', 'true', 'false', 'jq', 'cd', 'pwd', 'du', 'od', 'xxd', 'hexdump', 'strings', 'cut', 'tr', 'nl',
])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'cat-file', 'rev-parse', 'grep', 'add', 'commit'])
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time'])
const SHELL_CLOSERS = new Set(['fi', 'done', 'esac', '}', ''])

function readOnlySegment(seg) {
  const words = seg.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ''))
  while (words.length > 0 && (SHELL_KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift()
  if (words.length === 0 || (words.length === 1 && SHELL_CLOSERS.has(words[0]))) return true
  const cmd = words[0].split('/').pop()
  if (cmd === 'sed') return !words.some((w) => /^-[a-z]*i|^--in-place/.test(w))
  if (cmd === 'find') return !words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w))
  if (cmd === 'git') return GIT_READ.has(words.slice(1).find((w) => !w.startsWith('-')) ?? '')
  return READ_ONLY_COMMANDS.has(cmd)
}

/** shell のコマンド文字列が保護パスへ書き込み得るか。保護パスに触れない文字列は false（ガードに任せる）。 */
function shellTouchesProtected(command, roots, baseDir) {
  const f = fold(command)
  const mentions = PROTECTED_IN_SHELL.some((re) => re.test(f)) || roots.some((r) => {
    if (f.includes(r)) return true
    const rel = baseDir ? relative(fold(baseDir), r) : ''
    return rel !== '' && rel !== '.' && f.includes(rel)
  })
  if (!mentions) return false
  // 出力のリダイレクト（fd の複製と /dev/null 行きを除く）があれば書き込みとみなす
  const stripped = f.replace(/\d*>&\d*-?/g, ' ').replace(/&?\d*>>?\s*\/dev\/null\b/g, ' ')
  if (/>/.test(stripped)) return true
  return !stripped.split(/\$\(|[;&|\n()`]/).every(readOnlySegment)
}

// merge-exec の記録の期限と件数の上限（ふつうは同じ呼び出しの permission.evaluate で直ちに使われて消える）
const MERGE_BIND_TTL_MS = 120000
const MERGE_BIND_MAX = 64

/** sessionID・messageID・id の組をキーにする。どれかが文字列でなければ null（記録しない・照合しない）。 */
const bindKey = (sessionID, messageID, id) => ([sessionID, messageID, id].every((v) => typeof v === 'string' && v !== '') ? `${sessionID}\u0000${messageID}\u0000${id}` : null)

/** mergeRes に完全一致した shell の呼び出しを記録する（同じ組の古い記録は呼び出し側で消してある）。 */
function recordMergeCall(binds, key, command) {
  const i = command.indexOf('; ')
  if (!key || i < 0) return
  const now = Date.now()
  for (const [k, v] of binds) if (v.at + MERGE_BIND_TTL_MS < now) binds.delete(k)
  while (binds.size >= MERGE_BIND_MAX) binds.delete(binds.keys().next().value)
  binds.set(key, { tail: command.slice(i + 2), at: now })
}

/** permission.evaluate: 記録した呼び出しの後半がそのまま 1 件で届いたときだけ true。使った記録は消す。 */
function takeMergeBind(binds, event) {
  const src = event.source
  if (!src || src.type !== 'tool') return false
  const key = bindKey(event.sessionID, src.messageID, src.id)
  const b = key ? binds.get(key) : undefined
  if (!b) return false
  binds.delete(key)
  return b.at + MERGE_BIND_TTL_MS >= Date.now() && event.resources.length === 1 && event.resources[0] === b.tail
}

// ガードの判定結果のコード → 拒否の文言（codex-hook.sh の emit_deny と同じ文字列）
const guardDenyMessage = (code) => {
  if (code === 'deny-guard-missing') return 'iit-runner: ガードが見つからないため拒否した'
  if (code === 'deny-error') return 'iit-runner: ガードが異常終了したため拒否した'
  if (code.startsWith('deny:')) return `iit-runner: ガードの判定により拒否した（${code}）`
  return 'iit-runner: ガードの結果を得られないため拒否した'
}

/** 設定を検査して正規化する。不備があれば null（全 deny にする）。 */
function readOptions(options) {
  const o = options && typeof options === 'object' ? options : {}
  if (typeof o.guardScript !== 'string' || o.guardScript === '' || typeof o.log !== 'string' || o.log === '') return null
  let mergeRes = []
  try {
    mergeRes = (Array.isArray(o.mergeRes) ? o.mergeRes : []).map((src) => new RegExp(String(src)))
  } catch {
    return null
  }
  const protectedPaths = Array.isArray(o.protectedPaths) ? o.protectedPaths : []
  if (!protectedPaths.every((p) => typeof p === 'string' && isAbsolute(p))) return null
  if (o.callLog !== undefined && (typeof o.callLog !== 'string' || !isAbsolute(o.callLog))) return null
  return { guardScript: o.guardScript, log: o.log, mergeRes, markerPath: o.markerPath, nonce: o.nonce, protectedPaths, callLog: o.callLog ?? null }
}

function judge(guardScript, command, timeoutMs) {
  if (!existsSync(guardScript)) return { deny: true, code: 'deny-guard-missing' }
  const r = spawnSync(BASH, [guardScript], { input: JSON.stringify({ command, subagent: true }), encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' })
  if (r.error || r.signal || typeof r.stdout !== 'string') return { deny: true, code: 'deny-error' }
  const lines = r.stdout.split('\n').filter((l) => l !== '')
  const m = RESULT_LINE.exec(lines[lines.length - 1] ?? '')
  if (!m) return { deny: true, code: 'deny-noresult' }
  if (m[1] === 'allow') return r.status === 0 ? { deny: false } : { deny: true, code: 'deny-error' }
  return { deny: true, code: `deny:${m[2] ?? 'unknown'}` }
}

/**
 * tool.execute.before（全 serve）: shell の全文をガードに通す。拒否は throw（呼び出しが実行されない）。冒頭の「全文の判定」。
 * shell 以外でも input.command が文字列の tool（名前が変わった shell・plugin 定義）は同じく全文を判定する。
 */
function beforeTool(opts, binds, env, event) {
  const log = (what) => { try { appendFileSync(opts.log, `${Math.floor(Date.now() / 1000)}\t${what}\n`) } catch { /* ログ失敗は判定を変えない */ } }
  const reject = (code, message) => { log(code); throw new Error(message) }
  if (!event || typeof event !== 'object') reject('deny-bad-event', 'iit-runner: 対象を解釈できないため拒否した')
  const key = bindKey(event.sessionID, event.messageID, event.id)
  if (key) binds.delete(key)
  // 件数の突き合わせ用。判定の前に、拒否する呼び出しも含めて記録する（拒否された呼び出しもメッセージに tool part として残る）
  if (event.tool === 'shell' && opts.callLog) {
    try { appendFileSync(opts.callLog, `${typeof event.sessionID === 'string' ? event.sessionID.replace(/\s/g, '') : '-'}\n`) } catch { /* 記録の失敗は件数不足としてアダプタが拒否する */ }
  }
  const command = event.input?.command
  if (typeof command !== 'string') {
    if (event.tool === 'shell') reject('deny-bad-event', 'iit-runner: 対象を解釈できないため拒否した')
    return
  }
  if (event.tool === 'shell' && opts.mergeRes.length > 0 && opts.mergeRes.some((re) => re.test(command))) return recordMergeCall(binds, key, command)
  if (shellTouchesProtected(command, env.roots, env.baseDir)) reject('deny-protected-edit', MSG_PROTECTED)
  const v = judge(opts.guardScript, command, GUARD_TIMEOUT_MS)
  if (v.deny) reject(v.code, guardDenyMessage(v.code))
  log('allow')
}

function evaluate(opts, binds, event, env) {
  const log = (what) => { try { appendFileSync(opts.log, `${Math.floor(Date.now() / 1000)}\t${what}\n`) } catch { /* ログ失敗は判定を変えない */ } }
  if (event.effect === 'deny') return
  const action = event.action
  if (typeof action !== 'string') { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
  if (NON_SHELL_ACTIONS.has(action)) return
  const resources = event.resources
  if (!Array.isArray(resources)) { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
  // 編集系（shell 以外）はパスとして、保護パス（冒頭の「保護」）への書き込みを拒否する。
  if (action !== 'shell') {
    if (resources.some((r) => typeof r !== 'string')) {
      if (action === 'edit') { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
    } else if (resources.some((r) => isProtectedPath(r, env.roots, env.baseDir))) { log('deny-protected-edit'); return deny(event, MSG_PROTECTED) }
    if (action === 'edit') return
  }
  if (resources.length === 0) {
    if (action !== 'shell') return
    log('deny-bad-event')
    return deny(event, 'iit-runner: 対象を解釈できないため拒否した')
  }
  if (action === 'shell' && opts.mergeRes.length > 0 && resources.every((r) => typeof r === 'string') && takeMergeBind(binds, event)) { log('allow-mergeform'); return }
  const deadline = Date.now() + TOTAL_BLOCK_BUDGET_MS
  for (const command of resources) {
    if (typeof command !== 'string') { log('deny-bad-event'); return deny(event, 'iit-runner: 対象を解釈できないため拒否した') }
    if (shellTouchesProtected(command, env.roots, env.baseDir)) { log('deny-protected-edit'); return deny(event, MSG_PROTECTED) }
    if (opts.mergeRes.some((re) => re.test(command))) { log('allow-mergeform'); continue }
    const remaining = deadline - Date.now()
    if (remaining <= 0) { log('deny-budget'); return deny(event, 'iit-runner: 判定の時間の上限を超えたため拒否した') }
    const v = judge(opts.guardScript, command, Math.min(GUARD_TIMEOUT_MS, remaining))
    if (v.deny) { log(v.code); return deny(event, guardDenyMessage(v.code)) }
    log('allow')
  }
}

export default {
  id: 'iit-runner-guard',
  async setup(ctx) {
    const opts = readOptions(ctx.options)
    const dir = typeof ctx.location?.directory === 'string' && isAbsolute(ctx.location.directory) ? ctx.location.directory : null
    const env = opts ? { roots: protectedRoots(opts), baseDir: dir ? realOr(dir) : null } : null
    const binds = new Map() // merge-exec の対応づけ（冒頭の説明）。mergeRes が空の serve では何も記録しない
    const toolHook = typeof ctx.tool?.hook === 'function'
    if (opts && toolHook) {
      // 拒否と判定中の例外はどちらも throw のまま返す（呼び出しが実行されない = fail-closed）
      await ctx.tool.hook('execute.before', async (event) => beforeTool(opts, binds, env, event))
      await ctx.tool.hook('execute.after', async (event) => {
        try { const k = bindKey(event?.sessionID, event?.messageID, event?.id); if (k) binds.delete(k) } catch { /* 消し損ねは期限で消える */ }
      })
    }
    // 目印は全文の判定まで登録できたときだけ書く（書かなければアダプタが prereq で止める）
    if (opts && toolHook && opts.markerPath && opts.nonce) appendFileSync(opts.markerPath, `${JSON.stringify({ nonce: String(opts.nonce), directory: dir ?? null })}\n`)
    await ctx.permission.hook('evaluate', async (event) => {
      try {
        if (!opts) return deny(event, 'iit-runner: plugin の設定が不正なため拒否した')
        evaluate(opts, binds, event, env)
      } catch (e) {
        try { deny(event, 'iit-runner: 判定中の例外のため拒否した') } catch { throw e }
      }
    })
  },
}

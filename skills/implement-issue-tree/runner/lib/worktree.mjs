// `agent(..., { isolation: 'worktree' })` の再現。Workflow ランタイムが行う worktree の作成を、
// ランナーの共通層が実 git で行う境界（計画 C の方針 4。仕様は _/local-plans/iit-runners-phase0.md の 0-5）。
//
// 再現する契約（過去ランの残骸ブランチ・reflog・状態ファイルからの実測）:
//   - パス: <メイン worktree>/.claude/worktrees/<runId>-<N>。ホストは `.claude/worktrees/` 接頭辞に依存する。
//   - ブランチ: worktree-<runId>-<N>。ホストは `worktree-wf_…` 形のブランチを命名違反として弾くため、
//     実装ブランチへ付け替えるのはエージェントの責務で、ここでは作らない。
//   - 起点: 作成時点の最新の origin/<既定ブランチ>（ローカル HEAD ではない）。
//   - runId は `wf_<16 進 8>-<16 進 3>`、N はラン内の agent() の通し番号（隔離しない呼び出しも数える）。
//   - 後始末はしない。ホストの台帳（ephemeralWorktrees）と worktree-remove.sh に任せる。ブランチも消えずに残る。
//
// 未確定（0-5 の「決めること」）: lock の形。既定ではホストの worktree-remove.sh / recover-prep.sh が
// 解釈する Claude Code の形（`claude agent <名前> (pid <N>)`）で、ランナーの pid を付けて lock する。
// 実際の Workflow が付ける lock は生きた worktree で未確認のため、`lock: false` で外せる。
//
// 失敗は例外（0-5 の方針: throw するのは worktree の作成失敗だけ）。git は引数配列で起動し、シェルを経由しない。
// add の後（lock・gitdir の検証）で失敗したら、作った worktree とブランチを片づけてから例外にする（ホストはパスを知らないため）。
//
// git の環境: 継いだ GIT_DIR 等（gitLocationFreeEnv）を外して起動する。残すと git は cwd ではなくその変数が指す
// リポジトリを対象にする（シェル側は worktree-remove.sh・recover-prep.sh が unset している）。
// createWorktree の git は非同期で、時間切れ（fetch とそれ以外で別の上限）を付ける。origin が応答しないときに
// イベントループごと止めない（並行するエージェントのタイマ・シグナル処理・並列の枠を止めない）。
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const RUN_ID = /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/

/** git の出力に載った URL の認証情報（`scheme://user:pass@host`）を伏せる。エラー文・ログへ流さないため。 */
export function maskUrlCredentials(text) {
  return String(text).replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1***@')
}

/**
 * リポジトリの位置・中身の解釈を変える git の環境変数。`git rev-parse --local-env-vars`（git がサブモジュール等の
 * 別リポジトリへ入るときに外す一覧）に、探索の範囲を変えるもの（GIT_CEILING_DIRECTORIES・GIT_DISCOVERY_ACROSS_FILESYSTEM・
 * GIT_NAMESPACE）と実行ファイルの場所（GIT_EXEC_PATH）を足したもの。GIT_CONFIG_KEY_<n>・GIT_CONFIG_VALUE_<n> も外す
 * （GIT_CONFIG_COUNT と組で -c と同じ設定になるため）。GIT_CONFIG_GLOBAL・GIT_CONFIG_SYSTEM・GIT_CONFIG_NOSYSTEM は
 * 位置を変えない利用者の設定なので残す。
 */
export const GIT_LOCATION_ENV_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_NAMESPACE', 'GIT_EXEC_PATH',
])
const GIT_LOCATION_ENV = new Set(GIT_LOCATION_ENV_VARS)
const GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/

/**
 * env から GIT_LOCATION_ENV_VARS と GIT_CONFIG_KEY_<n>・GIT_CONFIG_VALUE_<n> を外した写しを返す（元は変えない）。
 * ランナーが起動する git・gh・Codex の子へ渡す env はこれを通す（run.mjs・adapters/codex.mjs）。
 */
export function gitLocationFreeEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!GIT_LOCATION_ENV.has(k) && !GIT_CONFIG_PAIR.test(k)) out[k] = v
  return out
}

/** ランナー自身が起動する git の env（gitLocationFreeEnv に、認証の入力で止まらない GIT_TERMINAL_PROMPT=0 を足す）。 */
export function gitSafeEnv(env = process.env) {
  return { ...gitLocationFreeEnv(env), GIT_TERMINAL_PROMPT: '0' }
}

const gitFailure = (args, status, stderr) => new Error(`git ${args[0]} が失敗した（終了コード ${status}）: ${maskUrlCredentials((stderr || '').trim().split('\n')[0])}`)

// 同期の git（起動時だけ使う resolveMainRoot と、ローカルの参照だけを読む resolveDefaultBranch）。通信はしないが上限は付ける
const SYNC_GIT_TIMEOUT_MS = 120_000
function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitSafeEnv(), timeout: SYNC_GIT_TIMEOUT_MS, killSignal: 'SIGKILL' })
  if (r.status !== 0 && !allowFail) {
    if (r.error) throw new Error(`git ${args[0]} が失敗した（${r.error.code === 'ETIMEDOUT' ? `${SYNC_GIT_TIMEOUT_MS} ms で時間切れ` : String(r.error.code ?? r.error.message).slice(0, 80)}）`)
    throw gitFailure(args, r.status, r.stderr)
  }
  return r.status === 0 ? r.stdout.trim() : null
}

/** createWorktree の git の既定の上限（fetch は origin との通信を含むので長め）。設定の timeoutsSec.worktree で変えられる（run.mjs）。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 300_000
export const DEFAULT_GIT_TIMEOUT_MS = 120_000
// 標準出力・標準エラーの保持の上限（使うのは rev-parse の 1 行と失敗文の 1 行目だけ）
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024

// 実行中の非同期 git（プロセスグループの長）。detached で端末の Ctrl-C が届かないため、ランナーの終了時に
// killGitSync が同期で止める（agent-host の killScriptsSync と同じ扱い。LOW-11）
const liveGits = new Set()

/** 実行中の非同期 git のプロセスグループを同期で SIGKILL する（run.mjs の process の exit・シグナルの処理から呼ぶ）。 */
export function killGitSync() {
  for (const c of liveGits) {
    try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* 既に終了 */ } }
  }
  liveGits.clear()
}

/**
 * 非同期の git。detached（setsid）で制御端末から外し、ssh が /dev/tty で尋ねて止まらないようにする。
 * timeoutMs を超えたらプロセスグループへ SIGKILL を送り、終了を待たずに例外にする（パイプを握った孫で待ち続けない）。
 * 成功なら標準出力（前後の空白を除く）、allowFail で失敗なら null。
 */
function gitAsync(cwd, args, { timeoutMs, allowFail = false }) {
  return new Promise((resolve, reject) => {
    const spawnFailure = (e) => new Error(`git ${args[0]} を起動できない: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`)
    let child
    try {
      child = spawn('git', args, { cwd, env: gitSafeEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      reject(spawnFailure(e))
      return
    }
    if (child.pid !== undefined) liveGits.add(child)
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    let timer = null
    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveGits.delete(child)
      fn()
    }
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 既に終了 */ } }
      // 自分の側のパイプを閉じる（グループの外へ逃げた孫が握っていても、このプロセスを引き留めない）
      child.stdout.destroy()
      child.stderr.destroy()
      settle(() => reject(new Error(`git ${args[0]} が ${timeoutMs} ms で時間切れになった（プロセスグループを止めた）`)))
    }, timeoutMs)
    child.stdout.on('data', (b) => { if (outBytes < MAX_GIT_OUTPUT_BYTES) out.push(b); outBytes += b.length })
    child.stderr.on('data', (b) => { if (errBytes < MAX_GIT_OUTPUT_BYTES) err.push(b); errBytes += b.length })
    child.on('error', (e) => settle(() => reject(spawnFailure(e))))
    child.on('close', (code) => settle(() => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim())
      else if (allowFail) resolve(null)
      else reject(gitFailure(args, code, Buffer.concat(err).toString('utf8')))
    }))
  })
}

/** `wf_<16 進 8>-<16 進 3>` 形の runId を作る。 */
export function newRunId() {
  const h = randomBytes(6).toString('hex')
  return `wf_${h.slice(0, 8)}-${h.slice(8, 11)}`
}

/** agent() 呼び出しの通し番号（1 始まり）を返すカウンタ。隔離しない呼び出しも数えるため、全呼び出しで next() する。 */
export function createSequencer() {
  let n = 0
  return { next: () => ++n, get count() { return n } }
}

export function worktreeNames(mainRoot, runId, n) {
  if (typeof mainRoot !== 'string' || !isAbsolute(mainRoot)) throw new Error(`メイン worktree のパスは絶対パスで渡す: ${String(mainRoot).slice(0, 80)}`)
  if (!RUN_ID.test(runId)) throw new Error(`runId の形が不正: ${runId}`)
  if (!Number.isInteger(n) || n < 1) throw new Error(`通し番号が不正: ${n}`)
  return {
    path: join(mainRoot, '.claude', 'worktrees', `${runId}-${n}`),
    branch: `worktree-${runId}-${n}`,
  }
}

/** cwd が属するリポジトリのメイン worktree の絶対パス（linked worktree の中から呼んでも本体を返す）。 */
export function resolveMainRoot(cwd) {
  const out = git(cwd, ['worktree', 'list', '--porcelain'])
  const first = out.split('\n').find((l) => l.startsWith('worktree '))
  if (!first) throw new Error('メイン worktree を特定できない')
  return first.slice('worktree '.length)
}

/** origin の既定ブランチ名。origin/HEAD が無ければ origin/main・origin/master の順に探す。 */
export function resolveDefaultBranch(mainRoot) {
  const head = git(mainRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (head?.startsWith('origin/')) return head.slice('origin/'.length)
  for (const b of ['main', 'master']) {
    if (git(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { allowFail: true })) return b
  }
  throw new Error('origin の既定ブランチを特定できない')
}

/**
 * linked worktree の git ディレクトリ（`<mainRoot>/.git/worktrees/<name>`）を検証して realpath を返す。
 * realpath の親がメインの `.git/worktrees` の realpath と一致しなければ例外。Codex アダプタはこの値だけを
 * permission profile の書き込み可に入れ、worktree の `.git` ファイルは読まない（監査 e670648 の HIGH-2。
 * `.git` はエージェントが書き換え得るため、中身を信じると書き込み範囲を任意のパスへ広げられる）。
 */
export function verifyWorktreeGitdir(mainRoot, gitdir) {
  if (typeof gitdir !== 'string' || !isAbsolute(gitdir)) throw new Error(`worktree の git ディレクトリが絶対パスでない: ${String(gitdir).slice(0, 80)}`)
  let real, parent
  try {
    real = realpathSync(gitdir)
    parent = realpathSync(join(mainRoot, '.git', 'worktrees'))
  } catch (e) {
    throw new Error(`worktree の git ディレクトリを解決できない: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`)
  }
  if (dirname(real) !== parent || basename(real) === '') throw new Error(`worktree の git ディレクトリがメインの .git/worktrees/ の直下に無い: ${real.slice(0, 160)}`)
  return real
}

/**
 * isolation: 'worktree' の worktree を作る（非同期。git は時間切れ付きで起動し、イベントループを止めない）。
 * gitdir は作成直後（エージェントが触る前）に git へ問い合わせて検証した値（verifyWorktreeGitdir）。
 * add の後の lock・gitdir の検証が失敗したら、作った worktree とブランチを片づけてから元の例外を投げる。
 * 片づけも失敗したら、残ったパス・ブランチを例外の文面に足す（利用者が手で消せるように）。
 * @param {{ mainRoot: string, runId: string, n: number, baseBranch?: string, fetch?: boolean, lock?: boolean, pid?: number,
 *   fetchTimeoutMs?: number, gitTimeoutMs?: number }} p
 * @returns {Promise<{ path: string, branch: string, baseBranch: string, baseSha: string, gitdir: string }>}
 */
export async function createWorktree({ mainRoot, runId, n, baseBranch, fetch = true, lock = true, pid = process.pid, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS, gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS }) {
  const { path, branch } = worktreeNames(mainRoot, runId, n)
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`pid が不正: ${pid}`)
  for (const [name, v] of [['fetchTimeoutMs', fetchTimeoutMs], ['gitTimeoutMs', gitTimeoutMs]]) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`${name} が不正: ${String(v).slice(0, 40)}`)
  }
  const g = (cwd, args, opts = {}) => gitAsync(cwd, args, { timeoutMs: gitTimeoutMs, ...opts })
  const base = baseBranch ?? resolveDefaultBranch(mainRoot)
  // 名前の検証は git 自身の規則（`--branch` は @{-1} 等を展開するので、展開されず元の名前のままのものだけ通す）に、
  // シェルが特別扱いする文字を持たない制限を重ねる（git は `$(x)` のような名前も有効とするため）
  const checked = typeof base === 'string' && /^[A-Za-z0-9._\/-]+$/.test(base) && !base.startsWith('-') ? await g(mainRoot, ['check-ref-format', '--branch', base], { allowFail: true }) : null
  if (checked !== base) throw new Error(`基点ブランチ名が不正: ${String(base).slice(0, 80)}`)
  // 「作成時点の最新の origin/<既定>」を起点にする。fetch の失敗・時間切れは握りつぶさない（古い起点で隔離を作らない）
  if (fetch) await g(mainRoot, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeoutMs: fetchTimeoutMs })
  const baseSha = await g(mainRoot, ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])
  mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true })
  // add 自体の失敗（同じ番号の衝突等）は片づけない（その worktree・ブランチは今回作ったものではない）
  await g(mainRoot, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, '--', path, baseSha])
  try {
    if (lock) await g(mainRoot, ['worktree', 'lock', '--reason', `claude agent ${runId}-${n} (pid ${pid})`, '--', path])
    const gitdir = verifyWorktreeGitdir(mainRoot, await g(path, ['rev-parse', '--absolute-git-dir']))
    return { path, branch, baseBranch: base, baseSha, gitdir }
  } catch (e) {
    throw await discardCreated(mainRoot, path, branch, e, g)
  }
}

/**
 * add の後に失敗した worktree を片づけ、投げる例外を返す（元の文面を保ち、片づけの失敗はその後ろに足す）。
 * 作成直後でエージェントは触っていないので、変更の有無を見ずに消す。lock 済み（lock の後の検証で失敗）なら先に外す。
 */
async function discardCreated(mainRoot, path, branch, original, g) {
  const left = []
  await g(mainRoot, ['worktree', 'unlock', '--', path], { allowFail: true }).catch(() => null)
  if (!(await g(mainRoot, ['worktree', 'remove', '--force', '--', path]).then(() => true, () => false))) left.push(`worktree ${path}`)
  // worktree が残っているとブランチは消せない（チェックアウト中）。消せなかった分だけ文面に足す
  if (!(await g(mainRoot, ['branch', '-D', branch]).then(() => true, () => false))) left.push(`ブランチ ${branch}`)
  const e = original instanceof Error ? original : new Error(String(original))
  if (left.length > 0) {
    e.message = `${e.message}（作った worktree の片づけにも失敗した。残っている: ${left.join('・')}。手で消す: git worktree unlock / git worktree remove --force / git branch -D）`
  }
  return e
}

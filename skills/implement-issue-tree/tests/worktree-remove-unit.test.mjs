// scripts/lib/worktree-remove-lib.sh（worktree-remove.sh の判断と入力検証だけの純関数）を、表で単体検査する回帰テスト（Issue #603 第 7 弾）。
//
// 削除してよいかの判断（モードと観測 → 削除・強制削除・保持）、lock の扱い、git の出力の読み取り、入力の形式検証は、git を呼ばない純関数に
// 切り出してある。1 回の bash 起動で表の全ケースを source した関数へ渡し、1 行ずつ結果を返させる（実 git で全体を走らせる検査は
// tests/worktree-remove.test.mjs）。利用できる bash（macOS の 3.2 と Homebrew の 5 など）をすべて回す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableBashes } from './lib/signed-output.mjs'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'worktree-remove-lib.sh')
const US = '\u001f'
const NL = '@@' // 表の中の改行（ドライバが改行へ戻す）

// 各行 [関数名, 引数...]。出力は `<i> <rc> [<標準出力>] [WR_ 変数のまとめ]`
const DRIVER = `
set -u
LC_ALL=C
export LC_ALL
. "$1" || exit 9
US=$(printf '\\037')
nl() { printf '%s' "$1" | sed 's/@@/\\
/g'; }
i=0
while IFS="$US" read -r fn a b c d; do
  rc=0
  out=""
  WR_DIRTY=0; WR_SUB_DIRTY=0; WR_REGISTERED=0; WR_MAIN=0; WR_LOCKED=0; WR_LOCK_REASON=""; WR_LOCK_PID=""
  case "$fn" in
    wr_count_status) wr_count_status "$(nl "$a")" ;;
    wr_find_entry) wr_find_entry "$(nl "$a")" "$b" ;;
    wr_lock_pid) out=$(wr_lock_pid "$a" 2>&1) || rc=$?; wr_lock_pid "$a" || true ;;
    *) out=$("$fn" "$a" "$b" "$c" "$d" 2>&1) || rc=$? ;;
  esac
  printf '%s %s [%s] [%s,%s,%s,%s,%s,%s,%s]\\n' "$i" "$rc" "$out" "$WR_DIRTY" "$WR_SUB_DIRTY" "$WR_REGISTERED" "$WR_MAIN" "$WR_LOCKED" "$WR_LOCK_REASON" "$WR_LOCK_PID"
  i=$((i + 1))
done
`

function table(bash, rows) {
  const input = rows.map((r) => r.join(US)).join('\n') + '\n'
  const r = spawnSync(bash, ['-c', DRIVER, 'driver', LIB], { input, encoding: 'utf8' })
  assert.equal(r.status, 0, `exit ${r.status} / stderr: ${r.stderr}`)
  const lines = r.stdout.split('\n').filter((l) => l !== '')
  assert.equal(lines.length, rows.length, `行数が合わない:\n${r.stdout}`)
  return lines.map((l, i) => {
    const m = /^(\d+) (\d+) \[(.*?)\] \[(.*)\]$/.exec(l)
    assert.ok(m && Number(m[1]) === i, l)
    const [dirty, sub, reg, main, locked, reason, pid] = m[4].split(',')
    return { rc: Number(m[2]), out: m[3], dirty: Number(dirty), sub: Number(sub), reg: Number(reg), main: Number(main), locked: Number(locked), reason, pid }
  })
}

const OK = 0
const NG = 1

function check(name, rows, expect) {
  for (const bash of availableBashes()) {
    test(`${name} [${bash}]`, () => {
      const got = table(bash, rows)
      rows.forEach((r, i) => expect(got[i], r, i))
    })
  }
}

check(
  'wr_valid_path: 絶対パス・先頭は英数字・使える文字は英数字と . _ / - 空白・.. を含まない（ホストの sanitizeWorktreePath と同じ）',
  [
    ['wr_valid_path', '/tmp/wt-1'], ['wr_valid_path', '/a'], ['wr_valid_path', '/Users/x/my repo/.claude/worktrees/agent-ab12'],
    ['wr_valid_path', ''], ['wr_valid_path', 'relative/p'], ['wr_valid_path', '/'], ['wr_valid_path', '/.hidden'], ['wr_valid_path', '/-x'],
    ['wr_valid_path', '/a/../b'], ['wr_valid_path', '/a..b'], ['wr_valid_path', "/a'b"], ['wr_valid_path', '/a"b'], ['wr_valid_path', '/a;b'],
    ['wr_valid_path', '/a$b'], ['wr_valid_path', '/a`b'], ['wr_valid_path', '/a|b'], ['wr_valid_path', '/a&b'], ['wr_valid_path', '/a\\b'],
    ['wr_valid_path', '/a*b'], ['wr_valid_path', '/a(b)'], ['wr_valid_path', '/a日本'], ['wr_valid_path', '/a\tb'],
  ],
  (g, r) => {
    const good = new Set(['/tmp/wt-1', '/a', '/Users/x/my repo/.claude/worktrees/agent-ab12'])
    assert.equal(g.rc, good.has(r[1]) ? OK : NG, JSON.stringify(r[1]))
  },
)

check(
  'wr_valid_branch: ホストの isValidBranchName の文字種に、git が拒否する形を加えて狭める',
  [
    ['wr_valid_branch', 'feat/603-x'], ['wr_valid_branch', 'main'], ['wr_valid_branch', 'release/1.0'], ['wr_valid_branch', 'a_b-c.d'],
    ['wr_valid_branch', ''], ['wr_valid_branch', '-D'], ['wr_valid_branch', '--delete'], ['wr_valid_branch', '/x'], ['wr_valid_branch', 'a..b'],
    ['wr_valid_branch', 'a//b'], ['wr_valid_branch', 'a/'], ['wr_valid_branch', 'a.lock'], ['wr_valid_branch', 'a.lock/b'], ['wr_valid_branch', 'a/.b'],
    ['wr_valid_branch', 'a@{1}'], ['wr_valid_branch', 'a b'], ['wr_valid_branch', 'a;b'], ['wr_valid_branch', 'a$b'], ['wr_valid_branch', "a'b"], ['wr_valid_branch', 'a:b'],
    ['wr_valid_branch', 'a*b'], ['wr_valid_branch', 'a^b'], ['wr_valid_branch', 'a~b'], ['wr_valid_branch', 'a?b'], ['wr_valid_branch', 'a[b'], ['wr_valid_branch', 'a\\b'],
  ],
  (g, r) => {
    const good = new Set(['feat/603-x', 'main', 'release/1.0', 'a_b-c.d'])
    assert.equal(g.rc, good.has(r[1]) ? OK : NG, JSON.stringify(r[1]))
  },
)

check(
  'wr_valid_file: _/issue-trees/<正の整数>.json だけ',
  [
    ['wr_valid_file', '_/issue-trees/1.json'], ['wr_valid_file', '_/issue-trees/603.json'],
    ['wr_valid_file', ''], ['wr_valid_file', '_/issue-trees/0.json'], ['wr_valid_file', '_/issue-trees/01.json'], ['wr_valid_file', '_/issue-trees/a.json'],
    ['wr_valid_file', '_/issue-trees/.json'], ['wr_valid_file', '_/issue-trees/1.json.bak'], ['wr_valid_file', '/_/issue-trees/1.json'],
    ['wr_valid_file', '_/issue-trees/../x/1.json'], ['wr_valid_file', '_/issue-trees/1/2.json'], ['wr_valid_file', 'x/issue-trees/1.json'],
  ],
  (g, r) => assert.equal(g.rc, r[1] === '_/issue-trees/1.json' || r[1] === '_/issue-trees/603.json' ? OK : NG, JSON.stringify(r[1])),
)

check(
  'wr_lock_pid: `claude agent <名前> (pid <N>)` の形だけ pid を取り出す',
  [
    ['wr_lock_pid', 'claude agent agent-abc123 (pid 4242)'], ['wr_lock_pid', 'claude agent a (pid 1)'], ['wr_lock_pid', 'claude agent two words (pid 9)'],
    ['wr_lock_pid', ''], ['wr_lock_pid', 'manual lock'], ['wr_lock_pid', 'claude agent agent-abc'], ['wr_lock_pid', 'claude agent agent-abc (pid )'],
    ['wr_lock_pid', 'claude agent agent-abc (pid x1)'], ['wr_lock_pid', 'claude agent agent-abc (pid 12x)'], ['wr_lock_pid', 'claude agent  (pid 1)'],
    ['wr_lock_pid', 'claude agent agent-abc (pid 1234567890)'], ['wr_lock_pid', 'Claude agent agent-abc (pid 1)'], ['wr_lock_pid', 'claude agent agent-abc (pid 1) extra'],
    ['wr_lock_pid', 'xclaude agent agent-abc (pid 1)'], ['wr_lock_pid', 'claude agent agent-abc (pid -1)'],
  ],
  (g, r, i) => {
    const pids = { 0: '4242', 1: '1', 2: '9' }
    if (i in pids) {
      assert.deepEqual([g.rc, g.pid], [OK, pids[i]], r[1])
    } else {
      assert.deepEqual([g.rc, g.pid], [NG, ''], r[1])
    }
  },
)

check(
  'wr_lock_action: lock なし → none / agent の形で pid が死んでいる → unlock / それ以外（生きている・形が違う・観測不能）→ retain',
  [
    ['wr_lock_action', '0', '', '1'], ['wr_lock_action', '0', '123', '0'],
    ['wr_lock_action', '1', '123', '0'], ['wr_lock_action', '1', '123', '1'], ['wr_lock_action', '1', '', '0'], ['wr_lock_action', '1', '', '1'],
    ['wr_lock_action', '1', '123', ''], ['wr_lock_action', '', '123', '0'], ['wr_lock_action', '2', '123', '0'],
  ],
  (g, r, i) => assert.equal(g.out, ['none', 'none', 'unlock', 'retain', 'retain', 'retain', 'retain', 'retain', 'retain'][i], JSON.stringify(r)),
)

// wr_plan MODE DIRTY SUB_DIRTY SUB_INIT
check(
  'wr_plan: superseded は汚れていても force（submodule の未記録の変更・確認不能は保持）、discard は汚れ・初期化済み submodule で保持し --force を使わない',
  [
    ['wr_plan', 'superseded', '0', '0', '0'], ['wr_plan', 'superseded', '5', '0', '0'], ['wr_plan', 'superseded', '5', '1', '0'], ['wr_plan', 'superseded', '1', '1', '2'],
    ['wr_plan', 'superseded', '0', '0', '3'], ['wr_plan', 'superseded', '-1', '0', '0'],
    ['wr_plan', 'discard', '0', '0', '0'], ['wr_plan', 'discard', '1', '0', '0'], ['wr_plan', 'discard', '0', '0', '1'], ['wr_plan', 'discard', '2', '1', '1'],
    ['wr_plan', 'discard', '-1', '0', '0'], ['wr_plan', 'bogus', '0', '0', '0'], ['wr_plan', '', '0', '0', '0'],
  ],
  (g, r, i) => assert.equal(g.out, ['force', 'force', 'retain-submodule', 'retain-submodule', 'force', 'retain-dirty', 'plain', 'retain-dirty', 'retain-submodule', 'retain-dirty', 'retain-dirty', 'retain-dirty', 'retain-dirty'][i], JSON.stringify(r)),
)

// wr_count_status TEXT（v2 形式。@@ が改行）→ WR_DIRTY, WR_SUB_DIRTY
const SUB_LINE = '1 .M S.M. 160000 160000 160000 aaaaaaaa bbbbbbbb sm'
check(
  'wr_count_status: v2 の行数を汚れとして数え、第 3 フィールドが S で始まる行を submodule 由来として数える',
  [
    ['wr_count_status', ''],
    ['wr_count_status', '1 .M N... 100644 100644 100644 aaaa bbbb a.txt'],
    ['wr_count_status', `1 .M N... 100644 100644 100644 aaaa bbbb a.txt${NL}? u.txt${NL}? deep/x`],
    ['wr_count_status', SUB_LINE],
    ['wr_count_status', `${SUB_LINE}${NL}1 A. N... 000000 100644 100644 0000 cccc c.txt`],
    ['wr_count_status', '2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\told.txt'],
    ['wr_count_status', 'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc a.txt'],
    ['wr_count_status', 'u UU S.M. 160000 160000 160000 160000 aaaa bbbb cccc sm'],
    ['wr_count_status', `# branch.oid abc${NL}1 .M N... 100644 100644 100644 aaaa bbbb a.txt`],
    ['wr_count_status', `${NL}${NL}? x${NL}`],
    ['wr_count_status', '? S-looks-like-submodule.txt'],
  ],
  (g, r, i) => assert.deepEqual([g.dirty, g.sub], [[0, 0], [1, 0], [3, 0], [1, 1], [2, 1], [1, 0], [1, 0], [1, 1], [1, 0], [1, 0], [1, 0]][i], JSON.stringify(r)),
)

const LIST = (...entries) => entries.join(`${NL}${NL}`)
const MAIN = `worktree /r/main${NL}HEAD aaaa${NL}branch refs/heads/main`
const W1 = `worktree /r/w1${NL}HEAD bbbb${NL}branch refs/heads/b1`
const W2L = `worktree /r/w2${NL}HEAD cccc${NL}branch refs/heads/b2${NL}locked claude agent agent-x (pid 77)`
const W3L = `worktree /r/w3${NL}HEAD dddd${NL}branch refs/heads/b3${NL}locked`
const W4 = `worktree /r/w 4${NL}HEAD eeee${NL}detached`
// wr_find_entry LIST TARGET → [dirty,sub,reg,main,locked,reason,pid] の reg, main, locked, reason
check(
  'wr_find_entry: 登録の有無・先頭エントリ（メイン）・lock の有無と理由（lock は対象のエントリのものだけ）',
  [
    ['wr_find_entry', LIST(MAIN, W1, W2L), '/r/main'],
    ['wr_find_entry', LIST(MAIN, W1, W2L), '/r/w1'],
    ['wr_find_entry', LIST(MAIN, W1, W2L), '/r/w2'],
    ['wr_find_entry', LIST(MAIN, W1, W2L), '/r/w3'],
    ['wr_find_entry', LIST(MAIN, W1, W3L), '/r/w3'],
    ['wr_find_entry', LIST(MAIN, W1, W3L), '/r/w1'],
    ['wr_find_entry', LIST(MAIN, W4, W1), '/r/w 4'],
    ['wr_find_entry', '', '/r/w1'],
    ['wr_find_entry', LIST(MAIN, W1), '/r/w1/'],
    ['wr_find_entry', LIST(MAIN, W1), '/r'],
    ['wr_find_entry', LIST(MAIN, W1), '/r/main/sub'],
    ['wr_find_entry', LIST(W2L, MAIN), '/r/main'],
  ],
  (g, r, i) => {
    const exp = [
      [1, 1, 0, ''], [1, 0, 0, ''], [1, 0, 1, 'claude agent agent-x (pid 77)'], [0, 0, 0, ''], [1, 0, 1, ''], [1, 0, 0, ''], [1, 0, 0, ''],
      [0, 0, 0, ''], [0, 0, 0, ''], [0, 0, 0, ''], [0, 0, 0, ''], [1, 0, 0, ''],
    ][i]
    assert.deepEqual([g.reg, g.main, g.locked, g.reason], exp, `${i}: ${JSON.stringify(r.slice(1))}`)
  },
)

// wr_branch_action BRANCH BASE GONE EXISTS
check(
  'wr_branch_action: 指定なし → none / base と同名 → keep-base / worktree が残っている → keep / 実在しない → absent / それ以外 → delete',
  [
    ['wr_branch_action', '', 'main', '1', '1'], ['wr_branch_action', 'main', 'main', '1', '1'], ['wr_branch_action', 'feat/x', 'main', '0', '1'],
    ['wr_branch_action', 'feat/x', 'main', '1', '0'], ['wr_branch_action', 'feat/x', 'main', '1', '1'], ['wr_branch_action', 'feat/x', '', '1', '1'],
    ['wr_branch_action', 'main', 'main', '0', '0'], ['wr_branch_action', 'feat/x', 'main', '', '1'], ['wr_branch_action', 'feat/x', 'main', '1', ''],
  ],
  (g, r, i) => assert.equal(g.out, ['none', 'keep-base', 'keep', 'absent', 'delete', 'delete', 'keep-base', 'keep', 'absent'][i], JSON.stringify(r)),
)

const WT = ['removed', 'not-registered', 'skipped', 'main', 'retained-dirty', 'retained-submodule', 'retained-locked', 'failed']
const BR = ['none', 'deleted', 'absent', 'keep-base', 'keep', 'failed']
check(
  'wr_ok / wr_retained / wr_wt_gone: superseded は worktree が残っても非致命（main だけ異常）、discard は worktree が無くなりブランチも無い・消えたときだけ ok',
  [
    ...WT.map((w) => ['wr_ok', 'superseded', w, 'none']),
    ...WT.flatMap((w) => BR.map((b) => ['wr_ok', 'discard', w, b])),
    ['wr_ok', 'bogus', 'removed', 'none'],
    ...WT.map((w) => ['wr_retained', w]),
    ...WT.map((w) => ['wr_wt_gone', w]),
  ],
  (g, r, i) => {
    let exp
    if (r[0] === 'wr_ok' && r[1] === 'superseded') exp = r[2] !== 'main'
    else if (r[0] === 'wr_ok' && r[1] === 'discard') exp = ['removed', 'not-registered', 'skipped'].includes(r[2]) && ['none', 'deleted', 'absent', 'keep-base'].includes(r[3])
    else if (r[0] === 'wr_ok') exp = false
    else if (r[0] === 'wr_retained') exp = !['removed', 'not-registered', 'skipped'].includes(r[1])
    else exp = ['removed', 'not-registered', 'skipped'].includes(r[1])
    assert.equal(g.rc, exp ? OK : NG, `${i}: ${JSON.stringify(r)}`)
  },
)

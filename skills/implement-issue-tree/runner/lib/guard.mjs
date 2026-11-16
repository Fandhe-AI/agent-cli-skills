// ランナーが起動するエージェントに対して、拒否するコマンドの形の一覧と、その生成元になる判定器。
//
// 位置づけ: ベストエフォートの第一の防御線。実効の防御はサーバー側の ruleset と G0 にある
// （Workflow 版の merge-guard-hook と同じ位置づけ。_/local-plans/iit-runners-phase0.md の 0-3）。
// 実際にコマンドを止めるのは次の 2 つで、本モジュールはその入力と、同じ形を確かめるテスト用の判定器を持つ。
//   - Codex: hook 1 本（init-codex の agent-guard.sh を、ランナーが「常に subagent=true」で呼ぶ）。
//     rules は使わない（`-c` では効かない）。hook の組み立てはアダプタ（Phase 2a）の責務で、ここには持たない。
//   - OpenCode: plugin（同じ agent-guard）と permissions・policies。opencodeRules() がその一覧を作る。
//
// マージ系の権限分離: マージを許すのは「autoMerge: true のランの merge-exec ラベル」だけ。許すのは
// 次の完全一致の 1 形だけで、承認を `;`・`&&`・改行でつないだ形などは MERGE_EXEC_COMMAND に一致せず拒否される。
//   HEAD_SHA="<40 桁 hex>"; gh pr merge <N> --squash --delete-branch --match-head-commit "$HEAD_SHA"
//
// 止められない形（既知の限界）: 変数経由・`$(…)` の出力を使う組み立て・書き込みツールで作ったスクリプトの
// 実行・引用符による語の分割のうち hook / permissions が見ない形。classify はクォートの連結と
// `bash -c` / `env` / `eval` の入れ子は展開して見るが、網羅は保証しない。

/** merge-exec の完全一致の形（src の merge プロンプトの手順 3 と同じ形）。 */
export const MERGE_EXEC_COMMAND = /^HEAD_SHA="[0-9a-f]{40}"; gh pr merge [1-9][0-9]* --squash --delete-branch --match-head-commit "\$HEAD_SHA"$/

const MAX_DEPTH = 8

/**
 * 拒否する形の一覧。mergeOnly は merge-exec の完全一致の形だけを例外にできる形（それ以外は常に拒否）。
 * opencode は OpenCode の permissions / policies へ渡す文字列照合のパターン（サブコマンドごとに照合される）。
 */
export const DENY_FORMS = Object.freeze([
  { id: 'pr-merge', mergeOnly: true, note: 'gh pr merge', opencode: ['gh pr merge*', 'gh * pr merge*'] },
  { id: 'api-merge', mergeOnly: true, note: 'REST の /merge と GraphQL のマージ系 mutation', opencode: ['gh api *merge*', 'gh api graphql*'] },
  { id: 'pr-approve', mergeOnly: false, note: 'gh pr review の --approve / -a', opencode: ['gh pr review*--approve*', 'gh pr review* -a*', 'gh * pr review*--approve*'] },
  { id: 'api-review', mergeOnly: false, note: 'reviews API の書き込みと GraphQL のレビュー mutation', opencode: ['gh api *reviews*'] },
  { id: 'auth-token', mergeOnly: false, note: '認証トークンの表示（gh auth token・status --show-token・環境変数の表示）', opencode: ['gh auth token*', 'gh auth status*-t*', 'gh auth status*--show-token*', 'printenv GH_TOKEN*', 'printenv GITHUB_TOKEN*'] },
  { id: 'auth-file', mergeOnly: false, note: 'gh / Codex の認証ファイルの読み取り', opencode: ['*gh/hosts.yml*', '*.codex/auth.json*'] },
  { id: 'git-force-push', mergeOnly: false, note: 'force 系の push', opencode: ['git push --force *', 'git push -f *', 'git push --force-with-lease *', 'git push --force-with-lease=* *', 'git push --force-if-includes *', 'git push --mirror *'] },
  { id: 'git-no-verify', mergeOnly: false, note: 'フックの迂回', opencode: ['git commit --no-verify *', 'git commit -n *', 'git push --no-verify *'] },
])

const MERGE_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/
const REVIEW_MUTATIONS = /\b(addPullRequestReview|submitPullRequestReview)\b/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const PASSTHROUGH = new Set(['command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'builtin'])
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname'])

/**
 * シェルの文字列を、区切り（; & | 改行 括弧 バッククォート）ごとの語の列へ分ける。
 * クォートは外して連結する（`gh pr 'mer'ge` は gh pr merge になる）。簡易な字句解析で、
 * 展開・リダイレクト・ヒアドキュメントは解釈しない。
 * @param {string} text
 * @returns {string[][]}
 */
export function splitCommand(text) {
  const segments = []
  let words = []
  let word = ''
  let inWord = false
  let quote = null
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSeg = () => { endWord(); if (words.length > 0) segments.push(words); words = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < text.length) word += text[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      inWord = true
    } else if (/[;&|\n()`]/.test(c)) {
      endSeg()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSeg()
  return segments
}

const baseName = (w) => w.slice(w.lastIndexOf('/') + 1)

/** セグメントの先頭から、環境変数の代入と素通しのラッパーを外す。env -S の文字列は第 2 戻り値で返す。 */
function stripPrefix(words) {
  let i = 0
  let splitString = null
  for (;;) {
    const w = words[i]
    if (w === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue }
    const b = baseName(w)
    if (b === 'env') {
      i++
      while (i < words.length && (words[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
        if (words[i] === '-S' || words[i] === '--split-string') { splitString = words[i + 1] ?? ''; i += 2; continue }
        if (words[i].startsWith('-S') && words[i].length > 2) { splitString = words[i].slice(2); i++; continue }
        i++
      }
      continue
    }
    if (PASSTHROUGH.has(b)) { i++; continue }
    break
  }
  return { rest: words.slice(i), splitString }
}

/** 入れ子（bash -c・eval・env -S）を展開した、実行されうる全セグメントの語の列。深さ超過は null。 */
function expand(text, depth) {
  if (depth > MAX_DEPTH) return null
  const out = []
  for (const seg of splitCommand(text)) {
    const { rest, splitString } = stripPrefix(seg)
    if (splitString !== null) {
      const inner = expand(splitString, depth + 1)
      if (inner === null) return null
      out.push(...inner)
    }
    if (rest.length === 0) continue
    out.push(rest)
    const head = baseName(rest[0])
    let script
    if (SHELLS.has(head)) {
      const k = rest.findIndex((w, idx) => idx > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w))
      if (k > 0) script = rest.slice(k + 1).find((w) => !w.startsWith('-')) ?? ''
    } else if (head === 'eval') {
      script = rest.slice(1).join(' ')
    }
    if (script !== undefined) {
      const inner = expand(script, depth + 1)
      if (inner === null) return null
      out.push(...inner)
    }
  }
  return out
}

function ghFormOf(words) {
  // gh のグローバルフラグ（-R x など）を外してサブコマンドを得る
  const args = []
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    if (GH_VALUE_FLAGS.has(w)) { i++; continue }
    if (/^(-R|--repo|--hostname)=/.test(w)) continue
    args.push(w)
  }
  const [a, b] = args
  if (a === 'pr' && b === 'merge') return 'pr-merge'
  if (a === 'pr' && b === 'review') {
    if (args.some((w) => w === '--approve' || w.startsWith('--approve=') || /^-[A-Za-z]*a[A-Za-z]*$/.test(w))) return 'pr-approve'
    return null
  }
  if (a === 'auth' && b === 'token') return 'auth-token'
  if (a === 'auth' && b === 'status' && args.some((w) => w === '--show-token' || /^-[A-Za-z]*t[A-Za-z]*$/.test(w))) return 'auth-token'
  if (a === 'api') {
    const joined = args.slice(1).join(' ')
    if (b === 'graphql' || args.includes('graphql')) {
      if (MERGE_MUTATIONS.test(joined)) return 'api-merge'
      if (REVIEW_MUTATIONS.test(joined)) return 'api-review'
      // クエリがファイル・標準入力から来る形は、中身を見られないため拒否側に倒す
      if (args.some((w) => w === '--input' || /^query=@/.test(w) || w === '-F' || w === '--field')) return 'api-review'
      return null
    }
    if (/\/pulls\/[^/\s]+\/merge\b/.test(joined) || /\/merge(\s|$)/.test(joined)) return 'api-merge'
    if (/\/pulls\/[^/\s]+\/reviews\b/.test(joined)) {
      const m = /(?:-X|--method)[= ]?\s*([A-Za-z]+)/.exec(args.join(' '))
      return m && m[1].toUpperCase() === 'GET' ? null : 'api-review'
    }
  }
  return null
}

function gitFormOf(words) {
  const args = words.slice(1)
  const sub = args.find((w) => !w.startsWith('-'))
  if (sub === 'push') {
    if (args.some((w) => w === '--force' || w === '-f' || w.startsWith('--force-with-lease') || w === '--force-if-includes' || w === '--mirror' || /^\+[^+]/.test(w))) return 'git-force-push'
    if (args.includes('--no-verify')) return 'git-no-verify'
  }
  if (sub === 'commit' && args.some((w) => w === '--no-verify' || w === '-n')) return 'git-no-verify'
  return null
}

function otherFormOf(words) {
  const head = baseName(words[0])
  if (head === 'printenv' && words.slice(1).some((w) => /^(GH_TOKEN|GITHUB_TOKEN)$/.test(w))) return 'auth-token'
  if (/^(cat|less|more|head|tail|bat|grep|sed|awk|cp|xxd|od|strings)$/.test(head) && words.slice(1).some((w) => /gh\/hosts\.yml|\.codex\/auth\.json/.test(w))) return 'auth-file'
  return null
}

/**
 * コマンド文字列を判定する。allowMerge は「autoMerge のランの merge-exec ラベル」のときだけ true。
 * @param {string} command
 * @param {{ allowMerge?: boolean }} [opts]
 * @returns {{ decision: 'allow' } | { decision: 'deny', form: string }}
 */
export function classify(command, { allowMerge = false } = {}) {
  if (typeof command !== 'string') return { decision: 'deny', form: 'bad-input' }
  if (allowMerge && MERGE_EXEC_COMMAND.test(command)) return { decision: 'allow' }
  const segs = expand(command, 0)
  if (segs === null) return { decision: 'deny', form: 'nesting-limit' }
  for (const words of segs) {
    const head = baseName(words[0])
    const form = head === 'gh' ? ghFormOf(words) : head === 'git' ? gitFormOf(words) : otherFormOf(words)
    // mergeOnly の形は、完全一致の 1 形（上で許可済み）以外は allowMerge でも拒否する
    if (form !== null) return { decision: 'deny', form }
  }
  return { decision: 'allow' }
}

/**
 * OpenCode の permissions / policies（init-opencode の opencode.jsonc と同じ形式）。
 * allowMerge の serve（merge-exec 専用）では mergeOnly の形を含めない。session.create で allow-all は付けない
 * （config の permissions が打ち消されるため。Phase 0-6）。policies は session の許可では外せない。
 * @param {{ allowMerge?: boolean }} [opts]
 */
export function opencodeRules({ allowMerge = false } = {}) {
  const patterns = DENY_FORMS.filter((f) => !(allowMerge && f.mergeOnly)).flatMap((f) => f.opencode)
  return {
    permissions: patterns.map((resource) => ({ action: 'shell', resource, effect: 'deny' })),
    policies: patterns.map((resource) => ({ action: 'tool.use', resource: `shell:${resource}`, effect: 'deny' })),
  }
}

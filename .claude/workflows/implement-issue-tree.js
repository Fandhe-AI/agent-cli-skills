export const meta = {
  name: 'implement-issue-tree',
  description: '親イシュー配下のサブイシューを post-order DFS で実装・レビュー・PR 作成・squash merge まで自動化する',
  whenToUse: '親イシュー番号を指定してサブイシュー群（孫含む）を順次自動開発するとき',
  phases: [
    { title: 'Plan', detail: 'イシューツリー取得と post-order 実行順の決定' },
    { title: 'Implement', detail: 'イシューごとの実装・レビュー・修正・PR 作成', model: 'opus' },
    { title: 'Merge', detail: 'CI 監視・レビューコメント全解決確認・squash merge・クローズ', model: 'sonnet' },
  ],
}

// args は string で渡される場合がある
const parsedArgs = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return args } })()
  : args
const parent = Number(
  parsedArgs && typeof parsedArgs === 'object' ? (parsedArgs.parent ?? parsedArgs.issue) : parsedArgs,
)
const baseBranch = sanitize((parsedArgs && typeof parsedArgs === 'object' && parsedArgs.branch) || 'main')

if (!Number.isInteger(parent) || parent <= 0) {
  throw new Error('親イシュー番号を args で指定すること（例: {"parent": 1008, "branch": "main"}）')
}

// GitHub API から取得した文字列をエージェントプロンプトに埋め込む前にサニタイズする
// バッククォート・バックスラッシュによるプロンプトインジェクションを軽減する
function sanitize(str) {
  return String(str).replace(/`/g, "'").replace(/\\/g, '/')
}

const COMMON = [
  `カレントディレクトリのリポジトリで作業する。base branch: ${baseBranch}。`,
  '自動運転モード: ユーザーへの質問・承認待ちは不可。判断が必要なら安全側に倒して進める。',
  'gh / git fetch / git push などネットワークを使うコマンドは sandbox 無効で実行する。',
  'コミットは pre-commit フックを必ず通す（--no-verify 禁止）。',
].join('\n')

const TREE_SCHEMA = {
  type: 'object',
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'state', 'parent', 'siblingIndex'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          state: { type: 'string', description: 'open または closed' },
          parent: { type: 'number', description: '直上の親イシュー番号。ルート自身は 0' },
          siblingIndex: { type: 'number', description: '親の sub_issues API 返却における 0-indexed 位置。ルート自身は 0' },
        },
      },
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['prNumber', 'branch', 'summary'],
  properties: {
    prNumber: { type: 'number', description: '作成した PR 番号。作成できなければ 0' },
    branch: { type: 'string' },
    summary: { type: 'string' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['state', 'summary'],
  properties: {
    state: {
      type: 'string',
      enum: ['merged', 'needs-fix', 'unresolved-comments', 'timeout', 'blocked'],
      description: 'merged: マージ成功 / needs-fix: CI 失敗・コンフリクト / unresolved-comments: レビューコメント未解決 / timeout: 監視上限超過 / blocked: 自力解決不可',
    },
    summary: { type: 'string', description: 'needs-fix / unresolved-comments の場合は対応に必要な情報の全文' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['pushed', 'summary'],
  properties: {
    pushed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

const CLOSE_SCHEMA = {
  type: 'object',
  required: ['closed', 'summary'],
  properties: {
    closed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

function implementPrompt(item) {
  const title = sanitize(item.title)
  return [
    `イシュー #${item.number}「${title}」を実装し PR を作成する担当エージェント。`,
    COMMON,
    '手順:',
    '1. git status が clean か確認する。差分が残っていれば作業せず prNumber: 0 と理由を返す。',
    `2. git fetch origin && git checkout -B feat/issue-${item.number} origin/${baseBranch} で作業ブランチを作成する。`,
    '3. .claude/skills/implement-issue/SKILL.md のフローに従う。ただしユーザー承認ステップは本ワークフローでは省略し、計画を _/local-plans/ に書いたら自己レビューのうえ即実装に進む。',
    '4. .claude/skills/implement-review/SKILL.md に従いセルフレビュー（品質 + セキュリティ）を実施し、指摘は重要度を問わずすべて修正する。',
    '5. .claude/skills/create-commit/SKILL.md に従い Conventional Commits でコミットする。',
    `6. .claude/skills/create-pr/SKILL.md に従い base ${baseBranch} で PR を作成する。body に必ず「Closes #${item.number}」を含める。`,
    '返却: prNumber（失敗時 0）/ branch / summary（実装内容の要約。失敗時は理由と現状）。',
  ].join('\n')
}

function monitorPrompt(item, impl) {
  return [
    `PR #${impl.prNumber}（イシュー #${item.number}）の CI 監視・レビューコメント確認・マージ判定の担当。修正作業は行わない。`,
    COMMON,
    '手順:',
    `1. gh pr checks ${impl.prNumber} --watch --interval 60 で全チェック完了まで監視する（Bash の timeout に 600000 を指定し、コマンドがタイムアウトしたら同コマンドを再実行。再実行は 4 回まで = 最長およそ 40 分）。`,
    '2. 全チェック完了後の CI 判定:',
    '   - 失敗チェックがあれば gh run view --log-failed 等で原因を特定し state: needs-fix。summary に修正に必要な情報をすべて書く。',
    '   - マージコンフリクトがあれば state: needs-fix とし、summary にコンフリクト解消が必要と書く。',
    `3. CI が全 green の場合、GraphQL API でレビュースレッドの全件を確認する（100 件超はページネーション必須）:`,
    `   cursor=""; hasNextPage=true; unresolved=()`,
    `   while $hasNextPage: gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved comments(last:1){nodes{body author{login}}}}pageInfo{hasNextPage endCursor}}}}}' -F owner="{owner}" -F name="{repo}" -F number=${impl.prNumber} -F cursor="$cursor"`,
    `   → 各ページの isResolved:false スレッドを unresolved に追加し、pageInfo.hasNextPage/endCursor で次ページへ進む。`,
    '   - unresolved が 1 件でもあれば state: unresolved-comments。summary に各未解決スレッドの最終コメント内容（author + body）をすべて列挙する。',
    '   - 全スレッド解決済み（または未解決スレッドなし）の場合のみ次のステップに進む。',
    `4. CI 全 green かつ未解決レビューコメントなしなら gh pr merge ${impl.prNumber} --squash --delete-branch でマージする。`,
    `5. マージ後、gh issue view ${item.number} --json state でクローズを確認し、open のままなら gh issue close ${item.number} する。git checkout ${baseBranch} && git pull origin ${baseBranch} で作業コピーを最新化する。`,
    '6. 監視上限まで待っても完了しない場合は state: timeout。自力で解決できない事象は state: blocked。',
    '返却: state / summary。',
  ].join('\n')
}

function fixPrompt(item, impl, finding) {
  const branch = sanitize(impl.branch)
  return [
    `PR #${impl.prNumber}（イシュー #${item.number}、ブランチ ${branch}）への指摘を修正する担当。`,
    COMMON,
    '指摘内容:',
    sanitize(finding.summary),
    '手順:',
    `1. git fetch origin && git checkout ${branch} && git pull origin ${branch}。コンフリクト解消が必要な場合は origin/${baseBranch} をマージして解消する。`,
    '2. 指摘を重要度を問わずすべて修正する。',
    `3. .claude/skills/create-commit/SKILL.md に従いコミットし、git push origin ${branch} で反映する。`,
    '4. unresolved-comments の指摘を修正した場合は、対応したスレッドを gh api graphql の resolveReviewThread ミューテーションで解決済みにマークする（可能な場合）。',
    '返却: pushed / summary。',
  ].join('\n')
}

function closePrompt(item) {
  const title = sanitize(item.title)
  return [
    `親イシュー #${item.number}「${title}」の完了検証とクローズの担当。配下の子イシューは本ワークフローで処理済み。`,
    COMMON,
    '手順:',
    `1. gh api "repos/{owner}/{repo}/issues/${item.number}/sub_issues?per_page=100" をページネーション（page=1,2,...）で全件取得し、全子イシューが closed であることを確認する。open が残っていれば closed: false で理由を返す。`,
    `2. gh issue view ${item.number} で本文の受入基準・チェックリストを読み、子イシューのマージ済み PR で満たされているか確認する。`,
    `3. 満たされていれば完了サマリーをコメントしてから gh issue close ${item.number} する。実装漏れ・残課題がある場合はクローズせず closed: false で残課題を summary に書く。`,
    '返却: closed / summary。',
  ].join('\n')
}

phase('Plan')
const tree = await agent([
  `GitHub イシューツリー取得タスク。ルートはイシュー #${parent}。`,
  COMMON,
  '手順:',
  `1. gh api repos/{owner}/{repo}/issues/${parent} でルートを取得する。`,
  '2. gh api "repos/{owner}/{repo}/issues/<n>/sub_issues?per_page=100" を再帰的に呼び、全子孫を列挙する（100 件超は page=2 以降も取得）。',
  '3. nodes にはルート自身（parent: 0、siblingIndex: 0）と全子孫を含める。各ノードの siblingIndex は、その親の sub_issues API が返した配列内での 0-indexed 位置とする（ルートは 0）。この値が実行順の正本になるため正確に記録すること。',
].join('\n'), { label: 'plan:issue-tree', phase: 'Plan', model: 'sonnet', schema: TREE_SCHEMA })

const byParent = new Map()
for (const n of tree.nodes) {
  const list = byParent.get(n.parent) ?? []
  list.push(n)
  byParent.set(n.parent, list)
}
// API 返却順（siblingIndex）で兄弟を確定的にソートする
for (const [, children] of byParent) {
  children.sort((a, b) => a.siblingIndex - b.siblingIndex)
}
const queue = []
const visited = new Set()
function visit(node) {
  if (visited.has(node.number)) return
  visited.add(node.number)
  const children = byParent.get(node.number) ?? []
  for (const child of children) visit(child)
  queue.push({ ...node, kind: children.length > 0 ? 'verify-close' : 'implement' })
}
const root = tree.nodes.find((n) => n.number === parent)
if (!root) throw new Error(`ルートイシュー #${parent} がツリー取得結果に含まれていない`)
visit(root)
const openImpl = queue.filter((q) => q.kind === 'implement' && q.state === 'open').length
log(`実行キュー ${queue.length} 件（うち実装対象 ${openImpl} 件）を post-order で構築した`)

const results = []
let halted = null
for (const item of queue) {
  if (item.state !== 'open') {
    results.push({ issue: item.number, status: 'skipped', note: 'すでに closed' })
    continue
  }
  if (item.kind === 'verify-close') {
    const v = await agent(closePrompt(item), { label: `close:#${item.number}`, phase: 'Merge', model: 'sonnet', schema: CLOSE_SCHEMA })
    if (v?.closed) {
      results.push({ issue: item.number, status: 'closed', note: v.summary })
    } else {
      halted = { issue: item.number, reason: `親イシューのクローズ検証に失敗した: ${v?.summary ?? 'agent error'}` }
      break
    }
    continue
  }

  log(`#${item.number} の実装を開始: ${item.title}`)
  const impl = await agent(implementPrompt(item), { label: `impl:#${item.number}`, phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA })
  if (!impl || !impl.prNumber) {
    halted = { issue: item.number, reason: impl?.summary ?? '実装エージェントが異常終了した' }
    break
  }

  let merged = false
  let lastState = 'timeout'
  let fixCount = 0
  // fix は最大 6 回。7 回目の monitor は 6 回目 fix 後の再確認専用（fix を起動しない）
  for (let round = 0; round < 7 && !merged; round++) {
    const m = await agent(monitorPrompt(item, impl), { label: `merge:#${item.number}`, phase: 'Merge', model: 'sonnet', schema: MERGE_SCHEMA })
    lastState = m?.state ?? 'blocked'
    if (lastState === 'merged') {
      merged = true
      results.push({ issue: item.number, status: 'merged', pr: impl.prNumber, note: m.summary })
    } else if (lastState === 'needs-fix' || lastState === 'unresolved-comments') {
      if (fixCount >= 6) {
        lastState = 'blocked'
        break
      }
      fixCount++
      log(`PR #${impl.prNumber} に修正が必要（${lastState}）、修正エージェントを起動する（${fixCount}/6 回目）`)
      const f = await agent(fixPrompt(item, impl, m), { label: `fix:#${item.number}`, phase: 'Implement', model: 'opus', schema: FIX_SCHEMA })
      if (!f?.pushed) {
        lastState = 'blocked'
        break
      }
    } else if (lastState === 'blocked') {
      break
    }
    // timeout は次ラウンドで再監視する
  }
  if (!merged) {
    halted = { issue: item.number, pr: impl.prNumber, reason: `マージに到達できなかった（最終状態: ${lastState}）` }
    break
  }
}

if (halted) log(`中断: #${halted.issue} — ${halted.reason}`)
return { parent, baseBranch, total: queue.length, done: results, halted }

export const meta = {
  name: 'implement-issue-tree',
  description: '親イシュー配下のサブイシューを依存順を保ちつつ worktree で並列に実装・レビュー・PR 作成・squash merge まで自動化する',
  whenToUse: '親イシュー番号を指定してサブイシュー群（孫含む）を依存順を保ちつつ並列に自動開発するとき',
  phases: [
    { title: 'Restore', detail: '状態ファイルの読み込み・再開情報の復元' },
    { title: 'Plan', detail: 'イシューツリー取得・機能的依存の抽出・並列実行順の決定' },
    { title: 'State', detail: '状態ファイル更新（進捗・worktree パスの記録）' },
    { title: 'Implement', detail: 'イシューごとの実装・レビュー・修正・PR 作成（worktree 並列）', model: 'opus' },
    { title: 'Merge', detail: 'CI / Bugbot 監視・レビューコメント全解決確認・squash merge・クローズ', model: 'sonnet' },
  ],
}

// args は string で渡される場合がある（Workflow args は string 防御）
const parsedArgs = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return args } })()
  : args
const parent = Number(
  parsedArgs && typeof parsedArgs === 'object' ? (parsedArgs.parent ?? parsedArgs.issue) : parsedArgs,
)
const baseBranch = sanitizeBranch((parsedArgs && typeof parsedArgs === 'object' && parsedArgs.branch) || 'main')
// 並列実行数（1〜8、既定 3）。1 を指定すると従来どおりの直列実行になる
const concurrency = (() => {
  const p = Number(parsedArgs && typeof parsedArgs === 'object' ? parsedArgs.parallel : undefined)
  return Number.isInteger(p) && p >= 1 && p <= 8 ? p : 3
})()

if (!Number.isInteger(parent) || parent <= 0) {
  throw new Error('親イシュー番号を args で指定すること（例: {"parent": 1008, "branch": "main", "parallel": 3}）')
}

// 状態ファイルのパス（メインリポルート相対）
// parent は整数検証済みなのでファイル名として安全に使用できる
const STATE_FILE = `_/issue-trees/${parent}.json`

// GitHub API から取得した文字列をエージェントプロンプトに埋め込む前にサニタイズする
// バッククォート・バックスラッシュ・改行・ドル記号によるプロンプトインジェクションを軽減する
function sanitize(str) {
  return String(str)
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\\/g, '/')
    .replace(/\$/g, '\\$')
}

// ブランチ名として不正な文字（スペース・セミコロン等）を拒否する
function sanitizeBranch(str) {
  const s = sanitize(str)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_./]*$/.test(s)) {
    throw new Error(`不正なブランチ名: ${s}`)
  }
  return s
}

// エージェント返却値の整数検証
function assertInt(val, label) {
  if (!Number.isInteger(val) || val <= 0) throw new Error(`${label} が正の整数ではない: ${val}`)
  return val
}

// worktree パスのホワイトリスト検証
// 英数字・スラッシュ・ハイフン・アンダースコア・ドット・スペースのみ許可。
// 先頭は英数字か '/'、'..' 連続（ディレクトリトラバーサル）は不許可。
// 不正な場合は '' を返す（throw しない。呼び出し側でスキップ判定する）。
function sanitizeWorktreePath(p) {
  if (typeof p !== 'string' || p === '') return ''
  if (/\.\./.test(p)) return ''
  if (!/^[a-zA-Z0-9/][a-zA-Z0-9\-_./ ]*$/.test(p)) return ''
  return p
}

const COMMON = [
  `リポジトリ: カレントディレクトリ（base branch: ${baseBranch}）。`,
  '自動運転モード: ユーザーへの質問・承認待ちは不可。判断が必要なら安全側に倒して進める。',
  '対象リポジトリの CLAUDE.md・.claude/rules・テスト実行規約・コーディング規約があれば必ず読んで従う。',
  '対象リポジトリに delegation ルールや専門サブエージェントがあれば、それに従い役割単位で委譲する。',
  'ドキュメント・コミット件名・PR 本文は対象リポジトリの言語規約に従う（規約がなければ日本語で書く）。',
  'gh / git fetch / git push などネットワークを使うコマンドは sandbox 無効で実行する。',
  'コミットは pre-commit フックを必ず通す（--no-verify 禁止）。非対話実行で stdin 待ちのフックがハングする場合は git commit に </dev/null を付ける。',
  'git push は pre-push フックが長時間かかる場合があるため、Bash の timeout に 600000 を指定する。',
  '複数イシューが並列実行されている。グローバル状態（メイン working copy のブランチ・共有設定）を変更しない。',
].join('\n')

const TREE_SCHEMA = {
  type: 'object',
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title', 'state', 'parent', 'siblingIndex', 'dependsOn'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          state: { type: 'string', description: 'open または closed' },
          parent: { type: 'number', description: '直上の親イシュー番号。ルート自身は 0' },
          siblingIndex: { type: 'number', description: '親の sub_issues API 返却における 0-indexed 位置。ルート自身は 0' },
          dependsOn: {
            type: 'array',
            items: { type: 'number' },
            description: '機能的に先行完了が必須のイシュー番号のみ（本文の明示的な依存記述・前提実装）。単なる関連やコンフリクトの可能性だけなら含めず空配列',
          },
        },
      },
    },
  },
}

// worktreePath を追加: 中断後にユーザーが残骸 worktree を特定・掃除できるようにする
const IMPL_SCHEMA = {
  type: 'object',
  required: ['prNumber', 'branch', 'summary'],
  properties: {
    prNumber: { type: 'number', description: '作成した PR 番号。作成できなければ 0' },
    branch: { type: 'string' },
    summary: { type: 'string' },
    worktreePath: { type: 'string', description: 'pwd の結果（worktree の絶対パス）。空文字でも可' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['state', 'summary'],
  properties: {
    state: {
      type: 'string',
      enum: ['merged', 'needs-fix', 'unresolved-comments', 'timeout', 'blocked'],
      description: 'merged: マージ成功 / needs-fix: CI 失敗・Bugbot 指摘・コンフリクト / unresolved-comments: レビューコメント未解決 / timeout: 監視上限超過 / blocked: 自力解決不可',
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
    worktreePath: { type: 'string', description: 'pwd の結果（worktree の絶対パス）。空文字でも可' },
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

// 状態ファイルの読み込みスキーマ（additionalProperties 許可で柔軟に受け取る）
const STATE_LOAD_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'object',
      description: 'issue 番号（文字列キー）→ 状態オブジェクトのマップ。空オブジェクトも可',
      additionalProperties: true,
    },
  },
  additionalProperties: true,
}

// 状態書き込み確認スキーマ
const STATE_WRITE_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
  },
}

// --- 状態ファイル書き込みミューテックス ---
// parallel > 1 で複数の runOne が同時に updateState / initAllPending を呼ぶと
// jq の read-modify-write が競合して last-writer-wins で進捗が消える。
// 書き込み操作を Promise チェーンで直列化することで常に 1 つの jq だけが動く状態にする。
let stateQueue = Promise.resolve()
function enqueueStateWrite(fn) {
  const next = stateQueue.then(fn, fn) // 前段が失敗してもチェーンを止めない
  stateQueue = next.catch(() => {})
  return next
}

// --- 状態ファイル操作ヘルパー ---

// 状態ファイルを読み込む（存在しなければ初期 JSON を作成して返す）
// monitor / close エージェント（isolation なし）はメインリポの cwd で動くため _/ に直接アクセスできる
async function loadState() {
  const result = await agent(
    [
      `状態ファイル読み込みタスク。`,
      `${STATE_FILE} が存在すれば cat でそのまま内容を読み取り、items フィールドとして返す。`,
      `存在しなければ mkdir -p _/issue-trees を実行し、`,
      `{"parent":${parent},"baseBranch":"${baseBranch}","parallel":${concurrency},"updatedAt":"","items":{}} を`,
      `${STATE_FILE} に書き込んでから、その内容を items として返す。`,
      `返却: items（JSON オブジェクト。空でも可）。`,
    ].join('\n'),
    { label: 'state:load', phase: 'Restore', model: 'haiku', schema: STATE_LOAD_SCHEMA },
  )
  return result?.items ?? {}
}

// 指定イシューの状態を patch でマージ更新する（jq で安全に書き戻す）
// patch の値はすべて JSON.stringify 経由で埋め込む（インジェクション対策）
// issue 番号は整数検証済みのものだけ渡す
// options.cleanupWorktree: string のとき、そのパスを削除対象として worktree 削除と worktree フィールドのクリアを同エージェント内で実施する
//                          true のとき、patch.worktree を削除対象として同様に実施する
//                          falsy のとき、削除処理を行わない
// worktreePath は JSON.stringify 経由でプロンプトに埋め込むため、エージェント返却値由来でも安全に扱える
async function updateState(issueNumber, patch, options = {}) {
  assertInt(issueNumber, 'updateState issueNumber')
  // patch を JSON シリアライズしてプロンプトに安全に埋め込む
  const patchJson = JSON.stringify(patch)

  // worktreePath はホワイトリスト検証を通過したものだけを削除対象にする
  const rawCleanupPath =
    typeof options.cleanupWorktree === 'string'
      ? options.cleanupWorktree
      : options.cleanupWorktree
        ? (patch.worktree ?? '')
        : ''
  const cleanupWorktreePath = sanitizeWorktreePath(rawCleanupPath)
  // worktreePath は JSON.stringify 経由でエスケープしてプロンプトに埋め込む（インジェクション対策）
  const cleanupPathJson = JSON.stringify(cleanupWorktreePath)

  const cleanupInstructions = cleanupWorktreePath
    ? [
        ``,
        `worktree 削除タスク（同一エージェントで実施）:`,
        `対象パス: ${cleanupPathJson}`,
        `1. 対象パスが空文字なら何もしない。`,
        `2. git worktree list --porcelain を実行し、出力に対象パス（${cleanupPathJson}）が含まれるか確認する。`,
        `   メインリポ自身（先頭エントリの worktree 行）は絶対に削除しない。`,
        `3. 含まれる場合: パスをシェル変数に格納してから削除する（インジェクション防止のため必ずこの手順を守る）:`,
        `     p=${cleanupPathJson}`,
        `     git worktree remove --force -- "$p"`,
        `   （merge 済みのため --force でよい。クリーン確認は不要）`,
        `   含まれない場合・すでに存在しない場合: 何もせず正常終了する。`,
        `4. 削除後（または削除不要の場合も）: git worktree prune を実行する。`,
        `5. 削除完了後、${STATE_FILE} の .items["${issueNumber}"].worktree を "" に更新する。`,
        `   更新方法（mktemp で衝突回避・--argjson でインジェクション対策）:`,
        `     tmp=$(mktemp "${STATE_FILE}.XXXXXX")`,
        `     jq --argjson patch '{"worktree":""}' '.items["${issueNumber}"] = ((.items["${issueNumber}"] // {}) + $patch) | .updatedAt = $ts' --arg ts "$(date -u +%FT%TZ)" ${STATE_FILE} > "$tmp" && mv "$tmp" ${STATE_FILE}`,
      ].join('\n')
    : ''

  const result = await enqueueStateWrite(() =>
    agent(
      [
        `状態ファイル更新タスク。`,
        `${STATE_FILE} の .items["${issueNumber}"] に以下の JSON をマージし、`,
        `.updatedAt を \`date -u +%FT%TZ\` の値に更新して書き戻す。`,
        `マージする JSON: ${patchJson}`,
        `書き戻し方法: jq コマンドで行い、mktemp で一時ファイルを作成して安全に上書きする（衝突回避）。`,
        `例:`,
        `  tmp=$(mktemp "${STATE_FILE}.XXXXXX")`,
        `  jq --argjson patch '${patchJson}' '.items["${issueNumber}"] = ((.items["${issueNumber}"] // {}) + $patch) | .updatedAt = $ts' --arg ts "$(date -u +%FT%TZ)" ${STATE_FILE} > "$tmp" && mv "$tmp" ${STATE_FILE}`,
        cleanupInstructions,
        `返却: ok: true（成功時）/ ok: false（失敗時）。`,
      ].join('\n'),
      { label: `state:update:#${issueNumber}`, phase: 'State', model: 'haiku', schema: STATE_WRITE_SCHEMA },
    ),
  )
  if (result?.ok !== true) {
    log(`⚠️ 状態ファイル更新失敗（issue #${issueNumber}）: エージェントが ok:false を返した`)
  }
}

// 全イシューを pending で一括初期化する（既存状態があるものは上書きしない）
// 1 回の haiku エージェントでまとめて処理する
async function initAllPending(queueItems) {
  // キューの各アイテムを { type, status: "pending", ... } で初期化する JSON を構築する
  const initEntries = queueItems.map((item) => ({
    number: item.number,
    type: item.kind === 'verify-close' ? 'verify-close' : 'implement',
  }))
  const initJson = JSON.stringify(initEntries)
  const result = await enqueueStateWrite(() =>
    agent(
      [
        `状態ファイル一括初期化タスク。`,
        `以下のイシューリストについて、${STATE_FILE} の .items に存在しないエントリのみ追加する（既存エントリは上書きしない）。`,
        `追加するエントリの初期値: {"status":"pending","pr":0,"branch":"","worktree":"","fixCount":0,"note":""}`,
        `イシューリスト（JSON 配列）: ${initJson}`,
        `jq を使い mktemp で一時ファイルを作成して安全に上書きする（衝突回避）。`,
        `ヒント: reduce を使って各エントリを条件付きで追加できる。`,
        `例:`,
        `  tmp=$(mktemp "${STATE_FILE}.XXXXXX")`,
        `  jq --argjson entries '${initJson}' 'reduce $entries[] as $e (.; if .items[($e.number|tostring)] == null then .items[($e.number|tostring)] = {"type":$e.type,"status":"pending","pr":0,"branch":"","worktree":"","fixCount":0,"note":""} else . end) | .updatedAt = $ts' --arg ts "$(date -u +%FT%TZ)" ${STATE_FILE} > "$tmp" && mv "$tmp" ${STATE_FILE}`,
        `返却: ok: true（成功時）/ ok: false（失敗時）。`,
      ].join('\n'),
      { label: 'state:init-all', phase: 'State', model: 'haiku', schema: STATE_WRITE_SCHEMA },
    ),
  )
  if (result?.ok !== true) {
    log(`⚠️ 状態ファイル一括初期化失敗: エージェントが ok:false を返した`)
  }
}

function implementPrompt(item) {
  const title = sanitize(item.title)
  return [
    `イシュー #${item.number}「${title}」を実装し PR を作成する担当エージェント。`,
    COMMON,
    '手順:',
    `0. まず既存 PR・ブランチを確認する（中断再開・重複 PR 防止）:`,
    `   a. 以下の 2 通りでイシュー #${item.number} に対応する open PR が既にないか確認する:`,
    `      - gh pr list --state open --search "Closes #${item.number}" --json number,title,headRefName`,
    `      - gh pr list --state open --search "${item.number} in:title" --json number,title,headRefName`,
    `      両コマンドの出力を合わせてイシュー #${item.number} に対応する open PR を探す。`,
    `   b. open PR が見つかった場合は新規 PR を作らず、そのブランチを git fetch origin && git checkout <branch> で取得して続きから作業し、既存 PR 番号を prNumber として返す。`,
    `   c. open PR がない場合は手順 1 以降に進む。`,
    '1. 本エージェントは隔離された git worktree 内で動作する。メイン working copy や他の worktree には触れず、作業はカレントの worktree 内に限定する。git status が clean か確認し、差分が残っていれば作業せず prNumber: 0 と理由を返す。',
    `2. git fetch origin && git checkout -B <type>/${item.number}-<short-name> origin/${baseBranch} で作業ブランチを作成する（type は feat / fix 等の Conventional Commits 規約。並列実行時のブランチ名衝突を防ぐためイシュー番号を必ず含める）。`,
    '3. implement-issue スキルのフローに従う。ただしユーザー承認ステップは本ワークフローでは省略し、計画を _/local-plans/ に書いたら自己レビューのうえ即実装に進む。',
    '4. 実装は対象リポジトリの delegation ルール・専門サブエージェントがあればそれに従い役割単位で委譲する。対象リポジトリの CLAUDE.md・rules（migration・スキーマ等の不変条件を含む）を必ず守る。',
    '5. 完了条件: 対象リポジトリのテスト実行規約に従い、ビルド・lint・テストを実行して pass すること。フォーマッタ・静的解析があればコミット前に通す。',
    '6. implement-review スキルに従いセルフレビュー（品質 + セキュリティ）を実施し、指摘は重要度を問わず（要改善レベルも含め）すべて修正する。',
    '7. create-commit スキルに従い Conventional Commits でコミットする（type/scope は英語、件名は対象リポジトリの言語規約に従う）。',
    `8. create-pr スキルに従い base ${baseBranch} で PR を作成する。body に必ず「Closes #${item.number}」を含める。`,
    '9. pwd の結果を worktreePath として返す（worktree の絶対パスを記録するため）。',
    '返却: prNumber（失敗時 0）/ branch / summary（実装内容の要約。失敗時は理由と現状）/ worktreePath（pwd の結果）。',
  ].join('\n')
}

function monitorPrompt(item, impl) {
  return [
    `PR #${impl.prNumber}（イシュー #${item.number}）の CI / Bugbot 監視・レビューコメント確認・マージ判定の担当。修正作業は行わない。`,
    COMMON,
    '手順:',
    `1. まず現在の HEAD sha を取得して固定する: gh pr view ${impl.prNumber} --json headRefOid -q .headRefOid。fix 後に再監視するたびに取り直す（古い sha を参照しないため）。`,
    `2. gh pr checks ${impl.prNumber} --watch --interval 60 で全チェック完了まで監視する（Bash の timeout に 600000 を指定し、コマンドがタイムアウトしたら同コマンドを再実行。再実行は 4 回まで = 最長およそ 40 分）。`,
    `3. watch 完了後、gh pr checks ${impl.prNumber} の出力で全チェックの結論を列挙して確認する。「watch が終わった」だけでは合格にしない。以下を厳密に確認する:`,
    '   a. 全チェックが success / neutral / skipped で完了していること（failure / cancelled / timed_out が 0 件）。',
    '   b. pending / queued / in_progress が 0 件であること。残っていれば再 watch する。',
    '   c. いずれかが failure / cancelled / timed_out の場合: gh run view --log-failed 等で原因を特定し state: needs-fix。summary に修正に必要な情報をすべて書く。変更と無関係な flaky と明確に判断できる場合に限り 1 回だけ gh run rerun <run-id> --failed で再実行して再監視する。再発した場合や変更起因の場合は state: needs-fix。',
    '   d. マージコンフリクトがあれば state: needs-fix とし、summary にコンフリクト解消が必要と書く。',
    `4. CI が全 green になったら HEAD sha に対する Bugbot（cursor[bot]）レビューを確認する:`,
    `   a. gh api "repos/{owner}/{repo}/pulls/${impl.prNumber}/reviews" で cursor[bot] のレビュー一覧を取得し、commit_id が手順 1 で取得した HEAD sha と一致するレビューがあるかを確認する。`,
    `   b. HEAD sha に対する cursor[bot] レビューがまだない場合: HEAD push から 1 分以上経過しても Bugbot チェックが開始していなければ、HEAD push 以降に "@cursor review" コメントが未投稿であることを確認したうえで gh pr comment ${impl.prNumber} --body "@cursor review" を 1 回だけ投稿し、開始・完了を最大 5 分待つ。投稿しても到着しない場合は再投稿せず Bugbot レビューなしとして扱い先へ進む（マージをブロックしない）。`,
    `   c. HEAD sha に対する cursor[bot] レビューが到着したら内容を確認する。新規バグ指摘があれば CI が pass でも state: needs-fix とし指摘全文を summary に含める。過去コミットへの指摘で対応するレビュースレッドが resolved 済みのものは needs-fix の根拠にしない（修正済み指摘の再検出による偽 needs-fix を防ぐ）。`,
    `5. CI 全 green（pending/failure 0 件）かつ HEAD sha に対する Bugbot 指摘なし（またはレビューなし確定）の場合、GraphQL API でレビュースレッドの全件を確認する（100 件超はページネーション必須）:`,
    '   cursor=""; hasNextPage=true; unresolved=()',
    `   while $hasNextPage: gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved comments(last:1){nodes{body author{login}}}}pageInfo{hasNextPage endCursor}}}}}' -F owner="{owner}" -F name="{repo}" -F number=${impl.prNumber} -F cursor="$cursor"`,
    '   → 各ページの isResolved:false スレッドを unresolved に追加し、pageInfo.hasNextPage/endCursor で次ページへ進む。',
    '   - unresolved が 1 件でもあれば state: unresolved-comments。summary に各未解決スレッドの最終コメント内容（author + body）をすべて列挙する。',
    '   - 全スレッド解決済み（または未解決スレッドなし）の場合のみ次のステップに進む。',
    `6. CI 全 green（pending/failure 0 件）・HEAD sha に対する Bugbot 指摘なし（またはレビューなし確定）・未解決レビューコメントなしの全条件が揃ったら gh pr merge ${impl.prNumber} --squash --delete-branch でマージする。`,
    `7. マージ後、gh issue view ${item.number} --json state でクローズを確認し、open のままなら gh issue close ${item.number} する。他のイシューが並列実行中のため、working copy のブランチ切り替えや git pull は行わない。`,
    '8. 監視上限まで待っても完了しない場合は state: timeout。自力で解決できない事象は state: blocked。',
    '返却: state / summary。',
  ].join('\n')
}

function fixPrompt(item, impl, finding) {
  const branch = sanitizeBranch(impl.branch)
  return [
    `PR #${impl.prNumber}（イシュー #${item.number}、ブランチ ${branch}）への指摘を修正する担当。`,
    COMMON,
    '指摘内容:',
    sanitize(finding.summary),
    '手順:',
    `1. 本エージェントは隔離された git worktree 内で動作する。ブランチ ${branch} は他の worktree で checkout 済みの可能性があるため、git fetch origin && git checkout --detach origin/${branch} で detached HEAD として取得して作業する。マージコンフリクトの解消が必要な場合は git merge origin/${baseBranch} を実行して解消する。`,
    '2. 指摘を重要度を問わずすべて修正する（実装は対象リポジトリの delegation ルール・専門サブエージェントがあればそれに従い委譲する）。対象リポジトリの CLAUDE.md・rules の不変条件（migration・スキーマ等）を守る。',
    '3. 対象リポジトリのテスト実行規約に従い、ビルド・lint・テストを実行して通す。',
    `4. create-commit スキルに従いコミットし、git push origin HEAD:refs/heads/${branch} で反映する。`,
    '5. unresolved-comments の指摘を修正した場合は、対応したスレッドを gh api graphql の resolveReviewThread ミューテーションで解決済みにマークする（可能な場合）。',
    '6. pwd の結果を worktreePath として返す（worktree の絶対パスを記録するため）。',
    '返却: pushed / summary / worktreePath（pwd の結果）。',
  ].join('\n')
}

function closePrompt(item) {
  const title = sanitize(item.title)
  return [
    `親イシュー #${item.number}「${title}」の完了検証とクローズの担当。配下の子イシューは本ワークフローで処理済み。`,
    COMMON,
    '手順:',
    `1. gh api "repos/{owner}/{repo}/issues/${item.number}/sub_issues?per_page=100" をページネーション（page=1,2,...）で全件取得し、全子イシューが closed であることを確認する。open が残っていれば closed: false で理由を返す。`,
    `2. gh issue view ${item.number} で本文の受入基準・チェックリストを読み、子イシューのマージ済み PR で満たされているか確認する。満たされたチェックボックスは更新してよい。`,
    `3. 満たされていれば完了サマリーをコメントしてから gh issue close ${item.number} する。実装漏れ・残課題がある場合はクローズせず closed: false で残課題を summary に書く。`,
    '返却: closed / summary。',
  ].join('\n')
}

// --- Restore フェーズ: 状態ファイルを読み込む ---
phase('Restore')
const savedItems = await loadState()
log(`状態ファイルを読み込んだ（既存エントリ: ${Object.keys(savedItems).length} 件）`)

phase('Plan')
const tree = await agent([
  `GitHub イシューツリー取得タスク。ルートはイシュー #${parent}。`,
  COMMON,
  '手順:',
  `1. gh api repos/{owner}/{repo}/issues/${parent} でルートを取得する。`,
  '2. gh api "repos/{owner}/{repo}/issues/<n>/sub_issues?per_page=100" を再帰的に呼び、全子孫を列挙する（100 件超は page=2 以降も取得）。',
  '3. nodes にはルート自身（parent: 0、siblingIndex: 0）と全子孫を含める。各ノードの siblingIndex は、その親の sub_issues API が返した配列内での 0-indexed 位置とする（ルートは 0）。この値が実行順の正本になるため正確に記録すること。',
  '4. 各 open ノードについて gh issue view <n> で本文を読み、dependsOn に「機能的に先行完了が必須」のイシュー番号のみを入れる。対象は本文に明示された依存記述（「依存:」「Depends on」「Blocked by」等）と、そのイシューの成果物（型・API・スキーマ等）を前提にしないと実装が成立しないものだけ。判断に迷う場合・単なる関連・同じファイルを触りそうというだけの場合は含めない（コンフリクトは後段の修正ループで解消されるため空配列でよい）。',
].join('\n'), { label: 'plan:issue-tree', phase: 'Plan', model: 'sonnet', schema: TREE_SCHEMA })

// エージェント返却値の整数検証（スキーマ宣言のみに依存しない）
for (const n of tree.nodes) {
  assertInt(n.number, `tree.nodes[].number`)
  if (!Number.isInteger(n.parent) || n.parent < 0) throw new Error(`tree.nodes[].parent が非負整数ではない: ${n.parent}`)
  // siblingIndex は実行順ソートの正本のため欠落・非整数を拒否する
  if (!Number.isInteger(n.siblingIndex) || n.siblingIndex < 0) {
    throw new Error(`tree.nodes[].siblingIndex が非負整数ではない: ${n.siblingIndex}（issue #${n.number}）`)
  }
}

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
const unreachable = tree.nodes.filter((n) => !visited.has(n.number))
if (unreachable.length > 0) {
  throw new Error(
    `Plan が返したノードのうち ${unreachable.length} 件がルート #${parent} から到達不能: ` +
    unreachable.map((n) => `#${n.number}（parent: ${n.parent}）`).join(', '),
  )
}
const openImpl = queue.filter((q) => q.kind === 'implement' && q.state === 'open').length
log(`実行キュー ${queue.length} 件（うち実装対象 ${openImpl} 件）を post-order で構築した（並列度 ${concurrency}）`)

// --- キュー確定後: 全ノードを pending で一括初期化（既存エントリは保持）---
await initAllPending(queue)

const results = []
const failures = []
let consecutiveFailures = 0
let halted = null

// 失敗を記録する。完了できないイシューがあっても即停止せず次へ進み、
// 3 イシュー連続で停滞した場合のみ新規着手を止めてユーザーの判断を待つ
function recordFailure(failure) {
  failures.push(failure)
  results.push({ issue: failure.issue, status: 'failed', pr: failure.pr, note: failure.reason })
  consecutiveFailures++
  log(`#${failure.issue} を完了できず次へ進む（${consecutiveFailures} 連続）: ${failure.reason}`)
  if (consecutiveFailures >= 3 && !halted) {
    halted = {
      reason: '3 イシュー連続で完了できなかったため新規着手を停止する。ユーザーの判断を待つこと',
      issues: failures.slice(-3).map((f) => f.issue),
    }
  }
}

// 親イシュー（verify-close）の完了検証とクローズ
async function runVerifyClose(item) {
  // impl 開始前に状態を implementing（verify-close の場合も同フィールドを流用）に更新
  await updateState(item.number, { status: 'implementing' })
  const v = await agent(closePrompt(item), { label: `close:#${item.number}`, phase: 'Merge', model: 'sonnet', schema: CLOSE_SCHEMA })
  if (v?.closed) {
    results.push({ issue: item.number, status: 'closed', note: v.summary })
    consecutiveFailures = 0
    // verify-close 成功 → closed に更新
    await updateState(item.number, { status: 'closed', note: String(v.summary ?? '') })
    return true
  }
  const reason = `親イシューのクローズ検証に失敗した: ${sanitize(v?.summary ?? 'agent error')}`
  await updateState(item.number, { status: 'failed', note: reason })
  recordFailure({ issue: item.number, reason })
  return false
}

// 末端イシューの実装 → 監視 → 修正 → マージ。implement / fix は worktree 隔離で並列実行する
async function runImplement(item) {
  // 状態ファイルから保存済みの情報を取得（再開判定に使用）
  const saved = savedItems[String(item.number)] ?? {}

  // monitoring から再開する場合: impl フェーズをスキップして monitor ループから開始する
  // branch が不正な場合は再開を諦めて通常の impl から実行する（最初からやり直せば回復できる）
  const savedBranchValid =
    saved.status === 'monitoring' &&
    typeof saved.branch === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9\-_./]*$/.test(saved.branch)
  const isResumeFromMonitoring = saved.status === 'monitoring' && Number.isInteger(saved.pr) && saved.pr > 0 && savedBranchValid
  if (saved.status === 'monitoring' && !isResumeFromMonitoring) {
    log(`#${item.number}: 状態ファイルの branch が不正または空のため monitoring 再開を諦め、通常の impl から実行する`)
  }
  // 保存済みの fixCount（クランプ済み）。monitoring フォールバック時の引き継ぎにも使用する
  const savedFixCount = Number.isInteger(saved.fixCount) ? Math.min(Math.max(saved.fixCount, 0), 6) : 0

  let impl
  if (isResumeFromMonitoring) {
    // 保存済みの pr / branch / fixCount を引き継いで再開する
    impl = {
      prNumber: saved.pr,
      branch: saved.branch,
      summary: '（状態ファイルから再開）',
      worktreePath: sanitizeWorktreePath(saved.worktree ?? ''),
    }
    log(`#${item.number}: 状態ファイルから monitoring 再開（PR #${impl.prNumber}、fixCount: ${savedFixCount}）`)
  } else {
    // 通常の impl フェーズを実行する（monitoring フォールバック含む）
    // impl 開始直前に状態を implementing に更新
    await updateState(item.number, { status: 'implementing' })
    impl = await agent(implementPrompt(item), { label: `impl:#${item.number}`, phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA, isolation: 'worktree' })
    if (!impl || !impl.prNumber) {
      const reason = sanitize(impl?.summary ?? '実装エージェントが異常終了した')
      await updateState(item.number, { status: 'failed', note: reason })
      recordFailure({ issue: item.number, reason })
      return false
    }
    if (!Number.isInteger(impl.prNumber) || impl.prNumber <= 0) {
      const reason = `prNumber が正の整数ではない: ${impl.prNumber}`
      await updateState(item.number, { status: 'failed', note: reason })
      recordFailure({ issue: item.number, reason })
      return false
    }
    // エージェント返却の branch 名もブランチ名として有効な文字種のみ許可する
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-_./]*$/.test(impl.branch ?? '')) {
      const reason = `branch 名が不正: ${sanitize(impl.branch ?? '(空)')}`
      await updateState(item.number, { status: 'failed', note: reason })
      recordFailure({ issue: item.number, pr: impl.prNumber, reason })
      return false
    }
    // impl が返した worktreePath もホワイトリスト検証を通す
    impl = { ...impl, worktreePath: sanitizeWorktreePath(impl.worktreePath ?? '') }
    // impl 完了直後: monitoring に遷移し pr / branch / worktree を記録する。
    // monitoring フォールバック時は中断前の fixCount を引き継ぐ（新規実行時のみ 0）
    await updateState(item.number, {
      status: 'monitoring',
      pr: impl.prNumber,
      branch: impl.branch,
      worktree: impl.worktreePath,
      fixCount: savedFixCount,
    })
  }

  let merged = false
  let lastState = 'timeout'
  // 再開時・monitoring フォールバック時は保存済みの fixCount を引き継ぐ。新規実行時のみ 0
  let fixCount = savedFixCount
  let noPushRounds = 0
  // 現在追跡中の worktree パス。impl または最後の fix の worktreePath を常に最新に保つ。
  // 再開時は状態ファイルから引き継ぐ。merged 時・fix 時の削除対象として使用する
  let currentWorktreePath = impl.worktreePath ?? ''
  // 監視は timeout 再試行を含め 7 回まで。fix は最大 6 回で、push 後は必ず 1 回以上の
  // 再監視を確保する（push した fix が再監視されないままループ終了しないように）
  let monitorsLeft = 7
  while (!merged && monitorsLeft > 0) {
    monitorsLeft--
    const m = await agent(monitorPrompt(item, impl), { label: `merge:#${item.number}`, phase: 'Merge', model: 'sonnet', schema: MERGE_SCHEMA })
    lastState = m?.state ?? 'blocked'
    if (lastState === 'merged') {
      merged = true
      results.push({ issue: item.number, status: 'merged', pr: impl.prNumber, note: m.summary })
      consecutiveFailures = 0
      // merged 確定: fixCount も同時に書く（更新まとめ）。現在追跡中の worktree を自動削除して残骸を防ぐ
      await updateState(item.number, { status: 'merged', pr: impl.prNumber, fixCount, worktree: currentWorktreePath }, { cleanupWorktree: currentWorktreePath })
    } else if (lastState === 'needs-fix' || lastState === 'unresolved-comments') {
      if (fixCount >= 6) {
        lastState = 'blocked'
        break
      }
      fixCount++
      log(`PR #${impl.prNumber} に修正が必要（${lastState}）、修正エージェントを起動する（${fixCount}/6 回目）`)
      const oldWorktreePath = currentWorktreePath
      const f = await agent(fixPrompt(item, impl, m), { label: `fix:#${item.number}`, phase: 'Implement', model: 'opus', schema: FIX_SCHEMA, isolation: 'worktree' })
      // fix が返した worktreePath もホワイトリスト検証を通して追跡パスを更新し、旧 worktree を削除する
      const newWorktreePath = sanitizeWorktreePath(f?.worktreePath ?? '')
      // 旧パスを保持し続けると stale になるため、有効・無効を問わず必ず新値で上書きする
      currentWorktreePath = newWorktreePath
      if (!newWorktreePath) {
        log(`⚠️ issue #${item.number}: fix worktree パスを取得できず追跡不能。git worktree prune での手動掃除が必要な場合あり`)
      }
      // fix 実行後: fixCount・新 worktree パスを更新し、旧 worktree を削除する
      await updateState(item.number, { fixCount, worktree: currentWorktreePath }, { cleanupWorktree: oldWorktreePath })
      if (!f?.pushed) {
        // 「指摘は修正済みで push 不要」の場合があるため即 blocked にせず 1 回だけ再監視する。
        // 2 回連続で push なしなら進展がないため blocked とする
        noPushRounds++
        if (noPushRounds >= 2) {
          lastState = 'blocked'
          break
        }
        log(`PR #${impl.prNumber} の修正エージェントは push 不要と判断、マージ条件を再判定する`)
      } else {
        noPushRounds = 0
      }
      if (monitorsLeft < 1) monitorsLeft = 1
    } else if (lastState === 'blocked') {
      break
    }
    // timeout は次ラウンドで再監視する
  }
  if (!merged) {
    const reason = `マージに到達できなかった（最終状態: ${lastState}）`
    await updateState(item.number, { status: 'failed', pr: impl.prNumber, fixCount, note: reason })
    recordFailure({ issue: item.number, pr: impl.prNumber, reason })
    return false
  }
  return true
}

async function runOne(item) {
  try {
    const ok = item.kind === 'verify-close' ? await runVerifyClose(item) : await runImplement(item)
    return { number: item.number, ok }
  } catch (e) {
    const reason = sanitize(e?.message ?? 'agent error')
    await updateState(item.number, { status: 'failed', note: reason })
    recordFailure({ issue: item.number, reason })
    return { number: item.number, ok: false }
  }
}

// --- 並列スケジューラ ---
// 待機が必要なのは「機能的依存」のみ:
//   - verify-close ノードは全子イシューの完了を待つ
//   - Plan が抽出した dependsOn（本文に明示された依存・前提実装）を待つ
// それ以外は post-order 順を優先度として空きスロットへ並列投入する。
// ファイル競合によるマージコンフリクトは待機せず、後段の修正ループで解消する。
const done = new Set()
const failedSet = new Set()
for (const item of queue) {
  if (item.state !== 'open') {
    results.push({ issue: item.number, status: 'skipped', note: 'すでに closed' })
    done.add(item.number)
  } else {
    // 状態ファイルで merged / closed のものは done 扱いにしてスキップする（再開時の防御）
    const saved = savedItems[String(item.number)] ?? {}
    if (saved.status === 'merged' || saved.status === 'closed') {
      results.push({ issue: item.number, status: saved.status, note: saved.note ?? '状態ファイルから復元（スキップ）' })
      done.add(item.number)
      log(`#${item.number}: 状態ファイルで ${saved.status} 済みのためスキップ`)
    }
  }
}
const work = queue.filter((q) => q.state === 'open' && !done.has(q.number))
const inTree = new Set(queue.map((q) => q.number))

// 依存グラフを事前構築し、解決不能な依存を除去してデッドロックを防ぐ:
//   1. 祖先イシューへの dependsOn は無視（親は子の完了を待つため本質的に循環）
//   2. 残る循環は DFS で検出し、循環を構成する dependsOn 辺を除去
//      （木の親子辺は除去対象にしない。木のみなら循環は構造上発生しない）
const depsMap = new Map()
for (const item of queue) {
  const ds = new Set()
  for (const c of byParent.get(item.number) ?? []) ds.add(c.number)
  depsMap.set(item.number, ds)
}
const parentNumOf = new Map(queue.map((q) => [q.number, q.parent]))
function isAncestor(anc, n) {
  let cur = parentNumOf.get(n)
  while (Number.isInteger(cur) && cur !== 0) {
    if (cur === anc) return true
    cur = parentNumOf.get(cur)
  }
  return false
}
for (const item of queue) {
  for (const d of item.dependsOn ?? []) {
    if (!Number.isInteger(d) || !inTree.has(d) || d === item.number) continue
    if (isAncestor(d, item.number)) {
      log(`#${item.number} の dependsOn #${d} は祖先イシューのため無視する（親は子の完了を待つ側）`)
      continue
    }
    depsMap.get(item.number).add(d)
  }
}
function findDependencyCycle() {
  const color = new Map() // undefined=未訪問 / 1=訪問中 / 2=完了
  const stack = []
  function dfs(n) {
    color.set(n, 1)
    stack.push(n)
    for (const d of depsMap.get(n) ?? []) {
      if (color.get(d) === 1) return stack.slice(stack.indexOf(d))
      if (!color.has(d)) {
        const found = dfs(d)
        if (found) return found
      }
    }
    stack.pop()
    color.set(n, 2)
    return null
  }
  for (const item of queue) {
    if (!color.has(item.number)) {
      const found = dfs(item.number)
      if (found) return found
    }
  }
  return null
}
let cycle = findDependencyCycle()
while (cycle) {
  let removed = false
  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i]
    const to = cycle[(i + 1) % cycle.length]
    const isTreeEdge = (byParent.get(from) ?? []).some((c) => c.number === to)
    if (!isTreeEdge && depsMap.get(from)?.has(to)) {
      depsMap.get(from).delete(to)
      log(`循環依存を検出: ${cycle.map((n) => `#${n}`).join(' → ')}。#${from} の dependsOn #${to} を無視する`)
      removed = true
      break
    }
  }
  // 木の親子辺のみで構成される循環は構造上発生しないため、ここに到達するのは異常データ
  if (!removed) throw new Error(`解決不能な循環依存: ${cycle.map((n) => `#${n}`).join(' → ')}`)
  cycle = findDependencyCycle()
}

function depsOf(item) {
  return depsMap.get(item.number) ?? new Set()
}

async function markBlockedByDeps(item, failedDeps) {
  failedSet.add(item.number)
  const note = `依存イシューの失敗・ブロックにより未着手: ${failedDeps.map((d) => `#${d}`).join(', ')}`
  results.push({
    issue: item.number,
    status: 'blocked',
    note,
  })
  // blocked 確定: note に理由を記録する（await して return 前に永続化を保証する）
  await updateState(item.number, { status: 'blocked', note })
  log(`#${item.number} は依存 ${failedDeps.map((d) => `#${d}`).join(', ')} の失敗により着手しない`)
}

const running = new Map()
while (true) {
  // 空きスロットへ post-order 順に投入する（halted 後は新規着手しない）
  if (!halted) {
    for (const item of work) {
      if (running.size >= concurrency) break
      const n = item.number
      if (done.has(n) || failedSet.has(n) || running.has(n)) continue
      const ds = [...depsOf(item)]
      const failedDeps = ds.filter((d) => failedSet.has(d))
      if (failedDeps.length > 0) {
        await markBlockedByDeps(item, failedDeps)
        continue
      }
      if (!ds.every((d) => done.has(d))) continue
      log(`#${n} を開始（実行中 ${running.size + 1}/${concurrency}）: ${sanitize(item.title)}`)
      running.set(n, runOne(item))
    }
  }
  if (running.size === 0) break
  const finished = await Promise.race(running.values())
  running.delete(finished.number)
  if (finished.ok) done.add(finished.number)
  else failedSet.add(finished.number)
}

// 依存失敗の連鎖を最終確定する（dispatch 順の都合で未マークのものを掃く）
let cascaded = true
while (cascaded) {
  cascaded = false
  for (const item of work) {
    const n = item.number
    if (done.has(n) || failedSet.has(n)) continue
    const failedDeps = [...depsOf(item)].filter((d) => failedSet.has(d))
    if (failedDeps.length > 0) {
      await markBlockedByDeps(item, failedDeps)
      cascaded = true
    }
  }
}
// halted により着手しなかったものも results に必ず記録する（報告漏れ防止）
const notStarted = work
  .filter((q) => !done.has(q.number) && !failedSet.has(q.number))
  .map((q) => q.number)
for (const n of notStarted) {
  results.push({ issue: n, status: 'not-started', note: 'halted により未着手' })
  // halted 時の notStarted は blocked として状態ファイルに記録する。
  // ただし既に monitoring 状態（PR 作成済み）の issue は上書きしない。
  // 状態ファイル上で monitoring かつ pr > 0 の場合は再開情報が有効なため保持する。
  const savedForN = savedItems[String(n)] ?? {}
  const isMonitoring = savedForN.status === 'monitoring' && Number.isInteger(savedForN.pr) && savedForN.pr > 0
  if (!isMonitoring) {
    await updateState(n, { status: 'blocked', note: 'halted により未着手' })
  } else {
    log(`#${n}: halt 時も monitoring 状態を維持する（PR #${savedForN.pr} の再開情報を保持）`)
  }
}
if (notStarted.length > 0) {
  log(`未着手のまま終了: ${notStarted.map((n) => `#${n}`).join(', ')}`)
}

if (halted) log(`中断: ${halted.reason}（直近の停滞イシュー: ${halted.issues.map((n) => `#${n}`).join(', ')}）`)
return { parent, baseBranch, parallel: concurrency, total: queue.length, done: results, failures, notStarted, halted }

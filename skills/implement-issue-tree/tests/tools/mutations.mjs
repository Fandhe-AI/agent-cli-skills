// mutate.mjs の既定の変異定義（Issue #603・テストの高速化で書き換えたテスト群が弱くなっていないことの確認用）。
// 1 つの変異 = 実装の 1 か所だけを壊す置換。`tests` に挙げたテストファイルのどれかが赤になれば killed。
// 形式と判定の規則は mutate.mjs の冒頭を参照。置換前の文字列は対象ファイルにちょうど 1 か所だけ当たること（実装が変わって
// 当たらなくなったら invalid と報告されるので、定義を直す）。
const BM = 'scripts/base-merge.sh'
const BM_LIB = 'scripts/lib/base-merge-lib.sh'
const PV = 'scripts/lib/push-verify.sh'
const OBS = 'scripts/observe-pr.sh'
const SRC = 'scripts/implement-issue-tree.src.js'
const BW = 'scripts/build-workflow.mjs'
const BASE_MERGE = ['base-merge.test.mjs', 'base-merge-unit.test.mjs']

export const MUTATIONS = [
  // ---- base-merge.sh の remote URL 照合（判定は lib/base-merge-lib.sh。表の単体検査と実 git の代表ケースの両方が見張る）----
  { id: 'U01-userinfo-not-stripped', file: BM_LIB, from: '      hostport=${hostport##*@}\n', to: '', tests: BASE_MERGE, note: 'https の userinfo を捨てずに host として比べる（トークン入りの正規 URL を拒否する）' },
  { id: 'U02-host-suffix', file: BM_LIB, from: '[ "${host}" = "${ALLOWED_REMOTE_HOST}" ] &&', to: '[ "${host%"${ALLOWED_REMOTE_HOST}"}" != "${host}" ] &&', tests: BASE_MERGE, note: 'host の後方一致（evilgithub.com を許す）' },
  { id: 'U04b-https-any-port', file: BM_LIB, from: 'ssh: | ssh:22 | https: | https:443 | scp:) ;;', to: 'ssh: | ssh:22 | https: | https:* | scp:) ;;', tests: BASE_MERGE, note: 'https の任意ポートを許す' },
  { id: 'U05b-whitelist-backslash', file: BM_LIB, from: '*[!A-Za-z0-9._~:/@%+-]*) return 1 ;;', to: '*[!A-Za-z0-9._~:/@%+\\\\-]*) return 1 ;;', tests: BASE_MERGE, note: '許可文字にバックスラッシュを足す（authority 偽装）' },
  { id: 'U18b-ssh-any-user', file: BM_LIB, from: '    ssh://git@*)\n      rest=${u#ssh://git@}', to: '    ssh://*@*)\n      rest=${u#ssh://*@}', tests: BASE_MERGE, note: 'ssh:// の ユーザーを git に限らない' },
  // ---- base-merge.sh の routing ガードと取り込みの流れ（実 git）----
  { id: 'U07-push-side-unchecked', file: BM_LIB, from: 'for spec in "fetch:--all" "push:--push --all"; do', to: 'for spec in "fetch:--all"; do', tests: ['base-merge.test.mjs'], note: 'push 先 URL を照合しない' },
  { id: 'U20-first-line-only', file: BM_LIB, from: 'out=$(git remote get-url "$@" origin 2>/dev/null) || return 2', to: 'out=$(git remote get-url "$@" origin 2>/dev/null | head -1) || return 2', tests: ['base-merge.test.mjs'], note: 'URL の先頭 1 行だけ照合する（複数 url の追加を見逃す）' },
  { id: 'U21-empty-geturl-ok', file: BM_LIB, from: '  [ -n "${out}" ] || return 2', to: '  [ -n "${out}" ] || return 0', tests: ['base-merge.test.mjs'], note: 'get-url が空を返しても許可する' },
  { id: 'U10-branch-fetch-unqualified', file: BM, from: 'git fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}"', to: 'git fetch origin "${branch}:refs/remotes/origin/${branch}"', tests: ['base-merge.test.mjs'], note: 'branch の fetch 元を refs/heads/ で修飾しない（同名タグが勝つ）' },
  { id: 'U25-base-not-validated', file: BM, from: 'pv_valid_branch "${base}" || usage "--base の形式が不正"', to: ':', tests: ['base-merge.test.mjs'], note: '--base の形式を検証しない' },
  { id: 'U31-read-without-r', file: BM_LIB, from: '  while IFS= read -r line; do\n    n=$((n + 1))', to: '  while IFS= read line; do\n    n=$((n + 1))', tests: ['base-merge.test.mjs'], note: 'get-url の各行を read -r なしで読む（バックスラッシュが消え、evil.example\\@github.com が github.com 宛てに見える = routing 偽装）' },
  // ---- lib/push-verify.sh（push 前後の突き合わせ）----
  { id: 'U12-no-check-ref-format', file: PV, from: '  git check-ref-format "refs/heads/$1" >/dev/null 2>&1\n}', to: '  true\n}', tests: ['push-verify.test.mjs', 'base-merge.test.mjs'], note: 'ブランチ名を git check-ref-format で検証しない' },
  { id: 'U30-follow-tags-allowed', file: PV, from: 'git push --no-follow-tags origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', to: 'git push origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', tests: ['push-verify.test.mjs', 'base-merge.test.mjs'], note: '--no-follow-tags を外す（利用者設定 push.followTags でタグが origin へ出る）' },
  { id: 'U32-force-push-refspec', file: PV, from: 'git push --no-follow-tags origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', to: 'git push --no-follow-tags origin "+HEAD:refs/heads/${branch}" >/dev/null || rc=$?', tests: ['push-verify.test.mjs', 'base-merge.test.mjs', 'script-static-guard.test.mjs'], note: 'push の refspec を +HEAD:… にする（force push。リモートが進んだブランチを上書きしうる）' },
  // ---- observe-pr.sh の壁時計・取得失敗・出力サイズ（実時間を待つテストを並行に走らせた群）----
  { id: 'O1-wall-keeps-counts', file: OBS, from: 'if [ "${err}" -ne 0 ] || [ "${inconclusive}" -eq 1 ]; then', to: 'if [ "${err}" -ne 0 ]; then', tests: ['observe-pr-inconclusive.test.mjs'], note: '壁時計 kill の封筒に直前の件数・headSha を載せる' },
  { id: 'O2-no-failonly-error', file: OBS, from: 'if [ "${ever_failed}" -eq 1 ] && [ "${ever_ok}" -eq 0 ]; then', to: 'if false; then', tests: ['observe-pr-inconclusive.test.mjs'], note: '一度も取得に成功しないまま壁時計で終わっても error にしない' },
  { id: 'O3-size-off-by-one', file: OBS, from: 'if [ $((size + 0)) -gt "${max_out}" ]; then', to: 'if [ $((size + 0)) -ge "${max_out}" ]; then', tests: ['observe-pr-inconclusive.test.mjs'], note: '出力サイズの上限ちょうどを取得失敗にする' },
  { id: 'O4-host-headsha-unchecked', file: SRC, from: "else if (typeof signed.payload.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(signed.payload.headSha)) reason = 'inconclusive'", to: "else if (false) reason = 'inconclusive'", tests: ['observe-pr-inconclusive.test.mjs'], note: 'ホストが headSha の形を検査しない（再ビルドする）' },
  { id: 'O5-no-window-margin', file: OBS, from: 'need=$((obs_max + sleep_sec + 3))', to: 'need=$((obs_max + sleep_sec + 0))', tests: ['observe-pr-bounds.test.mjs'], note: '次の観測を始める前の余裕 3 秒を外す' },
  { id: 'O6-wall-clamp-not-marked', file: OBS, from: '    if [ "${clamped}" -eq 1 ]; then\n      WALL_HIT=1\n', to: '    if [ "${clamped}" -eq 1 ]; then\n      :\n', tests: ['observe-pr-bounds.test.mjs', 'observe-pr-inconclusive.test.mjs'], note: '壁時計の縮めで kill したことを記録しない（取得失敗に倒れる）' },
  // ---- build-workflow.mjs（ビルダー）----
  { id: 'B1-rule-sign-digit-off', file: BW, from: "refuses: (prev, next) => (prev === '+' || prev === '-') && /[0-9]/.test(next) }", to: 'refuses: () => false }', tests: ['build-workflow.test.mjs'], note: '空白除去の規則 sign-digit を外す（1e- 2 を 1e-2 にしてしまう）' },
  { id: 'B2-cli-guard-no-realpath', file: BW, from: "return realpathSync(process.argv[1] ?? '')", to: "return process.argv[1] ?? ''", tests: ['build-workflow.test.mjs'], note: 'symlink 経由の起動で CLI が無言の no-op になる' },
]

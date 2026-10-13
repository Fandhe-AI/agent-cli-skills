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
const PP = 'scripts/pr-push.sh'
const PP_LIB = 'scripts/lib/pr-push-lib.sh'
const RV = 'scripts/run-verified.sh'
const PR_PUSH = ['pr-push.test.mjs', 'pr-push-unit.test.mjs']
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
  { id: 'U30-follow-tags-allowed', file: PV, from: 'git push --no-follow-tags origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', to: 'git push origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', tests: ['push-verify.test.mjs', 'base-merge.test.mjs', 'pr-push.test.mjs'], note: '--no-follow-tags を外す（利用者設定 push.followTags でタグが origin へ出る）' },
  { id: 'U32-force-push-refspec', file: PV, from: 'git push --no-follow-tags origin "HEAD:refs/heads/${branch}" >/dev/null || rc=$?', to: 'git push --no-follow-tags origin "+HEAD:refs/heads/${branch}" >/dev/null || rc=$?', tests: ['push-verify.test.mjs', 'base-merge.test.mjs', 'pr-push.test.mjs', 'script-static-guard.test.mjs'], note: 'push の refspec を +HEAD:… にする（force push。リモートが進んだブランチを上書きしうる）' },
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
  // ---- pr-push.sh と lib/pr-push-lib.sh（第 4 弾。pr-create / fix の base 取り込み・push・PR 作成）----
  { id: 'P01-routing-off', file: PP, from: '  check_routing\n  # 未コミットの tracked', to: '  # 未コミットの tracked', tests: ['pr-push.test.mjs'], note: 'prepare の routing ガード（remote の fetch / push URL の全行照合）を外す（別リポジトリから取り込み・push しうる）' },
  { id: 'P02-no-diff-check-off', file: PP, from: '    [ "${count}" -gt 0 ] || fail no-diff "base との差分が 0 件（push 対象コミットなし）"', to: '    :', tests: ['pr-push.test.mjs'], note: 'pr-create の差分ゼロ確認を外す（起点の取り違えで base の tip をそのまま push する）' },
  { id: 'P03-merge-in-progress-off', file: PP, from: '  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then\n    fail merge-in-progress', to: '  if false; then\n    fail merge-in-progress', tests: ['pr-push.test.mjs'], note: 'push モードがコンフリクト途中（MERGE_HEAD 残存）で止まらない（解消コミットの無い HEAD を push する）' },
  { id: 'P04-remote-ahead-continues', file: PP_LIB, from: "0) PP_ORIGIN='remote-ahead'; return 1 ;;", to: "0) PP_ORIGIN='remote-ahead'; return 0 ;;", tests: PR_PUSH, note: 'remote ahead（第三者の push と区別できない）を続行扱いにする（未レビューのリモートコミットを取り込む）' },
  { id: 'P05-head-mismatch-reused', file: PP_LIB, from: '    if [ "${same_sha}" = "${remote}" ]; then', to: '    if true; then', tests: PR_PUSH, note: 'head の sha が違う既存 PR も再利用する（他者・別ランの push で動いた PR にマージ経路が結ばれる）' },
  { id: 'P06-sha-mismatch-ignored', file: PP, from: '  [ "$(git rev-parse HEAD 2>/dev/null)" = "${head_now}" ] || fail sha-mismatch "checkout 後の HEAD が起点の sha と一致しない"', to: '  :', tests: ['pr-push.test.mjs'], note: 'checkout 後の HEAD と起点の sha の一致確認を外す（無関係な HEAD を取り込み・push する）' },
  // ---- pr-push.sh のレビュー指摘対応（codex C1〜C4・独立レビュー R1〜R6）----
  { id: 'P12-race-continues', file: SRC, from: 'race（push 後にリモート head が HEAD と違う = 並行 push 競合の可能性）も PR を作らず prNumber: 0 と race を理由として返す。', to: 'race（push 後にリモート head が HEAD と違う = 並行 push 競合の可能性）でも手順 1b へ進む。', tests: ['pr-push-prompt.test.mjs'], note: 'push 後の race（リモート head が HEAD と違う）でも PR 作成へ進ませる（第三者の未レビューのコミットを含む PR ができる）' },
  { id: 'P13-expect-sha-check-off', file: PP, from: '    ok) ;;\n    unknown) fail remote-head-unknown', to: '    ok | mismatch) ;;\n    unknown) fail remote-head-unknown', tests: ['pr-push.test.mjs'], note: 'pr モードがサーバー head と --expect-sha の不一致を見逃す（race 後の head で PR を作成・再利用する）' },
  { id: 'P14-reuse-view-no-R', file: SRC, from: 'gh pr view <番号>${repoArg ? ` -R ${repoArg}` : \'\'} --json body --jq .body', to: 'gh pr view <番号> --json body --jq .body', tests: ['pr-push-prompt.test.mjs'], note: '再利用 PR の本文取得に -R を付けない（GH_REPO・既定リポジトリが違うと別リポジトリの同番号 PR を読む）' },
  { id: 'P15-reuse-edit-no-R', file: SRC, from: 'gh pr edit <番号>${repoArg ? ` -R ${repoArg}` : \'\'} --body-file "$f" && rm -f "$f"', to: 'gh pr edit <番号> --body-file "$f" && rm -f "$f"', tests: ['pr-push-prompt.test.mjs'], note: '再利用 PR の本文更新に -R を付けない（別リポジトリの同番号 PR を書き換える）' },
  { id: 'P16-shared-ref-deleted', file: PP, from: 'base_ref="refs/worktree/pr-push/base"', to: 'base_ref="refs/remotes/origin/${base}"', tests: ['pr-push.test.mjs'], note: 'base の取得先を並列 worktree が共有する refs/remotes/origin/<base> に戻す（prepare が共有 ref を削除し、別 worktree の取り込み・検査を壊す）' },
  { id: 'P17-base-not-merged-off', file: PP, from: '    1) fail base-not-merged "base が HEAD に取り込まれていない（コンフリクトの解消を中止した等。prepare をやり直す）" ;;', to: '    1) ;;', tests: ['pr-push.test.mjs'], note: 'push モードが base 未取り込みの HEAD を止めない（conflict 後に merge --abort して push すると base 未取り込みの head が届く）' },
  { id: 'P18-push-routing-off', file: PP, from: '  check_routing\n  pv_push_verified "${branch}"', to: '  pv_push_verified "${branch}"', tests: ['pr-push.test.mjs'], note: 'push モードの routing 照合を外す（push 先が書き換えられても push する）' },
  { id: 'P19-pr-routing-off', file: PP, from: '  check_routing\n  # サーバー上のブランチ head が push した HEAD', to: '  # サーバー上のブランチ head が push した HEAD', tests: ['pr-push.test.mjs'], note: 'pr モードの routing 照合を外す' },
  { id: 'P20-milestone-fail-open', file: PP_LIB, from: '    \'\' | *[!0-9]*)\n      PP_MILESTONE=fetch-failed\n      return 1\n      ;;', to: '    \'\' | *[!0-9]*)\n      PP_MILESTONE=not-used\n      return 0\n      ;;', tests: PR_PUSH, note: 'milestone 件数の取得失敗を非運用扱いにする（fail-open。取得失敗を確認済みと読み替える）' },
  { id: 'P21-fork-pr-reused', file: PP, from: 'select(.isCrossRepository == false) | ', to: '', tests: ['pr-push.test.mjs'], note: 'fork の同名ブランチの PR も一覧に含める（別リポジトリの PR を再利用・取り違える）' },
  { id: 'P22-dirty-check-off', file: PP, from: '  [ -z "${dirty}" ] || fail dirty-worktree', to: '  :; [ -z "" ] || fail dirty-worktree', tests: ['pr-push.test.mjs'], note: 'prepare が未コミットの変更を検査しない（マージコミットへ混ざる）' },
  { id: 'P23-fix-push-fail-not-commitfailed', file: SRC, from: '非 0 終了・結果の行なしも同じ扱い（pushed: false・commitFailed: true。「push 不要」と区別するため）。', to: '', tests: ['pr-push-prompt.test.mjs'], note: 'fix の push が非 0 終了・結果の行なしのときの返却値を定めない' },
  { id: 'P24-milestone-warn-after-edit', file: SRC, from: '    `   1b の結果の milestone が unassigned のときは、"$f" の末尾にも「> **警告**: Closes 対象の #${item.number} に milestone が割り当てられていない。」の行を（無ければ）足す（gh pr edit より前に済ませる。更新後に足しても PR へ反映されない）。`,\n    optinRecordSection\n      ? `   本文への追記（Closes 行・対象外節・opt-in テスト記録節・milestone 警告）をすべて終えてから、最後に 1 回だけ更新して一時ファイルを削除する:`\n      : `   本文への追記（Closes 行・対象外節・milestone 警告）をすべて終えてから、最後に 1 回だけ更新して一時ファイルを削除する:`,\n    `     gh pr edit <番号>${repoArg ? ` -R ${repoArg}` : \'\'} --body-file "$f" && rm -f "$f"`,\n    `   （マージ時にイシューが自動クローズされないと監視が空転するため、Closes 行は必ず存在させる）`,\n', to: '    optinRecordSection\n      ? `   本文への追記（Closes 行・対象外節・opt-in テスト記録節・milestone 警告）をすべて終えてから、最後に 1 回だけ更新して一時ファイルを削除する:`\n      : `   本文への追記（Closes 行・対象外節・milestone 警告）をすべて終えてから、最後に 1 回だけ更新して一時ファイルを削除する:`,\n    `     gh pr edit <番号>${repoArg ? ` -R ${repoArg}` : \'\'} --body-file "$f" && rm -f "$f"`,\n    `   （マージ時にイシューが自動クローズされないと監視が空転するため、Closes 行は必ず存在させる）`,\n    `   1b の結果の milestone が unassigned のときは、"$f" の末尾にも「> **警告**: Closes 対象の #${item.number} に milestone が割り当てられていない。」の行を（無ければ）足す（gh pr edit より前に済ませる。更新後に足しても PR へ反映されない）。`,\n', tests: ['pr-push-prompt.test.mjs'], note: 'milestone 警告の追記指示を最後の gh pr edit の後ろへ戻す（更新後に足しても PR へ反映されない）' },
  { id: 'P25-pr-create-no-security-check', file: SRC, from: '    `0e. push 前のセキュリティ確認（必須。fail-closed）: git rev-parse refs/worktree/pr-push/base で base の SHA（40 桁）を控え、git diff <その SHA> HEAD の差分（手順 0 で入った base 取り込み・コンフリクト解消コミットの変更を含む）を、skills/create-pr/SKILL.md Step 2 の観点（認証認可の漏れ・ハードコード秘密情報・XSS・入力バリデーション・OWASP Top 10）で確認する。秘密情報の検出は .claude/rules/security.md の方針に従う（追加行のみ対象・マッチ行は出力せず件数と終了コードで判定・grep が終了コード 2 以上なら検査失敗として中止）。問題を検出した、または検査自体が失敗した場合は push も PR 作成もせず prNumber: 0 と「セキュリティ確認で問題を検出（または検査失敗）: 種別と箇所の要旨（秘密値そのものは書かない）」を理由として返す。問題なしの場合のみ手順 1 へ進む。`,\n', to: '', tests: ['pr-push-prompt.test.mjs'], note: 'PR 作成前（prepare 後・push 前）のセキュリティ確認を外す（解消コミットの変更が未確認のまま push・PR 作成される）' },
  // ---- 起動時のハッシュ予検査（第 4 弾）----
  { id: 'P07-precheck-skew-accepted', file: SRC, from: '  if (p.mismatch === 0 && p.missing === 0) return { ok: true }', to: '  if (true) return { ok: true }', tests: ['script-hash-precheck.test.mjs'], note: 'ホストが不一致・欠落を一致扱いにする（版ずれのまま着手する）' },
  { id: 'P08-verify-only-mismatch-ok', file: RV, from: '    elif [ "${actual}" = "${expected}" ]; then\n      ok=$((ok + 1))', to: '    elif true; then\n      ok=$((ok + 1))', tests: ['script-hash-precheck.test.mjs'], note: '--verify-only がハッシュ不一致を一致として数える' },
  { id: 'P09-precheck-skipped', file: SRC, from: 'if (skillDir) await precheckScriptHashes()', to: 'if (false) await precheckScriptHashes()', tests: ['script-hash-precheck.test.mjs'], note: 'ラン開始時の予検査を呼ばない' },
  // ---- observe-pr.sh --repo（第 4 弾）----
  { id: 'P10-repo-not-passed', file: SRC, from: "    repo !== '' ? ` --repo ${repo}` : '',", to: "    '',", tests: ['observe-pr-host.test.mjs'], note: 'ホストが args.repo を持つのに観測コマンドへ --repo を渡さない' },
  { id: 'P11-observe-no-R', file: OBS, from: 'run_timed "${gh_timeout}" gh pr view "${pr}" -R "${repo}" "$@"', to: 'run_timed "${gh_timeout}" gh pr view "${pr}" "$@"', tests: ['observe-pr.test.mjs'], note: '--repo があっても gh pr view に -R を付けない' },
]

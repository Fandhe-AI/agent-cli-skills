// agent-guard.sh（Codex PreToolUse hook と OpenCode plugin が共通に呼ぶコマンド禁止ガード）の回帰テスト。
//
// 契約: stdin の {"command", "subagent"} を判定し、最後の 1 行が
// `AGENT_GUARD_RESULT allow`（終了 0）か `AGENT_GUARD_RESULT deny <理由コード>`（終了 2）。
// 全セッションで git の --no-verify・force push を deny、subagent が true / null のときだけ
// merge-guard-hook.sh 由来のマージ系・設定変更系・難読化を deny する。
// 判定表は /bin/bash（3.2）と PATH の bash（5 系）の両方で同じ結果になることを確かめる。
// 子プロセスは並列に流し、実時間の待機は行わない。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'hooks', 'agent-guard.sh')

// 同じ bash が重複しないよう実パスで束ねる。
const pathBash = execFileSync('/bin/sh', ['-c', 'command -v bash']).toString().trim()
const BASHES = [...new Set(['/bin/bash', pathBash])]

function runRaw(bash, stdin, env = process.env) {
  return new Promise((resolve, reject) => {
    const p = spawn(bash, [GUARD], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => {
      const lines = out.split('\n').filter((l) => l !== '')
      resolve({ code, out, err, last: lines[lines.length - 1] ?? '' })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(stdin)
  })
}

const run = (bash, command, subagent) => runRaw(bash, JSON.stringify({ command, subagent }))

function expectAllow(r) {
  assert.equal(r.last, 'AGENT_GUARD_RESULT allow')
  assert.equal(r.code, 0)
}
function expectDeny(r, reason) {
  assert.equal(r.last, `AGENT_GUARD_RESULT deny ${reason}`)
  assert.equal(r.code, 2)
}

// --- git の規則（全セッション。subagent の値に依らない）-------------------------------
const GIT_DENY = [
  // --no-verify: 位置違い・-m の前後・サブコマンド違い
  ['git commit --no-verify -m x', 'no-verify'],
  ['git commit -m x --no-verify', 'no-verify'],
  ['git commit -m "x y" --no-verify', 'no-verify'],
  ['git commit -m x --amend --no-verify', 'no-verify'],
  ['git push --no-verify', 'no-verify'],
  ['git push origin main --no-verify', 'no-verify'],
  ['git merge main --no-verify', 'no-verify'],
  ['git rebase --no-verify main', 'no-verify'],
  ['git cherry-pick abc123 --no-verify', 'no-verify'],
  ['git am --no-verify x.patch', 'no-verify'],
  ['git revert HEAD --no-verify', 'no-verify'],
  ['git pull --no-verify', 'no-verify'],
  // グローバルオプション付き
  ['git -c user.name=a commit --no-verify -m x', 'no-verify'],
  ['git -c x=y commit --no-verify', 'no-verify'],
  ['git -C /tmp/r commit -m x -n', 'no-verify'],
  ['git -C dir -c a=b --no-pager commit -n', 'no-verify'],
  ['/usr/bin/git commit --no-verify', 'no-verify'],
  ['FOO=1 git commit -n -m x', 'no-verify'],
  // commit の -n（束ね書き）と --no-verify の略記・引用符分割
  ['git commit -n -m x', 'no-verify'],
  ['git commit -m x -n', 'no-verify'],
  ['git commit -an -m x', 'no-verify'],
  ['git commit -nm x', 'no-verify'],
  ['git commit --no-ver', 'no-verify'],
  ['git commit "--no-verify"', 'no-verify'],
  ["git commit --no-ve''rify", 'no-verify'],
  ['git commit -m x \\\n --no-verify', 'no-verify'],
  // 複合コマンドの各部
  ['git add . && git commit -m x --no-verify', 'no-verify'],
  ['git add .;git commit -n', 'no-verify'],
  ['echo a | git commit --no-verify', 'no-verify'],
  ['git status || git commit -n', 'no-verify'],
  ['(git commit -n)', 'no-verify'],
  ['x=$(git commit -n)', 'no-verify'],
  ['git commit -F - <<EOF\nmsg\nEOF\ngit commit -n', 'no-verify'],
  // force push: 位置違い・短縮・束ね書き・+refspec
  ['git push --force', 'force-push'],
  ['git push -f', 'force-push'],
  ['git push --force origin main', 'force-push'],
  ['git push origin main --force', 'force-push'],
  ['git push origin main -f', 'force-push'],
  ['git push -uf origin x', 'force-push'],
  ['git push origin +main', 'force-push'],
  ['git push origin +HEAD:main', 'force-push'],
  ['git -c a=b push -f', 'force-push'],
  ['git push --force-with-lease --force', 'force-push'],
  // lease 付きでも既存コミットを消せるので force 扱い（= 形・略記・順序違い・--force-if-includes）
  ['git push --force-with-lease', 'force-push'],
  ['git push --force-with-lease=main:abc123 origin main', 'force-push'],
  ['git push origin main --force-with-lease', 'force-push'],
  ['git push --force-if-includes', 'force-push'],
  ['git push --force-if-includes --force-with-lease', 'force-push'],
  ['git push --force-with origin x', 'force-push'],
  ['git push --force-with-lease origin feat', 'force-push'],
  ['git -C x push --force-with-lease', 'force-push'],
  // `--` はオプション解析を終えるだけ。後続の +refspec は force push のまま
  ['git push origin -- +main', 'force-push'],
  ['git push -- origin +HEAD:main', 'force-push'],
  ['git push origin -- main +x', 'force-push'],
  ['git status && git push -f', 'force-push'],
  ['git add .; git push origin x --force', 'force-push'],
  ['git commit -F - <<EOF\nmsg\nEOF\ngit push --force', 'force-push'],
  // 実機 fixture（Codex c1 PreToolUse・OpenCode permission.evaluate の resources）
  ['git push --force origin main', 'force-push'],
  ['git push origin main --force', 'force-push'],
  // 値を取るオプションの読み飛ばしの対照: 値の後ろのフラグは判定する
  ['git commit -am msg --no-verify', 'no-verify'],
  ['git commit -F msg.txt -n', 'no-verify'],
  ['git commit --message=x --no-verify', 'no-verify'],
  ['git commit --author=a -m x -n', 'no-verify'],
  ['git push -o x --force', 'force-push'],
  ['git push --push-option=x -f', 'force-push'],
]

const GIT_ALLOW = [
  'git -ccolor.ui=never status',
  'git -cuser.name=x commit -m y',
  // -n が commit 以外・--no-verify でない -n
  'git log -n 5',
  'git log --oneline -n 3 | head',
  'git -c core.pager=cat log -n 2',
  'git push -n origin main',
  'git branch -f topic',
  // 引用符・コメント・ヒアドキュメント内の語は引数ではない
  'git commit -m "fix -n handling"',
  'git commit -m "docs: --no-verify 禁止"',
  'git commit -m x # --no-verify',
  'echo "git push --force"',
  "git commit -F - <<'EOF'\nmessage git commit -n and git push --force\nEOF",
  'git commit -F - <<-EOF\n\tgit push -f\n\tEOF',
  'git commit -m "$(cat <<\'EOF\'\nfeat: x --no-verify を禁止\ngit push --force\nEOF\n)"',
  // 値を取るオプションの値（フラグに見えても値）と `--` 以降
  "git commit -m '--no-verify'",
  'git commit -m "-n"',
  'git commit --message=--no-verify',
  'git commit --message --no-verify',
  'git commit -F --no-verify.txt',
  'git commit -am -n',
  'git commit -m x -C -n',
  'git commit --author --no-verify -m x',
  'git push -o --force origin main',
  'git push --push-option=--force origin main',
  'git push origin -- --force',
  'git commit -m x -- --no-verify',
  // -m の値に n が含まれる
  'git commit -mn',
  'git commit -mrefactor',
  'git commit -m refactor --amend',
  // `--` の後の + で始まらない語は ref 名
  'git push -- origin main',
  'git push origin -- --force-with-lease',
  'git push --no-force-with-lease origin main',
  // 通常の操作
  'git push origin main',
  'git push -u origin feat/x',
  'git push origin "feature/+plus"',
  'git commit -m x -- file',
  'git commit --amend -m x',
  'git merge main',
  'git rebase main',
  'git status',
  'git stash push -u',
  'ls -la',
  'echo SUB-MARK',
  'echo MAIN-MARK',
  'git status --short',
]

// --- 判定漏れの是正（M1 / M2 / M4 / M5 / L2 / L3）の回帰 --------------------------------
// 陽性対照: 各ケースが「ただの deny」でなく guard の判定で deny されることの基準。
const FIX_DENY = [
  ['git push --force origin main', 'force-push'],
  // M1: here-string の `<<<` を heredoc と誤認して後続を読み飛ばさない
  ['cat <<< x\ngit push --force origin main', 'force-push'],
  ['cat <<<x\ngit commit --no-verify -m x', 'no-verify'],
  ['bc <<< "1+2"\ngit push -f', 'force-push'],
  // M2: 算術式の `<<` を heredoc と誤認しない
  ['echo $((1<<2))\ngit push -f', 'force-push'],
  ['((x = 1<<2))\ngit push -f', 'force-push'],
  ['echo $[1<<2]\ngit push -f', 'force-push'],
  ['echo $(( (1+2)<<3 ))\ngit commit -n', 'no-verify'],
  // 算術式のように見えて実はサブシェル / コマンド置換のものは中身を検査する
  ['echo $((git push -f); echo)', 'force-push'],
  ['echo $(( $(git push -f) ))', 'force-push'],
  // M4: `<` `>` は語の区切り（リダイレクトの後ろに隠さない）
  ['git push --force>/dev/null', 'force-push'],
  ['git push>/dev/null -f', 'force-push'],
  ['git commit --no-verify>/dev/null', 'no-verify'],
  ['git push 2>&1 -f', 'force-push'],
  ['git push &>/dev/null -f', 'force-push'],
  ['git push >>log.txt --force', 'force-push'],
  ['git push -f >| out.txt', 'force-push'],
  ['git commit -m x <in.txt -n', 'no-verify'],
  // M5: フック回避・alias 経由
  ['git -c core.hooksPath=/dev/null commit -m x', 'no-verify'],
  ['git -c core.hookspath=/dev/null commit -m x', 'no-verify'],
  ['git -c CORE.HOOKSPATH=/dev/null push', 'no-verify'],
  ['git --config-env=core.hooksPath=HP commit -m x', 'no-verify'],
  ['git --config-env core.hooksPath=HP commit -m x', 'no-verify'],
  ['git -c alias.p=push p -f', 'no-verify'],
  // -c の連結形（-c<key>=<value>）と --config-env の = 連結形
  ['git -ccore.hooksPath=/dev/null commit -m x', 'no-verify'],
  ['git -calias.p=push p -f', 'no-verify'],
  ['git -cCore.HooksPath=x commit -m y', 'no-verify'],
  ['git --config-env=core.hooksPath=HP push', 'no-verify'],
  ['git -c alias.c="commit -n" c', 'no-verify'],
  ['git -c alias.l=log l', 'no-verify'], // 値を解決せず alias の定義自体を拒否する（設計上の over-deny）
  ['HUSKY=0 git commit -m x', 'no-verify'],
  ['HUSKY=0 git push origin feat', 'no-verify'],
  ['FOO=1 HUSKY=0 /usr/bin/git commit -m x', 'no-verify'],
  ['env HUSKY=0 git commit -m x', 'no-verify'],
  ['export HUSKY=0; git commit -m x', 'no-verify'],
  ['HUSKY=0\ngit commit -m x', 'no-verify'],
  ['HUSKY_SKIP_HOOKS=1 git commit -m x', 'no-verify'],
  // env の値を取るオプションを引数ごと読み飛ばしたうえで後続の代入を見る
  ['env -u X HUSKY=0 git commit -m x', 'no-verify'],
  ['env --unset=X HUSKY=0 git commit -m x', 'no-verify'],
  ['env --unset X HUSKY=0 git commit -m x', 'no-verify'],
  ['env -C /tmp HUSKY=0 git commit -m x', 'no-verify'],
  ['env --chdir=/tmp HUSKY_SKIP_HOOKS=1 git commit -m x', 'no-verify'],
  ['env -i HUSKY=0 git commit -m x', 'no-verify'],
  ['env -i -u X -C /tmp HUSKY=0 git commit -m x', 'no-verify'],
  ["env -S 'HUSKY=0 git commit -m x'", 'no-verify'],
  ["env --split-string='HUSKY=0 git commit -m x'", 'no-verify'],
  ['git config core.hooksPath /dev/null', 'no-verify'],
  ['git config --global core.hooksPath /dev/null', 'no-verify'],
  ['git config core.hooksPath /dev/null --local', 'no-verify'],
  ['git config core.hookspath ""', 'no-verify'],
  ['git config --unset core.hooksPath', 'no-verify'],
  ['git config --unset-all core.hooksPath', 'no-verify'],
  ['git config --add core.hooksPath x', 'no-verify'],
  ['git config set core.hooksPath x', 'no-verify'],
  ['git config unset core.hooksPath', 'no-verify'],
  ['git -C d config core.hooksPath x', 'no-verify'],
  ['git config alias.p push', 'no-verify'],
  ['git config --global alias.ci "commit -n"', 'no-verify'],
  ['git config --unset alias.p', 'no-verify'],
  // L2: --mirror は実質 force
  ['git push --mirror', 'force-push'],
  ['git push --mirror origin', 'force-push'],
  ['git push origin --mirror', 'force-push'],
  ['git push --mir', 'force-push'],
  // L3: コマンド名の大文字小文字（macOS は区別しない）
  ['GIT push -f', 'force-push'],
  ['Git commit --no-verify', 'no-verify'],
  ['/usr/bin/GIT push --force', 'force-push'],
  ['/usr/bin/Git commit -n', 'no-verify'],
]

// 誤 deny の回帰 fixture。修正前の実装でも allow である。
const FIX_ALLOW = [
  // 推奨のコミット形（本文に禁止語・記号・引用符・heredoc 記号を含めても本文は引数ではない）
  'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nbody has "quoted" and \'s\' and --no-verify and git push --force\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\ncore.hooksPath and <<< and > file and $((1<<2))\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nfeat: it\'s\n\ngit push --force and git commit --no-verify\nEOF\n)"\n\nCo-Authored-By: x',
  'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nHUSKY=0 git commit -n; git config core.hooksPath x\nEOF\n)"',
  // 読み取り・リダイレクト・here-string・算術
  'git config --get core.hooksPath',
  'git config --get-all core.hooksPath',
  'git config core.hooksPath',
  'git config get core.hooksPath',
  'git config --global --get core.hooksPath',
  'git config --list',
  'git config --get-regexp alias',
  'git config alias.p',
  'git config --get alias.p',
  'git config user.name x',
  'git -c user.name=a commit -m x',
  'git log --format=\'%H\' > out.txt',
  'git log --format=%H >out.txt',
  'bc <<< "1+2"',
  'cat <<< x',
  'echo $((1<<2))',
  'echo $((1 << 2)) && git status',
  'echo $[1<<2]',
  '((x = 1<<2))',
  'git push origin feat 2>&1',
  'git push origin feat >/dev/null 2>&1',
  'git push origin feat &>/dev/null',
  'git status 2>&1 | head',
  'git diff <(echo a) <(echo b)',
  'git log -n 5 >out.txt',
  'env -u X git commit -m x',
  'env -u HUSKY git commit -m x',
  'env -C /tmp git commit -m x',
  'env -i git status',
  'HUSKY=0 npm ci',
  'HUSKY=0 npm ci; git commit -m x',
  'export FOO=1; git commit -m x',
  'env FOO=1 git status',
  'git push origin feat-mirror',
  'echo mirror',
]

// --- merge-guard-hook.sh 由来（subagent が true / null のときだけ）-----------------------
// merge-guard-repo-settings.test.mjs の deny / allow ケースの移植。
const MG_REPO_DENY = [
  'gh api --method PUT repos/Fandhe-AI/example/rulesets/123 --input /tmp/rs.json',
  'gh api -X PATCH "repos/{owner}/{repo}/rulesets/5" -f name=main-protection',
  'gh api -XDELETE repos/o/r/rulesets/5',
  'gh api --method=PUT repos/o/r/branches/main/protection --input p.json',
  'gh api -X DELETE repos/o/r/branches/release%2F1.0/protection',
  'gh api repos/o/r/rulesets -f name=x -f enforcement=active',
  'gh api orgs/o/rulesets --input rs.json',
  'gh api repos/o/r/branches/main/protection/required_status_checks -F strict=false',
  'gh -R o/r api --method PUT repos/o/r/rulesets/1 --input x.json',
  'gh api -X PATCH repos/o/r -f allow_auto_merge=true',
  'gh api --method DELETE repos/o/r',
  `gh api graphql -f query='mutation{updateRepositoryRuleset(input:{repositoryRulesetId:"x"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation($i:CreateBranchProtectionRuleInput!){createBranchProtectionRule(input:$i){clientMutationId}}'`,
  `gh api graphql -f query='mutation{updateRepository(input:{repositoryId:"x",hasWikiEnabled:false}){clientMutationId}}'`,
  'gh repo edit --enable-auto-merge',
  'gh repo edit o/r --default-branch develop',
  'gh repo archive o/r --yes',
  'gh api -X POST -f name=x repos/O/R/rulesets;true',
  'gh api -X PATCH https://api.github.com/repos/OWNER/REPO -f name=x',
  'gh api -X DELETE repos/OWNER/REPO/',
  'gh api -iX DELETE repos/O/R/rulesets/1',
  'gh api -f=name=x repos/O/R/rulesets',
  'gh api -XPUT repos/o/r/rulesets/1&&true',
  'gh api --method=delete repos/o/r/branches/main/protection',
  'gh api -F=enforcement=active orgs/o/rulesets',
  'gh api --field=name=x repos/o/r/rulesets',
  'gh api --raw-field=name=x repos/o/r/rulesets',
  'gh api -X PATCH /repos/o/r;echo',
  `gh api repos/o/r/rulesets -f enforcement=active | grep x`,
  `gh api repos/o/r/rulesets --jq '.a | .b' -f name=x`,
  `gh api repos/o/r/rulesets --jq ';' -f name=x`,
  'gh api repos/o/r/rulesets 2>&1 -f name=x',
  'echo x | gh api repos/o/r/rulesets -f name=x',
  'grep -F a=b f | gh api repos/o/r/rulesets -f name=x',
  'gh api repos/o/r/rulesets | grep -F a=b; gh api repos/o/r/rulesets -f name=x',
  'echo -f name=x | xargs gh api repos/o/r/rulesets',
  'gh api repos/o/r/rulesets $(true) | grep -F a=b -f name=x',
  'gh api repos/o/r/rulesets -f name=x | grep -F a=b',
  `gh api graphql -f query='mutation{deleteRepository(input:{repositoryId:"x"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{archiveRepository(input:{repositoryId:"x"}){clientMutationId}}'`,
]

const MG_MERGE_DENY = [
  'gh pr merge 5 --squash',
  'gh pr merge',
  'gh -R o/r pr merge 5',
  'gh --repo o/r pr merge 5 --auto',
  '/usr/bin/gh pr merge 5',
  'gh pr merge 5;echo',
  'gh pr view 1 && gh pr merge 1',
  'gh api -X PUT repos/o/r/pulls/5/merge',
  'gh api repos/o/r/pulls/5/merge -X PUT',
  'gh api -X POST repos/o/r/merges -f base=main -f head=x',
  `gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId}}'`,
  `printf 'mutation{mergeBranch(input:{}){x}}' | gh api graphql --input -`,
  'gh pr review 5 --approve',
  'gh pr review --approve 5',
  // 短縮 -a・束ね書き（-b / -F は値を取る）・順序違い
  'gh pr review 5 -a',
  'gh pr review -a 5',
  'gh pr review 5 --body x -a',
  'gh pr review 5 -ab ok',
  'gh pr review 5 -b ok -a',
  'gh -R o/r pr review 5 -a',
  'gh pr review 5 -ca',
  'gh pr review 5 -b "x; y" -a',
  // フルパス・相対パスの gh
  '/usr/bin/gh pr review 5 -a',
  '/opt/homebrew/bin/gh pr review -a 5',
  './gh pr review 5 -a',
  'gh pr review 5 -b gh -a',
  'gh pr review 5 -b /usr/bin/gh -a',
  '(gh pr review 5 -a)',
  'gh pr review 5 -c -b ok; gh pr review 6 -a',
  'gh pr review 5 -ab ok && ls',
  'gh api -X GET repos/o/r/pulls/5/reviews -X POST -f event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews --jq x -f event=APPROVE',
  // API 経由の承認: REST（reviews 作成・events 送信）
  'gh api -X POST repos/o/r/pulls/5/reviews -f event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews -f event=APPROVE -f body=ok',
  'gh api repos/o/r/pulls/5/reviews -F event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews --field event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews --raw-field event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews --field=event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews -f event=approve',
  'gh api repos/o/r/pulls/5/reviews -f event = APPROVE',
  `gh api repos/o/r/pulls/5/reviews -f 'event=APPROVE'`,
  'gh api -X POST repos/o/r/pulls/5/reviews/9/events -f event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews --input review.json',
  'gh api repos/o/r/pulls/5/reviews --input -',
  'gh api repos/o/r/pulls/5/reviews/9/events --input=review.json',
  'gh api repos/o/r/pulls/5/reviews -F event=@ev.txt',
  'gh api repos/o/r/pulls/5/reviews -f event=$EV',
  // API 経由の承認: GraphQL
  `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:APPROVE}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{submitPullRequestReview(input:{pullRequestId:"x",event:APPROVE}){clientMutationId}}'`,
  `gh api graphql -f query='mutation($e:PullRequestReviewEvent!){addPullRequestReview(input:{event:$e}){clientMutationId}}' -f e=APPROVE`,
  'gh api graphql -f query=@q.graphql',
  'gh api graphql -F query=@q.graphql',
  'gh api graphql --input q.json',
  'gh -R o/r pr review 5 --approve;echo',
  'gh alias set m "pr merge"',
  'gh alias import a.yml',
  'gh extension install o/gh-x',
  'gh extensions list',
  "gh pr mer''ge 5",
  'gh pr m\\erge 5',
]

const MG_OBFUSCATED_DENY = [
  "echo $'\\x67\\x68'",
  'gh${IFS}pr${IFS}merge 1',
  'gh$IFS pr merge 1',
]

const MG_ALLOW = [
  '/usr/bin/gh pr review 5 -c -b ok',
  `gh api --paginate --slurp "repos/{owner}/{repo}/rules/branches/main" | jq '[.[][] | select(.type == "required_status_checks")] | length'`,
  `gh api "repos/{owner}/{repo}/rulesets/<id>" --jq '.bypass_actors | type == "array" and length == 0'`,
  'gh api repos/o/r/rulesets/123 --jq .enforcement',
  'gh api repos/o/r/branches/main/protection',
  'gh api -i repos/o/r/branches/main/protection',
  'gh api --method GET repos/o/r/rulesets -F per_page=100',
  'gh api -X GET repos/o/r/rulesets -f includes_parents=true',
  'gh api repos/o/r/rulesets | grep -F bypass_actors',
  'gh api repos/o/r/rulesets/1 | jq -f /tmp/filter.jq',
  `gh api repos/o/r/rulesets | grep -F 'enforcement=active'`,
  'gh api repos/o/r/rulesets | grep -F enforcement=active | head -1',
  'gh api repos/o/r/rulesets && grep -F enforcement=active out.txt',
  'gh api repos/o/r/rulesets; grep -F enforcement=active out.txt',
  'gh api repos/o/r/branches/main/protection | egrep -F strict=false',
  `gh api repos/o/r/rulesets --jq '.[] | select(.name == "x")' | grep -F enforcement=active`,
  'gh api repos/o/r --jq .default_branch',
  'gh api repos/o/r/issues/5/comments -f body=hello',
  'gh repo view --json defaultBranchRef --jq .defaultBranchRef.name',
  'gh api -X POST repos/o/r/issues/5/comments -f body=hi',
  'gh api https://api.github.com/repos/o/r --jq .default_branch',
  'gh api -X GET repos/o/r/',
  `gh api graphql -f query='query{repository(owner:"o",name:"r"){rulesets(first:10){nodes{name}}}}'`,
  `gh api graphql -F owner='{owner}' -F name='{repo}' -F n=4 -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){number parent{number}}}}'`,
  'gh pr comment 5 --body "@cursor review"',
  'gh pr view 5 --json state',
  'gh pr review 5 --comment --body ok',
  'gh pr review 5 -c -b ok',
  'gh pr review 5 -r -b x',
  'gh pr review 5 --body -a -c',
  'gh pr checks 5',
  'gh api repos/o/r/pulls/5/reviews',
  'gh api repos/o/r/pulls/5/reviews --jq length',
  'gh api -X POST repos/o/r/pulls/5/reviews -f event=COMMENT -f body=x',
  'gh api -X POST repos/o/r/pulls/5/reviews -f event=REQUEST_CHANGES -f body=x',
  'gh api -X POST repos/o/r/pulls/5/reviews/9/events -f event=COMMENT',
  'gh api repos/o/r/pulls/5/reviews -f body=pending',
  'gh api repos/o/r/pulls/5/comments -f body=x',
  // 後続の別コマンドの -a は gh pr review の引数ではない
  'gh pr review 5 -c -b ok && ls -la',
  'gh pr review 5 -c -b ok; cp -a x y',
  'gh pr review 5 --comment -b x | grep -a y',
  'gh pr review 5 -c -b ok || ls -a',
  'gh pr review 5 -c -b ok\nls -la',
  // GraphQL: 別名の mutation・enum APPROVED は承認ではない
  `gh api graphql -f query='mutation{addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"x",body:"ok"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{addPullRequestReviewComment(input:{pullRequestReviewId:"x",body:"APPROVE me"}){clientMutationId}}'`,
  `gh api graphql -f query='query{repository(owner:"o",name:"r"){pullRequest(number:5){reviewDecision}}}' --jq '.. | select(. == "APPROVED")?'`,
  `gh api graphql -f query='query{repository(owner:"o",name:"r"){pullRequest(number:5){reviews(states:APPROVED,first:10){nodes{id}}}}}'`,
  // REST reviews の GET: jq フィルタ内の event= はフィールド指定ではない
  `gh api repos/o/r/pulls/5/reviews --jq '.[] | select(.event=="APPROVE")'`,
  `gh api repos/o/r/pulls/5/reviews -q '.[] | select(.event=="APPROVE")'`,
  `gh api -X GET repos/o/r/pulls/5/reviews -f per_page=100`,
  `gh api --method GET repos/o/r/pulls/5/reviews -F per_page=100 -f event=APPROVE`,
]

for (const bash of BASHES) {
  describe(`agent-guard.sh (${bash})`, { concurrency: 8 }, () => {
    for (const subagent of [false, true, null]) {
      describe(`subagent=${subagent}: git の規則は全セッションで有効`, { concurrency: 8 }, () => {
        for (const [cmd, reason] of GIT_DENY) {
          it(`deny ${reason}: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of GIT_ALLOW) {
          it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
        for (const [cmd, reason] of FIX_DENY) {
          it(`deny ${reason}: ${JSON.stringify(cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of FIX_ALLOW) {
          it(`allow: ${JSON.stringify(cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
      })
    }

    describe('subagent=false: マージ系・設定変更系・難読化は対象外', { concurrency: 8 }, () => {
      for (const cmd of [...MG_REPO_DENY, ...MG_MERGE_DENY, ...MG_OBFUSCATED_DENY]) {
        it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, false)))
      }
    })

    for (const subagent of [true, null]) {
      describe(`subagent=${subagent}: merge-guard の deny 対象`, { concurrency: 8 }, () => {
        for (const cmd of MG_REPO_DENY) {
          it(`deny repo-settings: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'repo-settings'))
        }
        for (const cmd of MG_MERGE_DENY) {
          it(`deny merge-guard: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'merge-guard'))
        }
        for (const cmd of MG_OBFUSCATED_DENY) {
          it(`deny obfuscated: ${cmd}`, async () => expectDeny(await run(bash, cmd, subagent), 'obfuscated'))
        }
        for (const cmd of MG_ALLOW) {
          it(`allow: ${cmd}`, async () => expectAllow(await run(bash, cmd, subagent)))
        }
      })
    }

    it('subagent キー欠落は null と同じ（マージ系を deny）', async () => {
      expectDeny(await runRaw(bash, JSON.stringify({ command: 'gh pr merge 5' })), 'merge-guard')
      expectAllow(await runRaw(bash, JSON.stringify({ command: 'gh pr view 5' })))
    })

    describe('入力が不正なら fail-closed（bad-input）', { concurrency: 8 }, () => {
      const BAD = [
        ['空', ''],
        ['空白のみ', '   \n'],
        ['JSON でない', 'not json'],
        ['JSON が途中で切れている', '{"command":"ls"'],
        ['空オブジェクト', '{}'],
        ['配列', '[]'],
        ['文字列', '"ls"'],
        ['command が数値', '{"command":5,"subagent":false}'],
        ['command が null', '{"command":null,"subagent":false}'],
        ['command が配列', '{"command":["ls"],"subagent":false}'],
        ['subagent が文字列', '{"command":"ls","subagent":"yes"}'],
        ['subagent が数値', '{"command":"ls","subagent":1}'],
        // Codex の PreToolUse stdin をそのまま渡した場合（command がトップレベルに無い）
        ['Codex の hook JSON そのまま', '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo MAIN-MARK"}}'],
      ]
      for (const [name, stdin] of BAD) {
        it(`deny bad-input: ${name}`, async () => expectDeny(await runRaw(bash, stdin), 'bad-input'))
      }
    })

    describe('jq が無い環境', () => {
      let dir
      before(() => {
        // jq 以外の必要なコマンドだけを置いた PATH を作る（システムの PATH に jq があっても外れる）。
        dir = mkdtempSync(join(tmpdir(), 'agent-guard-nojq-'))
        for (const c of ['cat', 'awk', 'sed', 'tr', 'grep']) {
          const p = execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim()
          symlinkSync(p, join(dir, c))
        }
        assert.equal(existsSync(join(dir, 'jq')), false)
      })
      after(() => rmSync(dir, { recursive: true, force: true }))

      it('allow できるコマンドでも deny no-jq', async () => {
        const r = await runRaw(bash, JSON.stringify({ command: 'ls', subagent: false }), { PATH: dir })
        expectDeny(r, 'no-jq')
      })
      it('main セッションの通常コマンドでも deny no-jq（fail-closed）', async () => {
        const r = await runRaw(bash, JSON.stringify({ command: 'git status', subagent: false }), { PATH: dir })
        expectDeny(r, 'no-jq')
      })
    })

    describe('出力に入力の文字列を含めない', { concurrency: 8 }, () => {
      const MARK = 'ZZ_SECRET_MARKER_ZZ'
      const cases = [
        [`git commit --no-verify -m ${MARK}`, false],
        [`git push --force origin ${MARK}`, false],
        [`gh pr merge 5 --body ${MARK}`, true],
        [`gh api -X PUT repos/o/r/rulesets/1 -f name=${MARK}`, null],
        [`echo $'${MARK}'`, true],
        [`echo ${MARK}`, false],
      ]
      for (const [cmd, subagent] of cases) {
        it(`marker が出ない: ${cmd}`, async () => {
          const r = await run(bash, cmd, subagent)
          assert.ok(!r.out.includes(MARK), 'stdout に入力が含まれる')
          assert.ok(!r.err.includes(MARK), 'stderr に入力が含まれる')
          assert.match(r.last, /^AGENT_GUARD_RESULT (allow|deny [a-z-]+)$/)
        })
      }
      it('不正な JSON の中身も出さない', async () => {
        const r = await runRaw(bash, `{"command":"${MARK}"`)
        assert.ok(!r.out.includes(MARK) && !r.err.includes(MARK))
        expectDeny(r, 'bad-input')
      })
    })

    it('結果行は stdout の最後の 1 行で、その行は 1 つだけ', async () => {
      const r = await run(bash, 'git push -f', false)
      const hits = r.out.split('\n').filter((l) => l.startsWith('AGENT_GUARD_RESULT'))
      assert.equal(hits.length, 1)
      assert.equal(r.out.trimEnd().split('\n').pop(), r.last)
    })
  })
}

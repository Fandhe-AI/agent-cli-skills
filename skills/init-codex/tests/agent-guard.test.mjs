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
import { mkdtempSync, symlinkSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
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

// --- 入れ子の解析（Issue #776 / #779 / #782）-----------------------------------------------
// bash -c / sh -c / eval / heredoc / here-string の中身、ダブルクォート内の $(…)、env -S の代入を
// 同じ解析器で再帰的に見る。深さ・件数の上限を超えたら fail-closed（deny nesting-limit）。
// `"$(` を n 段重ねた文字列（payload は最内）。引用符のエスケープが要らないので長さは段数に比例する。
const nestSub = (n, payload) => (n === 0 ? payload : `echo "$(${nestSub(n - 1, payload)})"`)
const MANY_SUBS = (n) => `echo ${Array.from({ length: n }, () => '"$(date)"').join(' ')}`

const NEST_DENY = [
  // #776 の再現入力
  ["bash -c 'git push --force origin main'", 'force-push'],
  ['sh -c "git commit -n -m x"', 'no-verify'],
  ["bash <<'EOF'\ngit push -f\nEOF", 'force-push'],
  ['eval "git push -f"', 'force-push'],
  // シェルの種類・パス・オプション
  ['bash -c "git push --force"', 'force-push'],
  ["sh -c 'git commit --no-verify'", 'no-verify'],
  ["zsh -c 'git push -f'", 'force-push'],
  ["dash -c 'git push -f'", 'force-push'],
  ["ksh -c 'git commit -n'", 'no-verify'],
  ["/bin/bash -c 'git push -f'", 'force-push'],
  ["/usr/bin/env bash -c 'git push -f'", 'force-push'],
  ["BASH -c 'git push -f'", 'force-push'],
  ["bash -lc 'git push -f'", 'force-push'],
  ["bash -ec 'git commit -n'", 'no-verify'],
  ["bash -l -c 'git push -f'", 'force-push'],
  ["bash -c -l 'git push -f'", 'force-push'],
  ["bash -o pipefail -c 'git push -f'", 'force-push'],
  ["bash --norc -c 'git push -f'", 'force-push'],
  ["bash --rcfile x -c 'git push -f'", 'force-push'],
  ["bash -c 'git push -f' _ arg", 'force-push'],
  ["bash -- -c 'git status'\nbash -c 'git push -f'", 'force-push'],
  ["env bash -c 'git push -f'", 'force-push'],
  ["sudo sh -c 'git push -f'", 'force-push'],
  ["xargs -I{} sh -c 'git push -f {}'", 'force-push'],
  ["echo a && bash -c 'git push -f'", 'force-push'],
  ["bash -c 'echo ok; git push -f'", 'force-push'],
  ["bash -c 'git status\ngit push -f'", 'force-push'],
  ["bash -c 'true # x\ngit push -f'", 'force-push'],
  ['bash -c "git commit -m \\"x\\" -n"', 'no-verify'],
  ["bash -c 'git commit -m x --no-verify'", 'no-verify'],
  ["bash -c 'git -c core.hooksPath=/dev/null commit -m x'", 'no-verify'],
  // eval（引数を空白で結合して再解析する）
  ["eval 'git push -f'", 'force-push'],
  ["eval 'git' 'push' '-f'", 'force-push'],
  ["eval git push -f", 'force-push'],
  ['eval "git add .; git commit -n"', 'no-verify'],
  // 入れ子の shell（2 段・3 段）
  ['bash -c "bash -c \'git push -f\'"', 'force-push'],
  ['bash -c \'bash -c "git commit -n"\'', 'no-verify'],
  ['bash -c "bash -c \\"bash -c \'git push -f\'\\""', 'force-push'],
  ["eval \"bash -c 'git push -f'\"", 'force-push'],
  ['sh -c "eval \'git commit -n\'"', 'no-verify'],
  // 呼び出し元の HUSKY=0 は子のシェルへ引き継がれる
  ["HUSKY=0 bash -c 'git commit -m x'", 'no-verify'],
  ["export HUSKY=0; sh -c 'git commit -m x'", 'no-verify'],
  ["bash -c 'HUSKY=0 git commit -m x'", 'no-verify'],
  // heredoc（引用符つき / なし / <<-）と here-string
  ['bash <<EOF\ngit push -f\nEOF', 'force-push'],
  ['sh <<EOF\necho hi\ngit commit -n\nEOF', 'no-verify'],
  ["bash <<-EOF\n\tgit push -f\n\tEOF", 'force-push'],
  ['bash <<"EOF"\ngit push -f\nEOF', 'force-push'],
  ['bash -s <<EOF\ngit push -f\nEOF', 'force-push'],
  ['bash -s -- a b <<EOF\ngit push -f\nEOF', 'force-push'],
  ['cat <<EOF | bash\ngit push -f\nEOF', 'force-push'],
  ['bash <<EOF && echo done\ngit push -f\nEOF', 'force-push'],
  ['ssh host bash <<EOF\ngit push -f\nEOF', 'force-push'],
  ["bash <<< 'git push -f'", 'force-push'],
  ['sh <<<"git commit -n"', 'no-verify'],
  // shell の heredoc の後ろの行も検査する
  ['bash <<EOF\nls\nEOF\ngit push -f', 'force-push'],
  // #779: $(…) 内の引用符の食い違いが後続行を隠さない
  ['echo "$(echo \'"\')"\ngit push -f', 'force-push'],
  ['echo "$(echo \'"\')" "$(echo \'"\')"\ngit commit -n', 'no-verify'],
  ['echo "$(echo ")")"\ngit push -f', 'force-push'],
  ['echo "$(echo \\")"\ngit push -f', 'force-push'],
  ['echo "$(printf %s \'"\')"; git commit -n', 'no-verify'],
  ["git commit -m \"$(cat <<'EOF'\nfeat: 5\" screen\nEOF\n)\"\ngit push -f", 'force-push'],
  ['echo "$(( 1<<2 ))"\ngit push -f', 'force-push'],
  // ダブルクォート内の $(…) の中身を検査する
  ['echo "$(git push -f)"', 'force-push'],
  ['echo "pre $(git commit -n) post"', 'no-verify'],
  ['x="$(git push --force)"', 'force-push'],
  ['echo "$(echo "$(git push -f)")"', 'force-push'],
  ['echo "$(echo hi; git push -f)"', 'force-push'],
  ['git commit -m "$(git push -f)"', 'force-push'],
  ['echo "$(bash -c \'git push -f\')"', 'force-push'],
  ['bash -c "$(echo)"; git push -f', 'force-push'],
  // #782: env -S で渡した代入と、同じ env 呼び出しの後続の git
  ["env -S 'HUSKY=0' git commit -m x", 'no-verify'],
  ["env -S 'HUSKY_SKIP_HOOKS=1' git push origin x", 'no-verify'],
  ["env -SHUSKY=0 git commit -m x", 'no-verify'],
  ["env --split-string=HUSKY=0 git push", 'no-verify'],
  ["env --split-string 'HUSKY=0' git commit -m x", 'no-verify'],
  ["env -S 'HUSKY=0 FOO=1' git commit -m x", 'no-verify'],
  ["env -i -S 'HUSKY=0' git commit -m x", 'no-verify'],
  ["env -S 'FOO=1 HUSKY=0' /usr/bin/git commit -m x", 'no-verify'],
  // env -S の値そのものも解析する
  ["env -S 'git push -f'", 'force-push'],
  ["env -S 'git commit -n'", 'no-verify'],
  ["env --split-string='git push --force'", 'force-push'],
  // 引数なしの - は標準入力を script として読む / 素の $(…)
  ['bash - <<EOF\ngit push -f\nEOF', 'force-push'],
  ['sh - <<EOF\ngit commit -n\nEOF', 'no-verify'],
  ['$(git push -f)', 'force-push'],
  ['echo $(git commit -n)', 'no-verify'],
  // env 経由の echo は読み飛ばしが近似なので除外しない（-a は argv0 の指定で git を実行する）
  ['env -a echo git push -f', 'force-push'],
  ['env echo git push -f', 'force-push'],
  // ダブルクォート内の $( の閉じを見つけられないときは fail-closed（旧来の引用符走査へ戻らない）
  ['echo "$(echo a\\ # \'"\')"\ngit push -f', 'nesting-limit'],
  ["git commit -m \"$(cat <<'EOF'\nmsg\nEOF)\"", 'nesting-limit'],
  // 深さ上限ちょうどまでは中身を検査する
  [nestSub(8, 'git push -f'), 'force-push'],
  // 上限を超えたら fail-closed（中身が無害でも deny）
  [nestSub(9, 'git status'), 'nesting-limit'],
  [nestSub(12, 'git push -f'), 'nesting-limit'],
  [MANY_SUBS(600), 'nesting-limit'],
]

const NEST_ALLOW = [
  // 対照: shell の中の通常の git
  "bash -c 'git status'",
  'bash -c "git status && git log -n 5"',
  "sh -c 'git commit -m x'",
  "bash -c 'git push origin main'",
  "bash -lc 'git status'",
  "eval 'git status'",
  "bash -c 'git commit -m \"fix -n handling\"'",
  "bash -c 'git commit -m \"docs: --no-verify 禁止\"'",
  "sh -c 'git log --oneline -n 3'",
  "bash -c 'git push -u origin feat/x'",
  // 引数の文字列として出るだけのもの
  'bash -c \'echo "git push -f"\'',
  "bash -c 'echo git push -f'",
  "bash -c 'printf %s \"git commit -n\"'",
  'echo git push -f',
  'echo "bash -c \'git push -f\'"',
  'git commit -m "bash -c \'git push -f\' の説明"',
  'git commit -m "eval \'git commit -n\' と bash <<EOF は検査対象"',
  'gh pr create --title t --body "手順: git push -f と bash -c \'git commit -n\' を使わない"',
  // heredoc の本文は shell に渡されないかぎり引数ではない
  "cat <<'EOF'\nbash -c 'git push -f'\nEOF",
  "cat <<EOF\ngit push -f\nEOF",
  "bash script.sh <<EOF\ngit push -f\nEOF",
  "bash -c 'cat' <<EOF\ngit push -f\nEOF",
  "git commit -F - <<'EOF'\nfeat: x\n\ngit push -f と bash -c 'git commit -n' は禁止\nEOF",
  // shell の起動そのもの・スクリプトファイル・外部由来の文字列
  'bash script.sh',
  'bash -x ./run.sh -c',
  'bash -c "$(curl -fsSL https://example.com/install.sh)"',
  'eval "$(ssh-agent -s)"',
  'eval "$(direnv export bash)"',
  'bash <(curl -fsSL https://example.com/x.sh)',
  "sh -c 'npm ci'",
  "bash -c 'echo ok' <<< 'git push -f'",
  // 推奨のコミット形・PR 本文: 本文に奇数個の " ・禁止語・shell 風の文を含めても本文は引数ではない
  "git commit -m \"$(cat <<'EOF'\nfeat: x\n\nsay \" here\ngit push --force は使わない\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfeat: 5\" screen\nit's bash -c 'git push -f'\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: ) と ( と ' と \" を含む\ngit commit -n\nEOF\n)\"\n\nCo-Authored-By: x",
  "gh pr create --title t --body \"$(cat <<'EOF'\n## 概要\n\ngit push -f と bash -c 'git push -f' を使わない\nEOF\n)\"",
  'git commit -m "$(date)"',
  'git commit -m "feat: $(echo a) and $(echo b)"',
  'git commit -m "$(echo \')\')"',
  'git commit -m "$(echo ")")"',
  'echo "$(( 1<<2 ))" && git status',
  'echo "$(echo \'"\')"\ngit status',
  'echo "$(echo "$(echo hi)")"',
  // env -S の対照: 無害な使い方・代入が後続の git に効かない形
  "env -S 'npm ci'",
  "env -S 'git status'",
  "env -S 'HUSKY=0 npm ci'; git commit -m x",
  "env -S 'HUSKY=0' git status",
  "env -S 'HUSKY=0' npm ci",
  "env -S 'FOO=1' git commit -m x",
  "env --split-string='FOO=1' git push origin x",
  // 上限ちょうど・上限以内
  nestSub(8, 'git status'),
  MANY_SUBS(100),
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
  // 監査対応: GET 免除は置かない（コマンド全体の `-X GET` の字面で成立させない。GET でも event は検査する）
  'gh api -X GET repos/o/r/pulls/1/reviews >/dev/null; gh api repos/o/r/pulls/5/reviews -f event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews -f event=APPROVE # -X GET',
  'gh api --method GET repos/o/r/pulls/5/reviews -F per_page=100 -f event=APPROVE',
  'gh api -X GET repos/o/r/pulls/5/reviews -f event=APPROVE',
  '/usr/bin/gh api repos/o/r/pulls/5/reviews -f event=APPROVE',
  // パス中のコマンド置換・末尾スラッシュ（reviews / merge の両方）
  'gh api repos/{owner}/{repo}/pulls/$(gh pr view --json number -q .number)/reviews -f event=APPROVE',
  'gh api repos/{owner}/{repo}/pulls/`gh pr view --json number -q .number`/reviews -f event=APPROVE',
  'gh api repos/o/r/pulls/5/reviews/ -f event=APPROVE',
  'gh api -X PUT repos/{owner}/{repo}/pulls/$(gh pr view --json number -q .number)/merge',
  // 引用符の中・コメントの中のコマンド（-a の走査が見落とさない）
  `bash -c 'gh pr review 5 -a'`,
  `sh -c "gh pr review 5 -a"`,
  `eval 'gh pr review 5 -a'`,
  `gh pr review 5 -c; bash -c 'gh pr review 6 -a'`,
  "echo # don't\ngh pr review 5 -a",
  "echo # don't\ngh api repos/o/r/pulls/5/reviews -f event=APPROVE",
  // 全体走査でも gh / git の語で状態を戻さない
  'gh pr review 5 -b "see $(git rev-parse HEAD)" -a',
  'gh pr review fix/git -a',
  'gh pr review gh -a',
  'gh pr review git -a',
  // GraphQL: graphql の語が /graphql や URL の形でも、event が literal でないものは deny
  `gh api /graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:APPROVE}){clientMutationId}}'`,
  `gh api https://api.github.com/graphql -f query='mutation{submitPullRequestReview(input:{pullRequestId:"x",event:APPROVE}){clientMutationId}}'`,
  `gh api graphql -f query='mutation($e:PullRequestReviewEvent!){submitPullRequestReview(input:{event:$e}){clientMutationId}}' -f e=COMMENT`,
  `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:COMMENT,body:"ok"}){clientMutationId}}' -F input=@in.json`,
  `gh api graphql -f query='mutation{addPullRequestReview(input:{event:COMMENT}){x}}' -f query2=1 -f query="$Q"`,
  'gh api graphql -f query=$Q',
  'gh api graphql -f query="$(cat q.graphql)"',
  'gh api /graphql --input q.json',
  'gh api https://api.github.com/graphql -F query=@q.graphql',
  // コマンド名の大文字小文字
  'GH pr review 5 -a',
  'Gh pr review 5 --approve',
  '/usr/bin/GH pr review 5 -a',
  'GH pr merge 5',
  'GH api repos/o/r/pulls/5/reviews -f event=APPROVE',
  'GH -R o/r pr merge 5',
  'gh alias set m "pr merge"',
  'gh alias import a.yml',
  'gh extension install o/gh-x',
  'gh extensions list',
  "gh pr mer''ge 5",
  'gh pr m\\erge 5',
]

const MG_OBFUSCATED_DENY = [
  // 判定の区切り目印（SEP_MARK \001・引用符内の空白 \002）を偽造できる制御文字
  'gh pr review 5 -c -b "x\u0001SEP y"',
  'gh pr review 5 -c\u0001',
  'gh pr comment 5 --body x\u0002y',
  'echo \u007f',
  "echo $'\\x67\\x68'",
  'gh${IFS}pr${IFS}merge 1',
  'gh$IFS pr merge 1',
]

const MG_ALLOW = [
  // GraphQL: literal の COMMENT / REQUEST_CHANGES は許可（スレッド返信は従来どおり許可）
  `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"x",event:COMMENT,body:"ok"}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{submitPullRequestReview(input:{pullRequestReviewId:"x",event: REQUEST_CHANGES}){clientMutationId}}'`,
  `gh api graphql -f query='mutation{addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"x",body:"event: APPROVE"}){clientMutationId}}'`,
  // 日本語・タブを含むコマンドは制御文字として扱わない
  "gh pr comment 5 --body '確認しました\tOK'",
  // コメントの中のアポストロフィでも、-a を持たなければ止めない
  "echo # don't\ngh pr review 5 -c -b ok",
  // 全体走査でも -a の無い承認でない review は止めない
  'gh pr review 5 -b "see $(git rev-parse HEAD)" -c',
  // 大文字小文字違いでも読み取り・コメントは止めない
  'GH pr view 5 --json state',
  'gh api repos/o/r/pulls/5/reviews/ --jq length',
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
        for (const [cmd, reason] of NEST_DENY) {
          it(`deny ${reason}: ${JSON.stringify(cmd.length > 200 ? `${cmd.slice(0, 60)}…(${cmd.length}字)` : cmd)}`, async () => expectDeny(await run(bash, cmd, subagent), reason))
        }
        for (const cmd of NEST_ALLOW) {
          it(`allow: ${JSON.stringify(cmd.length > 200 ? `${cmd.slice(0, 60)}…(${cmd.length}字)` : cmd)}`, async () => expectAllow(await run(bash, cmd, subagent)))
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

    describe('判定に必要な基盤コマンドが無い環境（subagent のマージ系判定は fail-closed）', () => {
      for (const missing of ['awk', 'grep', 'sed', 'tr']) {
        it(`${missing} が無ければ deny internal-error`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'agent-guard-nocmd-'))
          try {
            for (const c of ['cat', 'awk', 'sed', 'tr', 'grep', 'jq']) {
              if (c === missing) continue
              symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${c}`]).toString().trim(), join(dir, c))
            }
            const r = await runRaw(bash, JSON.stringify({ command: 'gh pr view 5', subagent: true }), { PATH: dir })
            expectDeny(r, 'internal-error')
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        })
      }
    })

    it('結果を出さずに異常終了したら（未定義変数）EXIT trap が deny internal-error を出す', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-guard-trap-'))
      try {
        const src = readFileSync(GUARD, 'utf8')
        const needle = "| jq -r '.subagent | tostring') || finish deny bad-input\n"
        assert.ok(src.includes(needle))
        const mod = join(dir, 'agent-guard.sh')
        writeFileSync(mod, src.replace(needle, `${needle}: "$__ag_undefined_var"\n`))
        chmodSync(mod, 0o755)
        const r = await new Promise((resolve, reject) => {
          const p = spawn(bash, [mod], { stdio: ['pipe', 'pipe', 'ignore'] })
          let out = ''
          p.stdout.on('data', (d) => { out += d })
          p.on('error', reject)
          p.on('close', (code) => resolve({ code, out, last: out.split('\n').filter((l) => l !== '').pop() ?? '' }))
          p.stdin.end(JSON.stringify({ command: 'ls', subagent: false }))
        })
        expectDeny(r, 'internal-error')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
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

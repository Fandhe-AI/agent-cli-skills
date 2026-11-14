#!/usr/bin/env bash
# agent-guard.sh: Codex（PreToolUse hook）と OpenCode（server plugin）が共通に呼ぶ、
# シェルコマンド文字列の禁止判定ガード。各ツール用のアダプタ（codex-pretooluse.sh・
# plugin の index.js）が自ツールの入力を下記の契約へ変換して呼び、結果行だけを読む。
# 4 スキル（init-codex / init-opencode / update-codex / update-opencode）で同一内容を保つ
# 配布物であり、このファイル単体で完結する（他ファイルを source しない）。
#
# 位置づけ: best-effort の攻撃面削減であり、承認境界ではない。文字列照合では base64 復元・
# 変数間接呼び出し・ブレース／glob 展開・別のコマンドが生成した文字列の実行による難読化を防げない
# （bash -c / eval / heredoc / ダブルクォート内の $(...) の中身は再帰的に解析する。下記参照）。
# 実強制はサーバー側の branch protection（ruleset）と、人間がマージする運用が担う。
# 判定ロジックの設計経緯（なぜセグメント分割しないか・なぜ over-deny 側に倒すか）は
# implement-issue-tree の scripts/merge-guard-hook.sh の冒頭コメントが正典。
#
# 入力（stdin・JSON 1 個）:
#   {"command": "<シェルコマンド文字列>", "subagent": true | false | null}
#   subagent は呼び出し側が判別した結果。null（キー欠落を含む）は判別不能で、マージ系の
#   制限は true と同じく適用する（fail-closed）。
#
# 出力（stdout の最後の 1 行。入力の文字列は一切含めない）:
#   AGENT_GUARD_RESULT allow
#   AGENT_GUARD_RESULT deny <理由コード>
# 理由コード（固定語彙）:
#   no-verify      git の commit / push / merge / rebase / cherry-pick / am / revert / pull の
#                  --no-verify（略記を含む）、または commit の -n。フックの無効化・差し替えも同じ
#                  コードで止める: -c / --config-env の core.hooksPath、git config での
#                  core.hooksPath の設定・解除、コマンド先頭の HUSKY=0 / HUSKY_SKIP_HOOKS=1、
#                  alias の定義（-c alias.* と git config alias.*。値は解決せず定義自体を拒否）
#                  （全セッション）
#   force-push     git push の --force / -f / --mirror / +<refspec>（`--` の後の + 始まりも）/
#                  --force-with-lease（= 形・略記を含む）/ --force-if-includes。lease 付きでも
#                  既存コミットを消せるため許可しない（全セッション）
#   merge-guard    gh pr merge・REST / GraphQL のマージ・承認（gh pr review の --approve / -a、
#                  reviews API の event=APPROVE・判定できない --input / @file 形、GraphQL の
#                  addPullRequestReview / submitPullRequestReview + APPROVE）・gh alias・
#                  gh extension（subagent が true / null のとき）
#   repo-settings  ruleset・branch protection・リポジトリ本体の書き込み・gh repo edit 等
#                  （subagent が true / null のとき）
#   obfuscated     ANSI-C クォート $'...' や $IFS 展開、判定の目印に使う制御文字（\t \n \r 以外の
#                  C0 と DEL）を含むコマンド（subagent が true / null のとき）
#   nesting-limit  bash -c / eval / heredoc / $(...) / env -S の入れ子が解析の上限（深さ 8・件数 512）を
#                  超えた、ダブルクォート内の $( や `（引用符なし heredoc 本文の $( や `）の閉じを見つけられない、
#                  または heredoc の区切り子が見つからないまま入力の末尾に達した。中身を見切れないため
#                  拒否する（fail-closed。全セッション）
#   bad-input      stdin が空・JSON として不正・command が文字列でない・subagent が真偽値 / null でない
#   no-jq          jq が見つからない
#   internal-error 想定外の異常終了（結果行を出す前にスクリプトが落ちた場合の保険）
#
# 終了コード: allow は 0、deny（内部エラー・fail-closed の deny を含む）は 2。
#   呼び出し側は「最後の行が AGENT_GUARD_RESULT allow」かつ終了コード 0 のときだけ許可し、
#   結果行が無い・終了コードが 0 以外で行が無い場合は deny として扱うこと。
#
# 依存: bash 3.2 以上・jq・awk（POSIX）・sed・tr・grep。jq が無い場合は deny（fail-closed）。
set -uf

RESULT_DONE=0

# 結果行を出して終了する唯一の出口。reason は本スクリプト内の固定語彙だけを渡す契約。
finish() {
  RESULT_DONE=1
  if [ "$1" = allow ]; then
    printf 'AGENT_GUARD_RESULT allow\n'
    exit 0
  fi
  printf 'AGENT_GUARD_RESULT deny %s\n' "$2"
  exit 2
}

# 結果行を出す前に落ちた場合（未定義変数・想定外の失敗）は許可へ倒さず deny にする。
trap 'if [ "$RESULT_DONE" -eq 0 ]; then printf "AGENT_GUARD_RESULT deny internal-error\n"; exit 2; fi' EXIT

input=$(cat) || finish deny bad-input
case "$input" in
  *[![:space:]]*) : ;;
  *) finish deny bad-input ;;
esac

command -v jq >/dev/null 2>&1 || finish deny no-jq

# command は文字列、subagent は真偽値か null（キー欠落は null）に限る。
printf '%s' "$input" | jq -e '
  type == "object"
  and ((.command | type) == "string")
  and (((.subagent | type) == "boolean") or ((.subagent | type) == "null"))
' >/dev/null 2>&1 || finish deny bad-input

cmd=$(printf '%s' "$input" | jq -r '.command') || finish deny bad-input
subagent=$(printf '%s' "$input" | jq -r '.subagent | tostring') || finish deny bad-input

# --- 全セッション共通: git の --no-verify と force push --------------------------------
# コマンドを引用符・バックスラッシュ・コメント・ヒアドキュメント本体を理解する awk で
# トークン化し、制御演算子（; & | 改行 ( ) `）ごとのセグメントに分けて各セグメントの git を見る。
# merge-guard と違いここでセグメント分割をしてよいのは、判定対象が「1 つの git 呼び出しの
# 引数」であり、マージ系のように前段の出力を後段が読む構造（`printf ... | gh api --input -`）を
# 見る必要がないため。引用符を理解するのは、`git commit -m "fix -n handling"` や
# ヒアドキュメントのコミットメッセージ本文に書かれた語を誤検知しないため。
# 検査するもの（git のグローバルオプション -c / -C / --git-dir 等はサブコマンドの前で読み飛ばす）:
#   - hook を飛ばせるサブコマンドの --no-verify（git の一意な略記 --no-v… も同一視）
#   - commit の短縮 -n（-an のような束ね書きも。-m 等の値を取るオプション以降は値として扱う）
#   - push の --force / -f（束ね書きも。-o 以降は値）/ --force-with-lease / --force-if-includes /
#     先頭 + の refspec（`--` の後ろでも見る。`--` はオプション解析を終えるだけで refspec は残る）
# コマンド名の git は大文字小文字を区別せず照合する（macOS の FS 対策。パス付きも）。
# コマンド位置の前置語（{ then do else elif if while until ! time（option は -p だけ）と、env（basename で照合・-iS 等の束ね書きも）・
# sudo / doas / nice・nohup・command・exec・builtin・export・declare・typeset とその option）と代入は読み飛ばし、
# その後ろの HUSKY=0・env -S・echo / printf を判定する（sudo 等の後の echo は読み違いが迂回になるので対象にしない）。
# リダイレクト（< > >> &> >& >|）は語の区切りで、その後ろに置いた引数も検査する。リダイレクトの対象（ファイル名・
# fd。`2>` `{fd}>` の指定も）はコマンドでも引数でもないので語に積まない（`>echo git push -f` の echo を
# コマンドと取り違えない）。here-string の語も別に持ち、shell が読む場合だけ解析する。`>` `<` の後ろの `&` `|` は
# 直前の文字ではなく、解釈済みのリダイレクト演算子かどうかで決める（escape した `\>&` の & は制御演算子）。
# 算術式（((...)) / $((...)) / $[...]）・${...}・配列の添字つき代入（x[1<<2]=y）と複合代入（a=([1<<2]=y)。どちらも
# 代入を置ける位置だけ）内の << は heredoc とみなさない（中のコマンド置換・バッククォートは引用符の中でも読んで検査する。
# 閉じのない式は算術式とみなさず通常どおり検査する）。bash 5.3 の ${ cmd; } / ${| cmd; } は中身がコマンドそのものなので
# 値として読まず deny nesting-limit にする。
# ANSI-C 引用符 $'...' は \ の解釈つきで読み（\' では閉じない・\n \xHH \NNN を解釈する）、heredoc の区切り子の
# $'...' / $"..." も bash と同じに外す。heredoc の区切り子が見つからないまま入力の末尾に達したら、読み違いで
# 後続の実コマンドを隠していないか判定できないので deny nesting-limit にする。
# 入れ子の解析: 次の中身は元の文字列と別に積み、同じ解析器で順に再解析する（再帰ではなく作業キュー。
# 深さ 8・件数 512 を超えたら deny nesting-limit）。
#   - bash / sh / zsh / dash / ksh の -c の値（-lc 等の束ね書き・-o / -O の値・`--` を読み飛ばす）と eval の引数
#   - -c を持たない shell（`bash <<EOF`・`cat <<EOF | bash`・`bash <<< '...'`）が同じ行で読む
#     ヒアドキュメント本体と here-string。-c 付きや `bash script.sh` への heredoc は入力データなので見ない
#   - ダブルクォート内の $(...) とバッククォート置換（対応する ) は引用符・入れ子・${...}・ヒアドキュメント本体・
#     コメント・算術式を読み飛ばして探す）。`git commit -m "$(cat <<'EOF' ...)"` の本文は heredoc として読み飛ばすため
#     誤検知せず、本文に奇数個の " があっても後続行を引用符の中と取り違えない
#   - 引用符なしヒアドキュメント（`<<EOF`）の本文のコマンド置換（$(...)・バッククォート・${...} 内）。bash が展開
#     するため。引用符つき（`<<'EOF'` `<<\EOF`）の本文は展開されないので読まない
#   - ${...}・算術式・配列添字の中のコマンド置換
#   - env -S / --split-string の値（呼び出し元の HUSKY=0 は子へ引き継ぐ）
# echo / printf のセグメントは引数を表示するだけなので git の語があっても見ない（`echo git push -f` は許可）。
# 残存ギャップ（未対応。best-effort の限界であり、実強制は ruleset が担う）:
#   - パイプで shell へ渡す文字列（`echo 'git push -f' | bash`）・`cat > x.sh <<EOF` のあとで実行する形・
#     bash -c の追加引数（`bash -c 'git "$@"' _ push -f`）・source / `.` / `bash <(…)`・
#     `bash -c "$(cat <<EOF …)"` のように別のコマンドが生成した文字列
#   - $(...) 内の case 文の `)`・$'...' の \u \U \c（解釈せず残す）・sudo / doas / nice の未知の値を取る option・
#     sudo 等のラッパーを挟んだ echo の読み飛ばし（対象にしない = 誤って deny する側）
#   - merge-guard 側（subagent が true / null のときの判定）の `>&` `>|` は従来どおり直前の文字で判定する
#   - main セッションでの難読化（変数間接・base64 復元・ブレース / glob 展開。obfuscated の
#     判定は subagent が true / null のときだけ）
#   - alias は -c と git config での定義だけを止める。利用者の設定ファイルに既にある alias、
#     include.path 経由の設定取り込み、GIT_CONFIG_* 環境変数、SKIP= 等の他のフック回避
#   - HUSKY=0 は同じコマンド文字列内の代入だけを見る（別の呼び出しで export 済みのものは見えない）
read -r -d '' GIT_AWK <<'AWK' || true
function isws(c) { return (c == " " || c == "\t" || c == "\r") }
# 語を確定する。リダイレクトの直後の語（rd == 1。対象のファイル名・fd）はコマンドでも引数でもないので積まない。
# here-string の語（rd == 2）は shell が script として読むときのために tok と別の hs へ積む。
function emit_tok() {
  if (have) {
    if (rd == 1) rd = 0
    else if (rd == 2) { nhs++; hs[nhs] = cur; rd = 0 }
    else { ntok++; tok[ntok] = cur }
  }
  cur = ""; have = 0
}
# リダイレクト演算子（< > <<<）の手前の語を片づける。`2>` `{fd}>` の fd 指定は語ではないので捨てる。
function redir_flush() {
  if (have && (cur ~ /^[0-9]+$/ || cur ~ /^[{][A-Za-z_][A-Za-z0-9_]*[}]$/)) { cur = ""; have = 0 }
  else emit_tok()
}
function setv(v) { if (verdict == "") verdict = v }
function end_seg() { emit_tok(); if (ntok > 0) analyze(); ntok = 0; nhs = 0; rd = 0; split("", hs) }
# 入れ子の中身（bash -c の値・eval の引数・ヒアドキュメント本体・$(...) の中・env -S の値）を作業キューへ積む。
# 深さ・件数の上限を超えたら中身を見切れないので limit を立てる（結果は deny nesting-limit）。
function enqueue(s, h) {
  if (cdepth + 1 > MAXD || nq >= MAXQ) { limit = 1; return }
  nq++; qs[nq] = s; qd[nq] = cdepth + 1; qh[nq] = h
}
function split_has_h(v) { return (v ~ /(^|[ \t\n])(HUSKY=0|HUSKY_SKIP_HOOKS=1)([ \t\n]|$)/) }
function join_from(k,   s) {
  s = ""
  for (; k <= ntok; k++) s = s (s == "" ? "" : " ") tok[k]
  return s
}
# shell（bash 等）の引数列。-c の値を積んで 1 を返す。-c も入力ファイルも無く標準入力を読むなら 0
# （heredoc / here-string が本体になる）。ファイル名を取るなら 2（heredoc は入力データ）。
function shell_args(j, hk,   t, cf, sf, b, lc) {
  cf = 0; sf = 0
  for (; j <= ntok; j++) {
    t = tok[j]
    if (t == "--" || t == "-") { j++; break }
    if (t ~ /^--/) { if (t == "--rcfile" || t == "--init-file") j++; continue }
    if (t ~ /^[-+][^-+]/) {
      b = substr(t, 2)
      if (substr(t, 1, 1) == "-") { if (index(b, "c") > 0) cf = 1; if (index(b, "s") > 0) sf = 1 }
      lc = substr(b, length(b), 1)
      if (lc == "o" || lc == "O") j++
      continue
    }
    break
  }
  if (j > ntok) return 0
  if (cf) { enqueue(tok[j], hk); return 1 }
  return (sf ? 0 : 2)
}
# env -S / --split-string の値を作業キューへ積み、回避の代入を含むかを返す。
function env_split(v, hh) { enqueue(v, hh); return split_has_h(v) }
function analyze(   i, m, t, lt, p, v, seg_h, seg_s, noecho, wr, vl, hk, st, cap, ch, rest) {
  # コマンド位置の前置語（{ then do else ! time 等のキーワードと env・sudo・export・declare 等のラッパー）・
  # 代入（FOO=1 HUSKY=0 git ...）・ラッパーの option を読み飛ばし、フック回避の代入を拾う。
  # env は basename で照合し、値を取る短縮 option（-u -C -P -a -S）は束ね書き（-iS）も 1 文字ずつ読む。
  # -S / --split-string の値は回避の代入があれば同じセグメントの後続の git に効くものとして扱い（seg_s。
  # 後のセグメントへは持ち越さない）、値そのものも別に解析する（`env -S 'HUSKY=0 git commit'`・`env -S 'git push -f'`）。
  # sudo / doas / nice の値を取る option も同様に読み飛ばす（`sudo -u root HUSKY=0 git ...`）。
  p = 1; seg_h = 0; seg_s = 0; noecho = 0; wr = ""
  while (p <= ntok) {
    t = tok[p]; lt = tolower(t)
    if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { if (t == "HUSKY=0" || t == "HUSKY_SKIP_HOOKS=1") seg_h = 1; p++ }
    else if (t ~ /^([{]|then|do|else|elif|if|while|until|!)$/) { wr = ""; p++ }
    else if (t == "time") { wr = "time"; p++ }
    else if (lt ~ /(^|\/)(env|sudo|doas|nice|nohup|command|exec|builtin)$/ || lt == "export" || lt == "declare" || lt == "typeset") {
      noecho = 1; wr = lt; sub(/^.*\//, "", wr); p++
    }
    else if (wr == "time" && t == "-p") p++
    else if (wr != "" && wr != "time" && t ~ /^-./) {
      if (wr == "env" && t ~ /^--/) {
        if (t == "--split-string") { if (p < ntok && env_split(tok[p + 1], (seg_h || husky_persist))) seg_s = 1; p += 2 }
        else if (t ~ /^--split-string=/) { v = t; sub(/^--split-string=/, "", v); if (env_split(v, (seg_h || husky_persist))) seg_s = 1; p++ }
        else if (t == "--unset" || t == "--chdir" || t == "--argv0") p += 2
        else p++
      }
      else if (wr == "env") {
        for (m = 2; m <= length(t); m++) if (index("uCSPa", substr(t, m, 1)) > 0) break
        if (m > length(t)) p++
        else {
          ch = substr(t, m, 1); rest = substr(t, m + 1)
          if (rest == "") { v = (p < ntok) ? tok[p + 1] : ""; p += 2 } else { v = rest; p++ }
          if (ch == "S" && v != "" && env_split(v, (seg_h || husky_persist))) seg_s = 1
        }
      }
      else if (wr == "sudo" || wr == "doas" || wr == "nice") {
        if (t ~ /^--/) p += (t ~ /^--(user|group|host|prompt|chdir|chroot|role|type|other-user|close-from|command-timeout)$/) ? 2 : 1
        else {
          vl = (wr == "sudo") ? "ugphCDRTUrt" : ((wr == "doas") ? "uC" : "n")
          for (m = 2; m <= length(t); m++) if (index(vl, substr(t, m, 1)) > 0) break
          if (m > length(t) || m < length(t)) p++; else p += 2
        }
      }
      else p++
    }
    else break
  }
  hk = husky_persist
  if (p > ntok) { if (seg_h) husky_persist = 1 } else if (seg_h || seg_s) hk = 1
  # echo / printf は引数を表示するだけで、git の語があっても実行しない。
  # env・sudo 等のラッパー経由は読み飛ばしが近似（`env -a echo git push -f` は argv0 指定で git を実行する。
  # sudo の値を取る option の読み違いは echo の語を値として読む迂回になる）なので対象にしない。
  if (p <= ntok && !noecho) { lt = tolower(tok[p]); if (lt == "echo" || lt == "printf") return }
  cap = 0
  for (i = 1; i <= ntok; i++) {
    t = tok[i]; lt = tolower(t)
    if (lt == "git" || lt ~ /\/git$/) git_args(i + 1, hk)
    else if (lt == "eval") enqueue(join_from(i + 1), hk)
    else if (lt ~ /(^|\/)(bash|sh|zsh|dash|ksh)$/) {
      st = shell_args(i + 1, hk)
      if (st == 0) { cap = 1; linecap = 1; linehk = hk }
    }
  }
  # -c の無い shell は here-string の語を、同じ行のヒアドキュメント本体（newline の処理で読む）とともに script として読む。
  if (cap) for (m = 1; m <= nhs; m++) enqueue(hs[m], hk)
}
# 短縮オプションの束ね書きを走査する。stop に含まれる文字は以降が値なので打ち切る。
function short_has(a, target, stop,   m, ch) {
  for (m = 2; m <= length(a); m++) {
    ch = substr(a, m, 1)
    if (index(stop, ch) > 0) return 0
    if (ch == target) return 1
  }
  return 0
}
# a の次のトークンがオプションの値か。longs は値を取る完全一致のオプション列（空白区切り）、
# stops は値を取る短縮オプション文字。束ね書きは最初の stops 文字が末尾のときだけ次トークンが値
# （-am msg の m は末尾 = 次が値・-mfoo は連結形 = 次は値ではない）。
function opt_val_next(a, longs, stops,   m, ch) {
  if (index(" " longs " ", " " a " ") > 0) return 1
  if (a ~ /^-[^-]/) {
    for (m = 2; m <= length(a); m++) {
      ch = substr(a, m, 1)
      if (index(stops, ch) > 0) return (m == length(a))
    }
  }
  return 0
}
# git の設定キー（-c の値・git config のキー）がフック・alias の差し替えか。
function conf_bad(kv,   lk) {
  lk = tolower(kv)
  return (lk ~ /^core\.hookspath([=]|$)/ || lk ~ /^alias\./)
}
# git config の引数列。core.hooksPath / alias.* を「設定・解除する形」だけ拒否する
# （--get 系・引数がキー 1 つだけの読み取りは許可）。
function config_args(k,   a, ro, wflag, np, key, nkey) {
  ro = 0; wflag = 0; np = 0; key = ""; nkey = 0
  for (; k <= ntok; k++) {
    a = tok[k]
    if (a == "--get" || a == "--get-all" || a == "--get-regexp" || a == "--get-urlmatch" || a == "--list" || a == "-l") ro = 1
    else if (a == "--unset" || a == "--unset-all" || a == "--add" || a == "--replace-all") wflag = 1
    else if (a == "-f" || a == "--file" || a == "--blob" || a == "--type" || a == "-t" || a == "--default") k++
    else if (substr(a, 1, 1) == "-") continue
    else {
      np++
      if (np == 1 && (a == "get" || a == "list")) ro = 1
      else if (np == 1 && (a == "set" || a == "unset")) wflag = 1
      else { nkey++; if (nkey == 1) key = a }
    }
  }
  if (key != "" && conf_bad(key) && (wflag || (!ro && nkey >= 2))) setv("no-verify")
}
function git_args(j, hk,   t, scmd, k, a, hooked, dd, eq, nm) {
  while (j <= ntok) {
    t = tok[j]
    if (t == "-c" || t == "--config-env") { if (conf_bad(tok[j + 1])) setv("no-verify"); j += 2 }
    else if (substr(t, 1, 2) == "-c" && length(t) > 2) { if (conf_bad(substr(t, 3))) setv("no-verify"); j++ }
    else if (t == "-C" || t == "--git-dir" || t == "--work-tree" || t == "--namespace" || t == "--super-prefix") j += 2
    else if (substr(t, 1, 12) == "--config-env" && conf_bad(substr(t, 14))) { setv("no-verify"); j++ }
    else if (substr(t, 1, 1) == "-") j++
    else break
  }
  if (j > ntok) return
  scmd = tok[j]
  if (scmd == "config") config_args(j + 1)
  hooked = (scmd == "commit" || scmd == "push" || scmd == "merge" || scmd == "rebase" || scmd == "cherry-pick" || scmd == "am" || scmd == "revert" || scmd == "pull")
  if (hk && hooked) setv("no-verify")
  for (k = j + 1; k <= ntok; k++) {
    a = tok[k]
    # `--` 以降は引数（パス・ref 名）でありフラグ判定しない。ただし push の + 始まりの refspec は
    # `--` の後ろでも force push なので見続ける。値を取るオプションの次トークンはループ末尾で読み飛ばす。
    if (a == "--") { dd = 1; continue }
    if (dd) {
      if (scmd == "push" && length(a) >= 2 && substr(a, 1, 1) == "+") setv("force-push")
      continue
    }
    if (hooked && length(a) >= 6 && length(a) <= 11 && substr(a, 1, 6) == "--no-v" && index("--no-verify", a) == 1) setv("no-verify")
    if (scmd == "commit" && a ~ /^-[^-]/ && short_has(a, "n", "mFCctuS")) setv("no-verify")
    if (scmd == "push") {
      if (a == "--force") setv("force-push")
      else if (length(a) >= 3 && length(a) <= 8 && index("--mirror", a) == 1) setv("force-push")
      else if (substr(a, 1, 8) == "--force-") {
        # --force-with-lease[=<値>] と --force-if-includes（git の一意な略記も）。lease 付きでも既存コミットを消せる。
        eq = index(a, "="); nm = (eq > 0) ? substr(a, 1, eq - 1) : a
        if (index("--force-with-lease", nm) == 1 || index("--force-if-includes", nm) == 1) setv("force-push")
      }
      else if (a ~ /^-[^-]/) { if (short_has(a, "f", "o")) setv("force-push") }
      else if (length(a) >= 2 && substr(a, 1, 1) == "+") setv("force-push")
    }
    # 束ね書きの -nm x の n は上で判定済み。ここで次トークン（値）を読み飛ばす。
    if (scmd == "commit" && opt_val_next(a, "-m -F -C -c -t --message --file --author --date --template --reuse-message --reedit-message --fixup --squash --trailer --cleanup --pathspec-from-file", "mFCct")) k++
    else if (scmd == "push" && opt_val_next(a, "-o --push-option --receive-pack --exec --repo", "o")) k++
  }
}
# 算術式 ((...)) / $((...)) の終端（`))` の次の位置）。br が 1 のときは旧式の $[...]（`]` の次の位置）。
# 中のコマンド置換・バッククォートは読み飛ばし、その本文を ab へ集める（en が 1 で成功したときだけ作業キューへ積む。
# 呼び出し側の text 全体は別途 sub_end 等で読み直されることがあるので、en = 0 で本文を重複して積まない）。
# 算術式の中は引用符が引用にならず（`$(( "$(cmd)" ))` の $( も展開される）、引用符は特別扱いしない。
# 閉じが見つからない・`$((cmd); cmd)` のような算術式でないものは 0 を返し、通常のトークン化に任せる。
function arith_end(k, en, br,   base, r, j) {
  base = abn; r = arith_scan(k, br)
  if (r > 0 && en) for (j = base + 1; j <= abn; j++) enqueue(ab[j], husky_persist)
  abn = base
  return r
}
function br_end(k, en) { return arith_end(k, en, 1) }
function arith_scan(k, br,   d, c, r) {
  d = 0
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (br) {
      if (c == "[") d++
      else if (c == "]") { if (d == 0) return k + 1; d-- }
      else if (c == "\n") return 0
    } else {
      if (c == "(") d++
      else if (c == ")") { if (d == 0) return (substr(text, k + 1, 1) == ")") ? k + 2 : 0; d-- }
    }
    if (c == "`") { r = bq_end(k + 1); if (r == 0) return 0; abn++; ab[abn] = bq_unesc(substr(text, k + 1, r - k - 2)); k = r; continue }
    if (c == "$" && substr(text, k + 1, 1) == "(") {
      if (!br && substr(text, k + 2, 1) == "(") { r = arith_scan(k + 3, 0); if (r > 0) { k = r; continue } }
      r = sub_end(k + 2)
      if (r == 0) return 0
      abn++; ab[abn] = substr(text, k + 2, r - k - 2); k = r + 1; continue
    }
    k++
  }
  return 0
}
# バッククォート置換の終端（閉じの `` ` `` の次の位置）。k は開きの次。閉じが無ければ 0。
function bq_end(k,   c) {
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "`") return k + 1
    k++
  }
  return 0
}
# バッククォートの中身を再解析する文字列へ戻す（\\ \$ \` の \ を外す）。
function bq_unesc(s,   o, n, i, c, nx) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { nx = substr(s, i + 1, 1); if (nx == "\\" || nx == "$" || nx == "`") { o = o nx; i++; continue } }
    o = o c
  }
  return o
}
# パラメータ展開 ${...} の終端（閉じの `}` の次の位置）と、複合代入 name=(...) の終端（閉じの `)` の次の位置）。
# k は `${` / `(` の次。中の引用符・コマンド置換・入れ子の ${...} を読み飛ばすので、`${x:-<<EOF }` の << を
# heredoc と取り違えない。ダブルクォートの中（q）は `'` が引用にならず閉じ記号も数えない。dqc が 1 のときは
# 呼び出し元が既にダブルクォートと同じ文脈（引用符なし heredoc 本文）なので `'` も引用にならない。
# en が 1 のとき中のコマンド置換の本文を作業キューへ積む（`${x:-"$(git push -f)"}`）。閉じが見つからなければ 0。
# bash 5.3 の ${ cmd; } / ${| cmd; } は中身がコマンドそのものなので単位として読まない（0）。
function ws_end(k, en, dqc, cl,   c, c2, r, q, d) {
  if (cl == "}" && substr(text, k, 1) ~ /^[ \t\n|]$/) return 0
  q = 0; d = 0
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "\047" && !q && !dqc) { r = index(substr(text, k + 1), "\047"); if (r == 0) return 0; k += r + 1; continue }
    if (c == "\"") { q = !q; k++; continue }
    if (c == "`") {
      r = bq_end(k + 1)
      if (r == 0) return 0
      if (en) enqueue(bq_unesc(substr(text, k + 1, r - k - 2)), husky_persist)
      k = r; continue
    }
    if (c == "$") {
      c2 = substr(text, k + 1, 1)
      if (c2 == "(") {
        if (substr(text, k + 2, 1) == "(") { r = arith_end(k + 3, en, 0); if (r > 0) { k = r; continue } }
        r = sub_end(k + 2)
        if (r == 0) return 0
        if (en) enqueue(substr(text, k + 2, r - k - 2), husky_persist)
        k = r + 1; continue
      }
      if (c2 == "{") { r = ws_end(k + 2, en, (dqc || q), "}"); if (r == 0) return 0; k = r; continue }
    }
    if (!q) {
      if (cl == "}" && c == "}") return k + 1
      if (cl == ")") {
        if (c == "(") d++
        else if (c == ")") { if (d == 0) return k + 1; d-- }
      }
    }
    k++
  }
  return 0
}
function pe_end(k, en, dqc) { return ws_end(k, en, dqc, "}") }
function ca_end(k, en) { return ws_end(k, en, 0, ")") }
# ANSI-C 引用符 $'...' の終端（閉じの `'` の次の位置）。k は `$'` の次。単一引用符と違い \ で閉じの `'` を
# escape できる（`$'\''` は `'` 1 文字）。閉じが無ければ 0。
function ansi_end(k,   c) {
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "\047") return k + 1
    k++
  }
  return 0
}
function hexv(c) { return index("0123456789abcdef", tolower(c)) - 1 }
function chr(v) { return (v >= 1 && v < 128) ? sprintf("%c", v) : "?" }
# $'...' の中身の \ 表記を bash と同じ値にする（\n \t \xHH \NNN 等。\u \U \c は解釈せずそのまま残す）。
function ansi_dec(s,   o, n, i, c, nx, v, j, d, e) {
  o = ""; n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c != "\\") { o = o c; i++; continue }
    nx = substr(s, i + 1, 1); i += 2
    if (nx == "n") o = o "\n"
    else if (nx == "t") o = o "\t"
    else if (nx == "r") o = o "\r"
    else if (nx == "a") o = o chr(7)
    else if (nx == "b") o = o chr(8)
    else if (nx == "e" || nx == "E") o = o chr(27)
    else if (nx == "f") o = o chr(12)
    else if (nx == "v") o = o chr(11)
    else if (nx == "\\" || nx == "\047" || nx == "\"" || nx == "?") o = o nx
    else if (nx == "x") {
      v = 0; e = 0
      for (j = 0; j < 2; j++) { d = hexv(substr(s, i + j, 1)); if (d < 0) break; v = v * 16 + d; e++ }
      if (e == 0) o = o "\\x"; else { o = o chr(v); i += e }
    }
    else if (nx ~ /^[0-7]$/) {
      v = nx + 0; e = 0
      for (j = 0; j < 2; j++) { d = substr(s, i + j, 1); if (d !~ /^[0-7]$/) break; v = v * 8 + d; e++ }
      o = o chr(v); i += e
    }
    else o = o "\\" nx
  }
  return o
}
# ヒアドキュメントの区切り語を k から読む。引用符・\・$'...'・$"..." を bash と同じに外した値を返し、
# 読み終えた次の位置を hdpos、引用符や \ があったか（本文でコマンド置換が展開されないか）を hdquoted に残す。
function hd_word(k,   w, c, q, r) {
  w = ""; hdquoted = 0
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\047" || c == "\"") {
      hdquoted = 1; q = c; k++
      while (k <= len && substr(text, k, 1) != q) { w = w substr(text, k, 1); k++ }
      k++
    } else if (c == "$" && substr(text, k + 1, 1) == "\047") {
      r = ansi_end(k + 2)
      if (r > 0) { hdquoted = 1; w = w ansi_dec(substr(text, k + 2, r - k - 3)); k = r } else { w = w c; k++ }
    } else if (c == "$" && substr(text, k + 1, 1) == "\"") k++
    else if (c == "\\") { hdquoted = 1; w = w substr(text, k + 1, 1); k += 2 }
    else if (isws(c) || c == "\n" || index(";&|<>()", c) > 0) break
    else { w = w c; k++ }
  }
  hdpos = k
  return w
}
# 引用符なしヒアドキュメントの本文は bash が展開するので、コマンド置換（$(...)・バッククォート・${...} 内）を
# 作業キューへ積む。\ で escape した置換は対象外。閉じが見つからなければ中身を見切れないので limit。
function heredoc_subs(b,   st, sl, k, c, c2, r) {
  st = text; sl = len; text = b; len = length(b); k = 1
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "`") {
      r = bq_end(k + 1)
      if (r == 0) { limit = 1; break }
      enqueue(bq_unesc(substr(text, k + 1, r - k - 2)), husky_persist); k = r; continue
    }
    if (c == "$") {
      c2 = substr(text, k + 1, 1)
      if (c2 == "(") {
        if (substr(text, k + 2, 1) == "(") { r = arith_end(k + 3, 1, 0); if (r > 0) { k = r; continue } }
        r = sub_end(k + 2)
        if (r == 0) { limit = 1; break }
        enqueue(substr(text, k + 2, r - k - 2), husky_persist); k = r + 1; continue
      }
      if (c2 == "{") {
        if (substr(text, k + 2, 1) ~ /^[ \t\n|]$/) { limit = 1; break }
        r = pe_end(k + 2, 1, 1); if (r > 0) { k = r; continue }
      }
      if (c2 == "[") { r = br_end(k + 2, 1); if (r > 0) { k = r; continue } }
    }
    k++
  }
  text = st; len = sl
}
# ダブルクォート文字列の終端（閉じの `"` の次の位置）。k は開きの `"` の次。中の $(...) は sub_end で、
# バッククォートは bq_end で読み飛ばす。閉じが見つからなければ 0。
function dq_end(k,   c, r) {
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "\"") return k + 1
    if (c == "`") { r = bq_end(k + 1); if (r == 0) return 0; k = r; continue }
    if (c == "$" && substr(text, k + 1, 1) == "(") {
      if (substr(text, k + 2, 1) == "(") { r = arith_end(k + 3, 0, 0); if (r > 0) { k = r; continue } }
      r = sub_end(k + 2)
      if (r == 0) return 0
      k = r + 1; continue
    }
    k++
  }
  return 0
}
# コマンド置換 $( の次の位置 k から、対応する `)` の位置を返す（見つからなければ 0）。
# 単一引用符・ANSI-C 引用符・ダブルクォート（入れ子の $(...) を含む）・バッククォート・${...}・算術式・コメント・
# ヒアドキュメント本体（本文の括弧や引用符を数えない）を読み飛ばして括弧の深さを数える。
function sub_end(k,   d, c, r, pend, pc, w, dash, line, hw, hd, rest, p) {
  d = 1; pend = ""
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "\\") { k += 2; continue }
    if (c == "$" && substr(text, k + 1, 1) == "\047") { r = ansi_end(k + 2); if (r == 0) return 0; k = r; continue }
    if (c == "$" && substr(text, k + 1, 1) == "{") { r = pe_end(k + 2, 0, 0); if (r > 0) { k = r; continue } }
    if (c == "\047") {
      k++
      while (k <= len && substr(text, k, 1) != "\047") k++
      if (k > len) return 0
      k++; continue
    }
    if (c == "\"") { k = dq_end(k + 1); if (k == 0) return 0; continue }
    if (c == "`") { r = bq_end(k + 1); if (r == 0) return 0; k = r; continue }
    if (c == "$" && substr(text, k + 1, 1) == "[") { r = br_end(k + 2, 0); if (r > 0) { k = r; continue } }
    if (c == "(" && substr(text, k + 1, 1) == "(") { r = arith_end(k + 2, 0, 0); if (r > 0) { k = r; continue } }
    if (c == "(") { d++; k++; continue }
    if (c == ")") { d--; if (d == 0) return k; k++; continue }
    if (c == "#") {
      pc = substr(text, k - 1, 1)
      if (pc == " " || pc == "\t" || pc == "\n" || pc == ";" || pc == "&" || pc == "|" || pc == "(") {
        while (k <= len && substr(text, k, 1) != "\n") k++
        continue
      }
    }
    if (c == "<" && substr(text, k, 3) == "<<<") { k += 3; continue }
    if (c == "<" && substr(text, k, 2) == "<<") {
      k += 2; dash = 0
      if (substr(text, k, 1) == "-") { dash = 1; k++ }
      while (k <= len && isws(substr(text, k, 1))) k++
      w = hd_word(k); k = hdpos
      pend = pend dash w "\001"
      continue
    }
    if (c == "\n" && pend != "") {
      k++
      while (pend != "") {
        p = index(pend, "\001"); hw = substr(pend, 1, p - 1); pend = substr(pend, p + 1)
        hd = substr(hw, 1, 1); hw = substr(hw, 2)
        while (k <= len) {
          rest = substr(text, k); p = index(rest, "\n")
          if (p == 0) { line = rest; k = len + 1 } else { line = substr(rest, 1, p - 1); k += p }
          if (hd == "1") sub(/^\t+/, "", line)
          if (line == hw) break
        }
      }
      continue
    }
    k++
  }
  return 0
}
# 現在の語が代入を置ける位置か（前に積んだ語が代入・キーワード・export 等とその option だけ）。
function assign_pos(   m, t) {
  for (m = 1; m <= ntok; m++) {
    t = tok[m]
    if (t ~ /^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?[+]?=/ || t ~ /^([{]|then|do|else|elif|if|while|until|!|time|export|declare|typeset|local|readonly)$/ || t ~ /^-./) continue
    return 0
  }
  return 1
}
# 1 つの文字列をトークン化して各セグメントを解析する。入れ子の中身は enqueue で積み、END が順に流す。
function scan(txt, dp, hkin,   ch, nx, c2, h, rest, p, line, r, dash, w, i, body, found) {
  text = txt; len = length(text); i = 1; cur = ""; have = 0; ntok = 0; nhs = 0; rd = 0; rdpos = -5; rdc = ""
  abn = 0; hdn = 0; linecap = 0; linehk = 0
  split("", hs); cdepth = dp; husky_persist = hkin
  while (i <= len) {
    ch = substr(text, i, 1)
    if (ch == "\\") {
      nx = substr(text, i + 1, 1)
      if (nx != "\n") { cur = cur nx; have = 1 }
      i += 2; continue
    }
    if (ch == "$" && substr(text, i + 1, 1) == "\047") {
      r = ansi_end(i + 2)
      if (r > 0) { cur = cur ansi_dec(substr(text, i + 2, r - i - 3)); have = 1; i = r; continue }
    }
    if (ch == "\047") {
      have = 1; i++
      while (i <= len && (c2 = substr(text, i, 1)) != "\047") { cur = cur c2; i++ }
      i++; continue
    }
    if (ch == "\"") {
      have = 1; i++
      while (i <= len) {
        c2 = substr(text, i, 1)
        if (c2 == "\"") break
        if (c2 == "\\") {
          nx = substr(text, i + 1, 1)
          if (nx == "\"" || nx == "\\" || nx == "$" || nx == "`") { cur = cur nx; i += 2; continue }
          if (nx == "\n") { i += 2; continue }
        }
        if (c2 == "$" && substr(text, i + 1, 1) == "(") {
          if (substr(text, i + 2, 1) == "(") { r = arith_end(i + 3, 1, 0); if (r > 0) { cur = cur substr(text, i, r - i); i = r; continue } }
          r = sub_end(i + 2)
          if (r > 0) { enqueue(substr(text, i + 2, r - i - 2), husky_persist); cur = cur "$()"; i = r + 1; continue }
          limit = 1
        }
        if (c2 == "`") {
          r = bq_end(i + 1)
          if (r > 0) { enqueue(bq_unesc(substr(text, i + 1, r - i - 2)), husky_persist); cur = cur "``"; i = r; continue }
          limit = 1
        }
        if (c2 == "$" && substr(text, i + 1, 1) == "{" && substr(text, i + 2, 1) ~ /^[ \t\n|]$/) limit = 1
        cur = cur c2; i++
      }
      i++; continue
    }
    if (ch == "#" && !have && cur == "") {
      while (i <= len && substr(text, i, 1) != "\n") i++
      continue
    }
    if (isws(ch)) { emit_tok(); i++; continue }
    if (ch == "\n") {
      end_seg(); i++
      for (h = 1; h <= hdn; h++) {
        body = ""; found = 0
        while (i <= len) {
          rest = substr(text, i)
          p = index(rest, "\n")
          if (p == 0) { line = rest; i = len + 1 } else { line = substr(rest, 1, p - 1); i += p }
          if (hdd[h]) sub(/^\t+/, "", line)
          if (line == hdw[h]) { found = 1; break }
          if (linecap || !hdq[h]) body = body line "\n"
        }
        # 区切り子が見つからないまま入力の末尾に達した。bash は残り全部を本文として読むが、これが本物の
        # heredoc でなく読み違いだと後続の実コマンドを隠す（攻撃側が区切り子の行を用意できる）ので中身を見切れない。
        if (!found) limit = 1
        if (body != "") { if (linecap) enqueue(body, linehk); else heredoc_subs(body) }
      }
      hdn = 0; linecap = 0; continue
    }
    if (ch == "<" && substr(text, i, 3) == "<<<") { redir_flush(); rd = 2; i += 3; continue }
    if (ch == "$" && substr(text, i + 1, 1) == "[") { r = br_end(i + 2, 1); if (r > 0) { cur = cur substr(text, i, r - i); have = 1; i = r; continue } }
    if (ch == "$" && substr(text, i + 1, 1) == "{") {
      # bash 5.3 の ${ cmd; } / ${| cmd; } は中身がコマンドそのもの。値として読まず（echo の引数として見逃さない）fail-closed にする。
      if (substr(text, i + 2, 1) ~ /^[ \t\n|]$/) limit = 1
      else { r = pe_end(i + 2, 1, 0); if (r > 0) { cur = cur substr(text, i, r - i); have = 1; i = r; continue } }
    }
    # 配列の添字つき代入 x[1<<2]=y と複合代入 a=([1<<2]=y) は、代入を置ける位置では添字・中身を含めて 1 語
    # （その << は heredoc でない）。引数の位置（`ls x[; cmd; y]=1`）では bash も 1 語にしないので読まない。
    if (ch == "(" && have && cur ~ /^[A-Za-z_][A-Za-z0-9_]*[+]?=$/ && assign_pos()) {
      r = ca_end(i + 1, 0)
      if (r > 0) { ca_end(i + 1, 1); cur = cur substr(text, i, r - i); i = r; continue }
    }
    if (ch == "[" && have && cur ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && assign_pos()) {
      r = br_end(i + 1, 0)
      if (r > 0 && (substr(text, r, 1) == "=" || substr(text, r, 2) == "+=")) { br_end(i + 1, 1); cur = cur substr(text, i, r - i); i = r; continue }
    }
    if (ch == "(" && substr(text, i + 1, 1) == "(") { r = arith_end(i + 2, 1, 0); if (r > 0) { cur = cur substr(text, i, r - i); have = 1; i = r; continue } }
    # >& <& &> >| の & | はリダイレクトの一部。直前の文字ではなく、直前の < > を演算子として解釈したか（rdpos）で決める
    # （`echo \>&git push -f` の escape した > の後ろの & は制御演算子）。
    if (ch == "&" && (rdpos == i - 1 || substr(text, i + 1, 1) == ">")) { emit_tok(); i++; continue }
    if (ch == "|" && rdpos == i - 1 && rdc == ">") { emit_tok(); i++; continue }
    if (ch == ";" || ch == "|" || ch == "&" || ch == "(" || ch == ")" || ch == "`") { end_seg(); i++; continue }
    if (ch == "<" && substr(text, i, 2) == "<<") {
      redir_flush()
      i += 2; dash = 0
      if (substr(text, i, 1) == "-") { dash = 1; i++ }
      while (i <= len && isws(substr(text, i, 1))) i++
      w = hd_word(i); i = hdpos
      hdn++; hdw[hdn] = w; hdd[hdn] = dash; hdq[hdn] = hdquoted
      continue
    }
    if (ch == "<" || ch == ">") { redir_flush(); rd = 1; rdpos = i; rdc = ch; i++; continue }
    cur = cur ch; have = 1; i++
  }
  end_seg()
  if (hdn > 0) limit = 1
}
{ alltext = alltext $0 "\n" }
END {
  verdict = ""; limit = 0; nq = 0; MAXD = 8; MAXQ = 512
  scan(alltext, 0, 0)
  for (qi = 1; qi <= nq && verdict == ""; qi++) scan(qs[qi], qd[qi], qh[qi])
  if (verdict == "" && limit) verdict = "nesting-limit"
  printf "%s\n", (verdict == "") ? "ok" : verdict
}
AWK

git_verdict=$(printf '%s\n' "$cmd" | awk "$GIT_AWK") || finish deny internal-error
case "$git_verdict" in
  ok) : ;;
  no-verify) finish deny no-verify ;;
  force-push) finish deny force-push ;;
  nesting-limit) finish deny nesting-limit ;;
  *) finish deny internal-error ;;
esac

# subagent が false（main セッション）はここまで。マージ系の制限は対象外。
[ "$subagent" = false ] && finish allow

# --- subagent（true）と判別不能（null）: merge-guard-hook.sh の deny 対象 ---------------
# 以下は implement-issue-tree/scripts/merge-guard-hook.sh と同じ判定（レビュー承認の判定を含む。
# 制御文字の拒否・基盤コマンドの存在確認・pipefail・gh の大文字小文字・REST / GraphQL の承認の検査・
# -a の normal / flat 走査も同じ）。違いは入出力（hook JSON ではなく上記契約）と deny の出し方
# （理由コード）だけ。判定を直すときは両方を同じ内容に保つ。行番号では対応づけない
# （どちらのファイルも編集で行がずれる）。

# 判定に使う基盤コマンドが無いと、証拠照合が黙って不成立（= 許可）になる。不在は deny に倒す。
for _ag_cmd in awk grep sed tr; do
  command -v "$_ag_cmd" >/dev/null 2>&1 || finish deny internal-error
done

# 制御文字（\t・\n・\r を除く）を含むコマンドは deny する。\001 は区切りの目印（SEP_MARK）、\002 は
# 引用符内の空白の目印として判定内部で使うため、コマンド文字列に混ぜられると走査の区切りを偽造できる。
# 正当なコマンドは使わない（過検知は fail-closed 方向で安全）。git の判定は全セッションで先に済んでいる。
cmd_clean=$(printf '%s' "$cmd" | LC_ALL=C tr -d '\001-\010\013\014\016-\037\177') || finish deny internal-error
[ "$cmd_clean" = "$cmd" ] || finish deny obfuscated

# デコード用プリミティブ（ANSI-C クォート・IFS 展開）は文字削除の正規化では意味が復元できない
# ため、構文の存在自体を raw のコマンドに対して deny する（merge-guard-hook.sh と同じ判定）。
if printf '%s' "$cmd" | grep -qE "[$]'"; then
  finish deny obfuscated
fi
if printf '%s' "$cmd" | grep -qE '[$]\{?IFS'; then
  finish deny obfuscated
fi

# 正規化 第1段: 行継続・改行・${IFS}・クォート・バックスラッシュを除去して文字レベルの
# 難読化（g''h・g\h・gh${IFS}pr）を潰す。トークン境界は変えない（merge-guard-hook.sh の norm_of と同じ）。
norm_of() {
  # パイプの途中（awk 等）の失敗を呼び出し側へ伝える（$(...) 内で呼ぶので他の判定へは波及しない。
  # グローバルの pipefail は grep -q の SIGPIPE で fail-open になるため使わない）
  set -o pipefail
  printf '%s\n' "$1" \
    | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
    | tr '\n' ' ' \
    | sed -e 's/[$]{IFS}/ /g' -e 's/[$]IFS/ /g' \
    | tr -d "'\"" \
    | tr -d "\\\\" \
    | tr -s '[:space:]' ' '
}
norm=$(norm_of "$cmd") || finish deny internal-error

# トークン全体が「非空白プレフィックス + /gh」のときだけ "gh" に置換する basename 正規化。
# 部分削除はしない（同一トークン内の deny 証拠を消さないため。merge-guard-hook.sh の normalize_gh_tokens と同じ）。
normalize_gh_tokens() {
  local s="$1" tok out=""
  for tok in $s; do
    # 大文字小文字を区別しない（macOS の FS 対策。`GH pr merge` も gh として動く）
    case "$tok" in
      */[Gg][Hh]|[Gg][Hh]) tok="gh" ;;
    esac
    out="$out $tok"
  done
  printf '%s' "$out"
}

# 正規化 第2段: シェルメタ文字を空白にしてトークン境界を確定 → basename 正規化。
# 順序が本質（メタ文字が先。merge-guard-hook.sh の tokenize_of と同じ）。
tokenize_of() {
  local t
  t=$(set -o pipefail; printf '%s' "$1" \
    | sed -e 's/[;&|<>(){}`$]/ /g' \
    | tr -s '[:space:]' ' ') || return 1
  normalize_gh_tokens "$t"
}
tokenized=$(tokenize_of "$norm") || finish deny internal-error

# 暗黙 POST の判定だけに使う走査対象。`gh api ... | grep -F key=value` の grep -F を gh api の
# フィールド指定と誤認しないよう、先頭が既知の読み取りフィルタで gh を含まないセグメントを
# 除く。区切りが隠れる状況（$( ` <( >( <<・引用符の閉じ忘れ・awk 異常）は全体を走査して
# fail-closed に倒す。マージ系・REST / GraphQL 証拠・明示の書き込み判定は常に全体で行う
# （merge-guard-hook.sh の segment_scan_text と同じ・Issue #537）。
segment_scan_text() {
  printf '%s\n' "$1" | awk '
    BEGIN {
      n = split("grep egrep fgrep jq head tail sort uniq wc cut tr column cat", a, " ")
      for (k = 1; k <= n; k++) ok[a[k]] = 1
      out = ""; seg = ""
    }
    { if (sub(/\\$/, "")) text = text $0; else text = text $0 "\n" }
    function flush(   tmp, w, c, m, j, hasgh) {
      if (seg ~ /^[ \t\n]*$/) { seg = ""; return }
      tmp = seg; sub(/^[ \t]+/, "", tmp)
      split(tmp, w, /[ \t]+/)
      hasgh = 0
      if (w[1] in ok) {
        c = seg
        gsub("[;&|<>(){}`$\047\"\\\\]", " ", c)
        m = split(c, w, /[ \t]+/)
        for (j = 1; j <= m; j++) if (tolower(w[j]) == "gh" || tolower(w[j]) ~ /\/gh$/) hasgh = 1
        if (!hasgh) { seg = ""; return }
      }
      out = out " ; " seg
      seg = ""
    }
    END {
      len = length(text); st = 0
      for (i = 1; i <= len; i++) {
        ch = substr(text, i, 1)
        if (st == 1) { seg = seg ch; if (ch == "\047") st = 0; continue }
        if (st == 2) {
          seg = seg ch
          if (ch == "\\") { i++; seg = seg substr(text, i, 1) }
          else if (ch == "\"") st = 0
          continue
        }
        if (ch == "\\") { seg = seg ch; i++; seg = seg substr(text, i, 1); continue }
        if (ch == "\047") { st = 1; seg = seg ch; continue }
        if (ch == "\"") { st = 2; seg = seg ch; continue }
        if (ch == "|" && substr(text, i - 1, 1) == ">") { seg = seg ch; continue }
        if (ch == "&") {
          if (substr(text, i - 1, 1) == ">" || substr(text, i - 1, 1) == "<" || substr(text, i + 1, 1) == ">") { seg = seg ch; continue }
        }
        if (ch == ";" || ch == "|" || ch == "&" || ch == "\n") { flush(); continue }
        seg = seg ch
      }
      if (st != 0) exit 3
      flush()
      printf "%s", out
    }'
}

scan_src="$cmd"
case "$cmd" in
  *'$('*|*'`'*|*'<('*|*'>('*|*'<<'*) scan_src="$cmd" ;;
  *)
    if seg_out=$(segment_scan_text "$cmd"); then
      scan_src="$seg_out"
    fi
    ;;
esac
scan_norm=$(norm_of "$scan_src") || finish deny internal-error
scan_tok=$(tokenize_of "$scan_norm") || finish deny internal-error

# 暗黙 POST 用の証拠照合（走査対象のみ）。
scan_evidence() {
  printf '%s' "$scan_norm" | grep -qE "$1" && return 0
  printf '%s' "$scan_tok" | grep -qE "$1"
}

# deny 証拠の部分文字列照合。メタ文字を保持した norm と、分割済みの tokenized の両方を見て
# どちらかで成立すれば真（片方の正規化で証拠が変形しても他方で拾う over-deny 合成）。
evidence() {
  printf '%s' "$norm" | grep -qE "$1" && return 0
  printf '%s' "$tokenized" | grep -qE "$1"
}

# コマンド全体を引用符を考慮してトークンに分け、1 行 1 トークンで出す。引用符の外の ; | &
# 改行はトークンの代わりに区切り行（SEP_MARK）を出す（>& &> >| のリダイレクトは区切りにしない）。
# 引用符の中の空白は \002 に置き換えて 1 トークンに保つ（呼び出し側が必要なら空白へ戻す）。
# $1 が keep のとき ( ) { } ` $ < > をトークン文字として残し、それ以外は空白と同じ扱いにする。
SEP_MARK=$'\001SEP'
shell_tokens() {
  printf '%s\n' "$cmd" | awk -v keep="$1" '
    function flush() { if (have) print cur; cur = ""; have = 0 }
    { text = text $0 "\n" }
    END {
      len = length(text); q = 0; cur = ""; have = 0
      for (i = 1; i <= len; i++) {
        ch = substr(text, i, 1)
        if (q == 1) { if (ch == "\047") q = 0; else cur = cur ((ch ~ /[ \t\n]/) ? "\002" : ch); continue }
        if (q == 2) {
          if (ch == "\"") q = 0
          else if (ch == "\\") { i++; cur = cur substr(text, i, 1) }
          else cur = cur ((ch ~ /[ \t\n]/) ? "\002" : ch)
          continue
        }
        if (ch == "\\") { i++; nx = substr(text, i, 1); if (nx != "\n") { cur = cur nx; have = 1 }; continue }
        if (ch == "\047") { q = 1; have = 1; continue }
        if (ch == "\"") { q = 2; have = 1; continue }
        if (ch == " " || ch == "\t" || ch == "\r") { flush(); continue }
        if (ch == "\n" || ch == ";" || ch == "|" || ch == "&") {
          pv = substr(text, i - 1, 1); nt = substr(text, i + 1, 1)
          flush()
          if ((ch == "&" && (pv == ">" || pv == "<" || nt == ">")) || (ch == "|" && pv == ">")) continue
          print "\001SEP"; continue
        }
        if (keep != "keep" && index("(){}`$<>", ch) > 0) { flush(); continue }
        cur = cur ch; have = 1
      }
      flush()
      # 引用符が閉じないまま終わった（コメント中のアポストロフィ等）。以降のトークンは信用できない
      if (q != 0) exit 3
    }'
}

# `-` で始まるトークン（フラグ）を除いたトークン列。値トークンは孤立して残るが、後段が
# 語順の部分列一致なので over-deny 側にしか働かない（merge-guard-hook.sh の strip_flags と同じ）。
strip_flags() {
  local s="$1" tok out=""
  for tok in $s; do
    case "$tok" in
      -*) : ;;
      *) out="$out $tok" ;;
    esac
  done
  printf '%s' "$out"
}

# $1 のトークン列に $2 以降の語がこの順序で（連続でなくてよい）現れるか。
# `gh -R o/r pr merge` のようなグローバルオプションの挟み込みで迂回されないための判定。
contains_subsequence() {
  local tokens="$1"; shift
  local -a want=("$@")
  local idx=0 tok
  for tok in $tokens; do
    if [ "$tok" = "${want[$idx]}" ]; then
      idx=$((idx + 1))
      [ "$idx" -eq "${#want[@]}" ] && return 0
    fi
  done
  return 1
}

all_nf=$(strip_flags "$tokenized")

# gh pr merge（あらゆる形）
if contains_subsequence "$all_nf" gh pr merge; then
  finish deny merge-guard
fi

# gh api 経由のマージ・設定変更（merge-guard-hook.sh の gh api 判定と同じ）
if contains_subsequence "$all_nf" gh api; then
  # REST merge（pulls/<n>/merge）・REST ブランチマージ（repos/<o>/<r>/merges）・
  # GraphQL の merge 系 mutation（mergeBranch は PR を経由せず直接マージできる迂回経路）
  # パスの途中にコマンド置換（`pulls/$(gh pr view ... -q .number)/merge`）があると空白で語が割れるため、
  # 空白を許す緩い形で照合する（過検知は fail-closed 方向で安全）。
  if evidence 'pulls/.*/merge'; then
    finish deny merge-guard
  fi
  if evidence '/merges([[:space:]?]|$)'; then
    finish deny merge-guard
  fi
  if evidence 'mergePullRequest|enablePullRequestAutoMerge|mergeBranch'; then
    finish deny merge-guard
  fi

  # API 経由の承認（外部レビューゲートの自作自演）。REST は pulls/<n>/reviews（作成）と
  # pulls/<n>/reviews/<id>/events（送信）で、event フィールドが COMMENT / REQUEST_CHANGES の
  # リテラル以外（APPROVE・@file・変数・判定できない値）なら deny する。--input は本文を
  # ファイル / stdin から渡すため中身が見えず deny する。event を持たない書き込み（保留レビュー
  # の作成）と、event を持たない読み取りは許可。
  # パスの照合は、途中にコマンド置換（`pulls/$(gh pr view ... -q .number)/reviews`）があって空白で
  # 語が割れる形と、末尾スラッシュ（`reviews/`）も拾うよう緩くする。
  # 明示の GET でも event は検査する（GET の免除は、コマンド全体の `-X GET` の字面が別の gh api
  # 呼び出しやコメント（`... -f event=APPROVE # -X GET`）にあるだけで成立してしまうため置かない。
  # `GET ... -f event=APPROVE` を deny するのは意図した過検知）。
  if evidence 'pulls/.*/reviews([?/[:space:]]|$)'; then
    if printf '%s' "$tokenized" | grep -qE '(^|[[:space:]])--input([[:space:]]|=|$)'; then
      finish deny merge-guard
    fi
    # event の検査はフィールド指定の引数に限る。--jq / -q / --template / -t の値（フィルタ式）は除く。
    # 引用符を追う分割が信用できない（閉じ忘れ・awk 失敗）ときは、引用符を除いた norm を空白で割る。
    rt_keep=$(shell_tokens keep) || rt_keep=$(printf '%s' "$norm" | tr ' ' '\n')
    rest_text=""; rest_drop=0
    while IFS= read -r rest_tok; do
      if [ "$rest_drop" -eq 1 ]; then rest_drop=0; continue; fi
      case "$rest_tok" in
        --jq|--template) rest_drop=1; continue ;;
        --jq=*|--template=*) continue ;;
        -[qt]|-[A-Za-z]*[qt]) rest_drop=1; continue ;;
        -[qt]?*) continue ;;
      esac
      rest_text="$rest_text ${rest_tok//$'\002'/ }"
    done <<EOF_RT
$rt_keep
EOF_RT
    rc=0
    ev_vals=$(printf '%s' "$rest_text" | grep -oiE 'event[[:space:]]*=[[:space:]]*[^[:space:]]*') || rc=$?
    [ "$rc" -le 1 ] || finish deny internal-error
    while IFS= read -r ev_line; do
      [ -n "$ev_line" ] || continue
      ev_v=${ev_line#*=}
      ev_v=$(printf '%s' "$ev_v" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')
      case "$ev_v" in
        COMMENT|REQUEST_CHANGES) : ;;
        *) finish deny merge-guard ;;
      esac
    done <<EOF_EV
$ev_vals
EOF_EV
  fi
  # GraphQL: レビュー作成・送信の mutation（addPullRequestReviewThreadReply 等の別名は対象外）。
  # `gh api graphql` の語の位置に依らず（`/graphql`・URL 形も）mutation 名で判定する。mutation がある
  # 場合は event が COMMENT / REQUEST_CHANGES のリテラルで、$var・@file・$(...) を含まない形だけを許可
  # する（event を持たない・変数経由・引用符内の値は判定できないので deny。APPROVE の語も deny）。
  if evidence '(addPullRequestReview|submitPullRequestReview)([^A-Za-z0-9_]|$)'; then
    rc=0
    gq_vals=$(printf '%s' "$norm" | grep -oE 'event[[:space:]]*:[[:space:]]*[^[:space:],})]*') || rc=$?
    [ "$rc" -le 1 ] || finish deny internal-error
    gq_n=0
    while IFS= read -r gq_line; do
      [ -n "$gq_line" ] || continue
      gq_v=${gq_line#*:}
      gq_v=$(printf '%s' "$gq_v" | tr -d '[:space:]')
      case "$gq_v" in
        COMMENT|REQUEST_CHANGES) gq_n=$((gq_n + 1)) ;;
        *) finish deny merge-guard ;;
      esac
    done <<EOF_GQ
$gq_vals
EOF_GQ
    [ "$gq_n" -ge 1 ] || finish deny merge-guard
    if evidence '(^|[^A-Za-z0-9_])APPROVE([^A-Za-z0-9_]|$)' \
      || printf '%s' "$norm" | grep -qE '=[[:space:]]*@'; then
      finish deny merge-guard
    fi
  fi
  # GraphQL の query を @file / 変数 / コマンド置換（先頭が @ か $）や --input で渡す形は中身を見られない。
  if evidence '(^|[^A-Za-z0-9_])graphql([^A-Za-z0-9_]|$)'; then
    if evidence '(^|[[:space:]])(-[A-Za-z]*[fF]|--(raw-)?field)[[:space:]=]*query[[:space:]]*=[[:space:]]*[@$]' \
      || printf '%s' "$tokenized" | grep -qE '(^|[[:space:]])--input([[:space:]]|=|$)'; then
      finish deny merge-guard
    fi
  fi

  # ruleset・branch protection・リポジトリ本体への書き込み。明示のメソッド、または gh api が
  # 暗黙に POST へ切り替えるフィールド指定（-f/-F は key=value 形に限り grep -F・jq -f を
  # 誤検知しない）。明示の GET は免除。リポジトリ本体は GET が常用されるため明示の書き込みのみ。
  m_write='([Pp][Uu][Tt]|[Pp][Aa][Tt][Cc][Hh]|[Pp][Oo][Ss][Tt]|[Dd][Ee][Ll][Ee][Tt][Ee])'
  explicit_write=0
  implicit_write=0
  if evidence "(^|[[:space:]])(-[A-Za-z]*X|--method)(=|[[:space:]]*)${m_write}([^A-Za-z]|\$)"; then
    explicit_write=1
  elif scan_evidence '(^|[[:space:]])(-[A-Za-z]*[fF](=|[[:space:]]*)[^[:space:]=-][^[:space:]=]*=|--(raw-)?field([[:space:]]|=)|--input([[:space:]]|=|$))' \
    && ! printf '%s' "$norm" | grep -qE '(^|[[:space:]])(-[A-Za-z]*X|--method)(=|[[:space:]]*)[Gg][Ee][Tt]([^A-Za-z]|$)'; then
    implicit_write=1
  fi
  if [ "$explicit_write" -eq 1 ] || [ "$implicit_write" -eq 1 ]; then
    if evidence '(repos|orgs)/[^[:space:]]*/rulesets([^A-Za-z0-9_-]|$)|branches/[^[:space:]]+/protection'; then
      finish deny repo-settings
    fi
  fi
  if [ "$explicit_write" -eq 1 ] \
    && evidence '(^|[[:space:]/])repos/[^/[:space:]]+/[^/[:space:]]+/?([^A-Za-z0-9_./-]|$)'; then
    finish deny repo-settings
  fi
  if evidence '(create|update|delete)(BranchProtectionRule|RepositoryRuleset)|updateRepository|deleteRepository|(un)?archiveRepository'; then
    finish deny repo-settings
  fi
fi

# リポジトリ設定を変える gh repo サブコマンド（view 等の読み取りは対象外）
for sub in edit rename archive unarchive delete; do
  if contains_subsequence "$all_nf" gh repo "$sub"; then
    finish deny repo-settings
  fi
done

# レビュー承認（外部レビューゲートの自作自演を防ぐ）。--approve はフラグでフラグ除去後に
# 残らないため、フラグ除去前の tokenized に対して判定する。
if contains_subsequence "$all_nf" gh pr review \
  && printf '%s' "$tokenized" | grep -qE '(^|[[:space:]])--approve([[:space:]]|$|=)'; then
  finish deny merge-guard
fi

# 短縮 -a（--approve の略）。束ね書き（-ab 等）は pflag と同じく先頭から読み、値を取る
# -b / -F が来たらそれ以降は値（-ba の a は本文）。値を取るオプションの次トークンも値として読み飛ばす。
# gh pr review の後ろだけを見る。
# 走査は 2 モード:
#   normal: 引用符を追うトークン化（shell_tokens strip）。引用符の外の ; | & 改行で状態を戻し、
#           `gh pr review 5 -c -b ok; cp -a x y` の -a（別コマンドの引数）を承認と誤認しない。
#   flat:   トークン化済みの全体（tokenized）を区切りなしで走査する（over-deny 側）。引用符の中の
#           コマンド（`bash -c 'gh pr review 5 -a'`・eval）、$( ` <( >( << で区切りが隠れる形、
#           引用符を追えない形で使う。git の判定のような再帰的な再解析はせず、この flat が bash -c / eval の
#           中の gh を担う（引用符を除いた全体を見るので二重の解析にならない）。
# gh / git の語では状態を戻さない（`gh pr review 5 -b "see $(git rev-parse HEAD)" -a`・
# `gh pr review fix/git -a` のように引数に現れても -a を見失わないため。次のコマンドの境界は normal の区切りだけが担う）。
# 戻り値: 0 = 承認あり / 1 = なし / 2 = 引用符を追えず信用できない（normal のみ）。REV_N に review への突入回数を残す。
REV_N=0
review_scan() {
  local mode="$1" tok st=0 skip=0 body m ch rt
  REV_N=0
  if [ "$mode" = normal ]; then
    rt=$(shell_tokens strip) || return 2
  else
    rt=$(printf '%s' "$tokenized" | tr ' ' '\n') || return 2
  fi
  while IFS= read -r tok; do
    if [ "$mode" = normal ] && [ "$tok" = "$SEP_MARK" ]; then st=0; skip=0; continue; fi
    if [ "$st" -lt 3 ]; then
      # コマンド名はフルパス・相対パス・大文字小文字違いでも gh として比較する（normalize_gh_tokens と同じ基準）。
      case "$tok" in
        */[Gg][Hh]|[Gg][Hh]) tok=gh ;;
      esac
      case "$tok" in
        -*) continue ;;
      esac
      case "$st:$tok" in
        0:gh) st=1 ;;
        1:pr) st=2 ;;
        2:review) st=3; REV_N=$((REV_N + 1)) ;;
      esac
      continue
    fi
    # 値トークン（-b gh の gh 等）を先に消化する。
    if [ "$skip" -eq 1 ]; then skip=0; continue; fi
    case "$tok" in
      --body|--body-file) skip=1 ;;
      --*) : ;;
      -?*)
        body=${tok#-}
        m=0
        while [ "$m" -lt "${#body}" ]; do
          ch=${body:$m:1}
          case "$ch" in
            a) return 0 ;;
            b|F) [ "$m" -eq $((${#body} - 1)) ] && skip=1; break ;;
          esac
          m=$((m + 1))
        done
        ;;
    esac
  done <<EOF_RV
$rt
EOF_RV
  return 1
}

# gh → pr → review の語順が（フラグ除去後に）何回現れるか。
count_gh_pr_review() {
  local tok idx=0 n=0
  for tok in $1; do
    case "$idx:$tok" in
      0:gh) idx=1 ;;
      1:pr) idx=2 ;;
      2:review) n=$((n + 1)); idx=0 ;;
    esac
  done
  printf '%s' "$n"
}

review_short_approve() {
  local rc=0 n_flat
  case "$cmd" in
    *'$('*|*'`'*|*'<('*|*'>('*|*'<<'*)
      review_scan flat && return 0
      return 1
      ;;
  esac
  review_scan normal || rc=$?
  [ "$rc" -eq 0 ] && return 0
  if [ "$rc" -eq 1 ]; then
    # 引用符の中のコマンド（bash -c '...'・eval '...'）は normal では 1 トークンになり review 状態に入らない。
    # 全体に gh pr review が normal の見た回数より多く現れるときは、flat で見直す。
    n_flat=$(count_gh_pr_review "$all_nf")
    [ "$n_flat" -gt "$REV_N" ] || return 1
  fi
  review_scan flat && return 0
  return 1
}
if review_short_approve; then
  finish deny merge-guard
fi

# 別名・拡張経由の迂回封じ
if contains_subsequence "$all_nf" gh alias; then
  finish deny merge-guard
fi
if contains_subsequence "$all_nf" gh extension \
  || contains_subsequence "$all_nf" gh extensions; then
  finish deny merge-guard
fi

finish allow

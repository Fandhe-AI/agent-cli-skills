#!/usr/bin/env bash
# agent-guard.sh: Codex（PreToolUse hook）と OpenCode（server plugin）が共通に呼ぶ、
# シェルコマンド文字列の禁止判定ガード。各ツール用のアダプタ（codex-pretooluse.sh・
# plugin の index.js）が自ツールの入力を下記の契約へ変換して呼び、結果行だけを読む。
# 4 スキル（init-codex / init-opencode / update-codex / update-opencode）で同一内容を保つ
# 配布物であり、このファイル単体で完結する（他ファイルを source しない）。
#
# 位置づけ: best-effort の攻撃面削減であり、承認境界ではない。文字列照合では eval・base64 復元・
# 変数間接呼び出し・ダブルクォート内のコマンド置換・ブレース／glob 展開による難読化を防げない。
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
#   obfuscated     ANSI-C クォート $'...' や $IFS 展開を含むコマンド（subagent が true / null のとき）
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
# リダイレクト（< > >> &> >& >|）と here-string（<<<）は語の区切りで、その後ろに置いた引数も
# 検査する。算術式（((...)) / $((...)) / $[...]）内の << は heredoc とみなさない（コマンド置換・
# 引用符を含む式や閉じのない式は算術式とみなさず通常どおり検査する）。
# 残存ギャップ（未対応。best-effort の限界であり、実強制は ruleset が担う）:
#   - ダブルクォート内の $(...) は 1 トークンとして扱い中身を検査しない（`git commit -m
#     "$(cat <<'EOF' ...)"` の本文を誤検知しないための意図的な選択）。そのため $(...) 内の
#     コマンド・引用符の食い違い（本文に奇数個の " を含むと以降が裸の語として検査され誤 deny、
#     逆に中身の実コマンドは見逃す）は扱えない
#   - bash -c / sh -c / eval / ヒアドキュメントや here-string を shell へ渡す形の中身
#   - main セッションでの難読化（変数間接・base64 復元・ブレース / glob 展開。obfuscated の
#     判定は subagent が true / null のときだけ）
#   - alias は -c と git config での定義だけを止める。利用者の設定ファイルに既にある alias、
#     include.path 経由の設定取り込み、GIT_CONFIG_* 環境変数、SKIP= 等の他のフック回避
#   - HUSKY=0 は同じコマンド文字列内の代入だけを見る（別の呼び出しで export 済みのものは見えない）
read -r -d '' GIT_AWK <<'AWK' || true
function isws(c) { return (c == " " || c == "\t" || c == "\r") }
function emit_tok() { if (have) { ntok++; tok[ntok] = cur }; cur = ""; have = 0 }
function setv(v) { if (verdict == "") verdict = v }
function end_seg() { emit_tok(); if (ntok > 0) analyze(); ntok = 0 }
function analyze(   i, t, lt, p, seg_h, sawenv, hk) {
  # 先頭の代入（FOO=1 HUSKY=0 git ...）・env・export を読み飛ばし、フック回避の代入を拾う。
  p = 1; seg_h = 0; sawenv = 0
  while (p <= ntok) {
    t = tok[p]
    if (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { if (t == "HUSKY=0" || t == "HUSKY_SKIP_HOOKS=1") seg_h = 1; p++ }
    else if (t == "env" || t == "export") { sawenv = 1; p++ }
    else if (sawenv && substr(t, 1, 1) == "-") p++
    else break
  }
  hk = husky_persist
  if (p > ntok) { if (seg_h) husky_persist = 1 } else if (seg_h) hk = 1
  for (i = 1; i <= ntok; i++) {
    t = tok[i]; lt = tolower(t)
    if (lt == "git" || lt ~ /\/git$/) git_args(i + 1, hk)
  }
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
      else if (length(a) >= 5 && length(a) <= 8 && index("--mirror", a) == 1) setv("force-push")
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
# 算術式 ((...)) / $((...)) の終端（`))` の次の位置）。コマンド置換・引用符・バッククォートを含む、
# または閉じが見つからないものは算術式とみなさず 0 を返し、通常のトークン化に任せる。
function arith_end(k,   d, c) {
  d = 0
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "(") d++
    else if (c == ")") { if (d == 0) return (substr(text, k + 1, 1) == ")") ? k + 2 : 0; d-- }
    else if (c == "`" || c == "\"" || c == "\047") return 0
    else if (c == "$" && substr(text, k + 1, 1) == "(") return 0
    k++
  }
  return 0
}
# 旧式の算術展開 $[...] の終端（`]` の次の位置）。同じく危うい内容は 0。
function br_end(k,   c) {
  while (k <= len) {
    c = substr(text, k, 1)
    if (c == "]") return k + 1
    if (c == "`" || c == "\"" || c == "\047" || c == "\n" || (c == "$" && substr(text, k + 1, 1) == "(")) return 0
    k++
  }
  return 0
}
{ text = text $0 "\n" }
END {
  len = length(text); i = 1; cur = ""; have = 0; ntok = 0; hdn = 0; verdict = ""; husky_persist = 0
  while (i <= len) {
    ch = substr(text, i, 1)
    if (ch == "\\") {
      nx = substr(text, i + 1, 1)
      if (nx != "\n") { cur = cur nx; have = 1 }
      i += 2; continue
    }
    if (ch == "\047") {
      have = 1; i++
      while (i <= len && (c2 = substr(text, i, 1)) != "\047") { cur = cur ((c2 == "\n") ? " " : c2); i++ }
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
        cur = cur ((c2 == "\n") ? " " : c2); i++
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
        while (i <= len) {
          rest = substr(text, i)
          p = index(rest, "\n")
          if (p == 0) { line = rest; i = len + 1 } else { line = substr(rest, 1, p - 1); i += p }
          if (hdd[h]) sub(/^\t+/, "", line)
          if (line == hdw[h]) break
        }
      }
      hdn = 0; continue
    }
    if (ch == "<" && substr(text, i, 3) == "<<<") { emit_tok(); i += 3; continue }
    if (ch == "$" && substr(text, i + 1, 1) == "[") { r = br_end(i + 2); if (r > 0) { cur = cur substr(text, i, r - i); have = 1; i = r; continue } }
    if (ch == "(" && substr(text, i + 1, 1) == "(") { r = arith_end(i + 2); if (r > 0) { cur = cur substr(text, i, r - i); have = 1; i = r; continue } }
    if (ch == "&" && (substr(text, i - 1, 1) == ">" || substr(text, i - 1, 1) == "<" || substr(text, i + 1, 1) == ">")) { emit_tok(); i++; continue }
    if (ch == "|" && substr(text, i - 1, 1) == ">") { emit_tok(); i++; continue }
    if (ch == ";" || ch == "|" || ch == "&" || ch == "(" || ch == ")" || ch == "`") { end_seg(); i++; continue }
    if (ch == "<" && substr(text, i, 2) == "<<" && substr(text, i, 3) != "<<<") {
      i += 2; dash = 0
      if (substr(text, i, 1) == "-") { dash = 1; i++ }
      while (i <= len && isws(substr(text, i, 1))) i++
      w = ""
      while (i <= len) {
        c2 = substr(text, i, 1)
        if (c2 == "\047" || c2 == "\"") {
          q = c2; i++
          while (i <= len && substr(text, i, 1) != q) { w = w substr(text, i, 1); i++ }
          i++
        } else if (c2 == "\\") { w = w substr(text, i + 1, 1); i += 2 }
        else if (isws(c2) || c2 == "\n" || index(";&|<>()", c2) > 0) break
        else { w = w c2; i++ }
      }
      hdn++; hdw[hdn] = w; hdd[hdn] = dash
      continue
    }
    if (ch == "<" || ch == ">") { emit_tok(); i++; continue }
    cur = cur ch; have = 1; i++
  }
  end_seg()
  printf "%s\n", (verdict == "") ? "ok" : verdict
}
AWK

git_verdict=$(printf '%s\n' "$cmd" | awk "$GIT_AWK") || finish deny internal-error
case "$git_verdict" in
  ok) : ;;
  no-verify) finish deny no-verify ;;
  force-push) finish deny force-push ;;
  *) finish deny internal-error ;;
esac

# subagent が false（main セッション）はここまで。マージ系の制限は対象外。
[ "$subagent" = false ] && finish allow

# --- subagent（true）と判別不能（null）: merge-guard-hook.sh の deny 対象 ---------------
# 以下は implement-issue-tree/scripts/merge-guard-hook.sh の判定を移植したもの。元ファイルは
# 変更していない。違いは入出力（hook JSON ではなく上記契約）と deny の出し方（理由コード）だけ。

# デコード用プリミティブ（ANSI-C クォート・IFS 展開）は文字削除の正規化では意味が復元できない
# ため、構文の存在自体を raw のコマンドに対して deny する（移植元 L194-199）。
if printf '%s' "$cmd" | grep -qE "[$]'"; then
  finish deny obfuscated
fi
if printf '%s' "$cmd" | grep -qE '[$]\{?IFS'; then
  finish deny obfuscated
fi

# 正規化 第1段: 行継続・改行・${IFS}・クォート・バックスラッシュを除去して文字レベルの
# 難読化（g''h・g\h・gh${IFS}pr）を潰す。トークン境界は変えない（移植元 L218-227）。
norm_of() {
  printf '%s\n' "$1" \
    | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
    | tr '\n' ' ' \
    | sed -e 's/[$]{IFS}/ /g' -e 's/[$]IFS/ /g' \
    | tr -d "'\"" \
    | tr -d "\\\\" \
    | tr -s '[:space:]' ' '
}
norm=$(norm_of "$cmd")

# トークン全体が「非空白プレフィックス + /gh」のときだけ "gh" に置換する basename 正規化。
# 部分削除はしない（同一トークン内の deny 証拠を消さないため。移植元 L234-243）。
normalize_gh_tokens() {
  local s="$1" tok out=""
  for tok in $s; do
    case "$tok" in
      */gh) tok="gh" ;;
    esac
    out="$out $tok"
  done
  printf '%s' "$out"
}

# 正規化 第2段: シェルメタ文字を空白にしてトークン境界を確定 → basename 正規化。
# 順序が本質（メタ文字が先。移植元 L253-259）。
tokenize_of() {
  local t
  t=$(printf '%s' "$1" \
    | sed -e 's/[;&|<>(){}`$]/ /g' \
    | tr -s '[:space:]' ' ')
  normalize_gh_tokens "$t"
}
tokenized=$(tokenize_of "$norm")

# 暗黙 POST の判定だけに使う走査対象。`gh api ... | grep -F key=value` の grep -F を gh api の
# フィールド指定と誤認しないよう、先頭が既知の読み取りフィルタで gh を含まないセグメントを
# 除く。区切りが隠れる状況（$( ` <( >( <<・引用符の閉じ忘れ・awk 異常）は全体を走査して
# fail-closed に倒す。マージ系・REST / GraphQL 証拠・明示の書き込み判定は常に全体で行う
# （移植元 L281-341・Issue #537）。
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
        for (j = 1; j <= m; j++) if (w[j] == "gh" || w[j] ~ /\/gh$/) hasgh = 1
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
scan_norm=$(norm_of "$scan_src")
scan_tok=$(tokenize_of "$scan_norm")

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

# `-` で始まるトークン（フラグ）を除いたトークン列。値トークンは孤立して残るが、後段が
# 語順の部分列一致なので over-deny 側にしか働かない（移植元 L361-370）。
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

# gh api 経由のマージ・設定変更（移植元 L397-449）
if contains_subsequence "$all_nf" gh api; then
  # REST merge（pulls/<n>/merge）・REST ブランチマージ（repos/<o>/<r>/merges）・
  # GraphQL の merge 系 mutation（mergeBranch は PR を経由せず直接マージできる迂回経路）
  if evidence 'pulls/[^[:space:]]*/merge'; then
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
  # の作成）と GET の読み取りは許可。
  if evidence 'pulls/[^/[:space:]]+/reviews(/[^/[:space:]]+/events)?([?[:space:]]|$)'; then
    if printf '%s' "$tokenized" | grep -qE '(^|[[:space:]])--input([[:space:]]|=|$)'; then
      finish deny merge-guard
    fi
    ev_vals=$(printf '%s' "$norm" | grep -oiE 'event[[:space:]]*=[[:space:]]*[^[:space:]]*') || ev_vals=""
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
  # GraphQL: レビュー作成・送信の mutation に APPROVE が含まれる（変数経由の -f e=APPROVE も同じ
  # コマンド文字列に現れる）。query を @file や --input で渡す形は中身を見られないので deny。
  if contains_subsequence "$all_nf" gh api graphql; then
    if evidence 'addPullRequestReview|submitPullRequestReview' && evidence 'APPROVE'; then
      finish deny merge-guard
    fi
    if evidence '(^|[[:space:]])(-[A-Za-z]*[fF]|--(raw-)?field)[[:space:]=]*query[[:space:]]*=[[:space:]]*@' \
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

# 短縮 -a（--approve の略）。束ね書き（-ab 等）は pflag と同じく先頭から読み、値を取る -b / -F が
# 来たらそれ以降は値（-ba の a は本文）。値を取るオプションの次トークンも値として読み飛ばす。
# gh pr review の後ろだけを見て、次の gh / git で打ち切る。
review_short_approve() {
  local tok st=0 skip=0 body m ch
  for tok in $tokenized; do
    if [ "$st" -lt 3 ]; then
      case "$tok" in
        -*) continue ;;
      esac
      case "$st:$tok" in
        0:gh) st=1 ;;
        1:pr) st=2 ;;
        2:review) st=3 ;;
      esac
      continue
    fi
    case "$tok" in
      gh|git) return 1 ;;
    esac
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
  done
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

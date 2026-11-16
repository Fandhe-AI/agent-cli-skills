#!/usr/bin/env bash
# codex-hook.sh: ランナーが起動する Codex の PreToolUse hook（matcher ^Bash$）。
# 配布済みの agent-guard.sh を「常に subagent=true」で呼び、結果を Codex の deny 出力へ写す。
# （トップレベルのセッションでも、マージ・承認・設定変更を止めるため。方針は phase0 の 0-3）
#
# 引数（codex.mjs が hook のコマンド行へ埋める。エージェントのシェルからは変えられない）:
#   --guard <path>     agent-guard.sh の絶対パス（必須）
#   --log <path>       呼び出しごとに 1 行を追記するログ（必須）。codex.mjs が「ログの行数 >= コマンド実行数」を
#                      終了時に確かめ、満たさなければガードの欠落（hook が黙って読まれなかった等）として扱う
#   --merge-re <ERE>   与えたときだけ、コマンド全体がこの正規表現に一致する場合に素通しにする
#                      （allowMerge。merge-exec の完全一致の 1 形。正本は runner/lib/guard.mjs の MERGE_EXEC_COMMAND）
#
# 入力（stdin）: Codex の PreToolUse JSON（使うのは tool_input.command だけ）。
# 出力: deny のときだけ stdout に deny JSON を出して exit 0。allow は何も出さず exit 0。
# ログと出力にコマンド文字列は含めない（秘密情報が流れないように）。
# fail-closed: 引数不備・jq 無し・ガード無し・結果行なしはすべて deny。呼び出し側のコマンド行は
# `bash <このファイル> … || exit 2` とし、このスクリプト自体が異常終了しても止める。
set -uf

GUARD='' LOG='' MERGE_RE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --guard) GUARD="${2:-}"; shift 2 || break ;;
    --log) LOG="${2:-}"; shift 2 || break ;;
    --merge-re) MERGE_RE="${2:-}"; shift 2 || break ;;
    *) shift ;;
  esac
done

log() { [ -n "$LOG" ] && printf '%s\t%s\n' "$(date +%s)" "$1" >> "$LOG"; return 0; }
emit_deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

if [ -z "$LOG" ] || [ -z "$GUARD" ]; then
  # ログが書けない構成では欠落検知が成立しないため、止める。
  [ -n "$LOG" ] && log deny-args
  emit_deny 'ランナーの hook 引数が不正なため拒否した'
fi
[ -f "$GUARD" ] || { log deny-guard-missing; emit_deny 'ガードが見つからないため拒否した'; }
command -v jq >/dev/null 2>&1 || { log deny-no-jq; emit_deny 'jq が見つからないため拒否した'; }

input=$(cat) || input=''
cmd=$(printf '%s' "$input" | jq -er '.tool_input.command | select(type == "string")' 2>/dev/null) || cmd=''
[ -n "$cmd" ] || { log deny-nocmd; emit_deny 'コマンドを解釈できないため拒否した'; }

if [ -n "$MERGE_RE" ] && [[ "$cmd" =~ $MERGE_RE ]]; then
  log allow-mergeform
  exit 0
fi

out=$(printf '%s' "$input" | jq -c '{command: .tool_input.command, subagent: true}' | bash "$GUARD" 2>/dev/null)
rc=$?
last=$(printf '%s\n' "$out" | awk 'NF{l=$0} END{print l}')
case "$last" in
  'AGENT_GUARD_RESULT allow')
    if [ "$rc" -eq 0 ]; then log allow; exit 0; fi
    log deny-error; emit_deny 'ガードが異常終了したため拒否した' ;;
  'AGENT_GUARD_RESULT deny '*)
    log "deny:${last#AGENT_GUARD_RESULT deny }"
    emit_deny "ガードの判定により拒否した（${last#AGENT_GUARD_RESULT deny }）" ;;
  *) log deny-noresult; emit_deny 'ガードの結果を得られないため拒否した' ;;
esac

#!/usr/bin/env bash
# codex-pretooluse.sh: Codex の PreToolUse hook（matcher ^Bash$）のアダプタ。
# Codex が stdin へ渡す hook 入力 JSON を agent-guard.sh の契約（{"command","subagent"}）へ
# 変換して呼び、結果行を Codex の deny 出力へ写す。判定そのものは agent-guard.sh が担う。
#
# 入力（stdin）: Codex の PreToolUse JSON。使うのは tool_input.command と agent_id だけ。
#   agent_id は subagent の中で動くツール呼び出しにだけ付く（実機 0.164.0 で確認）。
#   あれば subagent=true、無ければ false。JSON が読めない場合は command / subagent とも null
#   にして agent-guard.sh へ渡し、guard 側の bad-input deny に任せる。
# 出力: deny のときだけ stdout に hookSpecificOutput の deny JSON を出して exit 0。
#   allow は何も出さず exit 0。理由文は理由コードに対応する固定の日本語で、入力のコマンド文字列は
#   出力へ一切含めない。
# fail-closed: jq が無い・agent-guard.sh が無い・異常終了・結果行が無いときはすべて deny。
set -uf

emit_deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

reason_for() {
  case "$1" in
    no-verify) printf '%s' 'git の --no-verify / commit -n は禁止されている。フックを通して再実行すること' ;;
    force-push) printf '%s' '履歴を書き換える push（--force / --force-with-lease / +refspec）は禁止されている。必要なら人間に依頼すること' ;;
    merge-guard) printf '%s' 'サブエージェントによるマージ・承認は禁止されている。人間または親が実行すること' ;;
    repo-settings) printf '%s' 'サブエージェントによるリポジトリ設定・ruleset の変更は禁止されている' ;;
    obfuscated) printf '%s' '難読化されたコマンド（$'"'"'...'"'"' や $IFS 展開）は拒否される' ;;
    nesting-limit) printf '%s' 'コマンドの入れ子が深い、または $( の閉じを解析できないため拒否した' ;;
    bad-input) printf '%s' 'hook 入力を解釈できないため拒否した' ;;
    no-jq) printf '%s' 'jq が見つからないため拒否した（fail-closed）' ;;
    *) printf '%s' 'ガードの判定により拒否した' ;;
  esac
}

GUARD="$(dirname "$0")/agent-guard.sh"
[ -f "$GUARD" ] || emit_deny "$(reason_for guard-missing)"
command -v jq >/dev/null 2>&1 || emit_deny "$(reason_for no-jq)"

input=$(cat) || input=''
payload=$(printf '%s' "$input" | jq -c '{command: (.tool_input.command? // null), subagent: ((.agent_id? // null) != null and (.agent_id? // "") != "")}' 2>/dev/null) \
  || payload='{"command":null,"subagent":null}'
[ -n "$payload" ] || payload='{"command":null,"subagent":null}'

out=$(printf '%s' "$payload" | bash "$GUARD" 2>/dev/null)
rc=$?
last=$(printf '%s\n' "$out" | awk 'NF{l=$0} END{print l}')

case "$last" in
  'AGENT_GUARD_RESULT allow')
    [ "$rc" -eq 0 ] && exit 0
    emit_deny "$(reason_for guard-error)"
    ;;
  'AGENT_GUARD_RESULT deny '*)
    code=${last#AGENT_GUARD_RESULT deny }
    emit_deny "$(reason_for "$code")"
    ;;
  *) emit_deny "$(reason_for guard-error)" ;;
esac

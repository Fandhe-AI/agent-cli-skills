#!/usr/bin/env bash
# implement-issue-tree の merge-guard hook（PreToolUse / matcher: Bash）。
#
# 役割の境界（主張と保証を一致させる。security-auditor 3 回目監査・advisor 助言反映）:
# 本 hook が担うのは implement-issue-tree Workflow の「未承認マージ防止」の一層である。
# Workflow ランタイムは agent() 単位のツール allowlist・credential 分離を提供しないため、
# 未信頼の PR レビュー本文を読む monitor エージェントも merge-exec と同じ Bash・gh 認証を持つ。
# その前提で、本 hook の各経路が「実装として保証できる主張の強さ」は次のように異なる:
#
#   - allow 経路 = 証明可能な強制境界（本 hook が全 subagent Bash 呼び出しに発火し続ける
#     限りにおいて。強い主張をしてよい）:
#       subagent の gh pr merge は「host が grant 窓の間だけ発行した 1 バイト列
#       （expectedCommand）との完全一致」でのみ許可する。host が承認したその瞬間の正規
#       コマンドそのもの以外は（前後連結・フラグ追加・クォート/バックスラッシュ/IFS 難読化を
#       含め）一致せず deny される。これは文字列削除による正規化の網羅性に依存しないため、
#       「未承認の新規マージコマンドを許可しない」ことを構造的に保証できる。
#       前提: この保証は hook が settings に登録され全 Bash 呼び出しに発火していることに依存
#       する。canary はラン開始時 1 回のみ実効を検証するため、セッション途中で settings から
#       hook が外される・上書きされる変更は再検知しない（残存リスク。settings をラン中に
#       改変しない運用・PreToolUse hook 群の保護で担保する）。
#   - deny 経路 = best-effort（サンドボックスとは主張しない）:
#       allow で許可されなかったマージ系コマンド（gh pr merge / REST merges / GraphQL /
#       alias / extension / --approve）を、既知の直接実行難読化スペリング（行継続・改行・
#       クォート分割・単独バックスラッシュ・IFS 直書き、および ANSI-C クォート/IFS 展開の
#       存在検知）まで潰して deny する攻撃面削減の一層。間接実行（eval・base64 復元・変数
#       間接呼び出し・コマンド置換 $(...) 等）は文字列照合では原理的に防げない。完全な
#       サンドボックスではない。
#   - 実際の load-bearing な強制はサーバ側にある:
#       branch protection（第三者レビュー必須・required checks・直接 push 禁止。host 側
#       ランタイムで検証し未達なら自動マージ無効へ倒す。ensureBranchProtection 参照）+
#       完全一致 nonce grant + merge-verify の独立再検証。compromised なローカルエージェントは
#       サーバ側ルールを迂回できない（例: PR author と自動化 identity が同一なら
#       gh pr review --approve はサーバ側で拒否される。hook より強い論拠）。
# rust-ai-library PR #441 codex P0 対応。
#
# 呼び出し元の前提（契約）:
#   - .claude/settings.json の hooks.PreToolUse（matcher: "Bash"）に登録されて実行される。
#     stdin に hook JSON（agent_id / tool_input.command 等）を受け取る。
#   - agent_id は subagent 実行時のみ存在する。main スレッド（agent_id なし）は人間の監督下の
#     対話コンテキストであり、本 hook の制限対象外（何も出力せず許可）。
#   - 正規のマージ経路は「host（implement-issue-tree.js）が merge-exec 起動直前に発行する
#     grant ファイル（$CLAUDE_PROJECT_DIR/_/implement-issue-tree/merge-grants/grant-<pr>.json）
#     の expectedCommand と、実行コマンド（trim のみ・無正規化）の完全一致」でのみ許可する。
#     部分一致（nonce・PR 番号・--match-head-commit の個別照合）による許可は行わない。
#     これにより grant ファイルの内容を読まれても、実行できるのは host がその瞬間に承認した
#     正規コマンドそのもの（前後へのコマンド連結・フラグ追加は不一致で deny）だけになり、
#     nonce の秘匿には依存しない（nonce は多層防御の一層として残す）。
#   - deny 応答の permissionDecisionReason には必ずマーカー文字列
#     「implement-issue-tree-merge-guard」を含める。implement-issue-tree.js の canary プローブ
#     （merge-guard:probe エージェント）がこのマーカーの有無で hook の実効性を判定し、
#     未検出なら autoMerge: true でも自動マージを無効化する（fail-closed）。canary は hook の
#     「導入検証」であり、あらゆる難読化への耐性証明ではない点に注意。
#
# 判定ポリシー:
#   - allow 照合（正規化前の raw コマンド。前後 trim のみ）:
#       tool_input.command が grant の expectedCommand と完全一致 → 許可
#   - deny 照合（allow 不成立時。難読化対策の正規化後に評価）:
#       gh pr merge / REST merge（pulls/<n>/merge・repos/<o>/<r>/merges）/
#       GraphQL merge（mergePullRequest / enablePullRequestAutoMerge）/
#       gh pr review --approve / gh alias / gh extension → deny
#   - jq 不在・stdin パース失敗等の異常時 → deny（fail-closed）。ただし stdin に文字列
#     "agent_id" が現れない入力（main スレッド）は jq 不在でも許可する
#     （jq 不在環境で main スレッドをロックアウトしないための入口判定）
#   - 上記以外のコマンド → 許可（出力なし exit 0）

set -u

# deny 応答を出力して終了する。reason は本スクリプト内の固定文言のみを渡す契約
# （外部入力を埋め込むと JSON 破壊・reason 経由の注入面になるため禁止）。
deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"implement-issue-tree-merge-guard: %s"}}\n' "$1"
  exit 0
}

input=$(cat) || deny "stdin の読み取りに失敗したため deny（fail-closed）"

# main スレッドの入力（agent_id フィールドを含まない hook JSON）は jq の有無より前に許可する。
# jq 不在の環境で main スレッドの全 Bash コマンドをロックアウトしないための入口判定であり、
# 文字列 "agent_id" を含む入力はすべて後段の厳密判定（jq パース）へ回す（subagent の判定を
# この簡易照合で許可側へ倒すことはない）。
case "$input" in
  *'"agent_id"'*) : ;;
  *) exit 0 ;;
esac

# jq 不在は subagent 判定が不能のため fail-closed（許可へ倒すと hook が形骸化する）
command -v jq >/dev/null 2>&1 || deny "jq が見つからないため deny（fail-closed）。jq を導入すること"

# agent_id 判定より前のパース失敗も deny でよい（不正な hook 入力を許可へ倒さない）
agent_id=$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null) \
  || deny "hook 入力 JSON のパースに失敗したため deny（fail-closed）"

# main スレッド（agent_id 空値）は制限対象外。何も出力せず許可する
[ -z "$agent_id" ] && exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || deny "tool_input.command の取得に失敗したため deny（fail-closed）"

# command が空（Bash 以外のツール・空コマンド）は照合対象がないため許可
[ -z "$cmd" ] && exit 0

# --- deny 最前段: デコード用プリミティブの存在検知（raw コマンドに対して）----------------
# ANSI-C クォート（$'\x67\x68' 等）と IFS 由来展開（$IFS / ${IFS} / ${IFS%?} 等）は、
# 文字削除ベースの正規化では意味的にデコードできない（16/8/Unicode エスケープの復元・
# パラメータ展開の評価はシェルの実行時にしか起きない）。正当な gh コマンドはこれらを
# 使わない前提のため、構文の存在自体を raw 段階で検知して deny する（過検知は fail-closed
# 方向で安全）。これは既知の直接実行難読化を減らす best-effort であり、間接実行
# （eval・base64 復元・変数間接呼び出し・コマンド置換 $(...) 等）は文字列照合では原理的に
# 防げない。本 hook は完全なサンドボックスではない（実強制は branch protection + 完全一致
# nonce + merge-verify が担う。ファイル冒頭コメント・SKILL.md 参照）。
if printf '%s' "$cmd" | grep -qE "[$]'"; then
  deny "ANSI-C クォート構文（\$'...'）を含むコマンドは deny（デコードで難読化されたマージ経路を防ぐ best-effort。fail-closed）"
fi
if printf '%s' "$cmd" | grep -qE '[$]\{?IFS'; then
  deny "IFS 由来の展開（\$IFS / \${IFS} / \${IFS%?} 等）を含むコマンドは deny（トークン分割難読化を防ぐ best-effort。fail-closed）"
fi

# --- allow 照合: grant expectedCommand との完全一致（正規化前の raw で判定）------------
# host が生成する正規マージコマンドの形式。grant ファイルの改ざん・破損への fail-closed
# として、grant 側の expectedCommand 自体もこの形式に一致しなければ照合対象にしない。
# implement-issue-tree.js の buildMergeCommand / MERGE_GRANT_NONCE_RE と必ず一致させる。
ALLOW_RE='^IIT_MERGE_GRANT=[a-z0-9]{16,128} gh pr merge [0-9]+ --squash --delete-branch --match-head-commit [0-9a-f]{40}$'

# tool_input.command は tool 規約上末尾に改行が付き得るため、allow 判定に限り先に末尾の
# 空白・改行のみを剥がす（Low 対応。先頭・中間には触れず、クォート除去等の正規化も足さない
# ため、完全一致偽装の再発余地を作らない）。中間の改行はここでは残す。
# bash パラメータ展開で実装する（外部ツール非依存）。従来の
# `awk 'BEGIN{RS="\0"} ...'` は macOS awk 20200816 で RS=NUL が単一レコード化されず
# `printf 'a\n\nb\n'` が `ab` へ誤結合される（実測確認）。誤結合すると複数行コマンドの
# 中間行が allow 完全一致をすり抜ける恐れがあるため、RS 解釈の曖昧さを排して bash 展開に置換した。
# ${cmd##*[![:space:]]} = 末尾の空白類（改行含む）の連なり。それを ${cmd%...} で末尾から剥がす。
cmd_rstrip="${cmd%"${cmd##*[![:space:]]}"}"
# 完全一致照合は単一行コマンドのみを対象にする。複数行コマンドに grep -E の ^...$ を当てると
# 中間 1 行だけの一致で全体を許可してしまうため、末尾改行を剥がした後になお改行が残る
# （＝中間に改行がある）時点で allow 経路から外す。
nl_count=$(printf '%s' "$cmd_rstrip" | wc -l | tr -d ' ')
if [ "$nl_count" = "0" ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  # trim は前後の空白除去のみ。中身の正規化（クォート除去等）は行わない
  trimmed=$(printf '%s' "$cmd_rstrip" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if printf '%s' "$trimmed" | grep -qE "$ALLOW_RE"; then
    pr=$(printf '%s' "$trimmed" | grep -oE 'gh pr merge [0-9]+' | grep -oE '[0-9]+')
    grant_file="${CLAUDE_PROJECT_DIR}/_/implement-issue-tree/merge-grants/grant-${pr}.json"
    if [ -f "$grant_file" ]; then
      expected=$(jq -r '.expectedCommand // empty' "$grant_file" 2>/dev/null) || expected=""
      if [ -n "$expected" ] \
        && [ "$(printf '%s' "$expected" | wc -l | tr -d ' ')" = "0" ] \
        && printf '%s' "$expected" | grep -qE "$ALLOW_RE" \
        && [ "$trimmed" = "$expected" ]; then
        # host が承認した正規コマンドそのもの。許可（出力なし exit 0）
        exit 0
      fi
    fi
  fi
fi

# --- deny 照合: 難読化対策の正規化後にパターン評価 --------------------------------------
# allow が完全一致で成立しなかったコマンドのみここへ来る。deny 判定に限り、
#   (1) バックスラッシュ + 改行の行継続を除去
#   (2) 改行 → 空白
#   (3) ${IFS} / $IFS（波括弧あり/なし）を空白へ置換（gh${IFS}pr${IFS}merge のトークン分割難読化を潰す）
#   (4) シングル/ダブルクォート文字の除去（g''h → gh 等のクォート分割難読化を潰す）
#   (5) 残存する単独バックスラッシュを全除去（g\h pr merge / gh a\lias 等の直接実行形を潰す）
#   (6) 連続空白の圧縮
# の順で正規化してから照合する。正規化は deny 専用であり、allow 判定には決して使わない
# （正規化後の文字列で許可すると、正規化で潰れる差異を悪用した偽装 allow の余地が生まれる）。
# (5) のバックスラッシュ全除去は deny の一致範囲を広げる方向のみで安全（fail-closed）。
# ${IFS} 展開や ANSI-C クォート（$'...'）の「意味的デコード」は文字削除では追えないため、
# それらは本正規化ではなく最前段の「デコード用プリミティブの存在検知 deny」で raw 段階で
# 弾いている（波括弧なし $IFS の直書きはここでも (3) で空白化される）。これらにより既知の
# 直接実行形は塞ぐが、間接実行（eval・base64 復元・変数間接呼び出し・コマンド置換 $(...) 等）
# までは文字列照合では防げない（残存リスク。ファイル冒頭コメント・SKILL.md 参照。実強制は
# サーバ側 branch protection + 完全一致 nonce + merge-verify が担う多層防御の一層として運用する）。
norm=$(printf '%s\n' "$cmd" \
  | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
  | tr '\n' ' ' \
  | sed -e 's/[$]{IFS}/ /g' -e 's/[$]IFS/ /g' \
  | tr -d "'\"" \
  | tr -d "\\\\" \
  | tr -s '[:space:]' ' ')

nmatches() {
  printf '%s' "$norm" | grep -qE "$1"
}

# gh pr merge（grant の expectedCommand と完全一致しなかったものすべて）。
# pr と merge の間は [[:space:]]* とし、行継続除去で密着した形（prmerge）も検出する
if nmatches 'gh[[:space:]]+pr[[:space:]]*merge'; then
  deny "subagent からの gh pr merge は grant の expectedCommand と完全一致する場合のみ許可（grant は host が merge-exec 起動時にのみ発行する）"
fi

if nmatches 'gh[[:space:]]+api'; then
  # REST merge: PUT repos/<owner>/<repo>/pulls/<n>/merge
  if nmatches 'pulls/[^[:space:]]*/merge'; then
    deny "subagent からの REST merge（gh api pulls/<n>/merge）は禁止"
  fi
  # REST ブランチマージ: POST repos/<owner>/<repo>/merges
  if nmatches '/merges([[:space:]?]|$)'; then
    deny "subagent からの REST ブランチマージ（gh api repos/<o>/<r>/merges）は禁止"
  fi
  # GraphQL merge / auto-merge 有効化 mutation
  if nmatches 'mergePullRequest|enablePullRequestAutoMerge'; then
    deny "subagent からの GraphQL merge / auto-merge 有効化（mergePullRequest / enablePullRequestAutoMerge）は禁止"
  fi
fi

# レビュー承認（外部レビューゲートの自作自演を防ぐ）
if nmatches 'gh[[:space:]]+pr[[:space:]]+review' && nmatches '(^|[[:space:]])--approve([[:space:]]|$|=)'; then
  deny "subagent からの gh pr review --approve は禁止"
fi

# 別名・拡張経由の迂回封じ: gh alias（set / import 等すべて）・gh extension（install 等）
if nmatches 'gh[[:space:]]+alias([[:space:]]|$)'; then
  deny "subagent からの gh alias は禁止（別名経由のマージ迂回を防ぐ）"
fi
if nmatches 'gh[[:space:]]+extensions?([[:space:]]|$)'; then
  deny "subagent からの gh extension は禁止（拡張経由のマージ迂回を防ぐ）"
fi

# マージ系以外のコマンド（gh pr comment による催促・読み取り系等）は許可
exit 0

#!/usr/bin/env bash
# implement-issue-tree の merge-guard hook（PreToolUse / matcher: Bash）。
#
# この hook は subagent（monitor 等）のマージ系コマンドを deny する **best-effort の攻撃面
# 削減**であり、**承認境界ではない**。当初は host 発行の grant（expectedCommand 完全一致）に
# よる allow 経路を持たせて「未承認マージを許可しない証明可能な境界」を主張していたが、
# 同一トラストドメイン（hook と subagent が同じ FS・env・gh 認証を共有し、agent 単位の
# 権限分離がない）では偽造不能な認可を hook 側で検証できないことが判明したため、allow 経路を
# 全撤去した（grant 偽造 P0: monitor は Bash を持ち通常のファイル作成も hook を通るため、
# gh pr view で HEAD を取得 → 任意 nonce で grant-<pr>.json を自作 → その expectedCommand を
# 実行できる。hook は grant の真正性・署名を検証できない。この基盤には hook 専用の秘密注入
# 経路がなく（settings.json の env はセッション全体=subagent Bash 含めて共有）、hook が
# 検証でき subagent が読めない鍵を持てないため、MAC/署名による偽造防止は実装不能）。
#
# したがって本 hook は subagent からのマージ系コマンドを**無条件 deny**する（例外なし）。
# 間接実行（eval・base64 復元・変数間接呼び出し・コマンド置換 $(...)）や未知のスペリングは
# 文字列照合では防げない。**実際にマージを止めるのは、この Workflow が『自動マージを行わない』
# 方針そのもの（autoMerge を無条件 fail-closed 化し新規マージ経路を開かない）と、サーバ側の
# branch protection（人間がマージする前提の運用推奨）である**（rust-ai-library PR #441 /
# agent-cli-skills PR #182 codex P0）。この hook は多層防御の一層（best-effort deny）にすぎない。
#
# 呼び出し元の前提（契約）:
#   - .claude/settings.json の hooks.PreToolUse（matcher: "Bash"）に登録されて実行される。
#     stdin に hook JSON（agent_id / tool_input.command 等）を受け取る。導入は任意。
#   - agent_id は subagent 実行時のみ存在する。main スレッド（agent_id なし）は人間の監督下の
#     対話コンテキストであり、本 hook の制限対象外（何も出力せず許可）。
#   - deny 応答の permissionDecisionReason にはマーカー文字列
#     「implement-issue-tree-merge-guard」を含める（多層防御のログ識別用。allow 経路・canary は
#     撤去したため必須ではないが、ログ突き合わせのために残す）。
#
# 判定ポリシー（allow 経路なし。deny 専用）:
#   - subagent（agent_id あり）からのマージ系スペリングは無条件 deny:
#       gh pr merge（あらゆる形）/ REST merge（pulls/<n>/merge・repos/<o>/<r>/merges）/
#       GraphQL merge（mergePullRequest / enablePullRequestAutoMerge / mergeBranch）/
#       gh pr review --approve / gh alias / gh extension
#   - jq 不在・stdin パース失敗等の異常時 → deny（fail-closed）。ただし stdin に文字列
#     "agent_id" が現れない入力（main スレッド）は jq 不在でも許可する
#     （jq 不在環境で main スレッドをロックアウトしないための入口判定）
#   - 上記以外のコマンド（gh pr comment "@cursor review"・読み取り系等）→ 許可（出力なし exit 0）
#
# サブコマンド判定はトークン化 + 語順部分列一致で行う（Fandhe-AI/actions PR #66 codex P0）:
#   従来は `gh[[:space:]]+pr[[:space:]]*merge` のように「gh」「pr」「merge」の**隣接**を要求する
#   正規表現だったため、`gh -R owner/repo pr merge` / `gh --repo owner/repo pr merge` のように
#   サブコマンド前へ gh のグローバルオプション（-R/--repo・--hostname 等）を挟む正規の CLI 構文で
#   容易に迂回できた（同様に `gh[[:space:]]+api` も `gh --repo o/r api ...` で迂回できていた）。
#   個別のフラグ名を列挙して読み飛ばす方式（ブラックリスト）は、gh が新設する未知のグローバル
#   オプションに追従できず再発するため採用しない。代わりに以下の方式でフラグの語彙に依存せず
#   汎用的に扱う:
#     1. 独立コマンドの区切り（; & && ||）でセグメントに分割する（`;` 等を跨いだ語順一致に
#        よる誤検知を防ぐため。例: `gh pr view 1 && git merge main` は "gh" "pr" "merge" が
#        セグメントをまたぐため deny されない）。単一の `|`（パイプ）は分割しない
#        （前段の出力を後段が読む単一パイプラインのため分割すると mutation 名等の照合が
#        セグメントをまたいで見逃される。agent-cli-skills PR #195 codex P0）。
#     2. セグメントごとに、空白区切りの各トークンのうち `-` で始まるもの（フラグ。値の有無を
#        問わず）をすべて除去したトークン列を作る。値トークン（`-R owner/repo` の
#        `owner/repo` 側）は孤立して残るが、判定は**隣接ではなく語順の部分列一致**（後述）で
#        行うため、孤立した値トークンが偶然すり抜けの原因にはならない（値トークンが
#        たまたま "pr" や "merge" と完全一致しない限り無害。あえて「フラグとその次の値トークン」
#        をまとめて削る方式は採らない — その方式では `gh --version pr merge` のような
#        引数なしフラグの直後に来た本物のサブコマンド語まで値と誤認して削ってしまい、
#        `gh` → `pr` → `merge` の並びを見逃す fail-open 方向の誤りになるため）。
#     3. フラグ除去後のトークン列に「gh」→「pr」→「merge」（または「gh」→「api」等）が
#        **この順序で**（連続でなくてよい）現れるかを判定する。順序判定のため、値トークンの
#        混入は誤検知（over-deny）方向にのみ働き、見逃し（under-deny）方向には働かない。
#   `gh pr review --approve` の `--approve`自体はフラグなのでフラグ除去後には残らない。
#   そのため「gh」→「pr」→「review」の順序判定はフラグ除去後トークン列で行い、`--approve` の
#   有無は元のセグメント（フラグ除去前）に対して判定する。
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
# 防げない。本 hook は完全なサンドボックスではない（実強制は「自動マージを行わない」方針と
# サーバ側 branch protection が担う。ファイル冒頭コメント・SKILL.md 参照）。
if printf '%s' "$cmd" | grep -qE "[$]'"; then
  deny "ANSI-C クォート構文（\$'...'）を含むコマンドは deny（デコードで難読化されたマージ経路を防ぐ best-effort。fail-closed）"
fi
if printf '%s' "$cmd" | grep -qE '[$]\{?IFS'; then
  deny "IFS 由来の展開（\$IFS / \${IFS} / \${IFS%?} 等）を含むコマンドは deny（トークン分割難読化を防ぐ best-effort。fail-closed）"
fi

# --- 正規化: 難読化対策（クォート分割・行継続・IFS 直書き等）を潰す ----------------------
# subagent からのマージ系コマンドはすべて deny（allow 経路なし）。以下の順で正規化してから
# セグメント分割・トークン判定を行う:
#   (1) バックスラッシュ + 改行の行継続を除去
#   (2) 改行 → 空白
#   (3) ${IFS} / $IFS（波括弧あり/なし）を空白へ置換（gh${IFS}pr${IFS}merge のトークン分割難読化を潰す）
#   (4) シングル/ダブルクォート文字の除去（g''h → gh 等のクォート分割難読化を潰す）
#   (5) 残存する単独バックスラッシュを全除去（g\h pr merge / gh a\lias 等の直接実行形を潰す）
#   (6) 連続空白の圧縮
# ${IFS} 展開や ANSI-C クォート（$'...'）の「意味的デコード」は文字削除では追えないため、
# それらは本正規化ではなく前段の「デコード用プリミティブの存在検知 deny」で raw 段階で
# 弾いている。これらにより既知の直接実行形は塞ぐが、間接実行（eval・base64 復元・
# 変数間接呼び出し・コマンド置換 $(...) 等）までは文字列照合では防げない（残存リスク。
# ファイル冒頭コメント・SKILL.md 参照。実強制は「自動マージを行わない」方針とサーバ側
# branch protection が担う）。
norm=$(printf '%s\n' "$cmd" \
  | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }' \
  | tr '\n' ' ' \
  | sed -e 's/[$]{IFS}/ /g' -e 's/[$]IFS/ /g' \
  | tr -d "'\"" \
  | tr -d "\\\\" \
  | tr -s '[:space:]' ' ')

# --- セグメント分割: 独立コマンドの区切り（; & && ||）ごとに判定する ---------------------
# 分割しないと「gh pr view 1 && git merge main」のような無関係な複合コマンドが、文字列全体
# を対象にした語順一致で誤って deny されうる（"gh" → "pr" → "merge" が偶然この順で並ぶが
# 別コマンドの語）。ただし単一の `|`（パイプ）は分割しない —— `;`/`&`/`&&`/`||` は互いに
# 無関係な独立コマンドの区切りだが、`|` は前段の出力を後段の標準入力へ流し込む単一の
# パイプラインであり、`printf '...mergePullRequest...' | gh api graphql --input -` のように
# mutation 名（前段）と `gh api`（後段）が同一パイプラインの別セグメントに分かれてしまうと、
# 後段の REST/GraphQL merge 照合（`gh api` 判定と同一セグメント内の文字列一致が前提）が
# 両方とも不成立になり見逃す（agent-cli-skills PR #195 codex P0: セグメント分割導入時に
# `|` も区切りに含めたことで発生した回帰）。よって `|` はセグメント区切りに含めない
# （`||` は制御フローであり標準入力を運ばないため区切りに含めてよい）。
segments_raw=$(printf '%s\n' "$norm" | awk '{ gsub(/&&|\|\||[;&]/, "\n"); print }')

# フラグトークン（`-` で始まるすべてのトークン）を除去したトークン列を返す。
# 値トークンは孤立して残る（コメント冒頭の設計注記のとおり、これは語順部分列判定と
# 組み合わせる前提で安全側）。
strip_flags() {
  local seg="$1" tok out=""
  for tok in $seg; do
    case "$tok" in
      -*) : ;;
      *) out="$out $tok" ;;
    esac
  done
  printf '%s' "$out"
}

# $1 に渡したトークン列（空白区切り、word-splitting 前提）の中に、$2 以降で指定した語が
# **この順序で**（連続でなくてよい）出現するかを判定する。
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

while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  seg_nf=$(strip_flags "$seg")

  # gh pr merge（あらゆる形。グローバルオプションの挟み込みで迂回不可）
  if contains_subsequence "$seg_nf" gh pr merge; then
    deny "subagent からの gh pr merge は禁止（この基盤では自動マージを行わない。マージは GitHub 上で人間が行う）"
  fi

  # gh api 経由のマージ（グローバルオプションの挟み込みで迂回不可）
  if contains_subsequence "$seg_nf" gh api; then
    # REST merge: PUT repos/<owner>/<repo>/pulls/<n>/merge
    if printf '%s' "$seg" | grep -qE 'pulls/[^[:space:]]*/merge'; then
      deny "subagent からの REST merge（gh api pulls/<n>/merge）は禁止"
    fi
    # REST ブランチマージ: POST repos/<owner>/<repo>/merges
    if printf '%s' "$seg" | grep -qE '/merges([[:space:]?]|$)'; then
      deny "subagent からの REST ブランチマージ（gh api repos/<o>/<r>/merges）は禁止"
    fi
    # GraphQL merge / auto-merge 有効化 / ref 直接マージ mutation。
    # mergeBranch は PR を経由せず head ref を base へ直接マージできる迂回経路として塞ぐ。
    if printf '%s' "$seg" | grep -qE 'mergePullRequest|enablePullRequestAutoMerge|mergeBranch'; then
      deny "subagent からの GraphQL merge 系 mutation（mergePullRequest / enablePullRequestAutoMerge / mergeBranch）は禁止"
    fi
  fi

  # レビュー承認（外部レビューゲートの自作自演を防ぐ）。--approve はフラグなので
  # strip_flags 後には残らない。元セグメント（フラグ除去前）に対して判定する。
  if contains_subsequence "$seg_nf" gh pr review \
    && printf '%s' "$seg" | grep -qE '(^|[[:space:]])--approve([[:space:]]|$|=)'; then
    deny "subagent からの gh pr review --approve は禁止"
  fi

  # 別名・拡張経由の迂回封じ: gh alias（set / import 等すべて）・gh extension（install 等）
  if contains_subsequence "$seg_nf" gh alias; then
    deny "subagent からの gh alias は禁止（別名経由のマージ迂回を防ぐ）"
  fi
  if contains_subsequence "$seg_nf" gh extension \
    || contains_subsequence "$seg_nf" gh extensions; then
    deny "subagent からの gh extension は禁止（拡張経由のマージ迂回を防ぐ）"
  fi
done <<< "$segments_raw"

# マージ系以外のコマンド（gh pr comment による催促・読み取り系等）は許可
exit 0

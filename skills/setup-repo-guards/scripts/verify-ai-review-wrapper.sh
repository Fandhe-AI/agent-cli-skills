#!/usr/bin/env bash
# verify-ai-review-wrapper.sh
#
# 役割: setup-repo-guards の Step 1 が Fandhe-AI/actions から取得した ai-review wrapper
#       （ai-review.single.yml）を、対象リポジトリの .github/workflows/ へ配置する前に検査する。
#       取得元の改ざん・誤更新が、そのまま対象リポジトリの workflow になるのを防ぐ関門。
# 呼び出し元: skills/setup-repo-guards/SKILL.md Step 1（配置前に必ず実行。不合格なら配置しない）。
# 方式: allow-list（fail-closed）。コメント行と空行を除いた有効行を 1 行ずつ許可パターンと
#       突き合わせ、未知のキー・想定外の値は不合格にする。YAML パーサは使わない
#       （bash 3.2 と GNU bash の両方で動かすため、外部依存を持たない）。
#       値は「キーごとに許可する文法」へ完全一致させる（共通の文字集合で緩く受けない）:
#       with の値は 1 行の plain scalar（または全体を 1 組の引用符で囲んだ文字列）に限り、
#       `: `・`#`・anchor・tag・flow 記法は拒否する。types / branches / skip-branch-prefixes 等の
#       列挙は要素に分割し、各要素の前後の空白だけを除いて許可語・要素の文法へ完全一致させる
#       （要素内部の空白・空要素・重複は拒否）。判断に迷う入力は拒否する。
#       文字列でなければならない位置（name・ジョブ ID・concurrency.group・with の文字列キー・
#       on.pull_request.branches の要素）では、引用符なしで書かれると YAML が null・真偽値・数値・
#       日付に解決する値（null・~・true・yes・on・1・1_000・0x1F・1.5・.inf・2026-10-24 等。
#       YAML 1.1 と 1.2 の和集合）を拒否する（is_typed_plain_scalar）。引用符で囲んだ値は文字列なので許可する。
#       concurrency は任意だが、あるときは group が必須（group の無い concurrency は GitHub Actions が
#       workflow を無効にする）。
#       構造は位置に依存しない状態機械で追う: インデント 0 の行ごとにセクションを切り替え、
#       jobs の内側ではジョブ ID の行の後ろ（現在のジョブ）でだけ設定を受理し、uses・permissions・
#       with.provider は現在のジョブに帰属させて、ジョブを終える時点（次のジョブ ID・jobs を抜ける
#       トップレベルキー・ファイル末尾）に揃っていることを確かめる。
# 出力: 結果行（OK / NG と違反項目名・行番号）のみ。ファイル内容は出力しない
#       （検出器が内容の漏洩経路にならないようにする）。
# 終了コード: 0 = 合格 / 1 = 検査不合格 / 2 = 使い方の誤り・検査自体の失敗。
set -u
# 文字クラス・範囲の解釈をロケールに依存させない
export LC_ALL=C

EXPECTED_USES='Fandhe-AI/actions/.github/workflows/ai-review.yml@latest'

if [ "$#" -ne 1 ]; then
  echo "使い方: verify-ai-review-wrapper.sh <検査対象の workflow ファイル>" >&2
  exit 2
fi
target="$1"
if [ ! -f "${target}" ] || [ ! -r "${target}" ]; then
  echo "検査失敗: 読み取れる通常ファイルではない" >&2
  exit 2
fi

violations=0
jobs_seen=0     # トップレベル jobs があった
perm_scope=""   # "" / top / job
perm_indent=0
section=""      # 直近のトップレベルキー（on / concurrency / jobs / permissions）
top_perm_ok=0   # トップレベル permissions に contents: read があった
# 以下 job_* は「現在のジョブ」（cur_job）に帰属する。ジョブ ID の行で初期化し、
# 次のジョブ ID・jobs を抜けるトップレベルキー・ファイル末尾で finish_job が必須項目を確認する
job_uses=0      # 現在のジョブに期待値と一致する uses があった
job_contents=0  # 現在のジョブの permissions に contents: read があった
job_prw=0       # 現在のジョブの permissions に pull-requests: write があった
job_provider=0  # 現在のジョブの with に provider があった
job_sub=""      # jobs 配下のインデント 4 の直近キー（with / secrets / permissions / その他）
on_seen=0       # トップレベル on があった
conc_seen=0     # トップレベル concurrency があった
group_seen=0    # concurrency 直下に group の行があった（値の良否は別途検査する）
pr_seen=0       # on 直下（インデント 2）の pull_request があった
on_sub=""       # on 直下（インデント 2）の直近キー（types / branches を置けるのは pull_request の直下だけ）
seen=" "         # 出現済みキーの集合（スコープ/キー を空白区切りで保持。重複キー検出用）
cur_job=""       # 現在のジョブ ID。空 = ジョブの内側にいない（jobs の外、または jobs 直下でジョブ ID より前）
job_count=0      # jobs 直下のジョブ数（uses と権限を同じジョブに束縛するため 1 件に限定する）
list_els=" "     # parse_list が集めた要素（空白区切り。重複と必須要素の判定に使う）
n=0

# 現在のジョブを終える。必須の uses・権限・provider が、そのジョブ自身に揃っていなければ不合格にする。
# 呼び出し: 次のジョブ ID の行・jobs を抜けるトップレベルキー・ファイル末尾。
# 終えたら cur_job を空にし、以後の字下げ付き行がこのジョブへ誤って帰属しないようにする
finish_job() {
  [ -n "${cur_job}" ] || return 0
  if [ "${job_uses}" -ne 1 ]; then
    echo "NG: ジョブ ${cur_job} に期待値と一致する uses がない"
    violations=$((violations + 1))
  fi
  if [ "${job_contents}" -ne 1 ] || [ "${job_prw}" -ne 1 ]; then
    echo "NG: ジョブ ${cur_job} の permissions に contents: read と pull-requests: write が必要"
    violations=$((violations + 1))
  fi
  if [ "${job_provider}" -ne 1 ]; then
    echo "NG: ジョブ ${cur_job} の with に provider が必要"
    violations=$((violations + 1))
  fi
  cur_job=""
}

# 同一 mapping 内のキー重複を検出する。YAML では後勝ち・解釈系で差が出るため fail-closed で拒否する
once() {
  case "${seen}" in
    *" $1 "*) ng "重複キー"; return 1 ;;
  esac
  seen="${seen}$1 "
  return 0
}

ng() {
  # 違反項目名と行番号のみを出す（行の内容は出さない）
  echo "NG: $1 (行 ${n})"
  violations=$((violations + 1))
}

# 値の文法。いずれも bash 3.2 で動く（連想配列・mapfile・${x,,} は使わない）。
RE_TOKEN='^[A-Za-z0-9_.][A-Za-z0-9_./-]*$'            # 空白・コロン・記号を含まない 1 語
RE_WORDS='^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$'       # 空白 1 個区切りの語
RE_EXPR_VARS='^\$\{\{ vars\.[A-Za-z0-9_]+ \}\}$'      # 組織・リポジトリ変数の参照だけを式として許可
RE_URL='^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9_./-]*)?$'
RE_BOT='^[A-Za-z0-9_-]+(\[bot\])?$'
RE_EVENT='^(opened|synchronize|reopened|ready_for_review)$'
RE_BRANCH='^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$'
RE_PREFIX='^[A-Za-z0-9_.][A-Za-z0-9_./-]*$'
RE_WITH_LINE='^([a-z][a-z-]*):[ ]+(.+)$'
RE_NAME_LINE='^name:[ ]+(.+)$'
RE_GROUP_LINE='^group:[ ]+(.+)$'
RE_TYPES_LINE='^types:[ ]+(.+)$'
RE_BRANCHES_LINE='^branches:[ ]+(.+)$'

# YAML が文字列以外に解決する plain scalar の形（YAML 1.1 と 1.2 の和集合。どちらかの方言で
# 文字列にならなければ拒否する）。GitHub Actions のパーサがどちらの方言に従うかに判定を依存させない
RE_TY_INT='^[-+]?[0-9][0-9_]*$'                       # 10 進・先頭 0 の 8 進（1.1）・_ 区切り
RE_TY_HEX='^[-+]?0[xX][0-9a-fA-F_]+$'
RE_TY_OCT='^0o[0-7_]+$'                               # 1.2 の 8 進
RE_TY_BIN='^[-+]?0[bB][01_]+$'                        # 1.1 の 2 進
RE_TY_FLOAT='^[-+]?([0-9][0-9_]*)?\.[0-9_]*([eE][-+]?[0-9]+)?$'   # 1.5・.5・1.・1.5e3
RE_TY_EXP='^[-+]?[0-9][0-9_]*[eE][-+]?[0-9]+$'        # 1.2 の 1e3（小数点なし）
RE_TY_INF='^[-+]?\.(inf|Inf|INF)$'
RE_TY_NAN='^\.(nan|NaN|NAN)$'
# 日付。時刻つきの形はコロンを含み、どの文法もコロンを拒否するためここでは日付のみを見る
RE_TY_DATE='^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$'

# 引用符なしで書かれたとき、YAML が文字列以外（null・真偽値・数値・日付など）に解決する値なら return 0。
# 拒否する形:
#   null     : null Null NULL ~
#   真偽値   : true/false・yes/no・on/off・y/n（大文字始まり・全大文字を含む）
#   整数     : 10 進（+-・_ 区切り・先頭 0 の 8 進）・0x… ・0o… ・0b…
#   浮動小数 : 1.5 .5 1. 1.5e3 1e3 ±.inf .nan
#   日付     : YYYY-M-D
#   その他   : = と <<（YAML 1.1 の value / merge）
# 引用符で囲まれた値は文字列なので、呼び出し側は unq_quoted=0 のときだけ呼ぶ
is_typed_plain_scalar() {
  case "$1" in
    null|Null|NULL|'~') return 0 ;;
    true|True|TRUE|false|False|FALSE) return 0 ;;
    yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF) return 0 ;;
    y|Y|n|N|'='|'<<') return 0 ;;
  esac
  [[ "$1" =~ ${RE_TY_INT} ]] && return 0
  [[ "$1" =~ ${RE_TY_HEX} ]] && return 0
  [[ "$1" =~ ${RE_TY_OCT} ]] && return 0
  [[ "$1" =~ ${RE_TY_BIN} ]] && return 0
  [[ "$1" =~ ${RE_TY_FLOAT} ]] && return 0
  [[ "$1" =~ ${RE_TY_EXP} ]] && return 0
  [[ "$1" =~ ${RE_TY_INF} ]] && return 0
  [[ "$1" =~ ${RE_TY_NAN} ]] && return 0
  [[ "$1" =~ ${RE_TY_DATE} ]] && return 0
  return 1
}

# 前後の空白（半角スペースのみ。タブは先に拒否済み）を除く。結果は trimmed に入れる
trim() {
  trimmed="$1"
  trimmed="${trimmed#"${trimmed%%[! ]*}"}"
  trimmed="${trimmed%"${trimmed##*[! ]}"}"
}

# 全体を 1 組の同じ引用符で囲んだ値は内側を unq に入れる。引用符なしはそのまま。
# 引用符の有無は unq_quoted（0 / 1）に残す（引用符つきは文字列なので is_typed_plain_scalar の対象外）。
# 開き引用符だけ・開閉が食い違う値は return 1（内側の引用符は各キーの文法が拒否する）
unquote() {
  unq="$1"
  unq_quoted=0
  case "$1" in
    \"*) case "$1" in \"?*\") unq="${1#\"}"; unq="${unq%\"}"; unq_quoted=1 ;; *) return 1 ;; esac ;;
    \'*) case "$1" in \'?*\') unq="${1#\'}"; unq="${unq%\'}"; unq_quoted=1 ;; *) return 1 ;; esac ;;
  esac
  return 0
}

# 区切りが , の要素列を分割し、各要素の前後の空白だけを除いて ERE ($2) へ完全一致させる。
# 空要素・不一致・重複は return 1。$3 が 1 の要素列（フロー配列。要素ごとに独立した YAML scalar）では、
# 引用符なしで文字列以外に解決される要素を return 3 にする。通った要素は list_els に " a b c " の形で残す
parse_list() {
  local rest="$1," el
  list_els=" "
  while [ -n "${rest}" ]; do
    el="${rest%%,*}"
    rest="${rest#*,}"
    trim "${el}"
    el="${trimmed}"
    [[ "${el}" =~ $2 ]] || return 1
    if [ "${3:-0}" = "1" ] && is_typed_plain_scalar "${el}"; then return 3; fi
    case "${list_els}" in *" ${el} "*) return 1 ;; esac
    list_els="${list_els}${el} "
  done
  return 0
}

# on.pull_request 配下の [a, b] 形式。角括弧で囲まれた 1 行のフロー配列だけを受け、要素は parse_list で検査する。
# $3 が 1 のときは要素の型付き scalar を return 3 で拒否する（parse_list 参照）。成功時は list_els に要素を残す
parse_flow_list() {
  local v="$1"
  [[ "${v}" =~ ^\[(.*)\]$ ]] || return 1
  parse_list "${BASH_REMATCH[1]}" "$2" "${3:-0}"
}

# concurrency.group: 語と、許可した github 式の並び。許可外の式・閉じていない式は残るので文字集合で落ちる
check_group() {
  local g="$1" e
  # 置換パターンは変数経由で渡す（単引用符の解釈が bash のバージョンで異なるため）
  for e in '${{ github.ref }}' '${{ github.head_ref }}' '${{ github.workflow }}' '${{ github.event.pull_request.number }}'; do
    g="${g//"${e}"/X}"
  done
  [[ "${g}" =~ ^[A-Za-z0-9_.-]+$ ]]
}

# 引用符なしの列挙（a,b）は空白を含められない。空白で区切りたい場合は全体を引用符で囲む
# （plain scalar の中の「, 」を要素の区切りと読むかは受け側で異なるため、曖昧な形は拒否する）
unquoted_list_ok() {
  case "$1" in
    \"*|\'*) return 0 ;;
  esac
  case "$1" in
    *" "*) return 1 ;;
  esac
  return 0
}

# with の値を、キーごとの文法へ完全一致させる。通れば return 0。収集は呼び出し側が wunq から行う
check_with_value() {
  local key="$1" val="$2"
  trim "${val}"
  val="${trimmed}"
  unquote "${val}" || return 1
  wunq="${unq}"
  # 文字列でなければならないキーは、引用符なしで文字列以外に解決される値を拒否する（return 3）。
  # max-diff-bytes（数値）・collaborators-only（真偽値）は意図した型なので対象外。provider は固定語
  case "${key}" in
    runner|model|api-base-url|reasoning-effort|post-feedback-runner|reviewer-id|reviewer-name|prompt-path|skip-branch-prefixes|allowed-bot-actors|block-priorities)
      if [ "${unq_quoted}" -eq 0 ] && is_typed_plain_scalar "${unq}"; then return 3; fi ;;
  esac
  case "${key}" in
    provider)             [[ "${unq}" =~ ^(codex|claude|gemini|grok|openai-compatible)$ ]] ;;
    runner|model)         [[ "${unq}" =~ $RE_TOKEN ]] || [[ "${unq}" =~ $RE_EXPR_VARS ]] ;;
    api-base-url)         [[ "${unq}" =~ $RE_URL ]] || [[ "${unq}" =~ $RE_EXPR_VARS ]] ;;
    reasoning-effort|post-feedback-runner|reviewer-id)
                          [[ "${unq}" =~ $RE_TOKEN ]] ;;
    reviewer-name)        [[ "${unq}" =~ $RE_WORDS ]] ;;
    max-diff-bytes)       [[ "${unq}" =~ ^[0-9]+$ ]] ;;
    prompt-path)          [[ "${unq}" =~ $RE_TOKEN ]] && [[ "${unq}" != *..* ]] ;;
    collaborators-only)   [ "${unq}" = "true" ] ;;
    skip-branch-prefixes) unquoted_list_ok "${val}" && parse_list "${unq}" "${RE_PREFIX}" ;;
    allowed-bot-actors)   unquoted_list_ok "${val}" && parse_list "${unq}" "${RE_BOT}" ;;
    block-priorities)     return 0 ;;   # 要素の検査は呼び出し側（P0 と P1 の必須判定が要る）
    *)                    return 2 ;;   # 許可リストにないキー
  esac
}

while IFS= read -r line || [ -n "${line}" ]; do
  n=$((n + 1))
  # CR・タブは構造の誤読につながるため拒否する
  case "${line}" in
    *$'\r'*) ng "改行コード CR を含む"; continue ;;
    *$'\t'*) ng "タブ文字を含む"; continue ;;
  esac
  # コメント行・空行は検査対象外
  if [[ "${line}" =~ ^[[:space:]]*(#.*)?$ ]]; then
    continue
  fi
  body="${line#"${line%%[![:space:]]*}"}"
  indent=$(( ${#line} - ${#body} ))

  # permissions ブロックの内側（親より深いインデント）は権限キーだけを許可する
  if [ -n "${perm_scope}" ] && [ "${indent}" -gt "${perm_indent}" ]; then
    # 子キーは親のちょうど +2 のインデントに限る（不正な入れ子・過剰インデントを拒否）
    if [ "${indent}" -ne $((perm_indent + 2)) ]; then
      ng "permissions の子キーのインデントが不正"
      continue
    fi
    once "perm:${perm_scope}:${cur_job}/${body%%:*}" || continue   # top のとき cur_job は空
    if [[ "${body}" =~ ^contents:[[:space:]]+read[[:space:]]*$ ]]; then
      if [ "${perm_scope}" = "top" ]; then top_perm_ok=1; else job_contents=1; fi
      continue
    fi
    if [ "${perm_scope}" = "job" ] && [[ "${body}" =~ ^pull-requests:[[:space:]]+write[[:space:]]*$ ]]; then
      job_prw=1
      continue
    fi
    ng "許可外の権限"
    continue
  fi
  perm_scope=""

  # インデント 0 の行はトップレベルの新しいセクションの開始。jobs を抜けるときは現在のジョブを終える。
  # 許可リストにないキーでもセクションを切り替える（直前のセクションの子として誤読しない）
  if [ "${indent}" -eq 0 ]; then
    finish_job
    section="other"
    job_sub=""
    on_sub=""
    if [[ "${body}" =~ ^(on|concurrency|jobs|permissions|name):([[:space:]]|$) ]]; then
      once "top/${body%%:*}" || continue
      section="${body%%:*}"
      if [ "${section}" = "on" ]; then on_seen=1; fi
      if [ "${section}" = "jobs" ]; then jobs_seen=1; fi
      if [ "${section}" = "concurrency" ]; then conc_seen=1; fi
    fi
  fi
  if [[ "${body}" =~ ^permissions:[[:space:]]*$ ]]; then
    perm_indent="${indent}"
    if [ "${indent}" -eq 0 ]; then
      perm_scope="top"
    elif [ "${section}" = "jobs" ] && [ "${indent}" -eq 4 ] && [ -n "${cur_job}" ]; then
      once "job:${cur_job}/permissions" || continue
      perm_scope="job"
      job_sub="permissions"
    else
      ng "ジョブ ID の後ろ・各ジョブ直下以外での permissions"
    fi
    continue
  fi
  if [[ "${body}" =~ ^permissions: ]]; then
    ng "permissions のインライン指定（write-all 等）"
    continue
  fi

  # 名前付きの違反（原因が分かるように先に判定する）
  if [[ "${body}" =~ ^(pull_request_target|workflow_run|issue_comment|issues|push|workflow_dispatch|schedule|repository_dispatch):? ]]; then
    ng "特権または許可外のトリガー"; continue
  fi
  if [[ "${body}" =~ ^(run|steps|container|services|env|runs-on):?([[:space:]]|$) ]]; then
    ng "run/steps/container/services/env/runs-on は thin wrapper に不要"; continue
  fi
  if [[ "${body}" =~ ^secrets:[[:space:]]*inherit ]]; then
    ng "secrets: inherit"; continue
  fi

  # 親キーごとの allow-list（親を追跡し、on 配下は pull_request のみ・任意名は jobs 直下のみ）
  if [ "${indent}" -eq 0 ]; then
    if [[ "${body}" =~ ${RE_NAME_LINE} ]]; then
      trim "${BASH_REMATCH[1]}"
      if ! { unquote "${trimmed}" && [[ "${unq}" =~ ${RE_WORDS} ]]; }; then
        ng "name の値が許可する文法に一致しない"
      elif [ "${unq_quoted}" -eq 0 ] && is_typed_plain_scalar "${unq}"; then
        ng "name の値が YAML で文字列以外に解決される（null・真偽値・数値・日付）"
      fi
      continue
    fi
    if [[ "${body}" =~ ^(on|concurrency|jobs):[[:space:]]*$ ]]; then continue; fi
    ng "許可リストにないトップレベルキー"; continue
  fi
  case "${section}" in
    on)
      if [ "${indent}" -eq 2 ]; then
        on_sub=""
        if [[ "${body}" =~ ^pull_request:[[:space:]]*$ ]]; then once "on/pull_request" || true; pr_seen=1; on_sub="pull_request"; continue; fi
        ng "on 配下は pull_request（types・branches）のみ許可"; continue
      fi
      if [ "${indent}" -eq 4 ] && [ "${on_sub}" = "pull_request" ]; then
        if [[ "${body}" =~ ${RE_TYPES_LINE} ]]; then
          once "on/types" || true
          trim "${BASH_REMATCH[1]}"
          # 要素ごとに許可語へ完全一致させ、PR の再レビューに必要な 3 イベントが要素として揃うことを確かめる
          if ! parse_flow_list "${trimmed}" "${RE_EVENT}"; then
            ng "types は [a, b] 形式で、各要素が opened・synchronize・reopened・ready_for_review のいずれかであること（空要素・重複・内部の空白は不可）"
          else
            for ev in opened synchronize reopened; do
              case "${list_els}" in
                *" ${ev} "*) ;;
                *) ng "types に ${ev} が必要"; ;;
              esac
            done
          fi
          continue
        fi
        if [[ "${body}" =~ ${RE_BRANCHES_LINE} ]]; then
          once "on/branches" || true
          trim "${BASH_REMATCH[1]}"
          brc=0
          parse_flow_list "${trimmed}" "${RE_BRANCH}" 1 || brc=$?
          if [ "${brc}" -eq 3 ]; then
            ng "branches の要素が YAML で文字列以外に解決される（null・真偽値・数値・日付）"
          elif [ "${brc}" -ne 0 ]; then
            ng "branches は [a, b] 形式で、各要素が 1 語のブランチ名であること（空要素・重複・内部の空白は不可）"
          fi
          continue
        fi
      fi
      ng "on 配下は pull_request（types・branches）のみ許可"; continue ;;
    concurrency)
      if [ "${indent}" -eq 2 ] && [[ "${body}" =~ ${RE_GROUP_LINE} ]]; then
        trim "${BASH_REMATCH[1]}"
        group_seen=1
        if ! { unquote "${trimmed}" && check_group "${unq}"; }; then
          ng "concurrency.group の値が許可する文法に一致しない"
        elif [ "${unq_quoted}" -eq 0 ] && is_typed_plain_scalar "${unq}"; then
          ng "concurrency.group の値が YAML で文字列以外に解決される（null・真偽値・数値・日付）"
        else
          once "concurrency/group" || true
        fi
        continue
      fi
      if [ "${indent}" -eq 2 ] && [[ "${body}" =~ ^cancel-in-progress:[[:space:]]+(true|false)[[:space:]]*$ ]]; then once "concurrency/cancel" || true; continue; fi
      ng "concurrency 配下の許可外の行"; continue ;;
    jobs) ;;
    *) ng "許可外のセクション配下の行（トップレベルの親キーの内側でのみ設定を受け付ける）"; continue ;;
  esac

  # ここから jobs の内側。インデント 2 = ジョブ ID、4 以上 = ジョブの設定。
  # ジョブの設定はジョブ ID の行より後ろ（cur_job が設定済み）でだけ受理する。
  # ジョブ ID より前の設定行・jobs: より前のジョブキーを、後続のジョブ ID で後から成立させない
  if [ "${indent}" -ne 2 ] && [ -z "${cur_job}" ]; then
    ng "ジョブ ID より前、またはジョブの外にある設定行"; continue
  fi

  # jobs 配下: インデント 2 = ジョブ ID、4 = ジョブのキー、6 = with / secrets の子
  if [ "${indent}" -eq 2 ]; then
    job_sub=""
    finish_job
    if [[ "${body}" =~ ^[A-Za-z_][A-Za-z0-9_-]*:[[:space:]]*$ ]]; then
      if is_typed_plain_scalar "${body%%:*}"; then
        # キーが null・真偽値などに解決されるジョブ ID（null:・true:・yes:・on: 等）。後続の行が誤帰属しないよう cur_job は空のまま
        ng "ジョブ ID が YAML で文字列以外に解決される（null・真偽値）"; continue
      fi
      cur_job="${body%%:*}"
      job_uses=0; job_contents=0; job_prw=0; job_provider=0
      once "jobs/${cur_job}" || true
      job_count=$((job_count + 1))
      continue
    fi
    ng "jobs 直下はジョブ ID のみ許可"; continue
  fi
  if [ "${indent}" -eq 4 ]; then
    job_sub="other"
    once "job:${cur_job}/${body%%:*}" || continue
    if [[ "${body}" =~ ^uses: ]]; then
      if [ "${body}" != "uses: ${EXPECTED_USES}" ]; then
        ng "uses が期待値と一致しない"
      else
        job_uses=1
      fi
      continue
    fi
    if [[ "${body}" =~ ${RE_NAME_LINE} ]]; then
      trim "${BASH_REMATCH[1]}"
      if unquote "${trimmed}" && [[ "${unq}" =~ ${RE_WORDS} ]]; then
        if [ "${unq_quoted}" -eq 0 ] && is_typed_plain_scalar "${unq}"; then
          ng "ジョブの name の値が YAML で文字列以外に解決される（null・真偽値・数値・日付）"
        fi
        continue
      fi
      ng "ジョブの name の値が許可する文法に一致しない"; continue
    fi
    if [[ "${body}" =~ ^(with|secrets):[[:space:]]*$ ]]; then job_sub="${body%%:*}"; continue; fi
    ng "ジョブ直下の許可リストにないキー（uses は直下に必要）"; continue
  fi
  if [ "${indent}" -eq 6 ]; then
    if [ "${job_sub}" = "with" ] && [[ "${body}" =~ ${RE_WITH_LINE} ]]; then
      wkey="${BASH_REMATCH[1]}"
      wraw="${BASH_REMATCH[2]}"
      once "job:${cur_job}/with/${wkey}" || continue
      # 値はキーごとの文法へ完全一致させる。許可外のキーもここで不合格にする
      wrc=0
      check_with_value "${wkey}" "${wraw}" || wrc=$?
      if [ "${wrc}" -eq 2 ]; then
        ng "with に許可リストにないキー"
        continue
      elif [ "${wrc}" -eq 3 ]; then
        ng "with の値が YAML で文字列以外に解決される（null・真偽値・数値・日付。文字列にするなら引用符で囲む）"
        continue
      elif [ "${wrc}" -ne 0 ]; then
        ng "with の値が、そのキーに許可する文法に一致しない"
        continue
      fi
      case "${wkey}" in
        provider) job_provider=1 ;;
        block-priorities)
          # 外側の引用符と各要素の前後の空白だけを正規化し、要素ごとに P0〜P3 へ完全一致させる。
          # 内部の空白・引用符・空要素・重複（'P0,P 1' 等）は配置後のファイルに残り P1 の指定にならないため拒否する
          if ! parse_list "${wunq}" '^P[0-3]$'; then
            ng "block-priorities の要素は P0〜P3 のみ許可（内部の空白・引用符・空要素・重複は不可）"
          else
            # P0 と P1 の両方を含まない値は既存のブロックゲートを外すため拒否する
            case "${list_els}" in *" P0 "*) ;; *) ng "block-priorities に P0 が必要" ;; esac
            case "${list_els}" in *" P1 "*) ;; *) ng "block-priorities に P1 が必要" ;; esac
          fi ;;
      esac
      continue
    fi
    if [ "${job_sub}" = "secrets" ] && once "job:${cur_job}/secrets/API_KEY" && [[ "${body}" =~ ^API_KEY:[[:space:]]+\$\{\{[[:space:]]*secrets\.[A-Za-z0-9_]+[[:space:]]*\}\}[[:space:]]*$ ]]; then continue; fi
  fi

  ng "許可リストにない行"
done < "${target}"

# 最後のジョブを終える（ファイル末尾）。各ジョブの uses・権限・provider は finish_job が確認する
finish_job

if [ "${jobs_seen}" -ne 1 ] || [ "${job_count}" -ne 1 ]; then
  echo "NG: トップレベル jobs の下にジョブがちょうど 1 件必要（現在 ${job_count} 件。uses と権限を同じジョブに束縛するため。空ファイル・エラー応答を含む）"
  violations=$((violations + 1))
fi

# concurrency は任意だが、あるなら group が必要（group の無い mapping は workflow を無効にする）
if [ "${conc_seen}" -eq 1 ] && [ "${group_seen}" -ne 1 ]; then
  echo "NG: concurrency には group が必要"
  violations=$((violations + 1))
fi

if [ "${on_seen}" -ne 1 ] || [ "${pr_seen}" -ne 1 ]; then
  echo "NG: トップレベル on とその直下の pull_request トリガーが必要"
  violations=$((violations + 1))
fi

# トップレベル permissions の欠落は GITHUB_TOKEN をリポジトリ・組織の既定値に委ねるため不合格にする
# （ジョブ側の permissions は finish_job が、そのジョブ自身に対して確認する）
if [ "${top_perm_ok}" -ne 1 ]; then
  echo "NG: トップレベル permissions の contents: read がない"
  violations=$((violations + 1))
fi

if [ "${violations}" -gt 0 ]; then
  echo "検査不合格: 違反 ${violations} 件。配置せず、差分を目視確認すること"
  exit 1
fi
echo "OK: ai-review wrapper の構造検査に合格"
exit 0

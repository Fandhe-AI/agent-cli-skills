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
# 出力: 結果行（OK / NG と違反項目名・行番号）のみ。ファイル内容は出力しない
#       （検出器が内容の漏洩経路にならないようにする）。
# 終了コード: 0 = 合格 / 1 = 検査不合格 / 2 = 使い方の誤り・検査自体の失敗。
set -u

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
uses_count=0
perm_scope=""   # "" / top / job
perm_indent=0
section=""      # 直近のトップレベルキー（on / concurrency / jobs / permissions）
top_perm_ok=0   # トップレベル permissions に contents: read があった
job_contents=0  # ジョブ側 permissions に contents: read があった
job_prw=0       # ジョブ側 permissions に pull-requests: write があった
job_sub=""      # jobs 配下のインデント 4 の直近キー（with / secrets / permissions / その他）
on_seen=0       # トップレベル on があった
pr_seen=0       # on 直下（インデント 2）の pull_request があった
seen=" "         # 出現済みキーの集合（スコープ/キー を空白区切りで保持。重複キー検出用）
cur_job=""       # jobs 配下の直近のジョブ ID
job_count=0      # jobs 直下のジョブ数（uses と権限を同じジョブに束縛するため 1 件に限定する）
types_bad=0      # on.pull_request.types が必須イベントを欠く
n=0

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

# with: 配下で許可するキー（テンプレートの「よく使う調整」と運用中の wrapper が使うもの）。
# 値は block scalar・anchor・tag・コメントを含められない文字集合に限る
re_with_key='^(provider|runner|model|reasoning-effort|block-priorities|collaborators-only|allowed-bot-actors|skip-branch-prefixes|post-feedback-runner|max-diff-bytes|reviewer-id|reviewer-name|api-base-url|prompt-path):[[:space:]]+[][A-Za-z0-9_.,:/"'"'"'$ {}-]+$'
re_free='^[^|>&*!]+$'
re_types='^types:[[:space:]]+\[[a-z_, ]+\][[:space:]]*$'
re_branches='^branches:[[:space:]]+\[[A-Za-z0-9_./*, -]+\][[:space:]]*$'

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
    once "perm:${perm_scope}:${cur_job}/${body%%:*}" || continue
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

  if [ "${indent}" -eq 0 ] && [[ "${body}" =~ ^(on|concurrency|jobs|permissions):[[:space:]]*$ ]]; then
    once "top/${body%%:*}" || continue
    section="${body%%:*}"
    job_sub=""
    if [ "${section}" = "on" ]; then on_seen=1; fi
  fi
  if [[ "${body}" =~ ^permissions:[[:space:]]*$ ]]; then
    perm_indent="${indent}"
    if [ "${indent}" -eq 0 ]; then
      perm_scope="top"
    elif [ "${section}" = "jobs" ] && [ "${indent}" -eq 4 ]; then
      once "job:${cur_job}/permissions" || continue
      perm_scope="job"
      job_sub="permissions"
    else
      ng "jobs の各ジョブ直下以外での permissions"
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
    if [[ "${body}" =~ ^name:[[:space:]]+ ]] && [[ "${body#name:}" =~ ${re_free} ]]; then once "top/name" || true; continue; fi
    if [[ "${body}" =~ ^(on|concurrency|jobs):[[:space:]]*$ ]]; then continue; fi
    ng "許可リストにないトップレベルキー"; continue
  fi
  case "${section}" in
    on)
      if [ "${indent}" -eq 2 ] && [[ "${body}" =~ ^pull_request:[[:space:]]*$ ]]; then once "on/pull_request" || true; pr_seen=1; continue; fi
      if [ "${indent}" -eq 4 ] && [[ "${body}" =~ ${re_types} ]]; then
        once "on/types" || true
        # PR の再レビューに必要な opened・synchronize・reopened をすべて含まない値は拒否する
        tval="${body#*:}"
        tval="${tval//[[:space:]\[\]]/}"
        for ev in opened synchronize reopened; do
          case ",${tval}," in
            *,"${ev}",*) ;;
            *) types_bad=1 ;;
          esac
        done
        if [ "${types_bad}" -eq 1 ]; then ng "types に opened・synchronize・reopened が必要"; fi
        continue
      fi
      if [ "${indent}" -eq 4 ] && [[ "${body}" =~ ${re_branches} ]]; then once "on/branches" || true; continue; fi
      ng "on 配下は pull_request（types・branches）のみ許可"; continue ;;
    concurrency)
      if [ "${indent}" -eq 2 ] && [[ "${body}" =~ ^group:[[:space:]]+ ]] && [[ "${body#group:}" =~ ${re_free} ]]; then once "concurrency/group" || true; continue; fi
      if [ "${indent}" -eq 2 ] && [[ "${body}" =~ ^cancel-in-progress:[[:space:]]+(true|false)[[:space:]]*$ ]]; then once "concurrency/cancel" || true; continue; fi
      ng "concurrency 配下の許可外の行"; continue ;;
    jobs) ;;
    *) ng "許可外のセクション配下の行"; continue ;;
  esac

  # jobs 配下: インデント 2 = ジョブ ID、4 = ジョブのキー、6 = with / secrets の子
  if [ "${indent}" -eq 2 ]; then
    job_sub=""
    if [[ "${body}" =~ ^[A-Za-z0-9_-]+:[[:space:]]*$ ]]; then
      cur_job="${body%%:*}"
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
      uses_count=$((uses_count + 1))
      if [ "${body}" != "uses: ${EXPECTED_USES}" ]; then
        ng "uses が期待値と一致しない"
      fi
      continue
    fi
    if [[ "${body}" =~ ^name:[[:space:]]+ ]] && [[ "${body#name:}" =~ ${re_free} ]]; then continue; fi
    if [[ "${body}" =~ ^(with|secrets):[[:space:]]*$ ]]; then job_sub="${body%%:*}"; continue; fi
    ng "ジョブ直下の許可リストにないキー（uses は直下に必要）"; continue
  fi
  if [ "${indent}" -eq 6 ]; then
    if [ "${job_sub}" = "with" ] && [[ "${body}" =~ ${re_with_key} ]]; then
      wkey="${body%%:*}"
      once "job:${cur_job}/with/${wkey}" || continue
      wval="${body#*:}"
      wval="${wval//[[:space:]\"\'\[\]]/}"
      case "${wkey}" in
        collaborators-only)
          # 既定の true 以外は外部コントリビューターのレビュー実行を許すため拒否する
          if [ "${wval}" != "true" ]; then ng "collaborators-only は true のみ許可"; fi ;;
        block-priorities)
          # P0 と P1 の両方を含まない値は既存のブロックゲートを外すため拒否する
          case ",${wval}," in
            *,P0,*) ;;
            *) ng "block-priorities に P0 が必要" ;;
          esac
          case ",${wval}," in
            *,P1,*) ;;
            *) ng "block-priorities に P1 が必要" ;;
          esac ;;
      esac
      continue
    fi
    if [ "${job_sub}" = "secrets" ] && once "job:${cur_job}/secrets/API_KEY" && [[ "${body}" =~ ^API_KEY:[[:space:]]+\$\{\{[[:space:]]*secrets\.[A-Za-z0-9_]+[[:space:]]*\}\}[[:space:]]*$ ]]; then continue; fi
  fi

  ng "許可リストにない行"
done < "${target}"

if [ "${job_count}" -ne 1 ]; then
  echo "NG: ジョブが ${job_count} 件（ちょうど 1 件必要。uses と権限を同じジョブに束縛するため）"
  violations=$((violations + 1))
fi

if [ "${uses_count}" -ne 1 ]; then
  echo "NG: uses が ${uses_count} 件（ちょうど 1 件必要。空ファイル・エラー応答を含む）"
  violations=$((violations + 1))
fi

if [ "${on_seen}" -ne 1 ] || [ "${pr_seen}" -ne 1 ]; then
  echo "NG: トップレベル on とその直下の pull_request トリガーが必要"
  violations=$((violations + 1))
fi

# 権限の欠落は GITHUB_TOKEN をリポジトリ・組織の既定値に委ねるため不合格にする
if [ "${top_perm_ok}" -ne 1 ]; then
  echo "NG: トップレベル permissions の contents: read がない"
  violations=$((violations + 1))
fi
if [ "${job_contents}" -ne 1 ] || [ "${job_prw}" -ne 1 ]; then
  echo "NG: ジョブ側 permissions の contents: read と pull-requests: write が必要"
  violations=$((violations + 1))
fi

if [ "${violations}" -gt 0 ]; then
  echo "検査不合格: 違反 ${violations} 件。配置せず、差分を目視確認すること"
  exit 1
fi
echo "OK: ai-review wrapper の構造検査に合格"
exit 0

#!/usr/bin/env bash
# スキル本文のツール中立性の静的検査（本リポジトリ専用）。
#
# 役割: skills/*/SKILL.md と skills/*/references/**/*.md が、特定の CLI
#   （Claude Code）にしか無い前提を書いていないかを検査する。
#   3 リポ共通の統一版 check-skill-structure.sh とは別に持ち、そちらは変えない。
# 検査内容:
#   1. 検出語（固定文字列）の混入。Claude Code 固有のツール名・変数・生成表記
#      （Agent ツール・Bash ツール・isolation: "worktree" 等）、特定ツールを主語にした
#      「Claude が」「Claude は」（「Claude Code が／は」には一致しない）と、
#      <root>/.claude/agents/**/*.md の frontmatter name: の値（委譲先の固有名）、
#      Explore Agent。固有名は語として一致させる（部分一致では拾わない）。
#   2. 各対象スキルの SKILL.md に「sandbox 環境での実行」を含む見出しがあること。
# 境界: 節の中身の妥当性は見ない（レビューで見る）。除外スキルは検査しない。
# 許可: 行内に <!-- tool-neutral: allow --> がある行は違反に数えず allowed に数える。
# 出力: 違反ごとに「<相対パス>:<行>: <検出語>」、欠落ごとに「<相対パス>: missing sandbox section」、
#   最後に TOOL_NEUTRAL_RESULT violations=<N> missing_sandbox=<M> allowed=<K>。
# 終了コード: 既定（警告モード）は 0。--strict は N+M >= 1 で 1。
#   使い方の誤りと、grep / find / awk 自体の失敗は 2（検出なしに倒さない = fail-closed）。
# 前提: bash 3.2（macOS）と bash 5 の両方で動く。追加依存は grep・awk・find・sort のみ。
#
# 使い方: bash .github/scripts/check-tool-neutral.sh [--strict] [<リポジトリのルート>]
set -uo pipefail

# -w の語境界を日本語の直前直後でも安定させるため、バイト単位で照合する。
export LC_ALL=C

# 規約の適用外（Claude Code 専用）の 3 件だけを外す。init/update-codex・opencode は
# 自分の対象ツール名を書いてよいだけで、Claude Code 専用の記述の禁止と sandbox 節の必須は
# 適用されるため検査する（.claude/rules/tool-neutral-skills.md「適用範囲と例外」）。
EXCLUDED="implement-issue-tree init-claude update-claude"
MARKER='<!-- tool-neutral: allow -->'
TAB="$(printf '\t')"
NL='
'

die() {
  echo "check-tool-neutral: $*" >&2
  exit 2
}

strict=0
root_arg=""
for arg in "$@"; do
  case "${arg}" in
    --strict) strict=1 ;;
    -*) die "不明なオプション: ${arg}" ;;
    *)
      [ -z "${root_arg}" ] || die "ルートは 1 つだけ指定する"
      root_arg="${arg}"
      ;;
  esac
done

# ルートの解決: 引数 > カレント（skills/ があれば）> スクリプト位置の ../..
if [ -n "${root_arg}" ]; then
  [ -d "${root_arg}" ] || die "ルートが存在しない: ${root_arg}"
  root="$(cd "${root_arg}" && pwd)" || die "ルートへ移動できない: ${root_arg}"
elif [ -d skills ]; then
  root="$(pwd)"
else
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || die "ルートを解決できない"
fi
[ -d "${root}/skills" ] || die "skills/ が無い: ${root}"
cd "${root}" || die "ルートへ移動できない"

# --- 検出語の一覧を作る ---
# 形式: 「F<TAB>語」= 固定文字列の部分一致、「W<TAB>語」= 語として一致。
terms=""
add_term() { terms="${terms}$1${TAB}$2${NL}"; }
for t in 'Agent ツール' 'subagent_type' 'AskUserQuestion' 'ExitPlanMode' '$ARGUMENTS' '${CLAUDE_' \
  'Co-Authored-By: Claude' 'Generated with [Claude Code]' \
  'isolation: "worktree"' 'Bash ツール' 'Claude が' 'Claude は'; do
  add_term F "${t}"
done
add_term W 'Explore Agent'

# 委譲先の固有名: frontmatter（先頭の --- から次の ---）の name: の値だけを拾う。
if [ -d .claude/agents ]; then
  agent_files="$(find .claude/agents -type f -name '*.md' | sort)" || die "find .claude/agents が失敗"
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    names="$(awk '
      NR == 1 { if ($0 != "---") exit; infm = 1; next }
      infm && $0 == "---" { exit }
      infm && /^name:/ {
        v = $0; sub(/^name:[ \t]*/, "", v); gsub(/["\047\r]/, "", v); sub(/[ \t]+$/, "", v)
        if (v != "") print v
      }' "${f}")" || die "awk が失敗: ${f}"
    while IFS= read -r n; do
      [ -n "${n}" ] && add_term W "${n}"
    done <<EOT_NAMES
${names}
EOT_NAMES
  done <<EOT_AGENTS
${agent_files}
EOT_AGENTS
fi

# --- 対象ファイルの検査 ---
violations=0
missing=0
allowed_lines="${NL}"   # 許可された行の「ファイル:行」。同じ行の複数語は 1 件に数える。
allowed=0
out=""

skill_dirs="$(find skills -mindepth 1 -maxdepth 1 -type d | sort)" || die "find skills が失敗"
while IFS= read -r dir; do
  [ -n "${dir}" ] || continue
  skill="${dir#skills/}"
  case " ${EXCLUDED} " in *" ${skill} "*) continue ;; esac
  [ -f "${dir}/SKILL.md" ] || continue

  files="${dir}/SKILL.md"
  if [ -d "${dir}/references" ]; then
    refs="$(find "${dir}/references" -type f -name '*.md' | sort)" || die "find ${dir}/references が失敗"
    [ -z "${refs}" ] || files="${files}${NL}${refs}"
  fi

  # sandbox 見出し: grep の終了コードは 0（あり）/ 1（なし）のみ正常。
  rc=0
  grep -Eq '^#+ .*sandbox 環境での実行' "${dir}/SKILL.md" || rc=$?
  if [ "${rc}" -eq 1 ]; then
    out="${out}${dir}/SKILL.md: missing sandbox section${NL}"
    missing=$((missing + 1))
  elif [ "${rc}" -ne 0 ]; then
    die "sandbox 見出しの grep が exit ${rc}: ${dir}/SKILL.md"
  fi

  while IFS= read -r file; do
    [ -n "${file}" ] || continue
    while IFS="${TAB}" read -r kind term; do
      [ -n "${term}" ] || continue
      opts="-nF"
      [ "${kind}" = "W" ] && opts="-nFw"
      rc=0
      hits="$(grep "${opts}" -e "${term}" "${file}")" || rc=$?
      if [ "${rc}" -eq 1 ]; then
        continue
      elif [ "${rc}" -ne 0 ]; then
        die "grep が exit ${rc}: ${file}"
      fi
      while IFS= read -r hit; do
        [ -n "${hit}" ] || continue
        lineno="${hit%%:*}"
        text="${hit#*:}"
        case "${text}" in
          *"${MARKER}"*)
            case "${allowed_lines}" in
              *"${NL}${file}:${lineno}${NL}"*) ;;
              *)
                allowed_lines="${allowed_lines}${file}:${lineno}${NL}"
                allowed=$((allowed + 1))
                ;;
            esac
            ;;
          *)
            out="${out}${file}:${lineno}: ${term}${NL}"
            violations=$((violations + 1))
            ;;
        esac
      done <<EOT_HITS
${hits}
EOT_HITS
    done <<EOT_TERMS
${terms}
EOT_TERMS
  done <<EOT_FILES
${files}
EOT_FILES
done <<EOT_DIRS
${skill_dirs}
EOT_DIRS

printf '%s' "${out}"
echo "TOOL_NEUTRAL_RESULT violations=${violations} missing_sandbox=${missing} allowed=${allowed}"

if [ "${strict}" -eq 1 ] && [ $((violations + missing)) -ge 1 ]; then
  exit 1
fi
exit 0

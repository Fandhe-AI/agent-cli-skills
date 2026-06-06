#!/usr/bin/env bash
# frontmatter-check.sh — 全 SKILL.md / agent / rule の frontmatter 検査と symlink リンク切れ確認
#
# 使い方: ./script/frontmatter-check.sh [--skills | --agents | --rules | --symlinks | --all]
# 元スキル: .claude/agents/quality/frontmatter-linter.md（検証項目 A〜F）
#
# このスクリプトは「読み取り専用」— ファイルの作成・変更・削除は一切行わない。

set -euo pipefail

# このスクリプトは skills/claude-code-reference/script/ 配下にあるため、リポジトリルートは3階層上
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# ANSI カラー（ターミナル判定付き）
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; RESET=''
fi

OK="${GREEN}OK${RESET}"
NG="${RED}NG${RESET}"
WARN="${YELLOW}WARN${RESET}"

TOTAL_NG=0
TOTAL_WARN=0

# ----------------------------------------------------------------
# ヘルパー: YAML frontmatter から指定キーの値を抽出する
# ----------------------------------------------------------------
extract_frontmatter_value() {
  local file="$1"
  local key="$2"
  # --- ... --- の間の行から key: value を取り出す
  python3 - "$file" "$key" <<'PYEOF'
import sys, re

filepath, key = sys.argv[1], sys.argv[2]
try:
    with open(filepath, encoding='utf-8') as f:
        content = f.read()
except Exception:
    print('')
    sys.exit(0)

# frontmatter ブロックを抽出
m = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
if not m:
    print('')
    sys.exit(0)

fm = m.group(1)
for line in fm.splitlines():
    if line.startswith(key + ':'):
        val = line[len(key)+1:].strip().strip('"\'')
        print(val)
        sys.exit(0)
print('')
PYEOF
}

# frontmatter ブロックが正しく閉じられているか確認
has_valid_frontmatter() {
  local file="$1"
  python3 - "$file" <<'PYEOF'
import sys, re
with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
    content = f.read()
if re.match(r'^---\n.*?\n---', content, re.DOTALL):
    sys.exit(0)
else:
    sys.exit(1)
PYEOF
}

# ----------------------------------------------------------------
# A/C: SKILL.md の frontmatter 検査
# ----------------------------------------------------------------
check_skills() {
  echo "=== A. SKILL.md frontmatter 検査 ==="
  echo ""

  local skill_dir="${REPO_ROOT}/skills"
  local any_ng=0

  for skill_md in "${skill_dir}"/*/SKILL.md; do
    local skill_path="${skill_md#${REPO_ROOT}/}"
    local dir_name
    dir_name=$(basename "$(dirname "$skill_md")")

    local fm_ok name_val name_ok kebab_ok desc_ok

    # frontmatter ブロックの存在確認
    if has_valid_frontmatter "$skill_md" 2>/dev/null; then
      fm_ok=true
    else
      fm_ok=false
    fi

    name_val=$(extract_frontmatter_value "$skill_md" "name")
    desc_val=$(extract_frontmatter_value "$skill_md" "description")

    # kebab-case チェック: ^[a-z][a-z0-9-]+$
    if [[ -n "$name_val" ]] && echo "$name_val" | grep -qE '^[a-z][a-z0-9-]+$'; then
      kebab_ok=true
    else
      kebab_ok=false
    fi

    # name とディレクトリ名の一致確認（C）
    if [[ "$name_val" == "$dir_name" ]]; then
      name_ok=true
    else
      name_ok=false
    fi

    # description の存在確認
    if [[ -n "$desc_val" ]]; then
      desc_ok=true
    else
      desc_ok=false
    fi

    local status
    if $fm_ok && $name_ok && $kebab_ok && $desc_ok; then
      status="$OK"
    else
      status="$NG"
      any_ng=$((any_ng + 1))
      TOTAL_NG=$((TOTAL_NG + 1))
    fi

    printf "  [%b] %-40s fm=%s name=%s kebab=%s desc=%s dir-match=%s\n" \
      "$status" "$skill_path" \
      "$(bool_str $fm_ok)" "$(val_str "$name_val")" "$(bool_str $kebab_ok)" \
      "$(bool_str $desc_ok)" "$(bool_str $name_ok)"
  done

  echo ""
  if [[ "$any_ng" -gt 0 ]]; then
    echo -e "  ${NG}: ${any_ng} 件の問題があります"
  else
    echo -e "  ${OK}: 全 SKILL.md が正常"
  fi
  echo ""
}

# ----------------------------------------------------------------
# B: Agent frontmatter 検査
# ----------------------------------------------------------------
check_agents() {
  echo "=== B. Agent frontmatter 検査 ==="
  echo ""

  local agents_dir="${REPO_ROOT}/.claude/agents"
  local any_ng=0

  while read -r agent_md; do
    local agent_path="${agent_md#${REPO_ROOT}/}"

    local name_val model_val desc_val fm_ok
    if has_valid_frontmatter "$agent_md" 2>/dev/null; then
      fm_ok=true
    else
      fm_ok=false
    fi

    name_val=$(extract_frontmatter_value "$agent_md" "name")
    model_val=$(extract_frontmatter_value "$agent_md" "model")
    desc_val=$(extract_frontmatter_value "$agent_md" "description")

    local model_ok=false
    if echo "$model_val" | grep -qE '^(haiku|sonnet|opus|claude-.+)$'; then
      model_ok=true
    fi

    local status
    if $fm_ok && [[ -n "$name_val" ]] && [[ -n "$desc_val" ]] && $model_ok; then
      status="$OK"
    else
      status="$NG"
      TOTAL_NG=$((TOTAL_NG + 1))
    fi

    printf "  [%b] %-50s model=%s\n" "$status" "$agent_path" "$(val_str "$model_val")"
  done < <(find "${agents_dir}" -name "*.md" | sort)

  echo ""
}

# ----------------------------------------------------------------
# D: symlink リンク切れ確認
# ----------------------------------------------------------------
check_symlinks() {
  echo "=== D. symlink リンク切れ確認 (.claude/skills/*) ==="
  echo ""

  local dotclaude_skills="${REPO_ROOT}/.claude/skills"
  local any_broken=0

  if [[ ! -d "$dotclaude_skills" ]]; then
    echo "  [${WARN}] .claude/skills/ ディレクトリが存在しません"
    echo ""
    return
  fi

  for link in "${dotclaude_skills}"/*; do
    local link_name
    link_name=$(basename "${link}")
    local target
    target=$(readlink "${link}" 2>/dev/null || echo "(readlink 失敗)")

    if [[ -e "${link}" ]]; then
      printf "  [%b] %-30s -> %s\n" "$OK" "$link_name" "$target"
    else
      printf "  [%b] %-30s -> %s (リンク切れ)\n" "$NG" "$link_name" "$target"
      any_broken=$((any_broken + 1))
      TOTAL_NG=$((TOTAL_NG + 1))
    fi
  done

  echo ""
  if [[ "$any_broken" -gt 0 ]]; then
    echo -e "  ${NG}: ${any_broken} 件のリンク切れ"
    echo "  修正方法: (cd .claude/skills && ln -s ../../skills/<name> <name>)"
  else
    echo -e "  ${OK}: リンク切れなし"
  fi
  echo ""
}

# ----------------------------------------------------------------
# ヘルパー関数
# ----------------------------------------------------------------
bool_str() {
  if $1; then echo "✅"; else echo "❌"; fi
}
val_str() {
  if [[ -n "$1" ]]; then echo "✅($1)"; else echo "❌(空)"; fi
}

# ----------------------------------------------------------------
# サマリー
# ----------------------------------------------------------------
print_summary() {
  echo "=== 総合判定 ==="
  echo ""
  if [[ "$TOTAL_NG" -gt 0 ]]; then
    echo -e "  ${NG}: NG ${TOTAL_NG} 件 / WARN ${TOTAL_WARN} 件"
    echo "  → 詳細を確認して対応してください"
  elif [[ "$TOTAL_WARN" -gt 0 ]]; then
    echo -e "  ${WARN}: NG 0 件 / WARN ${TOTAL_WARN} 件"
    echo "  → 軽微な警告があります"
  else
    echo -e "  ${OK}: 全チェック通過"
  fi
  echo ""
}

# ----------------------------------------------------------------
# メイン
# ----------------------------------------------------------------
main() {
  local mode="${1:---all}"

  echo "Frontmatter & Symlink Checker"
  echo "リポジトリ: ${REPO_ROOT}"
  echo ""

  case "$mode" in
    --skills)   check_skills ;;
    --agents)   check_agents ;;
    --symlinks) check_symlinks ;;
    --all | *)
      check_skills
      check_agents
      check_symlinks
      ;;
  esac

  print_summary
}

main "$@"

#!/usr/bin/env bash
# skills-sync.sh — スキルの symlink 作成と skills-lock.json 同期の実例
#
# 使い方: ./script/skills-sync.sh [skill-name]
# 元スキル: skills/contribute-skill/SKILL.md（Step 6: upstream clone）
#           skills/sync-skills-lock/SKILL.md（Step 3〜7: ハッシュ同期）
#           .claude/agents/author/skill-author.md（Step 5: symlink 案内）
#           .claude/rules/skill-authoring.md（新スキル追加手順 Step 2）
#
# このスクリプトは以下の2つの用途をカバーする:
#   1. 新スキルの symlink を .claude/skills/ に作成する
#   2. skills-lock.json の computedHash を upstream と同期する（確認のみ）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

# ----------------------------------------------------------------
# 用途1: スキルの symlink を作成する
# ----------------------------------------------------------------
# 元スキル: skill-authoring.md Step 2
#   ln -s ../../skills/<name> .claude/skills/<name>
#
# .claude/skills/<name> → ../../skills/<name>/SKILL.md を辿れるようにする。
# 相対パスで指定することで、リポジトリをどこに clone しても壊れない。
create_symlink() {
  local skill_name="${1:?スキル名が必要です}"
  local skills_dir="${REPO_ROOT}/skills"
  local dotclaude_skills_dir="${REPO_ROOT}/.claude/skills"

  # スキルディレクトリの存在確認
  if [[ ! -d "${skills_dir}/${skill_name}" ]]; then
    echo "[ERROR] skills/${skill_name}/ が存在しません。" >&2
    echo "[INFO]  先に skills/${skill_name}/SKILL.md を作成してください。" >&2
    exit 1
  fi

  # .claude/skills/ ディレクトリが存在しなければ作成
  mkdir -p "${dotclaude_skills_dir}"

  # symlink が既に存在する場合はスキップ
  if [[ -e "${dotclaude_skills_dir}/${skill_name}" ]]; then
    echo "[INFO] symlink は既に存在します: .claude/skills/${skill_name}"
    ls -la "${dotclaude_skills_dir}/${skill_name}"
    return 0
  fi

  # 相対パスで symlink を作成（絶対パスを避けることでポータブルになる）
  # ln の -s オプションのみ使用。-f（強制上書き）は使わない（安全のため）
  (
    cd "${dotclaude_skills_dir}"
    ln -s "../../skills/${skill_name}" "${skill_name}"
  )

  echo "[OK] symlink 作成: .claude/skills/${skill_name} -> ../../skills/${skill_name}"
}

# ----------------------------------------------------------------
# 全スキルの symlink 状態を確認する
# ----------------------------------------------------------------
# 元スキル: .claude/agents/quality/frontmatter-linter.md Step 4
check_symlinks() {
  local dotclaude_skills_dir="${REPO_ROOT}/.claude/skills"

  echo "[INFO] .claude/skills/ の symlink 状態:"
  echo ""

  local broken=0
  for link in "${dotclaude_skills_dir}"/*; do
    local link_name
    link_name=$(basename "${link}")
    local target
    target=$(readlink "${link}" 2>/dev/null || echo "(readlink 失敗)")

    if [[ -e "${link}" ]]; then
      echo "  OK:     ${link_name} -> ${target}"
    else
      echo "  BROKEN: ${link_name} -> ${target}"
      broken=$((broken + 1))
    fi
  done

  echo ""
  if [[ "$broken" -gt 0 ]]; then
    echo "[WARN] リンク切れが ${broken} 件あります。"
    echo "[INFO] 修正方法: ln -s ../../skills/<name> .claude/skills/<name>"
  else
    echo "[OK] リンク切れなし"
  fi
}

# ----------------------------------------------------------------
# スキル一覧と symlink の対応を確認する
# ----------------------------------------------------------------
check_all_skills_have_symlinks() {
  local skills_dir="${REPO_ROOT}/skills"
  local dotclaude_skills_dir="${REPO_ROOT}/.claude/skills"

  echo "[INFO] skills/ ↔ .claude/skills/ の対応確認:"
  echo ""

  local missing=0
  for skill_dir in "${skills_dir}"/*/; do
    local skill_name
    skill_name=$(basename "${skill_dir}")

    if [[ -e "${dotclaude_skills_dir}/${skill_name}" ]]; then
      echo "  OK:      ${skill_name}"
    else
      echo "  MISSING: ${skill_name} (symlink がありません)"
      missing=$((missing + 1))
    fi
  done

  echo ""
  if [[ "$missing" -gt 0 ]]; then
    echo "[WARN] symlink がないスキルが ${missing} 件あります。"
    echo "[INFO] 追加コマンド:"
    for skill_dir in "${skills_dir}"/*/; do
      local skill_name
      skill_name=$(basename "${skill_dir}")
      if [[ ! -e "${dotclaude_skills_dir}/${skill_name}" ]]; then
        echo "  ln -s ../../skills/${skill_name} .claude/skills/${skill_name}"
      fi
    done
  else
    echo "[OK] 全スキルに symlink があります"
  fi
}

# ----------------------------------------------------------------
# skills-lock.json の computedHash を確認する（読み取り専用）
# ----------------------------------------------------------------
# 元スキル: sync-skills-lock/SKILL.md Step 4〜5
# 実際の更新は sync-skills-lock スキルが行う。このスクリプトは確認のみ。
check_skills_lock() {
  local lock_file="${REPO_ROOT}/skills-lock.json"

  if [[ ! -f "$lock_file" ]]; then
    echo "[INFO] skills-lock.json が見つかりません（スキップ）"
    return 0
  fi

  echo "[INFO] skills-lock.json のスキル一覧:"
  python3 -c "
import json
with open('${lock_file}') as f:
    d = json.load(f)
skills = d.get('skills', {})
print(f'  合計 {len(skills)} スキル')
for name, info in skills.items():
    source = info.get('source', '(source なし)')
    h = info.get('computedHash', '(hash なし)')
    print(f'  - {name}: source={source}, hash={h[:10]}...')
"
}

# ----------------------------------------------------------------
# メイン
# ----------------------------------------------------------------
main() {
  local skill_name="${1:-}"

  if [[ -n "$skill_name" ]]; then
    echo "[INFO] スキル '${skill_name}' の symlink を作成します..."
    create_symlink "${skill_name}"
    echo ""
    echo "[INFO] 次のステップ:"
    echo "  1. update-docs スキルを実行して CLAUDE.md を更新する"
    echo "  2. git add .claude/skills/${skill_name} && git commit -m 'chore(skills): ${skill_name} の symlink を追加'"
  else
    echo "[INFO] 全スキルの状態を確認します..."
    echo ""
    check_symlinks
    echo ""
    check_all_skills_have_symlinks
    echo ""
    check_skills_lock
  fi
}

main "$@"

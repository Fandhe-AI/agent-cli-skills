// 配布物（skills/implement-issue-tree/）の場所。テストと開発専用ファイルは dev/ にあるため、
// 配布側のスクリプト・生成物・SKILL.md を読むテストはここから場所を得る。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'skills', 'implement-issue-tree')
export const SHIPPED_SCRIPTS = join(SKILL_DIR, 'scripts')

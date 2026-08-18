// preview-untracked.test.mjs — Issue #381 対応の決定的回帰テスト。
//
// skills-lock-update.sh の承認プレビュー（更新完了後の「変更内容:」表示）が、
// `git diff` だけでは表示されない未追跡ファイルの存在・内容まで見せることを検証する。
//
// npx の実クローン処理は行わず、PATH 先頭に置いた npx / gh のスタブへ差し替える。
// スタブの挙動は TEST_NPX_SCENARIO で切り替える:
//   - 'new-file'  : skills-lock.json を更新し、.agents/skills/<skill>/ 配下に
//                   新規（未追跡）ファイルを作成する（upstream にファイルが増えたケースの再現）
//   - 'edit-only' : skills-lock.json と既存の追跡ファイルのみ変更し、新規ファイルは作らない
//                   （既存動作の非退行確認）
// git / jq / python3 は実物を使用する（ネットワーク不使用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'skills-lock-update.sh',
)

const SKILL_NAME = 'dummy-skill'
const SOURCE_REPO = 'Fandhe-AI/dummy-source'

function sh(cmd, cwd, env) {
  return execFileSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8' })
}

// gh / npx を差し替えるスタブ bin ディレクトリと、npx シナリオを注入した git repo 一式を用意する。
// clean ガード（porcelain チェック）を通す必要があるため、初期状態は必ず commit 済みにする。
function setupRepo(scenario) {
  const repoDir = mkdtempSync(join(tmpdir(), 'sync-skills-lock-test-'))
  const binDir = mkdtempSync(join(tmpdir(), 'sync-skills-lock-bin-'))

  // gh スタブ: auth status のみ成功させる（他サブコマンドはこのスクリプトから呼ばれない）
  writeFileSync(join(binDir, 'gh'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(binDir, 'gh'), 0o755)

  // npx スタブ: 実際の `npx skills add` の代わりに、シナリオに応じて
  // skills-lock.json の computedHash 更新・install ツリーの変更を模擬する。
  const npxBody = `#!/usr/bin/env bash
set -euo pipefail
skill_dir=".agents/skills/${SKILL_NAME}"
# 既存の追跡ファイルを変更（tracked diff の対象）
echo "updated upstream content" > "\${skill_dir}/SKILL.md"
# skills-lock.json の computedHash を書き換える
python3 - <<'PYEOF'
import json
with open('skills-lock.json') as f:
    lock = json.load(f)
lock['skills']['${SKILL_NAME}']['computedHash'] = 'sha256:updated-hash-value'
with open('skills-lock.json', 'w') as f:
    json.dump(lock, f, indent=2)
    f.write('\\n')
PYEOF
if [[ "\${TEST_NPX_SCENARIO:-}" == "new-file" ]]; then
  # upstream にファイルが増えたケース: npx 実行前は clean だったため、これは必ず未追跡になる
  echo "brand new upstream file" > "\${skill_dir}/NEW_FILE.md"
fi
exit 0
`
  writeFileSync(join(binDir, 'npx'), npxBody)
  chmodSync(join(binDir, 'npx'), 0o755)

  sh('git init -q', repoDir)
  sh('git config user.email test@example.com', repoDir)
  sh('git config user.name test', repoDir)

  mkdirSync(join(repoDir, '.agents', 'skills', SKILL_NAME), { recursive: true })
  writeFileSync(
    join(repoDir, '.agents', 'skills', SKILL_NAME, 'SKILL.md'),
    'original content\n',
  )
  writeFileSync(
    join(repoDir, 'skills-lock.json'),
    JSON.stringify(
      {
        skills: {
          [SKILL_NAME]: {
            source: `https://github.com/${SOURCE_REPO}`,
            computedHash: 'sha256:original-hash-value',
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
  sh('git add -A && git commit -q -m init', repoDir)

  return { repoDir, binDir, scenario }
}

function runScript({ repoDir, binDir, scenario }) {
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TEST_NPX_SCENARIO: scenario,
  }
  return execFileSync('bash', [SCRIPT_PATH, SKILL_NAME, SOURCE_REPO], {
    cwd: repoDir,
    env,
    encoding: 'utf8',
  })
}

function cleanDryRunList(repoDir) {
  const out = sh(
    `git clean -fdn -- ".agents/skills/${SKILL_NAME}/"`,
    repoDir,
  )
  // `Would remove <path>` 形式の行からパスのみを取り出す
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^Would remove /, '').trim())
    .sort()
}

test('ケース1: upstream にファイルが増えた場合、プレビューが新規未追跡ファイルの内容を表示する', () => {
  const ctx = setupRepo('new-file')
  try {
    const out = runScript(ctx)

    assert.match(out, /新規（未追跡）ファイル/, '未追跡ファイルの見出しが出力されること')
    assert.match(out, /NEW_FILE\.md/, '新規ファイル名が出力に含まれること')
    assert.match(
      out,
      /brand new upstream file/,
      '新規ファイルの内容（diff --no-index の出力）が表示されること',
    )

    // プレビューの未追跡集合と git clean -fdn（拒否経路の対象集合）が一致することを確認する
    assert.deepEqual(
      cleanDryRunList(ctx.repoDir),
      [`.agents/skills/${SKILL_NAME}/NEW_FILE.md`],
    )

    // tracked diff も従来どおり表示されること（非退行）
    assert.match(out, /SKILL\.md/, 'tracked ファイルの diff も表示されること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース2: 追跡ファイルの変更のみの場合、「新規（未追跡）ファイル: なし」と表示される（既存動作の非退行）', () => {
  const ctx = setupRepo('edit-only')
  try {
    const out = runScript(ctx)

    assert.match(out, /新規（未追跡）ファイル: なし/)
    // tracked diff（SKILL.md の変更）は従来どおり表示される
    assert.match(out, /updated upstream content/)

    // 未追跡ファイルが無いため、拒否経路（git clean -fdn）の対象も空になる
    assert.deepEqual(cleanDryRunList(ctx.repoDir), [])
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

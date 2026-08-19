// scope-guard.test.mjs — Issue #410 の回帰テスト。
//
// `npx skills add` は元来エージェント/パス制限なしに実行され、検出した各エージェント
// 向けツリー（`.claude/skills/` 等）へも書き込み得た。しかし clean ガード・プレビュー・
// リバート（Step 6 相当）・承認 `git add`（Step 7 相当）はいずれも `skills-lock.json` と
// `.agents/skills/<name>/` のみを対象としており、スコープ外への書き込みが発生すると
// (1) WIP 上書き、(2) レビュー（プレビュー）迂回、(3) 「clean と報告した後の dirty 残留」
// が起き得た。
//
// scripts/skills-lock-update.sh は 2 層で塞ぐ:
//   1. 書き込みスコープの制限（一次防御）: 固定版呼び出しへ `--agent universal` を追加
//   2. スコープ外書き込みの fail-closed 検出（多層防御）: npx 実行前後の
//      `git status --porcelain -z -uall` スナップショット差分でスコープ外変化を検出し、
//      検出時はスコープ内をリバートして停止・案内する
//
// npx の実クローン処理は行わず、preview-untracked.test.mjs と同じ方式で
// PATH 先頭に置いた npx / gh のスタブへ差し替える。シナリオは TEST_NPX_SCENARIO で
// 切り替える:
//   - 'out-of-scope-write'        : スコープ内変更に加えて .claude/skills/dummy-skill/SKILL.md
//                                   （他エージェントツリー相当）と .cursor/rules/x.md
//                                   （任意の別ツリー）を作成する
//   - 'invalid-agents'            : npx が「Invalid agents: ...」を出力して exit 0 する
//                                   （CLI バージョン更新で universal が無効化された場合の
//                                   silent no-op を再現する）
//   - 'content-overwrite-dirty'   : PR #412 レビュー指摘（P1）の回帰。実行前から M
//                                   （追跡・変更済み）だったスコープ外ファイルの内容
//                                   だけを、パス・ステータス文字を変えずに上書きする
//                                   （porcelain の記録だけでは検出できず、内容ハッシュ
//                                   比較でのみ検出できるケース）
//   - 'npx-failure-out-of-scope'  : PR #412 レビュー指摘（P1）の回帰。スコープ外へ
//                                   部分書き込みしたのち npx 自体が非ゼロ終了する
//                                   （失敗経路でも事後のスコープ外検査に到達する
//                                   ことを検証する）
//   - 'mode-change-dirty'         : PR #412 レビュー指摘（第3巡・P1）の回帰。実行前
//                                   から M だったスコープ外ファイルのパーミッション
//                                   のみを変更し内容は変えない（porcelain の記録・
//                                   内容ハッシュのいずれも前後不変に見え、モードを
//                                   含む状態シグネチャ比較でのみ検出できるケース）
//   - 'tee-failure'               : PR #412 CI 失敗指摘（P1）の回帰。npx 自体は
//                                   exit 0 で成功するが、その出力を保存する tee が
//                                   非ゼロ終了する（ディスク容量不足等）。
//                                   NPX_OUTPUT_FILE が不完全なまま「Invalid agents」
//                                   no-op 検知をすり抜けて誤って成功扱いになって
//                                   いないことを検証する。
// git / jq / python3 は実物を使用する（ネットワーク不使用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'skills-lock-update.sh',
)

const SKILL_NAME = 'dummy-skill'
const SOURCE_REPO = 'Fandhe-AI/dummy-source'
// 'content-overwrite-dirty' / 'npx-failure-out-of-scope' シナリオで使う、
// 実行前から追跡・変更済み（M）にしておくスコープ外ファイルのパス。
const OUT_OF_SCOPE_FILE = '.claude/skills/other-skill/NOTES.md'

function sh(cmd, cwd, env) {
  return execFileSync('bash', ['-c', cmd], { cwd, env, encoding: 'utf8' })
}

// npx / gh スタブと、シナリオを注入した git repo 一式を用意する。
// ARGV_LOG_FILE には npx スタブが実際に受け取った引数を1行1トークンで記録し、
// --agent universal が実行経路に到達していることを静的テストとは別に検証する。
function setupRepo(scenario) {
  const repoDir = mkdtempSync(join(tmpdir(), 'sync-skills-lock-scope-test-'))
  const binDir = mkdtempSync(join(tmpdir(), 'sync-skills-lock-scope-bin-'))
  const argvLogFile = join(binDir, 'npx-argv.log')

  writeFileSync(join(binDir, 'gh'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(binDir, 'gh'), 0o755)

  const npxBody = `#!/usr/bin/env bash
set -euo pipefail
# 受け取った引数をそのまま1行1トークンで記録する（--agent universal 到達の検証用）
printf '%s\\n' "\$@" > "${argvLogFile}"

if [[ "\${TEST_NPX_SCENARIO:-}" == "invalid-agents" ]]; then
  # CLI バージョン更新で universal が無効な agent id になった場合の実測挙動
  # （skills@1.5.22 で確認済み: エラー表示のうえ exit 0 の no-op）。
  echo "Invalid agents: universal"
  echo "Valid agents: claude-code, cursor, ..."
  exit 0
fi

skill_dir=".agents/skills/${SKILL_NAME}"
echo "updated upstream content" > "\${skill_dir}/SKILL.md"
python3 - <<'PYEOF'
import json
with open('skills-lock.json') as f:
    lock = json.load(f)
lock['skills']['${SKILL_NAME}']['computedHash'] = 'sha256:updated-hash-value'
with open('skills-lock.json', 'w') as f:
    json.dump(lock, f, indent=2)
    f.write('\\n')
PYEOF

if [[ "\${TEST_NPX_SCENARIO:-}" == "out-of-scope-write" ]]; then
  # スコープ外（他エージェントツリー相当 + 任意の別ツリー）への書き込みを再現する
  mkdir -p ".claude/skills/${SKILL_NAME}"
  echo "leaked into claude tree" > ".claude/skills/${SKILL_NAME}/SKILL.md"
  mkdir -p ".cursor/rules"
  echo "leaked into cursor tree" > ".cursor/rules/x.md"
fi

if [[ "\${TEST_NPX_SCENARIO:-}" == "content-overwrite-dirty" ]]; then
  # 実行前から M（追跡・変更済み）だったスコープ外ファイルを、パス・ステータス文字は
  # 変えずに内容だけ上書きする（porcelain のレコードだけでは前後不変に見えるケース）。
  echo "npx overwrote this content" > "${OUT_OF_SCOPE_FILE}"
fi

if [[ "\${TEST_NPX_SCENARIO:-}" == "npx-failure-out-of-scope" ]]; then
  # スコープ内書き込み（上の python ブロック）に加えてスコープ外へも部分書き込み
  # したのち、npx 自体が失敗するケースを再現する。
  echo "npx overwrote this content during failure" > "${OUT_OF_SCOPE_FILE}"
  exit 1
fi

if [[ "\${TEST_NPX_SCENARIO:-}" == "mode-change-dirty" ]]; then
  # 実行前から M（追跡・変更済み）だったスコープ外ファイルの内容は変えず、
  # パーミッションのみを変更する（chmod 等での実行可能スクリプトコピーを再現）。
  chmod 755 "${OUT_OF_SCOPE_FILE}"
fi
exit 0
`
  writeFileSync(join(binDir, 'npx'), npxBody)
  chmodSync(join(binDir, 'npx'), 0o755)

  // tee スタブ。既定は `command -p tee`（ユーザー PATH に依存しない標準ユーティリティ
  // 探索）へ委譲して実物と同じ動作にする。TEST_NPX_SCENARIO=='tee-failure' のときのみ、
  // 入力を破棄したうえで非ゼロ終了し、ディスク容量不足等での tee 失敗を再現する
  // （Issue #410 CI 失敗指摘の回帰）。
  const teeBody = `#!/usr/bin/env bash
if [[ "\${TEST_NPX_SCENARIO:-}" == "tee-failure" ]]; then
  cat > /dev/null
  exit 1
fi
exec command -p tee "\$@"
`
  writeFileSync(join(binDir, 'tee'), teeBody)
  chmodSync(join(binDir, 'tee'), 0o755)

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
  // 'content-overwrite-dirty' / 'npx-failure-out-of-scope' / 'mode-change-dirty' 用:
  // スコープ外ファイルを baseline content でコミットしてから、コミット後に別内容へ
  // 書き換えて「実行前から M（追跡・変更済み）だった」状態を再現する。npx スタブは
  // 同じパス・同じ M ステータスのまま内容またはパーミッションをさらに上書きする。
  if (
    scenario === 'content-overwrite-dirty' ||
    scenario === 'npx-failure-out-of-scope' ||
    scenario === 'mode-change-dirty'
  ) {
    const outOfScopePath = join(repoDir, ...OUT_OF_SCOPE_FILE.split('/'))
    mkdirSync(dirname(outOfScopePath), { recursive: true })
    writeFileSync(outOfScopePath, 'baseline content\n')
    sh('git add -A && git commit -q -m init', repoDir)
    writeFileSync(outOfScopePath, 'pre-existing wip edit (uncommitted)\n')
    return { repoDir, binDir, scenario, argvLogFile }
  }

  sh('git add -A && git commit -q -m init', repoDir)

  return { repoDir, binDir, scenario, argvLogFile }
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

test('ケース1: npx が --agent universal を実際に受け取る（argv 記録による実行経路検証）', () => {
  const ctx = setupRepo('edit-only-for-argv-check')
  try {
    runScript(ctx)
    const argv = readFileSync(ctx.argvLogFile, 'utf8').split('\n').filter(Boolean)
    assert.ok(
      argv.includes('--agent') && argv.includes('universal'),
      `--agent universal が npx へ渡されていない: ${JSON.stringify(argv)}`,
    )
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース2: スコープ外書き込みを検出すると非ゼロ終了し、スコープ内はリバートされ、' +
  'スコープ外は削除されずに残る', () => {
  const ctx = setupRepo('out-of-scope-write')
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（fail-closed）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(combined, /スコープ外/, 'スコープ外検出のエラーメッセージが出ること')
        assert.match(combined, /\.claude\/skills/, '検出パスが列挙されること（.claude 側）')
        assert.match(combined, /\.cursor\/rules/, '検出パスが列挙されること（.cursor 側）')
        return true
      },
    )

    // スコープ内（skills-lock.json / .agents/skills/<name>/）はリバートされ clean
    const lockDiff = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff, '', 'skills-lock.json はリバートされ clean であること')
    const treeDiff = sh(
      `git status --porcelain -- ".agents/skills/${SKILL_NAME}/"`,
      ctx.repoDir,
    ).trim()
    assert.equal(treeDiff, '', '.agents/skills/<name>/ はリバートされ clean であること')

    // スコープ外は自動リバートせず、内容を確認できる状態のまま残す
    assert.ok(
      existsSync(join(ctx.repoDir, '.claude', 'skills', SKILL_NAME, 'SKILL.md')),
      'スコープ外ファイル（.claude 側）は削除されず残存すること',
    )
    assert.ok(
      existsSync(join(ctx.repoDir, '.cursor', 'rules', 'x.md')),
      'スコープ外ファイル（.cursor 側）は削除されず残存すること',
    )
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース3: 「Invalid agents」で exit 0 の no-op を検出し、非ゼロ終了する', () => {
  const ctx = setupRepo('invalid-agents')
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（silent no-op を許容しない）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(
          combined,
          /Invalid agents/,
          'no-op を検出したエラーメッセージが出ること',
        )
        return true
      },
    )

    // no-op のため何も更新されておらず、skills-lock.json も変化していないはず
    const lockDiff = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff, '', 'no-op のため skills-lock.json は変化していないこと')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース4: スコープ内のみの書き込みでは誤検出せず、従来どおり完走する（非退行）', () => {
  const ctx = setupRepo('edit-only')
  try {
    const out = runScript(ctx)
    assert.doesNotMatch(out, /スコープ外/, 'スコープ内のみの変更を誤検出しないこと')
    assert.match(out, /updated upstream content/, 'tracked diff は従来どおり表示されること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース5: 実行前から dirty だったスコープ外ファイルの内容だけの上書きを、' +
  '内容ハッシュ比較で検出する（PR #412 P1 の回帰）', () => {
  const ctx = setupRepo('content-overwrite-dirty')
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（fail-closed）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(combined, /スコープ外/, 'スコープ外検出のエラーメッセージが出ること')
        assert.match(
          combined,
          /other-skill\/NOTES\.md/,
          '内容だけ上書きされたスコープ外ファイルのパスが列挙されること' +
            '（ステータス文字列・パスは前後で不変のため、これは内容ハッシュ比較でのみ検出できる）',
        )
        return true
      },
    )

    // スコープ内（skills-lock.json / .agents/skills/<name>/）はリバートされ clean
    const lockDiff = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff, '', 'skills-lock.json はリバートされ clean であること')
    const treeDiff = sh(
      `git status --porcelain -- ".agents/skills/${SKILL_NAME}/"`,
      ctx.repoDir,
    ).trim()
    assert.equal(treeDiff, '', '.agents/skills/<name>/ はリバートされ clean であること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース7: 実行前から dirty だったスコープ外ファイルのパーミッションのみの変更を、' +
  '状態シグネチャ比較で検出する（PR #412 第3巡 P1 の回帰）', () => {
  const ctx = setupRepo('mode-change-dirty')
  const outOfScopePath = join(ctx.repoDir, ...OUT_OF_SCOPE_FILE.split('/'))
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（fail-closed）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(combined, /スコープ外/, 'スコープ外検出のエラーメッセージが出ること')
        assert.match(
          combined,
          /other-skill\/NOTES\.md/,
          'パーミッションのみ変更されたスコープ外ファイルのパスが列挙されること' +
            '（ステータス文字列・パス・内容は前後で不変のため、これは状態シグネチャ' +
            '（モード込み）比較でのみ検出できる）',
        )
        return true
      },
    )

    // スコープ内（skills-lock.json / .agents/skills/<name>/）はリバートされ clean
    const lockDiff = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff, '', 'skills-lock.json はリバートされ clean であること')
    const treeDiff = sh(
      `git status --porcelain -- ".agents/skills/${SKILL_NAME}/"`,
      ctx.repoDir,
    ).trim()
    assert.equal(treeDiff, '', '.agents/skills/<name>/ はリバートされ clean であること')

    // スコープ外ファイルは自動リバートせず、変更後のパーミッション（755）のまま残す
    const mode = statSync(outOfScopePath).mode & 0o777
    assert.equal(mode, 0o755, 'パーミッション変更が自動リバートされず残存すること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース6: npx が非ゼロ終了しても事後のスコープ外検査へ到達する' +
  '（PR #412 P1 の回帰。failure 経路でも fail-closed）', () => {
  const ctx = setupRepo('npx-failure-out-of-scope')
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（fail-closed）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(combined, /実行が失敗しました/, 'npx 失敗の警告が出ること')
        assert.match(
          combined,
          /スコープ外へも書き込んだ可能性/,
          'npx 失敗経路でも事後のスコープ外検査が実行され、残置が報告されること',
        )
        assert.match(
          combined,
          /other-skill\/NOTES\.md/,
          '失敗経路での残置パスが列挙されること',
        )
        return true
      },
    )

    // 失敗経路でもスコープ内（skills-lock.json / .agents/skills/<name>/）は
    // 即座にリバートされ clean であること
    const lockDiff = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff, '', 'skills-lock.json はリバートされ clean であること')
    const treeDiff = sh(
      `git status --porcelain -- ".agents/skills/${SKILL_NAME}/"`,
      ctx.repoDir,
    ).trim()
    assert.equal(treeDiff, '', '.agents/skills/<name>/ はリバートされ clean であること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

test('ケース8: npx が成功しても tee が失敗した場合、fail-closed で失敗扱いになる' +
  '（PR #412 CI 失敗指摘の P1 回帰。PIPESTATUS[1] 未確認による誤成功の防止）', () => {
  const ctx = setupRepo('tee-failure')
  try {
    assert.throws(
      () => runScript(ctx),
      (err) => {
        assert.notEqual(err.status, 0, '非ゼロ終了すること（fail-closed）')
        const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`
        assert.match(
          combined,
          /tee が失敗しました/,
          'tee 失敗を検知したエラーメッセージが出ること',
        )
        assert.match(
          combined,
          /実行が失敗しました/,
          'npx 自体は exit 0 でも、tee 失敗により NPX_STATUS が失敗へ強制されること',
        )
        assert.doesNotMatch(
          combined,
          /Invalid agents を認識せず/,
          '不完全な NPX_OUTPUT_FILE を前提にした no-op 判定を経由しないこと',
        )
        return true
      },
    )

    // tee 失敗経路でもスコープ内（skills-lock.json / .agents/skills/<name>/）は
    // 即座にリバートされ clean であること（npx 自体は scope-in へ書き込み済みのため、
    // リバートされずに残ると「tee は失敗したのに部分的に成功扱いのまま」になる）
    const lockDiff2 = sh(`git status --porcelain -- skills-lock.json`, ctx.repoDir).trim()
    assert.equal(lockDiff2, '', 'skills-lock.json はリバートされ clean であること')
    const treeDiff2 = sh(
      `git status --porcelain -- ".agents/skills/${SKILL_NAME}/"`,
      ctx.repoDir,
    ).trim()
    assert.equal(treeDiff2, '', '.agents/skills/<name>/ はリバートされ clean であること')
  } finally {
    rmSync(ctx.repoDir, { recursive: true, force: true })
    rmSync(ctx.binDir, { recursive: true, force: true })
  }
})

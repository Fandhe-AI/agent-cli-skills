// verify-ai-review-wrapper.sh の回帰テスト。
// 取得した ai-review wrapper を配置前に検査する関門（allow-list・fail-closed）の契約を固定する:
// 合格は実テンプレートの有効行と同形のみ、1 項目ずつの変異は不合格、使い方の誤りは exit 2、
// 出力にファイル内容を含めない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/verify-ai-review-wrapper.sh');

// Fandhe-AI/actions の ai-review.single.yml の有効行と同形
const GOOD = `# コメント
name: AI PR review

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]

concurrency:
  group: ai-review-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  codex:
    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest
    permissions:
      contents: read
      pull-requests: write
    with:
      provider: codex
      # runner: codex
      skip-branch-prefixes: chore/skills-update-,chore/submodule-update-
      post-feedback-runner: ubuntu-latest
`;

function verify(content, args) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-wrapper-'));
  try {
    const f = join(dir, 'ai-review.yml');
    if (content !== undefined) writeFileSync(f, content);
    const r = spawnSync('bash', [SCRIPT, ...(args ?? [f])], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('実テンプレート同形・コメント追加・空行追加は合格する', () => {
  assert.equal(verify(GOOD).code, 0);
  assert.equal(verify('# 追加コメント\n\n' + GOOD + '\n\n# 末尾\n').code, 0);
});

test('旧パスのカスタム prompt を保持する prompt-path 指定は合格する', () => {
  const s = GOOD.replace('      provider: codex\n', '      provider: codex\n      prompt-path: .github/ai-review/prompt.md\n');
  assert.notEqual(s, GOOD);
  assert.equal(verify(s).code, 0);
});

test('安全値の collaborators-only・block-priorities は合格する', () => {
  const s = GOOD.replace('      provider: codex\n', '      provider: codex\n      collaborators-only: true\n      block-priorities: P0,P1,P2\n');
  assert.equal(verify(s).code, 0);
  const q = GOOD.replace('      provider: codex\n', '      provider: codex\n      block-priorities: "P0, P1"\n');
  assert.equal(verify(q).code, 0);
});

const mutations = {
  'uses が @main': (s) => s.replace('@latest', '@main'),
  'uses が SHA': (s) => s.replace('@latest', '@8df2fb1bfff527731dcf74fa5cedc4bd6ee040af'),
  'uses が別 org': (s) => s.replace('Fandhe-AI/actions', 'evil/actions'),
  'uses がローカル参照': (s) => s.replace(/uses: .*/, 'uses: ./.github/workflows/x.yml'),
  'uses を with 配下へ移動': (s) => s.replace('    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n', '').replace('      provider: codex\n', '      uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n      provider: codex\n'),
  'with キーがジョブ直下': (s) => s.replace('      provider: codex\n', '').replace('    with:\n', '    provider: codex\n    with:\n'),
  'permissions がジョブ直下より深い': (s) => s.replace('    permissions:\n      contents: read\n      pull-requests: write\n', '    with:\n      permissions:\n        contents: read\n        pull-requests: write\n'),
  'on ブロック削除': (s) => s.replace(/on:\n  pull_request:\n    types: .*\n    branches: .*\n\n/, ''),
  'on はあるが pull_request なし': (s) => s.replace(/  pull_request:\n    types: .*\n    branches: .*\n/, ''),
  'uses が 2 件': (s) => s + '  second:\n    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n',
  'pull_request_target': (s) => s.replace('pull_request:', 'pull_request_target:'),
  'on 配下に pull_request_review': (s) => s.replace('on:\n', 'on:\n  pull_request_review:\n'),
  'on 配下に delete': (s) => s.replace('on:\n', 'on:\n  delete:\n'),
  'トップレベル permissions 欠落': (s) => s.replace('permissions:\n  contents: read\n\njobs:', 'jobs:'),
  'ジョブ側 permissions 欠落': (s) => s.replace('    permissions:\n      contents: read\n      pull-requests: write\n', ''),
  'ジョブ側 pull-requests: write 欠落': (s) => s.replace('      pull-requests: write\n', ''),
  'concurrency 配下の任意キー': (s) => s.replace('  cancel-in-progress: true\n', '  cancel-in-progress: true\n  extra: x\n'),
  'workflow_run 追加': (s) => s.replace('on:\n', 'on:\n  workflow_run:\n'),
  'run 追加': (s) => s + '    run: echo hi\n',
  'steps 追加': (s) => s + '    steps:\n',
  'env 追加': (s) => s + '    env:\n',
  'secrets: inherit': (s) => s + '    secrets: inherit\n',
  'contents: write': (s) => s.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
  'ジョブ側 id-token: write': (s) => s.replace('      pull-requests: write\n', '      pull-requests: write\n      id-token: write\n'),
  'permissions: write-all': (s) => s.replace('permissions:\n  contents: read', 'permissions: write-all'),
  '未知キー': (s) => s + '      unknown-key: x\n',
  'block scalar': (s) => s.replace('provider: codex', 'provider: |'),
  'CR を含む': (s) => s.replace('provider: codex', 'provider: codex\r'),
  'jobs: の再出現': (s) => s + '\njobs:\n',
  'トップレベル on の重複': (s) => s + '\non:\n  pull_request:\n',
  'トップレベル name の重複': (s) => s + '\nname: x\n',
  'トップレベル permissions の重複': (s) => s + '\npermissions:\n  contents: read\n',
  'ジョブ ID の重複': (s) => s + '  codex:\n',
  'ジョブ直下 with の重複': (s) => s + '    with:\n      provider: codex\n',
  'with キーの重複': (s) => s + '      provider: claude\n',
  'ジョブ側 permissions の重複': (s) => s + '    permissions:\n      contents: read\n      pull-requests: write\n',
  'permissions 内キーの重複': (s) => s.replace('      pull-requests: write\n', '      pull-requests: write\n      pull-requests: write\n'),
  'concurrency の重複': (s) => s + '\nconcurrency:\n  group: x\n',
  'collaborators-only: false': (s) => s.replace('      provider: codex\n', '      provider: codex\n      collaborators-only: false\n'),
  'collaborators-only が任意値': (s) => s.replace('      provider: codex\n', '      provider: codex\n      collaborators-only: maybe\n'),
  'block-priorities: P3': (s) => s.replace('      provider: codex\n', '      provider: codex\n      block-priorities: P3\n'),
  'block-priorities に P1 欠落': (s) => s.replace('      provider: codex\n', '      provider: codex\n      block-priorities: P0\n'),
  'block-priorities に P0 欠落': (s) => s.replace('      provider: codex\n', '      provider: codex\n      block-priorities: P1,P2\n'),
  'permissions の子キーが親+4 のインデント': (s) => s.replace('      contents: read\n      pull-requests: write\n', '      contents: read\n        pull-requests: write\n'),
  'permissions の子キーが親+1 のインデント': (s) => s.replace('      contents: read\n      pull-requests: write\n', '     contents: read\n     pull-requests: write\n'),
  'uses と permissions が別ジョブ': (s) => s.replace('    permissions:\n      contents: read\n      pull-requests: write\n', '') + '  other:\n    permissions:\n      contents: read\n      pull-requests: write\n',
  'types が closed のみ': (s) => s.replace('[opened, synchronize, reopened]', '[closed]'),
  'types に reopened 欠落': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize]'),
  'with 値にコマンド置換風の文字': (s) => s.replace('provider: codex', 'provider: codex; rm -rf /'),
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`不合格: ${name}`, () => {
    const r = verify(mutate(GOOD));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /NG/);
  });
}

test('不合格: 空ファイルと HTTP エラー JSON（uses 0 件）', () => {
  assert.equal(verify('').code, 1);
  assert.equal(verify('{"message":"Not Found","status":"404"}\n').code, 1);
});

test('使い方の誤りは exit 2', () => {
  assert.equal(verify(undefined, []).code, 2);
  assert.equal(verify(undefined, ['/nonexistent/path']).code, 2);
  assert.equal(verify(undefined, [tmpdir()]).code, 2);
});

test('出力にファイル内容（注入文字列）を含めない', () => {
  const secret = 'SECRET_MARKER_12345';
  const r = verify(GOOD + `      ${secret}: x\n`);
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(secret));
});

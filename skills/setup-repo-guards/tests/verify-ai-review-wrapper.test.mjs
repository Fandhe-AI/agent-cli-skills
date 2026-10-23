// verify-ai-review-wrapper.sh の回帰テスト。
// 取得した ai-review wrapper を配置前に検査する関門（allow-list・fail-closed）の契約を固定する:
// 合格は実テンプレートの有効行と同形のみ、1 項目ずつの変異は不合格、使い方の誤りは exit 2、
// 出力にファイル内容を含めない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

// with 配下に追加した 1 行を GOOD の provider 行の直後へ差し込む
const withLine = (line) => GOOD.replace('      provider: codex\n', `      provider: codex\n      ${line}\n`);
const replaceTypes = (v) => GOOD.replace('[opened, synchronize, reopened]', v);
const replaceBranches = (v) => GOOD.replace('[main]', v);

const accepted = {
  'types の空白なし [opened,synchronize,reopened]': replaceTypes('[opened,synchronize,reopened]'),
  'types の括弧内外の余分な空白': replaceTypes('[ opened ,  synchronize , reopened ]'),
  'types に ready_for_review を追加': replaceTypes('[opened, synchronize, reopened, ready_for_review]'),
  'types の順序違い': replaceTypes('[reopened, opened, synchronize]'),
  'branches が複数': replaceBranches('[main, release/1.0]'),
  'branches の空白なし': replaceBranches('[main,develop]'),
  'provider が引用符付き': withLine('model: x').replace('provider: codex', 'provider: "codex"'),
  'provider が claude': GOOD.replace('provider: codex', 'provider: claude'),
  'runner': withLine('runner: self-hosted'),
  'model': withLine('model: gpt-6-astra'),
  'model が vars 式': withLine('model: ${{ vars.GROK_MODEL }}'),
  'api-base-url': withLine('api-base-url: http://llm-node:8000/v1'),
  'api-base-url が vars 式': withLine('api-base-url: ${{ vars.LOCAL_LLM_BASE_URL }}'),
  'reasoning-effort': withLine('reasoning-effort: medium'),
  'reviewer-id': withLine('reviewer-id: local-llm'),
  'reviewer-name が空白区切り': withLine('reviewer-name: Local LLM'),
  'max-diff-bytes': withLine('max-diff-bytes: 600000'),
  'allowed-bot-actors が引用符付き': withLine('allowed-bot-actors: "dependabot[bot],renovate[bot]"'),
  'allowed-bot-actors が空白付き': withLine('allowed-bot-actors: "dependabot[bot], renovate[bot]"'),
  'collaborators-only が引用符付き true': withLine('collaborators-only: "true"'),
  'block-priorities が引用符なしで空白なし': withLine('block-priorities: P0,P1'),
  'skip-branch-prefixes が引用符付きでカンマ後に空白': GOOD.replace('chore/skills-update-,chore/submodule-update-', '"chore/a-, chore/b-"'),
  'skip-branch-prefixes が 1 件': GOOD.replace('chore/skills-update-,chore/submodule-update-', 'chore/skills-update-'),
  'concurrency group が別の式': GOOD.replace('ai-review-${{ github.ref }}', 'ai-review-${{ github.workflow }}-${{ github.ref }}'),
  'secrets の API_KEY': GOOD + '    secrets:\n      API_KEY: ${{ secrets.OPENAI_API_KEY }}\n',
};
for (const [name, content] of Object.entries(accepted)) {
  test(`合格: ${name}`, () => {
    const r = verify(content);
    assert.equal(r.code, 0, r.out);
  });
}

test('合格: リポジトリ自身の .github/workflows/ai-review.yml', (t) => {
  const f = resolve(dirname(SCRIPT), '../../../.github/workflows/ai-review.yml');
  if (!existsSync(f)) return t.skip('このリポジトリ外（vendoring 先）では存在しない');
  const r = spawnSync('bash', [SCRIPT, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
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
  'block-priorities の内部空白 P 1': (s) => s.replace('      provider: codex\n', "      provider: codex\n      block-priorities: 'P0,P 1'\n"),
  'block-priorities の空要素': (s) => s.replace('      provider: codex\n', '      provider: codex\n      block-priorities: P0,,P1\n'),
  'block-priorities に P0 欠落': (s) => s.replace('      provider: codex\n', '      provider: codex\n      block-priorities: P1,P2\n'),
  'permissions の子キーが親+4 のインデント': (s) => s.replace('      contents: read\n      pull-requests: write\n', '      contents: read\n        pull-requests: write\n'),
  'permissions の子キーが親+1 のインデント': (s) => s.replace('      contents: read\n      pull-requests: write\n', '     contents: read\n     pull-requests: write\n'),
  'uses と permissions が別ジョブ': (s) => s.replace('    permissions:\n      contents: read\n      pull-requests: write\n', '') + '  other:\n    permissions:\n      contents: read\n      pull-requests: write\n',
  'types が closed のみ': (s) => s.replace('[opened, synchronize, reopened]', '[closed]'),
  'types に reopened 欠落': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize]'),
  // --- 値の文法（PR #707 の指摘 vpkrK・vpt-U と、同類型の退行防止） ---
  'provider の値に ": "（codex: broken）': (s) => s.replace('provider: codex', 'provider: codex: broken'),
  'provider の値の末尾が ":"': (s) => s.replace('provider: codex', 'provider: codex:'),
  'provider が許可外の値': (s) => s.replace('provider: codex', 'provider: evil'),
  'provider の引用符が閉じていない': (s) => s.replace('provider: codex', 'provider: "codex'),
  'provider の引用符が食い違う': (s) => s.replace('provider: codex', 'provider: "codex\''),
  'provider の値に行末コメント': (s) => s.replace('provider: codex', 'provider: codex # x'),
  'provider がフロー mapping': (s) => s.replace('provider: codex', 'provider: {a: b}'),
  'provider がフロー配列': (s) => s.replace('provider: codex', 'provider: [codex]'),
  'provider が anchor': (s) => s.replace('provider: codex', 'provider: &a codex'),
  'provider が alias': (s) => s.replace('provider: codex', 'provider: *a'),
  'provider が tag': (s) => s.replace('provider: codex', 'provider: !!str codex'),
  'provider の値が空': (s) => s.replace('provider: codex', 'provider:'),
  'provider の値が引用符の中に ": "': (s) => s.replace('provider: codex', 'provider: "codex: broken"'),
  'provider の値が内部空白': (s) => s.replace('provider: codex', 'provider: co dex'),
  'with のキーの後にコロンの直後が空白でない': (s) => s.replace('provider: codex', 'provider:codex'),
  'with のキーとコロンの間に空白': (s) => s.replace('provider: codex', 'provider : codex'),
  'api-base-url に ": "': (s) => s.replace('      provider: codex\n', '      provider: codex\n      api-base-url: http://x: y\n'),
  'api-base-url がスキーム違い': (s) => s.replace('      provider: codex\n', '      provider: codex\n      api-base-url: file:///etc/passwd\n'),
  'api-base-url が式（secrets）': (s) => s.replace('      provider: codex\n', '      provider: codex\n      api-base-url: ${{ secrets.X }}\n'),
  'model の値に ": "': (s) => s.replace('      provider: codex\n', '      provider: codex\n      model: a: b\n'),
  'model が式を含む混在値': (s) => s.replace('      provider: codex\n', '      provider: codex\n      model: x-${{ vars.M }}\n'),
  'runner が JSON 配列（許可リスト外）': (s) => s.replace('      provider: codex\n', "      provider: codex\n      runner: '[\"self-hosted\",\"x\"]'\n"),
  'reviewer-name に ": "': (s) => s.replace('      provider: codex\n', '      provider: codex\n      reviewer-name: a: b\n'),
  'max-diff-bytes が数字以外': (s) => s.replace('      provider: codex\n', '      provider: codex\n      max-diff-bytes: 12a\n'),
  'prompt-path が親ディレクトリを辿る': (s) => s.replace('      provider: codex\n', '      provider: codex\n      prompt-path: ../../etc/passwd\n'),
  'prompt-path が絶対パス': (s) => s.replace('      provider: codex\n', '      provider: codex\n      prompt-path: /etc/passwd\n'),
  'skip-branch-prefixes の引用符なしでカンマ後に空白': (s) => s.replace('chore/skills-update-,chore/submodule-update-', 'a, b'),
  'skip-branch-prefixes の要素内部の空白': (s) => s.replace('chore/skills-update-,chore/submodule-update-', '"a b,c"'),
  'skip-branch-prefixes の空要素': (s) => s.replace('chore/skills-update-,chore/submodule-update-', 'a,,b'),
  'skip-branch-prefixes に ": "': (s) => s.replace('chore/skills-update-,chore/submodule-update-', 'a: b'),
  'allowed-bot-actors に許可外の記号': (s) => s.replace('      provider: codex\n', '      provider: codex\n      allowed-bot-actors: "a;b"\n'),
  'allowed-bot-actors の要素内部の空白': (s) => s.replace('      provider: codex\n', '      provider: codex\n      allowed-bot-actors: "dependabot[bot],ren ovate[bot]"\n'),
  'collaborators-only が引用符付き false': (s) => s.replace('      provider: codex\n', '      provider: codex\n      collaborators-only: "false"\n'),
  'types の要素内部の空白（synchron ize）': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchron ize, reopened]'),
  'types の要素内部の空白（op ened）': (s) => s.replace('[opened, synchronize, reopened]', '[op ened, synchronize, reopened]'),
  'types が空配列': (s) => s.replace('[opened, synchronize, reopened]', '[]'),
  'types の末尾カンマ': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize, reopened,]'),
  'types の空要素': (s) => s.replace('[opened, synchronize, reopened]', '[opened,, synchronize, reopened]'),
  'types の重複要素': (s) => s.replace('[opened, synchronize, reopened]', '[opened, opened, synchronize, reopened]'),
  'types に許可外のイベント': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize, reopened, closed]'),
  'types の要素が引用符付き': (s) => s.replace('[opened, synchronize, reopened]', '["opened", synchronize, reopened]'),
  'types の要素が部分一致（openedx）': (s) => s.replace('[opened, synchronize, reopened]', '[openedx, synchronize, reopened]'),
  'types が配列でない': (s) => s.replace('[opened, synchronize, reopened]', 'opened'),
  'types の閉じ括弧なし': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize, reopened'),
  'types の括弧が入れ子': (s) => s.replace('[opened, synchronize, reopened]', '[[opened], synchronize, reopened]'),
  'types の後ろに余計な文字': (s) => s.replace('[opened, synchronize, reopened]', '[opened, synchronize, reopened] x'),
  'types が pull_request の外': (s) => s.replace('  pull_request:\n    types: [opened, synchronize, reopened]\n', '    types: [opened, synchronize, reopened]\n  pull_request:\n'),
  'branches の要素内部の空白': (s) => s.replace('[main]', '[ma in]'),
  'branches の空要素': (s) => s.replace('[main]', '[main,,dev]'),
  'branches の末尾カンマ': (s) => s.replace('[main]', '[main,]'),
  'branches が空配列': (s) => s.replace('[main]', '[]'),
  'branches に ": "': (s) => s.replace('[main]', '[a: b]'),
  'branches の要素が alias 始まり': (s) => s.replace('[main]', '[*main]'),
  'branches の重複': (s) => s.replace('[main]', '[main, main]'),
  'name の値に ": "': (s) => s.replace('name: AI PR review', 'name: AI: PR review'),
  'name の値に行末コメント': (s) => s.replace('name: AI PR review', 'name: AI PR review # x'),
  'name が anchor': (s) => s.replace('name: AI PR review', 'name: &a AI'),
  'name が flow mapping': (s) => s.replace('name: AI PR review', 'name: {a: b}'),
  'concurrency group の値に ": "': (s) => s.replace('group: ai-review-${{ github.ref }}', 'group: a: b'),
  'concurrency group が許可外の式': (s) => s.replace('github.ref', 'secrets.X'),
  'concurrency group の式が閉じていない': (s) => s.replace('${{ github.ref }}', '${{ github.ref'),
  'ジョブ ID が数字始まり': (s) => s.replace('  codex:\n', '  1codex:\n'),
  'ジョブの name に ": "': (s) => s.replace('    uses:', '    name: a: b\n    uses:'),
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

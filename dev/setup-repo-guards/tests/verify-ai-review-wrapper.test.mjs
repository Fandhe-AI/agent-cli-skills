// verify-ai-review-wrapper.sh の回帰テスト。
// 取得した ai-review wrapper を配置前に検査する関門（allow-list・fail-closed）の契約を固定する:
// 合格は実テンプレートの有効行と同形のみ、1 項目ずつの変異は不合格、使い方の誤りは exit 2、
// 出力にファイル内容を含めない。YAML が文字列以外に解決する引用符なしの値（null・真偽値・数値・日付）は
// 文字列の位置ごとに拒否し、引用符で囲んだ値は文字列として許可する（Issue #710）。
// すべての検査を、実行できる bash（macOS の /bin/bash 3.2 と PATH の bash 5 等）で走らせ、結果が一致することを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync } from 'node:fs';
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

// 実行できる bash の一覧（実体パスで重複除去）。macOS では /bin/bash（3.2）と Homebrew の bash が両方あり得る。
// PATH の bash（既定 bash）も含める。どれも見つからなければ PATH の bash を 1 つだけ返す。
// このスキルは単独で vendoring されるため、他スキルのテストヘルパーは import せず複製する
function availableBashes() {
  const seen = new Set();
  const out = [];
  const onPath = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  for (const p of ['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', onPath]) {
    if (!p || !existsSync(p)) continue;
    const real = realpathSync(p);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  if (out.length === 0) out.push('bash');
  return out;
}
const BASHES = availableBashes();

function runBash(bash, file, args) {
  const r = spawnSync(bash, [SCRIPT, ...(args ?? [file])], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

// 全 bash で実行し、終了コードと出力が一致することを確かめて返す（bash のバージョン差による判定のずれを検出する）
function verify(content, args, bashes = BASHES) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-wrapper-'));
  try {
    const f = join(dir, 'ai-review.yml');
    if (content !== undefined) writeFileSync(f, content);
    const results = bashes.map((b) => ({ bash: b, ...runBash(b, f, args) }));
    const [first, ...rest] = results;
    for (const r of rest) {
      assert.ok(r.code === first.code && r.out === first.out,
        `bash 間で結果が食い違う: ${first.bash} は exit ${first.code}、${r.bash} は exit ${r.code}\n--- ${first.bash}\n${first.out}\n--- ${r.bash}\n${r.out}`);
    }
    return { code: first.code, out: first.out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('検査を走らせる bash の一覧（macOS では /bin/bash 3.2 と PATH の bash を含む）', (t) => {
  t.diagnostic(BASHES.map((b) => `${b}: ${spawnSync(b, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]}`).join(' / '));
  assert.ok(BASHES.length >= 1);
});

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
  // --- 型付き scalar に見えるが文字列になる値（#710）。引用符で囲んだ値は文字列、予約語・数値の一部だけを含む語も文字列 ---
  'runner が引用符付き "yes"': withLine('runner: "yes"'),
  'runner が引用符付き \'null\'': withLine("runner: 'null'"),
  'model が引用符付き "1.5"': withLine('model: "1.5"'),
  'reviewer-id が引用符付き "123"': withLine('reviewer-id: "123"'),
  'reviewer-name が引用符付き "true"': withLine('reviewer-name: "true"'),
  'skip-branch-prefixes が引用符付き "2024"': GOOD.replace('chore/skills-update-,chore/submodule-update-', '"2024"'),
  'skip-branch-prefixes が数字を含む列挙': GOOD.replace('chore/skills-update-,chore/submodule-update-', '2024,2025'),
  'concurrency group が引用符付き "1.5"': GOOD.replace('ai-review-${{ github.ref }}', '"1.5"'),
  'トップの name が引用符付き "null"': GOOD.replace('name: AI PR review', 'name: "null"'),
  'ジョブの name が引用符付き "123"': GOOD.replace('    uses:', '    name: "123"\n    uses:'),
  'ジョブの name が数字を含む語': GOOD.replace('    uses:', '    name: Review 2\n    uses:'),
  'トップの name が予約語で始まる語': GOOD.replace('name: AI PR review', 'name: Yes we review'),
  'branches が数字・予約語を含む語': replaceBranches('[1.0.0, v1, 2026-10-24-hotfix, nullable, on-call, yesterday, 0x1G, 1e3x]'),
  'ジョブ ID が予約語で始まる語': GOOD.replace('  codex:\n', '  nullable:\n'),
  'max-diff-bytes と collaborators-only は意図した数値・真偽値': withLine('max-diff-bytes: 600000').replace('      provider: codex\n', '      provider: codex\n      collaborators-only: true\n'),
};
for (const [name, content] of Object.entries(accepted)) {
  test(`合格: ${name}`, () => {
    const r = verify(content);
    assert.equal(r.code, 0, r.out);
  });
}

test('合格: リポジトリ自身の .github/workflows/ai-review.yml（全 bash）', (t) => {
  const f = resolve(dirname(SCRIPT), '../../../.github/workflows/ai-review.yml');
  if (!existsSync(f)) return t.skip('このリポジトリ外（vendoring 先）では存在しない');
  const r = verify(undefined, [f]);
  assert.equal(r.code, 0, r.out);
});

// Fandhe-AI/actions@8df2fb1bfff527731dcf74fa5cedc4bd6ee040af の ai-review/templates/ai-review.single.yml をそのまま保存した fixture。
// 最小化した GOOD ではなく、上流の実物（コメント・他 provider の例を含む）が合格することを固定する
// （上流テンプレートが更新されたら、固定取得の SHA とともにこの fixture も差し替える）
test('合格: 上流テンプレート ai-review.single.yml（Fandhe-AI/actions@8df2fb1b の実物・全 bash）', () => {
  const f = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/ai-review.single@8df2fb1b.yml');
  assert.ok(readFileSync(f, 'utf8').includes('uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest'));
  const r = verify(undefined, [f]);
  assert.equal(r.code, 0, r.out);
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
  // --- Issue #710: concurrency は任意だが、あるなら group が必須（PR #707 thread PRRT_kwDORuXFg86vr1N1） ---
  'concurrency の group 欠落（cancel-in-progress のみ）': (s) => s.replace('  group: ai-review-${{ github.ref }}\n', ''),
  'concurrency が空（子なし）': (s) => s.replace('  group: ai-review-${{ github.ref }}\n  cancel-in-progress: true\n', ''),
  'concurrency の group の値が空': (s) => s.replace('group: ai-review-${{ github.ref }}', 'group:'),
  // --- Issue #710: branches の要素が YAML で文字列以外になる値（PR #707 thread PRRT_kwDORuXFg86vr1N_） ---
  'branches が [null]': (s) => s.replace('[main]', '[null]'),
  'branches が [true]': (s) => s.replace('[main]', '[true]'),
  'branches の 2 要素目が [main, null]': (s) => s.replace('[main]', '[main, null]'),
  'branches の要素が引用符付き（["1.0"]。引用符つき要素は未対応で拒否のまま）': (s) => s.replace('[main]', '["1.0"]'),
  'ジョブ ID が null:': (s) => s.replace('  codex:\n', '  null:\n'),
  'ジョブ ID が true:': (s) => s.replace('  codex:\n', '  true:\n'),
  'ジョブ ID が yes:': (s) => s.replace('  codex:\n', '  yes:\n'),
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
  // --- ジョブ構造（PR #707 の指摘 vrYoY: 設定行はジョブ ID より後・ジョブ内でのみ受理する） ---
  'ジョブ ID の行を末尾へ移動': (s) => s.replace('  codex:\n', '') + '  codex:\n',
  'ジョブ ID の行をジョブ設定の途中へ移動': (s) => s.replace('  codex:\n', '').replace('    with:\n', '  codex:\n    with:\n'),
  'ジョブ ID より前の permissions': (s) => s.replace('  codex:\n', '    permissions:\n      contents: read\n      pull-requests: write\n  codex:\n').replace(/(  codex:\n    uses: .*\n)    permissions:\n      contents: read\n      pull-requests: write\n/, '$1'),
  'ジョブ ID より前の uses': (s) => s.replace('  codex:\n    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n', '    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n  codex:\n'),
  'ジョブ ID より前の with': (s) => s.replace('  codex:\n', '    with:\n      provider: codex\n  codex:\n'),
  'ジョブが空': (s) => s.replace(/  codex:\n[\s\S]*$/, '  codex:\n'),
  'jobs が空': (s) => s.replace(/jobs:\n[\s\S]*$/, 'jobs:\n'),
  'uses が 2 ジョブに分散（uses のないジョブ）': (s) => s.replace('    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n', '') + '  second:\n    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n',
  'ジョブが uses を持たない（権限だけ）': (s) => s.replace('    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n', ''),
  'jobs より前のジョブキー': (s) => s.replace('jobs:\n', '    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\njobs:\n').replace('  codex:\n    uses: Fandhe-AI/actions/.github/workflows/ai-review.yml@latest\n', '  codex:\n'),
  'トップレベル name の後ろにジョブのキー': (s) => s.replace('name: AI PR review\n', '') + 'name: tail\n    permissions:\n      contents: read\n',
  'トップレベル name の後ろに on の子': (s) => s.replace('name: AI PR review\n', 'name: AI PR review\n  pull_request:\n'),
  'jobs の後ろのトップレベル name の下にジョブ ID': (s) => s.replace('name: AI PR review\n', '') + 'name: tail\n  other:\n',
  'on より前に pull_request': (s) => s.replace('on:\n', '  pull_request:\non:\n'),
  'concurrency の外の group': (s) => s.replace('concurrency:\n', '').replace('  group:', '    group:'),
  'with 値にコマンド置換風の文字': (s) => s.replace('provider: codex', 'provider: codex; rm -rf /'),
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`不合格: ${name}`, () => {
    const r = verify(mutate(GOOD));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /NG/);
  });
}

// --- Issue #710: 型付き scalar × 文字列の位置 の直積 ---
// 引用符なしで書くと YAML が文字列以外（null・真偽値・数値・日付）に解決する値を、文字列でなければならない
// すべての位置で拒否する。位置ごとに個別の指摘が連鎖していた（branches → group → name → with → ジョブ ID）ため、
// 1 つの表で位置と値の全組を固定する。YAML 1.1 と 1.2 の和集合を拒否し、どちらかの方言で文字列にならない値は残さない。
// 値の一覧（拒否する形の表）は scripts/verify-ai-review-wrapper.sh の is_typed_plain_scalar のコメントと対応させる
const TYPED_SCALARS = [
  'null', 'Null', 'NULL', '~',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'yes', 'Yes', 'YES', 'no', 'No', 'NO', 'on', 'On', 'ON', 'off', 'Off', 'OFF', 'y', 'Y', 'n', 'N',
  '1', '0', '+1', '-1', '1_000', '0777', '0x1F', '0o17', '0b101',
  '1.5', '.5', '1.', '-1.5', '1.5e3', '1e3', '1E+3', '.inf', '.Inf', '.INF', '-.inf', '.nan', '.NaN', '.NAN',
  '2026-10-24', '2026-1-5',
  '=', '<<',
];
const TYPED_SLOTS = {
  'branches の要素': (v) => replaceBranches(`[${v}]`),
  'branches の 2 要素目': (v) => replaceBranches(`[main, ${v}]`),
  'concurrency.group': (v) => GOOD.replace('ai-review-${{ github.ref }}', v),
  'トップの name': (v) => GOOD.replace('name: AI PR review', `name: ${v}`),
  'ジョブの name': (v) => GOOD.replace('    uses:', `    name: ${v}\n    uses:`),
  'ジョブ ID': (v) => GOOD.replace('  codex:\n', `  ${v}:\n`),
  'with.runner': (v) => withLine(`runner: ${v}`),
  'with.model': (v) => withLine(`model: ${v}`),
  'with.api-base-url': (v) => withLine(`api-base-url: ${v}`),
  'with.reasoning-effort': (v) => withLine(`reasoning-effort: ${v}`),
  'with.post-feedback-runner': (v) => GOOD.replace('post-feedback-runner: ubuntu-latest', `post-feedback-runner: ${v}`),
  'with.reviewer-id': (v) => withLine(`reviewer-id: ${v}`),
  'with.reviewer-name': (v) => withLine(`reviewer-name: ${v}`),
  'with.prompt-path': (v) => withLine(`prompt-path: ${v}`),
  'with.skip-branch-prefixes': (v) => GOOD.replace('chore/skills-update-,chore/submodule-update-', v),
  'with.allowed-bot-actors': (v) => withLine(`allowed-bot-actors: ${v}`),
  'with.block-priorities': (v) => withLine(`block-priorities: ${v}`),
};
// 各位置の文法だけなら受理される値（型の拒否が効いていることを理由メッセージで確かめる対象）。
// 先頭が英数字・_ ・. で、英数字・_ ・. ・- だけの値。ジョブ ID は先頭が英字・_ の値のみ
const GRAMMAR_SAFE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const NO_DOT_SLOTS = new Set(['with.allowed-bot-actors', 'with.block-priorities']);
for (const [slot, build] of Object.entries(TYPED_SLOTS)) {
  test(`不合格: ${slot} に型付き scalar（${TYPED_SCALARS.length} 値）`, () => {
    const failures = [];
    for (const v of TYPED_SCALARS) {
      const r = verify(build(v));
      if (r.code !== 1 || !/NG/.test(r.out)) failures.push(`${v} → exit ${r.code}`);
      // 位置の文法だけなら通る値は、型の拒否の理由で落ちていること（文法の偶然に頼らない）
      const reasonable = GRAMMAR_SAFE.test(v) && !(slot === 'ジョブ ID' && !/^[A-Za-z_]/.test(v)) && !(NO_DOT_SLOTS.has(slot) && v.includes('.'));
      if (reasonable && slot !== 'with.block-priorities' && !/文字列以外/.test(r.out)) failures.push(`${v} → 型の拒否ではない理由で不合格: ${r.out.trim().split('\n')[0]}`);
    }
    assert.deepEqual(failures, []);
  });
}

// 引用符で囲めば文字列なので、同じ値でも合格する対照（引用符を受け付けない branches の要素は含めない）
const QUOTABLE_SLOTS = ['concurrency.group', 'トップの name', 'ジョブの name', 'with.runner', 'with.model', 'with.reasoning-effort', 'with.reviewer-id', 'with.reviewer-name', 'with.prompt-path', 'with.skip-branch-prefixes'];
for (const slot of QUOTABLE_SLOTS) {
  test(`合格（対照）: ${slot} は同じ値でも引用符で囲めば文字列`, () => {
    const safe = TYPED_SCALARS.filter((v) => GRAMMAR_SAFE.test(v) && !(slot === 'with.prompt-path' && v.includes('..')));
    const failures = [];
    for (const v of safe) {
      for (const q of ['"', "'"]) {
        const r = verify(TYPED_SLOTS[slot](`${q}${v}${q}`));
        if (r.code !== 0) failures.push(`${q}${v}${q} → exit ${r.code}: ${r.out.trim().split('\n')[0]}`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test('不合格: concurrency に group が無い形は子の構成によらず拒否し、concurrency 自体の省略は合格する', () => {
  const noConc = GOOD.replace(/concurrency:\n  group: .*\n  cancel-in-progress: true\n\n/, '');
  assert.notEqual(noConc, GOOD);
  assert.equal(verify(noConc).code, 0);   // concurrency は任意
  for (const body of ['', '  cancel-in-progress: true\n', '  cancel-in-progress: false\n']) {
    const r = verify(GOOD.replace(/concurrency:\n  group: .*\n  cancel-in-progress: true\n/, `concurrency:\n${body}`));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /concurrency/);
  }
  const grouped = verify(GOOD.replace('  cancel-in-progress: true\n', ''));
  assert.equal(grouped.code, 0, grouped.out);   // group だけなら合格
});

// 行ベースの検査器と YAML の意味のずれを機械的に確かめる安全網。GOOD の構造行を移動・削除・複製・
// インデント変更した変異のうち、検査器が合格にしたものを実際の YAML パーサで読み、
// jobs.<id>.uses と permissions などが期待の構造であることを確認する。
// パーサ（python3 + PyYAML）が無い環境では skip する（新規依存は追加しない）。
const PYTHON_CHECK = `
import json, sys
try:
    import yaml
except Exception:
    print(json.dumps({"skip": "PyYAML なし"})); sys.exit(0)
EXPECTED = "Fandhe-AI/actions/.github/workflows/ai-review.yml@latest"
WITH_KEYS = {"provider","runner","model","reasoning-effort","block-priorities","collaborators-only","allowed-bot-actors","skip-branch-prefixes","post-feedback-runner","max-diff-bytes","reviewer-id","reviewer-name","api-base-url","prompt-path"}
def check(text):
    try:
        doc = yaml.safe_load(text)
    except Exception as e:
        return "YAML として読めない: " + str(e)[:80]
    if not isinstance(doc, dict): return "トップがマップでない"
    on = doc.get("on", doc.get(True))
    extra = set(map(str, doc.keys())) - {"name","on","True","concurrency","permissions","jobs"}
    if extra: return "トップレベルに余計なキー: %s" % sorted(extra)
    if doc.get("permissions") != {"contents": "read"}: return "トップレベル permissions が期待と違う"
    if not isinstance(on, dict) or set(on.keys()) != {"pull_request"}: return "on が pull_request のみでない"
    pr = on["pull_request"] if on["pull_request"] is not None else {}   # 子なし = 既定のイベント
    if not isinstance(pr, dict): return "pull_request がマップでない"
    if set(pr.keys()) - {"types","branches"}: return "pull_request の子が余計"
    if "types" in pr:
        if not isinstance(pr["types"], list) or not {"opened","synchronize","reopened"} <= set(pr["types"]) or len(set(pr["types"])) != len(pr["types"]): return "types が期待と違う"
    if "branches" in pr:
        if not isinstance(pr["branches"], list) or not all(isinstance(b, str) and b and " " not in b for b in pr["branches"]): return "branches が期待と違う"
    if "name" in doc and not isinstance(doc["name"], str): return "name が文字列でない"
    if "concurrency" in doc:
        c = doc["concurrency"]
        if not isinstance(c, dict) or not isinstance(c.get("group"), str) or not c["group"]: return "concurrency に文字列の group がない"
        if set(c.keys()) - {"group","cancel-in-progress"}: return "concurrency に余計なキー"
        if "cancel-in-progress" in c and not isinstance(c["cancel-in-progress"], bool): return "cancel-in-progress が真偽値でない"
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict) or len(jobs) != 1: return "jobs がちょうど 1 件でない"
    (jid, job), = jobs.items()
    if not isinstance(jid, str): return "ジョブ ID が文字列でない"
    if not isinstance(job, dict): return "ジョブがマップでない"
    if "name" in job and not isinstance(job["name"], str): return "ジョブの name が文字列でない"
    if job.get("uses") != EXPECTED: return "jobs.<id>.uses が期待と違う"
    if job.get("permissions") != {"contents": "read", "pull-requests": "write"}: return "ジョブ permissions が期待と違う"
    if set(job.keys()) - {"name","uses","permissions","with","secrets"}: return "ジョブに余計なキー"
    w = job.get("with", {})
    if not isinstance(w, dict) or set(w.keys()) - WITH_KEYS: return "with が期待と違う"
    for k, v in w.items():
        if k == "max-diff-bytes":
            if not (isinstance(v, int) and not isinstance(v, bool)) and not (isinstance(v, str) and v.isdigit()): return "max-diff-bytes が数値でない"
        elif k == "collaborators-only":
            if v is not True and v != "true": return "collaborators-only が true でない"
        elif not isinstance(v, str): return "with.%s が文字列でない" % k
    if w.get("provider") not in ("codex","claude","gemini","grok","openai-compatible"): return "provider が期待と違う"
    if "collaborators-only" in w and w["collaborators-only"] is not True and w["collaborators-only"] != "true": return "collaborators-only が true でない"
    return None
cases = json.load(sys.stdin)
print(json.dumps([check(c) for c in cases]))
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function structuralMutants(base, count, seed = 705) {
  const rnd = mulberry32(seed);
  const lines = base.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = [];
  const pick = () => Math.floor(rnd() * lines.length);
  for (let i = 0; i < count; i++) {
    const ls = lines.slice();
    const steps = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < steps; k++) {
      const a = Math.min(pick(), ls.length - 1);
      const kind = Math.floor(rnd() * 4);
      if (kind === 0) { // 移動
        const [l] = ls.splice(a, 1);
        ls.splice(Math.floor(rnd() * (ls.length + 1)), 0, l);
      } else if (kind === 1) { // 削除
        ls.splice(a, 1);
      } else if (kind === 2) { // 複製
        ls.splice(Math.floor(rnd() * (ls.length + 1)), 0, ls[a]);
      } else { // インデント変更
        ls[a] = rnd() < 0.5 ? '  ' + ls[a] : ls[a].replace(/^ {1,2}/, '');
      }
      if (ls.length === 0) ls.push('');
    }
    out.push(ls.join('\n') + '\n');
  }
  return out;
}

test('検査器が合格にした変異は YAML パーサで読んでも期待の構造になる（行ベースと YAML の意味のずれの検出）', (t) => {
  const probe = spawnSync('python3', ['-I', '-c', PYTHON_CHECK], { input: '[]', encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('python3 を実行できない');
  const probed = JSON.parse(probe.stdout);
  if (!Array.isArray(probed)) return t.skip(probed.skip);

  // 値の変異（型付き scalar を各位置へ・引用符つきの対照）は、ここで検査器が合格にしたものを oracle が
  // str として読み直す。構造だけを動かす変異では [null] のような値の型の穴を一度も見られなかった（#710）
  const ORACLE_VALUES = ['null', '~', 'true', 'yes', 'on', '1', '1_000', '0x1F', '0o17', '1.5', '.inf', '2026-10-24'];   // 全値は上の直積テストで検査済み。ここは oracle の代表値
  const valueMutants = [];
  for (const build of Object.values(TYPED_SLOTS)) {
    for (const v of ORACLE_VALUES) valueMutants.push(build(v), build(`"${v}"`));
  }
  const candidates = [GOOD, ...Object.values(accepted), ...valueMutants, ...structuralMutants(GOOD, Number(process.env.FUZZ_COUNT ?? 400), Number(process.env.FUZZ_SEED ?? 705))];
  // 候補ごとに bash を順繰りに 1 つだけ使う（全 bash での一致は他のテストが固定済み。ここは件数が多く時間がかかるため）
  const passed = candidates.filter((c, i) => verify(c, undefined, [BASHES[i % BASHES.length]]).code === 0);
  // 値の変異のうち合格したものは引用符つきの文字列だけで、型付き scalar の素の値は 1 件も残らない
  assert.ok(passed.some((c) => /: "(yes|null|1\.5)"/.test(c)), '引用符つきの対照が合格に含まれない');
  assert.ok(passed.length >= Object.keys(accepted).length + 1, '合格ケースが少なすぎる');
  const r = spawnSync('python3', ['-I', '-c', PYTHON_CHECK], { input: JSON.stringify(passed), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const results = JSON.parse(r.stdout);
  const bad = results.map((m, i) => (m === null ? null : `${m}\n---\n${passed[i]}`)).filter(Boolean);
  assert.equal(bad.length, 0, `検査器が合格にしたが YAML の意味が期待と違う ${bad.length} 件:\n${bad.slice(0, 3).join('\n=====\n')}`);
});

test('oracle 自体の自己テスト: 型付き scalar と group 欠落を YAML パーサの側でも検出できる（oracle が素通しになっていない）', (t) => {
  const probe = spawnSync('python3', ['-I', '-c', PYTHON_CHECK], { input: '[]', encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('python3 を実行できない');
  if (!Array.isArray(JSON.parse(probe.stdout))) return t.skip('PyYAML なし');
  const bad = [
    replaceBranches('[null]'), replaceBranches('[true]'), replaceBranches('[2026-10-24]'),
    GOOD.replace('  group: ai-review-${{ github.ref }}\n', ''),
    GOOD.replace('name: AI PR review', 'name: on'),
    GOOD.replace('ai-review-${{ github.ref }}', '1.5'),
    GOOD.replace('  codex:\n', '  null:\n'),
    withLine('runner: yes'),
    withLine('model: null'),
  ];
  const r = spawnSync('python3', ['-I', '-c', PYTHON_CHECK], { input: JSON.stringify([GOOD, ...bad]), encoding: 'utf8' });
  const res = JSON.parse(r.stdout);
  assert.equal(res[0], null, `GOOD は oracle も合格: ${res[0]}`);
  res.slice(1).forEach((m, i) => assert.notEqual(m, null, `oracle が見逃した: ${bad[i]}`));
});

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

// 共通資産の複製ずれ検査。各スキルは自己完結のため資産を複製して持つ。
// このファイルは 4 スキル（init/update × codex/opencode）でバイト同一に保つ。
// 兄弟スキルが無い導入先では、比較相手が無い検査を skip する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const selfDir = dirname(testsDir);
const skillsDir = dirname(selfDir);
const self = basename(selfDir);

const ALL = ['init-codex', 'update-codex', 'init-opencode', 'update-opencode'];
const COMMON = ['hooks/agent-guard.sh', 'agents-md-block.md', 'scripts/agents-md-block.sh'];
const TEST_FILE = 'tests/asset-sync.test.mjs';
// init / update の対。update 側にだけ存在してよいファイル（許可リスト）
const PAIRS = { 'update-codex': 'init-codex', 'update-opencode': 'init-opencode', 'init-codex': 'update-codex', 'init-opencode': 'update-opencode' };
const UPDATE_ONLY = {
  'update-codex': ['scripts/codex-hooks-merge.sh'],
  'update-opencode': ['scripts/opencode-config-merge.mjs'],
};

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const exec = (p) => (statSync(p).mode & 0o111) !== 0;
const sibling = (name) => join(skillsDir, name);
const present = (name) => name !== self && existsSync(sibling(name));

function walk(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

for (const other of ALL.filter((n) => n !== self)) {
  test(`共通資産が ${other} と同一（内容・実行ビット）`, (t) => {
    if (!present(other)) return t.skip(`兄弟スキル ${other} が無い導入先のため比較できない`);
    for (const f of COMMON) {
      const a = join(selfDir, 'assets', f);
      const b = join(sibling(other), 'assets', f);
      assert.ok(existsSync(a), `${self}/assets/${f} が無い`);
      assert.ok(existsSync(b), `${other}/assets/${f} が無い`);
      assert.equal(sha(a), sha(b), `${f}: ${self} と ${other} の内容がずれている`);
      if (f.endsWith('.sh')) assert.equal(exec(a), exec(b), `${f}: 実行ビットがずれている`);
    }
  });

  test(`${TEST_FILE} が ${other} とバイト同一`, (t) => {
    if (!present(other)) return t.skip(`兄弟スキル ${other} が無い導入先のため比較できない`);
    const b = join(sibling(other), TEST_FILE);
    assert.ok(existsSync(b), `${other}/${TEST_FILE} が無い`);
    assert.equal(sha(join(selfDir, TEST_FILE)), sha(b));
  });
}

test('init / update の対で assets 全体が同一（許可リスト除く）', (t) => {
  const pair = PAIRS[self];
  if (!present(pair)) return t.skip(`対のスキル ${pair} が無い導入先のため比較できない`);
  const updateName = self.startsWith('update-') ? self : pair;
  const allow = new Set(UPDATE_ONLY[updateName]);
  const aRoot = join(selfDir, 'assets');
  const bRoot = join(sibling(pair), 'assets');
  const a = walk(aRoot).filter((f) => !allow.has(f));
  const b = walk(bRoot).filter((f) => !allow.has(f));
  assert.deepEqual(a.sort(), b.sort(), '許可リスト外で片方にだけあるファイルがある');
  for (const f of a) {
    assert.equal(sha(join(aRoot, f)), sha(join(bRoot, f)), `${f}: 内容がずれている`);
    assert.equal(exec(join(aRoot, f)), exec(join(bRoot, f)), `${f}: 実行ビットがずれている`);
  }
  // 許可リストは update 側にだけ存在する
  const initRoot = self.startsWith('init-') ? aRoot : bRoot;
  const updRoot = self.startsWith('init-') ? bRoot : aRoot;
  for (const f of allow) {
    assert.ok(existsSync(join(updRoot, f)), `許可リストの ${f} が update 側に無い`);
    assert.ok(!existsSync(join(initRoot, f)), `許可リストの ${f} が init 側にもある`);
  }
});

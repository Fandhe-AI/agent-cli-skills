// Step 3 / Step 4 の付け替え（reassign-sub-issue.sh）の確認を、通常の確認として固定する回帰テスト。
//
// Step 2 は起動時の「確認なしで進めてよい」で確認を省けるとする一方、Step 3 は安全上の確認の
// 定型文（「確認なしで」等は返答にならない）を置いていたため、非対話で Step 2 の承認を得ていても
// Step 3 で止まっていた。付け替えは DELETE → POST で元に戻せる操作で、規約
// （.claude/rules/tool-neutral-skills.md）は安全上の確認の対象に当たらないとしている。
// Step 3 / Step 4 に安全上の確認の定型文が無く、Step 2 の承認に結びついていることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md');
const text = readFileSync(SKILL_MD, 'utf8');

// `### Step N:` から次の `### ` 見出し（または `## `）までを取り出す
function section(n) {
  const start = text.indexOf(`### Step ${n}:`);
  assert.ok(start >= 0, `Step ${n} の見出しが無い`);
  const rest = text.slice(start + 1);
  const m = rest.match(/\n#{2,3} /);
  return m ? rest.slice(0, m.index + 1) : rest;
}

const SAFETY_PHRASES = [
  /返答にならない/,
  /この会話の中でユーザーの明示の返答を得るまで/,
  /起動時の指示に含まれる「確認なしで」/,
];

for (const n of [3, 4]) {
  test(`Step ${n} に安全上の確認の定型文が無い`, () => {
    const s = section(n);
    for (const re of SAFETY_PHRASES) assert.doesNotMatch(s, re);
  });
}

test('Step 3 は Step 2 で承認された計画配列の対象にだけ実行し、非対話で承認が無ければ止める', () => {
  const s = section(3);
  assert.match(s, /Step 2 で承認された計画配列/);
  assert.match(s, /起動時の指示に確認を省くことの明示/);
  assert.match(s, /このスキルを起動する依頼そのものは承認にならない/);
  assert.match(s, /非対話実行）では実行せずに/);
});

test('Step 2 は起動時の明示で確認を省ける通常の確認のまま', () => {
  const s = section(2);
  assert.match(s, /起動時の指示にこの確認を省くことの明示/);
  assert.doesNotMatch(s, /返答にならない/);
});

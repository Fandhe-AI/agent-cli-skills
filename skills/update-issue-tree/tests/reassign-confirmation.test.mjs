// Step 3 / Step 4 の付け替え（reassign-sub-issue.sh）の明示承認を固定する回帰テスト。
//
// 付け替えは DELETE → POST で元に戻せるが、変更前は対象を提示した後のユーザーの明示の返答が
// 必須だった。起動時の包括的な指示（「確認なしで進めてよい」）だけで非対話に実行できるようにすると、
// ベースの AGENTS.md が禁じる承認境界の後退になる（PR #812 の codex 指摘）。
// そのため付け替えの承認は Step 2 / Step 3 とも、起動時の「確認なしで」では省けない形で書く。
// Step 2 は付け替え以外の確認だけ起動時の省略を認め、Step 3 の定型文と矛盾しないことを確かめる。
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

test('Step 3 は「確認なしで」が返答にならない明示承認の定型文を持つ', () => {
  const s = section(3);
  assert.match(s, /この会話の中でユーザーの明示の返答を得るまで `scripts\/reassign-sub-issue\.sh`/);
  assert.match(s, /起動時の指示に含まれる「確認なしで」「そのまま進めて」等は、この確認の返答にならない/);
  assert.match(s, /返答を得られない環境（非対話実行）では実行せずに/);
});

test('Step 3 に起動時の確認省略の明示を承認とみなす文が無い', () => {
  const s = section(3);
  assert.doesNotMatch(s, /起動時の指示に確認を省くことの明示/);
  assert.doesNotMatch(s, /省くことの明示（例: 「確認なしで進めてよい」）が含まれている場合/);
  assert.doesNotMatch(s, /通常の確認で足りる/);
});

test('Step 4 に付け替えの承認を緩める文が無い', () => {
  const s = section(4);
  assert.doesNotMatch(s, /起動時の指示に確認を省くことの明示/);
});

test('Step 2 は付け替えの確認を起動時の「確認なしで」で省けないと明記する', () => {
  const s = section(2);
  assert.match(s, /付け替え（`REASSIGN_PLAN` \/ `ORPHAN_PLAN` の対象/);
  assert.match(s, /起動時の「確認なしで」では省けない/);
  assert.match(s, /対象を提示した後のユーザーの明示の返答に限り承認とみなす/);
});

test('Step 2 の起動時の確認省略は付け替え以外の変更に限られる', () => {
  const s = section(2);
  assert.match(s, /付け替え以外の変更（ラベル同期・新 Phase 親の新設・分解）の確認は省いて続行してよい/);
  // 省略を認める文が付け替えを含む包括的な形に戻っていないこと
  assert.doesNotMatch(s, /に限り、確認を省いて続行してよい/);
});

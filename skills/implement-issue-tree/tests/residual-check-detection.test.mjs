// implement-issue-tree の「cancel された run の残存 check」検知コマンド (A) の決定的回帰テスト
// （Issue #338）。
//
// 背景: (A) は `gh api ... | sort | uniq -d | wc -l` のパイプ直結だった。`gh api` は HTTP エラーの
// JSON 本文も stdout に出す仕様のため（.claude/rules/ruleset-policy.md 手順 B と同じ罠）、
// 認証失敗・404・レート制限時にエラー 1 行がそのまま uniq -d に流れ込み、ヒットせず出力が `0` に
// なる。旧「1 以上なら重複あり」の読み方定義に従うと、この `0` が「重複なし」と誤読され、この節が
// 防ごうとしている誤診断（CI 由来を除外して PR 差分を疑う）そのものを誘発していた。
// 修正は (A) を「取得 → 終了コード検証 → 出力形式検証 → 件数算出」の 4 段へ作り直し、出力語彙を
// `UNDETERMINED` / `dup=<D> bad=<B>` の 2 形に固定し、対処側にゼロ件分岐を追加した。
//
// 追加修正（Issue #338 P1 の codex-review 指摘）: 旧 (A) は `bad` を cancelled / failure /
// timed_out の 3 conclusion のみに限定していたため、`pending`（未完了）・`action_required`・
// `startup_failure`・`stale` を含む重複が bad=0 になり「正常な重複（再実行）」と誤診断され得た。
// 特に success + pending の重複では、その pending 自体が mergeStateStatus=BLOCKED の直接原因
// たり得るのに、別原因の調査へ進んでしまう。`success` 以外を正常扱いしない分類へ変更し、
// `pending`（未完了）は bad とは別の `pend` フィールドで検知して「待機・判定不能」に倒し、
// それ以外の非 success conclusion は `bad` として通常の CI 失敗経路へ倒す。出力語彙は
// `dup=<D> bad=<B> pend=<P>` の 3 値へ拡張した。
//
// 3 群構成:
//   群 A（SKILL.md 記述の固定）: UNDETERMINED・dup=・bad=・ゼロ件分岐・終了コード検証の記載を固定。
//   群 B（旧文言の再発防止）: 「1 以上なら重複あり」が 0 回であることを固定。
//   群 C（集計ロジックの決定性）: SKILL.md から (A) の awk 式を抽出し、fixture 行を流して
//     dup/bad の算出が決定的であることを実測する（doc と挙動の乖離を同時に防ぐ）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const SKILL_MD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'SKILL.md',
)
const skillMd = readFileSync(SKILL_MD_PATH, 'utf8')

// ---------------------------------------------------------------------------
// 群 A: SKILL.md 記述の固定
// ---------------------------------------------------------------------------
test('群A: (A) は取得失敗・空出力を UNDETERMINED として扱う', () => {
  assert.match(skillMd, /UNDETERMINED/)
})

test('群A: (A) は dup=<D> bad=<B> 形式で重複件数と結論内訳を返す', () => {
  assert.match(skillMd, /dup=<D> bad=<B>/)
  assert.match(skillMd, /dup=%d bad=%d/)
})

test('群A: (A) は gh api の終了コードを検証してから件数を返す', () => {
  assert.match(skillMd, /終了コードを見る/)
  assert.match(skillMd, /status=\$\?/)
})

test('群A: 「対処」は cancelled run 0 件の分岐を明記する', () => {
  assert.match(skillMd, /cancelled run が \*\*0 件\*\*/)
})

test('群A: 「対処」は判定不能（前提 0）を rerun せず blocked として扱う', () => {
  assert.match(skillMd, /前提 0（判定不能の扱い）/)
  assert.match(skillMd, /判定不能を「重複なし」と読んで CI 由来を除外してはならない/)
})

test('群A: 「対処」は conclusion（bad）を含めて重複を判定する', () => {
  assert.match(skillMd, /D >= 1 かつ P = 0 かつ B >= 1/)
  assert.match(skillMd, /D >= 1 かつ B = 0 かつ P = 0/)
})

test('群A: 「対処」は pending（未完了）を含む重複を正常な再実行と断定しない（Issue #338 P1）', () => {
  assert.match(skillMd, /D >= 1 かつ P >= 1/)
  assert.match(skillMd, /pending.*BLOCKED.*直接原因/)
})

test('群A: (A)/(B) の権限境界（チェック名をエージェントの文脈へ出さない）は維持される', () => {
  assert.match(skillMd, /チェック名・エラー本文は出力に現れない/)
})

test('群A: 「よくある失敗」表に判定不能の誤読パターンが追加されている', () => {
  assert.match(skillMd, /\(A\) の出力を検証せず `0` を「重複なし」と読む/)
})

// ---------------------------------------------------------------------------
// 群 B: 旧文言の再発防止
// ---------------------------------------------------------------------------
test('群B: 旧文言「1 以上なら重複あり」は 0 回（判定不能を重複なしと誤読させない）', () => {
  const matches = skillMd.match(/1 以上なら重複あり/g)
  assert.equal(matches, null)
})

// ---------------------------------------------------------------------------
// 群 C: 集計ロジックの決定性（SKILL.md から (A) の awk 式を抽出して実行）
// ---------------------------------------------------------------------------
function extractAwkProgram(markdown) {
  const startMarker = "awk -F'\\t' '"
  const startIdx = markdown.indexOf(startMarker)
  if (startIdx < 0) {
    throw new Error('(A) の awk 起動部が SKILL.md に見つからない（記述形式が変わった可能性がある）')
  }
  const bodyStart = startIdx + startMarker.length
  const endMarker = "}'\nfi"
  const endIdx = markdown.indexOf(endMarker, bodyStart)
  if (endIdx < 0) {
    throw new Error('(A) の awk 終端（}\'\\nfi）が SKILL.md に見つからない')
  }
  return markdown.slice(bodyStart, endIdx + 1)
}

const awkProgram = extractAwkProgram(skillMd)

function runAwk(rows) {
  return execFileSync('awk', ['-F', '\t', awkProgram], {
    input: rows,
    encoding: 'utf8',
  }).trim()
}

test('群C: 重複あり・cancelled 混在で dup=2 bad=1 pend=0 を返す', () => {
  // ci/build は cancelled + success（重複かつ結論に cancelled を含む）。
  // ci/test は success x2（重複だが結論は健全）。ci/lint は単発（重複なし）。
  const rows = [
    'ci/build\tcancelled',
    'ci/build\tsuccess',
    'ci/test\tsuccess',
    'ci/test\tsuccess',
    'ci/lint\tsuccess',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=2 bad=1 pend=0')
})

test('群C: 重複はあるが結論が健全な場合は dup=1 bad=0 pend=0 を返す（前提1の D>=1 B=0 P=0 分岐に対応）', () => {
  const rows = [
    'ci/build\tsuccess',
    'ci/build\tsuccess',
    'ci/lint\tsuccess',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=1 bad=0 pend=0')
})

test('群C: 重複なしの場合は dup=0 bad=0 pend=0 を返す', () => {
  const rows = [
    'ci/build\tsuccess',
    'ci/lint\tsuccess',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=0 bad=0 pend=0')
})

test('群C: pending（conclusion 欠落）は bad に数えず pend に数える（Issue #338 P1: 旧実装は bad=0 のみで見分けがつかなかった）', () => {
  const rows = [
    'ci/build\tpending',
    'ci/build\tpending',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=1 bad=0 pend=1')
})

test('群C: success + pending の重複は「正常な重複」に丸め込まず pend=1 で検知する（Issue #338 P1 の指摘シナリオそのもの）', () => {
  const rows = [
    'ci/build\tsuccess',
    'ci/build\tpending',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=1 bad=0 pend=1')
})

test('群C: action_required / startup_failure / stale は bad に数える（success 以外を正常扱いしない）', () => {
  const rows = [
    'ci/build\taction_required',
    'ci/build\tsuccess',
    'ci/deploy\tstartup_failure',
    'ci/deploy\tsuccess',
    'ci/lint\tstale',
    'ci/lint\tsuccess',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=3 bad=3 pend=0')
})

test('群C: 同一重複名に bad な結論と pending が両方含まれる場合は B・P 双方が立つ', () => {
  const rows = [
    'ci/build\tfailure',
    'ci/build\tpending',
    'ci/build\tsuccess',
    '',
  ].join('\n')
  assert.equal(runAwk(rows), 'dup=1 bad=1 pend=1')
})

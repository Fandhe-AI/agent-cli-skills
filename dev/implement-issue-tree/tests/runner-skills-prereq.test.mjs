// ランナーの起動時検査「生成物が名指しするスキルの存在」（runner/lib/skills-prereq.mjs）の検査。
//   - REQUIRED_SKILLS が src（implement-issue-tree.src.js）の名指しと両方向で一致し続けること
//   - src に出るスキル名がすべて「必須」か「言及のみ」に分類されていること（新しい名指しを黙って見落とさない）
//   - 必須スキルが init-codex の導入対象に入っていること（入っていないと配布先が起動できない）
//   - ツールごとの探索先（codex は .agents/skills だけ）で判定すること
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackTmp } from './lib/tmp-track.mjs'
import { REQUIRED_SKILLS, SKILL_DIRS, missingSkills, missingSkillsMessage } from '../../../skills/implement-issue-tree/runner/lib/skills-prereq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const SRC = readFileSync(join(REPO, 'dev', 'implement-issue-tree', 'scripts', 'implement-issue-tree.src.js'), 'utf8')
const SKILLS = join(REPO, 'skills')
// src に名前が出るが手順を委ねない言及（「create-plan / implement-issue の計画粒度」）。必須にしない理由は lib の冒頭
const MENTION_ONLY = ['create-plan', 'implement-issue']

const uniqSorted = (xs) => [...new Set(xs)].sort()

/** src が名指しするスキル名（「<name> スキルに従」と「skills/<name>/SKILL.md」の 2 形）。 */
function namedInSrc(src) {
  const follow = [...src.matchAll(/(?<![A-Za-z0-9_-])([a-z][a-z0-9-]*) スキルに従/g)].map((m) => m[1])
  const file = [...src.matchAll(/(?<![A-Za-z0-9_.-])skills\/([a-z][a-z0-9-]*)\/SKILL\.md/g)].map((m) => m[1])
  return { follow, file, all: uniqSorted([...follow, ...file]) }
}

test('REQUIRED_SKILLS は src の名指し（スキルに従・skills/<name>/SKILL.md）と両方向で一致する', () => {
  const { follow, all } = namedInSrc(SRC)
  // 「スキルに従」の出現はすべて名前を伴う形で拾えている（`create-commit` のような別の書き方を見落とさない）
  assert.equal(follow.length, [...SRC.matchAll(/スキルに従/g)].length, '名前を拾えない「スキルに従」がある')
  assert.ok(all.includes('create-commit') && all.includes('implement-review'))
  assert.deepEqual([...REQUIRED_SKILLS], all)
  assert.deepEqual([...REQUIRED_SKILLS], uniqSorted(REQUIRED_SKILLS), '一覧は名前順で重複なし')
})

test('src に出るスキル名は、必須か言及のみのどちらかに分類されている', () => {
  const names = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const mentioned = names.filter((n) => n !== 'implement-issue-tree' && new RegExp(`(?<![A-Za-z0-9_-])${n}(?![A-Za-z0-9_-])`).test(SRC))
  assert.deepEqual(uniqSorted(mentioned), uniqSorted([...REQUIRED_SKILLS, ...MENTION_ONLY]))
  for (const n of REQUIRED_SKILLS) assert.ok(names.includes(n), `${n} はこのリポジトリのスキル`)
})

test('必須スキルは init-codex の導入対象に入っている', () => {
  for (const tool of ['codex']) {
    const md = readFileSync(join(SKILLS, `init-${tool}`, 'SKILL.md'), 'utf8')
    const m = /for s in ([a-z0-9 \\\n-]+?); do/.exec(md)
    assert.ok(m, `init-${tool} の導入ループ`)
    const list = m[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean)
    for (const n of REQUIRED_SKILLS) assert.ok(list.includes(n), `init-${tool} が ${n} を導入する`)
  }
})

const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-skills-'))))
let seq = 0
/** dir（メイン worktree からの相対）に names の SKILL.md を置いたメイン worktree を作る。 */
function repoWith(entries) {
  const d = join(root, `r${++seq}`)
  mkdirSync(d)
  for (const [dir, names] of entries) {
    for (const n of names) {
      mkdirSync(join(d, dir, n), { recursive: true })
      writeFileSync(join(d, dir, n, 'SKILL.md'), `---\nname: ${n}\n---\n`)
    }
  }
  return d
}

test('missingSkills: codex は .agents/skills だけを探す', () => {
  assert.deepEqual(SKILL_DIRS.codex, ['.agents/skills'])
  assert.deepEqual(missingSkills({ tool: 'codex', root: repoWith([['.agents/skills', REQUIRED_SKILLS]]) }), [])
  assert.deepEqual(missingSkills({ tool: 'codex', root: repoWith([]) }), [...REQUIRED_SKILLS])
  // Codex は .claude/skills・.opencode/skills を読まない
  assert.deepEqual(missingSkills({ tool: 'codex', root: repoWith([['.claude/skills', REQUIRED_SKILLS], ['.opencode/skills', REQUIRED_SKILLS]]) }), [...REQUIRED_SKILLS])
  // 一部だけ無ければその名前だけを返す
  assert.deepEqual(missingSkills({ tool: 'codex', root: repoWith([['.agents/skills', ['create-commit']]]) }), ['create-pr', 'implement-review'])
})

test('missingSkills: ディレクトリだけで SKILL.md が無ければ不在・未知のツールは例外', () => {
  const d = repoWith([])
  for (const n of REQUIRED_SKILLS) mkdirSync(join(d, '.agents', 'skills', n, 'SKILL.md'), { recursive: true })
  assert.deepEqual(missingSkills({ tool: 'codex', root: d }), [...REQUIRED_SKILLS], 'SKILL.md がディレクトリなら不在')
  assert.throws(() => missingSkills({ tool: 'claude', root: d }), /未知のツール/)
  assert.throws(() => missingSkills({ tool: 'opencode', root: d }), /未知のツール/)
  // isFile を注入できる（判定の入口は 1 つ）
  const seen = []
  assert.deepEqual(missingSkills({ tool: 'codex', root: '/r', isFile: (p) => { seen.push(p); return true } }), [])
  assert.deepEqual(seen, REQUIRED_SKILLS.map((n) => `/r/.agents/skills/${n}/SKILL.md`))
})

test('missingSkillsMessage: 足りない名前・探索先・導入の案内を含む', () => {
  const m = missingSkillsMessage('codex', ['create-commit', 'implement-review'])
  assert.match(m, /create-commit, implement-review/)
  assert.match(m, /\.agents\/skills\/<name>\/SKILL\.md/)
  assert.match(m, /init-codex/)
  assert.match(m, /コミット/)
})

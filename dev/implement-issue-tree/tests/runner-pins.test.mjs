// 内容の固定（skills/implement-issue-tree/runner/lib/pins.mjs。PR #851 の P0）の回帰テスト。
// 固定する一覧（ツール別）・固定値（sha256 / 無ければ null / 読めなければ食い違う値）・照合の理由・mergePins の優先を確かめる。
// 段ごとの照合と止め方は runner-agent-host.test.mjs、run.mjs からの受け渡しは runner-run.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackTmp } from './lib/tmp-track.mjs'
import { checkPins, launcherPinPaths, mergePins, pinFiles, pinPathsFor } from '../../../skills/implement-issue-tree/runner/lib/pins.mjs'

const root = trackTmp(realpathSync(mkdtempSync(join(tmpdir(), 'iit-runner-pins-'))))
const sha = (s) => createHash('sha256').update(s).digest('hex')

test('pinPathsFor: launcher と signed-output.sh・ガード（明示の guardScript）・codex は hook・opencode は plugin の全ファイル', () => {
  const skillDir = join(root, 'skill')
  const adaptersDir = join(root, 'adapters')
  mkdirSync(join(adaptersDir, 'opencode-plugin', 'sub'), { recursive: true })
  writeFileSync(join(adaptersDir, 'opencode-plugin', 'index.js'), 'x')
  writeFileSync(join(adaptersDir, 'opencode-plugin', 'sub', 'a.js'), 'y')
  const guard = join(root, 'agent-guard.sh')
  writeFileSync(guard, 'exit 0\n')
  const base = { skillDir, mainRoot: join(root, 'main'), toolConfig: { guardScript: guard }, adaptersDir }
  assert.deepEqual(launcherPinPaths(skillDir), [join(skillDir, 'scripts', 'run-verified.sh'), join(skillDir, 'scripts', 'lib', 'signed-output.sh')])
  assert.deepEqual(pinPathsFor({ tool: 'codex', ...base }), [...launcherPinPaths(skillDir), guard, join(adaptersDir, 'codex-hook.sh')])
  assert.deepEqual(pinPathsFor({ tool: 'opencode', ...base }), [...launcherPinPaths(skillDir), guard, join(adaptersDir, 'opencode-plugin', 'index.js'), join(adaptersDir, 'opencode-plugin', 'sub', 'a.js')])
  // ガードが見つからなければ（アダプタの start が prereq で止める）一覧に入れない
  assert.deepEqual(pinPathsFor({ tool: 'codex', ...base, toolConfig: { guardScript: join(root, 'none.sh') } }), [...launcherPinPaths(skillDir), join(adaptersDir, 'codex-hook.sh')])
})

test('pinFiles / checkPins: 内容の書き換え・削除・後から現れた・読めない・通常ファイルでない を食い違いにする', () => {
  const d = join(root, 'files')
  mkdirSync(d)
  const f = join(d, 'f.sh')
  const late = join(d, 'late.sh')
  const dir = join(d, 'dir')
  mkdirSync(dir)
  writeFileSync(f, 'a')
  const pins = pinFiles([f, late, dir])
  assert.deepEqual(pins.map((p) => p.sha256), [sha('a'), null, '!not-file'])
  assert.ok(Object.isFrozen(pins) && Object.isFrozen(pins[0]))
  assert.match(checkPins(pins), /dir を起動時に読めなかった（not-file）/)
  const two = pinFiles([f, late])
  assert.equal(checkPins(two), '')
  writeFileSync(f, 'b')
  assert.match(checkPins(two), /f\.sh が起動時と違う（内容が変わった）/)
  writeFileSync(f, 'a')
  writeFileSync(late, 'x')
  assert.match(checkPins(two), /late\.sh が起動時と違う（起動時は無かった）/)
  rmSync(late)
  rmSync(f)
  assert.match(checkPins(two), /f\.sh が起動時と違う（消えた）/)
  if (process.getuid?.() !== 0) {
    const r = join(d, 'r.sh')
    writeFileSync(r, 'r')
    const p = pinFiles([r])
    chmodSync(r, 0o000)
    assert.match(checkPins(p), /r\.sh が起動時と違う（内容が変わった）/)
    chmodSync(r, 0o644)
  }
})

test('mergePins: 同じパスは先（より早い時点）の固定を残す', () => {
  const a = [{ path: '/x', sha256: 'old' }]
  const b = [{ path: '/x', sha256: 'new' }, { path: '/y', sha256: null }]
  assert.deepEqual(mergePins(a, b), [{ path: '/x', sha256: 'old' }, { path: '/y', sha256: null }])
})

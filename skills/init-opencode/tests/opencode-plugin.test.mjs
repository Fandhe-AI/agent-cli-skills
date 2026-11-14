// assets/opencode/plugins/agent-guard/index.js（OpenCode の permission.evaluate hook から
// 共通ガード agent-guard.sh を呼ぶ主判定の層）の回帰テスト。
//
// 対象リポジトリでの配置（.opencode/plugins/agent-guard/index.js と .opencode/hooks/agent-guard.sh）を
// 一時ディレクトリへ再現し、plugin を動的 import して ctx をスタブで渡す。実際の OpenCode は起動しない。
// event の形は OpenCode v2.2.7 の実測値（permission.evaluate の shell event）を書き写したもの。
// ctx.session.get の呼び方（{ sessionID }）と返り値（子だけ parentID を持つ）も同じ実測による。
//
// 実時間の待機は行わない。ガードの時間切れ（5 秒）は実際には待たず、signal で kill された場合
// （spawnSync の r.signal が立つ点は時間切れと同じ分岐）で代用する。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const PLUGIN_SRC = join(ASSETS, 'opencode', 'plugins', 'agent-guard', 'index.js')
const GUARD_SRC = join(ASSETS, 'hooks', 'agent-guard.sh')

const tmpDirs = []
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

// 対象リポジトリの配置を再現する。guard: 'real' = 実物 / 'none' = 置かない / 文字列 = その内容のスクリプト
function layout(guard = 'real') {
  const root = mkdtempSync(join(tmpdir(), 'oc-plugin-'))
  tmpDirs.push(root)
  const pluginDir = join(root, '.opencode', 'plugins', 'agent-guard')
  const hooksDir = join(root, '.opencode', 'hooks')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(hooksDir, { recursive: true })
  copyFileSync(PLUGIN_SRC, join(pluginDir, 'index.js'))
  if (guard === 'real') copyFileSync(GUARD_SRC, join(hooksDir, 'agent-guard.sh'))
  else if (guard !== 'none') writeFileSync(join(hooksDir, 'agent-guard.sh'), guard)
  chmodSync(hooksDir, 0o755)
  return pathToFileURL(join(pluginDir, 'index.js')).href
}

// session: 'main' = parentID なし / 'sub' = parentID あり / 'throw' = get が例外 / 'null' = 返り値なし
function sessionStub(kind, calls) {
  return {
    async get(arg) {
      calls.push(arg)
      if (kind === 'throw') throw new Error('session not found')
      if (kind === 'null') return null
      if (kind === 'sub') return { id: arg.sessionID, parentID: 'ses_parent0000000000000000', agent: 'general', title: 'child' }
      return { id: arg.sessionID, title: 'main' }
    },
  }
}

async function load(url, kind) {
  const mod = await import(url)
  const hooks = {}
  const calls = []
  const ctx = {
    permission: { hook: async (name, fn) => { hooks[name] = fn } },
    session: sessionStub(kind, calls),
  }
  await mod.default.setup(ctx)
  return { evaluate: hooks.evaluate, calls, plugin: mod.default }
}

// permission.evaluate の実測 event（action: "shell"・effect の初期値は "allow"）。
const shellEvent = (resources, over = {}) => ({
  sessionID: 'ses_e280051f5ffeh0WJo8cybpQmES',
  agent: 'build',
  action: 'shell',
  resources,
  source: { type: 'tool', messageID: 'msg_1d7ffb1ec001Fe6bto8oQRs8NB', id: 'chatcmpl-tool-928b196f536aef0a' },
  effect: 'allow',
  ...over,
})

async function run(url, kind, event) {
  const { evaluate, calls } = await load(url, kind)
  await evaluate(event)
  return { event, calls }
}

describe('agent-guard plugin', { concurrency: true }, () => {
  it('素の object export で id が agent-guard', async () => {
    const { plugin } = await load(layout(), 'main')
    assert.equal(plugin.id, 'agent-guard')
    assert.equal(typeof plugin.setup, 'function')
  })

  it('main の git push origin main --force は deny（順序違いも止める）', async () => {
    const { event } = await run(layout(), 'main', shellEvent(['git push origin main --force']))
    assert.equal(event.effect, 'deny')
    assert.match(event.message, /force/)
  })

  it('main の git status は effect 不変（message も付けない）', async () => {
    const { event } = await run(layout(), 'main', shellEvent(['git status']))
    assert.equal(event.effect, 'allow')
    assert.equal(event.message, undefined)
  })

  it('main の git commit --no-verify は deny', async () => {
    const { event } = await run(layout(), 'main', shellEvent(['git commit --no-verify -m x']))
    assert.equal(event.effect, 'deny')
    assert.match(event.message, /no-verify/)
  })

  it('サブエージェントの gh pr merge は deny・main では不変', async () => {
    const url = layout()
    const sub = await run(url, 'sub', shellEvent(['gh pr merge 1 --squash']))
    assert.equal(sub.event.effect, 'deny')
    assert.match(sub.event.message, /サブエージェント/)
    const main = await run(url, 'main', shellEvent(['gh pr merge 1 --squash']))
    assert.equal(main.event.effect, 'allow')
  })

  it('session.get は { sessionID } で呼ぶ', async () => {
    const { calls } = await run(layout(), 'sub', shellEvent(['git status']))
    assert.deepEqual(calls, [{ sessionID: 'ses_e280051f5ffeh0WJo8cybpQmES' }])
  })

  it('複合 resources（2 要素のうち 1 つが deny）は deny', async () => {
    const e1 = await run(layout(), 'main', shellEvent(['git status', 'git push --force origin main']))
    assert.equal(e1.event.effect, 'deny')
    const e2 = await run(layout(), 'main', shellEvent(['git push -f origin main', 'git status']))
    assert.equal(e2.event.effect, 'deny')
  })

  it('複合 resources が全部 allow なら不変', async () => {
    const { event } = await run(layout(), 'main', shellEvent(['git status', 'git diff']))
    assert.equal(event.effect, 'allow')
  })

  it('session.get が throw → subagent null 扱い（マージ系 deny・force push 以外の通常コマンドは不変）', async () => {
    const url = layout()
    const merge = await run(url, 'throw', shellEvent(['gh pr merge 1 --squash']))
    assert.equal(merge.event.effect, 'deny')
    const normal = await run(url, 'throw', shellEvent(['git status']))
    assert.equal(normal.event.effect, 'allow')
  })

  it('session.get が null を返す場合も subagent null 扱い', async () => {
    const { event } = await run(layout(), 'null', shellEvent(['gh pr merge 1 --squash']))
    assert.equal(event.effect, 'deny')
  })

  it('shell 以外の action は触らない（session.get も呼ばない）', async () => {
    const e = shellEvent(['git push origin main --force'], { action: 'read' })
    const { event, calls } = await run(layout(), 'main', e)
    assert.equal(event.effect, 'allow')
    assert.equal(event.message, undefined)
    assert.equal(calls.length, 0)
    const sub = await run(layout(), 'main', shellEvent(['general'], { action: 'subagent' }))
    assert.equal(sub.event.effect, 'allow')
  })

  it('すでに deny の event は effect も message も変えない', async () => {
    const e = shellEvent(['git push --force origin main'], { effect: 'deny', message: '他の hook の理由' })
    const { event } = await run(layout(), 'main', e)
    assert.equal(event.effect, 'deny')
    assert.equal(event.message, '他の hook の理由')
  })

  it('deny の message に入力文字列を含めない', async () => {
    const marker = 'SECRET_MARKER_8f3a'
    const cmds = [`git push origin main --force # ${marker}`, `git commit --no-verify -m ${marker}`]
    for (const c of cmds) {
      const { event } = await run(layout(), 'main', shellEvent([c]))
      assert.equal(event.effect, 'deny')
      assert.ok(!event.message.includes(marker))
    }
    const sub = await run(layout(), 'sub', shellEvent([`gh pr merge 1 # ${marker}`]))
    assert.ok(!sub.event.message.includes(marker))
  })

  it('ask は使わない（deny か不変のみ）', async () => {
    const cmds = ['git status', 'git push origin main --force', 'gh pr merge 1']
    for (const c of cmds) {
      const { event } = await run(layout(), 'sub', shellEvent([c]))
      assert.ok(['allow', 'deny'].includes(event.effect))
    }
  })

  describe('fail-closed', { concurrency: true }, () => {
    const cases = [
      ['guard が無い', 'none'],
      ['guard が結果行なしで exit 1', '#!/bin/bash\ncat >/dev/null\nexit 1\n'],
      ['guard が結果行なしで exit 0', '#!/bin/bash\ncat >/dev/null\necho hello\nexit 0\n'],
      ['guard が allow を出して exit 1', '#!/bin/bash\ncat >/dev/null\necho "AGENT_GUARD_RESULT allow"\nexit 1\n'],
      ['guard が signal で kill される（時間切れと同じ分岐）', '#!/bin/bash\ncat >/dev/null\nkill -9 $$\n'],
      ['guard が未知の理由コードで deny', '#!/bin/bash\ncat >/dev/null\necho "AGENT_GUARD_RESULT deny zzz"\nexit 2\n'],
      ['guard の出力が契約外（結果行に余分な語）', '#!/bin/bash\ncat >/dev/null\necho "AGENT_GUARD_RESULT allow extra"\nexit 0\n'],
    ]
    for (const [name, guard] of cases) {
      it(`${name} → deny`, async () => {
        const { event } = await run(layout(guard), 'main', shellEvent(['git status']))
        assert.equal(event.effect, 'deny')
        assert.match(event.message, /^agent-guard: /)
        assert.ok(!event.message.includes('git status'))
      })
    }

    it('resources が配列でない shell event → deny', async () => {
      const { event } = await run(layout(), 'main', shellEvent('git status'))
      assert.equal(event.effect, 'deny')
    })

    it('resources に文字列でない要素 → deny', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['git status', 42]))
      assert.equal(event.effect, 'deny')
    })

    it('resources が空配列なら不変', async () => {
      const { event } = await run(layout(), 'main', shellEvent([]))
      assert.equal(event.effect, 'allow')
    })
  })
})

// assets/opencode/plugins/agent-guard/index.js（OpenCode の permission.evaluate hook から
// 共通ガード agent-guard.sh を呼ぶ主判定の層）の回帰テスト。
//
// 対象リポジトリでの配置（.opencode/plugins/agent-guard/index.js と .opencode/hooks/agent-guard.sh）を
// 一時ディレクトリへ再現し、plugin を動的 import して ctx をスタブで渡す。実際の OpenCode は起動しない。
// event の形は OpenCode v2.2.7 の実測値（permission.evaluate の shell event）を書き写したもの。
// ctx.session.get の呼び方（{ sessionID }）と返り値（`{ id, projectID, agent, ... }` の平らなオブジェクトで、
// 子だけが `parentID` を持つ。包まれていない）も同じ実測による。
//
// 実時間の待機は行わない。ガードの時間切れ（5 秒）は実際には待たず、signal で kill された場合
// （spawnSync の r.signal が立つ点は時間切れと同じ分岐）で代用する。
import { describe, it, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

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

// session: 'main' = parentID なし / 'sub' = parentID あり / 'throw' = get が例外 / 'null' = 返り値なし /
// 'wrapped' = { data: {...} } に包まれた形 / 'idmismatch' = 別セッションの id / 'noid' = id なし /
// 'noproject' = projectID なし / 'parent-null' = parentID が null / 'parent-empty' = 空文字 / 'parent-number' = 数値 /
// 'parent-alias' = parentId（別綴り）/ 'parent-other' = parent / 'hang' = 応答しない
// main・sub の形は v2.2.7 の実測（`{ id, [parentID,] projectID, agent, cost, tokens, time, title, location }`）。
const PROJECT_ID = '162d4e7639e760ecdba7c373e38461850969ff16'
const PARENT_ID = 'ses_parent0000000000000000'
function sessionStub(kind, calls) {
  return {
    async get(arg) {
      calls.push(arg)
      const base = { id: arg.sessionID, projectID: PROJECT_ID, agent: 'build', title: 'main' }
      if (kind === 'throw') throw new Error('session not found')
      if (kind === 'hang') return new Promise(() => {})
      if (kind === 'null') return null
      if (kind === 'sub') return { ...base, parentID: PARENT_ID, agent: 'general', title: 'child' }
      if (kind === 'wrapped') return { data: { ...base, parentID: PARENT_ID } }
      if (kind === 'idmismatch') return { ...base, id: 'ses_other00000000000000000000' }
      if (kind === 'noid') { const { id, ...rest } = base; return rest }
      if (kind === 'noproject') { const { projectID, ...rest } = base; return rest }
      if (kind === 'parent-null') return { ...base, parentID: null }
      if (kind === 'parent-empty') return { ...base, parentID: '' }
      if (kind === 'parent-number') return { ...base, parentID: 42 }
      if (kind === 'parent-alias') return { ...base, parentId: PARENT_ID }
      if (kind === 'parent-other') return { ...base, parent: PARENT_ID }
      return base
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

  // #778: session.get の返り値の形が想定と違うとき、main 扱い（マージ制限を外す）に倒れない。
  describe('サブエージェント判定は形を確かめたときだけ main と判定する（#778）', { concurrency: true }, () => {
    const odd = [
      ['返り値が { data: {...} } に包まれている（子のはずが parentID を読めない）', 'wrapped'],
      ['返り値の id が sessionID と違う', 'idmismatch'],
      ['返り値に id が無い', 'noid'],
      ['parentID が空文字', 'parent-empty'],
      ['parentID が数値', 'parent-number'],
      ['parentID が null（親を表すキーがあるため main と確定しない）', 'parent-null'],
      ['別綴りの親キー parentId がある', 'parent-alias'],
      ['親を表す別のキー parent がある', 'parent-other'],
      ['形を確かめるキー projectID が無い', 'noproject'],
    ]
    for (const [name, kind] of odd) {
      it(`${name} → 判定不能（null）としてマージ系を deny・通常コマンドは不変`, async () => {
        const url = layout()
        const merge = await run(url, kind, shellEvent(['gh pr merge 1 --squash']))
        assert.equal(merge.event.effect, 'deny')
        assert.match(merge.event.message, /サブエージェント/)
        const normal = await run(url, kind, shellEvent(['git status']))
        assert.equal(normal.event.effect, 'allow')
      })
    }

    it('id が一致し、projectID があり、親を表すキーがどれも無いときだけ main と判定してマージ系を許す', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['gh pr merge 1 --squash']))
      assert.equal(event.effect, 'allow')
    })

    it('id が一致し parentID が非空の文字列なら子としてマージ系を deny', async () => {
      const { event } = await run(layout(), 'sub', shellEvent(['gh pr merge 1 --squash']))
      assert.equal(event.effect, 'deny')
    })
  })

  // #778: shell 以外の action 名を「全面素通し」にしない。
  describe('action の判定（#778）', { concurrency: true }, () => {
    it('shell・edit 以外の既知の組み込み action は触らず（保護パスの read も不変） session.get も呼ばない', async () => {
      for (const action of ['read', 'glob', 'grep', 'subagent', 'skill', 'question', 'webfetch', 'websearch', 'external_directory', 'browser']) {
        const { event, calls } = await run(layout(), 'main', shellEvent(['git push origin main --force'], { action }))
        assert.equal(event.effect, 'allow', action)
        assert.equal(calls.length, 0, action)
      }
    })

    it('action 名が shell から変わっても、未知の action の resources をガードへ渡して deny する', async () => {
      for (const action of ['bash', 'shell_exec', 'Shell', 'terminal']) {
        const { event } = await run(layout(), 'main', shellEvent(['git push origin main --force'], { action }))
        assert.equal(event.effect, 'deny', action)
        assert.match(event.message, /force/)
      }
    })

    it('未知の action でもガードが allow のコマンド・MCP 風の resource `*` は不変（誤 deny しない）', async () => {
      const a = await run(layout(), 'main', shellEvent(['git status'], { action: 'bash' }))
      assert.equal(a.event.effect, 'allow')
      const mcp = await run(layout(), 'main', shellEvent(['*'], { action: 'github_create_issue' }))
      assert.equal(mcp.event.effect, 'allow')
      assert.equal(mcp.event.message, undefined)
      for (const kind of ['sub', 'throw', 'wrapped']) {
        const e = await run(layout(), kind, shellEvent(['*'], { action: 'github_create_issue' }))
        assert.equal(e.event.effect, 'allow', kind)
      }
    })

    it('未知の action でもサブエージェントのマージ系は deny（subagent 判定も同じ経路）', async () => {
      const { event } = await run(layout(), 'sub', shellEvent(['gh pr merge 1'], { action: 'bash' }))
      assert.equal(event.effect, 'deny')
    })

    it('action が文字列でない event は deny', async () => {
      for (const action of [undefined, null, 42, {}]) {
        const { event } = await run(layout(), 'main', shellEvent(['git status'], { action }))
        assert.equal(event.effect, 'deny', String(action))
        assert.match(event.message, /^agent-guard: /)
      }
    })

    it('すでに deny の未知 action は変えない', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['git push --force origin main'], { action: 'bash', effect: 'deny', message: '他の hook' }))
      assert.equal(event.message, '他の hook')
    })
  })

  // #777: config の deny が効かない書き方（大文字・./・..）の edit を plugin が止める補助層。
  describe('ガード・plugin・設定への edit の deny（#777）', { concurrency: true }, () => {
    const protectedPaths = [
      '.opencode/hooks/agent-guard.sh',
      '.opencode/plugins/agent-guard/index.js',
      '.opencode/plugins/other/index.js',
      '.opencode/opencode.jsonc',
      '.opencode/opencode.json',
      'opencode.jsonc',
      'opencode.json',
      '.OPENCODE/hooks/agent-guard.sh',
      '.Opencode/Plugins/agent-guard/INDEX.js',
      'OpenCode.JSONC',
      './.opencode/hooks/agent-guard.sh',
      'src/../.opencode/hooks/agent-guard.sh',
      '.opencode\\hooks\\agent-guard.sh',
      // サブディレクトリから起動したときの相対パス・絶対パス・入れ子の設定
      '../.opencode/hooks/agent-guard.sh',
      '../../.OPENCODE/Plugins/agent-guard/index.js',
      '../opencode.jsonc',
      '/work/repo/.opencode/hooks/agent-guard.sh',
      'packages/a/opencode.json',
      // 単数形の plugin ディレクトリ・直置きの .js（v2.2.7 の実機で読み込まれて実行されることを確認）
      '.opencode/plugin/agent-guard/index.js',
      '.opencode/plugin/x.js',
      '.opencode/plugins/direct.js',
      // Unicode の大文字小文字の畳み込み・互換文字（ſ は大文字化すると S になる）
      '.opencode/hookſ/agent-guard.sh',
      '.opencode/pluginſ/agent-guard/index.js',
      '.opencode/ｈｏｏｋｓ/agent-guard.sh',
      '.opencode/plugıns/x.js',
    ]
    for (const path of protectedPaths) {
      it(`edit ${path} → deny（固定文・session.get も呼ばない）`, async () => {
        const { event, calls } = await run(layout(), 'main', shellEvent([path], { action: 'edit' }))
        assert.equal(event.effect, 'deny')
        assert.match(event.message, /^agent-guard: /)
        assert.equal(calls.length, 0)
      })
    }

    it('deny の message に入力のパス文字列を含めない', async () => {
      const marker = 'SECRET_MARKER_8f3a'
      const { event } = await run(layout(), 'main', shellEvent([`.opencode/hooks/${marker}.sh`], { action: 'edit' }))
      assert.equal(event.effect, 'deny')
      assert.ok(!event.message.includes(marker))
    })

    const allowedPaths = ['file.txt', 'src/index.js', '.opencode/agents/implementer.md', 'AGENTS.md', '.opencode/skills/x/SKILL.md', 'docs/opencode.jsonc.md', 'myopencode.jsonc', '../src/index.js', '.opencode/plugin-notes.md', '.opencode/tool/t.js', '.opencode/commands/c.md']
    for (const path of allowedPaths) {
      it(`edit ${path} は不変`, async () => {
        const { event } = await run(layout(), 'main', shellEvent([path], { action: 'edit' }))
        assert.equal(event.effect, 'allow')
        assert.equal(event.message, undefined)
      })
    }

    it('複数 resources（patch）のうち 1 つでも保護対象なら deny', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['file.txt', '.OPENCODE/hooks/agent-guard.sh'], { action: 'edit' }))
      assert.equal(event.effect, 'deny')
    })

    it('resources が配列でない・文字列でない要素を含む edit は deny', async () => {
      assert.equal((await run(layout(), 'main', shellEvent('file.txt', { action: 'edit' }))).event.effect, 'deny')
      assert.equal((await run(layout(), 'main', shellEvent(['file.txt', 42], { action: 'edit' }))).event.effect, 'deny')
    })

    it('すでに deny の edit は変えない', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['.opencode/hooks/agent-guard.sh'], { action: 'edit', effect: 'deny', message: '他の hook' }))
      assert.equal(event.message, '他の hook')
    })
  })

  describe('未知の action でも保護パスは守る・execute は素通しにしない（#777 追補）', { concurrency: true }, () => {
    it('write・patch 等の名前違いの action でも resources が保護パスなら deny（ガードへは渡さない）', async () => {
      for (const action of ['write', 'patch', 'apply_patch', 'file_write', 'Edit', 'edit_file']) {
        const { event, calls } = await run(layout(), 'main', shellEvent(['.opencode/hooks/agent-guard.sh'], { action }))
        assert.equal(event.effect, 'deny', action)
        assert.match(event.message, /編集できない/, action)
        assert.equal(calls.length, 0, action)
      }
    })

    it('名前違いの action でも ſ・全角・大文字の保護パスは deny、通常のパスは不変', async () => {
      for (const path of ['.opencode/hookſ/agent-guard.sh', '.opencode/ｈｏｏｋｓ/agent-guard.sh', '.OPENCODE/Plugins/x.js', '../opencode.jsonc']) {
        const { event } = await run(layout(), 'main', shellEvent([path], { action: 'write' }))
        assert.equal(event.effect, 'deny', path)
      }
      const ok = await run(layout(), 'main', shellEvent(['file.txt', '.opencode/agents/implementer.md'], { action: 'write' }))
      assert.equal(ok.event.effect, 'allow')
    })

    it('shell の resources はパスではなくコマンドなので、保護パスを文字列に含んでも git diff 等は不変', async () => {
      const { event } = await run(layout(), 'main', shellEvent(['git diff ../.opencode/hooks/agent-guard.sh']))
      assert.equal(event.effect, 'allow')
    })

    it('execute は素通しにせず resources をガードへ渡す（`*` は allow・コマンド形の force push は deny）', async () => {
      const ok = await run(layout(), 'main', shellEvent(['*'], { action: 'execute' }))
      assert.equal(ok.event.effect, 'allow')
      assert.equal(ok.calls.length, 1)
      const bad = await run(layout(), 'main', shellEvent(['git push origin main --force'], { action: 'execute' }))
      assert.equal(bad.event.effect, 'deny')
    })
  })

  describe('例外でも deny を試みる（#778 追補）', { concurrency: true }, () => {
    it('resources の取得が例外を投げる event は deny（例外を呼び出し元へ漏らさない）', async () => {
      const { evaluate } = await load(layout(), 'main')
      const e = shellEvent(['git status'])
      Object.defineProperty(e, 'resources', { get() { throw new Error('boom') } })
      await evaluate(e)
      assert.equal(e.effect, 'deny')
      assert.match(e.message, /^agent-guard: /)
      assert.ok(!e.message.includes('boom'))
    })

    it('action の取得が例外を投げる event も deny', async () => {
      const { evaluate } = await load(layout(), 'main')
      const e = shellEvent(['git status'])
      Object.defineProperty(e, 'action', { get() { throw new Error('boom') } })
      await evaluate(e)
      assert.equal(e.effect, 'deny')
    })

    it('deny を書き込めない event（null）は握りつぶさず例外のまま', async () => {
      const { evaluate } = await load(layout(), 'main')
      await assert.rejects(() => evaluate(null))
    })
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

// 実時間を待たないため setTimeout を差し替える。差し替え中は他のテストと並行させない（top-level の describe は逐次）。
describe('ctx.session.get の時間切れ（#778 追補）', () => {
  it('応答しない session.get は 3 秒で判定不能（null）になり、マージ系は deny・通常コマンドは不変', async () => {
    const url = layout()
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const results = []
      for (const cmd of ['gh pr merge 1 --squash', 'git status']) {
        const { evaluate } = await load(url, 'hang')
        const event = shellEvent([cmd])
        const p = evaluate(event).then(() => 'done')
        mock.timers.tick(2999)
        await new Promise((r) => setImmediate(r))
        assert.equal(event.effect, 'allow', '3 秒に満たないうちは待つ')
        mock.timers.tick(1)
        const state = await Promise.race([p, new Promise((r) => setImmediate(() => r('hung')))])
        assert.equal(state, 'done')
        results.push(event.effect)
      }
      assert.deepEqual(results, ['deny', 'allow'])
    } finally {
      mock.timers.reset()
    }
  })
})

// PATH の先頭に偽の bash を置いても使われない（PATH 探索に頼らず /bin/bash か /usr/bin/bash を固定で使う）。
describe('spawn する bash の固定（#778 追補）', () => {
  const fixed = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p))
  it('PATH 先頭の偽 bash は実行されない', { skip: fixed ? false : '/bin/bash も /usr/bin/bash も無い環境' }, async () => {
    const fake = mkdtempSync(join(tmpdir(), 'oc-fakebash-'))
    tmpDirs.push(fake)
    const marker = join(fake, 'marker')
    writeFileSync(join(fake, 'bash'), `#!/bin/sh\ntouch "${marker}"\necho "AGENT_GUARD_RESULT allow"\nexit 0\n`)
    chmodSync(join(fake, 'bash'), 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = `${fake}:${oldPath}`
    try {
      const { event } = await run(layout(), 'main', shellEvent(['git push origin main --force']))
      assert.equal(event.effect, 'deny', '偽 bash の allow に騙されず、実物のガードが deny する')
      assert.ok(!existsSync(marker), '偽 bash が実行された')
    } finally {
      process.env.PATH = oldPath
    }
  })
})

// spawnSync の差し替えと Date の模擬を使うため、他のテストと並行させない（top-level の describe は逐次）。
// 実時間は待たない。guard の 1 回の実行が模擬時計で 4 秒かかったとして、合計の上限（10 秒）で打ち切られることを見る。
describe('ガードの同期実行の合計上限（#781）', () => {
  function withFakeSpawn(body) {
    const orig = cp.spawnSync
    const calls = []
    cp.spawnSync = (file, args, opts) => {
      calls.push({ timeout: opts.timeout, killSignal: opts.killSignal })
      mock.timers.tick(body.costMs)
      return { status: 0, signal: null, stdout: 'AGENT_GUARD_RESULT allow\n', stderr: '' }
    }
    syncBuiltinESMExports()
    return { calls, restore() { cp.spawnSync = orig; syncBuiltinESMExports() } }
  }

  it('resources が多く合計が 10 秒に達したら、残りは実行せず deny にする', async () => {
    const url = layout()
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const fake = withFakeSpawn({ costMs: 4000 })
    try {
      const { evaluate } = await load(url, 'main')
      const event = shellEvent(['git status', 'git log', 'git diff', 'git show', 'git branch'])
      await evaluate(event)
      assert.equal(event.effect, 'deny')
      assert.match(event.message, /上限を超えた/)
      // 1 回目・2 回目は 5 秒、3 回目は残り 2 秒だけ待てる。4 回目以降は実行されない。
      assert.deepEqual(fake.calls.map((c) => c.timeout), [5000, 5000, 2000])
    } finally {
      fake.restore()
      mock.timers.reset()
    }
  })

  it('spawnSync に killSignal: SIGKILL を渡す（時間切れでガードの bash を確実に止める）', async () => {
    const url = layout()
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const fake = withFakeSpawn({ costMs: 100 })
    try {
      const { evaluate } = await load(url, 'main')
      await evaluate(shellEvent(['git status', 'git log']))
      assert.deepEqual(fake.calls.map((c) => c.killSignal), ['SIGKILL', 'SIGKILL'])
    } finally {
      fake.restore()
      mock.timers.reset()
    }
  })

  it('合計が上限内なら従来どおり全件を判定して allow のまま（対照）', async () => {
    const url = layout()
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const fake = withFakeSpawn({ costMs: 100 })
    try {
      const { evaluate } = await load(url, 'main')
      const event = shellEvent(['git status', 'git log', 'git diff'])
      await evaluate(event)
      assert.equal(event.effect, 'allow')
      assert.deepEqual(fake.calls.map((c) => c.timeout), [5000, 5000, 5000])
    } finally {
      fake.restore()
      mock.timers.reset()
    }
  })
})

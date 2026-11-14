// assets/opencode/opencode.jsonc と assets/opencode/agents/*.md の静的検査。
//
// OpenCode v2 では v1 のキー（`permission`・`agent` 等）は黙って無視される（未知キーは警告なしで
// 消える）ため、雛形に混入しても気づけない。ここで v1 キーの不在・deny 規則の存在・agent 名が
// 組み込み ID と衝突しないこと（同じ ID は警告なしで上書きされる）を固定する。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OC = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'opencode')

// 組み込みの agent・スキル ID（衝突すると警告なしでプロジェクト側が上書きする）。
const BUILTIN_IDS = ['opencode', 'report', 'browser', 'general', 'explore', 'build', 'plan', 'compaction', 'title', 'summary', 'scout']

// v1 の最上位キー・agent フロントマターのキー（v2 では deprecated）。
const V1_TOP_KEYS = ['permission', 'agent', 'tools', 'mcp', 'provider', 'keybinds', 'autoshare', 'maxSteps']
const V1_AGENT_KEYS = ['permission', 'tools', 'prompt', 'temperature', 'top_p', 'disable', 'maxSteps', 'model']

// 文字列リテラルの中の // を壊さないよう、行コメントは文字列外だけを除去する簡易 JSONC 解析。
function parseJsonc(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') out += text[++i]
      else if (c === '"') inStr = false
    } else if (c === '"') { inStr = true; out += c }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n' }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (!(text[i] === '*' && text[i + 1] === '/')) i++; i++ }
    else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

// 雛形が使う範囲（スカラー・"キー: 値" の配列要素・入れ子のリスト）だけを読む簡易 frontmatter 解析。
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(m, 'frontmatter がある')
  const fm = {}
  let cur = null
  for (const line of m[1].split('\n')) {
    let g
    if ((g = /^([A-Za-z_]+):\s*(.*)$/.exec(line))) {
      cur = g[1]
      fm[cur] = g[2] === '' ? [] : g[2].replace(/^"(.*)"$/, '$1')
    } else if ((g = /^ {2}- (\w+):\s*(.*)$/.exec(line))) {
      fm[cur].push({ [g[1]]: g[2].replace(/^"(.*)"$/, '$1') })
    } else if ((g = /^ {4}(\w+):\s*(.*)$/.exec(line))) {
      fm[cur][fm[cur].length - 1][g[1]] = g[2].replace(/^"(.*)"$/, '$1')
    } else assert.fail(`解釈できない frontmatter 行: ${line}`)
  }
  return { fm, body: text.slice(m[0].length) }
}

const cfg = parseJsonc(readFileSync(join(OC, 'opencode.jsonc'), 'utf8'))
const agentFiles = readdirSync(join(OC, 'agents')).filter((f) => f.endsWith('.md')).sort()
const agents = agentFiles.map((f) => ({ file: f, id: f.replace(/\.md$/, ''), ...parseFrontmatter(readFileSync(join(OC, 'agents', f), 'utf8')) }))

describe('opencode.jsonc', () => {
  it('$schema がある', () => assert.equal(cfg.$schema, 'https://opencode.ai/config.json'))

  it('v1 のキーが無い', () => {
    for (const k of V1_TOP_KEYS) assert.ok(!(k in cfg), `v1 キー ${k}`)
  })

  it('permissions は { action, resource, effect } の配列で effect は deny のみ', () => {
    assert.ok(Array.isArray(cfg.permissions) && cfg.permissions.length > 0)
    for (const r of cfg.permissions) {
      assert.deepEqual(Object.keys(r).sort(), ['action', 'effect', 'resource'])
      assert.equal(r.effect, 'deny')
    }
  })

  it('shell の force push と --no-verify の deny がある', () => {
    const has = (res) => cfg.permissions.some((r) => r.action === 'shell' && r.resource === res)
    for (const res of ['git push --force *', 'git push -f *', 'git commit --no-verify *', 'git commit -n *']) {
      assert.ok(has(res), res)
    }
  })

  it('policies は tool.use の deny で shell: 接頭辞の規則がある', () => {
    assert.ok(Array.isArray(cfg.policies) && cfg.policies.length > 0)
    for (const p of cfg.policies) {
      assert.equal(p.action, 'tool.use')
      assert.equal(p.effect, 'deny')
      assert.ok(p.resource.startsWith('shell:git '), p.resource)
    }
    assert.ok(cfg.policies.some((p) => p.resource.startsWith('shell:git push --force')))
    assert.ok(cfg.policies.some((p) => p.resource.includes('--no-verify')))
  })

  it('ask / allow の規則を含まない（ガードは deny のみ）', () => {
    for (const r of [...cfg.permissions, ...cfg.policies]) assert.equal(r.effect, 'deny')
  })
})

describe('agents/*.md', () => {
  it('researcher / implementer / reviewer の 3 体', () => {
    assert.deepEqual(agents.map((a) => a.id), ['implementer', 'researcher', 'reviewer'])
  })

  for (const a of agents) {
    describe(a.id, () => {
      it('組み込みの agent・スキル ID と衝突しない', () => assert.ok(!BUILTIN_IDS.includes(a.id)))

      it('v2 のキーだけを使い v1 キーと model を含まない', () => {
        for (const k of Object.keys(a.fm)) assert.ok(['description', 'mode', 'permissions'].includes(k), `想定外のキー ${k}`)
        for (const k of V1_AGENT_KEYS) assert.ok(!(k in a.fm), `v1 キー ${k}`)
        assert.ok(a.fm.description && a.fm.description.length > 0)
        assert.equal(a.fm.mode, 'subagent')
      })

      it('本文に日本語で出力する旨がある', () => assert.match(a.body, /日本語/))
    })
  }

  for (const id of ['researcher', 'reviewer']) {
    it(`${id} は先頭で全 action を deny し、許可は read / glob のみ・.env の read を deny`, () => {
      const a = agents.find((x) => x.id === id)
      const perms = a.fm.permissions
      assert.deepEqual(perms[0], { action: '*', resource: '*', effect: 'deny' })
      assert.ok(perms.every((p) => ['deny', 'allow'].includes(p.effect)))
      const allows = perms.filter((p) => p.effect === 'allow')
      assert.ok(allows.length > 0 && allows.every((p) => ['read', 'glob'].includes(p.action)))
      // 後ろの規則ほど優先されるため、.env の deny は read の allow より後ろに置く。
      const lastAllow = perms.map((p) => p.effect).lastIndexOf('allow')
      const envDeny = perms.map((p, i) => (p.action === 'read' && p.resource.includes('.env') && p.effect === 'deny' ? i : -1)).filter((i) => i >= 0)
      assert.ok(envDeny.length >= 2 && envDeny.every((i) => i > lastAllow))
    })
  }

  it('implementer は書き込み系を妨げず、サブエージェントの再帰起動だけ deny', () => {
    const a = agents.find((x) => x.id === 'implementer')
    assert.deepEqual(a.fm.permissions, [{ action: 'subagent', resource: '*', effect: 'deny' }])
  })
})

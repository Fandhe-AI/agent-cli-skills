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

// 公式 docs の照合規則: `*` は 0 文字以上・`?` は 1 文字・末尾の ` *` は引数なしの形にも一致する。
const globToRegExp = (pat) => {
  const trailing = pat.endsWith(' *')
  const body = trailing ? pat.slice(0, -2) : pat
  const re = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}${trailing ? '( .*)?' : ''}$`)
}
const blockedBy = (cmds, rules, prefix) => cmds.filter((c) => rules.some((r) => globToRegExp(r.resource.slice(prefix.length)).test(c)))

describe('opencode.jsonc', () => {
  // コメント付きの生成物は update-opencode の自動マージ（opencode-config-merge.mjs）が needs-manual にする。
  it('コメントを含まない純粋な JSON である（利用者が規則を足しても自動マージを通る）', () => {
    const raw = readFileSync(join(OC, 'opencode.jsonc'), 'utf8')
    // 文字列リテラルの中の `/*`（パスの glob）はコメントではないので、文字列を除いてから検査する
    const outsideStrings = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    assert.ok(!/\/\/|\/\*/.test(outsideStrings))
    assert.doesNotThrow(() => JSON.parse(raw))
  })

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

  it('policies は tool.use の deny で、shell:git ... か edit:<保護パス> の接頭辞の規則だけがある', () => {
    assert.ok(Array.isArray(cfg.policies) && cfg.policies.length > 0)
    for (const p of cfg.policies) {
      assert.equal(p.action, 'tool.use')
      assert.equal(p.effect, 'deny')
      assert.ok(p.resource.startsWith('shell:git ') || p.resource.startsWith('edit:'), p.resource)
    }
    assert.ok(cfg.policies.some((p) => p.resource.startsWith('shell:git push --force')))
    assert.ok(cfg.policies.some((p) => p.resource.includes('--no-verify')))
  })

  // shell の照合は shell の規則だけで行う（edit の path glob を shell のコマンドに当てない）
  const shellPerm = cfg.permissions.filter((r) => r.action === 'shell')
  const shellPol = cfg.policies.filter((p) => p.resource.startsWith('shell:'))

  it('--force-with-lease / --force-if-includes も permissions・policies の両方に一致する（lease 付きでも既存コミットを消せる）', () => {
    const denied = ['git push --force-with-lease', 'git push --force-with-lease origin main', 'git push --force-with-lease=main:abc origin main', 'git push --force-if-includes', 'git push --force-if-includes origin main']
    assert.deepEqual(blockedBy(denied, shellPerm, ''), denied)
    assert.deepEqual(blockedBy(denied, shellPol, 'shell:'), denied)
  })

  it('通常の git push は permissions・policies のどの規則にも一致しない', () => {
    const allowed = ['git push', 'git push origin main', 'git push -u origin feat/x']
    assert.deepEqual(blockedBy(allowed, shellPerm, ''), [])
    assert.deepEqual(blockedBy(allowed, shellPol, 'shell:'), [])
  })

  it('引数なし・引数ありの --force / -f / --no-verify は policies に一致する', () => {
    const denied = ['git push --force', 'git push --force origin main', 'git push -f', 'git push -f origin main', 'git commit --no-verify', 'git commit --no-verify -m x', 'git push --no-verify']
    assert.deepEqual(blockedBy(denied, shellPol, 'shell:'), denied)
    assert.deepEqual(blockedBy(denied, shellPerm, ''), denied)
  })

  it('shell の policies の resource に接頭辞一致の `*`（空白なしの末尾 *）が無い', () => {
    // edit: の規則は path の glob（`.opencode/hooks/*` の `*` は「配下すべて」）なので対象外
    for (const p of cfg.policies.filter((x) => x.resource.startsWith('shell:'))) assert.ok(!/[^ ]\*$/.test(p.resource), p.resource)
  })

  // #777: エージェントが edit / write / patch でガード本体・plugin・設定を置換すると、次のコマンドからガードが無効になる。
  // v2.2.7 の実機で、write・edit ツールの action はどちらも `edit`・resource は相対パスで、絶対パス・`./` 付き・
  // `src/../` 付きも同じ規則で拒否されることを確かめた（policies は接頭辞が `edit:`。`write:` は一致しない）。
  // サブディレクトリから起動すると resource が `../.opencode/hooks/...` の形になる（実測）ため、ディレクトリ側は先頭を `*` にする。
  const EDIT_PROTECTED = ['*.opencode/hooks/*', '*.opencode/plugins/*', '*.opencode/plugin/*', 'opencode.jsonc', '*/opencode.jsonc', 'opencode.json', '*/opencode.json']

  it('ガード本体・plugin・設定ファイルへの edit の deny が permissions と policies の両方にある', () => {
    const permEdit = cfg.permissions.filter((r) => r.action === 'edit').map((r) => r.resource)
    const polEdit = cfg.policies.filter((p) => p.resource.startsWith('edit:')).map((p) => p.resource.slice('edit:'.length))
    assert.deepEqual([...permEdit].sort(), [...EDIT_PROTECTED].sort())
    assert.deepEqual([...polEdit].sort(), [...EDIT_PROTECTED].sort())
  })

  it('保護対象の edit は deny に一致し、通常のファイル・agents・AGENTS.md には一致しない', () => {
    const denied = [
      '.opencode/hooks/agent-guard.sh', '.opencode/plugins/agent-guard/index.js', '.opencode/plugins/new/index.js', '.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json',
      // サブディレクトリからの起動・絶対パス・入れ子の設定
      '../.opencode/hooks/agent-guard.sh', '../../.opencode/plugins/agent-guard/index.js', '.opencode/plugin/agent-guard/index.js', '.opencode/plugin/x.js', '.opencode/plugins/direct.js', '../opencode.jsonc', '../.opencode/opencode.json', '/work/repo/.opencode/hooks/agent-guard.sh', 'packages/a/opencode.jsonc',
    ]
    const allowed = ['file.txt', 'src/index.js', 'AGENTS.md', '.opencode/agents/implementer.md', '../.opencode/agents/implementer.md', '.opencode/skills/x/SKILL.md', 'docs/opencode.jsonc.md', 'myopencode.jsonc', '.opencode/plugin-notes.md', '.opencode/tool/t.js', '.opencode/commands/c.md']
    const editPerm = cfg.permissions.filter((r) => r.action === 'edit')
    const editPol = cfg.policies.filter((p) => p.resource.startsWith('edit:'))
    assert.deepEqual(blockedBy(denied, editPerm, ''), denied)
    assert.deepEqual(blockedBy(denied, editPol, 'edit:'), denied)
    assert.deepEqual(blockedBy(allowed, editPerm, ''), [])
    assert.deepEqual(blockedBy(allowed, editPol, 'edit:'), [])
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

  // 読み取り専用 agent が秘密情報を含みやすいファイルを read できない。resource は起動ディレクトリからの相対パス
  // （サブディレクトリからの起動では `../` 付き、絶対パスもある）で、`*` は `/` を含む 0 文字以上に一致する。
  // `credentials*` や `*credentials*` にすると src/credentials_service.ts のようなソースまで止めるため、
  // 名前が `credentials` / `credentials.json` に一致するファイルだけを対象にする。
  for (const id of ['researcher', 'reviewer']) {
    it(`${id} は .env 系・.envrc・.npmrc・*.pem・credentials 系の read を deny し、通常のソースは止めない`, () => {
      const a = agents.find((x) => x.id === id)
      const readDeny = a.fm.permissions.filter((p) => p.action === 'read' && p.effect === 'deny')
      const denied = [
        '.env', '.env.local', 'config/prod.env', '../.env', '/work/repo/.env.production',
        '.envrc', 'sub/.envrc', '../.envrc', '.npmrc', 'packages/a/.npmrc', '/home/u/.npmrc',
        'certs/server.pem', 'key.pem', '../tls/ca.pem',
        'credentials', '.aws/credentials', '/home/u/.aws/credentials', 'credentials.json', 'config/credentials.json', '../credentials.json',
      ]
      const allowed = [
        'src/index.js', 'README.md', 'docs/envrc.md', 'src/credentials_service.ts', 'src/credentials/index.ts', 'docs/credentials.md', 'test/fixtures/pem-parser.js', 'package.json', '.npmrc.md', 'environment.ts',
      ]
      assert.deepEqual(blockedBy(denied, readDeny, ''), denied)
      assert.deepEqual(blockedBy(allowed, readDeny, ''), [])
    })
  }

  it('implementer は書き込み系を妨げず、サブエージェントの再帰起動だけ deny', () => {
    const a = agents.find((x) => x.id === 'implementer')
    assert.deepEqual(a.fm.permissions, [{ action: 'subagent', resource: '*', effect: 'deny' }])
  })
})

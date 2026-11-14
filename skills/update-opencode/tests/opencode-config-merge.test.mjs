// assets/scripts/opencode-config-merge.mjs の実行テスト。スクリプトを子プロセスで直接実行し、
// 結果語彙・終了コード・ファイルの不変性を固定する。他スキルの lib には依存しない。
// 各テストは専用の一時ディレクトリを使うため、node:test の並列実行（concurrency）で独立に走る。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'assets', 'scripts', 'opencode-config-merge.mjs')
const TEMPLATE = join(HERE, '..', 'assets', 'opencode', 'opencode.jsonc')

const dirs = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'oc-merge-')); dirs.push(d); return d }
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

// 子プロセスを実行し、終了コード・stdout・結果語彙を返す。
async function merge(target, extra = [], template = TEMPLATE) {
  let r
  try { r = await run(process.execPath, [SCRIPT, '--target', target, '--template', template, ...extra]) }
  catch (e) { r = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code } }
  const last = r.stdout.trimEnd().split('\n').pop()
  return { code: r.code ?? 0, stdout: r.stdout, word: last.replace('OPENCODE_CONFIG_MERGE_RESULT ', '') , last }
}

// テンプレートの JSONC から自分の規則を取り出す（文字列内の // を壊さない読み方は本体と別に最小実装）。
const own = JSON.parse(readFileSync(TEMPLATE, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'))
const userAllow = { action: 'shell', resource: 'npm test', effect: 'allow' }
const userPolicy = { action: 'tool.use', resource: 'shell:ls*', effect: 'allow' }
const write = (dir, obj, name = 'opencode.jsonc') => { const p = join(dir, name); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n'); return p }
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

describe('opencode-config-merge', { concurrency: true }, () => {
  it('target が無ければ template をそのまま作成する', async () => {
    const d = tmp(); const t = join(d, 'opencode.jsonc')
    const r = await merge(t)
    assert.equal(r.word, 'created'); assert.equal(r.code, 0)
    assert.equal(readFileSync(t, 'utf8'), readFileSync(TEMPLATE, 'utf8'))
    assert.deepEqual(readdirSync(d), ['opencode.jsonc'])
  })

  it('利用者の規則の後ろに自分の規則が付き、利用者分は同順・他キーと $schema は保持', async () => {
    const d = tmp()
    const t = write(d, { $schema: 'https://opencode.ai/config.json', model: 'x/y', permissions: [userAllow, { action: 'shell', resource: 'rm *', effect: 'deny' }], policies: [userPolicy], extra: { b: 1, a: [3, 2, 1] } })
    const r = await merge(t)
    assert.equal(r.word, 'merged'); assert.equal(r.code, 0)
    const o = read(t)
    assert.deepEqual(o.permissions.slice(0, 2), [userAllow, { action: 'shell', resource: 'rm *', effect: 'deny' }])
    assert.deepEqual(o.permissions.slice(2), own.permissions)
    assert.deepEqual(o.policies, [userPolicy, ...own.policies])
    assert.equal(o.$schema, 'https://opencode.ai/config.json'); assert.equal(o.model, 'x/y')
    assert.deepEqual(Object.keys(o), ['$schema', 'model', 'permissions', 'policies', 'extra'])
    assert.deepEqual(o.extra, { b: 1, a: [3, 2, 1] })
    assert.ok(readFileSync(t, 'utf8').endsWith('}\n'))
    assert.equal(readdirSync(d).length, 1)
  })

  it('permissions / policies が無い target にも配列を作って追加する', async () => {
    const d = tmp(); const t = write(d, { model: 'a/b' })
    assert.equal((await merge(t)).word, 'merged')
    const o = read(t); assert.deepEqual(o.permissions, own.permissions); assert.deepEqual(o.policies, own.policies)
  })

  it('2 回目は unchanged で mtime も不変', async () => {
    const d = tmp(); const t = write(d, { permissions: [userAllow] })
    await merge(t)
    const old = new Date(2020, 0, 1); utimesSync(t, old, old)
    const before = readFileSync(t, 'utf8')
    const r = await merge(t)
    assert.equal(r.word, 'unchanged'); assert.equal(r.code, 0)
    assert.equal(statSync(t).mtimeMs, old.getTime()); assert.equal(readFileSync(t, 'utf8'), before)
  })

  it('利用者の規則より後ろにある自分の規則は既存、前にあるもの（キー順違いを含む）は不足として末尾へ再追加し、既存要素は動かさない', async () => {
    const d = tmp()
    const reordered = { effect: 'deny', resource: own.permissions[1].resource, action: 'shell' }
    const t = write(d, { permissions: [reordered, userAllow, own.permissions[0]], policies: own.policies })
    const r = await merge(t)
    assert.equal(r.word, 'merged')
    const o = read(t)
    assert.deepEqual(o.permissions.slice(0, 3), [reordered, userAllow, own.permissions[0]])
    // own[0] は userAllow より後ろなので既存。own[1] は前にしか無いので再追加される。
    assert.deepEqual(o.permissions.slice(3), own.permissions.slice(1))
    assert.deepEqual(o.policies, own.policies)
    assert.equal((await merge(t)).word, 'unchanged')
  })

  it('自分の deny 一式の後ろに利用者の包括 allow があれば、末尾へ全件を再追加し利用者分は順序不変・2 回目は unchanged', async () => {
    const d = tmp()
    const broad = { action: 'shell', resource: '*', effect: 'allow' }
    const broadPolicy = { action: 'tool.use', resource: 'shell:*', effect: 'allow' }
    const t = write(d, { permissions: [...own.permissions, broad], policies: [userPolicy, ...own.policies, broadPolicy] })
    const r = await merge(t)
    assert.equal(r.word, 'merged'); assert.equal(r.code, 0)
    const o = read(t)
    assert.deepEqual(o.permissions, [...own.permissions, broad, ...own.permissions])
    assert.deepEqual(o.policies, [userPolicy, ...own.policies, broadPolicy, ...own.policies])
    // 利用者の規則だけを取り出すと元の順序のまま。
    assert.deepEqual(o.permissions.filter((x) => x === undefined || !own.permissions.some((q) => JSON.stringify(q) === JSON.stringify(x))), [broad])
    // 末尾の自分の規則が最後に一致する = 包括 allow に負けない。
    assert.deepEqual(o.permissions.slice(-own.permissions.length), own.permissions)
    const again = await merge(t)
    assert.equal(again.word, 'unchanged')
    assert.deepEqual(read(t), o)
  })

  it('コメント付きで deny の後ろに利用者の規則があれば needs-manual で同じ判定の不足分を出す', async () => {
    const d = tmp()
    const broad = { action: 'shell', resource: '*', effect: 'allow' }
    const text = `{\n // c\n "permissions": ${JSON.stringify([...own.permissions, broad])}, "policies": ${JSON.stringify(own.policies)}\n}\n`
    const t = write(d, text)
    const r = await merge(t)
    assert.equal(r.word, 'needs-manual'); assert.equal(r.code, 3)
    assert.equal(readFileSync(t, 'utf8'), text)
    const json = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('OPENCODE_CONFIG_MERGE_RESULT')))
    assert.deepEqual(json.permissions, own.permissions)
    assert.equal(json.policies, undefined)
  })

  for (const [name, text] of [
    ['行コメント', '{\n  // メモ\n  "permissions": []\n}\n'],
    ['ブロックコメント', '{ /* x */ "permissions": [] }\n'],
    ['末尾カンマ', '{ "permissions": [], }\n'],
    ['配列の末尾カンマ', '{ "permissions": [ { "action": "a", "resource": "b", "effect": "allow" }, ] }\n'],
  ]) {
    it(`${name}付きは needs-manual（終了コード 3）でファイル不変・規則を JSON で出す`, async () => {
      const d = tmp(); const t = write(d, text)
      const r = await merge(t)
      assert.equal(r.word, 'needs-manual'); assert.equal(r.code, 3)
      assert.equal(readFileSync(t, 'utf8'), text)
      const json = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('OPENCODE_CONFIG_MERGE_RESULT')))
      assert.deepEqual(json.permissions, own.permissions); assert.deepEqual(json.policies, own.policies)
      assert.deepEqual(readdirSync(d), ['opencode.jsonc'])
    })
  }

  it('コメント付きでも追加すべき規則が無ければ unchanged', async () => {
    const d = tmp(); const t = write(d, `{\n // c\n "permissions": ${JSON.stringify(own.permissions)}, "policies": ${JSON.stringify(own.policies)}\n}\n`)
    const before = readFileSync(t, 'utf8')
    assert.equal((await merge(t)).word, 'unchanged'); assert.equal(readFileSync(t, 'utf8'), before)
  })

  it('文字列内の // /* ,} をコメント・末尾カンマと誤認しない', async () => {
    const d = tmp()
    const t = write(d, { $schema: 'https://opencode.ai/config.json', note: 'a /* b */ ,} c // d', permissions: [{ action: 'shell', resource: 'curl http://x/*', effect: 'allow' }] })
    const r = await merge(t)
    assert.equal(r.word, 'merged')
    assert.equal(read(t).note, 'a /* b */ ,} c // d')
    assert.equal(read(t).permissions[0].resource, 'curl http://x/*')
  })

  it('template 側の URL を含む $schema もコメント扱いせず読める', async () => {
    const d = tmp(); const t = join(d, 'o.jsonc')
    assert.equal((await merge(t)).word, 'created')
    assert.equal((await merge(t)).word, 'unchanged')
  })

  for (const [name, text, word] of [
    ['JSON 不正', '{ "permissions": [ ', 'error-invalid-json'],
    ['permissions がオブジェクト', '{ "permissions": {} }', 'error-not-array'],
    ['policies が文字列', '{ "policies": "x" }', 'error-not-array'],
    ['最上位が配列', '[]', 'error-not-object'],
  ]) {
    it(`${name}は非 0 でファイル不変（${word}）`, async () => {
      const d = tmp(); const t = write(d, text)
      const r = await merge(t)
      assert.equal(r.word, word); assert.notEqual(r.code, 0)
      assert.equal(readFileSync(t, 'utf8'), text); assert.deepEqual(readdirSync(d), ['opencode.jsonc'])
    })
  }

  it('symlink は非 0 でリンク先も不変', async () => {
    const d = tmp(); const real = write(d, { permissions: [] }, 'real.json'); const link = join(d, 'opencode.jsonc')
    symlinkSync(real, link)
    const before = readFileSync(real, 'utf8')
    const r = await merge(link)
    assert.equal(r.word, 'error-symlink'); assert.notEqual(r.code, 0)
    assert.equal(readFileSync(real, 'utf8'), before)
  })

  it('--check は書かずに語彙だけ返す（created / merged / unchanged）', async () => {
    const d = tmp(); const none = join(d, 'none.jsonc')
    assert.equal((await merge(none, ['--check'])).word, 'created'); assert.deepEqual(readdirSync(d), [])
    const t = write(d, { permissions: [userAllow] }); const before = readFileSync(t, 'utf8')
    assert.equal((await merge(t, ['--check'])).word, 'merged'); assert.equal(readFileSync(t, 'utf8'), before)
    await merge(t)
    assert.equal((await merge(t, ['--check'])).word, 'unchanged')
  })

  it('既存ファイルの権限を保つ', async () => {
    const d = tmp(); const t = write(d, { permissions: [] })
    const { chmodSync } = await import('node:fs'); chmodSync(t, 0o600)
    await merge(t)
    assert.equal(statSync(t).mode & 0o777, 0o600)
  })

  it('引数の誤りは error-usage（終了コード 2）', async () => {
    const r = await run(process.execPath, [SCRIPT, '--target']).catch((e) => e)
    assert.equal(r.code, 2); assert.match(r.stdout, /OPENCODE_CONFIG_MERGE_RESULT error-usage/)
  })
})

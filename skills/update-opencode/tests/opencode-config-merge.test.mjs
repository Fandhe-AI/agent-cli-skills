// assets/scripts/opencode-config-merge.mjs の実行テスト。スクリプトを子プロセスで直接実行し、
// 結果語彙・終了コード・ファイルの不変性を固定する。他スキルの lib には依存しない。
// 各テストは専用の一時ディレクトリを使うため、node:test の並列実行（concurrency）で独立に走る。
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
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

  // #777: edit deny（ガード本体・plugin・設定ファイルへの edit）を追加した新テンプレートを、
  // edit deny を持たない旧テンプレート（shell の deny だけ）で導入済みの利用先へ当てる。
  describe('旧テンプレートで導入済みの設定へ edit deny を追加する（#777）', { concurrency: true }, () => {
    const oldPerm = own.permissions.filter((r) => r.action === 'shell')
    const oldPol = own.policies.filter((p) => p.resource.startsWith('shell:'))
    const editPerm = own.permissions.filter((r) => r.action === 'edit')
    const editPol = own.policies.filter((p) => p.resource.startsWith('edit:'))

    it('template が edit の deny を permissions と policies に持ち、旧テンプレートは shell のみ', () => {
      assert.ok(editPerm.length >= 6 && editPol.length >= 6)
      assert.equal(oldPerm.length + editPerm.length, own.permissions.length)
      assert.equal(oldPol.length + editPol.length, own.policies.length)
      assert.ok(oldPerm.length > 0 && oldPol.length > 0)
    })

    it('旧テンプレート + 利用者の規則の target は merged で edit deny だけが末尾へ付き、利用者の規則と順序は不変・2 回目は unchanged', async () => {
      const d = tmp()
      const t = write(d, { model: 'a/b', permissions: [userAllow, ...oldPerm], policies: [userPolicy, ...oldPol] })
      const r = await merge(t)
      assert.equal(r.word, 'merged'); assert.equal(r.code, 0)
      const o = read(t)
      assert.deepEqual(o.permissions, [userAllow, ...oldPerm, ...editPerm])
      assert.deepEqual(o.policies, [userPolicy, ...oldPol, ...editPol])
      assert.equal(o.model, 'a/b')
      assert.equal((await merge(t)).word, 'unchanged')
    })

    it('--check は旧テンプレートの target を merged と判定し、書かない', async () => {
      const d = tmp()
      const t = write(d, { permissions: [...oldPerm], policies: [...oldPol] })
      const before = readFileSync(t, 'utf8')
      const r = await merge(t, ['--check'])
      assert.equal(r.word, 'merged'); assert.equal(r.code, 0)
      assert.equal(readFileSync(t, 'utf8'), before)
    })

    it('利用者の edit 全許可（後続の allow）があれば edit deny を末尾へ再追加し、最後に一致する規則が deny になる', async () => {
      const d = tmp()
      const editAll = { action: 'edit', resource: '*', effect: 'allow' }
      const t = write(d, { permissions: [...oldPerm, ...editPerm, editAll], policies: [...oldPol, ...editPol] })
      const r = await merge(t)
      assert.equal(r.word, 'merged')
      const o = read(t)
      const at = o.permissions.findIndex((x) => JSON.stringify(x) === JSON.stringify(editAll))
      assert.ok(at >= 0)
      assert.deepEqual(o.permissions.slice(-own.permissions.length), own.permissions)
      // 利用者の allow より後ろに、保護対象ごとの edit deny が戻っている
      for (const e of editPerm) assert.ok(o.permissions.map((x) => JSON.stringify(x)).lastIndexOf(JSON.stringify(e)) > at, e.resource)
      assert.equal((await merge(t)).word, 'unchanged')
    })

    it('コメント付きの旧テンプレート target は needs-manual で edit deny だけを JSON で出し、ファイルは不変', async () => {
      const d = tmp()
      const body = `{\n  // 利用者のコメント\n  "permissions": ${JSON.stringify(oldPerm)},\n  "policies": ${JSON.stringify(oldPol)}\n}\n`
      const t = write(d, body)
      const r = await merge(t)
      assert.equal(r.word, 'needs-manual'); assert.equal(r.code, 3)
      assert.equal(readFileSync(t, 'utf8'), body)
      const out = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('OPENCODE_CONFIG_MERGE_RESULT')))
      assert.deepEqual(out.permissions, editPerm)
      assert.deepEqual(out.policies, editPol)
    })
  })

  it('template 自体がコメント・末尾カンマを含まない（生成物が自動マージを通る前提）', () => {
    const t = readFileSync(TEMPLATE, 'utf8')
    // 文字列リテラルの中の `/*`（パスの glob）はコメントではないので、文字列を除いてから検査する
    assert.ok(!/\/\/|\/\*/.test(t.replace(/"(?:[^"\\]|\\.)*"/g, '""')), 'コメントがある')
    assert.doesNotThrow(() => JSON.parse(t))
  })

  it('template の生成物の末尾に利用者の規則を足しても needs-manual にならず merged で deny が末尾へ戻る', async () => {
    const d = tmp()
    const t = join(d, 'opencode.jsonc')
    assert.equal((await merge(t)).word, 'created')
    // 利用者が permissions 配列の末尾へ手で 1 件足した形（テキスト編集）
    const edited = readFileSync(t, 'utf8').replace('\n  ],\n  "policies"', `,\n    ${JSON.stringify(userAllow)}\n  ],\n  "policies"`)
    assert.notEqual(edited, readFileSync(t, 'utf8'))
    writeFileSync(t, edited)
    const r = await merge(t)
    assert.equal(r.word, 'merged'); assert.equal(r.code, 0)
    const o = read(t)
    assert.deepEqual(o.permissions.slice(-own.permissions.length), own.permissions)
    assert.deepEqual(o.permissions[own.permissions.length], userAllow)
    assert.deepEqual(o.policies, own.policies)
    assert.equal((await merge(t)).word, 'unchanged')
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

  // ---- 読み込みから置換までの間の変更（lost update）の検知 ----
  // --import で fs の読み書きを差し替える前処理を流し込み、target の最初の読み込み直後（既存）・一時ファイルの
  // chmod 直後（作成）に target を書き換えさせる。本物のスクリプトにテスト用のフックは持たせない。
  function racePreload(dir, mode) {
    const p = join(dir, 'race-preload.mjs')
    writeFileSync(p, [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'let done = false',
      `if (${JSON.stringify(mode)} === 'read') {`,
      '  const orig = fs.readFileSync',
      '  fs.readFileSync = function (p, ...a) {',
      '    const r = orig.call(this, p, ...a)',
      "    if (!done && String(p) === process.env.RACE_TARGET) { done = true; fs.appendFileSync(p, '\\n') }",
      '    return r',
      '  }',
      '} else {',
      '  const orig = fs.chmodSync',
      '  fs.chmodSync = function (...a) {',
      '    const r = orig.apply(this, a)',
      "    if (!done && !fs.existsSync(process.env.RACE_TARGET)) { done = true; fs.writeFileSync(process.env.RACE_TARGET, '{\"x\":1}\\n') }",
      '    return r',
      '  }',
      '}',
      'syncBuiltinESMExports()',
      '',
    ].join('\n'))
    return pathToFileURL(p).href
  }

  async function mergeRace(target, preload) {
    let r
    try { r = await run(process.execPath, ['--import', preload, SCRIPT, '--target', target, '--template', TEMPLATE], { env: { ...process.env, RACE_TARGET: target } }) }
    catch (e) { r = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code } }
    return { code: r.code ?? 0, stderr: r.stderr, word: r.stdout.trimEnd().split('\n').pop().replace('OPENCODE_CONFIG_MERGE_RESULT ', '') }
  }

  it('読み込んだあとに target が書き換わったら error-changed で上書きしない', async () => {
    const d = tmp(); const t = write(d, { permissions: [userAllow] })
    const before = readFileSync(t, 'utf8')
    const r = await mergeRace(t, racePreload(d, 'read'))
    assert.equal(r.word, 'error-changed', r.stderr); assert.notEqual(r.code, 0)
    assert.equal(readFileSync(t, 'utf8'), `${before}\n`, '他者の変更が残る')
    assert.deepEqual(readdirSync(d).filter((f) => f.includes('.tmp-')), [], '一時ファイルが残っている')
  })

  it('作成: 無いと見たあとに他者が作ったら error-changed で上書きしない', async () => {
    const d = tmp(); const t = join(d, 'opencode.jsonc')
    const r = await mergeRace(t, racePreload(d, 'create'))
    assert.equal(r.word, 'error-changed', r.stderr); assert.notEqual(r.code, 0)
    assert.equal(readFileSync(t, 'utf8'), '{"x":1}\n')
    assert.deepEqual(readdirSync(d).filter((f) => f.includes('.tmp-')), [], '一時ファイルが残っている')
  })

  it('前処理を入れても何も書き換わらなければ通常どおり書ける（対照）', async () => {
    const d = tmp(); const t = write(d, { permissions: [userAllow] })
    const pre = join(d, 'noop.mjs'); writeFileSync(pre, 'export {}\n')
    const r = await mergeRace(t, pathToFileURL(pre).href)
    assert.equal(r.word, 'merged', r.stderr)
  })

  // ---- 複数文書・オプション風のパス・親ディレクトリの symlink ----

  it('複数の JSON 文書（{}{}）は error-invalid-json でファイル不変', async () => {
    const d = tmp(); const t = write(d, '{}{}')
    const r = await merge(t)
    assert.equal(r.word, 'error-invalid-json'); assert.notEqual(r.code, 0)
    assert.equal(readFileSync(t, 'utf8'), '{}{}')
  })

  it('- 始まりの相対パスの target も通常のファイルとして扱う', async () => {
    const d = tmp(); write(d, { permissions: [userAllow] }, '-opencode.jsonc')
    let r
    try { r = await run(process.execPath, [SCRIPT, '--target', '-opencode.jsonc', '--template', TEMPLATE], { cwd: d }) } catch (e) { r = e }
    assert.match(r.stdout, /OPENCODE_CONFIG_MERGE_RESULT merged/, r.stderr)
    assert.equal(read(join(d, '-opencode.jsonc')).permissions.length, 1 + own.permissions.length)
  })

  it('親ディレクトリが symlink なら警告して実体のディレクトリへ書く', async () => {
    const d = tmp(); const real = join(d, 'real'); mkdirSync(real)
    const link = join(d, 'link'); symlinkSync(real, link)
    write(real, { permissions: [userAllow] })
    const r = await run(process.execPath, [SCRIPT, '--target', join(link, 'opencode.jsonc'), '--template', TEMPLATE])
    assert.match(r.stdout, /OPENCODE_CONFIG_MERGE_RESULT merged/)
    assert.match(r.stderr, /親ディレクトリ.*シンボリックリンク/)
    assert.equal(read(join(real, 'opencode.jsonc')).permissions.length, 1 + own.permissions.length)
    assert.deepEqual(readdirSync(real), ['opencode.jsonc'])
    // 通常の親ディレクトリでは警告しない（対照）
    const t = write(d, { permissions: [userAllow] }, 'plain.jsonc')
    assert.doesNotMatch((await run(process.execPath, [SCRIPT, '--target', t, '--template', TEMPLATE])).stderr, /シンボリックリンク/)
  })
})

#!/usr/bin/env node
// mutate.mjs — 変異テストの小さな実行器（Issue #603・テストの高速化の検証用）。ファイル名が `*.test.mjs` に一致しないため
// node --test の glob には拾われない。
//
// 目的: テストを書き換えた（まとめた・表にした・縮めた）あとで『検査が弱くなっていないか』を、実装に 1 か所だけ欠陥を入れた
//       変異体で確かめる。変異体に対して関連するテストファイルだけを流し、赤なら killed（検査が欠陥を捕まえた）、緑なら
//       survived（検査が欠陥を見逃した = テストが弱い）と判定する。全テスト（約 80 秒）を毎回流さない。
//
// 使い方（リポジトリルートで）:
//   node skills/implement-issue-tree/tests/tools/mutate.mjs --list
//   node skills/implement-issue-tree/tests/tools/mutate.mjs --run U02-host-suffix [id ...] [--jobs 4]
//   node skills/implement-issue-tree/tests/tools/mutate.mjs --run all
//   node skills/implement-issue-tree/tests/tools/mutate.mjs --def <定義ファイル> --run all
//   --list           定義の id・対象ファイル・流すテスト・説明を出す
//   --run ID...|all  変異体を作って判定する。同時に走らせる数は --jobs（既定 4）
//   --def FILE       既定の tools/mutations.mjs の代わりに読む定義ファイル（`export const MUTATIONS = [...]`）
//   --tests A,B      定義の tests の代わりに、この tests/ 内のテストファイルだけを流す（どのテストが捕まえるかの切り分け用）
//   --skill DIR      コピー元のスキルのディレクトリ（既定はこのファイルのあるスキル）。別の版（例: git archive で取り出した
//                    main）に同じ変異を当てて、テストの検出力を版どうしで比べるために使う
//   --keep           作業コピーを消さずにパスを出す（原因調査用）
//   Node の版を変えて流すときは `volta run --node 22 node …` のように実行器ごと包む（テストも同じ node で走る）。
//
// 変異の定義（MUTATIONS の要素）:
//   { id, file, from, to, tests: ['xxx.test.mjs', ...], note?, rebuild? }
//   file   スキルのディレクトリ（skills/implement-issue-tree）からの相対パス。from がそのファイルにちょうど 1 か所だけ
//          あること（0 か所・2 か所以上は invalid。弱い置換を黙って当てない）
//   tests  tests/ からの相対パス。流すのはこのファイルだけ
//   rebuild true / false / 省略（自動）。自動は .sh・.src.js・build-workflow.mjs を変えたときだけ生成物を再ビルドする
//          （スクリプトを変えると埋め込みハッシュが変わるので、再ビルドしないと『ハッシュ不一致』で偽の赤になる）。
//          再ビルドがトークン照合などで中止したら、変異体は出荷用のビルドゲートで止まったので killed（by: build）と扱う
//
// 安全: 作業ツリーは一切書き換えない。スキルのディレクトリを一時ディレクトリへ（リポジトリ内の深さ skills/<name>/ を保って）
//       コピーし、コピーの上で置換・再ビルド・テストを行う。作業コピーは終了時に必ず消す。
// 終了コード: 0 = 実行した変異体がすべて killed、1 = survived・invalid が 1 つ以上、2 = 使い方の誤り
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnAsync } from '../lib/run-async.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = resolve(HERE, '..', '..')
const SKILL_NAME = 'implement-issue-tree'
const DEFAULT_DEF = join(HERE, 'mutations.mjs')

// 子プロセス（再ビルド・node --test）の環境。node --test の中から呼ばれると NODE_TEST_CONTEXT が引き継がれ、入れ子の
// node --test が『親のテストランナーの子』として振る舞い、赤でも exit 0 を返す（変異を全部 survived と誤判定する）。外して渡す
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_TEST_CONTEXT
  return env
}

// 置換が当たる回数（重ならない出現）
export function countOccurrences(text, needle) {
  if (needle === '') return 0
  let n = 0
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++
  return n
}

// 置換を 1 か所だけ当てる。当たる回数が 1 でなければ { ok: false, reason } を返す
export function applyMutation(text, from, to) {
  const n = countOccurrences(text, from)
  if (n !== 1) return { ok: false, reason: `置換前の文字列が ${n} か所に当たる（ちょうど 1 か所である必要がある）` }
  return { ok: true, text: text.replace(from, () => to) }
}

export function needsRebuild(mutation) {
  if (typeof mutation.rebuild === 'boolean') return mutation.rebuild
  return /\.sh$/.test(mutation.file) || /\.src\.js$/.test(mutation.file) || mutation.file === 'scripts/build-workflow.mjs'
}

// 定義の形式検査（実行前に全件）。問題の一覧を返す
export function validateDefinitions(list) {
  const problems = []
  const seen = new Set()
  if (!Array.isArray(list)) return ['MUTATIONS が配列でない']
  for (const [i, m] of list.entries()) {
    const at = `#${i}${m && m.id ? `(${m.id})` : ''}`
    if (!m || typeof m !== 'object') {
      problems.push(`${at}: オブジェクトでない`)
      continue
    }
    for (const k of ['id', 'file', 'from']) if (typeof m[k] !== 'string' || m[k] === '') problems.push(`${at}: ${k} が空でない文字列でない`)
    if (typeof m.to !== 'string') problems.push(`${at}: to が文字列でない（削除する変異は空文字列）`)
    if (m.from === m.to) problems.push(`${at}: from と to が同じ（変異になっていない）`)
    if (!Array.isArray(m.tests) || m.tests.length === 0 || m.tests.some((t) => typeof t !== 'string' || !t.endsWith('.test.mjs'))) problems.push(`${at}: tests は *.test.mjs の配列（1 件以上）`)
    if (typeof m.file === 'string' && (m.file.startsWith('/') || m.file.includes('..'))) problems.push(`${at}: file はスキル内の相対パス`)
    if (Array.isArray(m.tests) && m.tests.some((t) => typeof t === 'string' && (t.startsWith('/') || t.includes('..')))) problems.push(`${at}: tests は tests/ 内の相対パス`)
    if (seen.has(m.id)) problems.push(`${at}: id が重複`)
    seen.add(m.id)
  }
  return problems
}

async function loadDefinitions(path) {
  const mod = await import(pathToFileURL(resolve(path)).href)
  const problems = validateDefinitions(mod.MUTATIONS)
  if (problems.length > 0) throw new Error(`変異の定義が不正:\n${problems.join('\n')}`)
  return mod.MUTATIONS
}

// 1 つの変異体を判定する。skillDir は変異の対象（既定は本物のスキル。コピー元として読むだけ）
export async function runMutation(m, { skillDir = SKILL_DIR, keep = false, nodeBin = process.execPath, testsOverride = null } = {}) {
  const started = Date.now()
  const done = (status, extra = {}) => ({ id: m.id, status, seconds: (Date.now() - started) / 1000, ...extra })
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'iit-mutate-')))
  try {
    // リポジトリ内の深さを保つ（build-workflow.test.mjs が ../../.. をリポジトリルートとして相対パスで --check を実行する）
    const copy = join(work, 'skills', SKILL_NAME)
    mkdirSync(dirname(copy), { recursive: true })
    cpSync(skillDir, copy, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') })
    const target = join(copy, m.file)
    if (!existsSync(target)) return done('invalid', { detail: `対象ファイルが無い: ${m.file}` })
    const applied = applyMutation(readFileSync(target, 'utf8'), m.from, m.to)
    if (!applied.ok) return done('invalid', { detail: applied.reason })
    writeFileSync(target, applied.text)

    if (needsRebuild(m)) {
      const b = await spawnAsync(nodeBin, [join(copy, 'scripts', 'build-workflow.mjs')], { cwd: copy, env: childEnv() })
      if (b.status !== 0) return done('killed', { by: 'build', detail: (b.stderr || b.stdout).trim().split('\n').pop().slice(0, 160) })
    }

    const tmp = join(work, 'tmp')
    mkdirSync(tmp, { recursive: true })
    const files = (testsOverride ?? m.tests).map((t) => join('tests', t))
    for (const f of files) if (!existsSync(join(copy, f))) return done('invalid', { detail: `流すテストファイルが無い: ${f}` })
    const t = await spawnAsync(nodeBin, ['--test', '--test-reporter=spec', ...files], { cwd: copy, env: childEnv({ TMPDIR: tmp }) })
    if (t.status === 0) return done('survived')
    const failed = t.stdout.split('\n').filter((l) => /^\s*✖ /.test(l) && !/failing tests:/.test(l)).map((l) => l.replace(/^\s*✖ /, '').replace(/ \([0-9.]+ms\)$/, '').slice(0, 70))
    return done('killed', { by: 'tests', detail: failed.length > 0 ? `赤 ${failed.length} 件: ${failed.slice(0, 2).join(' / ')}` : `exit ${t.status}` })
  } finally {
    if (keep) console.log(`作業コピー: ${work}`)
    else rmSync(work, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const out = { list: false, run: null, def: DEFAULT_DEF, keep: false, jobs: 4, tests: null, skill: SKILL_DIR, error: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') out.list = true
    else if (a === '--keep') out.keep = true
    else if (a === '--def' || a === '--jobs' || a === '--tests' || a === '--skill') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) return { ...out, error: `${a} に値が無い` }
      if (a === '--def') out.def = v
      else if (a === '--skill') out.skill = resolve(v)
      else if (a === '--tests') out.tests = v.split(',').filter(Boolean)
      else if (/^[1-9][0-9]?$/.test(v)) out.jobs = Number(v)
      else return { ...out, error: '--jobs は 1〜99 の整数' }
    } else if (a === '--run') {
      out.run = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.run.push(argv[++i])
      if (out.run.length === 0) return { ...out, error: '--run に id（または all）が無い' }
    } else return { ...out, error: `未知の引数: ${a}` }
  }
  if (!out.list && out.run === null) return { ...out, error: '--list か --run が必要' }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`mutate: ${args.error}\n使い方: node mutate.mjs --list | --run ID...|all [--def FILE] [--jobs N] [--keep]`)
    return 2
  }
  let defs
  try {
    defs = await loadDefinitions(args.def)
  } catch (e) {
    console.error(`mutate: ${e.message}`)
    return 2
  }
  if (args.list) {
    for (const m of defs) console.log(`${m.id}\t${m.file}\t${m.tests.join(',')}\t${m.note ?? ''}`)
    return 0
  }
  const wanted = args.run.length === 1 && args.run[0] === 'all' ? defs : args.run.map((id) => defs.find((m) => m.id === id) ?? id)
  const unknown = wanted.filter((m) => typeof m === 'string')
  if (unknown.length > 0) {
    console.error(`mutate: 未知の id: ${unknown.join(', ')}（--list で確認）`)
    return 2
  }
  const results = []
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const m = wanted[next++]
      const r = await runMutation(m, { skillDir: args.skill, keep: args.keep, testsOverride: args.tests })
      results.push(r)
      const label = { killed: 'KILLED  ', survived: 'SURVIVED', invalid: 'INVALID ' }[r.status]
      console.log(`${label} ${r.id}${r.by ? ` (by: ${r.by})` : ''} ${r.seconds.toFixed(1)}s${r.detail ? ` — ${r.detail}` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.jobs, wanted.length) }, worker))
  const count = (s) => results.filter((r) => r.status === s).length
  console.log(`合計 ${results.length} 件: killed ${count('killed')} / survived ${count('survived')} / invalid ${count('invalid')}`)
  return count('survived') + count('invalid') === 0 ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}

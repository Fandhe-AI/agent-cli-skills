// 改名器・検証器・V8 オラクルのテストが共有する呼び出し口（テスト専用）。
// 3 つとも Node 同梱 acorn を使うため node --expose-internals の子プロセスで起動する。
// stage1 はコミット済みの生成物を読まずに src から作る（生成物は後続の PR で改名済みに変わるため）。
import { SHIPPED_SCRIPTS } from './paths.mjs'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnAsync } from './run-async.mjs'
import { trackTmp } from './tmp-track.mjs'
import { SRC_PATH, buildArtifact, embedScriptHashes } from '../../scripts/build-workflow.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MANGLE_PATH = join(HERE, '..', '..', 'scripts', 'mangle-identifiers.cjs')
export const ALPHA_VERIFY_PATH = join(HERE, '..', '..', 'scripts', 'alpha-verify.cjs')
export const ORACLE_PATH = join(HERE, 'v8-bytecode-oracle.cjs')
const DRIVER_PATH = join(HERE, 'mangle-driver.cjs')

// 現行のビルドの stage1（ハッシュ埋め込み + コメント・空白除去。トークン照合はビルダーのテストが担う）
export function buildStage1() {
  return buildArtifact(embedScriptHashes(readFileSync(SRC_PATH, 'utf8'), SHIPPED_SCRIPTS))
}

async function runJson(path, input, args = []) {
  const r = await spawnAsync(process.execPath, ['--expose-internals', path, ...args], { input })
  if (r.status !== 0) throw new Error(`${path} が status ${r.status} で終了: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// 改名器の CLI をそのまま起動する（終了コード・stdout・stderr を返す）
export function runMangleCli(text) {
  return spawnAsync(process.execPath, ['--expose-internals', MANGLE_PATH], { input: text })
}

export async function mangleText(text) {
  const r = await runMangleCli(text)
  if (r.status !== 0) throw new Error(`改名器が status ${r.status} で終了: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// 複数の入力を 1 プロセスで改名する。[{ ok, code?, stats?, error? }]
export const mangleBatch = (texts) => runJson(DRIVER_PATH, JSON.stringify({ mode: 'mangle', texts }))
export const refswapMutants = (text, count, seed) => runJson(DRIVER_PATH, JSON.stringify({ mode: 'refswap', text, count, seed }))
export const functionBodyStarts = (text) => runJson(DRIVER_PATH, JSON.stringify({ mode: 'function-body-starts', text }))

// 検証器: cases = [{ name, before, after }] → results（名前で引ける Map）
export async function alphaVerify(cases) {
  const out = await runJson(ALPHA_VERIFY_PATH, JSON.stringify(cases))
  return new Map(out.results.map((r) => [r.name, r]))
}

// V8 オラクル: 一時ディレクトリはプロセス終了時に消す
export async function v8Oracle(cases) {
  const dir = trackTmp(mkdtempSync(join(tmpdir(), 'iit-v8-oracle-')))
  const out = await runJson(ORACLE_PATH, JSON.stringify(cases), [dir])
  return new Map(out.results.map((r) => [r.name, r]))
}

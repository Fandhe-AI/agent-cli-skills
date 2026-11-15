// 改名器・検証器・V8 オラクルのテストが共有する呼び出し口（テスト専用）。
// 3 つとも Node 同梱 acorn を使うため node --expose-internals の子プロセスで起動する。
// stage1 はコミット済みの生成物を読まずに src から作る（生成物は後続の PR で改名済みに変わるため）。
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
  return buildArtifact(embedScriptHashes(readFileSync(SRC_PATH, 'utf8'), dirname(SRC_PATH)))
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

// 実物の stage1 で、検証器の一律の拒否（関数の名前・ソースを観測し得る構文）に当たる既知の 1 か所。
// src の boundaryNonce の `const pad = (h) => h.toString(36)...`。h はループ内で `>>> 0` を通った uint32 なので、
// `(h>>>0)` に置き換えても値は変わらず、検証器の例外（受け手が構文上必ず数値）に当たる（同じ生成物の
// `(x>>>0).toString(16)` と同じ形）。PR 3 で src をこの形に書き換えると拒否は 0 件になり、この関数は件数の確認で
// 落ちる。そのときは呼び出し側（alpha-verify.test.mjs の (c)・mangle-real-artifact.test.mjs）からこの置き換えを外す
const KNOWN_OBSERVATION = { before: 'const pad=(h)=>', site: 'h.toString(36)', after: '.padStart(', replacement: '(h>>>0).toString(36)' }

// 拒否がちょうど 1 件で、その場所が既知の箇所（offset と前後の文字列が一致）であることを確かめてから、その 1 か所だけを
// 置き換えた stage1 を返す。件数・場所・前後が違えば置き換えずに例外で落ちる
export async function patchKnownObservation(stage1) {
  const r = (await alphaVerify([{ name: 'probe', before: stage1, after: stage1 }])).get('probe')
  const m = /^\[module\] 変換前: 関数の名前・ソースを観測し得る構文 (\d+) 件。最初は メンバーの toString（offset (\d+)）$/.exec(r.detail ?? '')
  if (r.ok || !m) throw new Error(`一律の拒否が想定の形でない: ${r.kind} ${r.detail}`)
  if (m[1] !== '1') throw new Error(`一律の拒否が ${m[1]} 件（1 件のはず）: ${r.detail}`)
  const { before, site, after, replacement } = KNOWN_OBSERVATION
  const at = Number(m[2])
  const around = stage1.slice(at - before.length, at + site.length + after.length)
  if (around !== before + site + after) throw new Error(`一律の拒否の場所が既知の箇所でない（offset ${at}）: ${JSON.stringify(around)}`)
  if (stage1.split(site).length !== 2) throw new Error(`${site} が stage1 に 1 か所でない`)
  return stage1.slice(0, at) + replacement + stage1.slice(at + site.length)
}

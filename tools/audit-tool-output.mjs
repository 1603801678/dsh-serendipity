#!/usr/bin/env node
/**
 * Audit every tool value for the harness's **lossless-JSON output contract**.
 *
 * Why this exists: the tool runtime snapshots each result before validating it,
 * and a single `undefined` member (or a function, a non-finite number, or a class
 * instance) makes it reject the **whole** call with
 * `tool "x" returned invalid output: value is not lossless JSON`. Unit tests that
 * read fields never see it — `JSON.stringify` drops `undefined` — so the first
 * symptom is a broken tool in a live session, which is exactly what happened on
 * 2026-10-13 (`landedLag.medianDays: undefined` cost the entire stats report).
 *
 * The audit runs every tool body on a throwaway project, walks each returned value,
 * and also checks the renderer's text for the word `undefined`. It must print
 * `ALL LOSSLESS`; anything else fails.
 *
 * Usage:
 *   node tools/audit-tool-output.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTools } from '../lib/tools.js'
import { StateStore } from '../lib/store.js'
import { loadCorpus } from '../lib/corpus.js'
import { DrawEngine } from '../lib/draw.js'

const root = mkdtempSync(join(tmpdir(), 'serendipity-audit-state-'))
const cwd = mkdtempSync(join(tmpdir(), 'serendipity-audit-project-'))

/**
 * Collect every member the runtime would reject.
 *
 * @param {unknown} node - value to inspect.
 * @param {string} path - diagnostic path.
 * @param {string[]} bad - accumulator, mutated.
 * @returns {void}
 */
function walk(node, path, bad) {
  if (node === undefined) { bad.push(`${path} = undefined`); return }
  if (node === null) return
  const type = typeof node
  if (type === 'function' || type === 'symbol' || type === 'bigint') { bad.push(`${path} = ${type}`); return }
  if (type === 'number') { if (!Number.isFinite(node)) bad.push(`${path} = ${String(node)}`); return }
  if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${path}[${index}]`, bad)); return }
  if (type !== 'object') return
  const prototype = Object.getPrototypeOf(node)
  if (prototype !== Object.prototype && prototype !== null) bad.push(`${path} 的原型是 ${prototype?.constructor?.name}`)
  for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`, bad)
}

const corpus = loadCorpus(undefined)
const store = new StateStore({ root })
const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
const tools = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
const exec = { agent: { session: { id: 'audit-session', header: { cwd }, events: [] } }, deferContext() {} }

let failures = 0

/**
 * Execute one tool call and report its contract violations.
 *
 * @param {string} label - human label for the call.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @returns {Promise<object | undefined>} the value, when the body did not throw.
 */
async function run(label, name, args) {
  let value
  try {
    value = await tools.get(name).execute(args, exec)
  } catch (error) {
    console.log(`THROW ${label} (${name}): ${error.message}`)
    failures += 1
    return undefined
  }
  const bad = []
  walk(value, name, bad)
  if (bad.length === 0) console.log(`OK   ${label} (${name})`)
  else {
    console.log(`FAIL ${label} (${name})`)
    for (const entry of bad) console.log('       ', entry)
    failures += bad.length
  }
  // The renderer runs on the model-facing path too, so it must never print `undefined`.
  const text = tools.get(name).output.render(args, value).map(block => block.text ?? '').join('\n')
  if (/undefined/.test(text)) { console.log(`FAIL ${label} 的渲染里出现了 undefined`); failures += 1 }
  return value
}

const drawn = await run('普通抽取', 'serendipity_draw', { count: 3, purpose: '审计工具输出' })
await run('抽取 scope=near', 'serendipity_draw', { scope: 'near', purpose: '审计' })
await run('抽取 scope=generate', 'serendipity_draw', { scope: 'generate' })
await run('抽取 collide', 'serendipity_draw', { collide: true, count: 2 })
await run('抽取 bias+violate', 'serendipity_draw', { bias: '阈值', violate: true, count: 2 })
await run('记录笔记', 'serendipity_note', {
  items: (drawn?.items ?? []).map((item, index) => index === 0
    ? { id: item.id, hit: true, note: '审计：搬进文档', landed: 'docs/x.md §1' }
    : { id: item.id, hit: false, note: '审计：对不上' }),
})
await run('沉淀素材', 'serendipity_learn', {
  label: '审计用素材',
  origin: '审计学',
  structure: '把不可见的边界显性化',
  summary: '这条素材只用于审计工具返回值，写在临时状态目录里。',
  detail: '当流程的边界没有被显式表达时，参与者只能靠经验猜测，误差会在每一步被放大；把边界写下来之后，误差不再累积，而是变成可讨论的选项。',
  bridge: '你的流程里，哪条边界只存在于某个人的经验里？',
  category: 'pattern',
  structureTags: ['边界'],
  tags: ['审计'],
})
await run('统计（全部段）', 'serendipity_stats', { cwd })
await run('统计（只有 library）', 'serendipity_stats', { cwd, sections: ['library'] })
await run('统计（只有 sessions）', 'serendipity_stats', { cwd, sections: ['sessions'] })
await run('拆解', 'serendipity_decompose', { artifact: '一个卡牌游戏', goal: '让人愿意反复开局', parts: ['抽牌', '出牌'] })
await run('抓取（非法 URL）', 'serendipity_fetch', { url: 'not-a-url', focus: '审计' })

console.log(failures === 0 ? '\nALL LOSSLESS' : `\n${failures} 处不合格`)
rmSync(root, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
process.exitCode = failures === 0 ? 0 : 1

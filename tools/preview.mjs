#!/usr/bin/env node
/**
 * 低成本中间产物生成器：把插件真正会交给模型的文本渲染出来，方便人工检查。
 *
 * 用法：node tools/preview.mjs [--count 5] [--bias 生活观察] [--violate]
 * 输出：控制台预览 + docs/preview-draw.md（git 可追踪，便于对比不同版本的渲染效果）
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCorpus } from '../lib/corpus.js'
import { DrawEngine } from '../lib/draw.js'
import { StateStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const count = Number(flag('count', '5')) || 5
const bias = flag('bias', undefined)
const violate = args.includes('--violate')

const root = mkdtempSync(join(tmpdir(), 'dsh-serendipity-preview-'))
const cwd = mkdtempSync(join(tmpdir(), 'dsh-serendipity-preview-cwd-'))
try {
  const corpus = loadCorpus(undefined)
  const store = new StateStore({ root })
  const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
  const tools = createTools({ engine, store })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const exec = { agent: { session: { header: { cwd } } } }

  const draw = byName.get('serendipity_draw')
  // Omit unset flags entirely: the registry rejects `undefined` members, since
  // model arguments are always lossless JSON.
  const drawArgs = { count, purpose: '（预览：人工检查渲染效果）' }
  if (bias !== undefined) drawArgs.bias = bias
  if (violate) drawArgs.violate = true
  const value = await draw.execute(drawArgs, exec)
  const rendered = draw.output.render({}, value)[0].text

  await byName.get('serendipity_note').execute({
    items: value.items.map((item, index) => ({
      id: item.id,
      hit: index === 0,
      note: index === 0 ? '（预览示例）第一条假设为命中' : '（预览示例）假设为未命中',
      transformation: false,
    })),
  }, exec)
  const stats = await byName.get('serendipity_stats').execute({}, exec)
  const statsText = byName.get('serendipity_stats').output.render({}, stats)[0].text

  const document = [
    '# dsh-serendipity 渲染预览',
    '',
    `> 由 \`node tools/preview.mjs\` 生成。参数：count=${count}${bias === undefined ? '' : ` bias=${bias}`}${violate ? ' violate' : ''}`,
    '> 这是模型实际看到的文本（含抽取头、素材卡片、记录要求），用于人工检查启发性和可读性。',
    '',
    '## serendipity_draw 输出',
    '',
    '```text',
    rendered,
    '```',
    '',
    '## serendipity_stats 输出（示例：1 命中）',
    '',
    '```text',
    statsText,
    '```',
    '',
  ].join('\n')

  mkdirSync(join(here, '..', 'docs'), { recursive: true })
  writeFileSync(join(here, '..', 'docs', 'preview-draw.md'), document, 'utf8')
  process.stdout.write(rendered + '\n\n')
  process.stdout.write(statsText + '\n')
  process.stdout.write(`\n→ 已写入 docs/preview-draw.md\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

// 测量：把工具 schema 真正发给模型要花多少 token，以及每个工具占多少。
// 用真实 ToolRuntime 的 schemas() 投影，所以量的是模型实际看到的东西。
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, {})
plugin.apply(ctx, {})

const schemas = ctx.tools.schemas()

/** 粗略 token 估算：CJK 约 1 token/字，ASCII 约 1 token/4 字符。 */
function estimateTokens(text) {
  let cjk = 0
  let ascii = 0
  for (const char of text) {
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
    else ascii += 1
  }
  return Math.round(cjk + ascii / 4)
}

const rows = []
for (const schema of schemas) {
  const full = JSON.stringify(schema)
  const description = schema.description ?? ''
  const params = JSON.stringify(schema.parameters ?? {})
  rows.push({
    name: schema.name,
    total: estimateTokens(full),
    description: estimateTokens(description),
    parameters: estimateTokens(params),
    paramCount: Object.keys(schema.parameters?.properties ?? {}).length,
    descChars: description.length,
  })
}

rows.sort((a, b) => b.total - a.total)
console.log('每个工具的估算 token 占用（模型每次请求都要读一遍）：\n')
console.log('工具'.padEnd(24), '合计'.padStart(6), '描述'.padStart(6), '参数'.padStart(6), '参数个数'.padStart(8))
for (const row of rows) {
  console.log(row.name.padEnd(24), String(row.total).padStart(6), String(row.description).padStart(6), String(row.parameters).padStart(6), String(row.paramCount).padStart(8))
}

const total = rows.reduce((sum, row) => sum + row.total, 0)
const descTotal = rows.reduce((sum, row) => sum + row.description, 0)
console.log(`\n合计约 ${total} token（描述部分约 ${descTotal}）`)

// 系统提示词段落也占地方
const assembly = await ctx.systemPrompt.assemble()
const section = assembly.sections.find(entry => entry.name === 'plugin:dsh-serendipity')
console.log(`系统提示词段落约 ${estimateTokens(section?.text ?? '')} token`)

// 对比参照
console.log('\n参照：')
console.log(`  本插件工具 schema 合计 ≈ ${total} token`)
console.log(`  一份 3000 字的中文文档 ≈ 3000 token`)
console.log(`  上下文窗口按 128k 算，占 ${(total / 128000 * 100).toFixed(2)}%`)

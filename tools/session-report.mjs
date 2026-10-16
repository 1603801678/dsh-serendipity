// 会话转录分析：把导出的 session.jsonl 摘要成可读报告，用来判断插件在真实会话里的表现。
// 用法：node tools/session-report.mjs <session.jsonl> [--metrics] [--serendipity] [--user] [--reasoning]
//
// 这是**只读**工具：不解析完整 5MB 转录进上下文，只挑出与插件相关的调用与模型自述。
//
// 不给任何开关时默认打印 `--metrics`：一个默认什么都不输出的工具，等于没有这个工具。

import { readFileSync } from 'node:fs'

const [, , file, ...flags] = process.argv
if (!file) {
  console.error('用法：node tools/session-report.mjs <session.jsonl> [--metrics] [--user] [--reasoning] [--tools] [--results]')
  process.exit(1)
}
const want = new Set(flags)
if (want.size === 0) want.add('--metrics')

const rows = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter(Boolean)

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

if (want.has('--metrics')) {
  // The one question a user asks after an open-ended prompt: did the plugin actually
  // get used, and how early? Answered from the transcript alone, so an exported zip is
  // enough — the plugin-side record (`~/.dsh/dsh-serendipity/projects/<项目>.json`,
  // `serendipity_stats`, `GET /api/dsh-serendipity/sessions`) answers the same question
  // from the other side.
  console.log('\n================ 缪斯（dsh-serendipity）会话指标 ================')
  const session = rows.find((o) => o.type === 'session')
  const calls = rows.filter((o) => o.type === 'tool/call')
  const byName = new Map()
  for (const call of calls) {
    const name = call.data?.name ?? '?'
    byName.set(name, (byName.get(name) ?? 0) + 1)
  }
  const serendipity = (name) => calls.filter((call) => call.data?.name === name)

  const drawCalls = serendipity('serendipity_draw')
  const noteCalls = serendipity('serendipity_note')
  const timed = rows.filter((o) => typeof o.time === 'number')
  const firstTurnAt = rows.find((o) => o.type === 'turn/start')?.time
  const lastAt = timed.at(-1)?.time
  const minutes = (from, to) => (from === undefined || to === undefined ? undefined : ((to - from) / 60000).toFixed(1))
  // "Turn start" is the last `turn/start` at or before a point — the same rule the
  // plugin uses (`lib/sessions.js`), so both reports agree. Measured from session
  // creation instead, an idle gap between opening the session and prompting would be
  // counted as time spent working.
  const turnStartedAt = (at) => rows.filter((o) => o.type === 'turn/start' && o.time <= at).at(-1)?.time

  // Materials actually handed over: counted from the rendered `id=` markers of *draw*
  // results (never from the request's `count`, which a draw may undershoot, and never
  // from other tools' output, which can contain hash-looking strings of its own).
  const callName = new Map(calls.map((call) => [call.data?.callId, call.data?.name]))
  const servedIds = new Set()
  for (const result of rows.filter((o) => o.type === 'tool/result')) {
    const callId = result.data?.message?.source?.callId
    if (callName.get(callId) !== 'serendipity_draw') continue
    const text = JSON.stringify(result.data?.message?.content ?? '')
    for (const match of text.matchAll(/id=([0-9a-f]{16})/g)) servedIds.add(match[1])
  }
  const served = servedIds.size

  // Notes are counted from the arguments: entries, distinct ids (补记 repeats an id),
  // and how many wrote a location. `landed` is the only credited number.
  let entries = 0
  let claimedHits = 0
  let landed = 0
  const notedIds = new Set()
  for (const call of noteCalls) {
    let args
    try {
      args = JSON.parse(call.data?.arguments ?? '{}')
    } catch {
      continue
    }
    for (const item of args.items ?? []) {
      entries += 1
      if (typeof item?.id === 'string' && item.id !== '') notedIds.add(item.id)
      if (item?.hit === true) claimedHits += 1
      if (typeof item?.landed === 'string' && item.landed.trim() !== '') landed += 1
    }
  }

  const reminders = rows.filter((o) => o.type === 'user/message'
    && String(o.data?.source?.plugin ?? '') === 'dsh-serendipity').length
  const firstDraw = drawCalls[0]
  const totalSteps = rows.filter((o) => o.type === 'step/start').length
  const totalTurns = rows.filter((o) => o.type === 'turn/start').length

  console.log(`会话 ${session?.id ?? '?'}  cwd=${session?.cwd ?? '?'}`)
  console.log(`规模：${totalTurns} 轮 / ${totalSteps} 步；首轮起 ${minutes(firstTurnAt, lastAt) ?? '?'} 分钟；工具调用 ${calls.length} 次`)
  console.log(`插件调用：draw ${byName.get('serendipity_draw') ?? 0}｜note ${byName.get('serendipity_note') ?? 0}`
    + `｜decompose ${byName.get('serendipity_decompose') ?? 0}｜stats ${byName.get('serendipity_stats') ?? 0}`
    + `｜learn ${byName.get('serendipity_learn') ?? 0}｜fetch ${byName.get('serendipity_fetch') ?? 0}`)
  if (firstDraw === undefined) {
    console.log('首次抽取：**没有抽取**（本会话一次 serendipity_draw 都没有）')
  } else {
    const turn = firstDraw.data?.turn
    const step = firstDraw.data?.step
    const turnStart = turnStartedAt(firstDraw.time)
    const elapsed = minutes(turnStart, firstDraw.time)
    const share = turnStart === undefined || lastAt === undefined || lastAt === turnStart
      ? undefined
      : Math.round(((firstDraw.time - turnStart) / (lastAt - turnStart)) * 100)
    let line = `首次抽取：第 ${turn ?? '?'} 轮第 ${step ?? '?'} 步`
    if (elapsed !== undefined) {
      line += `（该轮开场后 ${elapsed} 分钟`
      if (share !== undefined) line += `，占该轮 ${share}%`
      line += '）'
    }
    if (turn !== 1) line += '　⚠️ 不在第一轮：开场那轮没有抽'
    console.log(line)
    console.log(`　　　　　共抽取 ${drawCalls.length} 次，发出 ${served} 条素材`)
  }
  console.log(`回收：记录 ${noteCalls.length} 次；条目 ${entries} 条（去重 ${notedIds.size} 个 id）；`
    + `写明落点 ${landed} 条；自评「有用」${claimedHits} 条` + (landed === 0 ? '　→ 一次落点都没有' : ''))
  console.log(`漏记提醒：触发 ${reminders} 次${reminders === 0 ? '（记录及时）' : '　⚠️ 抽完没有立刻记录'}`)
  if (firstDraw !== undefined && noteCalls.length === 0) console.log('⚠️ 抽了但一条都没记——这批素材不会被标记为已读，下次还会抽到。')
  console.log('来源：① 本报告读的是转录；② 插件侧记录见 serendipity_stats 的【本会话】段与 GET /api/dsh-serendipity/sessions。')
}

if (want.has('--user')) {
  console.log('\n================ USER / PLUGIN MESSAGES ================')
  for (const o of rows) {
    if (o.type === 'user/message') {
      const d = o.data ?? {}
      const src = d.source?.kind ? `[${d.source.kind}${d.source.plugin ? ':' + d.source.plugin : ''}${d.source.form ? '/' + d.source.form : ''}]` : ''
      console.log(`\n--- seq ${o.seq} ${src} ---\n${textOf(d.content ?? d.message?.content ?? d)}`)
    }
  }
}

if (want.has('--tools')) {
  console.log('\n================ TOOL CALLS ================')
  for (const o of rows) {
    if (o.type !== 'tool/call') continue
    const d = o.data ?? {}
    if (!/^serendipity_/.test(d.name ?? '')) continue
    console.log(`\n===== seq ${o.seq} turn ${d.turn} ${d.name} =====`)
    console.log(d.arguments)
  }
}

if (want.has('--results')) {
  console.log('\n================ TOOL RESULTS (serendipity) ================')
  for (const o of rows) {
    if (o.type !== 'tool/result') continue
    const d = o.data ?? {}
    const s = JSON.stringify(d)
    if (!/serendipity|素材|落点/.test(s)) continue
    console.log(`\n===== seq ${o.seq} =====`)
    console.log(s.slice(0, 6000))
  }
}

if (want.has('--reasoning')) {
  console.log('\n================ REASONING MENTIONING PLUGIN ================')
  for (const o of rows) {
    if (o.type !== 'assistant/chunk') continue
    const s = JSON.stringify(o.data ?? {})
    if (!/缪斯|serendipity|素材|灵感|随机/.test(s)) continue
    const t = textOf(o.data?.content ?? o.data?.delta ?? '')
    if (t) console.log(`\n--- seq ${o.seq} ---\n${t.slice(0, 3000)}`)
  }
}

if (want.has('--assistant')) {
  console.log('\n================ ASSISTANT MESSAGES ================')
  for (const o of rows) {
    if (o.type !== 'assistant/message') continue
    const t = textOf(o.data?.content ?? o.data?.message?.content ?? '')
    if (t) console.log(`\n--- seq ${o.seq} ---\n${t}`)
  }
}

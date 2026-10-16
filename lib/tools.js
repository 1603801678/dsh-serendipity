/**
 * The agent-facing tools.
 *
 * Four tools, one loop: **draw** (get far-field material) → read → **note**
 * (what happened when you tried to map it) → **learn** (turn today's discovery
 * into tomorrow's material) → **stats** (see whether the corpus is actually
 * helping). The loop is deliberately loss-tolerant: a draw whose materials all
 * miss is recorded as a miss, not as a failure, because serendipity is a
 * numbers game and the misses are what the statistics are for.
 *
 * @module @1603801678/dsh-serendipity/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CATEGORY_NAMES, tagVocabulary, validateMaterial } from './corpus.js'
import { COLLIDE_DEFAULT_PAIRS } from './draw.js'
import { MIN_EVIDENCE, median } from './effectiveness.js'
import { QUERY_TRAPS, QUERY_TRAPS_BRIEF, REACHABLE_BRIEF, SOURCE_GROUPS, UNREACHABLE_BRIEF, UNREACHABLE_HINTS, fetchReadable } from './fetch.js'
import { drawPair, generationTask } from './generate.js'
import { fieldCount } from './fields.mjs'
import { CONTROLLED } from './structure-tags.mjs'
import { materialId } from './hash.js'
import { classifyHorizon, horizonGuidance, recallNotes } from './horizon.js'
import { sessionPosition, describeSession } from './sessions.js'
import { listAnalyses, readAnalysis, saveAnalysis, stateLayout } from './store.js'

/** One text content block (the only render shape these tools emit). */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** The corpus-pool shape reported when a call does not draw anything (`scope: near`). */
function emptyPool() {
  return { total: 0, unseenBeforeDraw: 0, unseenAfterDraw: 0, exhausted: false }
}

/** The request shape shared by every draw response. */
function baseRequest() {
  return { count: 0, violate: false }
}

/**
 * The session's working directory, used to key this project's draw history.
 * Taken from the durable session header so a hook that authors the host (or a
 * headless run from another directory) still lands in the right project bucket.
 * @param {object} exec - the tool run context.
 * @returns {string} an absolute directory, falling back to the process cwd.
 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** Session identity used to key the pending-note registry. */
function sessionOf(exec) {
  return exec?.agent?.session?.id ?? 'anonymous'
}

/** Pending-note windows older than this are dropped (a session that went quiet). */
const PENDING_TTL_MS = 60 * 60 * 1000

/**
 * Materials drawn but not yet noted, per session.
 *
 * The draw→note loop is the whole point of the plugin — an unnoted draw is
 * thrown-away work, and it also corrupts the hit-rate statistics. Prose in the
 * tool description ("ALWAYS call serendipity_note") is a request, not a
 * guarantee, so the plugin also *enforces* it: the result of the next
 * `serendipity_draw` carries a deferred context listing exactly which ids are
 * still unaccounted for. `draw.js` needs no knowledge of this registry.
 *
 * A plain module-level map (not a service) is enough: the tools are registered
 * globally, and the session id keys it correctly. Entries are bounded by TTL.
 *
 * @type {Map<string, { ids: Set<string>, at: number }>}
 */
const pendingNotes = new Map()

/** Add freshly drawn ids to a session's pending set. */
function addPending(exec, ids) {
  const key = sessionOf(exec)
  const entry = pendingNotes.get(key) ?? { ids: new Set(), at: Date.now() }
  for (const id of ids) entry.ids.add(id)
  entry.at = Date.now()
  pendingNotes.set(key, entry)
}

/** Remove noted ids and return how many are still outstanding. */
function settlePending(exec, ids) {
  const key = sessionOf(exec)
  const entry = pendingNotes.get(key)
  if (entry === undefined) return 0
  for (const id of ids) entry.ids.delete(id)
  if (entry.ids.size === 0) {
    pendingNotes.delete(key)
    return 0
  }
  return entry.ids.size
}

/** Outstanding ids for a session, expiring stale windows. */
function outstanding(exec) {
  const key = sessionOf(exec)
  const entry = pendingNotes.get(key)
  if (entry === undefined) return []
  if (Date.now() - entry.at > PENDING_TTL_MS) {
    pendingNotes.delete(key)
    return []
  }
  return [...entry.ids]
}

/**
 * How many previously-read-but-unlanded materials to hand back per draw.
 *
 * Small on purpose. This is not a second reading list — it is the one prompt that
 * makes a *delayed* landing recordable at all, and a long list would just compete
 * with the material actually being served.
 */
export const RECONSIDER_LIMIT = 2

/**
 * How old a note must be to count as "worth another look".
 *
 * Without a floor this surfaces whatever was written most recently — material read
 * minutes ago, whose owner has not had time to form a view about it yet. That is
 * not reconsideration, it is noise, and it would push the prompt toward "you just
 * said this was useless, are you sure?", which is exactly the self-report pressure
 * the design is trying to get away from. A day is the shortest span in which
 * anything else could plausibly have moved.
 */
export const RECONSIDER_MIN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * How many sessions of history `serendipity_stats` hands back.
 *
 * Small on purpose: the question the report answers is "is the plugin being used, and
 * how early" — a handful of recent sessions answers it, and a long table would be read
 * as a scoreboard. The full history stays in the project file for the read-only route.
 */
export const SESSION_ROWS = 5

/**
 * Build the deferred reminder for ids that were drawn but never noted.
 * @param {string[]} ids - outstanding material ids.
 * @returns {object} a user-role message for `ToolRunContext.deferContext`.
 */
export function noteReminderMessage(ids) {
  const sample = ids[0]
  return {
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-serendipity', form: 'notice' },
    content: [{
      type: 'text',
      text: [
        `【dsh-serendipity】上一次 serendipity_draw 有 ${ids.length} 条素材还没有被记录：${ids.join('、')}。`,
        '请立刻调用 serendipity_note 补上——命中就写清映射到了什么，没命中就写清为什么对不上。',
        `例：serendipity_note({ items: [{ id: "${sample}", hit: false, note: "结构对不上，因为……" }] })`,
        '不记录的话，这些素材不会被标记为已读（下次还会抽到它们），插件也拿不到覆盖度样本。',
      ].join('\n'),
    }],
  }
}

/** Clamp a number into a range, tolerating junk. */
function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

/**
 * Source fields this project has already read, for the generation sampler to avoid.
 *
 * "Already read" is judged from the project's own records, not the whole corpus:
 * material another project read is still new here, and the point of the avoid-list is
 * to keep *this* line of work from circling the same few fields.
 *
 * @param {object} store - the state store.
 * @param {string} cwd - session working directory.
 * @returns {string[]} distinct source fields.
 */
function coveredOriginsFor(store, cwd) {
  const entries = store.readProject(cwd).entries ?? {}
  const origins = new Set()
  for (const entry of Object.values(entries)) {
    if (entry?.external === true) continue
    if (typeof entry?.origin === 'string' && entry.origin !== '') origins.add(entry.origin)
  }
  return [...origins]
}

/**
 * Whether a draw purpose reads like design/redesign work — the case where decomposing
 * the artifact *before* drawing materials is worth a one-time suggestion.
 *
 * A deliberately blunt keyword test, and only ever used to suppress or allow a single
 * hint: a false positive costs one line of reading, a false negative costs nothing.
 *
 * @param {unknown} purpose - the free-text purpose argument.
 * @returns {boolean} whether to offer the decomposition hint.
 */
function suggestDecompose(purpose) {
  if (typeof purpose !== 'string' || purpose.trim() === '') return false
  return /设计|拆解|重做|改造|重构|改写|机制|规则|玩法|关卡|系统|方案|架构|部件|产品|稿件/.test(purpose)
}

/** The category label used in every render, e.g. `生活观察`. */
function categoryLabel(material) {
  return CATEGORY_NAMES[material.category] ?? material.category
}

/** Render the reading protocol printed above every draw. */
function renderProtocol(result) {
  const { request, pool } = result
  const lines = []
  // The horizon verdict leads, because it changes what the agent is expected to do
  // afterwards (record-and-forget vs. accumulate-and-distil).
  if (typeof result.horizonHeader === 'string') lines.push(result.horizonHeader)
  lines.push(`【素材 #${request.count}】${request.purpose === undefined ? '' : `针对：${request.purpose}`}`
    + (request.pairs === undefined ? '' : `（${request.pairs} 组碰撞对，每组 2 条）`))
  if (request.bias !== undefined) lines.push(`倾向：${request.bias}`)
  if (request.avoid !== undefined) lines.push(`回避：${request.avoid}`)
  if (request.violate) lines.push('约束违反模式：优先给「打破假设」的素材')
  lines.push('')
  lines.push(`**阅读要求**：逐条读完，每条花一点时间把它强行映射到当前问题上；映射不上就说明原因，别急着跳过。`)
  lines.push(`**请注意**：这批素材大概率有 0~1 条真的会进入你的工作——这是正常的。研究是长期、多次试错的过程，`
    + `而现在看不出用处的素材，往往在很久以后才显出价值；**插件不会因为你用不上就降权**。`)
  lines.push(`**读完必须调用** \`serendipity_note\`：对真的影响了工作的那几条，写明 \`landed\`（它写进了哪个文件/哪一节，或改写了哪个决定）；`
    + `用不上的就如实记一笔。**自评「有用」不会增加统计，只有写明落点才算。**`)
  lines.push('（漏记的话，你下一次 draw 时插件会把这些素材的 id 直接提醒给你。）')
  if (typeof result.decomposeHint === 'string' && result.decomposeHint !== '') {
    lines.push('')
    lines.push(`**先拆再抽**：${result.decomposeHint}`)
  }
  for (const line of result.horizonGuidance ?? []) lines.push(line)
  lines.push('')
  lines.push(`素材库 ${pool.total} 条；本项目未读 ${pool.unseenBeforeDraw} 条，抽完后剩 ${pool.unseenAfterDraw} 条。`)
  if (pool.exhausted) {
    lines.push('⚠️ 本项目已基本读遍素材库，本次含重复素材。要么换视角重读，要么用 serendipity_learn 沉淀新素材。')
  }
  // On a campaign, hand back what this project already recorded — traced first,
  // then claimed, then merely noted. Not hits-only: what looked useless at the time
  // is exactly what a long task needs to be reminded of later.
  const recalled = result.recall ?? []
  if (recalled.length > 0) {
    lines.push('')
    lines.push('【本项目此前记录过的（你自己的记录，供参考、别重复走同一条路）】')
    for (const entry of recalled) {
      const where = entry.landed === undefined ? '' : `（落点：${entry.landed}）`
      lines.push(`   · ${entry.label}${where}：${entry.note}  [id=${entry.id}]`)
    }
  }
  // The delayed-payoff channel. Without this the only recorded landings are the ones
  // that happened immediately, and "it became useful later" can never be entered.
  const reconsider = result.reconsider ?? []
  if (reconsider.length > 0) {
    lines.push('')
    lines.push('【当时没找到落点，值得再看一眼的】')
    lines.push('这些都是你以前读过、写明了「用不上」的素材。**当时用不上不等于永远用不上**——'
      + '后来的进展可能正好需要它。扫一眼：如果现在真的对上了，就再调一次 serendipity_note 把 `landed` 补上'
      + '（插件会把落点补进原记录，并算出它隔了多久才用上）；还是对不上就不用管。')
    // The stronger the invitation, the higher the fabrication risk — and `landed` is
    // the only signal anything is computed from, so an invented location does not
    // merely add noise, it corrupts the one number that is supposed to be checkable.
    // This warning is not decoration: in a real session the agent very nearly
    // "found" a landing here, and only an out-of-band check of the repository
    // stopped it. State the verification step; do not just ask for a location.
    lines.push('**但不要为了填而填。** 写 `landed` 之前先核对：那条结构真的在产物里吗？'
      + '要具体到能指认的位置（哪个文件/哪一节，或改写了哪条决定）。'
      + '「过了很久，大概用上了」不是证据——**编造的落点比空着更糟**，'
      + '它是这里唯一被人核对的东西。查不出来就保持空白。')
    for (const entry of reconsider) {
      const age = entry.daysSinceFirstDraw === undefined ? '此前' : `${entry.daysSinceFirstDraw} 天前`
      lines.push(`   · ${entry.label}（${age}读过）：${entry.note}  [id=${entry.id}]`)
    }
  }
  return lines.join('\n')
}

/** Render one material as a reading card. */
function renderMaterial(material, index) {
  const lines = []
  const category = material.categoryName ?? categoryLabel(material)
  lines.push(`── ${index + 1}. ${material.label} ──〔${category}｜来源：${material.origin}｜结构：${material.structure}〕  id=${material.id}`)
  lines.push(`一句话：${material.summary}`)
  lines.push(`机理：${material.detail}`)
  lines.push(`↳ 桥接提示：${material.bridge}`)
  lines.push(`   结构标签：${material.structureTags.join('、')}${material.tags.length > 0 ? `｜其它标签：${material.tags.join('、')}` : ''}`)
  return lines.join('\n')
}

/**
 * Render a `scope: 'near'` result.
 *
 * This is a *task*, not a delivery: the agent already has search, and a static
 * local corpus of the user's own field would go stale in weeks. What the plugin
 * adds is the method — same-domain works are the baseline novelty is measured
 * against, so the useful output is the shared assumptions they all rest on,
 * because that is the thing worth attacking.
 */
function renderComparison(value) {
  const domain = typeof value.comparison.domain === 'string' && value.comparison.domain !== ''
    ? value.comparison.domain
    : '（未指定，请用 purpose 说明你的领域）'
  const count = value.comparison.count
  return [
    `【近处比较分析：${domain}】`,
    '',
    `这一步**不抽素材**。同领域素材的作用不是给你灵感，而是给你**基准**——`,
    `你的作品是否新颖，只能在它已经存在的东西面前判定。`,
    '',
  ].concat(
    typeof value.comparison.previous === 'string' && value.comparison.previous !== ''
      ? [
        '**你（或上一次会话）已经对同一领域做过分析，以下是已保存的版本**——',
        '不必从零重查：先核对它是否仍然成立、补上新的作品与新的空白，然后覆盖保存。',
        '',
        '--- 已保存的分析 ---',
        value.comparison.previous.trim(),
        '--- 已保存的分析结束 ---',
        '',
      ]
      : [],
  ).concat([
    `请按下面四步做完（不要跳过任何一步）：`,
    '',
    `1. **找 ${count} 个真实存在的同领域作品**（用 web_search；要具体到名称，不要写"某类游戏"这种泛指）。`,
    `   每个都要能说出它做了什么、放弃了什么。`,
    '',
    '2. **逐个抽出它的骨架**——不要写它的内容，写它**怎么运转**：',
    '   · 它的唯一/核心动作是什么？',
    '   · 玩家的决策从哪来（信息差、资源约束、时序、博弈）？',
    '   · 它用什么机制制造难度或张力？',
    '   · 它**放弃**了哪些常见机制，为什么可以放弃？',
    '',
    '3. **找共同假设**（这一步最值钱）：把这几个作品的骨架叠在一起，',
    '   找出它们**全都默认成立、却没人质疑**的那一条。',
    '   例：都默认"玩家有手牌"、都默认"信息是隐藏的"、都默认"失败要可恢复"。',
    '   那个共同假设就是你这个领域当前的"天花板"，也是你下一步最该动的地方。',
    '',
    `4. **列出空白**：这 ${count} 个作品合起来**没有覆盖**哪些设计空间？`,
    '   哪些机制组合是它们都没想到、或者主动回避的？',
    '',
    '做完之后：把「共同假设」当成你要攻击的约束，用 `serendipity_decompose` 拆解，',
    '再用 `serendipity_draw({ bias: 该部件的结构标签 })` 去远域找替代结构——',
    '**near 负责指出该动哪里，far 负责提供动它的结构**。',
    '',
    '做完请务必用 `serendipity_learn({ kind: "saveAnalysis", domain, text })` 把分析存下来：',
    '这份分析很贵（多次检索 + 结构提取），而且不会很快过时；存下来以后同一领域的 near 分析会直接复用。',
    '',
    '注意：本工具返回的是**任务清单**，不是结果。你没有产出这些分析就等于没做这一步。',
    '',
    `（本机可达的检索来源见 serendipity_fetch 的说明；wikipedia/Reddit/HN/DuckDuckGo 在本机不可达。）`,
  ]).join('\n')
}

/**
 * Render the body of a `collide` draw: the pairs, grouped, with the move spelled out.
 *
 * The grouping is the whole point and it cannot be left to the flat list — two
 * materials in a row look like "two materials", not like "one shape seen twice". So the
 * render names the shared shape, prints both fields, and states the three-way mapping
 * (A, B, your problem) as the thing to produce.
 */
function renderCollisionBody(result) {
  const byId = new Map(result.items.map(material => [material.id, material]))
  const lines = []
  lines.push(`【这一批是碰撞对：同一个形状，两个不相干的领域】`)
  lines.push('')
  lines.push('普通抽取会**避免**一批里出现同一个结构形状（那样覆盖才宽）；这一批是反过来做的：'
    + '**刻意**给你同一个形状在两个远域里的两次出现。理由是——类比的力量不在「一条素材像我的问题」，'
    + '而在「**一个形状在两个地方都成立**」。两次出现互为对照：它们的共同点就是那个可迁移的骨架，'
    + '它们的差异就是它依赖什么条件。')
  lines.push('')
  lines.push('要产出的不是「我觉得像」，而是**三者的关系**：A 与 B 共享的那条结构，在你的问题里对应什么？'
    + 'A 成立而 B 不成立（或反过来）的地方，说明了那条结构的**适用边界**吗？边界往往比结构本身更有用。')
  let index = 0
  for (const pair of result.collisions ?? []) {
    const a = byId.get(pair.a)
    const b = byId.get(pair.b)
    if (a === undefined || b === undefined) continue
    index += 1
    lines.push('')
    lines.push(`══ 碰撞对 ${index}：结构核心「${pair.core}」 ══`)
    lines.push(`　A 来自「${a.origin}」，B 来自「${b.origin}」——两个领域不相干，形状是同一个。`)
    lines.push('')
    lines.push(renderMaterial(a, 0).replace(/^── 1\./, '── A.'))
    lines.push('')
    lines.push(renderMaterial(b, 1).replace(/^── 2\./, '── B.'))
    lines.push('')
    lines.push('　↳ 现在回答这三问：')
    lines.push(`　　· A 与 B 共享的那条结构，用一句话说是什么（不是它们的内容，是形状）？`)
    lines.push(`　　· 它在你手上的问题里对应哪个部件或哪条规则？`)
    lines.push(`　　· 有什么是「A 里有、B 里没有」的？那大概就是这条结构成立的条件。`)
    if (result.request?.bias !== undefined) {
      lines.push(`　（本批倾向：${result.request.bias}——你点名的形状优先，所以两组都可能落在同一个核心上。）`)
    }
  }
  return lines.join('\n')
}

/** Render a draw result in full. */
function renderDraw(result) {
  if (result.generation !== undefined) return renderGeneration(result.generation)
  if (result.comparison !== undefined) return renderComparison(result)
  if (result.items.length === 0) {
    return '素材库为空：请检查插件安装（lib/corpus/*.json 缺失）。'
  }
  const body = result.collisions !== undefined
    ? renderCollisionBody(result)
    : result.items.map(renderMaterial).join('\n\n')
  return `${renderProtocol(result)}\n\n${body}\n\n${renderProtocolFooter(result)}`
}

/** Render a `scope: 'generate'` result. */
function renderGeneration(generation) {
  if (generation.field === '') {
    return '领域地名志或结构词表为空：无法生成配对（检查 lib/fields.mjs 与 lib/structure-tags.mjs）。'
  }
  return [
    `【随机配对生成：${generation.field} × ${generation.core}】`,
    '',
    '这一步**不抽素材**：池子只有那么多条，而你已经读掉大半。'
    + '所以这次不说「给你什么」，而是**指定一个方向让你去造一条**——随机权在插件手上，不在搜索引擎手上。',
    '',
    ...generation.task.map(line => line),
    '',
    '## 要做的事',
    '',
    `1. **去「${generation.field}」里找一件真实存在的事**（用 serendipity_fetch 抓具体页面，或先用 web_search 找）；`
    + '要找的是**做法/现象/规程**，不是新闻。',
    `2. **写出它的机理**：为什么有效、为什么反直觉。只复述现象不算——合起来要能回答`
    + `「它凭什么在『${generation.core}』这个形状上成立」。`,
    `3. **提炼成一条可迁移素材**（\`structure\` 是形状不是内容；\`detail\` 写机理；\`bridge\` 是一个逼人做关系对齐的问句；`
    + `\`structureTags\` 里应当包含「${generation.core}」或与它同义的受控标签），然后用 \`serendipity_learn\` 入库。`,
    `4. **入库之后立刻记落点**：用 \`serendipity_note\` 写明它落在你作品的哪里。`
    + '**不入库也能记**——直接给一个 `label` 或自起的 `id` 即可，插件会把它算作「外部素材」，落点照样算数。',
    '',
    '## 三条约束（为什么这样要求）',
    '',
    `· **不要换成你已经熟悉的领域。** 抽到这里就是为了拿到一个不是你选的方向；换个「顺手」的领域等于把这一步作废。`
    + (generation.alternates.length > 0
      ? `真的说不通时，允许换成 ${generation.alternates.join(' / ')}，但要写明为什么原配对不成立。`
      : ''),
    '· **提炼不出可迁移结构就如实说**，不要为了完成任务塞一条「只能用在原文语境里」的素材进去——'
    + 'lint 会拒（`detail` 必须讲机理），而且它会污染以后所有抽取。',
    '· **一次一条就够。** 这一步的价值在于方向是随机的，不在于产量。',
    '',
    `（本对是否已经出现过：本项目已记住 ${generation.recent ?? 0} 组配对，插件会避开最近用过的组合；`
    + `候选领域 ${generation.considered.fields} 个、候选结构核心 ${generation.considered.cores} 个。）`,
  ].join('\n')
}

/** Closing lines of a draw render. */
function renderProtocolFooter(result) {
  const ids = result.items.map(material => material.id).join(', ')
  return `记录格式示例：serendipity_note({ items: [{ id: "${result.items[0].id}", hit: false, note: "结构对不上，这里的 X 与我的问题无关" }] })\n本条抽取的 id：${ids}`
}

/** Render the note acknowledgement. */
function renderNote(value) {
  const lines = [`已记录 ${value.accepted} 条。`]
  // An unresolvable entry no longer fails the call, so the message has to say what to
  // do about it. The old wording ("未识别 id（未写入）") read as "this is by design" and
  // a real session concluded exactly that, then dropped six of its best landings.
  if (value.unidentified.length > 0) {
    lines.push(`**有 ${value.unidentified.length} 条没写进去**（既没有 id，也没有 label）：${value.unidentified.join('、')}`)
    lines.push('每条至少要给一个 `id`（draw 给的、或你自己为外部素材起的）或者一个 `label`（结构的名字）。'
      + '注意：**只有 `hit` 没有 id/label 的条目无法入库**，而它的落点会一起丢掉——请补一次 `serendipity_note`。')
  }
  if (value.acceptedExternal > 0) {
    lines.push(`其中 ${value.acceptedExternal} 条是**外部素材**（不是本库抽出的，按 id/label 新建了记录）——`
      + '它们照常计入落点，但**不计入覆盖率**，因为库本来就没发过它们。')
  }
  // Landed is the first number because it is the only one that reaches the work;
  // the self-report is mentioned second and labelled as a claim.
  lines.push(`其中有落点（写明了结构去了哪里）${value.landed} 条；自评「有用」${value.claimedHits} 条（仅记录，不计入统计）。`)
  if (value.landedExternal > 0) {
    lines.push(`落点里有 ${value.landedExternal} 条来自外部素材——库里没有它们，所以覆盖度不受影响，但落点本身照样算数。`)
  }
  if (value.backedTransformations > 0) {
    lines.push(`有 ${value.backedTransformations} 条改变了问题定义，且给了改动前/后的对比。`)
  }
  // The nudge and the reassurance both belong to the **zero-landing** case. They were
  // unconditional once, so a real session's result said 「其中有落点 3 条」 and then
  // 「落点为 0 是正常的」 in adjacent lines — a self-contradiction printed by the tool
  // whose whole job is to report that number honestly.
  if (value.landed === 0) {
    if (value.claimedHits > 0) {
      lines.push('本次没有一条写明落点——如果它真的影响了工作，请指出它写进了哪里。')
    }
    lines.push('落点为 0 是正常的：研究本来就是一个长期、多次试错还不一定出结果的过程，素材的价值经常延迟兑现。')
  }
  // Re-note is a first-class move, not a correction of an error: the whole point of
  // a delayed payoff is that the first note could not have known.
  lines.push('**以后用上了就再说一次**：同一个 id 可以再次调用 serendipity_note 补上 `landed`，'
    + '插件会把落点补进原记录，并算出它从被读到用上隔了多久——这正是「当时用不上、后来有用」的记录方式。')
  if (value.stillUnread !== undefined) lines.push(`本项目仍有 ${value.stillUnread} 条素材未读。`)
  if (value.materialModelFile !== undefined) lines.push(`素材模型已追加到 ${value.materialModelFile}`)
  if (value.problems.length > 0) lines.push(`存储告警：${value.problems.join('；')}`)
  return lines.join('\n')
}

/** Build the four tools bound to one engine and store. */
export function createTools({ engine, store, readConfig }) {
  // The session report is the plugin's receipt: "this session drew at step 23 and three
  // materials landed". It is off entirely when the user turns it off — no recording, no
  // rendering — so a deployment that does not want the bookkeeping does not pay for it.
  // Read through a thunk rather than captured at mount: a settings change must take
  // effect on the next call without re-registering the tools.
  const sessionReportOn = () => (readConfig?.() ?? {}).sessionReport !== false

  /**
   * Fold one activity patch into this session's record (a no-op when the report is off).
   *
   * Called only after the durable write it describes has happened, so the metrics can
   * never claim activity the store did not record.
   *
   * @param {object} exec - the tool run context.
   * @param {object} increments - counters to add (see `lib/sessions.js`).
   * @param {{ first?: boolean }} [options] - `first: true` on a real draw, so the record keeps the *earliest* position.
   * @returns {void}
   */
  const recordSession = (exec, increments, options = {}) => {
    if (!sessionReportOn()) return
    try {
      store.recordSessionActivity(cwdOf(exec), sessionOf(exec), {
        position: sessionPosition(exec),
        increments,
        first: options.first === true,
      })
    } catch {
      // Metrics are a receipt, never a dependency: losing one must not fail the tool
      // call that produced it.
    }
  }

  const drawTool = defineTool({
    name: 'serendipity_draw',
    description:
      'Draw random far-field "structural material" from a cross-domain corpus — a mechanism, practice, counterintuitive finding, everyday trick, formal structure, or artistic pattern, deliberately NOT about your field. '
      + 'Force a structural mapping onto your problem; most will miss and that ratio is the point. '
      + 'Use it when designing or deciding, when stuck or looping, when the task rewards novelty over correctness, or when you want to question a constraint you treat as fixed. Cheap; no justification needed. '
      + 'After reading, ALWAYS call serendipity_note (misses included).',
    parameters: {
      count: { type: 'integer', description: 'How many, 1-10. Default 3; 5-8 when genuinely stuck. With `collide`, this is how many PAIRS (1-3) instead.' },
      purpose: { type: 'string', description: 'What you are working on, one line.' },
      bias: { type: 'string', description: 'Optional steer: a category (他域规律/他域做法/反直觉发现/生活观察/形式系统/艺术结构), a structure tag (反馈/阈值/自催化/冗余/对称破缺...), or a source field (生物学/音乐/考古学...). Full vocabulary: serendipity_stats. With `collide`, a structure tag here pins every pair to that shape.' },
      avoid: { type: 'string', description: 'Optional: what to steer away from.' },
      violate: { type: 'boolean', description: 'True when you want material that breaks a rule rather than adds a technique.' },
      allowRepeat: { type: 'boolean', description: 'Allow materials this project already drew. Default false.' },
      collide: { type: 'boolean', description: 'True = hand back PAIRS instead of a spread batch: two materials built on the SAME structural shape, taken from two source fields as far apart as possible, to be mapped against your problem together. Use it when you want one shape seen twice from unrelated fields (the strongest analogical move); leave it off when you want breadth.' },
      scope: { type: 'string', enum: ['far', 'near', 'generate'], description: "'far' (default): cross-domain material. 'near': no draw — returns a comparison task for your OWN field (find 3-5 real existing works, extract their skeletons, find the assumptions they all share). Same-domain works are the baseline your novelty is measured against. Use 'near' for \"what has already been made here?\"; then 'far' once you know which shared assumption to attack. 'generate': no draw either — hands back one random (source field × structure core) pair to MAKE material from, for when the pool is nearly read through and you want a direction nobody chose for you." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pool: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              unseenBeforeDraw: { type: 'integer', required: true },
              unseenAfterDraw: { type: 'integer', required: true },
              exhausted: { type: 'boolean', required: true },
            },
          },
          request: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer', required: true },
              pairs: { type: 'integer' },
              bias: { type: 'string' },
              violate: { type: 'boolean', required: true },
            },
          },
          // `collide` grouping: which materials form which pair, and on what shape.
          // Declared here or the Renderer cannot group them (same trap as `categoryName`).
          collisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                core: { type: 'string', required: true },
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
              },
            },
          },
          horizon: { type: 'string', required: true },
          horizonHeader: { type: 'string', required: true },
          horizonGuidance: { type: 'array', items: { type: 'string' }, required: true },
          // Present only when this project has never decomposed anything and the purpose
          // reads like design work. Must be declared here or the Renderer cannot see it.
          decomposeHint: { type: 'string' },
          recall: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                note: { type: 'string', required: true },
                category: { type: 'string' },
                // Must be declared here: the Renderer only receives fields named in
                // the output schema, so an undeclared `landed` renders as undefined.
                landed: { type: 'string' },
              },
            },
          },
          reconsider: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                note: { type: 'string', required: true },
                category: { type: 'string' },
                daysSinceFirstDraw: { type: 'integer' },
              },
            },
          },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                category: { type: 'string', required: true },
                categoryName: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                structure: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                detail: { type: 'string', required: true },
                bridge: { type: 'string', required: true },
                structureTags: { type: 'array', items: { type: 'string' }, required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
              },
            },
          },
          comparison: {
            type: 'object',
            additionalProperties: false,
            properties: {
              domain: { type: 'string' },
              count: { type: 'integer', required: true },
              previous: { type: 'string' },
            },
          },
          // `scope: 'generate'` returns a task, not material. Declared here or the
          // Renderer receives nothing to draw from (the same trap as `categoryName`).
          generation: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string', required: true },
              core: { type: 'string', required: true },
              family: { type: 'string', required: true },
              lens: { type: 'string' },
              alternates: { type: 'array', items: { type: 'string' }, required: true },
              task: { type: 'array', items: { type: 'string' }, required: true },
              considered: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  fields: { type: 'integer', required: true },
                  cores: { type: 'integer', required: true },
                },
              },
              recent: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => text(renderDraw(value)),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)

      // `near` is a different job, so it takes a different path: no corpus draw,
      // no reading state, no repetition bookkeeping. It hands back a comparison
      // task over the *agent's own* field, which the agent satisfies with search.
      if (args.scope === 'near') {
        const domain = typeof args.purpose === 'string' && args.purpose !== '' ? args.purpose : undefined
        const comparison = {
          count: clamp(args.count, 3, 5, 4),
        }
        if (domain !== undefined) comparison.domain = domain
        // A saved analysis is expensive to produce and does not rot quickly, so
        // hand it back as a base instead of paying for it twice.
        const previous = domain === undefined ? undefined : readAnalysis(store, domain)
        if (previous !== undefined) comparison.previous = previous.text
        return { pool: emptyPool(), request: baseRequest(), items: [], comparison }
      }

      // `generate` is the answer to "the pool is only as random as its 115 entries".
      // It hands back a (field × structure core) pair to *make* material from instead of
      // delivering material — no draw is recorded, nothing is marked as read, and the
      // dedup budget is untouched, because nothing was served.
      if (args.scope === 'generate') {
        // Coverage is reused rather than reinvented: `effectivenessFor` already answers
        // "which structural shapes has this project read least", which is exactly the
        // question worth asking when choosing what to make next.
        const effectiveness = engine.effectivenessFor(cwd)
        const pair = drawPair({
          cores: CONTROLLED,
          coreMultiplier: (core) => effectiveness.coreMultiplier([core]),
          coveredOrigins: coveredOriginsFor(store, cwd),
          recent: store.generatedPairs(cwd),
          random: engine.random,
        })
        if (pair === undefined) {
          return {
            pool: emptyPool(),
            request: baseRequest(),
            items: [],
            generation: { field: '', core: '', family: '', task: [], alternates: [], considered: { fields: 0, cores: 0 } },
          }
        }
        store.recordGenerated(cwd, pair)
        return {
          pool: emptyPool(),
          request: baseRequest(),
          items: [],
          generation: {
            field: pair.field,
            core: pair.core,
            family: pair.family,
            lens: pair.lens,
            alternates: pair.alternates,
            task: generationTask(pair),
            considered: pair.considered,
            recent: store.generatedPairs(cwd).length,
          },
        }
      }

      // Anything left over from an earlier draw is surfaced alongside this one's
      // result, so an unrecorded batch cannot silently rot.
      const forgotten = outstanding(exec)

      // `collide` is still a **delivery**: both materials are served, recorded as read
      // and counted against the dedup budget, exactly like an ordinary draw. Only the
      // selection changes — pairs that share a structural shape while their source
      // fields are as far apart as the corpus allows.
      const collide = args.collide === true
      const result = collide
        ? engine.collide(cwd, {
          count: clamp(args.count, 1, 3, COLLIDE_DEFAULT_PAIRS),
          purpose: args.purpose,
          bias: args.bias,
          avoid: args.avoid,
          allowRepeat: args.allowRepeat === true,
        })
        : engine.draw(cwd, {
          count: clamp(args.count, 1, 10, 3),
          purpose: args.purpose,
          bias: args.bias,
          avoid: args.avoid,
          violate: args.violate === true,
          allowRepeat: args.allowRepeat === true,
        })
      store.recordDraw(cwd, result.items, { purpose: args.purpose, bias: args.bias })
      addPending(exec, result.items.map(material => material.id))
      // The reminder rides the *next* request as a plugin-sourced context, so it
      // is read while the just-drawn materials are still fresh.
      if (forgotten.length > 0) exec.deferContext(noteReminderMessage(forgotten))
      // `first: true` — the receipt's headline number is how *early* the plugin got
      // used, so only the first delivery may stamp the position.
      recordSession(exec, {
        draws: 1,
        itemsServed: result.items.length,
        ...(forgotten.length > 0 ? { reminders: 1 } : {}),
      }, { first: true })
      // The canonical value must be *lossless JSON* — the registry rejects any
      // `undefined` member — so optional fields are omitted, never set to
      // undefined. (Caught by the integration test the hard way.)
      const pool = {
        total: result.pool.total,
        unseenBeforeDraw: result.pool.unseenBeforeDraw,
        unseenAfterDraw: result.pool.unseenAfterDraw,
        exhausted: result.pool.exhausted,
      }
      const request = {
        count: result.request.count,
        violate: result.request.violate,
      }
      if (result.request.bias !== undefined) request.bias = result.request.bias
      // With `collide`, `count` in the render means materials (2 per pair), so the pair
      // count travels separately — the render says "N 组碰撞对，共 2N 条" from both.
      if (result.request.pairs !== undefined) request.pairs = result.request.pairs
      // The plugin classifies the project itself rather than asking the model for a
      // `horizon` parameter: a free-choice parameter carries no information, while
      // draw counts and recorded outcomes are real evidence.
      const project = store.readProject(cwd)
      const horizon = classifyHorizon(project)
      const guidance = horizonGuidance(horizon)
      const recalled = horizon.kind === 'campaign' ? recallNotes(project) : []
      // A one-time suggestion, and only for work that is shaped like a design task.
      // Evidence for it: in a real session whose entire subject was redesigning a game
      // (including the user asking "does it really need shuffling?" — the exact example
      // in `serendipity_decompose`'s own description) the tool was never called once,
      // because the model reads this render and not the tool list. It stays a one-time
      // hint: a suggestion that repeats every draw is noise, not guidance.
      const decomposeHint = suggestDecompose(args.purpose) && store.toolUses(cwd, 'decompose') === 0
        ? '这一步先别急着抽素材：把作品拆成部件、把「现状」改写成「假设」之后，再对每个假设来抽，命中率会高得多。'
          + '用 `serendipity_decompose({ artifact, goal, parts })` —— 它会对每个部件强制追问「整块去掉会退化成什么」「替代它的 2~3 种做法」，'
          + '这两种问法是描述现状交不了差的。（本项目还没用过这个工具，所以这里提醒一次；用过之后就不会再提。）'
        : undefined
      // Material this project read, wrote about, and never found a place for. Some of
      // it simply did not fit; some of it did not fit *yet*. Handing a couple back is
      // the only mechanism that can ever record the second case, and since `landed` is
      // stamped when the note is written, without this the credited signal stays
      // permanently biased toward whatever was usable immediately.
      //
      // Anything already quoted by `recall` is dropped: an old unlanded note can also
      // be among the most recent six, and the same material listed twice in one result
      // reads as two different items. Ask for extra so the group still fills up.
      const quoted = new Set(recalled.map(entry => entry.id))
      const reconsider = store.unlandedNotes(cwd, {
        limit: RECONSIDER_LIMIT + quoted.size,
        minAgeMs: RECONSIDER_MIN_AGE_MS,
        byId: engine.byId,
      }).filter(entry => !quoted.has(entry.id)).slice(0, RECONSIDER_LIMIT)
      return {
        pool,
        request,
        horizon: horizon.kind,
        horizonHeader: guidance.header,
        horizonGuidance: guidance.guidance,
        ...(decomposeHint !== undefined ? { decomposeHint } : {}),
        ...(collide && result.pairs.length > 0 ? { collisions: result.pairs } : {}),
        ...(recalled.length > 0 ? { recall: recalled } : {}),
        ...(reconsider.length > 0 ? { reconsider } : {}),
        // Only the canonical value crosses the boundary; ids travel with it so
        // the model can name them in serendipity_note without a second lookup.
        items: result.items.map(material => ({
          id: material.id,
          label: material.label,
          category: material.category,
          categoryName: categoryLabel(material),
          origin: material.origin,
          structure: material.structure,
          summary: material.summary,
          detail: material.detail,
          bridge: material.bridge,
          structureTags: material.structureTags,
          tags: material.tags,
        })),
      }
    },
  })

  const noteTool = defineTool({
    name: 'serendipity_note',
    description:
      'Record what happened when you tried to use drawn materials — one entry per material, engaged or not. '
      + 'Call it after EVERY serendipity_draw: a recorded miss is what stops the same material coming back. '
      + 'THE CREDITED FIELD IS `landed`, NOT `hit`: name the place the structure actually went (a file + section, or the decision it rewrote). '
      + 'A hit that cannot name a location is recorded but not counted — being useful in conversation is not the same as reaching the work. '
      + 'If the material changed what the problem IS, put the before and after in `changedFrom`/`changedTo`; an unbacked claim of change is not counted either. '
      + 'NOT ONLY DRAWN MATERIAL: a structure you met elsewhere (a page you fetched, an article, your own reading) can be recorded too — give it an `id` of your own or just a `label`, '
      + 'and its `landed` counts the same way. It is reported separately because it is not corpus coverage. '
      + 'COME BACK LATER: an idea that looks useless today can become the hinge of the work once other things move. Re-call this tool for an id you noted before, '
      + 'with the `landed` you could not write the first time — the trace is added to the original record, and the gap between reading and using it is what the stats watch for. '
      + 'There is no penalty for a miss and no reward for a hit: research pays off later, and a structure that looks useless today may matter in a month. '
      + 'Optionally pass materialModel to record what you are learning about the corpus.',
    parameters: {
      items: {
        type: 'array',
        required: true,
        // One shape, not a `oneOf`. The obvious encoding — a bare branch plus a
        // branch that also accepts `landed` — is not expressible here: the second
        // is a superset of the first, so anything carrying `note` matches BOTH and
        // the validator rejects it ("must match exactly one oneOf branch"). The
        // rule that actually matters is a counting rule (`landed` counts only when
        // it names a place, a transformation only with before AND after), and that
        // belongs in the code below, where it can be exact.
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Deliberately NOT `required`. A missing id used to fail the whole call
            // during schema validation — before any plugin code could run — so in a
            // real session one malformed entry out of eight discarded all eight,
            // including the landings the agent had just written into its document.
            // An unresolvable entry is now reported with an actionable message while
            // its siblings are still recorded.
            id: { type: 'string', description: 'Draw id from a previous serendipity_draw, a learned material id, or any id of your own for a structure that came from elsewhere. Omit only when you give `label` instead.' },
            label: { type: 'string', description: 'What the structure is called. Used when `id` is omitted: matches a corpus material by title, otherwise records a new external trace.' },
            hit: { type: 'boolean', required: true, description: 'Your own judgement that it helped. Recorded, but NOT counted as evidence.' },
            note: { type: 'string', description: 'What you mapped it onto, and what happened.' },
            transformation: { type: 'boolean', description: 'Claimed change to the problem itself. Only counted with changedFrom + changedTo.' },
            landed: { type: 'string', description: 'WHERE the structure went, e.g. "docs/设计.md §3 闸门规则" or "改写了此前的通关判据（第 2 节）". Omit if it never reached the work; pass "" to withdraw a location recorded earlier.' },
            changedFrom: { type: 'string', description: 'The problem definition BEFORE the change (only when transformation=true).' },
            changedTo: { type: 'string', description: 'The problem definition AFTER the change.' },
          },
        },
        description: 'One entry per material.',
      },
      materialModel: { type: 'string', description: 'Optional: your updated view of the corpus. Appended to MATERIAL-MODEL.md.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'integer', required: true },
          acceptedExternal: { type: 'integer', required: true },
          unidentified: { type: 'array', items: { type: 'string' }, required: true },
          landed: { type: 'integer', required: true },
          landedExternal: { type: 'integer', required: true },
          claimedHits: { type: 'integer', required: true },
          backedTransformations: { type: 'integer', required: true },
          stillUnread: { type: 'integer' },
          materialModelFile: { type: 'string' },
          problems: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => text(renderNote(value)),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      // `landed` / `changedFrom` / `changedTo` merge onto the previous record when
      // absent (a re-note is a correction, not a replacement) and can be withdrawn
      // by passing an empty string — "it turned out not to be in the work after all".
      const trimmed = (value) => (typeof value === 'string' ? value.trim() : undefined)
      const notes = (args.items ?? []).map(item => {
        const note = {
          hit: item.hit === true,
          note: item.note,
          transformation: item.transformation === true,
          landed: trimmed(item.landed),
          changedFrom: trimmed(item.changedFrom),
          changedTo: trimmed(item.changedTo),
        }
        const id = trimmed(item.id)
        const label = trimmed(item.label)
        // Optional members are omitted rather than set to `undefined`: the store
        // merges by key presence, and `undefined` would erase a previous value.
        if (id !== undefined && id !== '') note.id = id
        if (label !== undefined && label !== '') note.label = label
        return note
      })
      // Ids the caller named are settled even when they carried no id (a label-only
      // note still clears the reminder for whatever it matched, which the store
      // resolves); unresolved ones keep their reminder alive.
      const outcome = store.recordNotes(cwd, notes, engine.byId)
      settlePending(exec, outcome.settled.map(entry => entry.id))
      // The receipt's other half: how much of what was served got written up, and how
      // much of it named a place. `noted` counts *first* notes and `landed` counts
      // landings this call **established**, so re-noting an id (which is exactly how a
      // delayed payoff gets recorded) adds to neither — while the delayed landing itself
      // still counts, because it is new information the first note could not have had.
      recordSession(exec, {
        notes: 1,
        noted: outcome.settled.filter(entry => entry.firstNote).length,
        landed: outcome.settled.filter(entry => !entry.external && entry.landedNew).length,
        externalLanded: outcome.settled.filter(entry => entry.external && entry.landedNew).length,
      })
      let materialModelFile
      if (typeof args.materialModel === 'string' && args.materialModel.trim() !== '') {
        materialModelFile = store.appendMaterialModel(args.materialModel).file
      }
      // `seenIds` excludes external traces, so intersect with the corpus before
      // subtracting: an id left over from a since-removed user material would
      // otherwise make this count too low.
      const seenInCorpus = [...store.seenIds(cwd)].filter(id => engine.byId.has(id)).length
      const unique = new Set(engine.materials.map(material => material.id)).size
      const value = {
        accepted: outcome.accepted,
        acceptedExternal: outcome.acceptedExternal,
        unidentified: outcome.unidentified,
        // `landed` is the credited signal; `claimedHits` is recorded but not
        // counted, and the render says so. A transformation claim only counts with
        // both before and after. External traces are counted apart from the corpus
        // figures so "of what the library served you" stays readable.
        //
        // Counted from the store's per-note resolutions, never from the arguments: a
        // label-only note that matched a corpus material by title has no id in the
        // arguments, and re-deriving here would file a corpus landing as external.
        landed: outcome.settled.filter(entry => !entry.external && entry.landed).length,
        landedExternal: outcome.settled.filter(entry => entry.external && entry.landed).length,
        claimedHits: outcome.settled.filter(entry => entry.hit).length,
        backedTransformations: outcome.settled.filter(entry => entry.backed).length,
        stillUnread: Math.max(0, unique - seenInCorpus),
        problems: store.drainProblems(),
      }
      // Optional members are omitted rather than set to `undefined`: the output
      // contract requires a lossless-JSON value.
      if (materialModelFile !== undefined) value.materialModelFile = materialModelFile
      return value
    },
  })

  const learnTool = defineTool({
    name: 'serendipity_learn',
    description:
      'Add knowledge to the library. Three modes, chosen with `kind`: '
      + '`add` (default) contributes one portable structural material — the far-field structure you just discovered, for a future unrelated project; '
      + '`saveAnalysis` stores a finished same-domain comparison (the work produced by serendipity_draw with scope:"near"), so the next near-draw on that field reuses it instead of paying for the searches again; '
      + '`readAnalysis` fetches one back. '
      + 'For `add`: the material must be stated structurally, portable beyond the field it came from, and stated with the mechanism rather than just the fact. '
      + 'Stored under ~/.dsh/dsh-serendipity/, not in the plugin package.',
    parameters: {
      kind: { type: 'string', enum: ['add', 'saveAnalysis', 'readAnalysis'], description: 'add (default) / saveAnalysis / readAnalysis.' },
      // add
      label: { type: 'string', description: 'add: short title.' },
      origin: { type: 'string', description: 'add: source field, e.g. 流体力学 / 民间工艺 / 生态学. Specific beats vague.' },
      structure: { type: 'string', description: 'add: the transferable shape, e.g. 延迟反馈导致的振荡 / 用冗余换鲁棒性.' },
      summary: { type: 'string', description: 'add: one sentence, what it is (20-40 字).' },
      detail: { type: 'string', description: 'add: the mechanism — why it works, why it is counterintuitive. Without this far transfer is impossible.' },
      bridge: { type: 'string', description: 'add: a question or imperative forcing a future reader to map the structure onto THEIR problem.' },
      category: { type: 'string', enum: ['pattern', 'device', 'surprise', 'everyday', 'formal', 'aesthetic'], description: 'add: pattern=他域规律 device=他域做法 surprise=反直觉发现 everyday=生活观察 formal=形式系统 aesthetic=艺术结构' },
      structureTags: { type: 'array', items: { type: 'string' }, description: 'add: 1-4 structure tags, e.g. 反馈/阈值/冗余. Reuse existing vocabulary (serendipity_stats).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'add: any additional topic tags.' },
      // analysis
      domain: { type: 'string', description: 'saveAnalysis / readAnalysis: the field, e.g. "小型解谜游戏".' },
      text: { type: 'string', description: 'saveAnalysis: the analysis body — the skeletons, the shared assumptions, the gaps.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          // add
          id: { type: 'string' },
          file: { type: 'string' },
          merged: { type: 'boolean' },
          corpusAfterReload: { type: 'integer' },
          // analysis
          domain: { type: 'string' },
          bytes: { type: 'integer' },
          text: { type: 'string' },
          items: { type: 'array', items: { type: 'string' }, required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderLearn(value)),
    },
    async execute(args, exec) {
      const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : 'add'

      if (kind === 'saveAnalysis') {
        const domain = typeof args.domain === 'string' ? args.domain.trim() : ''
        const body = typeof args.text === 'string' ? args.text.trim() : ''
        if (domain === '') return { ok: false, kind, items: [], error: 'saveAnalysis 需要 domain（要分析的是哪个领域）' }
        if (body.length < 40) return { ok: false, kind, items: [], error: `saveAnalysis 需要 text（分析正文只有 ${body.length} 字，太短了）` }
        try {
          const saved = saveAnalysis(store, domain, body)
          return { ok: true, kind, domain, file: saved.file, bytes: saved.bytes, items: [] }
        } catch (error) {
          return { ok: false, kind, items: [], error: error instanceof Error ? error.message : String(error) }
        }
      }

      if (kind === 'readAnalysis') {
        const domain = typeof args.domain === 'string' ? args.domain.trim() : ''
        if (domain === '') return { ok: false, kind, items: [], error: 'readAnalysis 需要 domain' }
        const found = readAnalysis(store, domain)
        const items = listAnalyses(store).map(entry => `${entry.slug}（${entry.bytes} 字节，${entry.updatedAt}）`)
        if (found === undefined) {
          return { ok: false, kind, domain, items, error: `没有「${domain}」的分析记录` }
        }
        return { ok: true, kind, domain, file: found.file, text: found.text, items }
      }

      if (kind !== 'add') {
        return { ok: false, kind, items: [], error: `未知 kind：${kind}（应为 add / saveAnalysis / readAnalysis）` }
      }

      const verdict = validateMaterial({ ...args, source: 'user' }, args.category)
      if (!verdict.ok) {
        return { ok: false, kind, items: [], error: `素材不合格：${verdict.reason}`, corpusAfterReload: engine.materials.length }
      }
      const material = { ...verdict.material, id: materialId(verdict.material.origin, verdict.material.label) }
      const merged = engine.existing(material.id) !== undefined
      try {
        const saved = store.saveUserMaterial(material)
        // Make it usable immediately: the engine's index is the live source.
        engine.byId.set(material.id, material)
        if (!merged) engine.materials.push(material)
        else engine.materials[engine.materials.findIndex(entry => entry.id === material.id)] = material
        return { ok: true, kind, id: material.id, file: saved.file, merged, corpusAfterReload: engine.materials.length, items: [] }
      } catch (error) {
        return { ok: false, kind, items: [], error: error instanceof Error ? error.message : String(error), corpusAfterReload: engine.materials.length }
      }
    },
  })

  const statsTool = defineTool({
    name: 'serendipity_stats',
    description:
      'Report the corpus and how well the loop is working: library size by category, how much this project has read, hit-rate and transformation-rate, the tag vocabulary for phrasing bias/avoid, and any corpus or storage warnings. '
      + 'Use it to look up the vocabulary before a biased draw, to see whether materials are paying off, or when the user asks how the plugin is doing.',
    parameters: {
      cwd: { type: 'string', description: 'Override the working directory for this project\'s history.' },
      sections: { type: 'array', items: { type: 'string', enum: ['library', 'vocabulary', 'usage', 'sessions', 'model', 'health'] }, description: 'Sections to include. Default: all.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          library: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              builtin: { type: 'integer', required: true },
              user: { type: 'integer', required: true },
              fields: { type: 'integer', required: true },
              byCategory: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    category: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    count: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              projectRead: { type: 'integer', required: true },
              remaining: { type: 'integer', required: true },
              projectDraws: { type: 'integer', required: true },
              draws: { type: 'integer', required: true },
              itemsServed: { type: 'integer', required: true },
              noted: { type: 'integer', required: true },
              landed: { type: 'integer', required: true },
              selfReportedHits: { type: 'integer', required: true },
              transformations: { type: 'integer', required: true },
              landedRate: { type: 'string', required: true },
              // Material the agent met outside the corpus (fetched pages, articles, its
              // own reading). Counted apart from the corpus figures on purpose: they
              // carry landings but they are not coverage.
              externalNoted: { type: 'integer', required: true },
              externalLanded: { type: 'integer', required: true },
            },
          },
          vocabulary: {
            type: 'object',
            additionalProperties: false,
            properties: {
              structureTags: { type: 'array', items: { type: 'string' }, required: true },
              tags: { type: 'array', items: { type: 'string' }, required: true },
              categories: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          effectiveness: {
            type: 'object',
            additionalProperties: false,
            properties: {
              minEvidence: { type: 'integer', required: true },
              totalRead: { type: 'integer', required: true },
              landed: { type: 'integer', required: true },
              selfReportedHits: { type: 'integer', required: true },
              readOrigins: { type: 'integer', required: true },
              optimizedFor: { type: 'string', required: true },
              // `medianDays` / `maxDays` are omitted when nothing has landed yet, so
              // they must stay optional (lossless-JSON contract).
              landedLag: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  landedWithKnownLag: { type: 'integer', required: true },
                  medianDays: { type: 'integer' },
                  maxDays: { type: 'integer' },
                  approximated: { type: 'integer' },
                },
              },
              categories: { type: 'array', items: { type: 'string' }, required: true },
              cores: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          model: { type: 'string' },
          // Per-session activity — the plugin's receipt. `current` is the live session
          // and is omitted until it has any activity; `recent` is the history of this
          // project's sessions, newest first.
          sessions: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reportEnabled: { type: 'boolean', required: true },
              current: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string', required: true },
                  current: { type: 'boolean', required: true },
                  lastAt: { type: 'string', required: true },
                  draws: { type: 'integer', required: true },
                  itemsServed: { type: 'integer', required: true },
                  notes: { type: 'integer', required: true },
                  noted: { type: 'integer', required: true },
                  landed: { type: 'integer', required: true },
                  externalLanded: { type: 'integer' },
                  reminders: { type: 'integer' },
                  decompose: { type: 'integer' },
                  firstDraw: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      turn: { type: 'integer', required: true },
                      step: { type: 'integer', required: true },
                      elapsedMs: { type: 'integer' },
                    },
                  },
                },
              },
              recent: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    sessionId: { type: 'string', required: true },
                    current: { type: 'boolean', required: true },
                    lastAt: { type: 'string', required: true },
                    draws: { type: 'integer', required: true },
                    itemsServed: { type: 'integer', required: true },
                    notes: { type: 'integer', required: true },
                    noted: { type: 'integer', required: true },
                    landed: { type: 'integer', required: true },
                    externalLanded: { type: 'integer' },
                    reminders: { type: 'integer' },
                    decompose: { type: 'integer' },
                    firstDraw: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        turn: { type: 'integer', required: true },
                        step: { type: 'integer', required: true },
                        elapsedMs: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          problems: { type: 'array', items: { type: 'string' }, required: true },
          locations: {
            type: 'object',
            additionalProperties: false,
            properties: {
              root: { type: 'string', required: true },
              projectFile: { type: 'string', required: true },
              materialModel: { type: 'string', required: true },
              userCorpus: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => text(renderStats(value)),
    },
    async execute(args, exec) {
      const wanted = Array.isArray(args.sections) && args.sections.length > 0
        ? new Set(args.sections)
        : new Set(['library', 'vocabulary', 'usage', 'sessions', 'model', 'health'])

      const cwd = args.cwd ?? cwdOf(exec)
      const stats = store.readStats()
      const composition = engine.composition()
      const project = store.readProject(cwd)
      const seen = store.seenIds(cwd)
      const vocabulary = wanted.has('vocabulary')
        ? tagVocabulary(engine.materials)
        : { tags: [], structureTags: [] }
      const problems = store.drainProblems()

      const value = {
        library: {
          total: composition.total,
          builtin: composition.builtin,
          user: composition.user,
          // The generation gazetteer's size, so "how many directions are there left"
          // is answerable without reading the source.
          fields: fieldCount(),
          byCategory: engine.categorySummary().map(entry => ({
            category: entry.category,
            name: entry.name,
            count: entry.count,
          })),
        },
        usage: {
          // `seen` counts corpus materials this project has drawn, so external traces
          // (which are not draws and are not in the corpus) stay out of the remaining
          // count on their own — no intersection needed here.
          projectRead: seen.size,
          remaining: Math.max(0, composition.total - [...seen].filter(id => engine.byId.has(id)).length),
          projectDraws: project.draws,
          draws: stats.draws,
          itemsServed: stats.itemsServed,
          noted: stats.noted,
          // Three counts, deliberately not merged: what reached the work, what the
          // agent *claimed*, and what it claimed about the problem itself. Only
          // the first is evidence; the other two are recorded for the reader.
          landed: stats.landed ?? 0,
          selfReportedHits: stats.selfReportedHits ?? 0,
          transformations: stats.transformations,
          landedRate: stats.itemsServed === 0 ? '—' : `${(((stats.landed ?? 0) / stats.itemsServed) * 100).toFixed(1)}%`,
          externalNoted: stats.externalNoted ?? 0,
          externalLanded: stats.externalLanded ?? 0,
        },
        vocabulary: {
          structureTags: vocabulary.structureTags.map(entry => `${entry.tag}(${entry.count})`),
          tags: vocabulary.tags.map(entry => `${entry.tag}(${entry.count})`),
          categories: engine.categorySummary().map(entry => `${entry.name}/${entry.category}(${entry.count})`),
        },
        effectiveness: (() => {
          const report = engine.effectivenessFor(cwd).report
          const label = (key) => CATEGORY_NAMES[key] ?? key
          // Ordered by how little has been read — the thing the weighting actually
          // optimizes. Sorting by a hit rate here would re-introduce exactly the
          // objective this module rejects.
          const shape = (rows, namer) => rows
            .filter(row => row.read > 0)
            .sort((a, b) => a.read - b.read || a.key.localeCompare(b.key))
            .map(row => `${namer(row.key)} 已读${row.read} 落点${row.landed} 权重×${row.multiplier.toFixed(2)}（${row.note}）`)
          // The lag distribution is the direct test of the design's central claim:
          // if structures really do become useful long after they were read, some
          // landings should show a large gap. Reported, never optimized for.
          const lagDays = report.overall.landedLagDays ?? []
          const lag = { landedWithKnownLag: lagDays.length }
          // Both fields are **omitted** when nothing has landed yet — the schema keeps
          // them optional for exactly this reason. Writing `medianDays: median(lagDays)`
          // looks equivalent because `JSON.stringify` drops `undefined`, but the tool
          // runtime snapshots the live value first and rejects the whole call with
          // "value is not lossless JSON": one `undefined` member costs the entire
          // report, on every project that has no landing lag to show yet (measured
          // 2026-10-13 — the stats tool was unusable in a live session).
          if (lagDays.length > 0) {
            lag.medianDays = median(lagDays)
            lag.maxDays = Math.max(...lagDays)
          }
          // Records written before `landedAt` existed still count, via `notedAt`, but
          // say so — otherwise a lag reading looks more exact than it is.
          const withoutStamp = report.overall.landedWithoutTimestamp ?? 0
          if (withoutStamp > 0) lag.approximated = withoutStamp
          return {
            minEvidence: MIN_EVIDENCE,
            totalRead: report.overall.read,
            landed: report.overall.landed,
            selfReportedHits: report.overall.selfReportedHits,
            readOrigins: report.readOrigins,
            optimizedFor: report.optimizedFor,
            // Not a target: optimization must not chase the lag, or it becomes the
            // hit-rate mistake again in another costume.
            landedLag: lag,
            categories: shape(report.categories, label),
            cores: shape(report.cores, (key) => key).slice(0, 15),
          }
        })(),
        // The receipt: what this session actually did, and what the previous sessions of
        // this project did. Descriptive only — nothing here feeds the draw weights.
        sessions: (() => {
          const enabled = sessionReportOn()
          const currentId = sessionOf(exec)
          const rows = enabled && wanted.has('sessions')
            ? store.sessions(cwd, { limit: SESSION_ROWS }).map(record => sessionRow(record, currentId))
            : []
          const current = rows.find(row => row.current === true)
          return {
            reportEnabled: enabled,
            ...(current !== undefined ? { current } : {}),
            recent: rows,
          }
        })(),
        problems,
        locations: {
          root: stateLayout().root,
          projectFile: store.projectFile(cwd),
          materialModel: stateLayout().materialModel,
          userCorpus: stateLayout().userCorpus,
        },
      }
      // Optional member: omitted rather than set to `undefined` (lossless-JSON contract).
      if (wanted.has('model')) value.model = store.readMaterialModel()
      return value
    },
  })

  return [drawTool, noteTool, learnTool, statsTool, makeDecomposeTool(store, recordSession), makeFetchTool()]
}

/**
 * The forced questions this tool hands back for every part.
 *
 * These are the whole point of the tool: a model asked to "analyse the parts"
 * will happily produce an inventory and stop. Each entry below is a question the
 * model must be able to answer in writing before the analysis counts as done, and
 * two of them (`alternatives`, `removeIt`) cannot be answered with prose about the
 * status quo at all — they demand a second design.
 */
const PART_QUESTIONS = [
  { key: 'function', label: '它现在承担什么功能', kind: 'describe' },
  { key: 'removal', label: '如果把它整块去掉，作品会退化成什么', kind: 'counterfactual' },
  { key: 'alternatives', label: '替代它完成同一功能的 2~3 种做法（至少一种完全不同的形态）', kind: 'design' },
  { key: 'cheapest', label: '哪个替代方案改动最小、且最可能打开新空间', kind: 'judge' },
  { key: 'farField', label: '哪个其它领域的结构能替代它（用 serendipity_draw 取素材，bias 填该部件的结构标签）', kind: 'cross-domain' },
]

/** The closing checks that make the difference between a list and an analysis. */
const OVERALL_CHECKS = [
  '**共同假设**：跨所有部件看一遍——它们共享了什么前提？那个前提是最该被质疑的东西。',
  '**配对替换**：任意取两个部件的替代方案同时采用，会不会产生一个单独改一个都得不到的新玩法？',
  '**真正不可动**：把你判定为「必然」的部件单独列出来。这份清单越短，作品的可改造空间越大；如果它很长，说明你把「习惯」当成了「必然」。',
  '**删到极限**：把所有可删的部件都删掉，剩下的最小可玩核心是什么？那个核心才是这个作品的身份。',
  '**信息通道**：玩家/读者是通过哪些通道获得反馈的（视觉、数字、声音、手感、时间）？有没有一个通道在独立承担全部信息？',
]

/** Render the decomposition scaffold. */
function renderDecomposition(value) {
  const lines = []
  lines.push(`【拆解分析：${value.artifact}】`)
  if (typeof value.goal === 'string' && value.goal !== '') lines.push(`目标：${value.goal}`)
  lines.push('')
  lines.push('**这是一套必须逐条回答的问题，不是一份可以只列清单的模板。**')
  lines.push(`每条「假设」都必须给出替代方案；只描述现状不算完成。`)
  lines.push('')

  for (const [index, part] of value.parts.entries()) {
    lines.push(`── ${index + 1}. ${part.name} ──`)
    if (typeof part.current === 'string' && part.current !== '') lines.push(`   现状：${part.current}`)
    lines.push('   逐条回答：')
    for (const question of PART_QUESTIONS) {
      lines.push(`     · ${question.label}`)
    }
    lines.push('')
  }

  if (value.declaredNecessary.length > 0) {
    lines.push('── 你已声明为「必然」的部件 ──')
    for (const name of value.declaredNecessary) lines.push(`   · ${name}`)
    lines.push('   对这些部件单独举证：为什么去掉它就不再是这个作品？（举不出就是「假设」，请改判。）')
    lines.push('')
  }

  lines.push('── 收尾检查（缺一不可）──')
  for (const check of OVERALL_CHECKS) lines.push(`   · ${check}`)
  lines.push('')
  lines.push(`部件共 ${value.parts.length} 个`)
  lines.push('拆完之后，对每个「假设」都用 serendipity_draw({ bias: "该部件的结构标签" }) 取远域素材找替代方案，'
    + '再把结果用 serendipity_note 记下来。')
  return lines.join('\n')
}

/** Render a fetch outcome plus the distillation demand. */
function renderFetch(value) {
  if (!value.ok) {
    return [
      `抓取失败：${value.url}`,
      `原因：${value.error}`,
      '',
      '本机实测可达的来源（2026-10-10 探测，46 个目标里 32 个可达）：',
      ...SOURCE_GROUPS.flatMap(group => [
        `【${group.kind}】`,
        ...group.items.map(hint => `  · ${hint}`),
      ]),
      '',
      '本机实测**不可达**：',
      `  · ${UNREACHABLE_HINTS.join('；')}`,
      '',
      '查询语法上的坑（每条都真实浪费过一次调用）：',
      ...QUERY_TRAPS.map(trap => `  · ${trap}`),
      '也可以用 web_search 先找到具体文章页，再拿 URL 来这里抓正文——首页和站内搜索页基本没有正文。',
      '**落点不必等入库**：从外部来源提炼出的结构，即使不入库，也可以直接写进 serendipity_note（自己起个 id，或给个 label），落点照样算数。',
    ].join('\n')
  }
  const kindLabel = { html: '网页', json: 'JSON', text: '纯文本' }[value.kind] ?? value.kind
  const lines = [
    `【抓取成功】${value.url}`,
    `HTTP ${value.status}｜类型 ${kindLabel}｜原始 ${value.bytes} 字节${value.truncated ? '（已截断）' : ''}`,
  ]
  if (value.indexPage === true) {
    // Measured: fetching a site homepage returned a few hundred menu labels and no
    // prose, and it was read as though it were content. The extraction is left
    // intact — the model can still see there is nothing here — but it is told.
    lines.push('⚠️ **这看起来是索引/导航页，不是文章正文**（大量短行、几乎没有长句）。'
      + '里面的内容基本不可用：请改用具体文章页（如 `机核 /articles/<id>`、`B站 /read/cv<id>`、`集石 /bbs/discuss-*`）'
      + '或搜索类 API（如 B站专栏搜索、少数派文章列表）。')
  }
  lines.push('')
  if (typeof value.focus === 'string' && value.focus !== '') lines.push(`检索意图：${value.focus}`, '')
  lines.push('--- 正文（截断至上限）---', value.text ?? '', '--- 正文结束 ---', '')
  lines.push(
    '**这份正文本身不是素材。** 网络信息大多不具启发性——它必须先被提炼成结构才有价值。',
    '请把它压缩成**一条**候选素材，满足下列要求后再用 `serendipity_learn` 入库：',
    '  · `structure`：可跨域迁移的**形状**（不是内容）。例：不是"某游戏的体力条"，而是"用消耗速率代替上限来做约束"。',
    '  · `detail`：讲清**机理**——为什么有效、为什么反直觉。只复述现象会被 lint 判为不合格。',
    '  · `bridge`：一个问句或祈使句，逼未来的读者把这条结构映射到**他自己的**问题上。',
    '  · `structureTags`：1~4 个受控结构标签（先查 `serendipity_stats` 的词表）；',
    '    `origin` 写真正的来源（站点/作者/领域），不要写"网络"。',
    '',
    '如果这份正文提炼不出可迁移的结构（很常见），**就不要入库**——',
    '宁可不沉淀，也不要往库里塞"只能用在原文语境里"的东西。',
    '',
    '**但落点不必等入库**：这条结构如果已经落进了你的作品，直接在 `serendipity_note` 里记一条就行'
    + '（自己起一个 id，或者给个 `label`）——不入库也能记落点，插件会把它算作「外部素材」。',
  )
  return lines.join('\n')
}

/** Build the networked fetch tool. */
function makeFetchTool() {
  return defineTool({
    name: 'serendipity_fetch',
    description:
      'Fetch a web page / API and get readable text back, for material the frozen corpus cannot have (recent discussions, new games, new papers). '
      + `Verified reachable from this host (2026-10-10 probe, 32/46 targets): ${REACHABLE_BRIEF}. `
      + `Not reachable — do not spend calls on them: ${UNREACHABLE_BRIEF}. `
      + `Query trap worth knowing before the first call: ${QUERY_TRAPS_BRIEF.join(' ')} `
      + 'Grab a specific article or API endpoint, never a site homepage: a homepage returns navigation, and this tool flags that case as `indexPage`. '
      + 'A fetched page is NOT material: reduce it to a portable structure with a mechanism, then save it with serendipity_learn. '
      + 'A structure that already reached your work can be recorded with serendipity_note directly (own id or a label) — it does not have to be learned into the corpus first. '
      + 'Prefer web_search first to find a reachable article URL, then fetch its text here.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http/https URL. For search APIs pass the full query URL.' },
      focus: { type: 'string', description: 'What you are looking for here, one line — echoed back to keep the distillation on target.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          status: { type: 'integer' },
          kind: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          // Present only when the extraction looks like a menu/list rather than an
          // article. Must be declared to reach the Renderer at all.
          indexPage: { type: 'boolean' },
          text: { type: 'string' },
          focus: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => text(renderFetch(value)),
    },
    async execute(args) {
      const outcome = await fetchReadable(String(args.url))
      const value = {
        ok: outcome.ok,
        url: outcome.url,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.kind !== undefined ? { kind: outcome.kind } : {}),
        ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}),
        ...(outcome.truncated !== undefined ? { truncated: outcome.truncated } : {}),
        ...(outcome.indexPage === true ? { indexPage: true } : {}),
        ...(outcome.text !== undefined ? { text: outcome.text } : {}),
        ...(typeof args.focus === 'string' && args.focus !== '' ? { focus: args.focus } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }
      return value
    },
  })
}

/** Build the decomposition tool. */
function makeDecomposeTool(store, recordSession) {
  return defineTool({
    name: 'serendipity_decompose',
    description:
      'Break a work into its component parts and question each one — "deliberately violating constraints" made operational. '
      + 'Use it when creating or redesigning something (a game, a mechanism, a system, a document) to find which parts are load-bearing and which are mere convention: '
      + 'does a card game really need shuffling? does it really need a "play" action? '
      + 'Returns a scaffold of forced questions: every part must be classed ASSUMPTION or NECESSITY, every assumption needs 2-3 alternatives including "remove it entirely", '
      + 'and the assumptions shared across parts must be named. The list is a checklist to fill in, not an answer — it is not done until alternatives exist. '
      + 'Pair with serendipity_draw (bias = the part\'s structure tags) for far-field replacements.',
    parameters: {
      artifact: { type: 'string', required: true, description: 'What you are decomposing: a game, a mechanism, a document, a method.' },
      goal: { type: 'string', description: 'What it is supposed to achieve — the standard every "necessary" claim is judged against.' },
      parts: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                current: { type: 'string' },
                status: { type: 'string', enum: ['assumption', 'necessity'] },
                note: { type: 'string' },
              },
            },
          ],
        },
        description: 'Your first-pass part list (each a name, or an object with name / current / status / note). '
          + 'Leave it out to be prompted for a full inventory instead — the tool will still return the question scaffold.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifact: { type: 'string', required: true },
          goal: { type: 'string' },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                current: { type: 'string' },
                note: { type: 'string' },
                status: { type: 'string', required: true },
              },
            },
          },
          declaredNecessary: { type: 'array', items: { type: 'string' }, required: true },
          emptyInventory: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text(renderDecomposition(value)),
    },
    async execute(args, exec) {
      const raw = Array.isArray(args.parts) ? args.parts : []
      const parts = []
      const declaredNecessary = []
      for (const entry of raw) {
        if (typeof entry === 'string') {
          if (entry.trim() !== '') parts.push({ name: entry.trim(), status: 'unknown' })
          continue
        }
        if (entry === null || typeof entry !== 'object') continue
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        if (name === '') continue
        const status = entry.status === 'necessity' ? 'necessity' : entry.status === 'assumption' ? 'assumption' : 'unknown'
        if (status === 'necessity') declaredNecessary.push(name)
        parts.push({
          name,
          status,
          ...(typeof entry.current === 'string' && entry.current !== '' ? { current: entry.current } : {}),
          ...(typeof entry.note === 'string' && entry.note !== '' ? { note: entry.note } : {}),
        })
      }
      // Recorded so the draw render stops offering this suggestion once it has been
      // taken, and so `stats` can answer "was this capability ever used?".
      if (store !== undefined) store.recordToolUse(cwdOf(exec), 'decompose')
      recordSession?.(exec, { decompose: 1 })
      return {
        artifact: String(args.artifact),
        ...(typeof args.goal === 'string' && args.goal !== '' ? { goal: args.goal } : {}),
        parts,
        declaredNecessary,
        emptyInventory: parts.length === 0,
      }
    },
  })
}

/**
 * Render a `serendipity_learn` outcome — one tool, three modes.
 *
 * Kept as one tool rather than two: `analysis` was a separate tool for a while and
 * it was the least-used of the set, because "save a finding" and "save an analysis"
 * are the same act on the caller's side. The `kind` distinguishes what is being
 * stored, not what the caller is doing.
 */
function renderLearn(value) {
  if (value.kind === 'saveAnalysis') {
    if (!value.ok) return `保存比较分析失败：${value.error}`
    return [
      `已保存「${value.domain}」的比较分析 → ${value.file}（${value.bytes} 字节）`,
      '以后再对同一领域做 `scope: "near"` 时，插件会先把这份内容取回来当基础，不用重新查一遍。',
      '（存的是你写的内容本身，插件不做加工；要更新直接再存一次即可覆盖。）',
    ].join('\n')
  }
  if (value.kind === 'readAnalysis') {
    const list = value.items.length > 0 ? `\n\n已保存的分析：${value.items.join('；')}` : ''
    if (!value.ok) return `读取比较分析失败：${value.error}${list}`
    return [`【${value.domain} 的比较分析】(${value.file})`, '', value.text].join('\n')
  }
  if (!value.ok) return `沉淀失败：${value.error}`
  return [
    `已沉淀素材 id=${value.id}${value.merged ? '（同 id 已存在，已覆盖）' : ''}`,
    `写入：${value.file}`,
    `下次插件加载后素材库为 ${value.corpusAfterReload} 条（本次会话内已即时生效）。`,
  ].join('\n')
}

/** Render the stats report for the model. */
/**
 * Project one stored session record into the stats output shape.
 *
 * Only the declared fields survive to the Renderer (a `categoryName`-style omission is
 * the classic silent `undefined` here), and optional members are omitted rather than set
 * to `undefined` — the lossless-JSON contract.
 *
 * @param {object} record - a stored session record from `lib/sessions.js`.
 * @param {string} currentId - the live session's id, for the `current` flag.
 * @returns {object} the output row.
 */
function sessionRow(record, currentId) {
  const row = {
    sessionId: String(record.sessionId ?? ''),
    current: record.sessionId === currentId,
    lastAt: String(record.lastAt ?? ''),
    draws: record.draws ?? 0,
    itemsServed: record.itemsServed ?? 0,
    notes: record.notes ?? 0,
    noted: record.noted ?? 0,
    landed: record.landed ?? 0,
  }
  for (const key of ['externalLanded', 'reminders', 'decompose']) {
    if ((record[key] ?? 0) > 0) row[key] = record[key]
  }
  const first = record.firstDraw
  if (first !== null && typeof first === 'object') {
    const shaped = { turn: first.turn ?? 0, step: first.step ?? 0 }
    if (first.elapsedMs !== undefined) shaped.elapsedMs = first.elapsedMs
    row.firstDraw = shaped
  }
  return row
}

function renderStats(value) {
  const lines = []
  const library = value.library
  lines.push(`【素材库】共 ${library.total} 条（内置 ${library.builtin}／沉淀 ${library.user}）`)
  lines.push(library.byCategory.map(entry => `${entry.name} ${entry.count}`).join('｜'))
  const usage = value.usage
  lines.push('')
  lines.push(`【本项目】已读 ${usage.projectRead} 条，剩 ${usage.remaining} 条；本项目抽取 ${usage.projectDraws} 次`)
  // Three numbers, never merged into one "rate": what reached the work, what the
  // agent claimed, and what it claimed about the problem itself. Only `landed`
  // is evidence — and research pays off so late that a low number here is not
  // failure.
  lines.push(`【累计】抽取 ${usage.draws} 次／发出 ${usage.itemsServed} 条；已记录 ${usage.noted} 条`)
  lines.push(`　其中写明落点的 ${usage.landed} 条（占发出量 ${usage.landedRate}）；`
    + `自评「有用」${usage.selfReportedHits} 条；声称改变问题定义的 ${usage.transformations} 条`)
  lines.push(`　（落点是唯一被计入统计的信号；自评与「改变定义」只做记录，不用来调权重。）`)
  if ((usage.externalLanded ?? 0) > 0 || (usage.externalNoted ?? 0) > 0) {
    // Reported next to the corpus figures rather than folded into them: the ratio on
    // the line above answers "of what this library served you", and material the
    // library never held would silently change that answer.
    lines.push(`　另有**外部素材**（你从网络/别处拿来的）${usage.externalNoted ?? 0} 条被记录，其中写明落点 ${usage.externalLanded ?? 0} 条。`
      + '它们计入落点、不计入覆盖率。')
  }
  if (value.vocabulary.categories.length > 0) {
    lines.push('')
    lines.push(`【bias 可用类别】${value.vocabulary.categories.join('、')}`)
    lines.push(`【bias 可用结构标签】${value.vocabulary.structureTags.slice(0, 30).join('、')}`)
    lines.push(`【bias 可用普通标签】${value.vocabulary.tags.slice(0, 40).join('、')}`)
  }
  const effectiveness = value.effectiveness
  if (effectiveness !== undefined) {
    lines.push('')
    lines.push(`【覆盖度（权重优化的目标）】本项目已读 ${effectiveness.totalRead} 条，覆盖 ${effectiveness.readOrigins} 个来源领域；`
      + `其中 ${effectiveness.landed} 条有落点、${effectiveness.selfReportedHits} 条自评有用`)
    lines.push(`　权重只按「读得少不少」倾斜（${effectiveness.minEvidence} 条读取历史起生效，范围 ×0.85 ~ ×1.25），`
      + '**不按命中率**——研究是长期过程，延迟兑现的素材不能被判负。')
    // The lag is the evidence for that claim, so the stats say it out loud rather
    // than leaving the design's central assumption untested.
    const lag = effectiveness.landedLag
    if (lag !== undefined && lag.landedWithKnownLag > 0) {
      lines.push(`　【延迟兑现】有落点的条目中，${lag.landedWithKnownLag} 条能算出「读了多久才用上」：`
        + `中位 ${lag.medianDays} 天、最长 ${lag.maxDays} 天。`
        + '（这个数字只用于观察，**不是优化目标**——去追它就会重犯「按自评学习」的错。）')
    } else if (effectiveness.landed === 0) {
      lines.push('　【延迟兑现】还没有任何条目写明落点，所以还看不出「读完之后多久才用上」。')
    }
    if (effectiveness.categories.length === 0) {
      lines.push('  还没有读取记录。')
    } else {
      lines.push(`  读得最少的类别：${effectiveness.categories.join('；')}`)
      lines.push(`  读得最少的结构：${effectiveness.cores.join('；')}`)
    }
  }
  if (typeof value.model === 'string' && value.model.trim() !== '') {
    lines.push('')
    lines.push('【素材模型（节选末尾）】')
    lines.push(value.model.trim().split('\n').slice(-18).join('\n'))
  }
  const sessions = value.sessions
  if (sessions !== undefined) {
    // The receipt. In a real session a single draw among 86 tool calls was invisible
    // — the user concluded the plugin had never been used, and the model had no way
    // to contradict them. Reported as a measurement, never as a grade.
    lines.push('')
    if (sessions.reportEnabled === false) {
      lines.push('【会话报告】已在设置里关闭（sessionReport: false）——不记录每次会话的抽取指标。')
    } else if (sessions.current === undefined) {
      lines.push('【本会话】还没有缪斯活动记录（本会话尚未抽取或记录过素材）。')
    } else {
      lines.push(`【本会话】${describeSession(sessions.current)}`)
      lines.push('　（状态目录里的 projects/<项目>.json 有完整历史；'
        + '`GET /api/dsh-serendipity/sessions` 也能读。）')
    }
    const earlier = (sessions.recent ?? []).filter(row => row.current !== true).slice(0, SESSION_ROWS - 1)
    if (earlier.length > 0) {
      lines.push('【最近几次会话】')
      for (const row of earlier) {
        lines.push(`　· ${String(row.lastAt).slice(0, 16).replace('T', ' ')}｜${describeSession(row)}`)
      }
    }
  }
  lines.push('')
  lines.push(`【存储位置】${value.locations.root}`)
  if (value.problems.length > 0) {
    lines.push(`【健康告警】${value.problems.join('；')}`)
  } else {
    lines.push('【健康】语料与状态文件无异常。')
  }
  return lines.join('\n')
}

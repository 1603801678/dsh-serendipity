/**
 * 随机配对生成：从「领域地名志 × 结构核心」里抽一对，交给模型去生成一条新素材。
 *
 * ## 它解决的是哪一个问题
 *
 * 抽取引擎的随机性只在**固定池子内部**发生：115 条素材，加权抽样 + 拥挤惩罚。
 * 池子抽干之后（真实项目里 100 多次抽取就会到这一步），「随机」就退化成「换个顺序重读」。
 * 而 `serendipity_learn` 只能补上模型碰巧遇到的东西——随机来源由**外部搜索引擎**决定，
 * 不是由插件决定。
 *
 * 这一层把两个已经存在的轴随机化：
 *
 * - **领域**（地名志，`lib/fields.mjs`）：无界，可以一直加。
 * - **结构核心**（受控词表，`lib/structure-tags.mjs`）：76 个，本身就是「可迁移形状」的枚举。
 *
 * 配对的结果不是一个素材，而是一个**生成任务**：去那个领域找一件真事，写出机理，再入库。
 * 素材的作者成本为零，来源面却是无界的。这不是把质量责任推给模型——`detail` 必须讲机理
 * 是 lint 的硬规则（`tools/lint-corpus.mjs`），提炼不出结构就不该入库。
 *
 * ## 抽样规则（都是有理由的，不是随手写的）
 *
 * - **避开已覆盖的领域**：与已读素材的 `origin` 词元重叠就降权，因为「远」是唯一信号，
 *   再抽一个已覆盖的领域等于浪费一次机会。
 * - **按覆盖度挑结构核心**：复用 `effectiveness.js` 的核心权重（读得少的权重高），
 *   让生成也朝着语料里没读透的方向走，而不是围着几种熟悉的结构打转。
 * - **记住最近抽过的对**：同一对（领域 + 核心）短期内不重复；真实项目里模型会反复
 *   落在自己熟悉的那几个领域上，没有记忆就会一直生成同一种素材。
 *
 * @module @1603801678/dsh-serendipity/generate
 */

import { FIELDS, FIELD_INDEX } from './fields.mjs'
import { EFFECTIVENESS_NEUTRAL } from './effectiveness.js'
import { overlapWith, tokenUnion } from './text.js'

/** 最近抽过多少对之内不再重复（按项目记）。 */
export const RECENT_PAIR_LIMIT = 24

/** 已覆盖来源领域的词元集合。 */
export function coveredTokens(origins) {
  return tokenUnion(origins)
}

/**
 * 一个候选领域的抽样权重。
 *
 * **导出是有意的**（与 `lib/draw.js` 的 `scoreMaterial` 同理）：权重的*预期*效果可以
 * 精确算出来，而*观察到的*效果只能靠抽样，而「1/(1+重叠)」这种温和的倾斜在大样本里
 * 也容易被噪声盖住。测试直接算精确分布，另外只对采样器做方向性断言。
 *
 * @param {string} field - 候选领域名。
 * @param {Set<string>} covered - 已覆盖领域的词元集合（`coveredTokens` 的输出）。
 * @returns {number} 正的权重（永不落零，地名志抽干时必须退化而不是失败）。
 */
export function fieldWeight(field, covered) {
  return 1 / (1 + overlapWith(field, covered))
}

/**
 * 在候选列表上做加权抽样（权重必须为正；全零时退化为均匀）。
 * @param {Array<{ key: string, weight: number }>} pool - candidates.
 * @param {() => number} random - uniform [0,1) source.
 * @returns {string} the chosen key.
 */
function weightedPick(pool, random) {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
  if (!(total > 0)) return pool[Math.floor(random() * pool.length) % pool.length].key
  let threshold = random() * total
  for (const entry of pool) {
    threshold -= entry.weight
    if (threshold <= 0) return entry.key
  }
  return pool.at(-1).key
}

/**
 * 抽一对（领域 × 结构核心）。
 *
 * @param {object} options - inputs.
 * @param {string[]} options.cores - controlled structure cores available.
 * @param {(core: string) => number} [options.coreMultiplier] - coverage weight per core
 *   (from `effectiveness.js`); omitted means every core is equally likely.
 * @param {string[]} [options.coveredOrigins] - source fields this project has already read.
 * @param {Array<{ field: string, core: string }>} [options.recent] - pairs drawn recently.
 * @param {() => number} [options.random] - uniform [0,1) source (injectable for tests).
 * @returns {{ field: string, family: string, lens: string, core: string, alternates: string[], considered: { fields: number, cores: number } } | undefined}
 *   the pair, or `undefined` when the gazetteer or the core list is empty.
 */
export function drawPair(options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random
  const cores = (options.cores ?? []).filter(core => typeof core === 'string' && core !== '')
  if (cores.length === 0 || FIELDS.length === 0) return undefined

  const recent = options.recent ?? []
  const recentFields = new Set(recent.map(entry => entry.field))
  const recentCores = new Set(recent.map(entry => entry.core))
  const covered = coveredTokens(options.coveredOrigins ?? [])

  // Field: weight 1, halved for anything already covered, and excluded outright when it
  // was drawn recently. The covered-but-not-recent ones stay eligible at low weight —
  // an exhausted gazetteer must degrade, not fail.
  const fieldPool = FIELDS
    .filter(field => !recentFields.has(field))
    .map(field => ({ key: field, weight: fieldWeight(field, covered) }))
  const fieldPooled = fieldPool.length > 0 ? fieldPool : FIELDS.map(field => ({ key: field, weight: 1 }))
  const field = weightedPick(fieldPooled, random)

  // Core: weighted toward the shapes this project has read least, using the same
  // coverage multipliers the draw engine leans on. Recently generated cores are skipped
  // so the next material is not another instance of the shape just made.
  const corePool = cores
    .filter(core => !recentCores.has(core))
    .map(core => ({ key: core, weight: (options.coreMultiplier?.(core)) ?? EFFECTIVENESS_NEUTRAL }))
  const corePooled = corePool.length > 0
    ? corePool
    : cores.map(core => ({ key: core, weight: 1 }))
  const core = weightedPick(corePooled, random)

  // Two alternates: the task is a generation prompt, and a single forced pair invites
  // writing something generic to satisfy it. Named alternatives make "this combination
  // does not fit" a legitimate answer instead of a silent failure.
  const alternates = []
  const remaining = fieldPooled.filter(entry => entry.key !== field)
  for (let i = 0; i < 2 && remaining.length > 0; i += 1) {
    const pick = weightedPick(remaining, random)
    alternates.push(pick)
    remaining.splice(remaining.findIndex(entry => entry.key === pick), 1)
  }

  const family = FIELD_INDEX.get(field)
  return {
    field,
    family: family?.name ?? '未分类',
    lens: family?.lens ?? '',
    core,
    alternates,
    considered: { fields: fieldPooled.length, cores: corePooled.length },
  }
}

/**
 * 把这一对带进渲染时需要的那几行。
 *
 * @param {object} pair - the output of `drawPair`.
 * @returns {string[]} the task lines.
 */
export function generationTask(pair) {
  return [
    `**领域**：${pair.field}（属「${pair.family}」）`,
    pair.lens === '' ? '' : `　这个领域的看点是：${pair.lens}`,
    `**结构核心**：${pair.core}`,
    pair.alternates.length > 0 ? `　如果这一对实在说不通，可以换成：${pair.alternates.join(' / ')}（换之前先说明为什么对不上）` : '',
  ].filter(line => line !== '')
}

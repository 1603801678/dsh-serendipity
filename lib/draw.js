/**
 * The draw engine — how materials get selected.
 *
 * Two things matter here, and they pull in opposite directions:
 *
 * 1. **Relevance**: the agent states what it is working on and what kind of help
 *    it wants, and the draw should lean toward materials whose tags match.
 * 2. **Distance**: the whole point of the plugin is *far* transfer, so every
 *    selection must maximize spread — across source fields, across categories,
 *    across structural types — and must avoid repeating what this project has
 *    already seen.
 *
 * The resolution is a penalty-augmented weighted sample: candidates are scored
 * for relevance, then picked one at a time, with each pick diminishing the
 * eligibility of everything that shares its origin, category, or structure. The
 * same machinery serves the `violate` switch, which simply biases the relevance
 * term toward materials that break a constraint instead of adding one.
 *
 * @module @1603801678/dsh-serendipity/draw
 */

import { CATEGORIES, CATEGORY_NAMES } from './corpus.js'
import { EFFECTIVENESS_NEUTRAL, buildEffectiveness } from './effectiveness.js'
import { toControlled } from './structure-tags.mjs'
import { overlap } from './text.js'

/** How many times each structural kind may appear in one selection. */
const STRUCTURE_TAG_CAP = 2
/** How many materials from one source field may appear in one selection. */
const ORIGIN_CAP = 2
/** Relevance weight of a direct tag hit. */
const TAG_WEIGHT = 1.6
/** Relevance weight of a source-field hit. */
const ORIGIN_WEIGHT = 1.2
/** Relevance weight of a category-name hit. */
const CATEGORY_WEIGHT = 1.0
/** Multiplier applied to a candidate the caller asked to steer away from. */
const AVOID_PENALTY = 0.12
/** Floor keeping every candidate selectable, so far transfer always stays possible. */
const SCORE_FLOOR = 0.15
/** How many collision pairs one call may return. */
export const COLLIDE_MAX_PAIRS = 3
/** How many collision pairs a call returns by default. */
export const COLLIDE_DEFAULT_PAIRS = 1

/**
 * Structure tags that mark a material as an instance of `violate` — rules being
 * broken, assumptions being overturned, or a system redefining its own space.
 */
const VIOLATE_TAGS = new Set([
  '约束作为生成', '判据替换', '范式转换', '边界', '元层级', '自指',
  '历史约束', '次优锁定', '路径依赖', '目标函数', '对称破缺', '去中心',
  '不完备', '预承诺', '偏差约束', '媒介移植',
])

/** Tokenize a free-text hint into comparable lowercase tokens. */
function tokens(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  return text
    .toLowerCase()
    .split(/[\s,，、;；/|:：()（）\[\]【】"'"'。.!！?？-]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
}

/** Every searchable string of one material, lowercased. */
function haystack(material) {
  return [
    material.label,
    material.origin,
    material.structure,
    material.summary,
    material.detail,
    material.bridge,
    material.category,
    CATEGORY_NAMES[material.category] ?? '',
    ...material.tags,
    ...material.structureTags,
  ].join(' ').toLowerCase()
}

/** Whether a hint token appears in the material's searchable text. */
function mentions(material, token) {
  return haystack(material).includes(token)
}

/**
 * Score one candidate for one draw request.
 *
 * **Exported deliberately.** The *expected* effect of a weighting change is
 * computable exactly from these scores; the *observed* effect can only be sampled,
 * and the coverage lean is intentionally gentle (×0.85..×1.25). Sampling 400 draws
 * to detect a 15% shift on a 22% base rate is inside the noise floor, so a
 * share-comparison test either flakes or has to be loosened until it asserts
 * nothing. Tests instead sum these scores to get the exact intended distribution,
 * then check the sampler only tracks it. Keep this pure and side-effect free.
 *
 * @param {object} material - corpus entry.
 * @param {object} context - request context.
 * @param {string[]} context.biasTokens - normalized bias terms.
 * @param {string[]} context.avoidTokens - normalized avoid terms.
 * @param {boolean} context.violate - prefer assumption-breaking material.
 * @param {Set<string>} context.seen - ids this project already drew.
 * @param {object} [context.effectiveness] - coverage-based lean (optional).
 * @returns {number} a positive weight (never zero, so distance stays reachable).
 */
export function scoreMaterial(material, context) {
  let score = 1

  for (const token of context.biasTokens) {
    if (material.tags.some(tag => tag.toLowerCase() === token)) score += TAG_WEIGHT
    else if (material.structureTags.some(tag => tag.toLowerCase() === token)) score += TAG_WEIGHT
    else if (material.origin.toLowerCase().includes(token)) score += ORIGIN_WEIGHT
    else if ((CATEGORY_NAMES[material.category] ?? '').toLowerCase() === token) score += CATEGORY_WEIGHT
    else if (mentions(material, token)) score += TAG_WEIGHT * 0.35
  }

  for (const token of context.avoidTokens) {
    if (mentions(material, token)) score *= AVOID_PENALTY
  }

  if (context.violate) {
    const breaksSomething = material.structureTags.some(tag => VIOLATE_TAGS.has(tag))
    score *= breaksSomething ? 4 : 0.25
  }

  // A material this project has never seen is the fresher stimulus; when repeats
  // are allowed at all, prefer the unseen.
  if (context.seen.has(material.id)) score *= 0.35

  // Finally the coverage term: lean away from the categories and structural shapes
  // this project has *already read through*, toward the ones still under-sampled.
  // Bounded (0.85-1.25) and gated on evidence (see effectiveness.js) so it steers
  // without strangling curiosity — never a filter, never a success ranking: what is
  // optimized is how much of the space this project has read, not whether it helped.
  if (context.effectiveness !== undefined) {
    score *= context.effectiveness.categoryMultiplier(material.category)
    score *= context.effectiveness.coreMultiplier(material.structureTags)
  }

  return Math.max(SCORE_FLOOR, score)
}

/**
 * Penalty for picking `material` given what is already in the selection: far
 * transfer is diluted the moment two picks share a source field or a shape.
 */
function crowdingPenalty(material, picked) {
  let penalty = 1
  const sameOrigin = picked.filter(entry => entry.origin === material.origin).length
  if (sameOrigin === 1) penalty *= 0.28
  else if (sameOrigin >= 2) penalty *= 0.04

  const sameCategory = picked.filter(entry => entry.category === material.category).length
  if (sameCategory === 1) penalty *= 0.6
  else if (sameCategory >= 2) penalty *= 0.2

  const sharedStructures = material.structureTags.filter(tag =>
    picked.some(entry => entry.structureTags.includes(tag))).length
  if (sharedStructures === 1) penalty *= 0.55
  else if (sharedStructures >= 2) penalty *= 0.15

  return penalty
}

/**
 * How far apart two materials' source fields are — the weight a **collision** pair
 * earns for being cross-domain.
 *
 * This is the exact inverse of what `crowdingPenalty` does to structure. Ordinary
 * spreading penalizes a shared structural shape (×0.55, ×0.15) because a batch should
 * cover different shapes — but that penalty is also what stops the engine from ever
 * handing over the strongest analogical signal there is: **one shape appearing twice,
 * in two unrelated fields**. Bisociation needs the shared shape *and* the distance.
 *
 * Returns 0 for the same source field, which the caller treats as "not a collision"
 * (two readings inside one field share a vocabulary; the mapping they suggest is the
 * field's own, not a cross-domain transfer).
 *
 * Exported so tests can assert on the intended distribution exactly rather than
 * sampling it — the same reason `scoreMaterial` is exported (see `lib/AGENTS.md` 坑 11).
 *
 * @param {object} a - first material.
 * @param {object} b - second material.
 * @returns {number} 0 (same field) up to 1 (nothing in common).
 */
export function originDistance(a, b) {
  if (a.origin === b.origin) return 0
  const shared = overlap(a.origin, b.origin)
  // Same category is a weaker "same area" signal than a shared source field: two
  // everyday-life materials can still be from unrelated fields, but they read as one
  // batch, so the pair is worth less.
  const categoryFactor = a.category === b.category ? 0.6 : 1
  return categoryFactor / (1 + shared)
}

/**
 * The best distance any pair inside this group can reach.
 *
 * Shapes differ in whether they can collide *at all*: a shape appearing in two
 * neighbouring fields (say two reliability-engineering materials that share the token
 * `可靠性`) offers nothing, while one that shows up in a fish tank and a compiler does.
 * Measured on the shipped corpus, roughly a sixth of the shapes that can form a pair at
 * all have a best distance under 0.5 — so preferring shapes by their best achievable
 * distance lifts the whole batch, and the shape *choice* is where that decision belongs
 * (within a group, `collisionWeight` already takes the best available pair).
 *
 * Exported so the claim can be asserted precisely instead of being eyeballed.
 *
 * @param {object[]} members - materials carrying one core.
 * @param {(a: object, b: object) => number} [distance] - distance function (defaults to `originDistance`).
 * @returns {number} the highest pairwise distance in the group (0 when it cannot pair).
 */
export function bestPairDistance(members, distance = originDistance) {
  let best = 0
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const value = distance(members[i], members[j])
      if (value > best) best = value
    }
  }
  return best
}

/**
 * The weight of handing over `a` and `b` **as a collision pair**.
 *
 * Relevance is already guaranteed for both (they share a core), so the only thing left
 * to optimize is distance — but not distance alone: a pair of irrelevant materials is
 * useless even if the two fields are maximally far apart. Hence relevance squared
 * (both sides counted) times distance.
 *
 * The `+0.05` floor keeps a near pair selectable when the group holds nothing better
 * (a core that only appears in two adjacent fields still yields its pair), and 0 for a
 * same-field pair is a hard exclusion rather than a penalty — see `originDistance`.
 *
 * Exported for the same reason `scoreMaterial` is: the intended distribution can then
 * be computed exactly instead of being inferred from noisy samples.
 *
 * @param {object} a - first material.
 * @param {object} b - second material.
 * @param {object} context - scoring context (see `scoreMaterial`).
 * @param {(a: object, b: object) => number} [distance] - distance function (defaults to `originDistance`; the engine passes a memoized one).
 * @returns {number} a positive weight, or 0 when the two cannot collide.
 */
export function collisionWeight(a, b, context, distance = originDistance) {
  const reach = distance(a, b)
  if (reach === 0) return 0
  return scoreMaterial(a, context) * scoreMaterial(b, context) * (0.05 + reach)
}

/**
 * Weighted sampling without replacement.
 * @param {Array<{ material: object, weight: number }>} pool - remaining candidates.
 * @param {() => number} random - uniform [0,1) source.
 * @returns {number} the index of the chosen entry.
 */
function weightedPick(pool, random) {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
  if (!(total > 0)) return 0
  let threshold = random() * total
  for (let i = 0; i < pool.length; i++) {
    threshold -= pool[i].weight
    if (threshold <= 0) return i
  }
  return pool.length - 1
}

/**
 * The draw engine.
 *
 * @example
 * const engine = new DrawEngine({ materials, byId, store })
 * const result = engine.draw(cwd, { count: 3, purpose: '设计一个解谜关卡', bias: '生活观察' })
 */
export class DrawEngine {
  /**
   * @param {object} options - corpus and state.
   * @param {object[]} options.materials - loaded materials.
   * @param {Map<string, object>} options.byId - id index.
   * @param {object} options.store - state store (`seenIds` is what it needs).
   * @param {() => number} [options.random] - uniform [0,1) source. Injectable so
   *   tests can pin the sampling and assert on real statistical behaviour
   *   (cross-field spread, `violate` bias) instead of on a lucky run.
   */
  constructor({ materials, byId, store, random }) {
    // Own copies: `serendipity_learn` appends and replaces entries in place, and
    // a caller's corpus object must not be mutated by that.
    this.materials = [...materials]
    this.byId = new Map(byId)
    this.store = store
    this.random = typeof random === 'function' ? random : Math.random
  }

  /** How many shipped vs user-contributed materials are loaded. */
  composition() {
    const builtin = this.materials.filter(material => material.source !== 'user').length
    return { total: this.materials.length, builtin, user: this.materials.length - builtin }
  }

  /**
   * The coverage view for one project: how much of each category and structural
   * core this project has read, and the bounded multipliers that follow.
   *
   * Derived on each draw from the project record rather than kept as a running
   * aggregate, so it can never drift from the notes it is supposed to summarize.
   *
   * @param {string} cwd - session working directory.
   * @returns {object} the coverage view (`categoryMultiplier` / `coreMultiplier` / `report`).
   */
  effectivenessFor(cwd) {
    const project = this.store.readProject(cwd)
    const shape = this.dimensionShape()
    return buildEffectiveness(project.entries, shape.categories, shape.cores)
  }

  /**
   * How much material each weighting dimension holds.
   *
   * The coverage lean is measured as a *read rate*, so it needs to know how big each
   * bucket is — otherwise a 25-item category and an 11-item one would be held to the
   * same bar. Categories count materials; structure cores count the materials whose
   * tags normalize to that core (one material can feed several cores, which is
   * correct: reading it does cover all of them).
   *
   * @returns {{ categories: Array<{key: string, items: number}>, cores: Array<{key: string, items: number}> }} the shapes.
   */
  dimensionShape() {
    const categories = CATEGORIES.map(category => ({
      key: category,
      items: this.materials.filter(material => material.category === category).length,
    }))
    const coreCounts = new Map()
    for (const material of this.materials) {
      for (const core of new Set((material.structureTags ?? []).map(toControlled).filter(Boolean))) {
        coreCounts.set(core, (coreCounts.get(core) ?? 0) + 1)
      }
    }
    return {
      categories,
      cores: [...coreCounts.entries()].map(([key, items]) => ({ key, items })),
    }
  }

  /**
   * Draw materials for one request.
   *
   * @param {string} cwd - session working directory (selects the project history).
   * @param {object} request - the draw request.
   * @param {number} request.count - how many materials to return.
   * @param {string} [request.purpose] - what the agent is working on (recorded, weakly scored).
   * @param {string} [request.bias] - free-text steer: category name, tag, field, structure.
   * @param {string} [request.avoid] - what to steer away from.
   * @param {boolean} [request.violate] - prefer materials that break a constraint.
   * @param {boolean} [request.allowRepeat] - ignore this project's draw history.
   * @returns {{ items: object[], pool: object, request: object }} selection plus pool statistics.
   */
  draw(cwd, request) {
    const count = Math.max(1, Math.min(10, Math.floor(request.count ?? 3)))
    const allowRepeat = request.allowRepeat === true
    // The project's draw history always informs scoring; `allowRepeat` only
    // decides whether an already-seen material may be returned at all.
    const seen = this.store.seenIds(cwd)

    const biasTokens = tokens(request.bias)
    const avoidTokens = tokens(request.avoid)
    const effectiveness = this.effectivenessFor(cwd)
    const context = { biasTokens, avoidTokens, violate: request.violate === true, seen, effectiveness }

    const strictPool = allowRepeat ? [...this.materials] : this.materials.filter(material => !seen.has(material.id))
    // An exhausted pool broadens instead of failing — and says so in the result,
    // because "the well is dry" is the signal to go learn something new.
    const exhausted = strictPool.length < count
    let candidates = exhausted ? [...this.materials] : strictPool

    // `violate` is an eligibility filter where the corpus can support one, not
    // merely a scoring nudge: a request for assumption-breaking material that
    // returns ordinary techniques half the time does not answer the request.
    let violatingCount = 0
    if (context.violate) {
      const violating = candidates.filter(material =>
        material.structureTags.some(tag => VIOLATE_TAGS.has(tag)))
      violatingCount = violating.length
      if (violating.length >= Math.min(count + 1, 3)) candidates = violating
    }

    const pool = candidates.map(material => ({ material, weight: scoreMaterial(material, context) }))
    const picked = []
    const originTally = new Map()

    while (picked.length < count && pool.length > 0) {
      const eligible = pool.filter(entry => (originTally.get(entry.material.origin) ?? 0) < ORIGIN_CAP)
      const working = eligible.length > 0 ? eligible : pool
      const adjusted = working.map(entry => ({
        material: entry.material,
        weight: entry.weight * crowdingPenalty(entry.material, picked),
      }))
      const index = weightedPick(adjusted, this.random)
      const chosen = working[index]
      pool.splice(pool.indexOf(chosen), 1)
      originTally.set(chosen.material.origin, (originTally.get(chosen.material.origin) ?? 0) + 1)
      picked.push(chosen.material)
    }

    // Interleave source fields so two consecutive materials never share one:
    // adjacency is what makes a cross-domain list feel like a cross-domain list.
    const ordered = []
    const remaining = [...picked]
    while (remaining.length > 0) {
      const lastOrigin = ordered.at(-1)?.origin
      const nextIndex = remaining.findIndex(material => material.origin !== lastOrigin)
      ordered.push(...remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1))
    }

    const uniqueTotal = new Set(this.materials.map(material => material.id)).size
    const unseenBeforeDraw = allowRepeat ? 0 : [...this.byId.keys()].filter(id => !seen.has(id)).length
    const drawnFromHistory = picked.filter(material => seen.has(material.id)).length
    return {
      items: ordered,
      pool: {
        total: uniqueTotal,
        unseenBeforeDraw,
        unseenAfterDraw: Math.max(0, unseenBeforeDraw - (picked.length - drawnFromHistory)),
        candidates: candidates.length,
        exhausted,
        repeatsIncluded: drawnFromHistory,
        violating: violatingCount,
      },
      request: {
        count,
        purpose: request.purpose,
        bias: request.bias,
        avoid: request.avoid,
        violate: request.violate === true,
        allowRepeat,
      },
    }
  }

  /**
   * Ids that collide with an incoming material (so `learn` can report a merge).
   * @param {string} id - candidate id.
   * @returns {object | undefined} the existing entry, if any.
   */
  existing(id) {
    return this.byId.get(id)
  }

  /**
   * Draw **collision pairs**: two materials built on the same structural shape, taken
   * from two source fields as far apart as the corpus allows.
   *
   * Why this exists as its own mode: the ordinary draw maximizes spread, and part of
   * that is a penalty on sharing a shape (`crowdingPenalty`, ×0.55 / ×0.15). So the
   * engine actively avoids handing over the one combination that produces the best
   * mappings — the same skeleton seen twice in unrelated fields. In a real session the
   * two most valuable results came exactly from that: a predator-prey cycle read
   * against a card-game feedback loop, and a saturation curve weighed against a delay
   * term. Those pairs were assembled by the model, not offered by the plugin.
   *
   * The pair is a **delivery**, not a task: both materials are served, recorded as read,
   * and counted against this project's dedup budget, exactly like an ordinary draw.
   *
   * @param {string} cwd - session working directory (selects the project history).
   * @param {object} request - the request.
   * @param {number} request.count - how many **pairs** (1-3), not materials.
   * @param {string} [request.purpose] - what the agent is working on.
   * @param {string} [request.bias] - steer; naming a structure core pins the pairs to it.
   * @param {string} [request.avoid] - what to steer away from.
   * @param {boolean} [request.allowRepeat] - ignore this project's draw history.
   * @returns {{ items: object[], pairs: Array<{ core: string, a: string, b: string }>, pool: object, request: object }}
   *   the materials (pair-adjacent), the grouping, and pool statistics.
   */
  collide(cwd, request) {
    const pairsWanted = Math.max(1, Math.min(COLLIDE_MAX_PAIRS, Math.floor(request.count ?? COLLIDE_DEFAULT_PAIRS)))
    const allowRepeat = request.allowRepeat === true
    const seen = this.store.seenIds(cwd)
    const biasTokens = tokens(request.bias)
    const avoidTokens = tokens(request.avoid)
    const effectiveness = this.effectivenessFor(cwd)
    const context = { biasTokens, avoidTokens, violate: false, seen, effectiveness }

    const unseen = this.materials.filter(material => !seen.has(material.id))
    // Two passes: pairs of never-read material first, then a fallback that may reuse
    // already-read material. A collision is only useful if both sides are real, so
    // degrading to repeats beats returning nothing ("the well is dry" is already a
    // signal the ordinary draw reports, and it is reported here too).
    const primary = allowRepeat ? [...this.materials] : unseen
    let pool = primary
    let exhausted = primary.length < pairsWanted * 2
    let grouped = this.coreIndex(pool)

    if (this.maxGroupSize(grouped) < 2) {
      pool = [...this.materials]
      exhausted = true
      grouped = this.coreIndex(pool)
    }

    const picked = []
    const pairs = []
    const usedCores = new Set()
    const takenIds = new Set()
    // One core per draw is deliberate: `usedCores` guarantees the whole batch is not
    // four readings of the same shape. Wanting the same shape twice in one go is what
    // separate calls are for.
    const biasCores = this.biasCores(request.bias)
    // Origins repeat heavily across the corpus, so the same handful of origin pairs get
    // compared again and again while the core weights are computed. Memoizing turns the
    // per-core scan from thousands of tokenizations into a few dozen.
    const distanceCache = new Map()
    const distance = (a, b) => {
      const left = `${a.origin}\u0000${a.category}`
      const right = `${b.origin}\u0000${b.category}`
      const key = left <= right ? `${left}\u0001${right}` : `${right}\u0001${left}`
      const cached = distanceCache.get(key)
      if (cached !== undefined) return cached
      const value = originDistance(a, b)
      distanceCache.set(key, value)
      return value
    }

    while (pairs.length < pairsWanted) {
      const core = this.pickCore(grouped, context, usedCores, takenIds, biasCores, distance)
      if (core === undefined) break
      const members = grouped.get(core).filter(material => !takenIds.has(material.id))
      const pair = this.pickCollisionPair(members, context, distance)
      if (pair === undefined) break
      usedCores.add(core)
      takenIds.add(pair.a.id)
      takenIds.add(pair.b.id)
      picked.push(pair.a, pair.b)
      pairs.push({ core, a: pair.a.id, b: pair.b.id })
    }

    const uniqueTotal = new Set(this.materials.map(material => material.id)).size
    const unseenBeforeDraw = allowRepeat ? 0 : unseen.length
    const drawnFromHistory = picked.filter(material => seen.has(material.id)).length
    return {
      items: picked,
      pairs,
      pool: {
        total: uniqueTotal,
        unseenBeforeDraw,
        unseenAfterDraw: Math.max(0, unseenBeforeDraw - (picked.length - drawnFromHistory)),
        candidates: pool.length,
        exhausted,
        repeatsIncluded: drawnFromHistory,
        violating: 0,
      },
      request: {
        count: picked.length,
        pairs: pairs.length,
        purpose: request.purpose,
        bias: request.bias,
        avoid: request.avoid,
        violate: false,
        allowRepeat,
      },
    }
  }

  /**
   * Group materials by controlled structural core.
   * @param {object[]} materials - candidates.
   * @returns {Map<string, object[]>} core → materials that carry it.
   */
  coreIndex(materials) {
    const index = new Map()
    for (const material of materials) {
      for (const core of new Set((material.structureTags ?? []).map(toControlled).filter(Boolean))) {
        const bucket = index.get(core) ?? []
        bucket.push(material)
        index.set(core, bucket)
      }
    }
    return index
  }

  /** The largest group in a core index (0 when empty). */
  maxGroupSize(index) {
    let max = 0
    for (const bucket of index.values()) max = Math.max(max, bucket.length)
    return max
  }

  /**
   * The structural cores the caller explicitly asked to collide on.
   *
   * Runs the bias text through the **controlled vocabulary** rather than comparing
   * strings: a caller who writes `bias: "预警"` is asking for the core `阈值` (the alias
   * table says so), and one who writes `bias: "阈值"` is asking for it directly.
   * Comparing raw text would make the second work and the first silently do nothing —
   * a failure mode that raises no error and just ignores the request. (It also would
   * *always* do nothing: `Set` has `has`, not `includes`.)
   *
   * @param {unknown} bias - the free-text bias argument.
   * @returns {Set<string>} controlled cores named by the bias.
   */
  biasCores(bias) {
    const cores = new Set()
    for (const token of tokens(bias)) {
      const controlled = toControlled(token)
      if (typeof controlled === 'string' && controlled !== '') cores.add(controlled)
    }
    return cores
  }

  /**
   * Choose which structural shape to collide on.
   *
   * Weighted by the coverage lean (shapes this project read least are preferred). When
   * the caller **named** a shape in `bias`, the candidates are *restricted* to it rather
   * than merely weighted: a boost multiplier is not enough. Measured — a ×12 boost
   * against ~75 competing cores at weight ≈1 is only a 14% chance per draw, so
   * `bias: "阈值"` returned some other shape about six times in seven. An instruction
   * that silently doesn't happen is worse than no instruction.
   *
   * Restricting can starve the batch (the named shape may hold too few unread materials),
   * so the named set falls back to the coverage-weighted pool when it cannot produce a
   * pair at all.
   *
   * @param {Map<string, object[]>} index - core index.
   * @param {object} context - scoring context.
   * @param {Set<string>} usedCores - cores already used in this batch.
   * @param {Set<string>} takenIds - materials already used in this batch.
   * @param {Set<string>} [biasCores] - cores the caller named.
   * @returns {string | undefined} the chosen core, or `undefined` when none can form a pair.
   */
  pickCore(index, context, usedCores, takenIds, biasCores = new Set(), distance = originDistance) {
    const all = []
    const named = []
    for (const [core, bucket] of index) {
      // One shape per batch is the default, because four readings of one shape is not a
      // wider view. An **explicit** request overrides that: `bias: "阈值", count: 2`
      // asks for two collisions on 阈值, and silently giving a different shape for the
      // second pair would be ignoring the instruction.
      const isNamed = biasCores.has(core)
      if (isNamed && this.avoided(core, context)) continue
      if (usedCores.has(core) && !isNamed) continue
      const available = bucket.filter(material => !takenIds.has(material.id))
      // Two *different source fields* are what make a collision: two materials from the
      // same field would be a rereading, not a collision.
      if (new Set(available.map(material => material.origin)).size < 2) continue
      const coverage = context.effectiveness?.coreMultiplier([core]) ?? EFFECTIVENESS_NEUTRAL
      const reach = bestPairDistance(available, distance)
      // Shapes that *can* collide far are worth more than shapes that merely exist: the
      // 0.25 floor keeps a near-only shape selectable (the well must degrade, not run dry).
      const weight = coverage * (0.25 + reach)
      all.push({ key: core, weight })
      if (isNamed) named.push({ key: core, weight: 1 })
    }
    const pool = named.length > 0 ? named : all
    if (pool.length === 0) return undefined
    // `weightedPick` returns an *index*, not a key (see its implementation).
    return pool[weightedPick(pool, this.random)].key
  }

  /** Whether the caller asked to avoid this core. */
  avoided(core, context) {
    const lowered = core.toLowerCase()
    for (const token of context.avoidTokens) {
      if (token.includes(lowered) || lowered.includes(token)) return true
    }
    return false
  }

  /**
   * Pick the pair inside one core group.
   *
   * Every candidate pair is enumerated and scored (`collisionWeight`) rather than
   * following "pick one, then pick the farthest from it". The greedy order optimizes
   * relevance first and distance second, and it measurably produced bad pairs: the
   * first pick landed on `可靠性工程 / 航空航天`, and the only other member of its shape
   * shared the token `可靠性`, so the "collision" arrived at distance 0.15. Groups are
   * small (a shape appears in a handful of materials), so the quadratic enumeration is
   * cheap and it optimizes both ends of the pair at once.
   *
   * @param {object[]} members - materials carrying this core.
   * @param {object} context - scoring context.
   * @returns {{ a: object, b: object } | undefined} the chosen pair.
   */
  pickCollisionPair(members, context, distance = originDistance) {
    const combos = []
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const weight = collisionWeight(members[i], members[j], context, distance)
        if (weight <= 0) continue
        combos.push({ weight, a: members[i], b: members[j] })
      }
    }
    if (combos.length === 0) return undefined
    return combos[weightedPick(combos, this.random)]
  }

  /** Every category id with its display name and current count. */
  categorySummary() {
    return CATEGORIES.map(category => ({
      category,
      name: CATEGORY_NAMES[category],
      count: this.materials.filter(material => material.category === category).length,
    }))
  }
}

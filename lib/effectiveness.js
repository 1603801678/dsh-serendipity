/**
 * Which kinds of material to lean toward — and, just as importantly, which
 * signals must NOT be trusted to decide that.
 *
 * ## What this module refuses to do
 *
 * Earlier versions used the agent's self-reported `hit` to adjust draw weights.
 * That is wrong for two separate reasons, and the second is the serious one:
 *
 * 1. **Self-reported usefulness is not evidence.** Controlled studies of
 *    LLM-as-judge for novelty find that small prompt changes swing pairwise
 *    accuracy by tens of points (sometimes below chance), that models
 *    systematically rate their own output as novel — a "novelty mirage" — while
 *    domain experts disagree, and that purpose-built novelty evaluators lose to a
 *    cheap prompt baseline. A `hit` flag written by the agent that just read the
 *    material, and knows the plugin hopes it will be useful, is exactly that kind
 *    of judgement.
 * 2. **Optimizing "usefulness" is the wrong objective for long work.** Research
 *    pays off *later*: a structure that looks useless today can become the hinge
 *    of the work months on. A hit flag is stamped *now*. So the loop does not
 *    merely add noise — it marks delayed-payoff material as failure and learns to
 *    avoid precisely the material worth keeping. Accumulated per project, that
 *    bias grows exactly where breadth matters most.
 *
 * ## What it does instead
 *
 * Two signals that are observable, cheap, and cannot collapse into timidity:
 *
 * - **`landed` (immediate trace)**: the agent must name *where* the structure
 *   went (`landed: "docs/design.md §3"`). No location, no credit. This is about
 *   the artifact rather than a feeling about the material, and a human can check
 *   it. A subtle failure is still possible — a plausible path that does not
 *   really reflect the material — but it is *checkable*, which self-report is not.
 * - **`coverage` (structural breadth)**: how much of the structural space this
 *   project has read, per controlled core and per source field. It is a property
 *   of the read history alone, so enthusiasm cannot inflate it, and it pushes
 *   toward *more* variety rather than less.
 *
 * The weighting that follows is deliberately weak and bounded: it leans toward
 * **under-read** structures, with a small bonus for material whose trace landed
 * before. Uniform far-field sampling is a perfectly good strategy — the corpus
 * exists to be read — so this is a lean at most
 * ({@link EFFECTIVENESS_MIN}..{@link EFFECTIVENESS_MAX}), never a filter.
 *
 * @module @1603801678/dsh-serendipity/effectiveness
 */

import { toControlled } from './structure-tags.mjs'

/** Bounded multiplier range: a lean, never a filter. */
export const EFFECTIVENESS_MIN = 0.85
export const EFFECTIVENESS_MAX = 1.25
export const EFFECTIVENESS_NEUTRAL = 1

/** Read history required before coverage may steer anything. */
export const MIN_EVIDENCE = 15

/**
 * How strongly coverage steers the weight, as the relative read rate at which each
 * end of the range is reached: at 4× the rate a bucket is pinned to the floor, at a
 * quarter of it to the ceiling.
 *
 * The neutral point is a **bucket read at exactly the project's overall rate**
 * (`bucket.read / bucketItems === totalRead / totalItems`) — the bar is "how much of
 * *this* material have we read", not a share of the history. Three earlier forms
 * were wrong in ways worth remembering:
 *
 * - Share-of-history (`1 - share*4`) saturates at zero for anything past 25% of the
 *   history, so "read through" and "never touched" both clamped to the same 0.85 and
 *   the lever did nothing measurable (21.8% against a 21.7% baseline).
 * - The mean of the buckets that were *used* moves with the data: with every read
 *   landing in one category that mean becomes the read-through count itself, and the
 *   read-through bucket scores as neutral.
 * - A uniform allocation over bucket *counts* ignores how much material each bucket
 *   holds, so a 25-item category and a 11-item one are held to the same bar.
 *
 * Rate-based, a bucket that has absorbed more than its share of attention sinks, one
 * that has absorbed less lifts, and an untouched one sits at the ceiling rather than
 * merely at neutral. No absolute threshold is needed anywhere: the shape of the
 * material itself supplies the bar.
 *
 * Calibration matters, and the first attempt got it wrong: with a floor at 2.7× and
 * 245 structure cores spread over 115 materials, the expected count for a core is
 * ~0.3 reads, so a core read ONCE scored ~3× the rate and was pinned to the floor —
 * i.e. reading rare material once was punished, the opposite of the intent. The floor
 * has to sit past the point where a bucket holding one material has been read once;
 * a ceiling of 1/4 makes the scale symmetric around that point (1 read of a 1-item
 * bucket ≈ neutral, 0 reads = ceiling, 2+ = floor).
 */
const COVERAGE_FLOOR_RATIO = 4
const COVERAGE_CEILING_RATIO = 0.25

/**
 * How much of the remaining headroom a bucket with a traced `landed` gets. Applied
 * as a fraction of the distance to {@link EFFECTIVENESS_MAX} rather than added on
 * top, so the trace cannot push a bucket past the ceiling nor cancel a genuine
 * suppression: with 22 of 123 reads a category scores 0.95, and a trace takes it to
 * 0.98 — it does not become 1.25, which is what a flat `+0.1` did on real data.
 */
const LANDED_LIFT = 0.25

/**
 * Tally read coverage and landed traces from one project's records.
 *
 * `hit` and `transformation` are read only so they can be *reported* — they never
 * feed a multiplier (see the module doc). `landedAt` is read only to measure the
 * **lag** between reading a material and its structure finally landing.
 *
 * @param {object} entries - one project's `entries` map (id → record).
 * @returns {{ categories: Map<string, object>, cores: Map<string, object>, origins: Map<string, object>, overall: object }} tallies.
 */
export function tallyOutcomes(entries) {
  const categories = new Map()
  const cores = new Map()
  const origins = new Map()
  const overall = {
    read: 0, noted: 0, landed: 0, selfReportedHits: 0, transformations: 0, landedLagDays: [],
    external: 0, externalLanded: 0,
  }

  const bump = (map, key, record) => {
    const bucket = map.get(key) ?? { read: 0, landed: 0 }
    bucket.read += 1
    if (typeof record.landed === 'string' && record.landed.trim() !== '') bucket.landed += 1
    map.set(key, bucket)
  }

  for (const record of Object.values(entries ?? {})) {
    // External traces — structures the agent met outside the corpus and reported a
    // landing for — are **not reads**. Counting them as reads would inflate
    // `totalRead`, move the neutral bar that every coverage multiplier is measured
    // against, and let material the library never served skew "how much of the
    // corpus has been read". They are tallied separately and reported separately:
    // a landing is still a landing, it just is not coverage.
    if (record?.external === true) {
      overall.external += 1
      if (typeof record.landed === 'string' && record.landed.trim() !== '') overall.externalLanded += 1
      continue
    }
    overall.read += 1
    // `notedAt` means "the agent wrote something about this" — the weakest kind of
    // engagement, and the only one that exists for every recorded material.
    if (record?.notedAt !== undefined) overall.noted += 1
    if (record?.hit === true) overall.selfReportedHits += 1
    if (record?.transformation === true) overall.transformations += 1
    if (typeof record?.landed === 'string' && record.landed.trim() !== '') {
      overall.landed += 1
      // How long this material sat between first being read and finally landing.
      // That lag is the observable form of the thing this whole design assumes —
      // that a structure which looked useless can matter much later — so it is
      // measured rather than taken on faith.
      //
      // `notedAt` is the fallback, not the primary: records written before
      // `landedAt` existed have a trace and no timestamp for it, and dropping those
      // from the measurement would quietly exclude exactly the longest-standing
      // entries. `notedAt` is when the landing was actually written for any record
      // that was not re-noted afterwards, so it is the right conservative bound.
      const lag = daysBetween(record.firstDrawnAt, record.landedAt ?? record.notedAt)
      if (lag !== undefined) overall.landedLagDays.push(lag)
      if (record.landedAt === undefined) overall.landedWithoutTimestamp = (overall.landedWithoutTimestamp ?? 0) + 1
    }

    if (typeof record?.category === 'string') bump(categories, record.category, record)
    if (typeof record?.origin === 'string') bump(origins, record.origin, record)
    if (Array.isArray(record?.structureTags)) {
      for (const core of new Set(record.structureTags.map(tag => toControlled(tag)).filter(Boolean))) {
        bump(cores, core, record)
      }
    }
  }
  return { categories, cores, origins, overall }
}

/** Whole days between two ISO timestamps, or `undefined` if either is unusable. */
export function daysBetween(from, to) {
  const start = Date.parse(from ?? '')
  const end = Date.parse(to ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, Math.round((end - start) / 86_400_000))
}

/** Median of a numeric list, or `undefined` when there is nothing to average. */
export function median(values) {
  const sorted = [...(values ?? [])].filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/**
 * Turn a bucket's read count into a bounded multiplier.
 *
 * Only two things move it, and both reward variety: material this project has
 * barely read is favoured, so the draw keeps opening untouched parts of the space;
 * and material whose structure has landed before takes a small bonus. It is a lean,
 * never a filter — uniform far-field sampling is a perfectly good strategy.
 *
 * @param {{ read: number, landed: number }} bucket - coverage for this bucket.
 * @param {number} totalRead - how much this project has read overall.
 * @param {{ items?: number, totalItems?: number }} [shape] - how much material this
 *   bucket holds, and how much the whole dimension holds. Supplies the neutral bar;
 *   omitted, every bucket is held to the same bar (so the bar is the overall rate
 *   itself, and any bucket read more than the overall rate is suppressed).
 * @returns {{ multiplier: number, note: string }} the multiplier and why.
 */
export function multiplierFor(bucket, totalRead, shape = {}) {
  if (totalRead < MIN_EVIDENCE) {
    return { multiplier: EFFECTIVENESS_NEUTRAL, note: `读取历史不足（${totalRead}/${MIN_EVIDENCE}），不做调整` }
  }
  const share = bucket.read / totalRead
  const items = shape.items
  const totalItems = shape.totalItems
  // The bucket's expected read count if this project read everything at the same
  // rate it has read so far. Falls back to the overall rate when the caller gives no
  // shape (a bare `multiplierFor(bucket, totalRead)` then reads "same bar for all").
  const expected = (typeof items === 'number' && typeof totalItems === 'number' && totalItems > 0)
    ? totalRead * (items / totalItems)
    : totalRead
  const relative = expected > 0 ? bucket.read / expected : (bucket.read > 0 ? Infinity : 1)
  // 1 at the neutral point, 0 at the ceiling (untouched or well below rate), −1 at the floor.
  const coverage = Math.max(0, Math.min(1,
    (COVERAGE_FLOOR_RATIO - relative) / (COVERAGE_FLOOR_RATIO - COVERAGE_CEILING_RATIO)))
  const base = EFFECTIVENESS_MIN + coverage * (EFFECTIVENESS_MAX - EFFECTIVENESS_MIN)
  // A traced landing is a bounded lift toward the ceiling, never a way past it.
  const multiplier = bucket.landed > 0 ? base + (EFFECTIVENESS_MAX - base) * LANDED_LIFT : base
  return {
    multiplier: Math.max(EFFECTIVENESS_MIN, Math.min(EFFECTIVENESS_MAX, multiplier)),
    note: bucket.landed > 0
      ? `已读 ${bucket.read} 次、其中 ${bucket.landed} 次有落点`
      : `已读 ${bucket.read} 次（占读取历史 ${(share * 100).toFixed(1)}%，按整体速度应约 ${expected.toFixed(1)} 次）`,
  }
}

/**
 * Build the weighting view a draw consults.
 *
 * @param {object} entries - one project's record map.
 * @param {Array<string|{key: string, items?: number}>} categories - every category id, with how many materials it holds.
 * @param {Array<string|{key: string, items?: number}>} coreIds - every controlled core, likewise.
 * @returns {{ categoryMultiplier: Function, coreMultiplier: Function, report: object }} lookups plus a report.
 */
export function buildEffectiveness(entries, categories, coreIds) {
  const tally = tallyOutcomes(entries)
  const totalRead = tally.overall.read

  const normalize = (list) => list.map(entry => (typeof entry === 'string' ? { key: entry } : entry))
  const sum = (list) => list.reduce((total, entry) => total + (entry.items ?? 1), 0)

  const rows = (map, list) => {
    const totalItems = sum(list)
    return list.map(({ key, items }) => {
      const bucket = map.get(key) ?? { read: 0, landed: 0 }
      return { key, ...bucket, ...multiplierFor(bucket, totalRead, { items, totalItems }) }
    })
  }

  const categoryList = normalize(categories)
  const coreList = normalize(coreIds)
  const categoryRows = rows(tally.categories, categoryList)
  const coreRows = rows(tally.cores, coreList)
  const categoryMap = new Map(categoryRows.map(row => [row.key, row.multiplier]))
  const coreMap = new Map(coreRows.map(row => [row.key, row.multiplier]))

  return {
    categoryMultiplier: (category) => categoryMap.get(category) ?? EFFECTIVENESS_NEUTRAL,
    coreMultiplier: (structureTags) => {
      const factors = []
      for (const core of new Set((structureTags ?? []).map(tag => toControlled(tag)).filter(Boolean))) {
        const value = coreMap.get(core)
        if (value !== undefined) factors.push(value)
      }
      if (factors.length === 0) return EFFECTIVENESS_NEUTRAL
      return factors.reduce((sum, value) => sum + value, 0) / factors.length
    },
    report: {
      overall: tally.overall,
      categories: categoryRows,
      cores: coreRows,
      readOrigins: tally.origins.size,
      // Spelled out so nobody reads coverage as a success metric.
      optimizedFor: 'coverage',
    },
  }
}

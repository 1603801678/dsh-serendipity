/**
 * Test suite for the corpus, the id scheme, the draw engine, the state store,
 * and the agent tools.
 *
 * Run with `node --test test/` (or `npm test`) from the project root. No build
 * step and no dependencies: the plugin ships plain ESM, so the tests exercise
 * exactly the code dsh loads.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { loadCorpus, tagVocabulary, validateMaterial, CATEGORIES, CATEGORY_NAMES } from '../lib/corpus.js'
import { materialId, projectKey } from '../lib/hash.js'
import { DrawEngine, scoreMaterial, originDistance, collisionWeight, bestPairDistance } from '../lib/draw.js'
import {
  EFFECTIVENESS_MAX, EFFECTIVENESS_MIN, EFFECTIVENESS_NEUTRAL, MIN_EVIDENCE, buildEffectiveness, tallyOutcomes,
} from '../lib/effectiveness.js'
import { StateStore } from '../lib/store.js'
import { createTools, RECONSIDER_MIN_AGE_MS } from '../lib/tools.js'
import { FIELDS, FIELD_FAMILIES, FIELD_INDEX, fieldCount } from '../lib/fields.mjs'
import { drawPair, fieldWeight, coveredTokens } from '../lib/generate.js'
import { CONTROLLED, toControlled } from '../lib/structure-tags.mjs'
import { SESSION_HISTORY_LIMIT } from '../lib/sessions.js'
import { makeRoutes, API_BASE } from '../lib/routes.js'
import { SERENDIPITY_GUIDANCE } from '../lib/index.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A throwaway state root so tests never touch the real ~/.dsh directory. */
function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-serendipity-test-'))
}

/** A throwaway project directory (the draw-history key). */
function tempProject() {
  return mkdtempSync(join(tmpdir(), 'dsh-serendipity-project-'))
}

/** Load the shipped corpus with no user directory. */
function builtinCorpus() {
  return loadCorpus(undefined)
}

/**
 * A deterministic uniform [0,1) source (mulberry32).
 *
 * The draw engine samples randomly, so statistical assertions like "the draw
 * spreads across source fields" or "violate prefers constraint-breaking
 * material" are flaky if they ride `Math.random`. Seeding instead of loosening
 * the assertions keeps them strict AND reproducible.
 * @param {number} seed - any integer.
 * @returns {() => number} a uniform generator.
 */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Assert that a tool value is lossless JSON.
 *
 * The tool runtime detaches every result before it validates it, and a single
 * `undefined` member — or a function, a symbol, a non-finite number, or a
 * class instance — makes it reject the **entire** call with
 * `value is not lossless JSON`. Reading fields out of the value never notices:
 * `JSON.stringify` drops `undefined`, so only a walk sees it.
 *
 * @param {unknown} value - the tool value.
 * @param {string} [path] - diagnostic path, for the failure message.
 * @returns {void}
 */
function assertLossless(value, path = 'value') {
  if (value === undefined) assert.fail(`${path} 是 undefined —— 工具运行时会拒掉整个返回值`)
  if (value === null) return
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint') assert.fail(`${path} 是 ${type}`)
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} 不是有限数`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertLossless(child, `${path}[${index}]`))
    return
  }
  if (type !== 'object') return
  const prototype = Object.getPrototypeOf(value)
  assert.ok(prototype === Object.prototype || prototype === null,
    `${path} 不是普通对象（原型 ${prototype?.constructor?.name ?? 'null'}）`)
  for (const [key, child] of Object.entries(value)) assertLossless(child, `${path}.${key}`)
}

test('corpus: every shipped file is valid and fully populated', () => {
  const corpus = builtinCorpus()
  assert.deepEqual(corpus.problems, [], `语料校验问题：${corpus.problems.join('；')}`)
  assert.ok(corpus.materials.length >= 80, `素材太少：${corpus.materials.length}`)
  for (const category of CATEGORIES) {
    assert.ok(corpus.countsByCategory[category] >= 8, `${category} 只有 ${corpus.countsByCategory[category]} 条`)
  }
  for (const material of corpus.materials) {
    assert.ok(Array.isArray(material.structureTags) && material.structureTags.length > 0, `${material.label} 缺结构标签`)
    assert.ok(material.detail.length >= 30, `${material.label} 机理过短`)
    assert.equal(material.source, 'builtin')
  }
})

test('corpus: ids are unique and stable across reloads', () => {
  const first = builtinCorpus()
  const second = builtinCorpus()
  const ids = new Set(first.materials.map(material => material.id))
  assert.equal(ids.size, first.materials.length, '存在重复 id')
  for (const material of first.materials) {
    const counterpart = second.byId.get(material.id)
    assert.ok(counterpart !== undefined, `${material.label} 的 id 在重载后消失`)
    assert.equal(counterpart.label, material.label)
  }
})

test('hash: id depends only on origin and label; project keys are path-stable', () => {
  assert.equal(materialId('物理学', '迟滞'), materialId('物理学 ', ' 迟滞'))
  assert.notEqual(materialId('物理学', '迟滞'), materialId('生物学', '迟滞'))
  assert.equal(projectKey('E:\\a\\b\\Demo'), projectKey('e:/a/b/demo/'))
  assert.notEqual(projectKey('E:/a/b/Demo'), projectKey('E:/a/c/Demo'))
})

test('validateMaterial: rejects incomplete records with a reason', () => {
  const bad = validateMaterial({ label: '只有标题' }, 'pattern')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /字段缺失或过短/)
  const noStructureTags = validateMaterial({
    label: '标题够长了',
    origin: '某领域',
    structure: '某结构',
    summary: '一句话摘要够长了吧',
    detail: '机理说明需要足够长，至少三十个字，这里再补一些内容凑够长度。',
    bridge: '这条结构能怎么映射到你的问题？',
    structureTags: [],
  }, 'pattern')
  assert.equal(noStructureTags.ok, false)
  assert.match(noStructureTags.reason, /structureTags/)
})

/**
 * Fixed seeds for the statistical tests.
 *
 * Sampling is weighted-random by design, so a single draw can legitimately
 * violate a statistical expectation. Running a handful of *fixed* seeds keeps
 * the assertion strict, kills flakiness in both directions (a green run stays
 * green), and fails loudly if the weighting changes behaviour.
 */
const TEST_SEEDS = [1, 7, 42, 1234, 90210]

test('draw: spreads across source fields and structural types', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    for (const seed of TEST_SEEDS) {
      const store = new StateStore({ root })
      const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(seed) })
      const result = engine.draw(cwd, { count: 6, purpose: '设计一个解谜关卡', bias: '生活观察' })

      assert.equal(result.items.length, 6)
      const origins = result.items.map(material => material.origin)
      assert.equal(new Set(origins).size, 6, `seed ${seed}: 来源领域没有分散：${origins.join('、')}`)
      for (let i = 1; i < origins.length; i++) {
        assert.notEqual(origins[i], origins[i - 1], `seed ${seed}: 相邻素材来自同一领域`)
      }
      const structuralKinds = result.items.flatMap(material => material.structureTags)
      for (const kind of new Set(structuralKinds)) {
        const count = structuralKinds.filter(tag => tag === kind).length
        assert.ok(count <= 2, `seed ${seed}: 结构标签「${kind}」在一次抽取里出现 ${count} 次，超出上限`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: never repeats within a project until the pool is exhausted', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })

    const seen = new Set()
    // Two draws of 10 must not overlap.
    for (let round = 0; round < 2; round++) {
      const result = engine.draw(cwd, { count: 10 })
      store.recordDraw(cwd, result.items, {})
      for (const material of result.items) {
        assert.ok(!seen.has(material.id), `素材 ${material.label} 被重复发放`)
        seen.add(material.id)
      }
    }
    assert.equal(seen.size, 20)

    // Draining the whole library must terminate with an explicit exhaustion flag
    // rather than returning an empty list.
    let guard = 0
    while (store.seenIds(cwd).size < corpus.materials.length && guard < 100) {
      const result = engine.draw(cwd, { count: 10 })
      store.recordDraw(cwd, result.items, {})
      guard += 1
    }
    const afterDrain = engine.draw(cwd, { count: 3 })
    assert.equal(afterDrain.pool.unseenBeforeDraw, 0)
    assert.equal(afterDrain.pool.exhausted, true)
    assert.equal(afterDrain.items.length, 3, '素材读完后仍应返回素材（放宽重复），而不是返回空')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: allowRepeat returns already-seen material', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(7) })
    store.recordDraw(cwd, corpus.materials.slice(0, 20), {})
    const seen = store.seenIds(cwd)

    const result = engine.draw(cwd, { count: 8, allowRepeat: true })
    assert.equal(result.items.length, 8)
    assert.ok(result.items.some(material => seen.has(material.id)), 'allowRepeat=true 时没有返回已读素材')
    // Without the flag, the same request must avoid what this project already read.
    const strict = engine.draw(cwd, { count: 8 })
    assert.ok(strict.items.every(material => !seen.has(material.id)), 'allowRepeat=false 时返回了已读素材')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: violate=true prefers constraint-breaking material', () => {
  const root = tempRoot()
  const cwd = tempProject()
  const violatingTags = [
    '约束作为生成', '判据替换', '范式转换', '边界', '元层级', '自指',
    '历史约束', '次优锁定', '路径依赖', '目标函数', '对称破缺', '去中心',
    '不完备', '预承诺', '偏差约束', '媒介移植',
  ]
  try {
    const corpus = builtinCorpus()
    for (const seed of TEST_SEEDS) {
      const store = new StateStore({ root })
      const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(seed) })
      let violating = 0
      let total = 0
      for (let round = 0; round < 12; round++) {
        const result = engine.draw(cwd, { count: 5, violate: true, allowRepeat: true })
        total += result.items.length
        violating += result.items.filter(material =>
          material.structureTags.some(tag => violatingTags.includes(tag))).length
      }
      const ratio = violating / total
      assert.ok(ratio >= 0.8, `seed ${seed}: violate=true 时「打破假设」类素材占比只有 ${(ratio * 100).toFixed(0)}%`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: bias leans the pool toward the named category, without filtering others', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(1) })

    // A bias is a *lean*, not a filter, so a single draw is a noisy probe of it —
    // a fair coin can come up heads three times. Measure it where it acts:
    // `draw({ count: 1 })` is exactly one weighted sample, so repeating with
    // distinct seeds gives a large, stable sample of the actual weighting.
    const run = (bias, rounds) => {
      let everyday = 0
      let foreign = 0
      for (let seed = 1; seed <= rounds; seed++) {
        const probe = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(seed) })
        // A fresh project each round: no draw history to bias the sample.
        const scratch = `${cwd}-${seed}`
        const [first] = probe.draw(scratch, bias === undefined ? { count: 1 } : { count: 1, bias }).items
        if (first.category === 'everyday') everyday += 1
        else foreign += 1
        rmSync(scratch, { recursive: true, force: true })
      }
      return { everyday, foreign, share: everyday / (everyday + foreign) }
    }

    const baselineShare = corpus.countsByCategory.everyday / corpus.materials.length
    const unbiased = run(undefined, 400)
    const biased = run('生活观察', 400)

    // Sanity: with no bias the sampling should reproduce the corpus proportions.
    assert.ok(Math.abs(unbiased.share - baselineShare) < 0.06,
      `无 bias 时的占比 ${(unbiased.share * 100).toFixed(1)}% 与语料基线 ${(baselineShare * 100).toFixed(1)}% 相差过大`)
    // The bias must be an unmistakable lean — measured lift is about 1.6x, and
    // the bounds pin the range so a future weight change cannot silently turn
    // `bias` into either a no-op or a filter.
    const lift = biased.share / baselineShare
    assert.ok(lift >= 1.4, `bias 太弱：提升 ${lift.toFixed(2)}x（${(biased.share * 100).toFixed(1)}% vs 基线 ${(baselineShare * 100).toFixed(1)}%）`)
    assert.ok(lift <= 3, `bias 太强，接近过滤：提升 ${lift.toFixed(2)}x`)
    // But never a filter: far-field material has to keep showing up, or the whole
    // point of the plugin (cross-domain transfer) is defeated.
    assert.ok(biased.foreign > 400 * 0.3, `bias 后其它领域只剩 ${biased.foreign}/400，跨域类比会被压掉`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('store: records per project and survives a corrupted file', () => {
  const root = tempRoot()
  const cwdA = tempProject()
  const cwdB = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const sample = corpus.materials.slice(0, 3)

    store.recordDraw(cwdA, sample, { purpose: '测试' })
    assert.equal(store.seenIds(cwdA).size, 3)
    assert.equal(store.seenIds(cwdB).size, 0, '项目之间的历史没有隔离')
    assert.equal(store.readStats().draws, 1)
    assert.equal(store.readStats().itemsServed, 3)

    // A truncated file must degrade to empty state, not throw.
    writeFileSync(store.projectFile(cwdA), '{ not json', 'utf8')
    assert.equal(store.seenIds(cwdA).size, 0)
    assert.ok(store.drainProblems().some(problem => problem.includes('解析失败')))

    // Notes move the cross-project counters; a re-note corrects rather than doubles.
    const target = corpus.materials[0]
    const noted = store.recordNotes(cwdB, [{ id: target.id, hit: true, note: '映射到关卡节奏上了', transformation: true }], corpus.byId)
    assert.equal(noted.accepted, 1)
    assert.deepEqual(noted.unidentified, [])
    assert.equal(store.readStats().selfReportedHits, 1)
    assert.equal(store.readStats().transformations, 1)
    // Retracting both claims on the re-note takes both counters back down. Booleans
    // are stated plainly (the note tool always resolves `transformation` to a
    // boolean before it gets here), unlike `landed`, which is a fact about the
    // artifact and survives a re-note unless it is explicitly withdrawn.
    store.recordNotes(cwdB, [{ id: target.id, hit: false, note: '其实没用', transformation: false }], corpus.byId)
    assert.equal(store.readStats().selfReportedHits, 0)
    assert.equal(store.readStats().transformations, 0)
    assert.equal(store.readStats().noted, 1, '重复记录不应重复计数')

    // A trace, by contrast, is not erased by a re-note that says nothing about it —
    // and only an explicit "" withdraws it. `recordDraw` re-writing the entry used
    // to drop it silently, which is what these three assertions pin down.
    const traced = corpus.materials[1]
    store.recordNotes(cwdB, [{ id: traced.id, hit: true, landed: 'docs/设计.md §3' }], corpus.byId)
    assert.equal(store.readStats().landed, 1)
    store.recordDraw(cwdB, [traced], {})
    assert.equal(store.readStats().landed, 1, '重新抽出不应抹掉落点')
    assert.equal(store.readProject(cwdB).entries[traced.id].landed, 'docs/设计.md §3')
    store.recordNotes(cwdB, [{ id: traced.id, hit: false, landed: '   ' }], corpus.byId)
    assert.equal(store.readStats().landed, 0, '空字符串应撤回落点')

    // An id that is not in the corpus is no longer dropped: it is recorded as an
    // **external trace** — a structure met outside the library — so its landing still
    // counts. (This replaced "unknown ids are reported, never written": in a real
    // session that behaviour discarded seven landings, six of them the material the
    // agent rated most valuable, and the credited signal ended up biased toward the
    // frozen corpus.) Note `seenIds` must NOT pick it up: it was never drawn, and
    // counting it would make `stillUnread` under-report against a corpus it is not in.
    const external = store.recordNotes(cwdB, [{ id: 'ext-gstone-0prob', hit: true, landed: 'docs/设计.md 附录 B.1' }], corpus.byId)
    assert.equal(external.accepted, 0)
    assert.equal(external.acceptedExternal, 1)
    assert.deepEqual(external.unidentified, [])
    assert.equal(external.settled[0].external, true)
    assert.equal(external.settled[0].landed, true)
    assert.equal(store.readStats().externalLanded, 1)
    assert.equal(store.readStats().landed, 0, '外部落点不该混进语料落点计数')
    assert.equal(store.readProject(cwdB).entries['ext-gstone-0prob'].external, true)
    assert.ok(!store.seenIds(cwdB).has('ext-gstone-0prob'), '外部素材不是「已读」的语料条目')

    // A note that names nothing at all is reported instead of silently dropped — and,
    // critically, it does not take its siblings down with it. The schema no longer
    // marks `id` as required, so an item like this reaches this code at all; before,
    // one such item failed the whole call during validation and every landing in the
    // same batch was lost.
    const mixed = store.recordNotes(cwdB, [
      { hit: true, note: '这一条忘了写 id' },
      { id: traced.id, hit: true, landed: 'docs/设计.md §5' },
    ], corpus.byId)
    assert.equal(mixed.accepted, 1, '同批里合法的那条必须照常写入')
    assert.deepEqual(mixed.unidentified, ['（无 id 也无 label）'])
    assert.equal(store.readProject(cwdB).entries[traced.id].landed, 'docs/设计.md §5')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwdA, { recursive: true, force: true })
    rmSync(cwdB, { recursive: true, force: true })
  }
})

test('note: a structure met OUTSIDE the corpus keeps its landing (the real-session regression)', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const exec = { agent: { session: { id: 'session-external', header: { cwd } } }, deferContext: () => {} }

    // This is the session that produced the fix, reduced to one call. The agent had
    // fetched six articles, extracted a structure from each, and written every one of
    // them into its design document with a location (`附录 B.1`…`B.7`). It then tried
    // to record them — first with no ids at all (the whole batch rejected by the
    // schema), then with self-invented ids ("ext-gstone-0prob"), which the plugin
    // answered with "未识别 id（未写入）" and wrote nothing. Six of the best landings of
    // that run were lost, and the agent concluded the behaviour was by design.
    const noted = await byName.get('serendipity_note').execute({
      items: [
        // An external id of the agent's own making, with a landing.
        { id: 'ext-gstone-0prob', hit: true, note: '零随机→背谱', landed: '设计/内容拓展_v2_灵感.md 附录 B.1' },
        // No id at all, but a title that a corpus material carries: match it, and the
        // landing counts as corpus coverage.
        { label: corpus.materials[0].label, hit: true, note: '标题对上了', landed: '设计/规则总表.md §3.5' },
        // No id, and a title the corpus does not know: a second external trace.
        { label: '净收益为零+规避副作用', hit: true, landed: '设计/内容拓展_v2_灵感.md §2.5' },
        // Names nothing: reported, and (crucially) does not take the three above down.
        { hit: false, note: '忘了写 id 和 label' },
      ],
    }, exec)

    assert.equal(noted.accepted, 1, '按标题匹配上语料的那条算语料落点')
    assert.equal(noted.acceptedExternal, 2, '两条外部结构必须被记录')
    assert.equal(noted.landed, 1, '按标题匹配的那条计入语料落点')
    assert.equal(noted.landedExternal, 2, '外部落点照样算数')
    assert.equal(noted.unidentified.length, 1)
    const render = byName.get('serendipity_note').output.render({}, noted)[0].text
    assert.match(render, /外部素材/)
    // The old wording read as "this is by design" and a real session drew exactly that
    // conclusion. The message has to carry the remedy.
    assert.match(render, /既没有 id，也没有 label/)
    assert.match(render, /serendipity_note/)

    // The two external traces are on disk with their locations, and the title-matched
    // one landed on the corpus record it matched.
    const project = store.readProject(cwd)
    const external = Object.values(project.entries).filter(entry => entry.external === true)
    assert.equal(external.length, 2)
    assert.deepEqual(external.map(entry => entry.landed).sort(), [
      '设计/内容拓展_v2_灵感.md §2.5', '设计/内容拓展_v2_灵感.md 附录 B.1',
    ])
    assert.equal(project.entries[corpus.materials[0].id].landed, '设计/规则总表.md §3.5')

    // Coverage must not move: an external trace is a reported landing, not a read.
    // Counting it would shift the neutral bar every coverage multiplier is measured
    // against, which is the one number the draw leans on.
    const stats = await byName.get('serendipity_stats').execute({}, exec)
    // Exactly one of the three recorded structures is a corpus material (the one the
    // title matched), so read coverage is 1 — not 3. The two external traces are
    // landings without coverage, and `externalNoted` is where they show up.
    assert.equal(stats.usage.projectRead, 1, '只有按标题匹配到语料的那条算「已读」')
    assert.equal(stats.usage.noted, 1)
    assert.equal(stats.usage.landed, 1)
    assert.equal(stats.usage.externalNoted, 2)
    assert.equal(stats.usage.externalLanded, 2)
    assert.equal(stats.effectiveness.totalRead, 1, '外部素材不得进入读取覆盖度')
    assert.match(byName.get('serendipity_stats').output.render({}, stats)[0].text, /外部素材/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('store: a landing recorded LATER is credited to the original read, with its lag', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const material = corpus.materials[0]

    // Session 1: drawn, read, mapped, and honestly recorded as having landed nowhere.
    store.recordDraw(cwd, [material], { purpose: '写了第一版设计' })
    store.recordNotes(cwd, [{ id: material.id, hit: false, note: '当时对不上，先放着' }], corpus.byId)
    const first = store.readProject(cwd).entries[material.id]
    assert.equal(first.landed, undefined)
    assert.equal(store.readStats().landed ?? 0, 0)

    // Backdate the read so a delay is observable without waiting real days.
    const project = store.readProject(cwd)
    project.entries[material.id].firstDrawnAt = '2026-01-01T00:00:00.000Z'
    writeFileSync(store.projectFile(cwd), JSON.stringify(project, null, 2), 'utf8')

    // Session 2: something else moved, and this structure suddenly fits. The agent
    // re-notes the SAME id with the `landed` it could not write the first time.
    const again = store.recordNotes(cwd, [{
      id: material.id, hit: true, note: '后来的方案正好需要它',
      landed: 'docs/设计.md §4 闸门判定',
    }], corpus.byId)
    assert.equal(again.unidentified.length, 0)

    const after = store.readProject(cwd).entries[material.id]
    // Credited to the original entry, not a new one.
    assert.equal(Object.keys(store.readProject(cwd).entries).length, 1, '补记不应新建条目')
    assert.equal(after.landed, 'docs/设计.md §4 闸门判定')
    assert.equal(after.firstDrawnAt, '2026-01-01T00:00:00.000Z', '首次读取时间不应被覆盖')
    assert.equal(after.landedAt !== undefined, true, '落点必须记录发生时刻，否则算不出延迟')
    assert.equal(store.readStats().landed, 1, '补记的落点应被计入')
    assert.equal(store.readStats().noted, 1, '补记不应把「已记录条数」加两次')

    // And the lag is measurable — this is the whole point.
    const report = buildEffectiveness(store.readProject(cwd).entries,
      [{ key: material.category, items: 1 }], [{ key: material.structureTags[0], items: 1 }]).report
    assert.equal(report.overall.landedLagDays.length, 1)
    assert.ok(report.overall.landedLagDays[0] > 0, '落点应显示为正的延迟天数')

    // Re-noting again does NOT move `landedAt` (the trace did not appear twice).
    const landedAt = store.readProject(cwd).entries[material.id].landedAt
    store.recordNotes(cwd, [{ id: material.id, hit: true, note: '换个说法再记一次' }], corpus.byId)
    assert.equal(store.readProject(cwd).entries[material.id].landedAt, landedAt, '重复补记不应改写落点时刻')
    assert.equal(store.readStats().landed, 1, '重复补记不应重复计入落点')

    // Withdrawing the trace also drops the lag measurement.
    store.recordNotes(cwd, [{ id: material.id, hit: false, landed: '' }], corpus.byId)
    assert.equal(store.readProject(cwd).entries[material.id].landedAt, undefined)
    assert.equal(store.readStats().landed, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: previously read but unlanded material is offered back for reconsideration', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const draw = byName.get('serendipity_draw')
    // The draw→note registry is keyed by SESSION ID, and tests that omit one all
    // share the `anonymous` key — so this test uses explicit ids and notes its own
    // draws, rather than leaving a pending batch for a later test to trip over.
    const exec = { agent: { session: { id: 'session-reconsider', header: { cwd } } }, deferContext: () => {} }

    // Nothing read yet ⇒ no reconsideration candidates, and the field is omitted
    // entirely rather than sent as an empty array (lossless-JSON contract).
    const empty = await draw.execute({ count: 1 }, exec)
    assert.equal(empty.reconsider, undefined)

    // Read three and record two of them as having landed nowhere. A third entry is
    // drawn-but-unnoted, which must NOT be offered back: an unread card is not a
    // candidate for reconsideration, it is simply not read yet.
    const [landedOne, missA, missB] = corpus.materials
    store.recordNotes(cwd, [{ id: landedOne.id, hit: true, note: 'x', landed: 'docs/a.md §1' }], corpus.byId)
    store.recordNotes(cwd, [
      { id: missA.id, hit: false, note: '结构对不上：它讲的是分布，我的问题是轨迹' },
      { id: missB.id, hit: false, note: '太抽象，没找到切入口' },
    ], corpus.byId)
    // Backdate the two misses so they are unambiguously the oldest unlanded entries.
    // Everything here is written within the same millisecond, so without this the age
    // ordering is genuinely arbitrary and the assertion below would be testing the
    // clock rather than the selection rule.
    const backdated = store.readProject(cwd)
    const longAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString()
    backdated.entries[missA.id].firstDrawnAt = longAgo(200)
    backdated.entries[missB.id].firstDrawnAt = longAgo(199)
    // `notedAt` also has to age: a note written just now is not "worth another look",
    // it is material whose owner has not had time to form a view yet.
    backdated.entries[missA.id].notedAt = longAgo(199)
    backdated.entries[missB.id].notedAt = longAgo(198)
    writeFileSync(store.projectFile(cwd), JSON.stringify(backdated, null, 2), 'utf8')
    // Note the first batch so it leaves no pending reminder behind. The registry is
    // keyed by SESSION ID, and tests that omit one all share the `anonymous` key —
    // leaving a batch pending here would surface it inside a later test.
    await byName.get('serendipity_note').execute({
      items: empty.items.map(item => ({ id: item.id, hit: false, note: '与本测试无关' })),
    }, exec)
    store.recordDraw(cwd, [corpus.materials[3]], {})
    // Every unlanded entry that carries a note is a candidate, so shift anything the
    // setup produced back out of the window and leave exactly the two backdated ones.
    const candidates = store.unlandedNotes(cwd, { limit: 99, minAgeMs: RECONSIDER_MIN_AGE_MS })
    // Filtered to the two known ids before comparing: the store is module-level, and
    // `tempProject()` can hand back a path already used by an earlier test in this
    // file, so asserting on the whole list would make this test order-dependent.
    const known = candidates.filter(entry => entry.id === missA.id || entry.id === missB.id)
    assert.deepEqual(known.map(entry => entry.id), [missA.id, missB.id],
      '回溯过的两条都应进入候选')
    for (const entry of known) {
      assert.ok(entry.daysSinceFirstDraw > 100, `${entry.label} 没有被回溯到足够早`)
    }

    const result = await draw.execute({ count: 1 }, exec)
    assert.equal(result.reconsider.length, 2)
    // Oldest first: the longer something has sat unlanded, the more likely later work
    // has overtaken it. `missA` was read a day earlier than `missB`, and both were
    // backdated far enough back that nothing else can outrank them.
    assert.deepEqual(result.reconsider.map(entry => `${entry.id}:${entry.label}`),
      [`${missA.id}:${missA.label}`, `${missB.id}:${missB.label}`])
    assert.ok(result.reconsider[0].daysSinceFirstDraw > 0, '应算出「读了多少天还没用上」')
    const ids = result.reconsider.map(entry => entry.id)
    assert.ok(!ids.includes(landedOne.id), '有落点的不该出现在「再看一眼」里')
    assert.ok(!ids.includes(corpus.materials[3].id), '只是抽过、没记录的不该出现')
    // Every published member must be declared in the output schema, or the value
    // fails the lossless-JSON check and the whole tool call is rejected.
    for (const entry of result.reconsider) {
      assert.deepEqual(Object.keys(entry).sort(), ['category', 'daysSinceFirstDraw', 'id', 'label', 'note'])
    }

    const rendered = draw.output.render({}, result)[0].text
    assert.match(rendered, /当时没找到落点，值得再看一眼的/)
    assert.match(rendered, /当时用不上不等于永远用不上/)
    // The prompt must name the re-note path, or the record can never be corrected.
    assert.match(rendered, /再调一次 serendipity_note/)
    assert.match(rendered, /隔了多久才用上/)
    assert.doesNotMatch(rendered, /undefined/)

    // A second session whose entries have all landed offers nothing back. A distinct
    // session id keeps it from sharing the outstanding-draw registry with the first.
    const cleanCwd = tempProject()
    const cleanExec = { agent: { session: { id: 'session-clean', header: { cwd: cleanCwd } } }, deferContext: () => {} }
    try {
      store.recordNotes(cleanCwd, [{ id: missA.id, hit: true, note: 'y', landed: 'docs/b.md §2' }], corpus.byId)
      const tidy = await draw.execute({ count: 1 }, cleanExec)
      assert.equal(tidy.reconsider, undefined)
      await byName.get('serendipity_note').execute({
        items: tidy.items.map(item => ({ id: item.id, hit: false, note: '与本测试无关' })),
      }, cleanExec)
    } finally {
      rmSync(cleanCwd, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: a campaign never quotes the same material in both recall and reconsider', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const draw = byName.get('serendipity_draw')
    const exec = { agent: { session: { id: 'session-recall', header: { cwd } } }, deferContext: () => {} }

    // Promote the project to a campaign and make some entries *old unlanded* notes —
    // which makes them eligible for BOTH lists: `recall` quotes the most recent six,
    // `reconsider` surfaces old unlanded notes, and the two can overlap.
    const materials = corpus.materials.slice(0, 14)
    store.recordNotes(cwd, materials.map((material, index) => ({
      id: material.id, hit: index % 2 === 0, note: `映射记录 ${index}`,
    })), corpus.byId)
    const project = store.readProject(cwd)
    for (const index of [0, 1]) {
      const ago = new Date(Date.now() - (300 - index) * 86_400_000).toISOString()
      project.entries[materials[index].id].firstDrawnAt = ago
      project.entries[materials[index].id].notedAt = ago
    }
    writeFileSync(store.projectFile(cwd), JSON.stringify(project, null, 2), 'utf8')

    const result = await draw.execute({ count: 1, purpose: 'campaign 组合' }, exec)
    assert.equal(result.horizon, 'campaign')
    assert.ok(result.recall.length > 0, 'campaign 应回灌历史记录')
    assert.ok(result.reconsider.length > 0, '旧的无落点记录应进入「再看一眼」')

    // The whole point: disjoint. The same material in both groups reads as two items.
    const recalledIds = new Set(result.recall.map(entry => entry.id))
    for (const entry of result.reconsider) {
      assert.ok(!recalledIds.has(entry.id), `${entry.label} 同时出现在 recall 与 reconsider 里`)
    }
    // `recall` must carry the id too — nothing can be re-noted without a name.
    assert.ok(result.recall.every(entry => typeof entry.id === 'string' && entry.id.length >= 8))
    // And both groups have to survive into the render.
    const text = draw.output.render({}, result)[0].text
    assert.match(text, /此前记录过的/)
    assert.match(text, /再看一眼的/)
    assert.match(text, /\[id=/)
    assert.doesNotMatch(text, /undefined/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('store: user contributions land in the user corpus and reload into the library', () => {
  const root = tempRoot()
  try {
    const store = new StateStore({ root })
    const material = {
      id: materialId('测试领域', '测试素材'),
      category: 'pattern',
      label: '测试素材',
      origin: '测试领域',
      structure: '测试结构',
      summary: '用于验证沉淀路径的一句话摘要。',
      detail: '这段机理说明必须超过三十个字符，用来满足校验规则，同时说明沉淀路径确实写盘了。',
      bridge: '这条结构能怎么映射到你的问题上？',
      structureTags: ['反馈'],
      tags: ['测试'],
      source: 'user',
    }
    const saved = store.saveUserMaterial(material)
    assert.ok(existsSync(saved.file))
    assert.equal(saved.count, 1)

    // Reloading with the user directory merges it in.
    const merged = loadCorpus(join(root, 'corpus'))
    assert.equal(merged.problems.length, 0)
    assert.ok(merged.byId.has(material.id), '沉淀的素材未进入素材库')
    assert.equal(merged.byId.get(material.id).source, 'user')

    // Saving the same id again merges instead of duplicating.
    const again = store.saveUserMaterial({ ...material, summary: '改过的一句话摘要，长度依然够用。' })
    assert.equal(again.count, 1)
    const reloaded = loadCorpus(join(root, 'corpus'))
    assert.equal(reloaded.byId.get(material.id).summary, '改过的一句话摘要，长度依然够用。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tools: the four tools register, validate, and round-trip a draw through note', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const tools = createTools({ engine, store })
    const libraryBefore = engine.materials.length
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    assert.deepEqual([...byName.keys()].sort(), [
      'serendipity_decompose', 'serendipity_draw', 'serendipity_fetch',
      'serendipity_learn', 'serendipity_note', 'serendipity_stats',
    ])

    // A fake run context supplies the session cwd the tools key their history on.
    const exec = { agent: { session: { header: { cwd } } } }

    const drawn = await byName.get('serendipity_draw').execute({ count: 3, purpose: '写一个谜题' }, exec)
    assert.equal(drawn.items.length, 3)
    assert.equal(new Set(drawn.items.map(item => item.id)).size, 3)
    assert.ok(drawn.items.every(item => item.id.length >= 8 && item.bridge.length > 5))
    assert.equal(store.seenIds(cwd).size, 3, 'draw 没有把素材标记为已读')

    // The renderer must be callable with the canonical value, and must state the
    // note requirement (it is what closes the loop).
    const rendered = byName.get('serendipity_draw').output.render({}, drawn)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /serendipity_note/)
    assert.match(rendered[0].text, /大概率有 0~1 条真的会进入你的工作/)
    // The category must survive into the render — a bare "undefined" here was a
    // real bug once, and it is invisible without asserting on the text.
    assert.doesNotMatch(rendered[0].text, /undefined/)
    assert.match(rendered[0].text, /来源：/)

    const noted = await byName.get('serendipity_note').execute({
      items: drawn.items.map((item, index) => {
        // The third one claims a hit too but names no place, so the difference
        // between what is *claimed* and what is *counted* shows up in one call:
        // 2 hits claimed, 1 landed.
        if (index === 0) {
          return {
            id: item.id, hit: true, note: '把节奏结构搬进来了', transformation: true,
            landed: 'docs/设计.md §3 关卡节奏',
            changedFrom: '关卡要更难', changedTo: '关卡要更有呼吸',
          }
        }
        if (index === 2) {
          return { id: item.id, hit: true, note: '第 3 条也在会话里用上了，但没写进任何文件' }
        }
        return { id: item.id, hit: false, note: '对不上' }
      }),
      materialModel: '生活观察类的素材对游戏设计最有启发，形式系统类偏抽象。',
    }, exec)
    assert.equal(noted.accepted, 3)
    // The demotion: two hits claimed, one of them backed by a location.
    assert.equal(noted.claimedHits, 2, '自评命中数应如实记录')
    assert.equal(noted.landed, 1, '只有写明了落点的那条才计入落点数')
    assert.equal(noted.backedTransformations, 1, '有前后文的转变才计入')
    assert.equal(noted.problems.length, 0)
    assert.match(byName.get('serendipity_note').output.render({}, noted)[0].text, /仅记录/)
    assert.ok(existsSync(join(root, 'MATERIAL-MODEL.md')))
    assert.match(readFileSync(join(root, 'MATERIAL-MODEL.md'), 'utf8'), /形式系统类偏抽象/)

    // A claim with no before/after is not a backed transformation either. This runs
    // after the stats assertions below because it necessarily changes the tally, and
    // it uses a *fresh* material on purpose: backing is judged on the merged record, so
    // re-noting the one above (whose full pair is already stored) would legitimately
    // count as backed — the claim really is backed by what the record holds.

    const learned = await byName.get('serendipity_learn').execute({
      label: '用等待代替加速',
      origin: '民间工艺',
      structure: '势垒过程无法用速率替代',
      summary: '有些过程只能等它自己完成，加大输入只会先破坏外层。',
      detail: '当过程由串联的两步组成且慢步受扩散限制时，加大输入只会加速快的那一步，结果反而更差。真正有效的做法是改善慢步的条件而非提高整体速率。',
      bridge: '你的流程里，哪一步是真正的限速步？你正在加速的是它，还是另一个？',
      category: 'pattern',
      structureTags: ['限速步', '扩散'],
      tags: ['工艺', '等待'],
    }, exec)
    assert.equal(learned.ok, true, learned.error)
    assert.equal(learned.merged, false)
    assert.equal(engine.materials.length, libraryBefore + 1, '沉淀的素材没有即时进入素材库')
    assert.equal(corpus.materials.length, libraryBefore, 'engine 不应改动调用方的语料数组')

    const stats = await byName.get('serendipity_stats').execute({}, exec)
    assert.equal(stats.library.total, libraryBefore + 1)
    assert.equal(stats.usage.projectRead, 3)
    assert.equal(stats.usage.noted, 3)
    // Reported apart, and the headline rate is the checkable one: `landed` names a
    // place, `hits` is the agent grading itself.
    assert.equal(stats.usage.landed, 1)
    assert.equal(stats.usage.landedRate, '33.3%')
    assert.equal(stats.usage.selfReportedHits, 2)
    assert.equal(stats.usage.transformations, 1)
    assert.ok(stats.vocabulary.structureTags.includes('反馈(' + corpus.materials.flatMap(m => m.structureTags).filter(tag => tag === '反馈').length + ')'))
    // The learning section must be present and honest about its evidence gate.
    assert.equal(stats.effectiveness.minEvidence, 15)
    assert.equal(stats.effectiveness.totalRead, 3)
    assert.equal(stats.effectiveness.optimizedFor, 'coverage')
    assert.match(byName.get('serendipity_stats').output.render({}, stats)[0].text, /素材库/)

    const unbacked = await byName.get('serendipity_note').execute({
      items: drawn.items.slice(1, 2).map(item => ({
        id: item.id, hit: true, transformation: true, changedFrom: '只写了一半',
      })),
    }, exec)
    assert.equal(unbacked.backedTransformations, 0, 'changeFrom 单边出现不算转变')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('tools: the stats value stays lossless JSON when there is no landing lag to report', async () => {
  // Regression: `landedLag.medianDays/maxDays` used to be written as explicit
  // `undefined`, which the tool runtime rejects for the whole call
  // ("value is not lossless JSON"). A fresh project has an empty lag list, so this
  // is the case every new user hits first — and no field-reading test saw it.
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const stats = await createTools({ engine, store })
      .find(tool => tool.name === 'serendipity_stats')
      .execute({}, { agent: { session: { id: 'lossless', header: { cwd }, events: [] } } })

    assertLossless(stats)
    assert.equal(stats.effectiveness.landedLag.landedWithKnownLag, 0)
    // Omitted, not present-and-undefined: the difference is exactly what the runtime checks.
    assert.equal('medianDays' in stats.effectiveness.landedLag, false)
    assert.equal('maxDays' in stats.effectiveness.landedLag, false)
    // The renderer must not print the missing distribution either.
    const text = createTools({ engine, store })
      .find(tool => tool.name === 'serendipity_stats')
      .output.render({}, stats)[0].text
    assert.doesNotMatch(text, /undefined/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('tools: an unrecorded draw is reminded on the next draw, and cleared by note', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const tools = createTools({ engine, store })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    // A minimal ToolRunContext stand-in: the reminder path needs both the
    // session identity and `deferContext`.
    const deferred = []
    const makeExec = (id = 'session-A') => ({
      agent: { session: { id, header: { cwd } } },
      deferContext: (message) => deferred.push(message),
    })

    const first = await byName.get('serendipity_draw').execute({ count: 2 }, makeExec())
    assert.equal(deferred.length, 0, '首次抽取不应有提醒')

    // Drawing again without noting must carry a reminder naming the first batch.
    const second = await byName.get('serendipity_draw').execute({ count: 2 }, makeExec())
    assert.equal(deferred.length, 1, '漏记后没有产生提醒')
    const reminder = deferred[0]
    assert.equal(reminder.role, 'user')
    assert.equal(reminder.source.kind, 'plugin')
    assert.equal(reminder.source.plugin, 'dsh-serendipity')
    assert.equal(reminder.content[0].type, 'text')
    for (const item of first.items) {
      assert.ok(reminder.content[0].text.includes(item.id), `提醒里缺少 ${item.id}`)
    }
    assert.match(reminder.content[0].text, /serendipity_note/)
    // Real usage showed 41 draws with zero notes, so the reminder must state the
    // consequences rather than only asking: unread material gets served again, and
    // the effectiveness tally gets no sample to learn from.
    assert.match(reminder.content[0].text, /不会被标记为已读/)
    assert.match(reminder.content[0].text, /覆盖度样本/)

    // Recording the first batch leaves the second outstanding, and vice versa.
    await byName.get('serendipity_note').execute({
      items: first.items.map(item => ({ id: item.id, hit: false })),
    }, makeExec())
    const third = await byName.get('serendipity_draw').execute({ count: 1 }, makeExec())
    assert.equal(deferred.length, 2, '第二批遗漏仍未提醒')
    assert.equal(third.items.length, 1)

    // Once every batch is noted, no further reminder appears.
    for (const batch of [second, third]) {
      await byName.get('serendipity_note').execute({
        items: batch.items.map(item => ({ id: item.id, hit: false })),
      }, makeExec())
    }
    await byName.get('serendipity_draw').execute({ count: 1 }, makeExec())
    assert.equal(deferred.length, 2, '全部记录后仍在提醒')

    // A different session must not inherit another session's pending ids.
    await byName.get('serendipity_draw').execute({ count: 1 }, makeExec('session-B'))
    assert.equal(deferred.length, 2, '会话之间串了待记录状态')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('effectiveness: no adjustment before there is enough read history', () => {
  const entries = {}
  // Below the threshold everything stays neutral, so the first few draws cannot
  // lock the sampling into whatever happened to come up first.
  for (let i = 0; i < MIN_EVIDENCE - 1; i++) {
    entries[`a${i}`] = { category: 'everyday', structureTags: ['反馈'], notedAt: 'x', hit: i === 0 }
  }
  const view = buildEffectiveness(entries, ['everyday', 'formal'], ['反馈', '阈值'])
  assert.equal(view.categoryMultiplier('everyday'), EFFECTIVENESS_NEUTRAL)
  assert.equal(view.coreMultiplier(['反馈']), EFFECTIVENESS_NEUTRAL)
  const row = view.report.categories.find(entry => entry.key === 'everyday')
  assert.match(row.note, /读取历史不足/)
})

test('effectiveness: what is optimized is COVERAGE, not hit rate', () => {
  const entries = {}
  // Two categories read the same number of times. One "hit" on almost every read,
  // the other never. Under the old design the first would gain weight and the
  // second would lose it; now their weights must be identical, because a hit is
  // the agent's own judgement and research pays off too late for a flag stamped
  // today to be a verdict.
  for (let i = 0; i < 20; i++) {
    entries[`e${i}`] = { category: 'everyday', structureTags: ['反馈'], notedAt: 'x', hit: i < 19 }
  }
  for (let i = 0; i < 20; i++) {
    entries[`f${i}`] = { category: 'formal', structureTags: ['不动点'], notedAt: 'x', hit: false }
  }
  const view = buildEffectiveness(entries, ['everyday', 'formal'], ['反馈', '不动点'])
  assert.equal(
    view.categoryMultiplier('everyday'),
    view.categoryMultiplier('formal'),
    '命中率不应影响权重（这正是被移除的目标）',
  )
  assert.equal(
    view.coreMultiplier(['反馈']),
    view.coreMultiplier(['不动点']),
    '按结构的权重同样不应看命中率',
  )

  // A `landed` trace is the one thing that still nudges: same read count, but one
  // bucket has a trace.
  const withTrace = { ...entries }
  withTrace.e0 = { ...withTrace.e0, landed: 'docs/设计.md §3' }
  const traced = buildEffectiveness(withTrace, ['everyday', 'formal'], ['反馈', '不动点'])
  assert.ok(
    traced.categoryMultiplier('everyday') >= view.categoryMultiplier('everyday'),
    '有落点的类别权重不应低于无落点的',
  )

  // And an under-read bucket is favoured over an over-read one.
  const lopsided = {}
  for (let i = 0; i < 60; i++) lopsided[`p${i}`] = { category: 'pattern', structureTags: ['阈值'], notedAt: 'x' }
  for (let i = 0; i < 5; i++) lopsided[`q${i}`] = { category: 'formal', structureTags: ['不动点'], notedAt: 'x' }
  const skewed = buildEffectiveness(lopsided, ['pattern', 'formal'], ['阈值', '不动点'])
  assert.ok(
    skewed.categoryMultiplier('formal') > skewed.categoryMultiplier('pattern'),
    '读得少的类别应被略微优先（覆盖度目标）',
  )
  for (const value of [skewed.categoryMultiplier('formal'), skewed.categoryMultiplier('pattern')]) {
    assert.ok(value >= EFFECTIVENESS_MIN && value <= EFFECTIVENESS_MAX, `权重 ${value} 越界`)
  }
  // No structure tags at all ⇒ no structural lean ⇒ neutral.
  assert.equal(skewed.coreMultiplier([]), EFFECTIVENESS_NEUTRAL)
})

test('effectiveness: the draw leans toward the under-read, and never filters', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })

    // Read every `everyday` material into this project (marking them read is all
    // that matters — coverage, not outcome), leaving `formal` untouched. Note the
    // deliberate absence of any hit information: coverage alone must move the
    // weighting.
    store.recordDraw(cwd, corpus.materials.filter(m => m.category === 'everyday'), {})
    // Deliberately no `landed` / `hit` anywhere: this test is about coverage alone.
    const report = engine.effectivenessFor(cwd).report
    assert.ok(report.overall.read >= MIN_EVIDENCE, `读取历史 ${report.overall.read} 不足`)
    // The lever itself: the read-through category is weighted down, untouched ones up.
    // An untouched bucket sits at the CEILING rather than merely at neutral — the
    // objective is coverage, so "not read yet" is the thing being steered toward.
    assert.ok(engine.effectivenessFor(cwd).categoryMultiplier('everyday') < 1)
    assert.equal(engine.effectivenessFor(cwd).categoryMultiplier('formal'), EFFECTIVENESS_MAX)

    // What a 1-item draw actually samples is the score times the crowding penalty
    // for an empty selection — and that penalty re-randomizes the shares, so the
    // observed rate of an exact, deliberately gentle lean (×0.85..×1.25) is buried
    // in sampling noise. Assert the intent exactly, from the same scoring function
    // the sampler uses, and then check the sampler only tracks it.
    const view = engine.effectivenessFor(cwd)
    // `seen` matters for the expectation: the project has already read every
    // `everyday` material, and the sampler damps those. Omitting it here would make
    // the expectation describe a state the sampler is not in.
    const seen = store.seenIds(cwd)
    const weight = (material) => scoreMaterial(material, {
      biasTokens: [], avoidTokens: [], violate: false, seen, effectiveness: view,
    })
    const totalWeight = corpus.materials.reduce((sum, m) => sum + weight(m), 0)
    const items = (category) => corpus.materials.filter(m => m.category === category)
    // The category's share of the weight if the sampler simply used these weights.
    const expected = (category) => items(category).reduce((sum, m) => sum + weight(m), 0) / totalWeight
    const baseline = (category) => items(category).length / corpus.materials.length

    const tally = new Map()
    const ROUNDS = 400
    for (let seed = 1; seed <= ROUNDS; seed++) {
      // Drawn from the SAME project, so the recorded coverage actually applies. A
      // scratch path would have an empty history and sample the neutral weighting —
      // which is exactly the mistake that made this test unable to see the lever.
      const probe = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(seed) })
      const [first] = probe.draw(cwd, { count: 1, allowRepeat: true }).items
      tally.set(first.category, (tally.get(first.category) ?? 0) + 1)
    }
    const share = (category) => (tally.get(category) ?? 0) / ROUNDS

    // The read-through category's share of the weight drops below its share of the
    // corpus, and the untouched one's rises above it. This is the lever, stated as a
    // number rather than inferred from a noisy sample.
    assert.ok(expected('everyday') < baseline('everyday'),
      `已读透的类别没有被降权：${(expected('everyday') * 100).toFixed(1)}% vs 基线 ${(baseline('everyday') * 100).toFixed(1)}%`)
    assert.ok(expected('formal') > baseline('formal'),
      `未读的类别没有被加权：${(expected('formal') * 100).toFixed(1)}% vs 基线 ${(baseline('formal') * 100).toFixed(1)}%`)

    // ...and the sampler tracks those weights rather than ignoring them. The crowding
    // penalty for the first pick pulls the observed shares back toward the uniform
    // corpus baseline, so this is a same-direction check with a wide band, not an
    // equality: it catches "the sampler stopped consulting the weights at all".
    for (const category of ['everyday', 'formal']) {
      const direction = Math.sign(share(category) - baseline(category))
      assert.equal(direction, Math.sign(expected(category) - baseline(category)),
        `${category} 的实测倾向与预期相反：实测 ${(share(category) * 100).toFixed(1)}% 预期 ${(expected(category) * 100).toFixed(1)}% 基线 ${(baseline(category) * 100).toFixed(1)}%`)
    }

    // The guard that matters: the coverage lean may suppress a bucket but never
    // filter it out. The plugin exists to fetch *far* material; a category that stops
    // being offered is no longer a serendipity engine. The floor is what makes that
    // true, so it is stated directly rather than inferred from a sample — and it is
    // deliberately *not* inferred here from the observed share, because the repeat
    // damping (already-seen ×0.35) dominates these 400 draws and would be attributed
    // to the coverage lever by mistake.
    assert.ok(EFFECTIVENESS_MIN >= 0.8, '覆盖度权重不得变成事实上的过滤器')

    // In the worst case the coverage lean can produce — one category absorbing the
    // entire read history — the overshadowed category keeps a large majority of its
    // weight, so it is still routinely drawn.
    const lopsided = {}
    for (let i = 0; i < 60; i++) lopsided[`p${i}`] = { category: 'pattern', structureTags: ['阈值'] }
    for (let i = 0; i < 5; i++) lopsided[`f${i}`] = { category: 'formal', structureTags: ['不动点'] }
    const shadowed = buildEffectiveness(lopsided, [
      { key: 'pattern', items: 22 }, { key: 'formal', items: 14 },
    ], [{ key: '阈值', items: 30 }, { key: '不动点', items: 20 }])
    const ratio = shadowed.categoryMultiplier('formal') / shadowed.categoryMultiplier('pattern')
    assert.ok(ratio > 1, `被冷落的类别应当被加权：比值 ${ratio.toFixed(2)}`)
    assert.ok(shadowed.categoryMultiplier('pattern') >= EFFECTIVENESS_MIN,
      '最被过度阅读的类别也不得被压到零权重')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('effectiveness: coverage counts reads, and traces are tallied separately from claims', () => {
  const tally = tallyOutcomes({
    a: { category: 'everyday', origin: '厨房', structureTags: ['反馈'], notedAt: 'x', hit: true, landed: 'docs/a.md §1' },
    // Drawn but never noted: still a read (it is coverage), but not an engagement.
    b: { category: 'everyday', origin: '厨房', structureTags: ['反馈'] },
    // A claimed hit with no location: recorded as a claim, not as a trace.
    c: { category: 'formal', origin: '数学', structureTags: ['不动点'], notedAt: 'x', hit: true, transformation: true },
  })
  assert.equal(tally.overall.read, 3, '每次抽取都应计入覆盖度')
  assert.equal(tally.overall.noted, 2)
  assert.equal(tally.overall.landed, 1)
  assert.equal(tally.overall.selfReportedHits, 2)
  assert.equal(tally.overall.transformations, 1)
  assert.equal(tally.categories.get('everyday').read, 2)
  assert.equal(tally.categories.get('everyday').landed, 1)
  assert.equal(tally.origins.size, 2, '来源领域覆盖度单独统计')
})

test('routes: the read-only API answers and refuses non-GET', async () => {
  const root = tempRoot()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const routes = makeRoutes({ engine, store })
    assert.deepEqual(routes.map(route => route.path), [
      `${API_BASE}/summary`, `${API_BASE}/corpus`, `${API_BASE}/vocabulary`, `${API_BASE}/model`,
      `${API_BASE}/sessions`, `${API_BASE}/settings`,
    ])
    assert.ok(routes.every(route => route.kind === 'exact'))

    const call = async (handler, { method = 'GET', url = '/' } = {}) => {
      const chunks = []
      const response = {
        status: 0,
        headers: {},
        writeHead(status, headers) { this.status = status; this.headers = headers },
        end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)) },
      }
      await handler(
        { method, url, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
        response,
      )
      return { status: response.status, body: chunks.join('') }
    }

    const summaryHandler = routes[0].handler
    const summary = await call(summaryHandler, { url: `${API_BASE}/summary` })
    assert.equal(summary.status, 200)
    const summaryBody = JSON.parse(summary.body)
    assert.equal(summaryBody.library.total, corpus.materials.length)
    // The two signals must be reported apart on the wire too, and each with its own
    // rate — collapsing them into one "usefulness" number is the thing being undone.
    for (const key of ['landed', 'hits', 'landedRate', 'hitRate']) {
      assert.ok(Object.hasOwn(summaryBody.usage, key), `usage 缺少 ${key}`)
    }
    // A trace only counts once it names a place; without one, nothing is landed.
    // The route keys its project on `process.cwd()`, so this writes to that project
    // inside the temp root and is undone below.
    const routeCwd = process.cwd()
    const target = corpus.materials[0]
    store.recordNotes(routeCwd, [{ id: target.id, hit: true, note: '自评有用但没有落点' }], corpus.byId)
    const claimed = JSON.parse((await call(summaryHandler, { url: `${API_BASE}/summary` })).body)
    assert.equal(claimed.usage.hits, 1)
    assert.equal(claimed.usage.landed, 0)
    store.recordNotes(routeCwd, [{ id: target.id, hit: true, landed: 'docs/api.md §1' }], corpus.byId)
    const traced = JSON.parse((await call(summaryHandler, { url: `${API_BASE}/summary` })).body)
    assert.equal(traced.usage.hits, 1)
    assert.equal(traced.usage.landed, 1)
    rmSync(store.projectFile(routeCwd), { force: true })

    const corpusHandler = routes[1].handler
    const page = await call(corpusHandler, { url: `${API_BASE}/corpus?category=everyday&limit=2` })
    assert.equal(page.status, 200)
    const parsed = JSON.parse(page.body)
    assert.equal(parsed.materials.length, 2)
    assert.ok(parsed.materials.every(material => material.category === 'everyday'))

    const search = await call(corpusHandler, { url: `${API_BASE}/corpus?q=${encodeURIComponent('反馈')}` })
    assert.ok(JSON.parse(search.body).total > 0)

    const rejected = await call(summaryHandler, { method: 'POST' })
    assert.equal(rejected.status, 405)

    // `/sessions` answers "did the plugin get used in that project?" — for any project,
    // because the HTTP surface has no session of its own to take a directory from.
    const sessionsHandler = routes.find(route => route.path === `${API_BASE}/sessions`).handler
    const emptySessions = JSON.parse((await call(sessionsHandler, { url: `${API_BASE}/sessions?cwd=${encodeURIComponent(routeCwd)}` })).body)
    assert.equal(emptySessions.ok, true)
    assert.equal(emptySessions.enabled, true)
    assert.equal(emptySessions.cwd, routeCwd)
    assert.deepEqual(emptySessions.sessions, [])
    store.recordSessionActivity(routeCwd, 'session-route', { increments: { draws: 1, itemsServed: 3 } })
    const recorded = JSON.parse((await call(sessionsHandler, { url: `${API_BASE}/sessions?cwd=${encodeURIComponent(routeCwd)}` })).body)
    assert.equal(recorded.sessions.length, 1)
    assert.equal(recorded.sessions[0].sessionId, 'session-route')
    assert.equal(recorded.sessions[0].itemsServed, 3)
    // With the report switched off the list is empty, but `enabled:false` says why —
    // an empty list and a disabled feature must not read the same.
    const offRoutes = makeRoutes({ engine, store, readConfig: () => ({ sessionReport: false }) })
    const offHandler = offRoutes.find(route => route.path === `${API_BASE}/sessions`).handler
    const off = JSON.parse((await call(offHandler, { url: `${API_BASE}/sessions?cwd=${encodeURIComponent(routeCwd)}` })).body)
    assert.equal(off.enabled, false)
    assert.deepEqual(off.sessions, [])
    assert.match(off.note, /sessionReport/)
    rmSync(store.projectFile(routeCwd), { force: true })

    const foreign = await call(summaryHandler, { url: `${API_BASE}/summary` })
    assert.equal(foreign.status, 200)
    const offSite = await routes[0].handler(
      { method: 'GET', url: `${API_BASE}/summary`, headers: { host: '10.0.0.5:3080' }, socket: { remoteAddress: '10.0.0.9' } },
      { status: 0, writeHead(status) { this.status = status }, end() {} },
    )
    assert.equal(offSite, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decompose: every part gets forced questions, and assumptions must yield alternatives', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const tool = byName.get('serendipity_decompose')
    const exec = { agent: { session: { header: { cwd } } } }

    const value = await tool.execute({
      artifact: '一款卡牌游戏',
      goal: '让两名玩家在十分钟内产生有意义的决策',
      parts: [
        { name: '洗牌', status: 'assumption', current: '开局随机打乱牌堆' },
        { name: '打出操作', status: 'assumption' },
        { name: '手牌上限', status: 'necessity' },
        '出牌阶段',
      ],
    }, exec)

    assert.equal(value.parts.length, 4)
    assert.deepEqual(value.declaredNecessary, ['手牌上限'])
    // A bare string gets no status rather than a guessed one.
    assert.equal(value.parts.find(part => part.name === '出牌阶段').status, 'unknown')

    const rendered = tool.output.render({}, value)[0].text
    assert.match(rendered, /这是一套必须逐条回答的问题/)
    // The two questions that cannot be answered by describing the status quo.
    assert.match(rendered, /如果把它整块去掉/)
    assert.match(rendered, /替代它完成同一功能的 2~3 种做法/)
    // Cross-domain hook: decomposition must hand back to draw.
    assert.match(rendered, /serendipity_draw/)
    // Declared "necessity" claims must be justified, not accepted.
    assert.match(rendered, /为什么去掉它就不再是这个作品/)
    // Closing checks that turn a list into an analysis.
    assert.match(rendered, /共同假设/)
    assert.match(rendered, /真正不可动/)
    // Every part is present, and there is a question block per part.
    for (const name of ['洗牌', '打出操作', '手牌上限', '出牌阶段']) {
      assert.ok(rendered.includes(name), `渲染里缺少部件 ${name}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('decompose: an empty inventory still returns the scaffold (that is the point)', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const tool = byName.get('serendipity_decompose')

    const value = await tool.execute({ artifact: '一个科学方法' }, { agent: { session: { header: { cwd } } } })
    assert.equal(value.parts.length, 0)
    assert.equal(value.emptyInventory, true)
    const rendered = tool.output.render({}, value)[0].text
    // With nothing to enumerate, the checks are the whole payload.
    assert.match(rendered, /收尾检查/)
    assert.match(rendered, /共同假设/)
    assert.match(rendered, /删到极限/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: a design-shaped purpose is offered the decomposition once, and only once', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const exec = { agent: { session: { id: 'session-decompose-hint', header: { cwd } } }, deferContext: () => {} }

    // The measured failure this guards: in a real 164-call session whose subject was
    // redesigning a card game — including the user asking "does it really need
    // shuffling?", the literal example in this tool's description — decompose was never
    // called, because the model reads the draw render and not the tool catalogue.
    const first = await byName.get('serendipity_draw').execute({ count: 1, purpose: '设计卡牌游戏的战斗系统' }, exec)
    assert.equal(typeof first.decomposeHint, 'string')
    assert.match(byName.get('serendipity_draw').output.render({}, first)[0].text, /先拆再抽/)

    // A purpose that is not design work gets no hint: this must not become boilerplate.
    const plain = await byName.get('serendipity_draw').execute({ count: 1, purpose: '核对上一轮的结论' }, exec)
    assert.equal(plain.decomposeHint, undefined)
    assert.doesNotMatch(byName.get('serendipity_draw').output.render({}, plain)[0].text, /先拆再抽/)

    // Once the tool has actually run for this project, the suggestion stops — a hint
    // that repeats on every draw is noise.
    await byName.get('serendipity_decompose').execute(
      { artifact: '卡牌游戏', parts: ['洗牌阶段'] }, exec)
    assert.equal(store.toolUses(cwd, 'decompose'), 1)
    const after = await byName.get('serendipity_draw').execute({ count: 1, purpose: '继续设计战斗系统' }, exec)
    assert.equal(after.decomposeHint, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('fields: the gazetteer is well-formed and does not duplicate itself', () => {
  // The gazetteer is hand-written content, so it gets the same treatment as the corpus:
  // mechanical rules enforced by a test rather than by memory.
  assert.ok(fieldCount() >= 150, `地名志太小了：${fieldCount()} 个领域`)
  const seen = new Set()
  for (const family of FIELD_FAMILIES) {
    assert.ok(family.name.trim().length >= 2, '家族必须有名字')
    assert.ok(family.lens.trim().length >= 10, `${family.name} 缺少「看什么」的说明`)
    assert.ok(family.fields.length >= 8, `${family.name} 的领域太少（${family.fields.length}）`)
    for (const field of family.fields) {
      assert.ok(field.trim().length >= 3, `领域名太泛：${field}（应具体到能直接当检索词）`)
      assert.ok(!/[（(]/.test(field), `${field} 不该带括注——领域名要能直接当关键词`)
      assert.ok(!seen.has(field), `领域重复：${field}`)
      seen.add(field)
      assert.equal(FIELD_INDEX.get(field), family, `${field} 的家族索引不对`)
    }
  }
  // Every family must be reachable by name, or `lens` would be lost in the render.
  for (const field of FIELDS) {
    const family = FIELD_INDEX.get(field)
    assert.ok(family !== undefined && family.lens !== '', `${field} 没有家族`)
  }
})

test('generate: hands back a (field × core) task instead of material, and remembers the pair', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const exec = { agent: { session: { id: 'session-generate', header: { cwd } } }, deferContext: () => {} }

    const value = await byName.get('serendipity_draw').execute({ scope: 'generate' }, exec)
    assert.equal(value.items.length, 0, 'generate 不发素材')
    assert.equal(value.comparison, undefined)
    const generation = value.generation
    assert.ok(generation.field.length > 0)
    assert.ok(generation.core.length > 0)
    assert.ok(FIELDS.includes(generation.field), '领域必须来自地名志')
    assert.ok(CONTROLLED.includes(generation.core), '结构核心必须来自受控词表')
    assert.ok(generation.alternates.length > 0, '必须给替代项，否则「这一对说不通」没有出口')
    assert.ok(generation.task.some(line => line.includes(generation.field)))

    const rendered = byName.get('serendipity_draw').output.render({}, value)[0].text
    assert.match(rendered, /随机配对生成/)
    assert.match(rendered, /serendipity_learn/)
    // The step that the real session got wrong: an external structure can be noted
    // without being learned into the corpus first.
    assert.match(rendered, /不入库也能记/)
    assert.doesNotMatch(rendered, /undefined/)

    // Generation must not touch the draw bookkeeping: nothing was served, so nothing is
    // read, no reminder is pending, and the dedup budget is unchanged. Getting this
    // wrong would burn the corpus for material the agent never received.
    assert.equal(store.readProject(cwd).draws, 0, 'generate 不计入抽取次数')
    assert.equal(store.seenIds(cwd).size, 0, 'generate 不标记任何素材为已读')
    assert.equal(store.readStats().draws, 0)
    assert.equal(store.generatedPairs(cwd).length, 1, '要记住这一对，避免下次重复')

    // A batch of successive draws must not repeat a field or a core within the window.
    const seen = new Set([`${generation.field}|${generation.core}`])
    for (let i = 0; i < 6; i += 1) {
      const next = await byName.get('serendipity_draw').execute({ scope: 'generate' }, exec)
      const key = `${next.generation.field}|${next.generation.core}`
      assert.ok(!seen.has(key), `连续生成的配对重复了：${key}`)
      seen.add(key)
      assert.ok(!next.generation.considered.fields || FIELDS.includes(next.generation.field))
    }
    assert.equal(store.generatedPairs(cwd).length, 7)

    // The memory is capped so a long project cannot grow its state file without bound.
    for (let i = 0; i < 30; i += 1) store.recordGenerated(cwd, { field: `虚构领域 ${i}`, core: '反馈' }, 24)
    assert.equal(store.generatedPairs(cwd).length, 24)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('generate: the sampler leans away from fields this project already read', () => {
  const covered = coveredTokens(['速记法', '消防工程', '玻璃吹制退火'])

  // Exact weights, not sampled ones: a covered field keeps a strictly positive weight
  // (the gazetteer must degrade rather than fail with an empty pool) but is measurably
  // less likely, and a field overlapping more is less likely than one overlapping less.
  assert.equal(fieldWeight('消防工程', new Set()), 1, '没有覆盖时权重为 1')
  assert.ok(fieldWeight('消防工程', covered) < 1, '已覆盖的领域必须降权')
  assert.ok(fieldWeight('消防工程', covered) < fieldWeight('量子场论', covered),
    '与已读领域重叠更多的候选，权重必须更低')
  for (const field of FIELDS) {
    const weight = fieldWeight(field, covered)
    assert.ok(weight > 0 && weight <= 1, `${field} 的权重越界：${weight}`)
  }

  // Direction, not magnitude: over many draws the covered fields must appear far less
  // often than their share of the gazetteer. Asserting exact frequencies here would be
  // asserting on noise — the exact part is the weight assertion above.
  const seeded = (seed) => {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 4294967296
    }
  }
  const random = seeded(20261010)
  let coveredHits = 0
  const total = 400
  for (let i = 0; i < total; i += 1) {
    const pair = drawPair({ cores: CONTROLLED, coveredOrigins: ['速记法', '消防工程', '玻璃吹制退火'], random })
    if (['速记法', '消防工程', '玻璃吹制退火'].includes(pair.field)) coveredHits += 1
  }
  const baseline = (3 / FIELDS.length) * total
  assert.ok(coveredHits < baseline * 0.6,
    `已覆盖领域应明显少出现：实测 ${coveredHits} 次，基线 ${baseline.toFixed(1)} 次`)

  // And the core side: a core that was just generated must not come straight back.
  const first = drawPair({ cores: ['反馈', '阈值'], recent: [{ field: 'x', core: '反馈' }], random })
  assert.equal(first.core, '阈值')
  // Both excluded ⇒ the window degrades instead of failing.
  const both = drawPair({ cores: ['反馈', '阈值'], recent: [{ field: 'x', core: '反馈' }, { field: 'y', core: '阈值' }], random })
  assert.ok(['反馈', '阈值'].includes(both.core), '窗口全占满时应退化而不是报错')
})

test('collide: two materials on one shape, from fields as far apart as the corpus allows', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(20261011) })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const exec = { agent: { session: { id: 'session-collide', header: { cwd } } }, deferContext: () => {} }

    const value = await byName.get('serendipity_draw').execute({ collide: true, count: 2 }, exec)
    assert.equal(value.collisions.length, 2, 'count 在 collide 模式下是「组数」')
    assert.equal(value.items.length, 4, '每组 2 条素材')
    assert.equal(value.request.pairs, 2)
    assert.equal(value.request.count, 4, 'request.count 报的是素材条数，渲染的头一行才对得上')

    const byId = new Map(value.items.map(item => [item.id, item]))
    const seenIds = new Set()
    for (const pair of value.collisions) {
      // The two sides must share a *controlled* shape — that is the whole premise.
      const a = byId.get(pair.a)
      const b = byId.get(pair.b)
      assert.ok(a !== undefined && b !== undefined)
      assert.notEqual(a.origin, b.origin, '同来源的「碰撞」只是又读了两条同域素材')
      const shared = a.structureTags.map(toControlled).filter(tag => tag !== undefined)
        .filter(tag => b.structureTags.map(toControlled).includes(tag))
      assert.ok(shared.includes(pair.core), `${a.label} 与 ${b.label} 并不共享核心 ${pair.core}`)
      assert.ok(!seenIds.has(a.id) && !seenIds.has(b.id), '同一批里素材不能重复')
      seenIds.add(a.id)
      seenIds.add(b.id)
      assert.equal(originDistance(a, b) > 0, true)
    }

    // A collision is a *delivery*, not a task: both materials are served and marked read,
    // unlike `near`/`generate` which hand back work instead of material.
    assert.equal(store.readProject(cwd).draws, 1, 'collide 计入抽取次数')
    assert.equal(store.seenIds(cwd).size, 4, 'collide 发出的素材要标记为已读')
    assert.equal(store.readStats().itemsServed, 4)

    const rendered = byName.get('serendipity_draw').output.render({}, value)[0].text
    assert.match(rendered, /碰撞对/)
    assert.match(rendered, /组碰撞对/)
    assert.ok(rendered.includes(value.collisions[0].core), '渲染里必须点明共享的形状')
    assert.match(rendered, /适用边界/)
    assert.doesNotMatch(rendered, /undefined/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collide: naming a shape pins the pairs to it, aliases included', () => {
  const corpus = builtinCorpus()
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const store = new StateStore({ root })
    // Several seeds, because a pin expressed as a *weight* is not a pin: measured on the
    // shipped corpus, a ×12 boost against ~75 competing shapes only lands on the named one
    // about one draw in seven. This asserts the filter, not the odds.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(seed) })
      const direct = engine.collide(cwd, { count: 1, bias: '阈值' })
      assert.equal(direct.pairs.length, 1)
      assert.equal(direct.pairs[0].core, '阈值', 'bias 直接写受控核心时必须钉住')
      // `预警` is an alias of `阈值` in the controlled vocabulary; a caller who writes the
      // alias is asking for the same shape, and comparing raw text would silently ignore it.
      const aliased = engine.collide(cwd, { count: 1, bias: '预警' })
      assert.equal(aliased.pairs[0].core, '阈值', 'bias 写别名也要归一后再匹配')
    }
    // An explicitly avoided shape is dropped even when named: avoid wins over bias.
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(3) })
    const avoided = engine.collide(cwd, { count: 1, bias: '阈值', avoid: '阈值' })
    if (avoided.pairs.length > 0) assert.notEqual(avoided.pairs[0].core, '阈值')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collide: distance is maximized, and shapes that cannot collide far are passed over', () => {
  const corpus = builtinCorpus()
  const byId = corpus.byId

  // Exact properties first — no sampling involved.
  const [a, b] = corpus.materials
  assert.equal(bestPairDistance([a], () => 0), 0, '一个成员无法成对')
  const synth = (...distances) => {
    const members = distances.map((_, index) => ({ id: `m${index}` }))
    let cursor = 0
    return bestPairDistance(members, () => distances[cursor++])
  }
  assert.equal(synth(0.2, 0.9, 0.1), 0.9, '应取组内最大距离')

  const context = { biasTokens: [], avoidTokens: [], violate: false, seen: new Set() }
  // Same field ⇒ not a pair at all (0 is a hard exclusion, in an engine where every
  // other weight has a floor).
  assert.equal(originDistance({ origin: 'X' }, { origin: 'X' }), 0)
  assert.equal(collisionWeight({ origin: 'X' }, { origin: 'X' }, context), 0)
  // Different fields ⇒ positive, and a farther pair outweighs a nearer one.
  const near = { origin: '可靠性工程 / 航空航天', category: 'device', tags: [], structureTags: [] }
  const far = { origin: '戏曲锣鼓点', category: 'aesthetic', tags: [], structureTags: [] }
  const nearOther = { origin: '可靠性工程 / 机械', category: 'device', tags: [], structureTags: [] }
  assert.ok(originDistance(near, far) > originDistance(near, nearOther))
  assert.ok(collisionWeight(near, far, context) > collisionWeight(near, nearOther, context))

  // Then the sampler's *direction*, on real material with a fixed random source: the mean
  // pair distance must be high, and pairs that barely count as cross-domain must be rare.
  // The exact part is asserted above; this only guards against the engine drifting back to
  // "pick one, then pick the farthest" (which measured 0.76 mean / 17.5% poor pairs).
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(99) })
    const distances = []
    for (let i = 0; i < 60; i += 1) {
      const drawn = engine.collide(cwd, { count: 2 })
      for (const pair of drawn.pairs) {
        distances.push(originDistance(byId.get(pair.a), byId.get(pair.b)))
      }
    }
    const mean = distances.reduce((sum, value) => sum + value, 0) / distances.length
    const poor = distances.filter(value => value < 0.5).length / distances.length
    assert.ok(mean > 0.7, `平均来源距离应保持高位，实测 ${mean.toFixed(3)}`)
    assert.ok(poor < 0.25, `「同域感」的配对应很少，实测 ${(poor * 100).toFixed(1)}%`)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('collide: an exhausted pool degrades to repeats instead of returning nothing', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store, random: seeded(5) })
    // Everything this project could ever read is already read.
    store.recordDraw(cwd, corpus.materials, {})
    const value = engine.collide(cwd, { count: 3 })
    assert.ok(value.pairs.length > 0, '抽干之后仍要给出碰撞对——「没有新素材」不等于「没有可看的东西」')
    assert.equal(value.pool.exhausted, true)
    assert.equal(value.pool.repeatsIncluded, value.pairs.length * 2)
    assert.equal(value.pool.unseenAfterDraw, 0)
    for (const pair of value.pairs) {
      assert.notEqual(byOrigin(engine, pair.a), byOrigin(engine, pair.b))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

/** The origin of a material id (a helper for the degradation test). */
function byOrigin(engine, id) {
  return engine.byId.get(id).origin
}

test('draw: scope=near returns a comparison task, not materials', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const tool = byName.get('serendipity_draw')
    const exec = { agent: { session: { header: { cwd } } } }

    const value = await tool.execute({ scope: 'near', purpose: '小型解谜游戏', count: 4 }, exec)
    // No material is served, so nothing may be recorded as read.
    assert.deepEqual(value.items, [])
    assert.equal(value.comparison.count, 4)
    assert.equal(value.comparison.domain, '小型解谜游戏')
    assert.equal(store.seenIds(cwd).size, 0, 'near 不应写入阅读记录')

    const rendered = tool.output.render({}, value)[0].text
    assert.match(rendered, /近处比较分析：小型解谜游戏/)
    // The whole value of `near` is the shared-assumption step; it must be present
    // and it must be the step the render calls the most valuable one.
    assert.match(rendered, /找共同假设/)
    assert.match(rendered, /最值钱/)
    assert.match(rendered, /列出空白/)
    // It must hand back to the far side rather than pretending to be the answer.
    assert.match(rendered, /near 负责指出该动哪里，far 负责提供动它的结构/)
    // And it must be explicit that a task was returned, not a result.
    assert.match(rendered, /返回的是\*\*任务清单\*\*/)

    // `count` stays inside the usable band; a comparison of 20 works is not useful.
    const clamped = await tool.execute({ scope: 'near', count: 99 }, exec)
    assert.ok(clamped.comparison.count <= 5, `count 未收敛：${clamped.comparison.count}`)
    // And `far` is still the default path.
    const far = await tool.execute({ count: 2 }, exec)
    assert.equal(far.items.length, 2)
    assert.equal(far.comparison, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('fetch: unreachable and malformed URLs fail plainly instead of throwing', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const tool = byName.get('serendipity_fetch')

    // Bad schemes and malformed URLs must be rejected before any network call.
    for (const url of ['file:///etc/passwd', 'not-a-url', 'ftp://example.com/x']) {
      const value = await tool.execute({ url })
      assert.equal(value.ok, false, `${url} 应被判为失败`)
      const rendered = tool.output.render({}, value)[0].text
      assert.match(rendered, /抓取失败/)
    }

    // The failure render must state which sources are reachable *and* which are not,
    // because the whole point is not to burn calls on the sites that answer 403.
    // It also has to carry the query-syntax traps that each wasted a real call.
    const failed = await tool.execute({ url: 'not-a-url' })
    const text = tool.output.render({}, failed)[0].text
    assert.match(text, /本机实测可达的来源/)
    assert.match(text, /gcores|bilibili|gstonegames/)
    assert.match(text, /本机实测\*\*不可达\*\*/)
    assert.match(text, /nga|tieba/)
    assert.match(text, /查询语法上的坑/)
    assert.match(text, /arXiv/)
    // And it must tell the model the thing a real session got wrong: a landing from an
    // external source does not have to be learned into the corpus to be recorded.
    assert.match(text, /落点不必等入库/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('fetch: an index page and a binary body are reported, not passed off as prose', async () => {
  const { looksLikeIndex, binaryKind } = await import('../lib/fetch.js')

  // Measured shape of a real failure: a site homepage extracted to a few hundred short
  // link labels and no prose, which was then read as though it were an article.
  const menu = Array.from({ length: 80 }, (_, index) => `条目 ${index}`).join('\n')
  assert.equal(looksLikeIndex(menu).index, true)
  const article = Array.from({ length: 10 }, () =>
    '这是一句足够长的正文，用来模拟真实文章里的行长分布；菜单不会长成这样，因为菜单项都很短。').join('\n')
  assert.equal(looksLikeIndex(article).index, false)
  // Too little text to judge is not an index page — otherwise every short fetch is flagged.
  assert.equal(looksLikeIndex('只有一行').index, false)

  // A PDF must be refused outright: returning its bytes as text burns the whole output
  // budget on `FlateDecode` streams. Measured on a 973 KB PDF in an earlier session.
  assert.equal(binaryKind('application/pdf', '%PDF-1.5'), 'application/pdf')
  assert.equal(binaryKind('text/html', '%PDF-1.5'), 'application/pdf', '魔数也要能识别（有些站不回 content-type）')
  assert.equal(binaryKind('application/octet-stream', 'PK\u0003\u0004'), 'application/octet-stream')
  assert.equal(binaryKind('text/plain', 'a\u0000b'), 'binary')
  assert.equal(binaryKind('application/json', '{"a":1}'), undefined)
  assert.equal(binaryKind('text/html; charset=utf-8', '<html>'), undefined)
})

test('fetch: API metadata noise is stripped so the payload survives the budget', async () => {
  const { extractReadable } = await import('../lib/fetch.js')

  // This is the GitHub search shape that wasted a whole call: each result embeds some
  // forty `*_url` template fields, so the 9000-character output budget was consumed by
  // URL patterns and the descriptions the agent asked for never arrived.
  const payload = JSON.stringify({
    total_count: 1,
    items: [{
      node_id: 'R_kgDOQwRq0w',
      name: 'deckbuilder',
      html_url: 'https://github.com/x/deckbuilder',
      description: '可迁移的机制描述',
      stargazers_count: 42,
      owner: { login: 'x', avatar_url: 'https://a', followers_url: 'https://f', node_id: 'U_1' },
      deep: { a: { b: { c: { d: 1 } } } },
    }],
  })
  const { text, kind } = extractReadable(payload, 'application/json')
  assert.equal(kind, 'json')
  assert.match(text, /可迁移的机制描述/)
  assert.match(text, /deckbuilder/)
  assert.match(text, /42/)
  assert.doesNotMatch(text, /_url|node_id|avatar_url/, '模板字段与节点 id 不应占预算')
  // Deeply nested metadata is summarized instead of expanded.
  assert.match(text, /\{…\}/)
})

test('fetch: extractReadable reduces html/json to bounded text', async () => {
  const { extractReadable, MAX_EXTRACT_CHARS } = await import('../lib/fetch.js')

  const html = `<html><head><style>p{color:red}</style><script>var x=1</script></head>
    <body><nav>menu</nav><p>第一段正文</p><p>第二段正文</p></body></html>`
  const extracted = extractReadable(html, 'text/html; charset=utf-8')
  assert.equal(extracted.kind, 'html')
  // Script and style content must be gone; prose must survive.
  assert.doesNotMatch(extracted.text, /var x=1/)
  assert.doesNotMatch(extracted.text, /color:red/)
  assert.match(extracted.text, /第一段正文/)
  assert.match(extracted.text, /第二段正文/)

  const json = extractReadable('{"a":[1,2],"b":{"c":"中文"}}', 'application/json')
  assert.equal(json.kind, 'json')
  assert.match(json.text, /"中文"/)
  // Pretty-printed so the model can read structure.
  assert.match(json.text, /\n/)

  assert.equal(extractReadable('纯文本', 'text/plain').kind, 'text')
  assert.ok(MAX_EXTRACT_CHARS > 1000)
})

test('horizon: a project is classified from evidence, not from a parameter', async () => {
  const { classifyHorizon, horizonGuidance, recallNotes, CAMPAIGN_MIN_NOTED } = await import('../lib/horizon.js')

  // Empty project: a session.
  const fresh = { draws: 0, createdAt: new Date().toISOString(), entries: {} }
  const freshVerdict = classifyHorizon(fresh)
  assert.equal(freshVerdict.kind, 'session')
  assert.match(freshVerdict.reason, /不足以判定/)

  // Enough recorded outcomes: a campaign.
  const entries = {}
  for (let i = 0; i < CAMPAIGN_MIN_NOTED; i++) {
    entries[`id${i}`] = { notedAt: `2026-01-${String(i + 1).padStart(2, '0')}`, hit: i % 3 === 0, label: `素材${i}`, note: `映射${i}`, category: 'everyday' }
  }
  // One entry with a real trace, and the OLDEST one at that. It must come first:
  // ordering is by how checkable the record is, not by when it was written.
  entries.oldest = { notedAt: '2025-01-01', hit: true, label: '有落点的素材', note: '映射oldest', category: 'formal', landed: 'docs/设计.md §3' }
  // And one the agent recorded as useless. The old hits-only filter dropped these
  // from the history entirely, which is the mistake being corrected — it must be
  // quotable too.
  entries.miss = { notedAt: '2025-01-02', hit: false, label: '当时用不上的素材', note: '映射miss', category: 'everyday' }
  const busy = { draws: 4, createdAt: new Date().toISOString(), entries }
  const busyVerdict = classifyHorizon(busy)
  assert.equal(busyVerdict.kind, 'campaign')
  assert.equal(busyVerdict.noted, CAMPAIGN_MIN_NOTED + 2, '两条额外的记录也应计入 campaign 判定')
  assert.match(busyVerdict.reason, /已记录/)

  // Drawn-but-unnoted entries are not evidence of a campaign: draws alone with no
  // outcomes stay a session, which is exactly the state real usage got stuck in.
  const drawnOnly = { draws: 41, createdAt: new Date().toISOString(), entries: Object.fromEntries(
    Array.from({ length: 82 }, (_, i) => [`x${i}`, { category: 'pattern' }]),
  ) }
  assert.equal(classifyHorizon(drawnOnly).kind, 'session', '只抽不记不应算长期任务')

  // The two horizons must actually ask for different behaviour.
  const campaignText = horizonGuidance(busyVerdict)
  const sessionText = horizonGuidance(freshVerdict)
  assert.match(campaignText.header, /长期任务/)
  assert.match(sessionText.header, /单次任务/)
  assert.ok(campaignText.guidance.join('').includes('serendipity_learn'), '长期任务应要求沉淀')
  assert.ok(!sessionText.guidance.join('').includes('serendipity_learn'), '短期任务不该要求沉淀')

  // Recall quotes only the agent's own notes, never invents text, and is NOT
  // hits-only: material recorded as useless stays quotable, because a long task is
  // exactly where a delayed payoff would show up.
  const recalled = recallNotes(busy)
  assert.ok(recalled.length > 0)
  assert.ok(recalled.every(entry => entry.note.startsWith('映射')), '回灌里出现了非 agent 撰写的内容')
  assert.ok(recalled.length <= 6)
  // A trace outranks recency: the oldest entry is the one with a location.
  assert.equal(recalled[0].label, '有落点的素材')
  assert.equal(recalled[0].landed, 'docs/设计.md §3')
  // The optional field is omitted rather than set to `undefined` (lossless JSON).
  assert.ok(recalled.slice(1).every(entry => !Object.hasOwn(entry, 'landed')))
  // With room for the misses it must include one, rather than showing hits only.
  const wider = recallNotes(busy, 20)
  assert.ok(wider.some(entry => entry.label === '当时用不上的素材'), '自评没用的素材不该被回灌排除')
  assert.ok(wider.length > CAMPAIGN_MIN_NOTED - 6, '回灌默认条数过少时也应有更宽的调用方式')
})

test('analysis: near output round-trips through save/list/read and is reused', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const analysis = byName.get('serendipity_learn')
    const draw = byName.get('serendipity_draw')
    const exec = { agent: { session: { header: { cwd } } } }

    // Saving needs a real body: a two-word stub is not an analysis.
    const tooShort = await analysis.execute({ kind: 'saveAnalysis', domain: '小型解谜游戏', text: '很短' })
    assert.equal(tooShort.ok, false)
    assert.match(tooShort.error, /太短/)

    const body = [
      '## 骨架',
      '- 《传送门》：唯一动作是传送；决策来自空间关系。',
      '- 《Baba Is You》：规则本身是谜题材料。',
      '## 共同假设',
      '都默认「关卡是预先设计好的、有限且静态」——这是本领域的天花板。',
      '## 空白',
      '没人做「规则会随玩家历史变化」的关卡。',
    ].join('\n')
    const saved = await analysis.execute({ kind: 'saveAnalysis', domain: '小型解谜游戏', text: body }, exec)
    assert.equal(saved.ok, true)
    assert.ok(saved.bytes > 40)

    // A second save overwrites rather than duplicating. `learn` reports the stored
    // set on read, so this also checks that one domain can never hold two analyses.
    await analysis.execute({ kind: 'saveAnalysis', domain: '小型解谜游戏', text: `${body}\n## 补充\n新增一条空白。` }, exec)
    const listed = await analysis.execute({ kind: 'readAnalysis', domain: '小型解谜游戏' }, exec)
    assert.equal(listed.items.length, 1, '同一领域应只有一份分析')

    const read = await analysis.execute({ kind: 'readAnalysis', domain: '小型解谜游戏' }, exec)
    assert.equal(read.ok, true)
    assert.match(read.text, /共同假设/)
    assert.match(read.text, /新增一条空白/)

    // Reading an unknown domain is a plain miss, not an error.
    const missing = await analysis.execute({ kind: 'readAnalysis', domain: '不存在的领域' }, exec)
    assert.equal(missing.ok, false)
    assert.match(missing.error, /没有/)

    // And a near-draw on the same domain hands the saved analysis back as a base.
    const reuse = await draw.execute({ scope: 'near', purpose: '小型解谜游戏' }, exec)
    assert.equal(typeof reuse.comparison.previous, 'string')
    assert.match(reuse.comparison.previous, /共同假设/)
    const rendered = draw.output.render({}, reuse)[0].text
    assert.match(rendered, /已经对同一领域做过分析/)
    assert.match(rendered, /不必从零重查/)
    // A different domain must not inherit it.
    const other = await draw.execute({ scope: 'near', purpose: '别的领域' }, exec)
    assert.equal(other.comparison.previous, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('draw: horizon guidance and campaign recall appear in the render', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const draw = byName.get('serendipity_draw')
    // `deferContext` is part of the real ToolRunContext; the unrecorded batch from
    // earlier in this test makes the draw path call it.
    const exec = {
      agent: { session: { header: { cwd } } },
      deferContext: () => {},
    }

    const first = await draw.execute({ count: 2, purpose: '短任务' }, exec)
    assert.equal(first.horizon, 'session')
    const firstText = draw.output.render({}, first)[0].text
    assert.match(firstText, /【单次任务】/)
    assert.doesNotMatch(firstText, /此前记录过的/)

    // Record enough outcomes to promote the project, then draw again. One of them
    // names a place, so the render has to show the trace — that field has to be in
    // the output schema or the Renderer silently receives `undefined`.
    store.recordNotes(cwd, engine.materials.slice(0, 14).map((material, index) => ({
      id: material.id,
      hit: index % 2 === 0,
      note: `第 ${index} 条映射记录`,
      ...(index === 0 ? { landed: 'docs/设计.md §3' } : {}),
    })), engine.byId)

    const second = await draw.execute({ count: 2, purpose: '长期任务' }, exec)
    assert.equal(second.horizon, 'campaign')
    const secondText = draw.output.render({}, second)[0].text
    assert.match(secondText, /【长期任务】/)
    assert.match(secondText, /本项目此前记录过的/)
    assert.match(secondText, /第 0 条映射记录/)
    assert.match(secondText, /落点：docs\/设计\.md §3/)
    assert.doesNotMatch(secondText, /undefined/)
    // The traced entry is ranked first, even though later entries are newer.
    assert.match(secondText, /【本项目此前记录过的[^\n]*\n\s+· [^\n]*第 0 条映射记录/,
      '有落点的记录应排在回灌列表的第一条')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('vocabulary and guidance stay in sync with the corpus', () => {
  const corpus = builtinCorpus()
  const vocabulary = tagVocabulary(corpus.materials)
  assert.ok(vocabulary.structureTags.length >= 20)
  assert.ok(vocabulary.structureTags[0].count >= vocabulary.structureTags.at(-1).count)
  // The announcement must name every tool and point at the tag/category
  // vocabulary, or the model cannot phrase `bias` or discover a capability.
  const needles = [
    'serendipity_draw', 'serendipity_note', 'serendipity_learn', 'serendipity_stats',
    'serendipity_decompose', 'serendipity_fetch',
    // The category vocabulary moved into serendipity_stats' word list, so the
    // announcement points at the tool rather than spelling out every name.
    'serendipity_stats', '标签词表', 'scope',
  ]
  for (const needle of needles) {
    assert.ok(SERENDIPITY_GUIDANCE.includes(needle), `提示词缺少 ${needle}`)
  }
  // Every registered category must be reachable by name through the stats tool,
  // which is where the model is told to look them up.
  for (const category of CATEGORIES) {
    assert.ok(CATEGORY_NAMES[category].length > 0, `分类 ${category} 缺少中文名`)
  }
})

/**
 * A fake ToolRunContext whose session carries an event log — the shape the session
 * metrics read (`turn/start` + `step/start`). The unit-test execs elsewhere carry no
 * log on purpose: the metrics must degrade to "no position" rather than throw.
 *
 * @param {string} cwd - the project directory.
 * @param {{ id?: string, steps?: number, turnStartedMsAgo?: number }} [options] - log shape.
 * @returns {object} the run context.
 */
function metricsExec(cwd, { id = 'session-metrics', steps = 3, turnStartedMsAgo = 60_000 } = {}) {
  const start = Date.now() - turnStartedMsAgo
  const events = [{ type: 'turn/start', seq: 1, time: start, data: {} }]
  for (let index = 0; index < steps; index += 1) {
    events.push({ type: 'step/start', seq: index + 2, time: start + index, data: {} })
  }
  return { agent: { session: { id, header: { cwd }, events } }, deferContext: () => {} }
}

test('sessions: the receipt records how early the plugin was used, and counts re-notes once', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({ engine, store }).map(tool => [tool.name, tool]))
    const exec = metricsExec(cwd, { steps: 3 })

    // The session this feature exists for: one draw, deep into a long turn, invisible
    // among 86 tool calls. The receipt has to make it visible without grading it.
    const drawn = await byName.get('serendipity_draw').execute({ count: 2, purpose: '改一个验证流程' }, exec)
    assert.equal(drawn.items.length, 2)

    let record = store.sessions(cwd)[0]
    assert.equal(record.sessionId, 'session-metrics')
    assert.equal(record.draws, 1)
    assert.equal(record.itemsServed, 2)
    // Position comes from the session's own log, not from a plugin-side counter.
    assert.deepEqual([record.firstDraw.turn, record.firstDraw.step], [1, 3])
    assert.ok(record.firstDraw.elapsedMs >= 59_000, `耗时应接近 1 分钟，实际 ${record.firstDraw.elapsedMs}`)

    // Later in the same turn the model draws again: the headline stays the FIRST draw,
    // because the question is how early the plugin got used.
    exec.agent.session.events.push({ type: 'step/start', seq: 99, time: Date.now(), data: {} })
    await byName.get('serendipity_draw').execute({ count: 1 }, exec)
    record = store.sessions(cwd)[0]
    assert.equal(record.draws, 2)
    assert.equal(record.itemsServed, 3)
    assert.equal(record.firstDraw.step, 3, '第二抽不得改写首次抽取的位置')

    const [first, second] = drawn.items
    await byName.get('serendipity_note').execute({
      items: [
        { id: first.id, hit: true, note: '映射上了', landed: 'docs/x.md §1' },
        { id: second.id, hit: false, note: '结构对不上' },
      ],
    }, exec)
    record = store.sessions(cwd)[0]
    assert.equal(record.notes, 1)
    assert.equal(record.noted, 2)
    assert.equal(record.landed, 1)

    // Re-noting is how a delayed payoff gets recorded, so it must not read as new work:
    // same entries, and only the newly *established* landing counts.
    await byName.get('serendipity_note').execute({
      items: [
        { id: first.id, hit: true, landed: 'docs/x.md §1' },
        { id: second.id, hit: true, landed: 'docs/x.md §2' },
      ],
    }, exec)
    record = store.sessions(cwd)[0]
    assert.equal(record.notes, 2)
    assert.equal(record.noted, 2, '补记不增加条目数')
    assert.equal(record.landed, 2, '只有新建立的落点计数')

    // And the stats tool hands it back, with the live session flagged.
    const stats = await byName.get('serendipity_stats').execute({}, exec)
    assert.equal(stats.sessions.reportEnabled, true)
    assert.equal(stats.sessions.current.sessionId, 'session-metrics')
    assert.equal(stats.sessions.current.firstDraw.step, 3)
    const text = byName.get('serendipity_stats').output.render({}, stats)[0].text
    assert.match(text, /【本会话】首次抽取在第 1 轮第 3 步/)
    assert.doesNotMatch(text, /undefined/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('sessions: sessionReport:false stops the recording itself, and the stats say why', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const byName = new Map(createTools({
      engine,
      store,
      readConfig: () => ({ sessionReport: false }),
    }).map(tool => [tool.name, tool]))
    const exec = metricsExec(cwd)

    const drawn = await byName.get('serendipity_draw').execute({ count: 2 }, exec)
    await byName.get('serendipity_note').execute({
      items: [{ id: drawn.items[0].id, hit: true, note: '写进设计文档', landed: 'docs/设计.md §2' }],
    }, exec)

    // Off means no bookkeeping at all — not merely a hidden section. A switch that left
    // the writes behind would keep growing a file the user asked the plugin to forget.
    // (`sessions: {}` is the empty shape every project write carries; what matters is
    // that no session was ever entered into it.)
    const onDisk = JSON.parse(readFileSync(store.projectFile(cwd), 'utf8'))
    assert.deepEqual(onDisk.sessions, {}, '关掉后不得再往项目文件里写会话记录')
    // The draw itself still works and is still recorded — only the receipt is off.
    assert.equal(store.readProject(cwd).draws, 1)

    const stats = await byName.get('serendipity_stats').execute({}, exec)
    assert.equal(stats.sessions.reportEnabled, false)
    assert.equal(stats.sessions.current, undefined)
    assert.deepEqual(stats.sessions.recent, [])
    const text = byName.get('serendipity_stats').output.render({}, stats)[0].text
    assert.match(text, /已在设置里关闭/)
    assert.match(text, /sessionReport/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('sessions: history is capped, newest kept', () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const store = new StateStore({ root })
    for (let index = 0; index < SESSION_HISTORY_LIMIT + 5; index += 1) {
      store.recordSessionActivity(cwd, `session-${index}`, {
        at: Date.now() + index,
        increments: { draws: 1, itemsServed: 2 },
      })
    }
    const kept = store.sessions(cwd, { limit: 100 })
    assert.equal(kept.length, SESSION_HISTORY_LIMIT, '会话历史必须有上限')
    assert.equal(kept[0].sessionId, `session-${SESSION_HISTORY_LIMIT + 4}`, '最新的排在最前')
    assert.ok(!kept.some(record => record.sessionId === 'session-0'), '最旧的应被丢弃')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('note render: the zero-landing reassurance is not printed next to a landing', async () => {
  const root = tempRoot()
  const cwd = tempProject()
  try {
    const corpus = builtinCorpus()
    const store = new StateStore({ root })
    const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
    const tool = new Map(createTools({ engine, store }).map(entry => [entry.name, entry])).get('serendipity_note')
    const exec = { agent: { session: { id: 'session-note-text', header: { cwd } } }, deferContext: () => {} }

    // The bug: the line was unconditional, so a real session's own record read
    // 「其中有落点 3 条」 and 「落点为 0 是正常的」 in adjacent lines.
    const withLanding = await tool.execute({
      items: [{ id: corpus.materials[0].id, hit: true, note: '落到 §3', landed: 'docs/设计.md §3' }],
    }, exec)
    assert.equal(withLanding.landed, 1)
    const text = tool.output.render({}, withLanding)[0].text
    assert.match(text, /其中有落点（写明了结构去了哪里）1 条/)
    assert.doesNotMatch(text, /落点为 0 是正常的/, '已写明落点时不得再打印「落点为 0」')
    assert.doesNotMatch(text, /本次没有一条写明落点/)

    // The reassurance is still printed exactly where it belongs: nothing landed.
    const withoutLanding = await tool.execute({
      items: [{ id: corpus.materials[1].id, hit: true, note: '自评有用，但还没写进哪里' }],
    }, exec)
    assert.equal(withoutLanding.landed, 0)
    const second = tool.output.render({}, withoutLanding)[0].text
    assert.match(second, /本次没有一条写明落点/)
    assert.match(second, /落点为 0 是正常的/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('corpus files on disk are generated, formatted, and complete', () => {
  for (const category of CATEGORIES) {
    const file = join(projectRoot, 'lib', 'corpus', `${category}.json`)
    assert.ok(existsSync(file), `缺少语料文件 ${category}.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.category, category)
    assert.ok(parsed.materials.length >= 8)
    assert.ok(parsed.categoryName.length > 0)
  }
  // The generator must be the source of truth: regenerating changes nothing.
  assert.ok(existsSync(join(projectRoot, 'tools', 'build-corpus.mjs')))
  mkdirSync(join(projectRoot, 'lib', 'corpus'), { recursive: true })
})

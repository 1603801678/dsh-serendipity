/**
 * Corpus loading and validation.
 *
 * The shipped corpus lives in `lib/corpus/<category>.json` next to this file and
 * is loaded once per process. A user may also contribute materials
 * (`serendipity_learn`), which live in the user directory and are merged in at
 * load time; user entries win on id collision so a contributed correction
 * replaces the shipped text.
 *
 * Every entry is validated here rather than at use time: a malformed material is
 * dropped with a recorded reason instead of reaching the model, and the
 * validator's complaints are surfaced by `serendipity_stats` so a corpus edit
 * cannot silently rot.
 *
 * @module @1603801678/dsh-serendipity/corpus
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialId } from './hash.js'

/** Category ids shipped with the plugin, in presentation order. */
export const CATEGORIES = ['pattern', 'device', 'surprise', 'everyday', 'formal', 'aesthetic']

/** Human-readable category names, used in renders and prompts. */
export const CATEGORY_NAMES = {
  pattern: '他域规律',
  device: '他域做法',
  surprise: '反直觉发现',
  everyday: '生活观察',
  formal: '形式系统',
  aesthetic: '艺术结构',
}

/** Fields every material must carry, with the minimum acceptable length. */
const REQUIRED_STRING_FIELDS = {
  label: 2,
  origin: 2,
  structure: 2,
  summary: 8,
  detail: 30,
  bridge: 8,
}

/** Directory holding the shipped corpus files. */
function corpusDir() {
  return join(dirname(fileURLToPath(import.meta.url)), 'corpus')
}

/**
 * Validate one raw material record.
 * @param {unknown} raw - a candidate record from a corpus file.
 * @param {string} fallbackCategory - category from the containing file.
 * @returns {{ ok: true, material: object } | { ok: false, reason: string, label: string }} the verdict.
 */
export function validateMaterial(raw, fallbackCategory) {
  const label = typeof raw?.label === 'string' ? raw.label.trim() : '(无标题)'
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '条目不是对象', label }
  }
  const missing = []
  for (const [field, min] of Object.entries(REQUIRED_STRING_FIELDS)) {
    const value = raw[field]
    if (typeof value !== 'string' || value.trim().length < min) missing.push(`${field}(>=${min} 字)`)
  }
  if (missing.length > 0) return { ok: false, reason: `字段缺失或过短: ${missing.join(', ')}`, label }

  const asTags = (value) => Array.isArray(value)
    ? value.filter(tag => typeof tag === 'string' && tag.trim() !== '').map(tag => tag.trim())
    : []

  const category = CATEGORIES.includes(raw.category) ? raw.category : fallbackCategory
  const origin = raw.origin.trim()
  const material = {
    id: typeof raw.id === 'string' && /^[0-9a-f]{8,}$/i.test(raw.id) ? raw.id : materialId(origin, label),
    category,
    label,
    origin,
    structure: raw.structure.trim(),
    summary: raw.summary.trim(),
    detail: raw.detail.trim(),
    bridge: raw.bridge.trim(),
    structureTags: asTags(raw.structureTags),
    tags: asTags(raw.tags),
    source: raw.source === 'user' ? 'user' : 'builtin',
  }
  if (material.structureTags.length === 0) {
    return { ok: false, reason: 'structureTags 为空（跨域检索的骨架，必须至少一个）', label }
  }
  return { ok: true, material }
}

/**
 * Read every `*.json` corpus file in one directory.
 * @param {string} dir - directory to scan.
 * @param {string} source - `builtin` or `user`, stamped onto each entry.
 * @returns {{ materials: object[], problems: string[] }} entries and complaints.
 */
function readCorpusDir(dir, source) {
  const materials = []
  const problems = []
  if (!existsSync(dir)) return { materials, problems }
  let files
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch (error) {
    return { materials, problems: [`无法读取语料目录 ${dir}: ${error.message}`] }
  }
  for (const name of files) {
    const file = join(dir, name)
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`${name}: JSON 解析失败 — ${error.message}`)
      continue
    }
    const fallbackCategory = CATEGORIES.includes(parsed?.category)
      ? parsed.category
      : name.replace(/\.json$/, '')
    const list = Array.isArray(parsed?.materials) ? parsed.materials : []
    if (list.length === 0) problems.push(`${name}: materials 为空或不是数组`)
    for (const raw of list) {
      const verdict = validateMaterial({ ...raw, source }, fallbackCategory)
      if (verdict.ok) materials.push(verdict.material)
      else problems.push(`${name} → 「${verdict.label}」: ${verdict.reason}`)
    }
  }
  return { materials, problems }
}

/**
 * Load the whole corpus: shipped entries plus every user contribution.
 * @param {string} [userCorpusDir] - directory of user-contributed corpus files.
 * @returns {{ materials: object[], byId: Map<string, object>, problems: string[], countsByCategory: Record<string, number> }} the loaded corpus.
 */
export function loadCorpus(userCorpusDir) {
  const builtin = readCorpusDir(corpusDir(), 'builtin')
  const user = userCorpusDir === undefined
    ? { materials: [], problems: [] }
    : readCorpusDir(userCorpusDir, 'user')

  const byId = new Map()
  for (const material of builtin.materials) byId.set(material.id, material)
  // User entries override shipped ones (a contributed correction wins).
  for (const material of user.materials) byId.set(material.id, material)

  const materials = [...byId.values()]
  const countsByCategory = {}
  for (const category of CATEGORIES) {
    countsByCategory[category] = materials.filter(m => m.category === category).length
  }
  return {
    materials,
    byId,
    problems: [...builtin.problems, ...user.problems],
    countsByCategory,
  }
}

/**
 * Every distinct tag in the corpus, with how many materials carry it — the
 * vocabulary the model needs to phrase `bias` and `avoid` well.
 * @param {object[]} materials - loaded materials.
 * @returns {{ tags: Array<{ tag: string, count: number }>, structureTags: Array<{ tag: string, count: number }> }} the vocabularies, most common first.
 */
export function tagVocabulary(materials) {
  const tally = (pick) => {
    const counts = new Map()
    for (const material of materials) {
      for (const tag of pick(material)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag))
  }
  return {
    tags: tally(m => m.tags),
    structureTags: tally(m => m.structureTags),
  }
}

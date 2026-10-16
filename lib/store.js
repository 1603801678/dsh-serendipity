/**
 * Durable state: one project's draw history, the cross-project tally, and the
 * agent's written model of the corpus.
 *
 * Three files under `~/.dsh/dsh-serendipity/`:
 * - `projects/<projectKey>.json` — every material this project has drawn, when,
 *   and (once noted) whether the analogy paid off. This is what makes
 *   `serendipity_draw` avoid handing the same material to the same project twice.
 * - `stats.json` — cross-project counters, so `serendipity_stats` can report
 *   hit-rate and transformation-rate across everything the plugin has ever done.
 * - `MATERIAL-MODEL.md` — the agent's own accumulating critique of the corpus
 *   ("formal 类偏抽象，写游戏时需要先具体化一步"). Kept as markdown because a
 *   human is expected to read it.
 *
 * Writes are atomic (temp file + rename) and every read tolerates corruption by
 * falling back to empty state with a recorded problem: losing usage history must
 * never take a session down.
 *
 * @module @1603801678/dsh-serendipity/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectKey, materialId } from './hash.js'
import { SESSION_HISTORY_LIMIT, capSessions, mergeActivity, newSessionRecord, recentSessions as listSessions } from './sessions.js'

/**
 * Prefix that marks a record as an **external trace**: a structure the agent met
 * outside the corpus (a fetched page, an article, its own reading) and whose
 * landing it reported. The prefix guarantees the id cannot collide with a corpus
 * id (16 hex characters, no prefix).
 */
export const EXTERNAL_ID_PREFIX = 'ext-'

/**
 * Stable id for a structure that is not in the corpus.
 *
 * Reported landings are the one credited signal, and the most valuable material of a
 * real session comes from *outside* the frozen corpus — a page fetched this morning,
 * not a card written at install time. Dropping those traces because they have no
 * draw behind them biases the signal toward the oldest part of the library, so they
 * get an id of their own instead: hashed from the label so a re-note of the same
 * structure merges instead of piling up.
 *
 * @param {string} label - what the structure is called.
 * @returns {string} an id such as `ext-1a2b3c4d5e6f7a8b`.
 */
export function externalId(label) {
  return `${EXTERNAL_ID_PREFIX}${materialId('external', label)}`
}

/** Root of the plugin's user state. */
export function stateRoot() {
  return join(homedir(), '.dsh', 'dsh-serendipity')
}

/** Directory of user-contributed corpus files (one JSON per category is fine). */
export function userCorpusDir() {
  return join(stateRoot(), 'corpus')
}

/** Absolute path of the agent's evolving model of the corpus. */
export function materialModelPath() {
  return join(stateRoot(), 'MATERIAL-MODEL.md')
}

/**
 * Directory of saved field analyses (the `scope: 'near'` work).
 *
 * A comparison analysis is expensive to produce — several searches plus
 * structural extraction — and it does not go stale quickly, so throwing it away
 * when the conversation moves on wastes the most costly thing the plugin asks
 * for. Saved as one markdown file per domain, keyed by a path-safe slug of the
 * domain rather than by project: two sessions working on the same field should
 * be able to reuse each other's baseline.
 *
 * @param {object} [store] - a store instance, to honour a test-overridden root.
 * @returns {string} absolute directory.
 */
export function analysesDir(store) {
  const root = store?.root ?? stateRoot()
  return join(root, 'analyses')
}

/** Turn a free-text domain into a stable, path-safe file slug. */
function domainSlug(domain) {
  const cleaned = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  // Non-ASCII (Chinese) is allowed and meaningful here, so only fall back when
  // nothing usable survives.
  return cleaned === '' ? 'unnamed-domain' : cleaned
}

/**
 * Save (or replace) the analysis for one domain.
 * @param {object} store - store instance (used for its root).
 * @param {string} domain - the field the analysis is about.
 * @param {string} text - the analysis body.
 * @returns {{ file: string, slug: string, bytes: number }} where it landed.
 */
export function saveAnalysis(store, domain, text) {
  const slug = domainSlug(domain)
  const dir = analysesDir(store)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slug}.md`)
  const body = [
    `# 同领域比较分析：${domain}`,
    '',
    `> 由 \`serendipity_draw({ scope: "near" })\` 的产出保存，最近更新 ${new Date().toISOString()}。`,
    '> 内容由 agent 撰写，插件不做加工。再次对同一领域做 near 分析时会先取回本文件作为基础。',
    '',
    text.trim(),
    '',
  ].join('\n')
  writeFileSync(file, body, 'utf8')
  return { file, slug, bytes: Buffer.byteLength(body, 'utf8') }
}

/**
 * Read a saved analysis.
 * @param {object} store - store instance.
 * @param {string} domain - the domain to look up.
 * @returns {{ file: string, slug: string, text: string } | undefined} the analysis, when one exists.
 */
export function readAnalysis(store, domain) {
  const slug = domainSlug(domain)
  const file = join(analysesDir(store), `${slug}.md`)
  if (!existsSync(file)) return undefined
  try {
    return { file, slug, text: readFileSync(file, 'utf8') }
  } catch {
    return undefined
  }
}

/**
 * List saved analyses, newest first.
 * @param {object} store - store instance.
 * @returns {Array<{ slug: string, file: string, bytes: number, updatedAt: string }>} entries.
 */
export function listAnalyses(store) {
  const dir = analysesDir(store)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const file = join(dir, name)
        const stat = statSync(file)
        return { slug: name.replace(/\.md$/, ''), file, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

/**
 * Find a corpus material by its label.
 *
 * The label path exists because a model that has just written a design document knows
 * what a structure *is called* far more reliably than it knows its 16-hex id. An exact
 * match first, then a case/whitespace-insensitive one; anything else is a new external
 * trace rather than a guess, since a wrong match would attach a landing to material
 * that was never read.
 *
 * @param {Map<string, object>} byId - corpus index.
 * @param {string} label - the label to look for.
 * @returns {object | undefined} the material, when one matches.
 */
function findByLabel(byId, label) {
  const target = label.trim().toLowerCase()
  for (const material of byId.values()) {
    if (String(material?.label ?? '').trim().toLowerCase() === target) return material
  }
  return undefined
}

/**
 * Resolve one raw note into a record key: an id plus the corpus material it names.
 *
 * @param {object} raw - the note as the tool received it.
 * @param {Map<string, object>} byId - corpus index.
 * @returns {{ id: string, label?: string, material?: object } | undefined} the resolution,
 *   or `undefined` when the note names nothing at all (no id and no label).
 */
function resolveNote(raw, byId) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  if (id !== '') return { id, material: byId.get(id) }
  const label = typeof raw?.label === 'string' ? raw.label.trim() : ''
  if (label === '') return undefined
  const matched = findByLabel(byId, label)
  if (matched !== undefined) return { id: matched.id, material: matched }
  return { id: externalId(label), label, material: undefined }
}

/** Plain-language description of where everything is kept (for prompts and stats). */
export function stateLayout() {  const root = stateRoot()
  return {
    root,
    projects: join(root, 'projects'),
    stats: join(root, 'stats.json'),
    materialModel: join(root, 'MATERIAL-MODEL.md'),
    userCorpus: join(root, 'corpus'),
  }
}

/** One atomic JSON write: serialize to a sibling temp file, then rename over. */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

/** Read a JSON file, returning `fallback` (and a problem note) on any failure. */
function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return { value: fallback, problem: undefined }
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')), problem: undefined }
  } catch (error) {
    return { value: fallback, problem: `${file} 解析失败，已按空状态继续：${error.message}` }
  }
}

/**
 * Whole days between two ISO timestamps, or `undefined` if either is unusable.
 *
 * Used for the `daysSinceFirstDraw` age on reconsideration candidates. The landing
 * *lag* is computed in `lib/effectiveness.js` from the same pair of fields.
 */
function daysBetween(from, to) {
  const start = Date.parse(from ?? '')
  const end = Date.parse(to ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, Math.round((end - start) / 86_400_000))
}

/** Empty per-project record. */
function emptyProject(cwd) {
  return {
    version: 1,
    projectKey: projectKey(cwd),
    cwd,
    createdAt: new Date().toISOString(),
    draws: 0,
    entries: {},
    // Per-tool call counters. The only use so far is "has this project ever run a
    // decomposition?", which the draw render checks before suggesting one — a hint
    // that fires on every draw is noise, and a hint that never fires is a capability
    // nobody uses (measured: `serendipity_decompose` was called zero times in a
    // 164-call session whose task was literally the example in its own description).
    tools: {},
    // Per-session activity, keyed by session id and capped (see lib/sessions.js).
    // Written only while the `sessionReport` setting is on.
    sessions: {},
  }
}

/** Empty cross-project tally. */
function emptyStats() {
  return { version: 1, draws: 0, itemsServed: 0, noted: 0, hits: 0, transformations: 0, byCategory: {}, byOrigin: {}, since: new Date().toISOString() }
}

/**
 * Durable state facade. One instance per plugin mount.
 *
 * @example
 * const store = new StateStore()
 * const seen = store.seenIds(cwd)
 * store.recordDraw(cwd, [{ material, purpose }], 'pattern')
 */
export class StateStore {
  /** Problems collected from tolerant reads, surfaced by `serendipity_stats`. */
  problems = []

  /**
   * @param {object} [options] - test/override seam.
   * @param {string} [options.root] - state root, overriding `~/.dsh/dsh-serendipity`.
   */
  constructor(options = {}) {
    this.root = options.root ?? stateRoot()
    this.projectsDir = join(this.root, 'projects')
    this.statsFile = join(this.root, 'stats.json')
  }

  /** Path of one project's record file. */
  projectFile(cwd) {
    return join(this.projectsDir, `${projectKey(cwd)}.json`)
  }

  /** Load one project's record (empty when absent or unreadable). */
  readProject(cwd) {
    const { value, problem } = readJsonSafe(this.projectFile(cwd), emptyProject(cwd))
    if (problem !== undefined) this.problems.push(problem)
    const base = emptyProject(cwd)
    return {
      ...base,
      ...(value !== null && typeof value === 'object' ? value : {}),
      entries: (value !== null && typeof value === 'object' && value.entries !== null && typeof value.entries === 'object') ? value.entries : {},
    }
  }

  /**
   * Ids this project has already drawn — the default exclusion set.
   *
   * External traces (material that came from the web rather than from a draw, see
   * `recordNotes`) are **not** draws and are excluded: counting them here would
   * inflate `seen` against a corpus it has nothing to do with, and `stillUnread`
   * (`corpus size - seen`) would silently under-report.
   *
   * @param {string} cwd - session working directory.
   * @returns {Set<string>} seen material ids.
   */
  seenIds(cwd) {
    const entries = this.readProject(cwd).entries
    return new Set(Object.entries(entries)
      .filter(([, entry]) => entry?.external !== true)
      .map(([id]) => id))
  }

  /**
   * Materials this project read but never recorded a landing for, oldest first.
   *
   * This exists for one specific reason: **an idea that looked useless can become
   * useful later**, once other work moves. A `landed` value is stamped when the
   * agent writes its note, so material that had not landed *yet* is recorded as
   * having landed nowhere — and if nothing ever brings it back to attention, the
   * delayed payoff is never recorded at all, and the one credited signal stays
   * permanently biased toward whatever was visible immediately.
   *
   * Ordering is deliberately by age: the *oldest* unlanded material is the one most
   * likely to have been overtaken by later progress, and the current draw is the
   * natural moment to ask again. Entries with no note at all are excluded — an
   * unread card is not a candidate for reconsideration, it is just not read yet.
   *
   * @param {string} cwd - session working directory.
   * @param {object} options - selection options.
   * @param {number} [options.limit] - how many to return.
   * @param {number} [options.minAgeMs] - ignore notes younger than this, so a material
   *   noted minutes ago is not immediately handed back as "worth another look".
   * @param {Map<string, object>} [options.byId] - corpus index; when given, entries no
   *   longer in the library (removed user contributions) are skipped.
   * @returns {Array<{ id: string, label: string, note: string, category: string, daysSinceFirstDraw?: number }>} candidates, oldest first.
   */
  unlandedNotes(cwd, { limit = 2, minAgeMs = 0, byId } = {}) {
    const project = this.readProject(cwd)
    const cutoff = Date.now() - Math.max(0, minAgeMs)
    return Object.entries(project.entries)
      .filter(([id, entry]) => entry?.notedAt !== undefined
        && entry?.landed === undefined
        // External traces were never drawn, so "read it again" is meaningless for them.
        && entry?.external !== true
        && typeof entry?.note === 'string' && entry.note.trim() !== ''
        && (minAgeMs <= 0 || (Number.isFinite(Date.parse(entry.notedAt)) && Date.parse(entry.notedAt) <= cutoff))
        && (byId === undefined || byId.has(id)))
      .map(([id, entry]) => {
        const candidate = {
          id,
          label: String(entry.label ?? id),
          note: String(entry.note),
          category: String(entry.category ?? ''),
        }
        // Optional: omitted rather than set to `undefined` (lossless-JSON contract).
        // The raw timestamps stay internal — the tool output schema declares only
        // what the render actually uses.
        const age = daysBetween(entry.firstDrawnAt, new Date().toISOString())
        if (age !== undefined) candidate.daysSinceFirstDraw = age
        return candidate
      })
      .sort((a, b) => String(a.firstDrawnAt ?? '').localeCompare(String(b.firstDrawnAt ?? '')))
      .slice(0, Math.max(0, limit))
  }

  /**
   * Note that a tool ran for this project.
   *
   * Deliberately tiny: a counter per tool name, in the project's own record. It exists
   * so a suggestion can be made *once* — the draw render only proposes a decomposition
   * to a project that has never run one — and so "was this capability ever used?" is a
   * question the statistics can answer instead of a guess.
   *
   * @param {string} cwd - session working directory.
   * @param {string} name - tool name, e.g. `decompose`.
   * @returns {number} how many times it has now run for this project.
   */
  recordToolUse(cwd, name) {
    const project = this.readProject(cwd)
    const tools = { ...(project.tools ?? {}) }
    tools[name] = (tools[name] ?? 0) + 1
    project.tools = tools
    writeJsonAtomic(this.projectFile(cwd), project)
    return tools[name]
  }

  /** How many times a tool has run for this project (0 when it never has). */
  toolUses(cwd, name) {
    return this.readProject(cwd).tools?.[name] ?? 0
  }

  /**
   * Record what the plugin did inside one session.
   *
   * Answers the one question a user cannot answer from memory or from a long
   * transcript: *was this session's material actually drawn, and how early?* Kept in
   * the project record (capped, oldest first out) rather than in a file per session,
   * because the interesting comparison is between sessions of the same project.
   *
   * Counters add; `firstDraw` is written once. See `lib/sessions.js` for why.
   *
   * @param {string} cwd - session working directory.
   * @param {string} sessionId - the session's id (`'anonymous'` when unavailable).
   * @param {object} [patch] - `{ at?, position?, increments?, first? }`.
   * @returns {object} the updated session record.
   */
  recordSessionActivity(cwd, sessionId, patch = {}) {
    const project = this.readProject(cwd)
    const at = patch.at ?? Date.now()
    const stored = project.sessions
    const sessions = (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {}
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'anonymous'
    const record = sessions[key] ?? { sessionId: key, ...newSessionRecord({ at, position: patch.position }) }
    mergeActivity(record, { ...patch, at })
    sessions[key] = record
    project.sessions = capSessions(sessions, SESSION_HISTORY_LIMIT)
    writeJsonAtomic(this.projectFile(cwd), project)
    return record
  }

  /**
   * Sessions this project has activity for, newest first.
   * @param {string} cwd - session working directory.
   * @param {{ limit?: number }} [options] - how many to return.
   * @returns {Array<object>} session records.
   */
  sessions(cwd, options) {
    return listSessions(this.readProject(cwd), options)
  }

  /**
   * Remember a (field × structure core) pair handed out by `scope: 'generate'`.
   *
   * A model told to invent material in an unfamiliar field will drift back to the fields
   * it already knows unless something stops it; the pair memory is that stop. Capped so
   * the record cannot grow without bound — the oldest entries fall off.
   *
   * @param {string} cwd - session working directory.
   * @param {{ field: string, core: string }} pair - the pair that was handed out.
   * @param {number} [limit] - how many recent pairs to keep.
   * @returns {number} how many pairs are now remembered.
   */
  recordGenerated(cwd, pair, limit = 24) {
    const project = this.readProject(cwd)
    const history = Array.isArray(project.generated) ? project.generated : []
    history.push({ field: pair.field, core: pair.core, at: new Date().toISOString() })
    project.generated = history.slice(-Math.max(1, limit))
    writeJsonAtomic(this.projectFile(cwd), project)
    return project.generated.length
  }

  /** Recently generated pairs, oldest first. */
  generatedPairs(cwd) {
    const history = this.readProject(cwd).generated
    return Array.isArray(history) ? history : []
  }

  /** Load the cross-project tally. */
  readStats() {
    const { value, problem } = readJsonSafe(this.statsFile, emptyStats())
    if (problem !== undefined) this.problems.push(problem)
    const base = emptyStats()
    return { ...base, ...(value !== null && typeof value === 'object' ? value : {}) }
  }

  /** Load the agent's model of the corpus (may be empty). */
  readMaterialModel() {
    const file = join(this.root, 'MATERIAL-MODEL.md')
    if (!existsSync(file)) return ''
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      this.problems.push(`MATERIAL-MODEL.md 读取失败：${error.message}`)
      return ''
    }
  }

  /**
   * Record one draw: mark every served material seen by this project.
   * @param {string} cwd - session working directory.
   * @param {Array<{ id: string, category: string, origin: string }>} served - the materials handed out.
   * @param {{ purpose?: string, bias?: string }} context - why they were drawn.
   * @returns {{ recorded: number, projectDraws: number, statsDraws: number }} what was written.
   */
  recordDraw(cwd, served, context = {}) {
    const project = this.readProject(cwd)
    const now = new Date().toISOString()
    for (const material of served) {
      const previous = project.entries[material.id]
      project.entries[material.id] = {
        firstDrawnAt: previous?.firstDrawnAt ?? now,
        lastDrawnAt: now,
        timesDrawn: (previous?.timesDrawn ?? 0) + 1,
        category: material.category,
        origin: material.origin,
        label: material.label,
        // Stored so effectiveness can be tallied per structural core later
        // (`lib/effectiveness.js`); without it a record supports only per-category signal.
        structureTags: material.structureTags ?? previous?.structureTags ?? [],
        purpose: context.purpose ?? previous?.purpose,
        bias: context.bias ?? previous?.bias,
        hit: previous?.hit,
        note: previous?.note,
        transformation: previous?.transformation,
        // Re-drawing must not erase what was learned the first time. This is a
        // field-by-field rebuild, so every new recorded field has to be carried
        // over explicitly — omitting these three dropped the `landed` trace (the
        // one signal the statistics rest on) as soon as a material came up again.
        landed: previous?.landed,
        changedFrom: previous?.changedFrom,
        changedTo: previous?.changedTo,
        notedAt: previous?.notedAt,
      }
    }
    project.draws += 1
    writeJsonAtomic(this.projectFile(cwd), project)

    const stats = this.readStats()
    stats.draws += 1
    stats.itemsServed += served.length
    for (const material of served) {
      stats.byCategory[material.category] = (stats.byCategory[material.category] ?? 0) + 1
      stats.byOrigin[material.origin] = (stats.byOrigin[material.origin] ?? 0) + 1
    }
    writeJsonAtomic(this.statsFile, stats)
    return { recorded: served.length, projectDraws: project.draws, statsDraws: stats.draws }
  }

  /**
   * Record one note about a material's use.
   *
   * **A note is accepted even when the id is not in the corpus.** Structures met
   * outside the library (a fetched page, an article, the agent's own reading) are
   * recorded as *external traces*: they carry a `landed` location and count in the
   * reported figures, but they are excluded from read coverage and from
   * `seenIds`, because "how much of the corpus has been read" must not be inflated
   * by material the corpus never held.
   *
   * This is a correction of a real defect, not a convenience. `landed` is the only
   * credited signal, and in a real session the agent tried twice to record seven
   * external landings — six of them the material it rated most valuable — and was
   * told "未识别 id（未写入）" both times. The signal ended up systematically biased
   * toward the frozen corpus, which is exactly the part that goes stale.
   *
   * @param {string} cwd - session working directory.
   * @param {Array<{ id?: string, label?: string, hit: boolean, note?: string, transformation?: boolean, landed?: string, changedFrom?: string, changedTo?: string }>} notes - one per material.
   * @param {Map<string, object>} byId - corpus index, for denormalized fields and existence checks.
   * @returns {{ accepted: number, acceptedExternal: number, unidentified: string[], settled: Array<{ id: string, external: boolean, landed: boolean, landedNew: boolean, hit: boolean, firstNote: boolean, backed: boolean }>, stats: object }} outcome plus the updated tally.
   */
  recordNotes(cwd, notes, byId) {
    const project = this.readProject(cwd)
    const stats = this.readStats()
    const now = new Date().toISOString()
    const unidentified = []
    // `settled` reports per-note outcomes so the caller can render this call's
    // figures without re-deriving them from the arguments — a label-only note that
    // matched a corpus material has no id in the arguments, and guessing there would
    // report a corpus landing as an external one.
    const settled = []
    let accepted = 0
    let acceptedExternal = 0
    for (const raw of notes) {
      // Named `resolved`, not `note`: shadowing the raw patch here silently dropped
      // every field of the note (`note.note`, `note.landed`, `note.hit` all read off
      // the resolution object instead) while the tests' `category` and `notedAt`
      // assertions still passed. The whole point of this function is that the merged
      // record keeps what the caller wrote.
      const resolved = resolveNote(raw, byId)
      if (resolved === undefined) {
        unidentified.push(String(raw?.label ?? raw?.id ?? '（无 id 也无 label）'))
        continue
      }
      const { id, material } = resolved
      const previous = project.entries[id]
      const alreadyNoted = previous?.notedAt !== undefined
      // Note fields MERGE onto the previous record (`?? previous`), so a re-note is
      // a correction, not a replacement: noting again to fix `hit` must not erase
      // where the structure landed. The counters have to be computed from these
      // merged values — adjusting them from the raw patch instead made every
      // partial re-note silently retract the trace it was not even talking about.
      const wasLanded = typeof previous?.landed === 'string' && previous.landed.trim() !== ''
      // An empty string withdraws a previously recorded location; omitted leaves it.
      const landed = (typeof raw.landed === 'string' && raw.landed.trim() === '') ? undefined : (raw.landed ?? previous?.landed)
      const isLanded = typeof landed === 'string' && landed.trim() !== ''
      const hit = raw.hit === true
      const transformation = raw.transformation ?? previous?.transformation ?? false
      // When the trace appeared. Recorded rather than derived: it cannot be recovered
      // from `notedAt`, which is overwritten on every re-note, and the whole point of
      // a delayed landing is that it happens long after the material was first read.
      // `daysBetween` on the pair yields the lag that `effectiveness.js` reports.
      const landedAt = isLanded ? (wasLanded ? (previous?.landedAt ?? previous?.firstDrawnAt ?? now) : now) : undefined
      const external = material === undefined
      project.entries[id] = {
        firstDrawnAt: previous?.firstDrawnAt ?? now,
        lastDrawnAt: previous?.lastDrawnAt ?? now,
        timesDrawn: previous?.timesDrawn ?? 0,
        // An external trace has no category, origin or structure tags — it was never
        // in the corpus. Everything downstream has to treat its presence as "reported,
        // not read"; the `external` flag is the single place that says so.
        ...(external
          ? { external: true, label: resolved.label ?? previous?.label ?? id }
          : {
            category: material.category,
            origin: material.origin,
            label: material.label,
            structureTags: material.structureTags ?? previous?.structureTags ?? [],
          }),
        purpose: previous?.purpose,
        bias: previous?.bias,
        // `hit` / `transformation` are the agent's own judgement — kept for the
        // record and for the reader, never used as a learning signal (see
        // lib/effectiveness.js).
        hit,
        note: raw.note ?? previous?.note,
        transformation,
        // The credited trace: where the structure actually went, plus the before /
        // after pair that backs a claimed transformation.
        landed,
        landedAt,
        changedFrom: raw.changedFrom ?? previous?.changedFrom,
        changedTo: raw.changedTo ?? previous?.changedTo,
        notedAt: now,
      }
      if (external) acceptedExternal += 1
      else accepted += 1
      settled.push({
        id,
        external,
        landed: isLanded,
        // A landing this call **established**, as opposed to one it merely confirms on a
        // re-note. The session metrics count these, so re-noting the same id (the
        // sanctioned way to record a delayed payoff) cannot inflate the receipt.
        landedNew: isLanded && !wasLanded,
        hit: hit === true,
        // Whether this call wrote the entry's *first* note, as opposed to correcting an
        // earlier one. The session metrics count first notes, so a re-note (the
        // sanctioned way to record a delayed landing) is not reported as a second item.
        firstNote: !alreadyNoted,
        backed: transformation === true
          && typeof project.entries[id].changedFrom === 'string' && project.entries[id].changedFrom.trim() !== ''
          && typeof project.entries[id].changedTo === 'string' && project.entries[id].changedTo.trim() !== '',
      })
      // Cross-project counters move only on the first note for an entry, so a
      // re-note corrects the record instead of double-counting it. `selfReported`
      // is named that way on purpose: it is reported, not believed.
      // External traces are counted separately so the corpus figures stay readable
      // as "of what this library served you, how much reached the work".
      const notedKey = external ? 'externalNoted' : 'noted'
      const landedKey = external ? 'externalLanded' : 'landed'
      if (!alreadyNoted) {
        stats[notedKey] = (stats[notedKey] ?? 0) + 1
        if (!external) {
          if (hit) stats.selfReportedHits = (stats.selfReportedHits ?? 0) + 1
          if (transformation === true) stats.transformations += 1
        }
        if (isLanded) stats[landedKey] = (stats[landedKey] ?? 0) + 1
      } else {
        if (wasLanded !== isLanded) stats[landedKey] = Math.max(0, (stats[landedKey] ?? 0) + (isLanded ? 1 : -1))
        if (!external && (previous?.hit === true) !== hit) {
          stats.selfReportedHits = Math.max(0, (stats.selfReportedHits ?? 0) + (hit ? 1 : -1))
        }
        if (!external && (previous?.transformation === true) !== (transformation === true)) {
          stats.transformations += (transformation === true) ? 1 : -1
        }
      }
    }
    stats.transformations = Math.max(0, stats.transformations)
    writeJsonAtomic(this.projectFile(cwd), project)
    writeJsonAtomic(this.statsFile, stats)
    return { accepted, acceptedExternal, unidentified, settled, stats }
  }

  /**
   * Append a dated revision to the agent's corpus model.
   * @param {string} text - the new model text (replaces nothing; appended as a revision).
   * @returns {{ file: string, bytes: number }} where it landed.
   */
  appendMaterialModel(text) {
    const file = join(this.root, 'MATERIAL-MODEL.md')
    mkdirSync(this.root, { recursive: true })
    const header = existsSync(file)
      ? ''
      : '# 素材模型（由 agent 维护）\n\n本文件记录 agent 对素材库的观察与批判：哪些类别的素材真的有用、哪些偏抽象、缺什么主题。\n每次 `serendipity_note({ materialModel })` 调用都会在末尾追加一节，最新在最下。\n'
    if (header !== '') writeFileSync(file, header, 'utf8')
    const stamp = new Date().toISOString()
    appendFileSync(file, `\n## ${stamp}\n\n${text.trim()}\n`, 'utf8')
    return { file, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /**
   * Save one user-contributed material into the user corpus directory.
   * @param {object} material - a validated material record.
   * @returns {{ file: string, count: number }} where it landed and how many the file now holds.
   */
  saveUserMaterial(material) {
    const dir = join(this.root, 'corpus')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${material.category}.json`)
    let payload = { category: material.category, materials: [] }
    if (existsSync(file)) {
      const { value } = readJsonSafe(file, undefined)
      if (value !== null && typeof value === 'object' && Array.isArray(value.materials)) {
        payload = { category: material.category, ...value, materials: value.materials }
      } else {
        this.problems.push(`${file} 结构异常，已被重建（原文件备份为 .bak）`)
        try {
          renameSync(file, `${file}.bak`)
        } catch { /* the rebuild below is still the best available outcome */ }
      }
    }
    const index = payload.materials.findIndex(entry => entry?.id === material.id)
    if (index >= 0) payload.materials[index] = material
    else payload.materials.push(material)
    writeJsonAtomic(file, payload)
    return { file, count: payload.materials.length }
  }

  /** Current problem list (reads performed so far), consumed and cleared by callers that report it. */
  drainProblems() {
    const problems = this.problems
    this.problems = []
    return problems
  }
}

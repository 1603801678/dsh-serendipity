/**
 * Per-session activity metrics — "what did the plugin actually do in this session?"
 *
 * Why this exists: in a real session the user could not tell whether the plugin had
 * been used at all. In that session the model *did* deliberate and then drew six
 * materials at step 23 of 60 (three of them landed in the deliverable), but a single
 * draw among 86 tool calls, inside one long turn that never yields to the user, is
 * invisible unless you scroll to that step. "Did it work?" must be answerable from
 * the record rather than from memory.
 *
 * The metrics are deliberately **descriptive, never a score**:
 *
 * - They count what happened (`draws`, `itemsServed`, `notes`, `landed`, how far into
 *   the session the first draw happened). No rate is optimized and nothing here
 *   feeds back into the draw weights — the same discipline as `lib/effectiveness.js`,
 *   for the same reason: material pays off late, so "used it immediately?" is the
 *   wrong target.
 * - `landed` is reported next to `notes`, never merged, because a note is a claim
 *   and a landing is a checkable place.
 * - Turning the report off (`sessionReport: false`) stops the recording itself, so
 *   a user who does not want the bookkeeping does not pay for it.
 *
 * @module @1603801678/dsh-serendipity/sessions
 */

/** How many sessions one project keeps (oldest fall off; the record cannot grow forever). */
export const SESSION_HISTORY_LIMIT = 20

/** The counter fields a session record accumulates. */
const COUNTERS = ['draws', 'itemsServed', 'notes', 'noted', 'landed', 'externalLanded', 'reminders', 'decompose']

/**
 * Where the current tool call sits in the session.
 *
 * Read from the session's own event log rather than from a counter the plugin
 * maintains: the log is the durable source of truth, and a plugin-side counter would
 * be wrong for the first call after a resume.
 *
 * `elapsedMs` is measured from **the current turn's** `turn/start`, not from
 * `header.createdAt`. Measured the other way it lied twice over: a session opened (or
 * resumed) minutes or days before the prompt counted that idle time as "time into the
 * session", which is exactly the number a reader uses to judge how early the plugin was
 * used. `turn` and `step` come from the same scan, so all three agree.
 *
 * Entirely tolerant: a session without an events array (a unit test, a headless
 * harness) yields `undefined` and the caller simply records no position.
 *
 * @param {object} exec - the tool run context.
 * @param {number} [now] - injectable clock, for tests.
 * @returns {{ turn: number, step: number, at: number, turnStartedAt?: string, elapsedMs?: number } | undefined} the position.
 */
export function sessionPosition(exec, now = Date.now()) {
  const session = exec?.agent?.session
  const events = session?.events
  if (!Array.isArray(events)) return undefined
  let turn = 0
  let step = 0
  let turnStart
  for (const event of events) {
    if (event?.type === 'turn/start') {
      turn += 1
      if (typeof event.time === 'number') turnStart = event.time
    } else if (event?.type === 'step/start') {
      step += 1
    }
  }
  const position = { turn, step, at: now }
  if (turnStart !== undefined) {
    position.turnStartedAt = new Date(turnStart).toISOString()
    position.elapsedMs = Math.max(0, now - turnStart)
  }
  return position
}

/**
 * A fresh session record.
 *
 * No `startedAt`: the session's own creation time is not what a reader wants (a session
 * opened at breakfast and prompted at lunch would report a two-hour "start"), so the
 * record keeps `firstAt`/`lastAt` — when the plugin first and last did something — and
 * the position of the first draw, which is the number the report is actually about.
 *
 * @param {{ at: number, position?: object }} input - the clock and, when known, where the session stands.
 * @returns {object} the record, counters at zero.
 */
export function newSessionRecord({ at, position }) {
  const now = new Date(at).toISOString()
  const record = {
    firstAt: now,
    lastAt: now,
    draws: 0,
    itemsServed: 0,
    notes: 0,
    noted: 0,
    landed: 0,
    externalLanded: 0,
    reminders: 0,
    decompose: 0,
  }
  applyPosition(record, position)
  return record
}

/**
 * Stamp the last known position onto a record (turn/step only when the session has a log).
 * @param {object} record - the session record, mutated.
 * @param {object} [position] - the position from {@link sessionPosition}.
 * @returns {void}
 */
export function applyPosition(record, position) {
  if (position === undefined) return
  record.turn = position.turn
  record.step = position.step
  if (position.elapsedMs !== undefined) record.elapsedMs = position.elapsedMs
}

/**
 * Merge one activity patch into a session record.
 *
 * Counters **add** (a session draws more than once), while `firstDraw` is written
 * **once** — the whole question the metric answers is "how early did the plugin get
 * used", and a later draw must not overwrite the first one's position.
 *
 * @param {object} record - the stored record, mutated in place.
 * @param {object} patch - `{ at, position?, increments?: object, first: boolean }`.
 * @returns {object} the same record.
 */
export function mergeActivity(record, patch) {
  const at = patch.at ?? Date.now()
  record.lastAt = new Date(at).toISOString()
  for (const [key, amount] of Object.entries(patch.increments ?? {})) {
    if (!COUNTERS.includes(key)) continue
    record[key] = (record[key] ?? 0) + amount
  }
  applyPosition(record, patch.position)
  if (patch.first === true && record.firstDraw === undefined && patch.position !== undefined) {
    record.firstDraw = {
      turn: patch.position.turn,
      step: patch.position.step,
      at: record.lastAt,
    }
    if (patch.position.elapsedMs !== undefined) record.firstDraw.elapsedMs = patch.position.elapsedMs
  }
  return record
}

/**
 * Sessions of one project, newest activity first.
 *
 * @param {object} project - a project record from the store.
 * @param {{ limit?: number }} [options] - how many to return.
 * @returns {Array<object>} the session records.
 */
export function recentSessions(project, { limit = SESSION_HISTORY_LIMIT } = {}) {
  const sessions = project?.sessions
  if (sessions === null || typeof sessions !== 'object') return []
  return Object.values(sessions)
    .filter(entry => entry !== null && typeof entry === 'object')
    .sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
    .slice(0, Math.max(0, limit))
}

/**
 * Drop the oldest sessions so a long-lived project cannot grow its record without bound.
 * @param {object} sessions - the `sessions` map, mutated.
 * @param {number} [limit] - how many to keep.
 * @returns {object} the same map.
 */
export function capSessions(sessions, limit = SESSION_HISTORY_LIMIT) {
  const keys = Object.keys(sessions)
  if (keys.length <= limit) return sessions
  const keep = new Set(Object.values(sessions)
    .sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
    .slice(0, limit)
    .map(entry => entry?.sessionId))
  for (const key of keys) if (!keep.has(key)) delete sessions[key]
  return sessions
}

/**
 * One plain-language line answering "did the plugin get used this session?".
 *
 * Written for the model to paste back and for a human reading the stats: it states the
 * measurement and never grades it.
 *
 * @param {object} session - a session record.
 * @returns {string} the summary line.
 */
export function describeSession(session) {
  const parts = []
  const first = session.firstDraw
  if (first === undefined) {
    parts.push((session.draws ?? 0) > 0
      ? `抽了 ${session.draws} 次，但会话没有事件日志，记不下第几步`
      : '没有抽过素材')
  } else {
    const minutes = first.elapsedMs === undefined ? undefined : (first.elapsedMs / 60_000).toFixed(1)
    parts.push(`首次抽取在第 ${first.turn} 轮第 ${first.step} 步`
      + (minutes === undefined ? '' : `（该轮开场后 ${minutes} 分钟）`))
    parts.push(`共抽 ${session.draws ?? 0} 次／发出 ${session.itemsServed ?? 0} 条`)
  }
  parts.push(`记录 ${session.notes ?? 0} 次（条目 ${session.noted ?? 0}，其中落点 ${session.landed ?? 0}`
    + (session.externalLanded > 0 ? `，外部落点 ${session.externalLanded}` : '') + '）')
  if ((session.reminders ?? 0) > 0) parts.push(`漏记提醒触发 ${session.reminders} 次`)
  return parts.join('；')
}

/**
 * Horizon: is this project a one-off session or an ongoing campaign?
 *
 * A design session that ends today and a research problem that grinds on for
 * weeks want different behaviour from a serendipity engine. A short task wants
 * material *now* and no ceremony. A long one wants the plugin to remember what
 * this project already recorded, to push the agent to write findings back, and to
 * keep a model of the corpus it can hand to the next round.
 *
 * The tempting design — a `horizon: "short" | "long"` tool parameter — is the
 * wrong one: a parameter that costs the model nothing to set will be set
 * arbitrarily, and arbitrary metadata is noise. The plugin already has real
 * evidence, so it classifies instead of asking:
 *
 * - how many outcomes this project has actually recorded (a campaign accumulates
 *   them; a session has a handful),
 * - how many separate draws it has made,
 * - how long it has been going.
 *
 * The classification is *observable* to the agent (it is printed in the draw
 * header), so a wrong guess is visible and self-correcting rather than silent.
 *
 * @module @1603801678/dsh-serendipity/horizon
 */

/** Recorded outcomes needed before a project can count as a campaign. */
export const CAMPAIGN_MIN_NOTED = 12

/** Distinct draws needed before a project can count as a campaign. */
export const CAMPAIGN_MIN_DRAWS = 6

/** Elapsed time (ms) that alone can promote a project to a campaign. */
export const CAMPAIGN_MIN_AGE_MS = 12 * 60 * 60 * 1000

/** How many recent results to quote back as the durable model of a campaign. */
export const MODEL_QUOTE_LIMIT = 6

/**
 * Classify one project.
 *
 * @param {{ draws?: number, createdAt?: string, entries?: object }} project - the project record.
 * @returns {{ kind: 'session' | 'campaign', reason: string, noted: number, hits: number, draws: number, ageHours: number }} the verdict plus its evidence.
 */
export function classifyHorizon(project) {
  const entries = Object.values(project?.entries ?? {})
  const noted = entries.filter(entry => entry?.notedAt !== undefined)
  const hits = noted.filter(entry => entry?.hit === true)
  const draws = Number(project?.draws ?? 0)
  const created = Date.parse(project?.createdAt ?? '')
  const ageMs = Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0
  const ageHours = ageMs / 3_600_000

  // Any one strong signal promotes; a campaign is "this is clearly not a one-off".
  const campaign = noted.length >= CAMPAIGN_MIN_NOTED
    || draws >= CAMPAIGN_MIN_DRAWS && noted.length >= Math.ceil(CAMPAIGN_MIN_NOTED / 2)
    || ageMs >= CAMPAIGN_MIN_AGE_MS && noted.length >= Math.ceil(CAMPAIGN_MIN_NOTED / 3)

  if (campaign) {
    const reason = noted.length >= CAMPAIGN_MIN_NOTED
      ? `已记录 ${noted.length} 条结果`
      : draws >= CAMPAIGN_MIN_DRAWS
        ? `${draws} 轮抽取、已记录 ${noted.length} 条`
        : `持续 ${ageHours.toFixed(1)} 小时、已记录 ${noted.length} 条`
    return { kind: 'campaign', reason, noted: noted.length, hits: hits.length, draws, ageHours }
  }
  return {
    kind: 'session',
    reason: `已记录 ${noted.length} 条结果、${draws} 轮抽取（不足以判定为长期任务）`,
    noted: noted.length,
    hits: hits.length,
    draws,
    ageHours,
  }
}

/**
 * The durable model to hand back on a campaign draw: what this project already
 * recorded, most substantial first.
 *
 * A long task forgets; this is the memory. Only notes the agent itself wrote are
 * quoted — inventing a summary would put words in its mouth.
 *
 * It does **not** filter on the self-reported `hit`. The old version did ("only
 * hits, because the point is a reminder of what worked"), which meant a campaign's
 * memory consisted of the agent's own flattering verdicts, and that material
 * recorded as useless was dropped from the very history that might later show it
 * mattered. Ordering, not exclusion, is what makes the list useful:
 *
 * 1. entries with a `landed` trace — the only ones a reader can check;
 * 2. entries the agent flagged as a hit or a transformation of the problem;
 * 3. everything else it bothered to write a note about.
 *
 * @param {{ entries?: object }} project - the project record.
 * @param {number} [limit] - how many notes to quote.
 * @returns {Array<{ id: string, label: string, note: string, category: string, landed?: string }>} ranked, then most recent first.
 */
export function recallNotes(project, limit = MODEL_QUOTE_LIMIT) {
  const rank = (entry) => {
    if (typeof entry?.landed === 'string' && entry.landed.trim() !== '') return 0
    if (entry?.hit === true || entry?.transformation === true) return 1
    return 2
  }
  return Object.entries(project?.entries ?? {})
    .filter(([, entry]) => entry?.notedAt !== undefined && typeof entry.note === 'string' && entry.note !== '')
    .sort(([, a], [, b]) => rank(a) - rank(b) || String(b.notedAt).localeCompare(String(a.notedAt)))
    .slice(0, limit)
    .map(([id, entry]) => {
      const quoted = {
        // The id travels with the quote: a recalled entry is something the agent may
        // want to re-note (e.g. its structure landed after all), which it cannot do
        // without naming it. Draw also uses it to avoid quoting the same material in
        // both `recall` and `reconsider`.
        id,
        label: String(entry.label ?? id),
        note: String(entry.note),
        category: String(entry.category ?? ''),
      }
      // Optional: omitted rather than set to `undefined` (lossless-JSON contract).
      if (typeof entry.landed === 'string' && entry.landed.trim() !== '') quoted.landed = entry.landed
      return quoted
    })
}

/** @deprecated Renamed to {@link recallNotes}: the list is no longer hits-only. */
export const recallHits = recallNotes

/**
 * The behavioural difference between the two horizons.
 *
 * Expressed as instructions the model reads at draw time, not as a parameter it
 * fills in: the plugin decides *what kind of work this is* and states it.
 *
 * @param {ReturnType<typeof classifyHorizon>} horizon - the classification.
 * @returns {{ header: string, guidance: string[] }} one-line header plus extra instructions.
 */
export function horizonGuidance(horizon) {
  if (horizon.kind === 'campaign') {
    return {
      header: `【长期任务】${horizon.reason}——本次按「累积」处理`,
      guidance: [
        '这是长期任务：素材读完后请把**真正有用的那条结构**用 serendipity_learn 沉淀回库里，'
        + '它下次会被别人（或你的下一轮）当作素材抽到。',
        '如果这一批的映射让你改变了问题的定义，在 serendipity_note 里同时给出 `changedFrom` 与 `changedTo`'
        + '（改变前/后的问题定义各一句）；只写「改变了」不计入统计。',
        '**不要把「当下用不上」当成失败**：长期任务里素材的价值常常延迟兑现，插件的权重只看读取覆盖度、'
        + '不看命中率——如实记录用不上，不会让未来的素材变差。',
        '建议把结论写进 serendipity_note 的 materialModel 参数，它会在后续轮次里回灌给你。',
      ],
    }
  }
  return {
    header: `【单次任务】${horizon.reason}——本次一次给足，不要求沉淀`,
    guidance: [
      '这是短任务：读完、映射、记录完就继续手上的事，不必刻意沉淀素材或维护素材库模型。',
    ],
  }
}

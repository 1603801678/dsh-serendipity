/**
 * The `/api/dsh-serendipity` route family.
 *
 * A read-mostly HTTP surface for inspecting the corpus and the loop's
 * effectiveness outside a chat turn (`curl`, a future GUI panel, the user's own
 * scripts). It deliberately does **not** expose `learn`: writing to the corpus
 * is an agent/tool action, and a web endpoint that mutates a user's material
 * library is not worth the surface.
 *
 * The routes carry the same loopback fence the other dsh plugins use, so a
 * LAN-exposed deployment does not serve them.
 *
 * @module @1603801678/dsh-serendipity/routes
 */

import { CATEGORY_NAMES, tagVocabulary } from './corpus.js'
import { fieldCount } from './fields.mjs'
import { stateLayout } from './store.js'

/** Base pathname of the route family. */
export const API_BASE = '/api/dsh-serendipity'

/** Cap on the corpus page size. */
const MAX_PAGE = 200

/**
 * Loopback + same-origin browser fence (mirrors the dsh-ssh pairing fence).
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} whether the request may be served.
 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Cap on JSON request bodies (a config patch is a handful of scalars). */
const MAX_JSON_BODY_BYTES = 16 * 1024

/** Write one JSON response. */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {Promise<object | undefined>} the parsed object, or undefined when too large / unparseable.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Compact projection of a material for HTTP consumers. */
function publicMaterial(material) {
  return {
    id: material.id,
    category: material.category,
    categoryName: CATEGORY_NAMES[material.category] ?? material.category,
    label: material.label,
    origin: material.origin,
    structure: material.structure,
    summary: material.summary,
    detail: material.detail,
    bridge: material.bridge,
    structureTags: material.structureTags,
    tags: material.tags,
    source: material.source,
  }
}

/**
 * Build the route list.
 * @param {object} deps - live engine, store, and the settings bridge.
 * @param {object} deps.engine - draw engine (corpus + selection).
 * @param {object} deps.store - state store.
 * @param {() => object} [deps.configStatus] - config diagnostics.
 * @param {() => object} [deps.readConfig] - effective configuration.
 * @param {(patch: object) => Promise<object>} [deps.writeConfig] - merges a patch and returns the outcome.
 * @returns {Array<{ kind: string, path: string, handler: Function }>} registrations for `webServer.register`.
 */
export function makeRoutes({ engine, store, configStatus, readConfig, writeConfig }) {
  const summary = async (_request, response) => {
    // The HTTP surface has no session, so it reports the host process's
    // directory. Per-project history is keyed identically by the tools, which do
    // have a session, so a query from the same directory lines up.
    const cwd = process.cwd()
    const project = store.readProject(cwd)
    const stats = store.readStats()
    const composition = engine.composition()
    const seen = store.seenIds(cwd)
    writeJson(response, 200, {
      library: {
        total: composition.total,
        builtin: composition.builtin,
        user: composition.user,
        // The generation gazetteer: how many directions are still available.
        fields: fieldCount(),
        byCategory: engine.categorySummary(),
        problems: store.drainProblems(),
      },
      usage: {
        // `seen` counts corpus materials only (external traces are not reads), so the
        // intersection is redundant today — kept explicit so a future change to
        // `seenIds` cannot silently make this number wrong.
        projectRead: [...seen].filter(id => engine.byId.has(id)).length,
        remaining: Math.max(0, composition.total - [...seen].filter(id => engine.byId.has(id)).length),
        projectDraws: project.draws,
        draws: stats.draws,
        itemsServed: stats.itemsServed,
        noted: stats.noted,
        // `landed` names a place and is checkable; `hits` is the agent's own
        // judgement, reported for the reader and used by no weight (see
        // lib/effectiveness.js). They are never merged into one number.
        landed: stats.landed ?? 0,
        hits: stats.selfReportedHits ?? 0,
        transformations: stats.transformations,
        landedRate: stats.itemsServed === 0 ? null : (stats.landed ?? 0) / stats.itemsServed,
        hitRate: stats.noted === 0 ? null : (stats.selfReportedHits ?? 0) / stats.noted,
        transformationRate: stats.noted === 0 ? null : stats.transformations / stats.noted,
        // Structures met outside the corpus. They carry landings but are not coverage,
        // so the panel must not fold them into the rates above.
        externalNoted: stats.externalNoted ?? 0,
        externalLanded: stats.externalLanded ?? 0,
        generatedPairs: store.generatedPairs(cwd).length,
      },
      locations: stateLayout(),
    })
  }

  const corpus = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const category = url.searchParams.get('category')
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)

    let materials = engine.materials
    if (category !== null && category !== '') materials = materials.filter(material => material.category === category)
    if (query !== '') {
      materials = materials.filter(material => [
        material.label, material.origin, material.structure, material.summary, material.detail, material.bridge,
        ...material.tags, ...material.structureTags,
      ].join(' ').toLowerCase().includes(query))
    }
    const page = materials.slice(offset, offset + limit)
    writeJson(response, 200, {
      total: materials.length,
      offset,
      limit,
      categories: engine.categorySummary(),
      materials: page.map(publicMaterial),
    })
  }

  const vocabulary = async (_request, response) => {
    const tally = tagVocabulary(engine.materials)
    writeJson(response, 200, {
      categories: engine.categorySummary(),
      structureTags: tally.structureTags,
      tags: tally.tags,
      origins: [...new Set(engine.materials.map(material => material.origin))].sort(),
    })
  }

  const model = async (_request, response) => {
    writeJson(response, 200, { path: stateLayout().materialModel, text: store.readMaterialModel() })
  }

  /**
   * Per-session activity for one project — the honest answer to "did the plugin get
   * used, and how early?".
   *
   * `?cwd=` exists because the HTTP surface has no session: without it this route would
   * only ever report the host process's own directory (the same limitation `/summary`
   * documents), which is never the directory the user is actually working in.
   */
  const sessions = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const override = (url.searchParams.get('cwd') ?? '').trim()
    const cwd = override === '' ? process.cwd() : override
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
    const enabled = (readConfig?.() ?? {}).sessionReport !== false
    writeJson(response, 200, {
      ok: true,
      // `enabled` distinguishes "no activity yet" from "the bookkeeping is switched
      // off" — the two read identically in an empty list, and confusing them is how a
      // disabled feature looks broken.
      enabled,
      cwd,
      projectFile: store.projectFile(cwd),
      sessions: enabled ? store.sessions(cwd, { limit }) : [],
      ...(enabled ? {} : { note: '会话报告已在设置里关闭（sessionReport: false）；关掉后不再记录新会话。' }),
    })
  }

  /**
   * Config read/write for the browser settings card.
   *
   * `GET` reports the effective configuration and whether the settings section
   * registered; `POST` merges a patch. Writes go through the **settings service**,
   * not straight to a file, so the running plugin re-reads the new value through
   * the same path a GUI or hand-edited document would use — one config path, not
   * three.
   */
  const settings = async (request, response) => {
    const status = configStatus === undefined ? { stage: 'not-wired' } : configStatus()
    if (request.method === 'GET' || request.method === 'HEAD') {
      writeJson(response, 200, {
        ok: true,
        ...status,
        config: readConfig === undefined ? undefined : readConfig(),
        writable: writeConfig !== undefined,
      })
      return
    }
    if (writeConfig === undefined) {
      writeJson(response, 501, {
        ok: false,
        error: '本部署没有可写的设置服务：改 profile 的 cordis.patch.yml 里 serendipity 条目的 config，或跑 node tools/set-config.mjs。',
      })
      return
    }
    const patch = await readJsonBody(request)
    if (patch === undefined) {
      writeJson(response, 400, { ok: false, error: '请求体不是合法 JSON 对象' })
      return
    }
    try {
      const outcome = await writeConfig(patch)
      writeJson(response, outcome.ok ? 200 : 400, outcome)
    } catch (error) {
      writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const wrap = (handler, methods) => async (request, response) => {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { error: 'dsh-serendipity routes are loopback-only' })
      return
    }
    if (!methods.includes(request.method ?? 'GET')) {
      writeJson(response, 405, { error: `method not allowed: ${request.method}` })
      return
    }
    try {
      await handler(request, response)
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return [
    { kind: 'exact', path: `${API_BASE}/summary`, handler: wrap(summary, ['GET', 'HEAD']) },
    { kind: 'exact', path: `${API_BASE}/corpus`, handler: wrap(corpus, ['GET', 'HEAD']) },
    { kind: 'exact', path: `${API_BASE}/vocabulary`, handler: wrap(vocabulary, ['GET', 'HEAD']) },
    { kind: 'exact', path: `${API_BASE}/model`, handler: wrap(model, ['GET', 'HEAD']) },
    { kind: 'exact', path: `${API_BASE}/sessions`, handler: wrap(sessions, ['GET', 'HEAD']) },
    { kind: 'exact', path: `${API_BASE}/settings`, handler: wrap(settings, ['GET', 'HEAD', 'POST']) },
  ]
}

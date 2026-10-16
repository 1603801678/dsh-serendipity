/**
 * dsh-serendipity (缪斯) — host half.
 *
 * Makes creativity a mechanical rather than aspirational property of a
 * session. The plugin ships a corpus of far-field *structural* material
 * (mechanisms, techniques, counterintuitive findings, everyday tricks, formal
 * structures, artistic patterns) and gives the agent six tools around it:
 *
 * - `serendipity_draw` — pull N random materials, maximally spread across source
 *   fields and structural types, avoiding what this project already read;
 * - `serendipity_note` — record what happened when they were mapped onto the
 *   work, and where the structure actually **landed** (a named place, which is the
 *   only signal the weighting credits; a self-reported "useful" is recorded but not
 *   counted, because research pays off later than any flag stamped today);
 * - `serendipity_learn` — contribute a newly discovered structure back to the
 *   corpus, so the library grows out of real work;
 * - `serendipity_stats` — library size, read coverage, landed vs self-reported
 *   counts (never merged), tag vocabulary.
 *
 * Everything rides official NPM SDK packages: no dsh source changes. The
 * optional `/api/dsh-serendipity` routes expose the corpus read-only over HTTP
 * for `curl` and future GUI panels.
 *
 * @module @1603801678/dsh-serendipity
 */

import { createRequire } from 'node:module'
import { loadCorpus } from './corpus.js'
import { DrawEngine } from './draw.js'
import { makeRoutes } from './routes.js'
import { StateStore, userCorpusDir } from './store.js'
import { createTools } from './tools.js'

/** Stable cordis plugin name. */
export const name = 'serendipity'

/**
 * Services required before the tools can mount. `webServer` is deliberately NOT
 * here: the routes are mounted through a nested fiber so a headless deployment
 * gets the tools without the HTTP surface.
 */
export const inject = ['tools', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/** Default config values (the loader applies these when declared in a manifest). */
const DEFAULTS = {
  enabled: true,
  announceToAgent: true,
  serveRoutes: true,
  drawMode: 'autonomous',
  sessionReport: true,
}

/** The three ways the plugin can relate to the agent, from silent to self-directed. */
export const DRAW_MODES = ['off', 'onRequest', 'autonomous']

/** Every config key the browser card may write. */
const CONFIG_KEYS = ['drawMode', 'enabled', 'announceToAgent', 'serveRoutes', 'sessionReport']

/** The package name, used to find this plugin's own profile entry. */
const PACKAGE_NAME = '@1603801678/dsh-serendipity'

/**
 * Diagnostics for the settings wiring, exposed through the read-only route.
 *
 * `stage` exists because the first version of this failed silently: the settings
 * library was imported by name, the import failed, the error was caught, and the
 * result was a plugin with no settings anywhere and a green test suite. Nothing in
 * the process could tell you that. A stage string can — and it paid for itself again
 * when dsh 0.2.0 removed `settings.register()` out from under this plugin.
 *
 * @type {{ stage: string, error?: string }}
 */
const settingsStatus = {
  stage: 'not-attempted',
}

/**
 * Resolve `schemastery` (the SDK's schema library) so the config can be described
 * to the settings UI — a schema is what turns `drawMode` into a real control in
 * the Web settings page instead of a YAML key.
 *
 * Tried through several routes because it may be CJS or ESM and may or may not be
 * reachable from this plugin's location. Returning undefined is fine: the plugin
 * still mounts, it just has no settings form and keeps reading its config from the
 * composition entry.
 *
 * @returns {object | undefined} the schemastery factory, when available.
 */
function loadSchemastery() {
  const candidates = []
  try {
    candidates.push(createRequire(import.meta.url)('@deepseek-ai/schemastery'))
  } catch { /* fall through */ }
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    const factory = candidate.default ?? candidate
    if (typeof factory === 'function' && typeof factory.object === 'function') return factory
  }
  return undefined
}

/**
 * Declare the config the way dsh 0.2.0 expects it: a `Config` export whose editable
 * fields are `.volatile()`.
 *
 * 0.2.0 removed the runtime seam this plugin used to plug into
 * (`settings.register(namespace, schema, …)`) — measured live after the upgrade as
 * `child.settings.register is not a function`. The replacement is declarative: the
 * loader validates the raw config against this schema **before** `apply` runs and
 * hands the resolved value to `apply(ctx, config)`; a `.volatile()` field arrives as
 * a **live reference** (`{ get() }`, rewritten in place on a committed change, with
 * no plugin restart), and volatile is also what makes a field editable in the Web
 * settings page and writable through the settings service.
 *
 * Returns `undefined` when schemastery is unreachable — a supported deployment.
 * cordis then skips validation entirely (`resolveConfig` returns the raw config) and
 * `apply` still runs off the composition entry, because a missing peer package must
 * never take the plugin (and with it the profile) down.
 *
 * @returns {object | undefined} the schema, or undefined when schemastery is missing.
 */
function declareConfig() {
  const z = loadSchemastery()
  if (z === undefined) return undefined
  try {
    return z.object({
      drawMode: z.string().default(DEFAULTS.drawMode)
        .description('抽取模式。填 autonomous（自主，默认）／onRequest（按需，工具可用但不在提示词里声明）／off（关闭）。')
        .volatile(),
      enabled: z.boolean().default(DEFAULTS.enabled)
        .description('总开关；关掉等价于 drawMode = off。')
        .volatile(),
      announceToAgent: z.boolean().default(DEFAULTS.announceToAgent)
        .description('是否在系统提示词里声明本插件（仅在 drawMode = autonomous 时生效）。')
        .volatile(),
      serveRoutes: z.boolean().default(DEFAULTS.serveRoutes)
        .description('是否挂载 /api/dsh-serendipity 只读接口。')
        .volatile(),
      sessionReport: z.boolean().default(DEFAULTS.sessionReport)
        .description('会话报告：记录每次会话的抽取指标（第几步首次抽、抽了几条、多少条写明落点），'
          + '并在 serendipity_stats 与只读路由里报告。关掉后完全不记录。')
        .volatile(),
    })
  } catch {
    return undefined
  }
}

/** The declared config — the export the loader reads (see {@link declareConfig}). */
export const Config = declareConfig()

settingsStatus.stage = Config === undefined ? 'schema-unavailable' : 'declared'

/**
 * Read one config field.
 *
 * A field the harness resolved from a `.volatile()` schema is a live reference
 * (`{ get() }`); a plain object is what `apply` receives from a unit test, from an
 * older harness, or from a deployment without schemastery. Both shapes must work, so
 * every read goes through here.
 *
 * @param {object | undefined} config - the resolved plugin config.
 * @param {string} key - field name.
 * @returns {unknown} the current value, or undefined when the field is absent.
 */
function configField(config, key) {
  const raw = config?.[key]
  return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
}

/**
 * The profile entry id this plugin runs as.
 *
 * 0.2.0's settings service keys editable config by **profile entry**, not by a
 * namespace a plugin invents, so a write has to name the entry the loader started
 * us as (the bundle patch inserts `id: serendipity`). Our own fiber's entry is the
 * primary source; the config editor's inventory is the fallback for a deployment
 * whose fiber carries no entry (a bare `apply()` in a test).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {string | undefined} the entry id, when it can be determined.
 */
function resolveEntryId(ctx) {
  const direct = ctx.fiber?.entry?.options?.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  try {
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
    return editor?.entries?.().find(row => row?.options?.name === PACKAGE_NAME)?.options?.id
  } catch {
    return undefined
  }
}

/**
 * Normalize the configured draw mode.
 *
 * `autonomous` (default) = tools registered and announced, so the agent decides
 * when a task would benefit from far-field material.
 * `onRequest` = tools registered but never announced: they exist for a user who
 * asks for material, and the model will not volunteer them.
 * `off` = the plugin mounts nothing at all.
 *
 * Backward compatibility: older configs only had `enabled` / `announceToAgent`,
 * so `announceToAgent: false` maps to `onRequest` (tools still usable, not
 * advertised) — the same behaviour those configs produced before.
 *
 * An unknown value degrades to the default rather than throwing: a config typo
 * must not take the plugin (and the profile that loads it) down.
 *
 * @param {object} [config] - raw plugin config.
 * @returns {'off' | 'onRequest' | 'autonomous'} the effective mode.
 */
function resolveDrawMode(config) {
  const raw = config?.drawMode
  if (typeof raw === 'string' && DRAW_MODES.includes(raw)) return raw
  if (config?.enabled === false) return 'off'
  if (config?.announceToAgent === false) return 'onRequest'
  return DEFAULTS.drawMode
}

/**
 * Model-facing announcement: what the plugin is for, when to reach for it, and
 * what the loop expects. Kept deliberately short — the tool descriptions carry
 * the operational detail, and this section exists so the agent *notices* the
 * capability at the moment it is designing rather than executing.
 */
export const SERENDIPITY_GUIDANCE = [
  '本机已安装 dsh-serendipity（缪斯）插件：一个跨领域「结构素材库」，用来做远距离类比式的创造性工作。',
  '工具：serendipity_draw（抽 N 条随机素材；`scope: "near"` 时改为返回「同领域比较分析」任务，`scope: "generate"` 时改为返回一组「随机领域 × 随机结构核心」的生成任务）、serendipity_note（记录素材的落点——结构写进了哪里；外部来源的素材也能记，给个 id 或 label 就行；自评「有用」只作记录、不计入统计）、serendipity_learn（把工作中学到的新结构沉淀回素材库）、serendipity_stats（库规模、读取覆盖度与落点情况、可用标签词表）、serendipity_decompose（把作品拆成部件，逐一追问「哪些是假设、哪些是必然」）、serendipity_fetch（联网抓取正文，用于把最新资料提炼成素材）。',
  '什么时候抽：**用户给的是「开放式目标」时，先抽一次再动手**——即那些没指明方法的问题（「看看这个项目哪里能改进」「帮我设计一个 X」「换个思路」「有没有更好的做法」）。不要先把一长串调查做完再抽，也不要等「有空」时才抽。',
  '其余时机：正在设计或做方案取舍时；卡住、反复绕圈时；需要一个跳出现有思路的视角时；任务更看重新颖而不是正确时；想质疑某个被当成前提的约束时。抽取很便宜，不需要理由，也不需要保证用得上。',
  '怎么用：读完素材后，逐条强行把它映射到当前问题上（素材的 bridge 字段就是给这一步的问句）。命中就展开；不命中就说明为什么对不上——素材本来就是低概率有用的东西，0 命中是正常结果，不是失败。',
  '做设计类任务时，先拆解再抽素材往往更有效：用 serendipity_decompose 把作品拆成部件、把「现状」改写成「假设」，再对每个假设用 serendipity_draw(bias=该部件的结构标签) 找替代方案。',
  '需要「同领域基准」时用 serendipity_draw({ scope: "near" })：它不抽素材，而是给你一份比较分析任务（找同领域已有作品 → 抽骨架 → 找共同假设 → 列出空白）。同领域素材的作用是给新颖性提供判定基准，与跨域迁移是两种不同的活。',
  '池子读得差不多、或者用户想要「随机一点、新一点的素材」时用 serendipity_draw({ scope: "generate" })：它不抽现成素材，而是随机指定一个**具体领域**（如消防工程、冰川物质平衡、戏曲锣鼓点）与一个**结构核心**，让你去那个领域找一件真事、写出机理、提炼成素材再入库。方向由插件随机决定，不由搜索引擎决定——这是「随机」和「最新」都能真正成立的做法。',
  '想要「同一个形状在两个不相干的领域里各出现一次」时用 serendipity_draw({ collide: true })：**按组**发素材（每组 2 条，共享同一结构核心、来源尽量远），要求你回答三者的关系——那条结构在你的问题里对应什么、以及 A 有而 B 没有的部分是否就是它成立的条件。`bias` 写结构标签会**钉住**形状（如 bias: "阈值"）。平时别用它：普通抽取追求覆盖面，collide 追求一个形状的两个实例。',
  '需要最新资料时用 serendipity_fetch（可达来源与查询语法都写在它的说明里）。两条硬规则：**不要抓首页**——首页返回导航，工具会标 `indexPage`，要抓具体文章页或 API；抓到正文后必须**提炼成结构**再用 serendipity_learn 入库，提炼不出结构就不要入库。但**落点不必等入库**：外部来源的结构可以直接用 serendipity_note 记（自起 id 或给 label 即可），否则这批最值钱的落点会丢。',
  '硬性要求：每次 serendipity_draw 之后必须调用 serendipity_note（包括全部 miss）。不记录的话这些素材不会被标记为已读（下次还会抽到），插件也拿不到覆盖度样本。对真的进入了工作的那几条，写明 `landed`——结构去了哪个文件/哪一节、或改写了哪个决定；自评「有用」会记录但不算数，因为素材的价值常常延迟兑现，今天看不出来不是失败。',
  '用户提到「抽素材 / 灵感 / 缪斯 / 跨领域类比 / 换个思路 / 跳出框架 / 卡住了」时，即指本插件，请据此协作。',
].join('\n')

/**
 * Mount the corpus, tools, prompt section, and optional routes.
 *
 * The surfaces are re-registered whenever the configuration changes, so a user can
 * flip `drawMode` from the Web settings page and see the effect on the next turn
 * without editing a YAML file and restarting. Everything lives behind one `sync()`
 * with its disposers held, because a config change must never leave a duplicate
 * tool or prompt section registered (a duplicate registration throws).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context carrying tools/systemPrompt (and optionally webServer).
 * @param {object} [config] - resolved plugin config: volatile fields are live references.
 * @returns {void}
 */
export function apply(ctx, config) {
  /** The profile entry we run as — the namespace a settings write must name. */
  const entryId = resolveEntryId(ctx)

  // The configuration is read **live** on every use rather than captured at mount:
  // a volatile field is a reference the loader rewrites in place, so a mounted
  // engine keeps seeing the current value without being rebuilt.
  const resolve = () => {
    const value = {
      drawMode: configField(config, 'drawMode'),
      enabled: configField(config, 'enabled'),
      announceToAgent: configField(config, 'announceToAgent'),
      serveRoutes: configField(config, 'serveRoutes'),
      sessionReport: configField(config, 'sessionReport'),
    }
    return {
      enabled: value.enabled ?? DEFAULTS.enabled,
      announceToAgent: value.announceToAgent ?? DEFAULTS.announceToAgent,
      serveRoutes: value.serveRoutes ?? DEFAULTS.serveRoutes,
      sessionReport: value.sessionReport ?? DEFAULTS.sessionReport,
      drawMode: resolveDrawMode(value),
    }
  }

  const store = new StateStore()
  const corpus = loadCorpus(userCorpusDir())
  const engine = new DrawEngine({
    materials: corpus.materials,
    byId: corpus.byId,
    store,
  })

  // Corpus problems are reported where an operator can see them rather than
  // thrown at mount: one bad user-contributed file must not break the plugin —
  // and with it, potentially, the whole web profile.
  if (corpus.problems.length > 0) {
    const message = `dsh-serendipity: 语料校验发现 ${corpus.problems.length} 个问题 — ${corpus.problems.join('；')}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  const tools = createTools({ engine, store, readConfig: resolve })
  let disposeTools
  let disposeSection
  let disposeRoutes

  /**
   * Release one surface.
   *
   * `ctx.effect` returns a *thenable wrapper*, not a disposer — so the disposer has
   * to be the function the effect callback returns (the `dsh-ssh` convention, and
   * presumably why every plugin is written that way). Calling the effect's return
   * value is a silent no-op, which is exactly the kind of failure that leaves
   * duplicate registrations behind on a config change.
   *
   * @param {(() => void) | undefined} dispose - the disposer to run, if any.
   */
  const release = (dispose) => { if (typeof dispose === 'function') dispose() }

  /** Register or drop every surface to match the current configuration. */
  const sync = () => {
    // Tear down first: registering the same tool name or prompt-section name twice
    // throws, so a settings change must never overlap with the old registration.
    release(disposeTools)
    release(disposeSection)
    release(disposeRoutes)
    disposeTools = undefined
    disposeSection = undefined
    disposeRoutes = undefined

    const value = resolve()
    if (!value.enabled || value.drawMode === 'off') return

    disposeTools = ctx.effect(() => {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) release(dispose) }
    }, 'dsh-serendipity: tools')

    // `onRequest` keeps the tools registered but stays silent in the prompt, so the
    // agent only reaches for material when the user asks for it. That is the
    // difference between "available" and "offered" — a user who wants the plugin to
    // exist but not to be volunteered by the model needs exactly this middle step.
    if (value.announceToAgent && value.drawMode === 'autonomous') {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-serendipity',
        order: SECTION_ORDER,
        text: SERENDIPITY_GUIDANCE,
      })
    }

    // Routes follow the config too, so turning everything off really does take the
    // HTTP surface away instead of leaving a listening endpoint behind.
    if (value.serveRoutes) {
      ctx.inject(['webServer'], (child) => {
        const routes = makeRoutes({
          engine,
          store,
          // Lets `GET /settings` report how the config wiring stands — the diagnostic
          // that caught the silent failure, and the one that named the 0.2.0 breakage.
          configStatus: () => ({
            ...settingsStatus,
            entryId,
            service: typeof ctx.get === 'function' && ctx.get('settings') !== undefined ? 'available' : 'absent',
            effective: resolve(),
          }),
          readConfig: resolve,
          // The browser card writes through the settings service, so a GUI change and
          // a hand-edited profile document travel the same path.
          writeConfig: async (patch) => {
            const rejected = []
            for (const [key, value] of Object.entries(patch)) {
              if (!CONFIG_KEYS.includes(key)) rejected.push(`未知配置项「${key}」`)
              else if (key === 'drawMode' && !DRAW_MODES.includes(value)) rejected.push(`drawMode 只能是 ${DRAW_MODES.join(' / ')}`)
              else if (key !== 'drawMode' && typeof value !== 'boolean') rejected.push(`${key} 只能是 true / false`)
            }
            if (rejected.length > 0) return { ok: false, error: rejected.join('；') }

            const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
            if (settings === undefined || typeof settings.update !== 'function') {
              return {
                ok: false,
                error: '设置服务不可用：改 profile 的 cordis.patch.yml 里 serendipity 条目的 config，'
                  + '或跑 node tools/set-config.mjs drawMode=…',
              }
            }
            if (entryId === undefined) {
              return { ok: false, error: '找不到本插件在 profile 里的条目 id，无法写设置。' }
            }
            try {
              await settings.update(entryId, patch)
              // The loader rewrites volatile references in place and emits
              // `loader/volatile-update`, which re-syncs the surfaces; doing it here
              // too keeps the GUI honest if that event ever changes shape — a write
              // that silently does not take effect is a failure this plugin has
              // already paid for once.
              sync()
              return { ok: true, config: resolve() }
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) }
            }
          },
        })
        child.effect(() => {
          const disposers = routes.map(route => child.webServer.register(route))
          return () => { for (const dispose of disposers) release(dispose) }
        }, 'dsh-serendipity: routes')
      })
    }
  }

  sync()

  // A committed settings change is applied **in place**: dsh 0.2.0 rewrites the
  // volatile references and does NOT restart the plugin, so a mount decided by the
  // old value (tools registered, prompt section declared) would otherwise survive
  // the change it was decided against. The event is the only notification, and it is
  // filtered to this fiber — which is the plugin's own context.
  ctx.on('loader/volatile-update', () => sync())
}


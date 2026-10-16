/**
 * Integration test: mount the plugin through a real cordis context, the real
 * ToolRuntime, and the real SystemPrompt.
 *
 * The unit tests exercise the engine directly, which cannot catch the failures
 * that actually break a dsh boot: a wrong export shape, a duplicate tool name,
 * a schema the registry rejects, `ctx.effect` misuse, or a nested `ctx.inject`
 * that never fires. This test runs `apply()` exactly as the loader does and then
 * inspects what the model would see.
 *
 * Node resolves the `@deepseek-ai/*` peers from `node_modules` (see README for
 * the one-time junction setup), so this needs no build step either.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import * as plugin from '../lib/index.js'
import { API_BASE } from '../lib/routes.js'

/**
 * A minimal stand-in for the web server service: records what gets registered
 * and unregisters it again. The service name is passed explicitly, the way the
 * real `dsh-host-webserver` does it — cordis needs the name to publish the
 * service, and the plugin's nested `ctx.inject(['webServer'])` looks it up by
 * exactly that name.
 */
class WebServer extends Service {
  constructor(ctx, config) {
    super(ctx, 'webServer', config)
    /** Registrations seen, in order. */
    this.registered = []
  }

  register(route) {
    this.registered.push(route)
    return () => {
      this.registered = this.registered.filter(entry => entry !== route)
    }
  }
}

/** Build a context carrying the real prompt + tool services plus the fake web server. */
async function makeContext() {
  const ctx = new Context()
  // `ctx.plugin` returns a thenable Fiber; awaiting it settles the plugin's own
  // initialization, which is where the services register.
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(WebServer, {})
  return { ctx }
}

test('plugin: exports the cordis contract and mounts through the real registry', async () => {
  assert.equal(plugin.name, 'serendipity')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual([...plugin.inject].sort(), ['systemPrompt', 'tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.match(plugin.SERENDIPITY_GUIDANCE, /serendipity_draw/)

  const { ctx } = await makeContext()
  assert.ok(ctx.get('tools') !== undefined, 'ToolRuntime 未注册')
  assert.ok(ctx.get('systemPrompt') !== undefined, 'SystemPrompt 未注册')
  assert.ok(ctx.get('webServer') !== undefined, 'WebServer 未注册')

  // Mount the plugin in its own fiber, the way the loader does, so disposing the
  // fiber is a clean way to observe the plugin's own cleanup.
  const pluginFiber = await ctx.plugin({
    inject: plugin.inject,
    apply: (child) => plugin.apply(child, {}),
  })

  // Every tool the model would be offered.
  const schemas = ctx.tools.schemas()
  const names = schemas.map(schema => schema.name).sort()
  assert.deepEqual(names, [
    'serendipity_decompose', 'serendipity_draw', 'serendipity_fetch',
    'serendipity_learn', 'serendipity_note', 'serendipity_stats',
  ], `注册的工具不对：${names.join(', ')}`)

  // The parameters must reach the model with descriptions intact.
  const draw = schemas.find(schema => schema.name === 'serendipity_draw')
  assert.equal(draw.parameters.type, 'object')
  assert.ok(draw.parameters.properties.count.description.includes('1-10'))
  assert.deepEqual(Object.keys(draw.parameters.properties).sort(), [
    'allowRepeat', 'avoid', 'bias', 'collide', 'count', 'purpose', 'scope', 'violate',
  ])
  // No parameter is mandatory: a draw needs no justification.
  assert.deepEqual(draw.parameters.required ?? [], [])

  // The system prompt gains exactly one section, inside the tool-guidance band.
  const assembly = await ctx.systemPrompt.assemble()
  const section = assembly.sections.find(entry => entry.name === 'plugin:dsh-serendipity')
  assert.ok(section !== undefined, '提示词段落没有注册')
  assert.match(section.text, /跨领域「结构素材库」/)

  // The nested inject fiber fires for the existing webServer and registers the
  // four read-only routes.
  const webServer = ctx.get('webServer')
  assert.deepEqual(
    webServer.registered.map(route => route.path).sort(),
    [
      '/api/dsh-serendipity/corpus',
      '/api/dsh-serendipity/model',
      '/api/dsh-serendipity/sessions',
      '/api/dsh-serendipity/settings',
      '/api/dsh-serendipity/summary',
      '/api/dsh-serendipity/vocabulary',
    ],
  )

  // Disposing the plugin's own fiber must release both the tools and the routes:
  // the plugin owns them through `ctx.effect`, so an HMR reload cannot leave
  // duplicate registrations (which would throw on the next mount).
  await pluginFiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0, '卸载后工具没有释放')
  assert.equal(webServer.registered.length, 0, '卸载后路由没有释放')

  // And it must be mountable again after that.
  await ctx.plugin({ inject: plugin.inject, apply: (child) => plugin.apply(child, {}) })
  assert.equal(ctx.tools.schemas().length, 6, '重新挂载失败')
})

test('plugin: a tool dispatches end to end through the registry', async () => {
  const { ctx } = await makeContext()
  plugin.apply(ctx, {})

  // Dispatch through the real pipeline (schema validation, body, output-contract
  // validation, render) rather than calling the tool body directly.
  const result = await ctx.tools.execute({
    callId: 'test-call-1',
    name: 'serendipity_draw',
    arguments: { count: 2, purpose: '集成测试' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, `工具派发失败：${JSON.stringify(result.error)}`)
  assert.equal(result.value.items.length, 2)
  const text = result.content.map(block => block.text ?? '').join('\n')
  assert.match(text, /serendipity_note/)
  assert.doesNotMatch(text, /undefined/)
})

test('plugin: serendipity_stats survives the real output contract', async () => {
  const { ctx } = await makeContext()
  plugin.apply(ctx, {})

  // The stats value is the largest object the plugin returns, and the runtime
  // detaches and validates it as a whole: one `undefined` member rejects the call
  // with "value is not lossless JSON". Reading fields off the return value of the
  // tool body never catches that, so the call goes through the real pipeline.
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-serendipity-stats-'))
  try {
    for (const sections of [undefined, ['library'], ['health']]) {
      const result = await ctx.tools.execute({
        callId: `test-call-stats-${String(sections)}`,
        name: 'serendipity_stats',
        arguments: sections === undefined ? { cwd } : { cwd, sections },
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, false,
        `stats(sections=${String(sections)}) 派发失败：${JSON.stringify(result.error ?? result.content)}`)
      assert.ok(result.value.library.total > 0)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('plugin: disabled config mounts neither tools nor prompt section', async () => {
  const { ctx } = await makeContext()
  plugin.apply(ctx, { enabled: false })
  assert.equal(ctx.tools.schemas().length, 0)
  const assembly = await ctx.systemPrompt.assemble()
  assert.equal(assembly.sections.filter(entry => entry.name === 'plugin:dsh-serendipity').length, 0)
})

test('plugin: drawMode has three levels, and a typo degrades safely', async () => {
  // Asserted through the mounted behaviour rather than by reaching into the
  // resolver: what matters is what the agent can actually see.
  const allTools = [
    'serendipity_decompose', 'serendipity_draw', 'serendipity_fetch',
    'serendipity_learn', 'serendipity_note', 'serendipity_stats',
  ]
  const cases = [
    // Default: announced, so the agent decides when material would help.
    [{}, allTools, true],
    [{ drawMode: 'autonomous' }, allTools, true],
    // onRequest: tools exist but the prompt never volunteers them.
    [{ drawMode: 'onRequest' }, allTools, false],
    // off: nothing mounts at all.
    [{ drawMode: 'off' }, [], false],
    // A config typo must not take the plugin — or the profile — down.
    [{ drawMode: 'nonsense' }, allTools, true],
    // Backward compatibility with the older config shape.
    [{ announceToAgent: false }, allTools, false],
    [{ enabled: false }, [], false],
  ]

  for (const [config, expectedTools, expectAnnouncement] of cases) {
    const { ctx } = await makeContext()
    plugin.apply(ctx, config)
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    assert.deepEqual(names, expectedTools, `config=${JSON.stringify(config)} 的工具集不对`)
    const assembly = await ctx.systemPrompt.assemble()
    const announced = assembly.sections.some(section => section.name === 'plugin:dsh-serendipity')
    assert.equal(announced, expectAnnouncement, `config=${JSON.stringify(config)} 的提示词声明不对`)
  }
})

/** A live config reference, the shape dsh 0.2.0 hands to `apply` for a volatile field. */
function volatileRef(initial) {
  let current = initial
  return { get: () => current, write: (next) => { current = next } }
}

/** The five declared fields, as references, with their documented defaults. */
function defaultRefs() {
  return {
    drawMode: volatileRef('autonomous'),
    enabled: volatileRef(true),
    announceToAgent: volatileRef(true),
    serveRoutes: volatileRef(true),
    sessionReport: volatileRef(true),
  }
}

test('plugin: the Config export is what makes the settings page work', () => {
  // dsh 0.2.0 keys editable config by a declared `Config` export and only shows
  // `.volatile()` fields. Both halves matter: no export and the plugin has no
  // settings at all; a field without `.volatile()` and it silently stays read-only.
  assert.ok(plugin.Config !== undefined, 'Config 没有导出 —— 设置页里不会有它')
  const fields = plugin.Config({})
  assert.deepEqual(Object.keys(fields).sort(),
    ['announceToAgent', 'drawMode', 'enabled', 'serveRoutes', 'sessionReport'])
  for (const [key, value] of Object.entries(fields)) {
    assert.equal(typeof value.get, 'function', `${key} 不是 volatile 引用（设置页改不动它）`)
  }
  for (const [key, node] of Object.entries(plugin.Config.dict)) {
    assert.equal(node.meta.volatile, true, `${key} 没有 .volatile()，设置服务会拒绝写它`)
  }
  assert.equal(fields.drawMode.get(), 'autonomous')
  assert.equal(fields.enabled.get(), true)
  assert.equal(fields.sessionReport.get(), true)
})

/**
 * An in-memory stand-in for the settings service.
 *
 * The real package is not resolvable from this repo (measured: `schemastery`
 * resolves, `@deepseek-ai/dsh-settings` does not), which is exactly why the plugin
 * must reach it through `ctx` rather than an import — and why this fake earns its
 * place: the first version of the settings wiring failed *silently* and shipped
 * with no settings tab at all, and the 0.2.0 upgrade broke it again in a way only a
 * live call showed (`settings.register is not a function`).
 *
 * It mimics the loader too: a committed write rewrites the references in place and
 * emits `loader/volatile-update`, which is exactly what the real service does for a
 * volatile-only change — no restart, no second `apply`.
 */
class Settings extends Service {
  constructor(ctx, config) {
    super(ctx, 'settings', config)
    /** Every write the plugin made, in order. */
    this.calls = []
    /** The references to rewrite, installed by the test before mounting. */
    this.refs = {}
  }

  async update(ns, patch) {
    this.calls.push({ ns, patch })
    for (const [key, value] of Object.entries(patch)) {
      if (this.refs[key] === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
      this.refs[key].write(value)
    }
    this.ctx.emit(this.ctx, 'loader/volatile-update', Object.keys(patch))
  }
}

/** The config-editor seam the plugin uses to find its own profile entry id. */
class ConfigEditor extends Service {
  constructor(ctx, config) {
    super(ctx, 'configEditor', config)
  }

  entries() {
    return [{ options: { id: 'serendipity', name: '@1603801678/dsh-serendipity' } }]
  }
}

/** Build a request the route's loopback fence and JSON body reader both accept. */
function routeRequest({ method, url, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** Capture one route response. */
function routeResponse() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(chunk) { if (chunk !== undefined) captured.body += String(chunk) },
  }
}

test('plugin: a volatile change re-mounts the surfaces, and the card writes through the settings service', async () => {
  const { ctx } = await makeContext()
  await ctx.plugin(Settings, {})
  await ctx.plugin(ConfigEditor, {})
  const settings = ctx.get('settings')
  const refs = defaultRefs()
  settings.refs = refs
  plugin.apply(ctx, refs)

  // Default: autonomous — tools plus the prompt section.
  assert.equal(ctx.tools.schemas().length, 6)
  assert.ok((await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === 'plugin:dsh-serendipity'))

  // The loader rewrites the reference in place and emits the event; the plugin is
  // NOT restarted, so the surfaces have to follow the event.
  refs.drawMode.write('onRequest')
  ctx.emit(ctx, 'loader/volatile-update', ['drawMode'])
  assert.equal(ctx.tools.schemas().length, 6, 'onRequest 应保留工具')
  assert.ok(!(await ctx.systemPrompt.assemble()).sections.some(entry => entry.name === 'plugin:dsh-serendipity'),
    'onRequest 不应再声明提示词段落')

  refs.drawMode.write('off')
  ctx.emit(ctx, 'loader/volatile-update', ['drawMode'])
  assert.equal(ctx.tools.schemas().length, 0)

  refs.drawMode.write('autonomous')
  ctx.emit(ctx, 'loader/volatile-update', ['drawMode'])
  assert.equal(ctx.tools.schemas().length, 6, '改回来必须重新挂上（重复注册会抛）')

  // The GUI path, end to end: POST /settings → settings.update(entryId, patch).
  const route = ctx.get('webServer').registered.find(entry => entry.path === `${API_BASE}/settings`)
  assert.ok(route !== undefined, '/settings 路由没有挂上')

  const rejected = routeResponse()
  await route.handler(routeRequest({
    method: 'POST',
    url: `${API_BASE}/settings`,
    body: JSON.stringify({ drawMode: 'nonsense' }),
  }), rejected)
  assert.equal(rejected.captured.status, 400)
  assert.match(rejected.captured.body, /drawMode 只能是/)
  assert.equal(ctx.get('settings').calls.length, 0, '非法取值不该走到设置服务')

  const accepted = routeResponse()
  await route.handler(routeRequest({
    method: 'POST',
    url: `${API_BASE}/settings`,
    body: JSON.stringify({ drawMode: 'off' }),
  }), accepted)
  assert.equal(accepted.captured.status, 200, accepted.captured.body)
  // The namespace is the **profile entry id**, not a name the plugin invents.
  assert.deepEqual(settings.calls, [{ ns: 'serendipity', patch: { drawMode: 'off' } }])
  assert.equal(ctx.tools.schemas().length, 0, '写在设置里的值必须立刻生效')
  assert.equal(JSON.parse(accepted.captured.body).config.drawMode, 'off')

  // Unknown keys and wrong types are refused before the write too.
  for (const patch of [{ nope: true }, { enabled: 'yes' }]) {
    const response = routeResponse()
    await route.handler(routeRequest({ method: 'POST', url: `${API_BASE}/settings`, body: JSON.stringify(patch) }), response)
    assert.equal(response.captured.status, 400, JSON.stringify(patch))
  }
  assert.equal(settings.calls.length, 1, '被拒的 patch 不应写进设置')
})

test('plugin: a corrupt user corpus is reported, not fatal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-serendipity-home-'))
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  try {
    // The plugin resolves its user corpus from the OS home directory, so the
    // only way to point it at a scratch tree is to move home for this test.
    const scratchHome = join(root, 'home')
    process.env.HOME = scratchHome
    process.env.USERPROFILE = scratchHome
    const corpusDir = join(scratchHome, '.dsh', 'dsh-serendipity', 'corpus')
    mkdirSync(corpusDir, { recursive: true })
    writeFileSync(join(corpusDir, 'pattern.json'), '{ truncated', 'utf8')

    const warnings = []
    const { ctx } = await makeContext()
    ctx.logger = { warn: (message) => warnings.push(String(message)) }
    plugin.apply(ctx, {})

    // The built-in corpus still loads, and the operator is told.
    assert.deepEqual(
      ctx.tools.schemas().map(schema => schema.name).sort(),
      ['serendipity_decompose', 'serendipity_draw', 'serendipity_fetch', 'serendipity_learn', 'serendipity_note', 'serendipity_stats'],
    )
    assert.ok(warnings.some(message => message.includes('语料校验发现')), `没有告警：${warnings.join('|')}`)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The browser half's contract.
 *
 * A client bundle is loaded by `dsh-client-modules` as a lazy CJS table: the host
 * reads `exports["./client"]` from the package manifest, serves that file at
 * `/plugins/<id>/client.js`, and the shell instance provides a few *static* modules
 * (react among them) that a factory may `require` without declaring them.
 *
 * None of that can be caught by mounting the host plugin, and a browser bundle that
 * is merely *wrong* fails silently in the page — the card just never appears. These
 * assertions pin the mechanical requirements, so a future edit cannot quietly break
 * the card again.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(projectRoot, 'lib', 'client.js')

/** The package manifest, parsed. */
function manifest() {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
}

test('client bundle: the manifest points at it and declares the web platform', () => {
  const pkg = manifest()
  // The host resolves this subpath itself, accepting a string or { default }.
  const client = pkg.exports?.['./client']
  const target = typeof client === 'string' ? client : client?.default
  assert.equal(typeof target, 'string', 'package.json 缺少 exports["./client"]')
  assert.equal(target, './lib/client.js')
  assert.ok(existsSync(join(projectRoot, target)), `${target} 不存在`)

  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject 必须是数组')
  // `slots` is the service the card registers through; a bundle that needs it
  // without declaring it is a graph error.
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    `dsh.client.inject 应包含 slots 模块，实际：${pkg.dsh.client.inject.join(', ')}`)
})

test('client bundle: registers the expected module id and exports apply', () => {
  const pkg = manifest()
  const source = readFileSync(clientPath, 'utf8')

  // The loader keys the module by the package name, and the boot manifest asserts
  // the bundle registered exactly that id.
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes(`id: '${pkg.name}'`), `client.js 应以 id: '${pkg.name}' 注册`)
  assert.match(source, /factory:\s*\(require\)\s*=>/)
  // `apply` and `inject` are the plugin entry points the runtime looks up.
  assert.match(source, /function apply\(ctx\)/)
  assert.match(source, /const inject = \[/)
  assert.match(source, /return \{ apply, inject \}/)
  // react is a shell-provided static module, so it may be required directly.
  assert.match(source, /require\('react'\)/)
})

test('client bundle: the card writes through the plugin route, not a file', () => {
  const source = readFileSync(clientPath, 'utf8')
  // The GUI must go through the same config path as a hand-edited document; a
  // bundle that invented its own file write would drift from the host's view.
  assert.match(source, /\/api\/dsh-serendipity\/settings/)
  assert.match(source, /method: 'POST'/)
  // Registration target: the official settings page section slot.
  assert.match(source, /settings\.section/)
  // A client plugin that throws takes the whole shell boot down with it, so the
  // registration is wrapped.
  assert.match(source, /catch \(error\)/)
})

test('client bundle: no host-only imports leak into the browser half', () => {
  const source = readFileSync(clientPath, 'utf8')
  // `node:` builtins and host SDK packages cannot resolve in the module table;
  // importing one is an instant boot failure in the page.
  for (const forbidden of ['node:fs', 'node:path', 'node:module', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-settings']) {
    assert.ok(!source.includes(`require('${forbidden}')`), `client.js 不应 require ${forbidden}`)
  }
})

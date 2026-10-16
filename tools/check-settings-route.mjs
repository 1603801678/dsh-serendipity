// 验证新的 /settings 诊断路由：能报告设置项注册阶段与当前生效配置。
import { loadCorpus } from '../lib/corpus.js'
import { DrawEngine } from '../lib/draw.js'
import { makeRoutes, API_BASE } from '../lib/routes.js'
import { StateStore } from '../lib/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'ser-settings-'))
const corpus = loadCorpus(undefined)
const store = new StateStore({ root })
const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
const routes = makeRoutes({
  engine,
  store,
  configStatus: () => ({ stage: 'declared', entryId: 'serendipity', service: 'available', effective: { drawMode: 'onRequest', enabled: true } }),
})

const route = routes.find(entry => entry.path === `${API_BASE}/settings`)
console.log('路由存在：', route !== undefined)

const chunks = []
const response = {
  status: 0,
  writeHead(status) { this.status = status },
  end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)) },
}
await route.handler(
  { method: 'GET', url: `${API_BASE}/settings`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
  response,
)
console.log('HTTP', response.status)
console.log(chunks.join(''))

// 没有 configStatus 时也要能安全回答
const bare = makeRoutes({ engine, store }).find(entry => entry.path === `${API_BASE}/settings`)
const chunks2 = []
await bare.handler(
  { method: 'GET', url: `${API_BASE}/settings`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
  { writeHead() {}, end(chunk) { if (chunk !== undefined) chunks2.push(String(chunk)) } },
)
console.log('未接线时的回答：', chunks2.join(''))

rmSync(root, { recursive: true, force: true })

// 生成「情境图」：真实彩色 emoji + 箭头 + 少量文字。
//
//   node tools/build-scenario-images.mjs [outDir]
//
// 出两套，因为 dsh-ppt 有两种图框比例（见 AGENTS.md「版式」一节）：
//  - 整页 `image`      11.6×4.45 in ≈ 2.60:1 → 2560×984   （信息量大的图：流程、漏斗）
//  - 半幅 `image-right` 5.6×4.45 in ≈ 1.26:1 → 2160×1712  （情境图：emoji + 箭头）
//
// 三条硬坑（都踩过）：
//  1. 用**浏览器**渲染，不用 Inkscape —— Inkscape 把彩色 emoji 画成单色轮廓。
//  2. 比例必须匹配图框，混用会被拉伸裁切。
//  3. PPTX 侧是 `<a:stretch><a:fillRect/>`（拉伸填满），内容超宽/超高就会被裁掉，
//     改完模板务必量：`node tools/measure-scenario-images.mjs`。
import { writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scenarioHtml, SCENARIO_NAMES, SCENARIO_CANVAS } from './scenario-template.mjs'
import { halfScenarioHtml, HALF_SCENARIO_NAMES, HALF_SCENARIO_CANVAS } from './scenario-template-half.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(process.argv[2] || resolve(HERE, '../演示/assets/muse'))
mkdirSync(OUT, { recursive: true })

const sets = [
  { tag: 'full', names: SCENARIO_NAMES, canvas: SCENARIO_CANVAS, html: scenarioHtml },
  { tag: 'half', names: HALF_SCENARIO_NAMES, canvas: HALF_SCENARIO_CANVAS, html: halfScenarioHtml },
]

const EDGE = process.env.DSH_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9713
const PROFILE = process.env.TEMP + '\\dshppt-scenario'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' })

let ws, id = 1
const pend = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + m)) } }, 20000) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }

try {
  let page
  for (let i = 0; i < 60 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) } catch { /* not up */ }
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('no page target — Edge 装了吗？路径可用 DSH_EDGE 覆盖')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
  await send('Runtime.enable'); await send('Page.enable')

  for (const set of sets) {
    const { w: W, h: H } = set.canvas
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    for (const name of set.names) {
      const tmp = join(process.env.TEMP, 'scenario-' + set.tag + '-' + name + '.html')
      writeFileSync(tmp, set.html(name), 'utf8')
      await send('Page.navigate', { url: pathToFileURL(tmp).href })
      await ev('document.fonts ? document.fonts.ready.then(()=>1) : 1')
      await sleep(420)
      const r = await send('Page.captureScreenshot', { format: 'png' })
      const out = join(OUT, name + '.png')
      writeFileSync(out, Buffer.from(r.data, 'base64'))
      console.log('wrote ' + out + '  (' + W + 'x' + H + ')')
    }
  }
} catch (err) {
  console.error('FAILED: ' + err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}

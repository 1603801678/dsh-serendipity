// 量两套情境图（整页 2.60:1 与半幅 1.26:1）的内容包围盒，确认不会被 fillRect 裁掉。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scenarioHtml, SCENARIO_NAMES, SCENARIO_CANVAS } from './scenario-template.mjs'
import { halfScenarioHtml, HALF_SCENARIO_NAMES, HALF_SCENARIO_CANVAS } from './scenario-template-half.mjs'

const EDGE = process.env.DSH_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9723
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sets = [
  { tag: 'full', names: SCENARIO_NAMES, canvas: SCENARIO_CANVAS, html: scenarioHtml },
  { tag: 'half', names: HALF_SCENARIO_NAMES, canvas: HALF_SCENARIO_CANVAS, html: halfScenarioHtml },
]

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\dshppt-measure',
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
let ws, id = 1
const pend = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')) } }, 15000) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }

try {
  let page
  for (let i = 0; i < 60 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) } catch { /* wait */ }
    if (!page) await sleep(250)
  }
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
  await send('Runtime.enable'); await send('Page.enable')

  let bad = 0
  for (const set of sets) {
    const { w: W, h: H } = set.canvas
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    console.log('\n' + set.tag + ' 画布 ' + W + 'x' + H)
    for (const name of set.names) {
      const tmp = join(process.env.TEMP, 'measure-' + set.tag + '-' + name + '.html')
      writeFileSync(tmp, set.html(name), 'utf8')
      await send('Page.navigate', { url: pathToFileURL(tmp).href })
      await ev('document.fonts ? document.fonts.ready.then(()=>1) : 1')
      await sleep(300)
      const r = await ev(`(() => {
        const cv = document.querySelector('.cv');
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        cv.querySelectorAll('*').forEach(function (el) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return;
          if (b.left < minX) minX = b.left; if (b.right > maxX) maxX = b.right;
          if (b.top < minY) minY = b.top; if (b.bottom > maxY) maxY = b.bottom;
        });
        return { w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
      })()`)
      const fitW = r.w <= W, fitH = r.h <= H
      if (!fitW || !fitH) bad++
      console.log((fitW && fitH ? 'OK   ' : 'OVER ') + name.padEnd(24) + ' content ' + r.w + 'x' + r.h +
        (fitW ? '' : '  宽超 ' + (r.w - W) + 'px') + (fitH ? '' : '  高超 ' + (r.h - H) + 'px'))
    }
  }
  console.log(bad ? '\n' + bad + ' 张超框' : '\n全部在框内')
  process.exitCode = bad ? 1 : 0
} catch (err) {
  console.error('FAILED: ' + err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}

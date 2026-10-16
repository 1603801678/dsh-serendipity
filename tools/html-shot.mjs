// Screenshot a local HTML file at an exact size via CDP. The most reliable way to
// get true-color emoji + CJK text into a PNG on Windows.
//   node html-shot.mjs <file.html> <out.png> [width] [height]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [file, out, wArg, hArg] = process.argv.slice(2)
if (!file || !out) { console.error('usage: node html-shot.mjs <in.html> <out.png> [w] [h]'); process.exit(2) }
const W = Number(wArg || 1600), H = Number(hArg || 900)
const PORT = 9500 + Math.floor(Math.random() * 400)
const PROFILE = process.env.TEMP + '\\dshppt-shot-' + PORT
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
  if (!page) throw new Error('no page target')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => { ws.onopen = r })
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
  await send('Runtime.enable'); await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: pathToFileURL(resolve(file)).href })
  // wait for fonts + images to settle
  await ev('document.fonts ? document.fonts.ready.then(()=>1) : 1')
  for (let i = 0; i < 40; i++) {
    const ok = await ev('document.readyState === "complete" && Array.from(document.images).every(i => i.complete)')
    if (ok) break
    await sleep(150)
  }
  await sleep(400)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(out, Buffer.from(r.data, 'base64'))
  console.log('wrote ' + out + '  (' + W + 'x' + H + ')')
} catch (err) {
  console.error('FAILED: ' + err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}

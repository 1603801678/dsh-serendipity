// 自动标定 scenario-template.mjs 的全局放大系数 S：
// 二分搜索一个 S，使所有情境图的内容宽度都 <= 画布宽度（留 6% 余量）。
// 用法：node tools/calibrate-scenarios.mjs [--write]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const WRITE = process.argv.includes('--write')
const TEMPLATE = new URL('./scenario-template.mjs', import.meta.url)
const EDGE = process.env.DSH_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9733
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'dshppt-cal-'))

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(tmp, 'prof'),
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
let ws, id = 1
const pend = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')) } }, 15000) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }

async function measure(S) {
  const src = readFileSync(TEMPLATE, 'utf8').replace(/const S = [\d.]+/, 'const S = ' + S)
  const modPath = join(tmp, 'tpl-' + S + '.mjs')
  writeFileSync(modPath, src, 'utf8')
  const mod = await import(pathToFileURL(modPath).href + '?v=' + S)
  const { w: W, h: H } = mod.SCENARIO_CANVAS
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  const out = {}
  for (const name of mod.SCENARIO_NAMES) {
    const f = join(tmp, 'm-' + S + '-' + name + '.html')
    writeFileSync(f, mod.scenarioHtml(name), 'utf8')
    await send('Page.navigate', { url: pathToFileURL(f).href })
    await ev('document.fonts ? document.fonts.ready.then(()=>1) : 1')
    await sleep(200)
    out[name] = await ev(`(() => {
      const s = document.querySelector('.cv > .row');
      const b = s.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    })()`)
  }
  return { W, H, out }
}

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

  // 二分：找最大的 S 使所有图都放得下（目标 ≤ 0.94 * W）
  let lo = 0.4, hi = 6, best = null
  for (let iter = 0; iter < 9; iter++) {
    const mid = (lo + hi) / 2
    const { W, out } = await measure(mid.toFixed(3))
    const worst = Object.entries(out).sort((a, b) => b[1].w - a[1].w)[0]
    const ok = worst[1].w <= W * 0.94
    console.log('S=' + mid.toFixed(3) + '  worst=' + worst[0] + ' ' + worst[1].w + 'px / ' + W + '  ' + (ok ? 'FIT' : 'OVER'))
    if (ok) { best = mid; lo = mid } else { hi = mid }
  }
  if (best === null) throw new Error('连最小的 S 都放不下，模板有问题')
  const S = Number(best.toFixed(2))
  console.log('\n选定 S=' + S)
  const { out } = await measure(S.toFixed(2))
  for (const [k, v] of Object.entries(out)) console.log('  ' + k.padEnd(20) + v.w + 'x' + v.h)
  if (WRITE) {
    const src = readFileSync(TEMPLATE, 'utf8').replace(/const S = [\d.]+/, 'const S = ' + S)
    writeFileSync(TEMPLATE, src, 'utf8')
    console.log('\n已写入 scenario-template.mjs')
  } else {
    console.log('\n（未写入；加 --write 生效）')
  }
} catch (err) {
  console.error('FAILED: ' + err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}

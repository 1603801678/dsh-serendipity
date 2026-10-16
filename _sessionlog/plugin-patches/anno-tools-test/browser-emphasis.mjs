// Real-browser check that inline emphasis renders in the HTML slideshow (weight + color), not just markup.
import { spawn } from 'node:child_process'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const FILE = process.argv[2]
const PORT = 9644
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\dshppt-emph', '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
let ws, id = 1
const pend = new Map()
const send = (m, p = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')) } }, 15000) }) }
async function ev(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
let page
for (let i = 0; i < 40 && !page; i++) { try { page = (await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) } catch {} if (!page) await sleep(250) }
ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: FILE })
for (let i = 0; i < 40; i++) { if (await ev('!!document.getElementById("stage") && document.querySelectorAll(".slide").length>0')) break; await sleep(250) }
await sleep(500)

const checks = await ev(`(() => {
  const out = [];
  const slide1 = document.querySelectorAll('.slide')[0];
  const title = slide1.querySelector('h2');
  const lis = Array.from(slide1.querySelectorAll('li'));
  const strongInTitle = title.querySelector('strong');
  const hlInTitle = title.querySelector('.hl');
  const cssWeight = strongInTitle ? getComputedStyle(strongInTitle).fontWeight : null;
  const baseWeight = getComputedStyle(title).fontWeight;
  const nrmWeight = getComputedStyle(lis[0]).fontWeight;
  out.push(['<strong> exists in title', !!strongInTitle]);
  out.push(['<strong> font-weight is heavier than body', Number(cssWeight) > Number(nrmWeight), cssWeight + ' vs ' + nrmWeight]);
  out.push(['.hl exists in title', !!hlInTitle]);
  out.push(['.hl colour is the accent red', hlInTitle ? getComputedStyle(hlInTitle).color : null]);
  const boldLi = lis[1].querySelector('strong');
  out.push(['bold bullet has <strong>', !!boldLi]);
  const accLi = lis[2].querySelector('.hl');
  out.push(['accent bullet has .hl', !!accLi]);
  out.push(['accent bullet colour', accLi ? getComputedStyle(accLi).color : null]);
  const mixed = lis[3];
  out.push(['mixed bullet has both', !!mixed.querySelector('strong') && !!mixed.querySelector('.hl')]);
  const colorOf = (el) => (el ? getComputedStyle(el).color : 'no-element')
  out.push(['accent (title) is brand red', colorOf(hlInTitle) === 'rgb(192, 0, 0)', colorOf(hlInTitle)])
  out.push(['accent (bullet) is brand red', colorOf(accLi) === 'rgb(192, 0, 0)', colorOf(accLi)])
  out.push(['accent is NOT the soft-theme orange', colorOf(hlInTitle) !== 'rgb(229, 138, 47)', colorOf(hlInTitle)])
  // markers must not be visible in any slide text
  const allText = Array.from(document.querySelectorAll('.slide')).map(s => s.textContent).join(' ');
  out.push(['no ** visible', !allText.includes('**')]);
  out.push(['no == visible', !allText.includes('==')]);
  out.push(['no literal <b> rendered', !document.querySelector('.slide b')]);
  out.push(['injected tag text kept, tag dropped', allText.includes('应剥掉的 标签')]);
  // table cell emphasis
  const slide2 = document.querySelectorAll('.slide')[1];
  const tds = Array.from(slide2.querySelectorAll('td'));
  out.push(['table cell accent colour', (() => { const h = slide2.querySelector('td .hl'); return h ? getComputedStyle(h).color : null })()]);
  out.push(['table cell bold weight', (() => { const b = slide2.querySelector('td strong'); return b ? getComputedStyle(b).fontWeight : null })()]);
  // plain slide must be untouched
  const slide3 = document.querySelectorAll('.slide')[2];
  out.push(['plain slide has no strong', !slide3.querySelector('strong')]);
  out.push(['plain slide has no .hl', !slide3.querySelector('.hl')]);
  return out;
})()`)

let bad = 0
for (const c of checks) { const [name, ok, detail] = c; if (!ok) bad++; console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail != null ? '  — ' + detail : '')) }
console.log(bad ? '\n' + bad + ' FAILED' : '\nall ' + checks.length + ' browser checks passed')
ws.close(); edge.kill()
process.exitCode = bad ? 1 : 0

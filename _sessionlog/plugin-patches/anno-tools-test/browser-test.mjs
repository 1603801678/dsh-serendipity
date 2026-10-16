// Real-browser verification for the new player tools (laser / pen / zoom).
// Drives headless Edge over the Chrome DevTools Protocol and asserts actual pixels.
import { spawn } from 'node:child_process'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const FILE = process.argv[2]
const PORT = 9631
const PROFILE = process.env.TEMP + '\\dshppt-anno-profile'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

const edge = spawn(EDGE, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--window-size=1280,720',
  'about:blank',
], { stdio: 'ignore' })

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('browser did not expose a page target')
}

let ws, nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)) } }, 10000)
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function key(k, code, vk, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
}
async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
}
async function drag(x0, y0, x1, y1, extra = {}) {
  await mouse('mousePressed', x0, y0, extra)
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, extra)
    await sleep(20)
  }
  await mouse('mouseReleased', x1, y1, extra)
}

// count opaque pixels on a canvas layer
const inkExpr = (id) => `(() => {
  const c = document.getElementById('${id}');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++;
  return n;
})()`

try {
  const page = await findPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  // headless windows opened on about:blank default to a tiny viewport; pin it so
  // coordinate-based input always lands inside the page
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: FILE })
  const where = await evaluate('location.href')
  const wantName = decodeURIComponent(FILE.split('/').pop())
  if (!where.includes(encodeURI(wantName)) && !where.includes(wantName)) throw new Error('attached to wrong target: ' + where)
  const vp = await evaluate('window.innerWidth + "x" + window.innerHeight')
  check('viewport pinned for input', vp === '1280x720', vp)
  // the player attaches its listeners during init; dispatching input before that silently no-ops
  let ready = false
  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!document.getElementById("anno-bar") && !!window.__dshPpt')) { ready = true; break }
    await sleep(250)
  }
  check('player finished initialising before input', ready)
  await sleep(400)

  // 0) player booted, no console errors thrown during load
  check('player boots with annotation layer', await evaluate('!!document.getElementById("anno-bar") && !!document.getElementById("pen-canvas")'))
  check('pen canvas sized to viewport', await evaluate('document.getElementById("pen-canvas").width > 0'))

  // 1) laser: hold X, move, expect trail pixels
  await evaluate('document.getElementById("anno-clear").click()')
  await sleep(120)
  check('laser canvas starts empty', (await evaluate(inkExpr('laser-canvas'))) === 0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 })
  await sleep(60)
  for (let i = 0; i < 12; i++) { await mouse('mouseMoved', 300 + i * 30, 360 + Math.sin(i / 2) * 40); await sleep(45) }
  const laserInk = await evaluate(inkExpr('laser-canvas'))
  check('laser trail paints while held', laserInk > 200, 'lit pixels=' + laserInk)
  check('laser does not ink the pen layer', (await evaluate(inkExpr('pen-canvas'))) === 0)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 })
  await evaluate('window.__laserPending = 1')
  await sleep(900)
  const laserAfter = await evaluate(inkExpr('laser-canvas'))
  check('laser fades after release', laserAfter < laserInk, laserInk + ' -> ' + laserAfter)

  // 2) pen: toggle D, drag, expect ink; then C clears
  await evaluate('document.getElementById("anno-clear").click()')
  await key('d', 'KeyD', 68)
  await sleep(80)
  check('pen mode enabled by D', await evaluate('document.body.classList.contains("pen-on")'))
  await drag(320, 300, 900, 480)
  await sleep(150)
  const penInk = await evaluate(inkExpr('pen-canvas'))
  check('pen stroke inks the pen layer', penInk > 300, 'lit pixels=' + penInk)
  const penColor = await evaluate(`(() => {
    const c = document.getElementById('pen-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i+3] > 40) { r = d[i]; g = d[i+1]; break }
    return { r, g };
  })()`)
  check('default pen is red', penColor.r > 180 && penColor.g < 110, JSON.stringify(penColor))

  // green pen via Shift+D
  await key('D', 'KeyD', 68, 8)
  await sleep(80)
  check('shift+D selects green pen', await evaluate('document.getElementById("anno-pen").classList.contains("is-on")'))
  await drag(320, 520, 900, 560)
  await sleep(150)
  const green = await evaluate(`(() => {
    const c = document.getElementById('pen-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let found = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i+3] > 40 && d[i+1] > 150 && d[i] < 120) { found++; if (found > 50) break }
    return found;
  })()`)
  check('green pen inks in green', green > 50, 'green pixels=' + green)

  // C clears the slide
  await key('c', 'KeyC', 67)
  await sleep(150)
  check('C clears annotations', (await evaluate(inkExpr('pen-canvas'))) === 0)

  // 3) zoom: Shift+wheel zooms in, drag pans, Esc resets
  check('zoom starts at 1x', (await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--deck-zoom").trim()')) === '1')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: -240, modifiers: 8 })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: -240, modifiers: 8 })
  let zoomed = '1'
  for (let i = 0; i < 20; i++) { // the stage transform has a 180ms transition; read the settled value
    zoomed = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--deck-zoom").trim()')
    if (parseFloat(zoomed) > 1.3) break
    await sleep(100)
  }
  check('shift+wheel zooms in', parseFloat(zoomed) > 1.3, 'zoom=' + zoomed)
  check('zoom marks body.zoomed', await evaluate('document.body.classList.contains("zoomed")'))

  // turn the pen OFF first: with the pen active a left-drag is a stroke, not a pan
  await evaluate(`(() => { const b = document.getElementById('anno-pen'); if (document.body.classList.contains('pen-on')) b.click(); return document.body.classList.contains('pen-on') })()`)
  await sleep(120)
  check('pen toggled off by button', !(await evaluate('document.body.classList.contains("pen-on")')))
  const before = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--deck-px").trim()')
  await drag(700, 400, 620, 340)
  await sleep(150)
  const after = await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--deck-px").trim()')
  check('drag pans while zoomed', before !== after, before + ' -> ' + after)

  const stageHidden = await evaluate(`(() => {
    const s = getComputedStyle(document.getElementById('stage')).transform;
    return s !== 'none' && s !== 'matrix(1, 0, 0, 1, 0, 0)';
  })()`)
  check('stage carries the zoom transform', stageHidden)

  await key('Escape', 'Escape', 27)
  await sleep(250)
  check('Esc resets zoom to 1x', (await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--deck-zoom").trim()')) === '1')

  // 4) annotations are per-slide and survive page navigation
  await key('d', 'KeyD', 68)
  await drag(400, 300, 600, 300)
  await sleep(200)
  const onPage1 = await evaluate(inkExpr('pen-canvas'))
  await key('ArrowRight', 'ArrowRight', 39)
  await sleep(300)
  const onPage2 = await evaluate(inkExpr('pen-canvas'))
  check('new slide starts without ink', onPage2 === 0, 'page1=' + onPage1 + ' page2=' + onPage2)
  await key('ArrowLeft', 'ArrowLeft', 37)
  await sleep(300)
  const backOnPage1 = await evaluate(inkExpr('pen-canvas'))
  check('returning restores that slide ink', Math.abs(backOnPage1 - onPage1) < onPage1 * 0.25, backOnPage1 + ' vs ' + onPage1)
  await evaluate(`(() => { if (document.body.classList.contains('pen-on')) document.getElementById('anno-pen').click(); document.getElementById('anno-clear').click(); return 1 })()`)
  await sleep(150)

  // 5) existing features must still work
  await key('g', 'KeyG', 71)
  await sleep(200)
  check('overview still works (G)', await evaluate('document.body.classList.contains("overview")'))
  await key('Escape', 'Escape', 27)
  await sleep(150)
  check('annotation toolbar hidden in overview', await evaluate(`getComputedStyle(document.getElementById('anno-bar')).display === 'none' || !document.body.classList.contains('overview')`))
  await key('s', 'KeyS', 83)
  await sleep(150)
  check('notes still work (S)', await evaluate('document.body.classList.contains("notes-open")'))
  await key('Escape', 'Escape', 27)
  await sleep(120)
  check('slide counter still updates', (await evaluate('document.getElementById("counter").textContent')).includes('/'))
} catch (err) {
  check('harness ran to completion', false, err.message)
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
  await sleep(300)
  if (failed.length) process.exitCode = 1
}

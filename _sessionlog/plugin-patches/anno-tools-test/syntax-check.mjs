import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')

// 1) inline player script must parse
const parts = html.split(/<script>/i)
const last = parts[parts.length - 1].split(/<\/script>/i)[0]
try {
  new Function(last)
  console.log('PARSE OK  player script (' + last.length + ' chars)')
} catch (err) {
  console.log('PARSE FAIL: ' + err.message)
  process.exitCode = 1
}

// 2) the new player surface must actually be present in the artifact
const required = [
  '--deck-zoom',
  '--deck-px',
  'id="pen-canvas"',
  'id="laser-canvas"',
  'id="anno-bar"',
  'id="anno-laser"',
  'id="anno-pen"',
  'id="anno-zoom"',
  'id="anno-clear"',
  'function redrawPen',
  'function zoomAt',
  'function clearPenAll',
  'function renderLaser',
  'laserOpts',
  'requestAnimationFrame(tick)',
]
let missing = 0
for (const needle of required) {
  if (!html.includes(needle)) { console.log('MISSING: ' + needle); missing++ }
}
console.log(missing === 0 ? 'ASSETS OK  all ' + required.length + ' markers present' : 'ASSETS FAIL ' + missing + ' missing')
if (missing) process.exitCode = 1

// 3) no template literals leaked from the generator into the player script
if (last.includes('${')) { console.log('LEAK: ${ found in player script'); process.exitCode = 1 }
else console.log('LEAK OK   no unexpanded template placeholders')

// 4) lang-specific labels resolved (zh default)
console.log(html.includes('激光笔：按住 X') ? 'UI OK     zh toolHint rendered' : 'UI FAIL   toolHint missing')

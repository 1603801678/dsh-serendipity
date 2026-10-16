import { readFileSync } from 'node:fs'
const html = readFileSync(process.argv[2], 'utf8')
const checks = {
  'closing title 下一步': html.includes('下一步'),
  'chart value 387': html.includes('387'),
  'chart caption 数据源': html.includes('数据源'),
  'annotation toolbar': html.includes('id="anno-bar"'),
  'laser canvas': html.includes('id="laser-canvas"'),
  'pen canvas': html.includes('id="pen-canvas"'),
  'help: laser key X': html.includes('<kbd>X</kbd>'),
  'help: pen key D': html.includes('<kbd>D</kbd>'),
  'help: zoom key Z': html.includes('<kbd>Z</kbd>'),
  'slide frames == 21': (html.match(/class="slide-frame"/g) || []).length === 21,
  'tables present': (html.match(/deck-table/g) || []).length > 5,
  'speaker notes kept': (html.match(/data-notes=/g) || []).length >= 20,
}
let bad = 0
for (const [k, v] of Object.entries(checks)) { if (!v) bad++; console.log((v ? 'OK   ' : 'FAIL ') + k) }
const repl = (html.match(/\uFFFD/g) || []).length
console.log((repl === 0 ? 'OK   ' : 'FAIL ') + 'no mojibake (U+FFFD count ' + repl + ')')
if (repl) bad++
console.log(bad ? '\n' + bad + ' FAILED' : '\nall content checks passed')
process.exitCode = bad ? 1 : 0

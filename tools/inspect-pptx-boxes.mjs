import { readFileSync } from 'node:fs'
const file = process.argv[2]
const s = readFileSync(file, 'utf8')
const pics = [...s.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0])
console.log('pics in ' + file.split('\\').pop() + ': ' + pics.length)
const EMU = 914400
for (const p of pics) {
  const off = p.match(/<a:off x="(\d+)" y="(\d+)"\/>/)
  const ext = p.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/)
  const nm = p.match(/name="([^"]*)"/)
  if (!off || !ext) continue
  const x = +off[1] / EMU, y = +off[2] / EMU, w = +ext[1] / EMU, h = +ext[2] / EMU
  console.log('  ' + (nm ? nm[1] : '?') + '  box x=' + x.toFixed(2) + ' y=' + y.toFixed(2) +
    ' w=' + w.toFixed(2) + ' h=' + h.toFixed(2) + '  ratio=' + (w / h).toFixed(3) +
    '  占整页宽 ' + (w / 13.333 * 100).toFixed(0) + '%')
}
// 文本形状
const shapes = [...s.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0])
for (const sp of shapes) {
  const nm = sp.match(/name="([^"]*)"/)
  const off = sp.match(/<a:off x="(\d+)" y="(\d+)"\/>/)
  const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/)
  if (!nm || !off || !ext) continue
  if (!/Body|Title/.test(nm[1])) continue
  const x = +off[1] / EMU, y = +off[2] / EMU, w = +ext[1] / EMU, h = +ext[2] / EMU
  console.log('  [' + nm[1] + '] box x=' + x.toFixed(2) + ' y=' + y.toFixed(2) + ' w=' + w.toFixed(2) + ' h=' + h.toFixed(2))
}

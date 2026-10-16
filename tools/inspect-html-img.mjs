import { readFileSync } from 'node:fs'
const h = readFileSync(process.argv[2], 'utf8')
const slides = h.split('<section class="slide slide--')
let n = 0
for (const s of slides) {
  if (!/^(image|image-right|image-left)\b/.test(s)) continue
  n++
  const fig = s.indexOf('<figure class="media-image"')
  const img = s.indexOf('<img', fig >= 0 ? fig : 0)
  const title = (s.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, '?'])[1].replace(/<[^>]*>/g, '').slice(0, 28)
  const boxStyle = fig >= 0 ? (s.slice(fig, fig + 260).match(/style="([^"]*)"/) || [, '?'])[1] : '?'
  const imgTag = img >= 0 ? s.slice(img, s.indexOf('>', img) + 1) : '?'
  const nm = (imgTag.match(/(half-)?[\w-]+\.png/) || ['?'])[0]
  const st = (imgTag.match(/style="([^"]*)"/) || [, '?'])[1]
  console.log('fig' + n + '  ' + title)
  console.log('    img ' + nm.padEnd(26) + ' style=' + st)
  console.log('    boxstyle=' + (boxStyle.length > 110 ? boxStyle.slice(0, 110) + '…' : boxStyle))
}

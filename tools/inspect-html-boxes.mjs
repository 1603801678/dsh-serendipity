// 从生成的 HTML 里反推 mediaBoxes 实际用的框：position() 输出 left/top/width/height 百分比。
import { readFileSync } from 'node:fs'
const html = readFileSync(process.argv[2], 'utf8')
const CANVAS = { w: 13.3333333333, h: 7.5 }
const slides = [...html.matchAll(/<section class="slide slide--([\w-]+)"[\s\S]*?<\/section>/g)]
console.log('slides in html:', slides.length)
slides.forEach((m, i) => {
  const body = m[0]
  if (!/slide--image/.test(body)) return
  const title = (body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, ''])[1].replace(/<[^>]*>/g, '').slice(0, 30)
  const imgStyle = (body.match(/class="media-image" style="([^"]*)"/) || [, ''])[1]
  const bodyStyle = (body.match(/class="media-body" style="([^"]*)"/) || [, ''])[1]
  const num = (s, k) => { const r = s.match(new RegExp(k + ':([\\d.]+)%')); return r ? +r[1] : null }
  const iw = num(imgStyle, 'width'), il = num(imgStyle, 'left')
  const bw = num(bodyStyle, 'width'), bl = num(bodyStyle, 'left')
  const fmt = (v) => v === null ? '  -  ' : (v / 100 * 13.333).toFixed(2) + '"'
  console.log(String(i + 1).padStart(2) + ' ' + m[1].padEnd(12) + ' img ' + fmt(il).padStart(6) + ' w=' + fmt(iw).padStart(6) +
    '   body ' + fmt(bl).padStart(6) + ' w=' + fmt(bw).padStart(6) + '   ' + title)
})

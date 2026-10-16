// 列出每个 slide XML 里的图片框与文字框，找出「图片被放进窄栏」的页。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const EMU = 914400
const files = readdirSync(dir).filter((f) => /^slide\d+\.xml$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
for (const f of files) {
  const s = readFileSync(join(dir, f), 'utf8')
  const pic = s.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0]
  let img = 'none'
  if (pic) {
    const off = pic.match(/<a:off x="(\d+)" y="(\d+)"\/>/)
    const ext = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/)
    if (off && ext) img = 'x=' + (+off[1] / EMU).toFixed(2) + ' w=' + (+ext[1] / EMU).toFixed(2) + ' → 占宽 ' + ((+ext[1] / EMU) / 13.333 * 100).toFixed(0) + '%'
  }
  const body = s.match(/name="Body"[\s\S]{0,220}?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)
  const bodyBox = body ? 'x=' + (+body[1] / EMU).toFixed(2) + ' w=' + (+body[3] / EMU).toFixed(2) : 'none'
  console.log(f.padEnd(14) + ' img[' + img.padEnd(26) + ']  body[' + bodyBox + ']')
}

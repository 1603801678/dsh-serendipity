// Assert the inline-emphasis feature end to end (HTML + JSON manifest).
import { readFileSync } from 'node:fs'
const base = process.argv[2]
const html = readFileSync(base + '.html', 'utf8')
const doc = JSON.parse(readFileSync(base + '.json', 'utf8'))
const checks = []
const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

// 1) HTML must render real <strong> and .hl spans, not escape them
add('HTML renders <strong> for **bold**', html.includes('<strong>关键短语</strong>'))
add('HTML renders .hl span for ==accent==', html.includes('<span class="hl">真正要记住的</span>'))
add('HTML renders title runs', html.includes('<strong>加粗</strong>与<span class="hl">标红</span>'))
add('HTML renders table cell bold', /<td[^>]*><strong>#C00000<\/strong>/.test(html))
add('HTML renders table cell accent', /<td[^>]*><span class="hl">#FFFFFF<\/span>/.test(html))
add('HTML renders statement text runs', html.includes('改变问题定义'))
add('HTML has .hl style rule', html.includes('.hl{color:var(--accent)'))
add('HTML escapes injected tag (no real <b>)', !html.includes('<b>标签</b>'))
add('injected tag stripped from text', html.includes('应剥掉的 标签'))

// 2) markers must never leak into visible text
const leaked = /(^|>)[^<]*(==|\*\*)[^<]*(<|$)/.test(html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, ''))
add('no ** or == leaked into rendered text', !leaked)

// 3) manifest stores clean plain text + runs
const slides = doc.slides
const s0 = slides[0]
add('manifest title is marker-free', s0.title === '正文里的加粗与标红', JSON.stringify(s0.title))
add('manifest keeps titleRuns', Array.isArray(s0.titleRuns) && s0.titleRuns.some(r => r.bold) && s0.titleRuns.some(r => r.accent), JSON.stringify(s0.titleRuns))
add('manifest bullet is marker-free', s0.bullets[1] === '这句里的关键短语加粗了', JSON.stringify(s0.bullets[1]))
add('manifest keeps bulletRuns', Array.isArray(s0.bulletRuns) && s0.bulletRuns[1]?.[1]?.bold === true, JSON.stringify(s0.bulletRuns?.[1]))
add('plain bullets have null runs slot', s0.bulletRuns[0] === null)
add('table cells marker-free', slides[1].rows[1][1] === '#FFFFFF' && slides[1].rows[3][1] === '#C00000')
add('statement textRuns kept', Array.isArray(slides[3].textRuns) && slides[3].textRuns.some(r => r.accent))
// 4) slides without markup must carry no runs at all (old path preserved)
const s2 = slides[2]
add('slide without markup has no *Runs keys', !s2.titleRuns && !s2.bulletRuns, JSON.stringify(Object.keys(s2)))

let bad = 0
for (const c of checks) { if (!c.ok) bad++; console.log((c.ok ? 'OK   ' : 'FAIL ') + c.name + (c.ok ? '' : '  — ' + c.detail)) }
console.log(bad ? '\n' + bad + ' FAILED' : '\nall ' + checks.length + ' checks passed')
process.exitCode = bad ? 1 : 0

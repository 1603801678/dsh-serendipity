import { scenarioHtml, SCENARIO_NAMES } from './scenario-template.mjs'
let bad = 0
for (const name of SCENARIO_NAMES) {
  const h = scenarioHtml(name)
  const problems = []
  if (h.includes('font-size:font-size')) problems.push('doubled font-size property')
  if (!/\.e\{[^}]*font-size:\d+px/.test(h)) problems.push('.e has no valid font-size')
  if (/style="font-size:[^"]*pxpx/.test(h)) problems.push('pxpx')
  if (problems.length) { bad++; console.log('FAIL ' + name + ': ' + problems.join(', ')) }
  else console.log('OK   ' + name)
}
const css = scenarioHtml('cover-hero').slice(scenarioHtml('cover-hero').indexOf('<style>') + 7, scenarioHtml('cover-hero').indexOf('</style>'))
console.log('\n--- CSS head ---')
console.log(css.split('\n').slice(1, 9).join('\n'))
console.log(bad ? '\n' + bad + ' FAILED' : '\ntemplate OK')
process.exitCode = bad ? 1 : 0

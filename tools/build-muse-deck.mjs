// 重建「缪斯」项目演示文稿：白底朴素风格 + 情境图 + 内联强调 + 图表。
//
//   node tools/build-muse-deck.mjs
//
// 会重建三件套到仓库的「演示/」目录（该目录不进版本库，见 .gitignore；覆盖前自动备份一次）。
// 依赖：`dsh-ppt` 的 CLI（走新进程，因此用得到本地补丁）；Inkscape（流程图）；
//      py -3.14（图表）；Edge（情境图截图）。
import { execFileSync } from 'node:child_process'
import { existsSync, copyFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = resolve(ROOT, '演示') // 演示产物集中在这里，不进版本库
const ASSETS = resolve(DEMO, 'assets/muse')
const PPT = process.env.DSH_PPT_DIR || 'C:/Users/417/.dsh/profiles/web/node_modules/dsh-ppt'
const CLI = resolve(PPT, 'skills/dsh-ppt/scripts/build-deck.mjs')
const NAME = 'dsh-serendipity-缪斯'

const step = (msg) => console.log('\n=== ' + msg + ' ===')
const run = (cmd, args, opts = {}) => {
  const out = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
  if (out.trim()) console.log(out.trim())
  return out
}

// 1) 情境图（真实彩色 emoji，浏览器渲染后截图）
step('情境图（emoji + 箭头，浏览器截图）')
run(process.execPath, [resolve(ROOT, 'tools/build-scenario-images.mjs'), ASSETS])

// 2) 结果图表（matplotlib，数据来自插件 HTTP 接口）
step('结果图表（matplotlib）')
const chartPy = resolve(ROOT, 'tools/gen-metrics-chart.py')
if (existsSync(chartPy)) run('py', ['-3.14', chartPy], { env: process.env, cwd: ROOT })

// 3) 流程示意图（手写 SVG → Inkscape 导出 PNG）
step('流程示意图（Inkscape）')
const svg = resolve(ASSETS, 'loop-diagram.svg')
if (existsSync(svg)) run('inkscape', ['--export-type=png', `--export-filename=${resolve(ASSETS, 'loop-diagram.png')}`, '--export-width=2560', svg])

// 4) 备份现有三件套
step('备份现有三件套')
mkdirSync(DEMO, { recursive: true })
for (const ext of ['html', 'pptx', 'json']) {
  const src = resolve(DEMO, `${NAME}.${ext}`)
  if (existsSync(src)) { copyFileSync(src, src + '.bak-before-white-restyle'); console.log('backed up ' + ext) }
}

// 5) 生成三件套（白底 + 品牌 + soft 主题）
step('生成三件套')
const brand = {
  primaryColor: '#C00000',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  fontFamily: 'Microsoft YaHei',
  name: '缪斯 dsh-serendipity',
}
const brandFile = resolve(ASSETS, '_brand.json')
const slidesFile = resolve(ASSETS, 'deck-slides.json')
writeFileSync(brandFile, JSON.stringify(brand, null, 2), 'utf8')
run(process.execPath, [
  CLI,
  '--title', '缪斯 dsh-serendipity 项目演示',
  '--slides', '@' + slidesFile,
  '--brand', '@' + brandFile,
  '--theme', 'soft',
  '--lang', 'zh',
  '--out', DEMO,
  '--overwrite',
])

// 6) CLI 会把产物写在 --out 目录下、命名为 deck.*，这里重命名并清掉临时件
step('重命名产物')
for (const ext of ['html', 'pptx', 'json']) {
  const from = resolve(DEMO, 'deck.' + ext)
  if (!existsSync(from)) { console.log('MISSING deck.' + ext + ' — 生成可能失败'); continue }
  renameSync(from, resolve(DEMO, `${NAME}.${ext}`))
  console.log('renamed deck.' + ext + ' -> ' + `${NAME}.${ext}`)
}

console.log('\n完成。产物：')
for (const ext of ['html', 'pptx', 'json']) console.log('  ' + resolve(DEMO, `${NAME}.${ext}`))

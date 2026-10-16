// 清理验证脚本写进真实状态目录的「（验证记录）」条目。
//
// 背景：tools/verify-note-path.mjs 为了证明落盘链路是通的，会往真实项目记录里补几条
// note（note 文本带「（验证记录）」前缀）。它们本身是合法记录，但会污染两处：
//   1. 「当时没找到落点，值得再看一眼的」——它们是验证噪音，不该占用这个位置；
//   2. stats.json 的 noted / landed / selfReportedHits / transformations 计数。
//
// 这个脚本把带该标记的条目删掉，并把计数按「每条的平均贡献」回退。
// 默认只预览（dry-run），加 --apply 才真正写盘；写盘前自动备份。
//
//   node tools/cleanup-verify-records.mjs            # 预览
//   node tools/cleanup-verify-records.mjs --apply    # 执行
import { copyFileSync, existsSync } from 'node:fs'
import { StateStore } from '../lib/store.js'

const MARKER = '（验证记录）'
const apply = process.argv.includes('--apply')
const cwd = process.argv.find(arg => arg.startsWith('--cwd='))?.slice('--cwd='.length)
  ?? 'E:\\deepseekagent\\dsh-creativity'

const store = new StateStore()
const file = store.projectFile(cwd)
if (!existsSync(file)) {
  console.log(`找不到项目记录：${file}`)
  process.exit(1)
}

const project = store.readProject(cwd)
const marked = Object.entries(project.entries)
  .filter(([, entry]) => typeof entry?.note === 'string' && entry.note.includes(MARKER))

console.log(`项目记录：${file}`)
console.log(`总条目 ${Object.keys(project.entries).length}，其中带「${MARKER}」标记的 ${marked.length} 条`)

const stats = store.readStats()
let landed = 0
let hits = 0
let transformations = 0
for (const [id, entry] of marked) {
  const isLanded = typeof entry.landed === 'string' && entry.landed.trim() !== ''
  if (isLanded) landed += 1
  if (entry.hit === true) hits += 1
  if (entry.transformation === true) transformations += 1
  console.log(`  · ${id} ${entry.label}`
    + `｜落点=${isLanded ? '有' : '无'} 自评=${entry.hit === true ? '有用' : '无用'}`
    + `｜${String(entry.note).slice(0, 30)}…`)
}

console.log('')
console.log('计数回退（删掉这些条目后应当减掉的数量）：')
console.log(`  noted            ${stats.noted} → ${Math.max(0, stats.noted - marked.length)}`)
console.log(`  landed           ${stats.landed ?? 0} → ${Math.max(0, (stats.landed ?? 0) - landed)}`)
console.log(`  selfReportedHits ${stats.selfReportedHits ?? 0} → ${Math.max(0, (stats.selfReportedHits ?? 0) - hits)}`)
console.log(`  transformations  ${stats.transformations ?? 0} → ${Math.max(0, (stats.transformations ?? 0) - transformations)}`)

if (!apply) {
  console.log('\n（预览模式，未写盘。加 --apply 执行。）')
  process.exit(0)
}

const statsFile = store.statsFile
const stamp = '.bak-before-cleanup'
copyFileSync(file, `${file}${stamp}`)
copyFileSync(statsFile, `${statsFile}${stamp}`)

for (const [id] of marked) delete project.entries[id]
const updated = {
  ...stats,
  noted: Math.max(0, stats.noted - marked.length),
  landed: Math.max(0, (stats.landed ?? 0) - landed),
  selfReportedHits: Math.max(0, (stats.selfReportedHits ?? 0) - hits),
  transformations: Math.max(0, (stats.transformations ?? 0) - transformations),
}
if (updated.landed === 0) delete updated.landed
// `hits` was the pre-rename key for `selfReportedHits`. It is read by nothing now,
// and leaving it behind means a stale number sits next to the live one.
if (updated.hits !== undefined) delete updated.hits

// 直接写盘（原子写由 store 内部保证；这里沿用同样的做法）。
const { writeFileSync, renameSync } = await import('node:fs')
const writeAtomic = (target, value) => {
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, target)
}
writeAtomic(file, project)
writeAtomic(statsFile, updated)

console.log(`\n✅ 已删除 ${marked.length} 条验证记录`)
console.log(`   备份：${file}${stamp}`)
console.log(`   备份：${statsFile}${stamp}`)

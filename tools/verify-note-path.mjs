// 验证脚本：用插件自己的代码，对真实的用户状态目录跑一次 note 写入路径。
// 目的：确认「serendipity_note → 落盘 → 统计更新」这条链在重启后的真实环境里是通的。
// 这是只增不删的验证：给一条真实抽过的素材补上记录，并核对文件内容。
import { StateStore } from '../lib/store.js'
import { loadCorpus } from '../lib/corpus.js'

const cwd = 'E:\\deepseekagent\\dsh-creativity'
const store = new StateStore()
const corpus = loadCorpus(undefined)

const before = store.readStats()
const project = store.readProject(cwd)
const entries = Object.values(project.entries)
console.log(`写入前：draws=${before.draws} itemsServed=${before.itemsServed} noted=${before.noted}`
  + ` landed=${before.landed ?? 0} 自评有用=${before.selfReportedHits ?? 0}`)
console.log(`项目记录：${entries.length} 条，其中已记录 ${entries.filter(e => e.notedAt !== undefined).length} 条`)
// 真实数据里有多少条缺 structureTags？缺了就只能按类别学，学不到「哪种结构有用」。
const withoutTags = entries.filter(e => !Array.isArray(e.structureTags) || e.structureTags.length === 0)
console.log(`其中缺 structureTags 的：${withoutTags.length} 条`
  + (withoutTags.length === 0 ? '' : '（这些条目只能提供类别信号）'))

// 挑一条**还没记录过**、且能解析到语料的素材（这样 structureTags 能带出来）。
// 只挑未记录的，脚本才可重复运行：否则第二次跑时统计不会再增长，断言会误报。
// 注意：素材 id 是 entries 的**键**，不是条目里的字段。
const targetId = Object.keys(project.entries)
  .find(id => corpus.byId.has(id) && project.entries[id]?.notedAt === undefined)
if (targetId === undefined) {
  console.log('❌ 项目记录里找不到「未记录且可解析」的素材，无法验证')
  process.exit(1)
}
const target = { id: targetId, ...project.entries[targetId] }
console.log(`\n验证目标：id=${target.id} label=「${target.label}」`)

const beforeEntry = { ...target }
const outcome = store.recordNotes(cwd, [{
  id: target.id,
  hit: true,
  note: '（验证记录）用于确认 note 落盘链路：把素材的结构映射到当前工作上。',
  transformation: true,
  landed: '（验证记录）本文件 tools/verify-note-path.mjs',
}], corpus.byId)

console.log(`\nrecordNotes 结果：accepted=${outcome.accepted} unknown=${JSON.stringify(outcome.unknown)}`)

// 重新从磁盘读取，确认真的落盘了（而不是只在内存里）。
const after = store.readStats()
const afterProject = store.readProject(cwd)
const afterEntry = afterProject.entries[target.id]

const checks = [
  ['stats.noted 增加', after.noted === before.noted + 1, `${before.noted} → ${after.noted}`],
  ['stats.landed 增加（被计入的那一个信号）', (after.landed ?? 0) === (before.landed ?? 0) + 1,
    `${before.landed ?? 0} → ${after.landed ?? 0}`],
  ['stats.selfReportedHits 增加（只记录、不计入权重）',
    (after.selfReportedHits ?? 0) === (before.selfReportedHits ?? 0) + 1,
    `${before.selfReportedHits ?? 0} → ${after.selfReportedHits ?? 0}`],
  ['entries 条目带 notedAt', afterEntry.notedAt !== undefined, String(afterEntry.notedAt)],
  ['entries 条目带 hit=true', afterEntry.hit === true, String(afterEntry.hit)],
  ['entries 条目带 transformation', afterEntry.transformation === true, String(afterEntry.transformation)],
  ['entries 条目带 landed 落点', typeof afterEntry.landed === 'string' && afterEntry.landed.length > 0, afterEntry.landed],
  ['entries 条目带 note 文本', typeof afterEntry.note === 'string' && afterEntry.note.length > 0, afterEntry.note],
  ['structureTags 已落盘（覆盖度学习需要它）', Array.isArray(afterEntry.structureTags) && afterEntry.structureTags.length > 0, JSON.stringify(afterEntry.structureTags)],
  ['重读的条数与写入前一致', Object.keys(afterProject.entries).length === entries.length, `${entries.length} → ${Object.keys(afterProject.entries).length}`],
]

console.log('')
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${name}：${detail}`)
  if (!ok) failed += 1
}

// 有效性视图现在应该能看到这条样本（虽然仍低于 15 条的证据门槛）。
// 它统计的是**覆盖度**：读了多少、其中多少条有落点；自评有用只显示、不进权重。
const { DrawEngine } = await import('../lib/draw.js')
const engine = new DrawEngine({ materials: corpus.materials, byId: corpus.byId, store })
const report = engine.effectivenessFor(cwd).report
console.log(`\n有效性视图：整体已读 ${report.overall.read} 条、其中 ${report.overall.landed} 条有落点、`
  + `${report.overall.selfReportedHits} 条自评有用（不计入权重）、已覆盖 ${report.readOrigins} 个来源领域`)
const row = report.categories.find(entry => entry.key === afterEntry.category)
console.log(`  ${afterEntry.category} → 已读 ${row.read} 次、落点 ${row.landed} 次，权重 ×${row.multiplier.toFixed(2)}（${row.note}）`)

console.log(failed === 0 ? '\n✅ note 落盘链路验证通过' : `\n❌ ${failed} 项未通过`)
console.log('（验证写入了一条标记为「（验证记录）」的 note，可用 .bak-before-verify 备份还原）')
process.exit(failed === 0 ? 0 : 1)

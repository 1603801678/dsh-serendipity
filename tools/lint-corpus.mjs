#!/usr/bin/env node
/**
 * 语料质量体检：把「凭手感维护的散文素材库」变成可自动检查的东西。
 *
 * 用法：
 *   node tools/lint-corpus.mjs            # 只报告
 *   node tools/lint-corpus.mjs --strict   # 有 FAIL 时以非零码退出（供 CI / 提交前使用）
 *
 * 检查项（FAIL = 违反硬规则，WARN = 可能退化的信号）：
 *
 * FAIL
 *   - 条目字段缺失/过短（与 lib/corpus.js 的校验一致）
 *   - `bridge` 不是问句或祈使句（桥接提示的存在意义就是逼人做关系对齐）
 *   - `bridge` / `summary` 相互重复（同一段话被复制到多个条目）
 *   - `structureTags` 用了受控词表之外的标签（会导致跨域检索与去重失效）
 *   - id 重复
 *
 * WARN
 *   - `detail` 看不出机制语汇（多半只是在陈述事实，需人工确认）
 *   - 分类/来源领域覆盖失衡（抽取时同一领域最多出 2 条，会互相挤掉）
 *   - `summary` 太长、`detail` 太短
 *   - 结构核心过于分散
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CATEGORIES, CATEGORY_NAMES, loadCorpus } from '../lib/corpus.js'
import { CONTROLLED, toControlled } from '../lib/structure-tags.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '..', 'lib', 'corpus')

/**
 * 机制性标记。
 *
 * 只用来提示「这段文字可能只是在陈述事实、没有讲清为什么」——判断是否真的讲了机理
 * 需要人读，所以命中不了这些标记只报 WARN，不报 FAIL。
 */
const MECHANISM_MARKERS = [
  // 因果与推论
  '因为', '所以', '于是', '导致', '使得', '因此', '从而', '反过来', '结果是', '由此',
  '说明', '意味着', '推论', '关键在于', '之所以', '正是', '就会', '才能', '会给出',
  '决定了', '归因', '本质上', '取决于',
  // 机制语汇
  '机制', '原理', '过程', '作用', '效应', '规律', '逻辑', '条件', '代价',
  '阈值', '延迟', '反馈', '梯度', '速率', '比例', '倍数', '频率',
  '越大', '越小', '越多', '越少', '过高', '过低', '不足', '太过',
  '超线性', '亚线性', '线性', '非单调', '单调', '饱和', '收敛', '发散',
  // 定义式与依存式表述
  '是指', '指的是', '靠的是', '依靠', '依赖', '需要', '来自', '源于',
  '构成', '形成', '建立', '分离', '隔离', '替代', '补偿', '衡量', '量化',
  '足够', '不再', '无法', '不能', '只有', '只要', '除非',
  // 解释性动词（「说明了」「暴露出」「转化为」这类也是在讲机制）
  '会暴露', '暴露', '转化为', '会带来', '会使得', '会变得', '源于', '根子', '症结',
  '要点是', '核心是', '这解释了', '解释', '差别', '区别', '不同于', '相当于',
]

/** bridge 必须是问句或祈使句。 */
const QUESTION_MARKERS = ['？', '?', '能不能', '有没有', '是否', '哪', '什么', '怎么', '多少']
const IMPERATIVE_MARKERS = ['请', '试', '把它', '把那个', '先', '去测', '换一个', '挑一个', '列', '写下', '假设', '检查', '不要', '分别']

const failures = []
const warnings = []

/** 判断文本是否像问句/祈使句。 */
function looksLikePrompt(text) {
  if (QUESTION_MARKERS.some(marker => text.includes(marker))) return true
  return IMPERATIVE_MARKERS.some(marker => text.startsWith(marker) || text.includes(marker))
}

/** 判断 detail 是否在讲机制。 */
function looksMechanistic(text) {
  if (/[0-9]/.test(text)) return true
  return MECHANISM_MARKERS.some(marker => text.includes(marker))
}

const corpus = loadCorpus(undefined)
for (const problem of corpus.problems) failures.push(`语料加载：${problem}`)

const files = readdirSync(corpusDir).filter(name => name.endsWith('.json')).sort()
if (files.length !== CATEGORIES.length) {
  failures.push(`语料文件数 ${files.length} 与分类数 ${CATEGORIES.length} 不一致（缺文件会让该类别整类消失）`)
}

const seenIds = new Map()
const seenBridges = new Map()
const seenSummaries = new Map()
const originCount = new Map()
const tagCount = new Map()
const unmappedTags = new Set()

for (const material of corpus.materials) {
  const where = `${material.category}/「${material.label}」`

  if (seenIds.has(material.id)) failures.push(`${where}: id 与「${seenIds.get(material.id)}」重复`)
  seenIds.set(material.id, material.label)

  if (!looksLikePrompt(material.bridge)) {
    failures.push(`${where}: bridge 不是问句或祈使句 —— ${material.bridge}`)
  }
  if (!looksMechanistic(material.detail)) {
    warnings.push(`${where}: detail 看不出机制语汇，请人工确认它讲的是「为什么」而不只是「是什么」`)
  }
  if (material.summary.length > 60) {
    warnings.push(`${where}: summary ${material.summary.length} 字，偏长（一句话讲清即可）`)
  }
  if (material.detail.length < 60) {
    warnings.push(`${where}: detail ${material.detail.length} 字，偏短（机理容易讲不透）`)
  }

  for (const tag of material.structureTags) {
    const controlled = toControlled(tag)
    if (controlled === undefined) unmappedTags.add(tag)
    else tagCount.set(controlled, (tagCount.get(controlled) ?? 0) + 1)
  }

  // 复制粘贴检测：完全相同的 bridge/summary 多半是复制后忘改。
  if (seenBridges.has(material.bridge)) failures.push(`${where}: bridge 与「${seenBridges.get(material.bridge)}」完全相同`)
  else seenBridges.set(material.bridge, material.label)
  if (seenSummaries.has(material.summary)) failures.push(`${where}: summary 与「${seenSummaries.get(material.summary)}」完全相同`)
  else seenSummaries.set(material.summary, material.label)

  originCount.set(material.origin, (originCount.get(material.origin) ?? 0) + 1)
}

if (unmappedTags.size > 0) {
  failures.push(`结构标签未归一到受控核心（会破坏跨域检索与去重）：${[...unmappedTags].sort().join('、')} —— 请在 lib/structure-tags.mjs 的 TAG_ALIASES 里补映射`)
}

const unusedControls = CONTROLLED.filter(tag => !tagCount.has(tag))
if (unusedControls.length > CONTROLLED.length * 0.35) {
  warnings.push(`受控核心里有 ${unusedControls.length}/${CONTROLLED.length} 个从未被使用，词表可能过度设计：${unusedControls.join('、')}`)
}

for (const category of CATEGORIES) {
  const count = corpus.materials.filter(material => material.category === category).length
  if (count === 0) failures.push(`分类 ${category}（${CATEGORY_NAMES[category]}）没有任何素材`)
  else if (count < 10) warnings.push(`分类 ${category}（${CATEGORY_NAMES[category]}）只有 ${count} 条，偏少`)
}

for (const [origin, count] of originCount.entries()) {
  if (count >= 4) warnings.push(`来源领域「${origin}」有 ${count} 条，占比偏高（抽取时同一领域最多出 2 条，其余会被挤掉）`)
}

// 远距离类比的前提是「来源领域真的各不相同」：origin 是抽取时判断「远不远」的唯一依据，
// 所以领域重复率是一个应该被监控的质量指标，而不是随手写的东西。
// 实测：把「日常厨房」这类泛称收敛成真正的来源领域后，107 → 114 个独立领域（115 条素材）。
const distinctOrigins = originCount.size
const originRatio = distinctOrigins / corpus.materials.length
if (originRatio < 0.85) {
  warnings.push(`来源领域重复率偏高：${corpus.materials.length} 条素材只有 ${distinctOrigins} 个不同领域`
    + `（比值 ${originRatio.toFixed(2)}，建议 ≥0.85）—— origin 越重复，「远距离」信号越弱`)
}
const vagueOrigins = [...originCount.keys()].filter(origin => origin.replace(/[（）()/\s·、]/g, '').length <= 2)
if (vagueOrigins.length > 0) {
  warnings.push(`来源领域名过泛（≤2 字，无法提供「远」的信号）：${vagueOrigins.join('、')}`)
}

const rareTags = [...tagCount.entries()].filter(([, count]) => count === 1).map(([tag]) => tag)
if (rareTags.length > tagCount.size * 0.4) {
  warnings.push(`结构核心过于分散：${rareTags.length}/${tagCount.size} 个核心只被用过一次，跨域检索的骨架会变弱`)
}

const lines = []
lines.push(`素材总数：${corpus.materials.length}`)
lines.push(`分类分布：${CATEGORIES.map(c => `${CATEGORY_NAMES[c]} ${corpus.countsByCategory[c]}`).join('｜')}`)
lines.push(`来源领域：${originCount.size} 个｜受控结构核心：${tagCount.size}/${CONTROLLED.length} 个被用到`)
lines.push('')
lines.push(failures.length === 0 ? '✅ FAIL: 无' : `❌ FAIL ${failures.length} 项：`)
for (const failure of failures) lines.push(`   - ${failure}`)
lines.push(warnings.length === 0 ? '✅ WARN: 无' : `⚠️  WARN ${warnings.length} 项：`)
for (const warning of warnings) lines.push(`   - ${warning}`)
process.stdout.write(lines.join('\n') + '\n')

if (process.argv.includes('--strict') && failures.length > 0) process.exitCode = 1

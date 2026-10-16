#!/usr/bin/env node
/**
 * Set this plugin's configuration without hand-editing YAML.
 *
 * **Where the config lives changed in dsh 0.2.0.** The old `~/.dsh/settings.yaml`
 * document is gone: the harness renames it to `settings.yaml.imported` on boot and
 * migrates its sections into profile *entries*. A plugin's editable config is now
 * the `config:` block of its own entry in the profile patch —
 * `~/.dsh/profiles/<profile>/cordis.patch.yml`:
 *
 *   - id: serendipity
 *     config:
 *       drawMode: "onRequest"
 *
 * The plugin declares that entry's schema (`lib/index.js` exports `Config` with
 * `.volatile()` fields), which is also what puts it in the Web settings page and
 * what makes the browser card's saves go through the settings service.
 *
 * This tool edits **only that entry's `config:` block** and leaves every other
 * entry, comment and `!!js` expression in the file byte-for-byte. No YAML library
 * is available on this host, so the surgery is line-based and the result is
 * re-read and validated before the write is allowed to happen.
 *
 * Usage:
 *   node tools/set-config.mjs --show
 *   node tools/set-config.mjs drawMode=onRequest
 *   node tools/set-config.mjs --profile web enabled=false sessionReport=false
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The loader entry this plugin is inserted as (see cordis.patch.yml). */
const ENTRY_ID = 'serendipity'
const DRAW_MODES = ['off', 'onRequest', 'autonomous']
const BOOLEANS = ['enabled', 'announceToAgent', 'serveRoutes', 'sessionReport']
const KNOWN = ['drawMode', ...BOOLEANS]

/** The dsh home, honouring an explicit override. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Where a profile's composition patch lives. */
function patchPath(profile) {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/** Coerce one `key=value` assignment into the typed value the schema expects. */
function coerce(key, raw) {
  if (!KNOWN.includes(key)) throw new Error(`未知配置项「${key}」，可用：${KNOWN.join(' / ')}`)
  if (key === 'drawMode') {
    if (!DRAW_MODES.includes(raw)) throw new Error(`drawMode 只能是 ${DRAW_MODES.join(' / ')}，收到 ${raw}`)
    return raw
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${key} 只能是 true 或 false，收到 ${raw}`)
}

/** Render one scalar the way YAML/cordis reads it back unchanged. */
function scalar(value) {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

/** Unquote one scalar read back out of the document. */
function unquote(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/** The 0-based index of the line starting this entry, or -1. */
function entryStart(lines, id) {
  return lines.findIndex((line) => {
    const match = /^-\s+id:\s*(.+?)\s*$/.exec(line)
    return match !== null && unquote(match[1]) === id
  })
}

/**
 * The entry's `config:` block, as `{ start, end }`.
 *
 * `start` is the `config:` line (whatever follows it on that line is replaced),
 * `end` the first line after the block: the block is the run of lines indented
 * deeper than the entry's own keys, minus the blank lines that separate entries.
 *
 * @param {string[]} lines - the document.
 * @param {number} from - the entry's `- id:` line index.
 * @returns {{ start: number, end: number } | undefined} the range, absent when the entry has no config.
 */
function configRange(lines, from) {
  let start = -1
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break
    if (/^ {2}config:/.test(line)) { start = i; break }
  }
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') { end += 1; continue }
    if (/^ {4}/.test(line)) { end += 1; continue }
    break
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

/** Read the entry's config, or `{}` when the entry (or its block) is absent. */
function readEntryConfig(lines, from) {
  if (from < 0) return {}
  const range = configRange(lines, from)
  if (range === undefined) return {}
  const config = {}
  for (let i = range.start + 1; i < range.end; i++) {
    const match = /^ {4}([A-Za-z][\w]*):\s*(.*?)\s*$/.exec(lines[i])
    if (match !== null) config[match[1]] = unquote(match[2])
  }
  return config
}

/**
 * Set the entry's config block, creating the entry when it is missing.
 *
 * @param {string} text - the current document.
 * @param {object} config - the complete config to write for this entry.
 * @returns {string} the new document.
 */
function writeEntryConfig(text, config) {
  const lines = text.split('\n')
  const from = entryStart(lines, ENTRY_ID)
  const block = [
    `  config:`,
    ...Object.entries(config).map(([key, value]) => `    ${key}: ${scalar(value)}`),
  ]

  if (from < 0) {
    // An empty patch document is literally `[]`; drop it before appending an item.
    const kept = lines.filter(line => line.trim() !== '[]')
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
    const entry = [`- id: ${ENTRY_ID}`, ...block]
    return [...kept, ...(kept.length > 0 ? [''] : []), ...entry, ''].join('\n')
  }

  const range = configRange(lines, from)
  if (range !== undefined) {
    return [...lines.slice(0, range.start), ...block, ...lines.slice(range.end)].join('\n')
  }

  // The entry exists without a config block: insert one after its last own key.
  let insert = from + 1
  while (insert < lines.length && /^ {2}\S/.test(lines[insert])) insert += 1
  return [...lines.slice(0, insert), ...block, ...lines.slice(insert)].join('\n')
}

/** Parse argv. */
function parseArgs(argv) {
  const assignments = []
  let profile = process.env.DSH_PROFILE ?? 'web'
  let show = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--show') show = true
    else if (arg === '--profile') profile = argv[++i]
    else if (arg === '--settings') {
      throw new Error('dsh 0.2.0 起不再有 ~/.dsh/settings.yaml：配置写在 profile 的 cordis.patch.yml 里，'
        + '本工具默认就写那里，去掉 --settings 即可')
    } else if (arg === '--patch') {
      // Kept as a no-op alias: this used to mean "the composition layer".
      continue
    } else if (arg.includes('=')) {
      const index = arg.indexOf('=')
      assignments.push([arg.slice(0, index), arg.slice(index + 1)])
    } else throw new Error(`无法识别的参数：${arg}`)
  }
  return { assignments, profile, show }
}

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`❌ ${error.message}`)
  process.exit(1)
}
const { assignments, profile, show } = parsed
const file = patchPath(profile)

if (show) {
  const exists = existsSync(file)
  const lines = exists ? readFileSync(file, 'utf8').split('\n') : []
  const config = readEntryConfig(lines, entryStart(lines, ENTRY_ID))
  console.log(file)
  console.log(exists ? '' : '  （文件不存在）')
  console.log(Object.keys(config).length === 0
    ? `  （没有 ${ENTRY_ID} 条目的 config：插件正在用 Config 里声明的默认值）`
    : Object.entries(config).map(([key, value]) => `  ${key}: ${value}`).join('\n'))
  process.exit(0)
}

if (assignments.length === 0) {
  console.log('用法：node tools/set-config.mjs [--profile web] <key>=<value> ...')
  console.log('  例：node tools/set-config.mjs drawMode=onRequest')
  console.log(`  可用项：${KNOWN.join(' / ')}`)
  console.log('  --show 只打印当前配置')
  process.exit(1)
}

let patch
try {
  patch = {}
  for (const [key, raw] of assignments) patch[key] = coerce(key, raw)
} catch (error) {
  console.error(`❌ ${error.message}`)
  process.exit(1)
}

const text = existsSync(file) ? readFileSync(file, 'utf8') : '[]\n'
const lines = text.split('\n')
const from = entryStart(lines, ENTRY_ID)
const merged = { ...readEntryConfig(lines, from), ...patch }
const next = writeEntryConfig(text, merged)

// Validate before writing: re-read what we are about to persist and confirm the
// entry round-trips, so a formatting bug cannot corrupt the rest of the file.
const after = next.split('\n')
for (const [key, value] of Object.entries(merged)) {
  const read = readEntryConfig(after, entryStart(after, ENTRY_ID))[key]
  if (read !== value) throw new Error(`写入前校验失败：${key} 期望 ${value}，回读得到 ${read}`)
}
// Every other entry must still be there.
for (const line of lines) {
  const match = /^-\s+id:\s*(.+?)\s*$/.exec(line)
  if (match === null) continue
  const id = unquote(match[1])
  if (id !== ENTRY_ID && entryStart(after, id) < 0) throw new Error(`写入前校验失败：条目 ${id} 丢了`)
}

if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
if (existsSync(file)) copyFileSync(file, `${file}.bak-before-set-config`)
const temp = `${file}.${process.pid}.tmp`
writeFileSync(temp, next, 'utf8')
renameSync(temp, file)

console.log(`✅ 已写入 ${file}`)
console.log(`   ${ENTRY_ID}: ${JSON.stringify(merged)}`)
console.log('   这一层是 profile 的组合配置，由设置服务在提交时改写；通常无需重启（volatile 字段就地生效）。')

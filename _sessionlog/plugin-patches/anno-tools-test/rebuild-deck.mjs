// Rebuild an existing dsh-ppt project's HTML/PPTX/JSON from its own content,
// WITHOUT re-authoring it — used to inject the new player build after a plugin patch.
//
//   node rebuild-deck.mjs <deck.json> [--dry]
//
// Content (slides/theme/lang/motion/title) is taken verbatim from the project file.
// The project's own history/revision is reset by this path; that is called out in the output.
import { readFileSync } from 'node:fs'
import { resolve, basename, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = process.env.DSH_PPT_DIR || 'C:/Users/417/.dsh/profiles/web/node_modules/dsh-ppt'
const { buildDeckAsync } = await import(pathToFileURL(PLUGIN + '/skills/dsh-ppt/scripts/deck-advanced.mjs').href)

const deckPath = process.argv[2]
const dry = process.argv.includes('--dry')
if (!deckPath) { console.error('usage: node rebuild-deck.mjs <deck.json> [--dry]'); process.exit(2) }

const abs = resolve(deckPath)
const doc = JSON.parse(readFileSync(abs, 'utf8'))
if (!doc || !Array.isArray(doc.slides) || !doc.slides.length) { console.error('not a dsh-ppt project: ' + abs); process.exit(1) }

const outputDir = resolve(abs, '..')
const fileName = basename(abs, extname(abs))
console.log('project   : ' + abs)
console.log('title     : ' + doc.title)
console.log('slides    : ' + doc.slides.length + '  (theme=' + doc.theme + ', lang=' + doc.language + ', motion=' + doc.motion + ')')
console.log('history   : ' + (doc.history?.length ?? 0) + ' entries, revision=' + (doc.revision ?? 0) + ' -> reset by this path')
console.log('output    : ' + outputDir + '\\' + fileName + '.{html,pptx,json}')
if (dry) { console.log('dry run: nothing written'); process.exit(0) }

const result = await buildDeckAsync({
  title: doc.title,
  theme: doc.theme,
  lang: doc.language,
  motion: doc.motion !== false,
  slides: doc.slides,
  brand: doc.brand,
  outputDir,
  fileName,
  overwrite: true,
})

console.log('\nrebuilt:')
console.log('  html  ' + result.files.html)
console.log('  pptx  ' + result.files.pptx)
console.log('  json  ' + result.files.json)
console.log('  pages ' + result.slideCount + ', quality errors ' + (result.quality?.errorCount ?? '?'))

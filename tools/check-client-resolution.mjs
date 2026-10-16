// 模拟宿主对客户端半边的解析：从 web profile 目录解析包名与 exports["./client"]，
// 确认那个文件真的在磁盘上（宿主是按路径读文件并原样服务到 /plugins/<id>/client.js）。
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const profileRequire = createRequire('C:/Users/417/.dsh/profiles/web/package.json')
const manifestPath = profileRequire.resolve('@1603801678/dsh-serendipity/package.json')
const packageDir = dirname(manifestPath)
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

const clientExport = pkg.exports?.['./client']
const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
const full = join(packageDir, target)

console.log('插件目录      :', packageDir)
console.log('包名          :', pkg.name)
console.log('dsh.client    :', JSON.stringify(pkg.dsh?.client))
console.log('client 目标   :', target)
console.log('文件存在      :', existsSync(full) ? `✅ ${full}` : '❌ 缺失')
if (existsSync(full)) {
  console.log('文件大小      :', statSync(full).size, '字节')
  const head = readFileSync(full, 'utf8').slice(0, 80).replace(/\n/g, ' ')
  console.log('开头          :', head)
  console.log('会被服务到    :', `/plugins/${pkg.name}/client.js`)
}

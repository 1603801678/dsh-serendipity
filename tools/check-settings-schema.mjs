// 验证插件导出的 Config 本身是否符合 dsh 0.2.0 的设置契约：
// 五个字段都在、都可编辑（.volatile()）、默认值正确，且解析结果是活引用（{ get() }）。
// 真实的 GUI 表单只能人工看，但 schema 的正确性可以在这里先钉住。
import { Config } from '../lib/index.js'

if (Config === undefined) {
  console.log('❌ Config 没有导出 —— 设置页里不会有任何可编辑字段')
  process.exit(1)
}

const resolved = Config({})
console.log('字段：', Object.keys(resolved).join(' / '))
for (const [key, node] of Object.entries(Config.dict)) {
  const volatile = node.meta?.volatile === true
  const value = resolved[key]
  const live = typeof value?.get === 'function'
  console.log(`${volatile && live ? '✅' : '❌'} ${key}: volatile=${volatile} 活引用=${live} 默认值=${JSON.stringify(live ? value.get() : value)}`)
  if (node.meta?.volatile !== true || !live) process.exitCode = 1
}

// 用户覆盖必须能落到引用上，且引用本身是可被设置服务就地改写的形状。
const overridden = Config({ drawMode: 'onRequest' })
console.log(`覆盖 drawMode=onRequest → ${overridden.drawMode.get()}`)
if (overridden.drawMode.get() !== 'onRequest') process.exitCode = 1

// 类型约束由 schema 把住；域内取值由插件自己的校验把住（drawMode 是 string）。
for (const [input, shouldPass] of [
  [{ drawMode: 'autonomous' }, true],
  [{ drawMode: 'nonsense' }, true], // 字符串类型不拒绝任意值——由插件的写入口校验兜住
  [{ drawMode: 123 }, false],
  [{ enabled: 'yes' }, false],
]) {
  let passed = true
  let detail = ''
  try {
    detail = JSON.stringify(Config(input).drawMode.get())
  } catch (error) {
    passed = false
    detail = error.message.split('\n')[0]
  }
  console.log(`${passed === shouldPass ? '✅' : '❌'} ${JSON.stringify(input)} → ${passed ? '通过' : '拒绝'} ${detail}`)
  if (passed !== shouldPass) process.exitCode = 1
}

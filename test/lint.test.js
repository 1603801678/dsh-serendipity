/**
 * 语料体检：把 tools/lint-corpus.mjs 纳入测试，让「素材质量退化」在 CI/提交前就暴露。
 *
 * 这里断言的是 lint 的 **FAIL** 项为零（硬规则：字段完整性、bridge 是问句、无复制粘贴、
 * 结构标签全部能归一到受控核心、id 唯一）。WARN 项只打印不断言——它是给人看的复查清单，
 * 「这段 detail 是不是没讲机理」这种判断最终要人读，不该让启发式误报把测试搞红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Run the linter and return its stdout plus exit code. */
function runLint() {
  try {
    const stdout = execFileSync(process.execPath, [join(projectRoot, 'tools', 'lint-corpus.mjs'), '--strict'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    return { stdout, code: 0 }
  } catch (error) {
    return { stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

test('lint: the corpus has no hard rule violations', () => {
  const { stdout, code } = runLint()
  assert.equal(code, 0, `lint 报出 FAIL：\n${stdout}`)
  assert.match(stdout, /✅ FAIL: 无/)
  // Guard the guard: an empty corpus would also produce "no failures".
  const total = Number(/素材总数：(\d+)/.exec(stdout)?.[1] ?? 0)
  assert.ok(total >= 100, `素材总数只有 ${total}，lint 可能没读到语料`)
})

test('lint: severity split is honest (heuristic checks warn, hard rules fail)', () => {
  const { stdout } = runLint()
  // The mechanism check is a heuristic and must stay a WARN: if it ever became a
  // FAIL it would red-light perfectly good prose.
  assert.doesNotMatch(stdout, /FAIL[^\n]*看不出机制/)
  if (stdout.includes('看不出机制语汇')) {
    assert.match(stdout, /⚠️\s+WARN/, '机制检查应归入 WARN')
  }
})

test('lint: source fields stay distinct enough for far transfer', () => {
  const { stdout } = runLint()
  const total = Number(/素材总数：(\d+)/.exec(stdout)?.[1] ?? 0)
  const origins = Number(/来源领域：(\d+) 个/.exec(stdout)?.[1] ?? 0)
  assert.ok(origins > 0, 'lint 没有报告来源领域数')
  // `origin` is the only signal that makes a material "far", so heavy repetition
  // weakens the plugin's core value. The measured ratio is ~0.99 (114/115); the
  // floor leaves headroom for a couple of legitimately related entries while
  // catching a collapse back to a handful of generic buckets.
  const ratio = origins / total
  assert.ok(ratio >= 0.85, `来源领域重复率过高：${total} 条素材只有 ${origins} 个领域（比值 ${ratio.toFixed(2)}）`)
  assert.doesNotMatch(stdout, /来源领域名过泛/, '存在过泛的来源领域名')
})

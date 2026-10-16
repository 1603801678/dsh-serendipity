/**
 * 词元的切分与重叠：判断两段文字「是不是在同一片区域」。
 *
 * 两处用到它，需求是同一个：
 *
 * - `lib/generate.js`：候选领域和本项目**已经读过的来源领域**重不重叠
 *   （「读过消防工程，就别再提『消防』」）。
 * - `lib/draw.js` 的 `collide`：一对素材的**来源距离**够不够远
 *   （同结构、异来源才叫碰撞；来源本来就挨着，那就只是又读了两条同域素材）。
 *
 * 都是粗粒度判断，都用同一个切法，所以放在这里而不是各写一份。
 *
 * ## 为什么中文切二元组而不是单字
 *
 * 单字会让「消防工程」和「工业工程」因为一个「工」字就算重叠，惩罚退化成均匀噪声；
 * 二元组只在真的像同一片区域时命中。拉丁文按词切（长度 ≥2）。
 *
 * 因此这个判断**很少触发、但触发时是对的**——不要指望它做重活，
 * 需要精确去重的地方（同一对配对不要重复抽取）应该用 id 而不是文本。
 *
 * @module @1603801678/dsh-serendipity/text
 */

/** 分隔符：中英文标点与空白都算。 */
const SEPARATORS = /[\s,，、;；/|:：()（）\[\]【】"'“”。.!！?？_-]+/

/**
 * 一段文字的词元集合。
 * @param {unknown} text - any text (non-strings are stringified; null/undefined yield nothing).
 * @returns {Set<string>} tokens — CJK bigrams and Latin words.
 */
export function tokens(text) {
  const out = new Set()
  for (const part of String(text ?? '').toLowerCase().split(SEPARATORS)) {
    if (part === '') continue
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.add(part)
      continue
    }
    const chars = [...part]
    if (chars.length === 1) {
      // 单字（如「盐」「静」）不切二元组，否则什么都不会剩下。
      out.add(part)
      continue
    }
    for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * 两段文字共享的词元数。
 * @param {unknown} a - first text.
 * @param {unknown} b - second text.
 * @returns {number} how many tokens they share (0 = no overlap).
 */
export function overlap(a, b) {
  const left = tokens(a)
  const right = tokens(b)
  let hits = 0
  for (const token of left) if (right.has(token)) hits += 1
  return hits
}

/**
 * 一组文字共同的词元集合（用于「已经读过的来源领域」这类多次比较）。
 * @param {Iterable<unknown>} texts - the texts.
 * @returns {Set<string>} the union of their tokens.
 */
export function tokenUnion(texts) {
  const set = new Set()
  for (const text of texts) for (const token of tokens(text)) set.add(token)
  return set
}

/**
 * 一个候选与一组已覆盖词元的重叠度。
 * @param {unknown} text - candidate text.
 * @param {Set<string>} covered - the covered token set (`tokenUnion` output).
 * @returns {number} how many of the candidate's tokens are already covered.
 */
export function overlapWith(text, covered) {
  let hits = 0
  for (const token of tokens(text)) if (covered.has(token)) hits += 1
  return hits
}

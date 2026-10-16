/**
 * Stable identity for corpus entries.
 *
 * A material's id must survive edits to unrelated fields, corpus reordering,
 * and the move between the shipped corpus and a user's own additions — so it is
 * derived from the two fields that define *which* material this is (its origin
 * and label), never from an array index or a counter.
 *
 * @module @1603801678/dsh-serendipity/hash
 */

/** One 32-bit FNV-1a pass over a string. */
function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Deterministic 8-hex-character id for one material.
 * @param {string} origin - the material's source field (domain or field name).
 * @param {string} label - the material's title.
 * @returns {string} a stable id such as `b3f1a907`.
 */
export function materialId(origin, label) {
  const seed = `${origin.trim()}::${label.trim()}`
  // Two salted passes widen the space; the pairing is what makes the id
  // collision-resistant enough for a few thousand entries.
  const a = fnv1a(seed).toString(16).padStart(8, '0')
  const b = fnv1a(`salt:${seed}`).toString(16).padStart(8, '0')
  return a + b
}

/**
 * Short project key derived from a working directory, used to keep one
 * project's draw history separate from another's.
 * @param {string} cwd - absolute working directory of the session.
 * @returns {string} a filesystem-safe key such as `p-1a2b3c4d-<basename>`.
 */
export function projectKey(cwd) {
  const normalized = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const base = normalized.split('/').filter(Boolean).pop() ?? 'root'
  const safeBase = base.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, '-').slice(0, 40) || 'root'
  return `p-${fnv1a(normalized).toString(16).padStart(8, '0')}-${safeBase}`
}

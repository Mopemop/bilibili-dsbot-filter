/**
 * 跨账号复读检测：把正文归一化后按 24 字滑窗求交。
 * 归一化会去掉 @提及、标点、空白、emoji 与大小写差异，所以「换标点 / 加 @」不影响命中。
 */

const SHINGLE = 24
const MENTION = /@[^\s，。,:：;；]{1,20}/g
const NON_WORD = /[^\u4e00-\u9fa5a-zA-Z0-9]+/g

export function normalizeMessage(message) {
  return String(message ?? '')
    .replace(MENTION, '')
    .replace(NON_WORD, '')
    .toLowerCase()
}

const SHINGLE_CACHE = new Map()

function shingles(text) {
  if (SHINGLE_CACHE.has(text)) return SHINGLE_CACHE.get(text)
  const out = new Set()
  if (text.length >= SHINGLE) {
    for (let i = 0; i + SHINGLE <= text.length; i += 1) out.add(text.slice(i, i + SHINGLE))
  }
  if (SHINGLE_CACHE.size > 2000) SHINGLE_CACHE.clear()
  SHINGLE_CACHE.set(text, out)
  return out
}

function intersects(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const gram of small) if (big.has(gram)) return true
  return false
}

/**
 * @param {Array<{rpid:string, mid:string, message:string}>} comments
 * @returns {{rpids:string[], sameAuthor:string[]}}
 */
export function detectDuplicate(comments) {
  const prepared = (comments ?? []).map((comment) => {
    const normalized = normalizeMessage(comment.message)
    return { ...comment, grams: shingles(normalized) }
  })

  const rpids = new Set()
  const sameAuthor = new Set()

  for (let i = 0; i < prepared.length; i += 1) {
    const a = prepared[i]
    if (!a.grams.size) continue
    for (let j = i + 1; j < prepared.length; j += 1) {
      const b = prepared[j]
      if (!b.grams.size) continue
      if (!intersects(a.grams, b.grams)) continue
      if (a.mid && a.mid === b.mid) {
        sameAuthor.add(a.rpid)
        sameAuthor.add(b.rpid)
      } else {
        rpids.add(a.rpid)
        rpids.add(b.rpid)
      }
    }
  }

  return { rpids: [...rpids], sameAuthor: [...sameAuthor] }
}

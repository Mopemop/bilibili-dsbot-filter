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

/**
 * @param {Array<{rpid:string, mid:string, message:string}>} comments
 * @returns {{rpids:string[], sameAuthor:string[]}}
 */
export function detectDuplicate(comments) {
  const rpids = new Set()
  const sameAuthor = new Set()
  // shingle → 首次出现的 {mid, rpid}；共享任意 24 字片段即视为重复，
  // 复杂度从 O(n²) 降到 O(总 shingle 数)。
  const index = new Map()

  for (const comment of comments ?? []) {
    const grams = shingles(normalizeMessage(comment.message))
    if (!grams.size) continue
    const local = new Set()
    for (const gram of grams) {
      if (local.has(gram)) continue
      local.add(gram)
      const hit = index.get(gram)
      if (!hit) {
        index.set(gram, { mid: comment.mid, rpid: comment.rpid })
        continue
      }
      if (hit.rpid === comment.rpid) continue
      if (hit.mid && hit.mid === comment.mid) {
        sameAuthor.add(hit.rpid)
        sameAuthor.add(comment.rpid)
      } else {
        rpids.add(hit.rpid)
        rpids.add(comment.rpid)
      }
    }
  }

  return { rpids: [...rpids], sameAuthor: [...sameAuthor] }
}

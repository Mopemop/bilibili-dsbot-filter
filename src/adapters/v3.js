import {
  queryDeep,
  queryDeepOne,
  findTabRow,
  observeDeep,
  normalizeUrl,
  fallbackRpid,
  triggerMore,
  isPinned,
} from './shadow.js'

const HOST = 'bili-comments'
const THREAD = 'bili-comment-thread-renderer'
const LEVEL = /level_(\d)\.svg/

/** v3 的评论对象挂在 el.__data 上（Lit 渲染数据）；找不到再退回 DOM。 */
function litData(element) {
  const nodes = [element, ...queryDeep(element, '*')]
  for (const node of nodes) {
    const data = node.__data
    if (data && data.member) return data
  }
  return null
}

function readFromData(data, element) {
  return {
    rpid: String(data.rpid_str ?? data.rpid ?? ''),
    mid: String(data.member?.mid ?? ''),
    uname: String(data.member?.uname ?? ''),
    message: String(data.content?.message ?? ''),
    faceUrl: normalizeUrl(data.member?.face ?? ''),
    level: Number(data.member?.level_info?.current_level ?? 0),
    element,
  }
}

function readFromDom(element) {
  const nameEl = queryDeepOne(element, '#user-name a')
  const contentEl = queryDeepOne(element, '#contents')
  const levelImg = queryDeepOne(element, '#user-level img')
  const avatarImg =
    queryDeepOne(element, '#avatar img') ??
    queryDeep(element, 'img').find((img) => !LEVEL.test(img.getAttribute('src') ?? ''))
  const href = nameEl?.getAttribute('href') ?? ''
  const mid = (href.match(/space\.bilibili\.com\/(\d+)/) ?? [])[1] ?? ''
  const message = (contentEl?.textContent ?? '').trim()
  return {
    rpid: fallbackRpid(element, mid, message),
    mid,
    uname: (nameEl?.textContent ?? '').trim(),
    message,
    faceUrl: normalizeUrl(avatarImg?.getAttribute('src') ?? ''),
    level: Number((levelImg?.getAttribute('src') ?? '').match(LEVEL)?.[1] ?? 0),
    element,
  }
}

export function createV3(host) {
  return {
    name: 'v3',
    root: host,
    listComments: () => queryDeep(host, THREAD),
    getSortRow: () => findTabRow(host),
    isPinned,
    readComment(element) {
      const data = litData(element)
      return data ? readFromData(data, element) : readFromDom(element)
    },
    loadMore: (options = {}) =>
      triggerMore({ root: host, items: queryDeep(host, THREAD), ...options }),
    subscribe(callback) {
      return observeDeep(host, callback)
    },
  }
}

export const v3 = {
  name: 'v3',
  match: (document) => Boolean(document.querySelector(HOST)),
  create: (document) => createV3(document.querySelector(HOST)),
}

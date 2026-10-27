import { findTabRow, observeDeep, normalizeUrl, fallbackRpid, triggerMore, isPinned } from './shadow.js'

const ROOT = '.bili-comment'

function mainComments(root) {
  return [...root.querySelectorAll('.reply-item')].filter(
    (el) => !el.closest('.sub-reply-list') && !el.classList.contains('sub-reply-item'),
  )
}

function readComment(element) {
  const nameEl = element.querySelector('.user-name, .user-info .name, a[href*="space.bilibili.com"]')
  const href = nameEl?.getAttribute('href') ?? ''
  const messageEl = element.querySelector('.reply-content, .reply-content-container, .content-wrp')
  const avatarEl = element.querySelector('img.avatar, .avatar img, .user-info img')
  const mid =
    (href.match(/space\.bilibili\.com\/(\d+)/) ?? [])[1] ??
    element.getAttribute('data-usercard-mid') ??
    ''
  const message = (messageEl?.textContent ?? '').trim()
  return {
    rpid: fallbackRpid(element, mid, message),
    mid,
    uname: (nameEl?.textContent ?? '').trim(),
    message,
    faceUrl: normalizeUrl(avatarEl?.getAttribute('src') ?? ''),
    level: 0,
    element,
  }
}

export function createV2(root) {
  return {
    name: 'v2',
    root,
    listComments: () => mainComments(root),
    getSortRow: () => findTabRow(root),
    readComment,
    isPinned,
    loadMore: () => triggerMore({ root, items: mainComments(root) }),
    subscribe(callback) {
      return observeDeep(root, callback)
    },
  }
}

export const v2 = {
  name: 'v2',
  match: (document) => Boolean(document.querySelector(ROOT)),
  create: (document) => createV2(document.querySelector(ROOT)),
}

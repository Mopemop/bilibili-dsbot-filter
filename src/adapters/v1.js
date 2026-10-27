import { findTabRow, observeDeep, normalizeUrl, fallbackRpid, triggerMore } from './shadow.js'

const ROOT = '.bb-comment'

function mainComments(root) {
  const cards = [...root.querySelectorAll('.list-item.reply-wrap, .reply-item[data-id]')]
  return cards.filter((el) => !el.closest('.reply-box'))
}

function readComment(element) {
  const nameEl = element.querySelector('.con .user .name, .user .name')
  const href = nameEl?.getAttribute('href') ?? ''
  const messageEl = element.querySelector('.con .text, .text')
  const avatarEl = element.querySelector('.con .user img, .user img')
  const mid =
    nameEl?.getAttribute('data-usercard-mid') ??
    (href.match(/space\.bilibili\.com\/(\d+)/) ?? [])[1] ??
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

export function createV1(root) {
  return {
    name: 'v1',
    root,
    listComments: () => mainComments(root),
    getSortRow: () => findTabRow(root),
    readComment,
    loadMore: () => triggerMore({ root, items: mainComments(root) }),
    subscribe(callback) {
      return observeDeep(root, callback)
    },
  }
}

export const v1 = {
  name: 'v1',
  match: (document) => Boolean(document.querySelector(ROOT)),
  create: (document) => createV1(document.querySelector(ROOT)),
}

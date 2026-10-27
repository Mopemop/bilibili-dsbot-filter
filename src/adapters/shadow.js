/** Shadow DOM 与深层查询工具：B 站新版评论区的所有节点都在多层 shadow root 里。 */

export function normalizeUrl(url) {
  const value = String(url ?? '').trim()
  if (!value) return ''
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('http://')) return value.replace(/^http:\/\//, 'https://')
  return value
}

/** 跨 shadow 边界的 querySelectorAll（去重）。 */
export function queryDeep(root, selector) {
  const out = []
  const seen = new Set()
  const visit = (node) => {
    if (!node?.querySelectorAll) return
    if (node.shadowRoot) visit(node.shadowRoot)
    if (node.nodeType === 1 && node.matches?.(selector) && !seen.has(node)) {
      seen.add(node)
      out.push(node)
    }
    for (const el of node.querySelectorAll(selector)) {
      if (seen.has(el)) continue
      seen.add(el)
      out.push(el)
    }
    for (const el of node.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot)
  }
  visit(root)
  return out
}

export function queryDeepOne(root, selector) {
  return queryDeep(root, selector)[0] ?? null
}

/**
 * 旧版 DOM 兜底时可能拿不到 rpid；用「mid + 正文哈希」生成稳定 key，
 * 否则所有评论会共用一个空 key，判定结果互相覆盖。
 */
export function fallbackRpid(element, mid, message) {
  const attr = element?.getAttribute?.('data-rpid') ?? element?.getAttribute?.('data-id') ?? ''
  if (attr) return String(attr)
  const text = String(message ?? '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return `auto-${mid || 'anon'}-${(hash >>> 0).toString(36)}`
}

/**
 * 排序行：不依赖 class，找文本恰好是「最热」「最新」的叶子节点，取它们的父节点。
 * 找不到时退回「评论」头部行。
 */
export function findTabRow(root) {
  const leaves = queryDeep(root, 'span, div, a, button, li')
  const isTab = (text) => /^(最?热|最新|热门|推荐|按时间)$/.test(text)
  const hits = leaves.filter((el) => el.children.length === 0 && isTab((el.textContent ?? '').trim()))
  if (hits.length) return hits[0].parentElement
  const header = queryDeep(root, 'div, header, section').find(
    (el) => /^评论/.test((el.textContent ?? '').trim()) && el.children.length > 0,
  )
  return header ?? null
}

const MORE_TEXT = /点击查看更多|查看更多|展开更多|加载更多|查看更多回复|更多回复/

/** 找最近的可滚动祖先（跨 shadow 边界）。 */
function nearestScrollable(element) {
  let node = element
  while (node) {
    if (node.nodeType === 1) {
      const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node)
      const overflowY = style?.overflowY ?? ''
      if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight + 20) return node
      if (node.scrollHeight > node.clientHeight + 20 && node !== node.ownerDocument?.documentElement) {
        return node
      }
    }
    node = node.parentElement ?? node.getRootNode?.()?.host ?? null
  }
  return null
}

/**
 * 触发「加载更多」，尽量不打扰用户：
 * 1) 评论区内有「点击查看更多 / 加载更多」按钮 → 直接点它（零滚动）；
 * 2) 评论列表有独立滚动容器 → 只滚这个容器到底；
 * 3) 都没有 → 只把最后一条评论滚进视野，**绝不**把整页滚到 footer。
 */
export function triggerMore({ root, items }) {
  const buttons = queryDeep(root, 'button, a, div, span').filter(
    (el) => el.children.length === 0 && MORE_TEXT.test((el.textContent ?? '').trim()),
  )
  const button = buttons[buttons.length - 1]
  if (button) {
    button.click()
    return true
  }

  const last = items?.[items.length - 1]
  if (!last) return false

  // 最后一条评论已经在视野里：交给页面自己的懒加载，别再滚，避免来回弹
  const view = last.ownerDocument?.defaultView
  const rect = last.getBoundingClientRect?.()
  if (rect && rect.bottom > 0 && view?.innerHeight && rect.bottom <= view.innerHeight + 120) {
    return true
  }

  const scroller = nearestScrollable(last)
  if (scroller) {
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8) return true
    scroller.scrollTop = scroller.scrollHeight
    return true
  }

  try {
    last.scrollIntoView?.({ block: 'end', inline: 'nearest' })
  } catch {
    /* 某些环境没有 scrollIntoView */
  }
  return true
}

const hooks = new Set()
let hooked = false

/** 监听所有新建的 shadow root（B 站重渲染时会新建）。 */
export function onShadowCreated(callback) {
  if (!hooked && typeof Element !== 'undefined' && Element.prototype.attachShadow) {
    const original = Element.prototype.attachShadow
    Element.prototype.attachShadow = function patched(init) {
      const shadow = original.call(this, init)
      for (const hook of hooks) {
        try {
          hook(shadow, this)
        } catch {
          /* 单个 hook 失败不影响页面 */
        }
      }
      return shadow
    }
    hooked = true
  }
  hooks.add(callback)
  return () => hooks.delete(callback)
}

/** 在 root 及所有已知 shadow root 上挂 MutationObserver。 */
export function observeDeep(root, callback) {
  const observers = []
  const seen = new Set()
  const MutationObserverCtor =
    root?.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver

  const attach = (node) => {
    if (!node?.querySelectorAll || seen.has(node) || !MutationObserverCtor) return
    seen.add(node)
    const observer = new MutationObserverCtor(callback)
    observer.observe(node, { childList: true, subtree: true })
    observers.push(observer)
    for (const el of node.querySelectorAll('*')) if (el.shadowRoot) attach(el.shadowRoot)
  }

  attach(root)
  const offHook = onShadowCreated((shadow) => {
    attach(shadow)
    callback()
  })

  return () => {
    for (const observer of observers) observer.disconnect()
    offHook()
  }
}

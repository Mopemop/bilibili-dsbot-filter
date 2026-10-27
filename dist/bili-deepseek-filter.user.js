// ==UserScript==
// @name         B站大肥鱼过滤器（DeepSeek 机器人）
// @name:en      Bilibili DeepSeek Bot Comment Filter
// @name:zh-CN   B站大肥鱼过滤器（DeepSeek 机器人）
// @version      1.8.0
// @description  在 B 站视频评论区识别 DeepSeek「大肥鱼」机器人的主评论：最新/最热里隐藏，新增「大肥鱼」视图只展示它们及其楼中楼。
// @description:en  Filter DeepSeek bot comments on Bilibili video pages: hide them in "Hot/Latest", add a "Big Fat Fish" tab that only shows the detected bot comments.
// @description:zh-CN  在 B 站视频评论区识别 DeepSeek「大肥鱼」机器人的主评论：最新/最热里隐藏，新增「大肥鱼」视图只展示它们及其楼中楼。
// @author       local
// @match        https://www.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @license      MIT
// @noframes
// @namespace https://greasyfork.org/users/1657822
// ==/UserScript==

(function () {
'use strict';
var __BDF_DEBUG__ = true;
var __defs = {};
var __cache = {};
function __define(id, factory) { __defs[id] = factory; }
function __require(id) {
  if (__cache[id]) return __cache[id];
  var exports = {};
  __cache[id] = exports;
  if (!__defs[id]) throw new Error('module not found: ' + id);
  __defs[id](exports, __require);
  return exports;
}

__define("src/main.js", function (exports, __require) {
const { detectAdapter, degrade } = __require("src/adapters/index.js");
const { queryDeepOne, queryDeep, onShadowCreated, nearListEnd } = __require("src/adapters/shadow.js");
const { scanCommentsOnce, classifyComment } = __require("src/core/score.js");
const { detectDuplicate } = __require("src/core/repeat.js");
const { createStore, createDb } = __require("src/core/store.js");
const { DEBUG } = __require("src/core/debug.js");
const { applyView, mountControls } = __require("src/ui/mount.js");
const VIDEO_URL = /^https?:\/\/www\.bilibili\.com\/video\//
const VERSION = '1.8.0'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  }
}

function bvidOf(location) {
  const match = String(location?.href ?? '').match(/\/video\/(BV[0-9A-Za-z]+)/)
  return match ? match[1] : ''
}

/** 装配入口；找不到评论区就退化为原样。 */
function boot({ window: win = globalThis.window, storage } = {}) {
  const document = win?.document
  if (!document) {
    degrade('没有可用的 document')
    return null
  }

  // 自愈：清掉旧版残留节点，并还原被隐藏过的原生列表
  for (const id of ['#bdf-fish-list', '#bdf-slot']) {
    document.querySelectorAll(id).forEach((el) => el.remove())
  }
  // 升级 / SPA 跳转后 DOM 可能保留旧隐藏状态：跨 shadow 把所有被我们动过的元素复原
  for (const el of queryDeep(document, '[data-bdf-hidden], [data-bdf-bot], [data-bdf-hid]')) {
    el.style.display = ''
    delete el.dataset.bdfHidden
    delete el.dataset.bdfBot
    delete el.dataset.bdfHid
  }
  // 旧版本可能直接把列表容器设成 display:none 却没留标记
  for (const selector of ['.reply-list', '.bili-comment', '.bb-comment', 'bili-comments']) {
    for (const el of queryDeep(document, selector)) {
      if (el.style.display === 'none') el.style.display = ''
    }
  }

  const adapter = detectAdapter(document)
  if (!adapter) {
    degrade('找不到评论区结构（可能改版、或当前不是视频页）')
    return null
  }

  const diag = (() => {
    try {
      return typeof unsafeWindow !== 'undefined' ? unsafeWindow : win
    } catch {
      return win
    }
  })()
  const report = (patch) => {
    if (!DEBUG) return
    const info = { version: VERSION, started: true, adapter: adapter.name, ...patch }
    try {
      diag.__bdf = { ...(diag.__bdf ?? {}), ...info, at: Date.now() }
    } catch {
      /* 忽略 */
    }
    try {
      win.__bdf = { ...(win.__bdf ?? {}), ...info, at: Date.now() }
    } catch {
      /* 忽略 */
    }
  }
  report({ href: win.location?.href })

  const store = createStore(storage ?? win.localStorage ?? memoryStorage())
  const gm =
    typeof globalThis.GM_getValue === 'function' && typeof globalThis.GM_setValue === 'function'
      ? {
          get: (key) => globalThis.GM_getValue(key, null),
          set: (key, value) => globalThis.GM_setValue(key, value),
        }
      : null
  const db = createDb({ gm, storage: storage ?? win.localStorage ?? memoryStorage() })

  let settings = store.loadSettings()
  let view = 'hot'
  let verdicts = new Map()
  let lastRenderKey = ''
  let preloadAt = 0
  let preloadStatic = 0
  let preloadDisabled = false
  let preloadRaf = 0
  let botCount = 0
  let destroyed = false
  let recomputeTimer = null
  let unsubscribe = null
  let ui = null

  const visibleVerdicts = () => (settings.enabled ? verdicts : new Map())

  // B 站会复用 DOM 节点（切排序/加载更多），缓存必须校验正文快照，否则会拿到旧作者的数据
  const signalCache = new WeakMap()
  function readSignal(element) {
    const snapshot = element.textContent ?? ''
    const cached = signalCache.get(element)
    if (cached && cached.snapshot === snapshot) return cached.signal
    const signal = adapter.readComment(element)
    signalCache.set(element, { snapshot, signal })
    return signal
  }

  /** 渲染路径用的快速读法：直接用上一次 compute 的结果，不重复做 DOM 解析 */
  function readSignalFast(element) {
    return signalCache.get(element)?.signal ?? readSignal(element)
  }

  // 评论列表按需缓存：只在 DOM 变动后重算，避免每个 scroll 帧都做跨 shadow 遍历
  let commentsCache = null
  function listComments() {
    if (!commentsCache) commentsCache = adapter.listComments()
    return commentsCache
  }
  function invalidateComments() {
    commentsCache = null
  }

  function compute() {
    if (destroyed) return
    invalidateComments()
    const elements = listComments()
    const signals = elements.map(readSignal)
    const words = store.words()
    const { scores } = scanCommentsOnce(signals, {
      preset: settings.preset,
      labels: store.labelMap(),
      words,
    })
    verdicts = new Map([...scores].map(([rpid, verdict]) => [rpid, verdict.isBot]))

    // 只有手动名单覆盖规则；支持 UID 与用户名全称两种匹配
    for (const signal of signals) {
      const human = db.accountVerdict(signal.mid) === 'human' || db.nameVerdict(signal.uname) === 'human'
      const bot = db.accountVerdict(signal.mid) === 'bot' || db.nameVerdict(signal.uname) === 'bot'
      if (human) verdicts.set(signal.rpid, false)
      else if (bot) verdicts.set(signal.rpid, true)
    }
    // 置顶评论永远不算机器人
    elements.forEach((element, index) => {
      if (adapter.isPinned?.(element)) verdicts.set(signals[index].rpid, false)
    })
    botCount = [...verdicts.values()].filter(Boolean).length
  }

  /** 记下视口里第一条评论的位置，重排后把视口拉回原处（避免隐藏评论后页面跳动） */
  function captureAnchor() {
    for (const element of adapter.listComments()) {
      const rect = element.getBoundingClientRect?.()
      if (rect && rect.top >= 0) return { element, top: rect.top }
    }
    return null
  }

  function restoreAnchor(saved) {
    if (!saved?.element) return
    const rect = saved.element.getBoundingClientRect?.()
    if (!rect) return
    const delta = rect.top - saved.top
    if (Math.abs(delta) > 8) win.scrollBy?.(0, delta)
  }

  // ---- 渐进式审核：先显示，再分批判定，命中即移除 ----
  const BATCH = 40
  let knownElements = new WeakSet()
  let pending = []
  let pumping = false
  let dupTimer = null
  let settleResolvers = []
  let listsCache = null

  function settled() {
    return new Promise((resolve) => {
      if (!pending.length && !pumping) resolve()
      else settleResolvers.push(resolve)
    })
  }

  function resolveSettled() {
    const list = settleResolvers
    settleResolvers = []
    for (const resolve of list) resolve()
  }

  function nextTask(fn) {
    if (win.requestIdleCallback) win.requestIdleCallback(fn, { timeout: 300 })
    else win.setTimeout(() => fn(null), 16)
  }

  function verdictOne(element) {
    const signal = readSignal(element)
    listsCache = listsCache ?? db.snapshot()
    const base = classifyComment(signal, {
      preset: settings.preset,
      labels: store.labelMap(),
      words: store.words(),
    })
    let isBot = base.isBot
    const human =
      listsCache.byMid.get(String(signal.mid)) === 'human' ||
      listsCache.byName.get(signal.uname) === 'human'
    const bot =
      listsCache.byMid.get(String(signal.mid)) === 'bot' ||
      listsCache.byName.get(signal.uname) === 'bot'
    if (human) isBot = false
    else if (bot) isBot = true
    if (adapter.isPinned?.(element)) isBot = false
    verdicts.set(signal.rpid, isBot)
  }

  function recount() {
    let count = 0
    for (const value of verdicts.values()) if (value) count += 1
    botCount = count
  }

  /** 跨账号复读是页级信号，最后统一补一次 */
  function finishPageSignals() {
    if (dupTimer) win.clearTimeout?.(dupTimer)
    dupTimer = win.setTimeout?.(() => {
      dupTimer = null
      if (destroyed) {
        resolveSettled()
        return
      }
      const signals = listComments().map(readSignal)
      const dup = detectDuplicate(signals)
      if (dup.rpids.length) {
        for (const rpid of dup.rpids) verdicts.set(rpid, true)
        recount()
        render()
      }
      resolveSettled()
    }, 300)
  }

  function pump() {
    if (pumping || destroyed) return
    pumping = true
    const run = (deadline) => {
      let processed = 0
      while (pending.length && processed < BATCH) {
        if (deadline?.timeRemaining && deadline.timeRemaining() < 3 && processed >= 10) break
        verdictOne(pending.shift())
        processed += 1
      }
      if (processed) {
        recount()
        render()
      }
      if (pending.length) {
        nextTask(run)
        return
      }
      pumping = false
      finishPageSignals()
    }
    nextTask(run)
  }

  function queueAll() {
    listsCache = null
    knownElements = new WeakSet()
    verdicts = new Map()
    pending = listComments().slice()
    pump()
  }

  function queueNew() {
    listsCache = null
    for (const element of listComments()) {
      if (knownElements.has(element)) continue
      knownElements.add(element)
      pending.push(element)
    }
    if (pending.length) pump()
  }

  function render() {
    if (destroyed) return
    // 只有切换视图/开关时才做视口锚定；否则每次 B 站追加评论都会把用户拽回去
    const renderKey = `${view}|${settings.enabled}|${settings.preset}`
    const anchor = renderKey !== lastRenderKey ? captureAnchor() : null
    lastRenderKey = renderKey

    applyView({
      adapter,
      verdicts: visibleVerdicts(),
      view: settings.enabled ? view : 'off',
      readId: (element) => readSignalFast(element).rpid,
    })

    restoreAnchor(anchor)
    ui?.setBadge(botCount)
    ui?.setActive(view === 'fish')
    ui?.refreshLists?.()
    report({
      view,
      botCount,
      comments: listComments().length,
      hasSlot: Boolean(document.querySelector('#bdf-slot')),
    })

  }

  /** 距离底部还有一段就开始加载，避免「必须拉到底」才出评论 */
  function preloadTick() {
    if (destroyed || preloadDisabled) return
    const now = Date.now()
    if (now - preloadAt < 1500) return
    // 只按「评论区最后一条」判断，滑到一半不会误触发
    const items = listComments()
    const last = items[items.length - 1]
    const rect = last?.getBoundingClientRect?.()
    // 提前约 1.5 屏（大约滑到评论区一半）就开始加载
    const viewH = win.innerHeight ?? 800
    if (!nearListEnd(rect, viewH, Math.round(viewH * 1.5))) return
    preloadAt = now
    const before = items.length
    let triggered = false
    try {
      // 优先只点「加载更多」按钮，完全不滚动
      triggered = adapter.loadMore?.({ silent: true }) ?? false
      if (!triggered) adapter.loadMore?.()
    } catch (error) {
      degrade('预加载失败', error)
    }
    win.setTimeout?.(() => {
      if (destroyed) return
      invalidateComments()
      const grew = listComments().length > before
      preloadStatic = grew ? 0 : preloadStatic + 1
      if (preloadStatic >= 3) preloadDisabled = true
    }, 1500)
  }

  const onScrollPreload = () => {
    if (preloadRaf) return
    preloadRaf = win.requestAnimationFrame?.(() => {
      preloadRaf = 0
      preloadTick()
    }) ?? 0
  }
  win.addEventListener?.('scroll', onScrollPreload, { passive: true })

  function scheduleCompute() {
    if (destroyed) return
    if (recomputeTimer) win.clearTimeout?.(recomputeTimer)
    recomputeTimer = win.setTimeout?.(() => {
      recomputeTimer = null
      queueNew()
    }, 150)
  }

  ui = mountControls({
    adapter,
    document,
    settings,
    onViewChange(next) {
      view = next === 'fish' ? 'fish' : next === 'new' ? 'new' : 'hot'
      render()
    },
    onToggle(enabled) {
      settings = store.saveSettings({ enabled })
      if (!enabled) view = 'hot'
      render()
    },
    onPresetChange(preset) {
      settings = store.saveSettings({ preset })
      queueAll()
      render()
    },
    onAddName(name, verdict) {
      const value = String(name ?? '').trim()
      if (!value) return
      const signal = adapter.listComments().map(readSignal).find((item) => item.uname === value)
      const mid = signal?.mid ?? ''
      if (mid) store.setLabel(mid, verdict)
      db.addName(value, verdict, mid)
      queueAll()
      render()
    },
    onAddWord(word) {
      store.addWord(word)
      queueAll()
      render()
    },
    onRemoveWord(word) {
      store.removeWord(word)
      queueAll()
      render()
    },
    getWords() {
      return store.words()
    },
    onRemove(key) {
      const record = [...db.list('human'), ...db.list('bot')].find((item) => item.key === key)
      if (record?.mid) store.removeLabel(record.mid)
      db.removeAccount(key)
      queueAll()
      render()
    },
    getLists() {
      return { white: db.list('human'), black: db.list('bot') }
    },
  })

  // 评论区可能被之前运行/旧版本整段隐藏（容器 display:none），把评论及其祖先一路恢复
  for (const element of adapter.listComments()) {
    element.style.display = ''
    let node = element
    while (node && node !== document.body) {
      if (node.nodeType === 1 && node.style?.display === 'none') node.style.display = ''
      node = node.parentElement ?? node.getRootNode?.()?.host ?? null
    }
  }

  queueAll()
  render()
  win.setTimeout?.(() => {
    if (!destroyed) preloadTick()
  }, 1500)

  unsubscribe = adapter.subscribe?.(() => {
    invalidateComments()
    scheduleCompute()
  }) ?? null

  function destroy() {
    destroyed = true
    if (recomputeTimer) win.clearTimeout?.(recomputeTimer)
    unsubscribe?.()
    win.removeEventListener?.('scroll', onScrollPreload)
    if (preloadRaf) win.cancelAnimationFrame?.(preloadRaf)
    ui?.dispose()
    ui = null
  }

  return {
    adapter,
    compute,
    render,
    settled,
    destroy,
    get view() {
      return view
    },
    get botCount() {
      return botCount
    },
    get settings() {
      return settings
    },
  }
}

/** 入口：只处理视频页；评论区异步挂载，所以带重试与看门狗。 */
function start({ window: win = globalThis.window, watchRoute = true } = {}) {
  if (!win) return null

  let controller = null
  let destroyed = false
  let timer = null
  let lastHref = win.location?.href ?? ''
  let tries = 0
  let missingTicks = 0

  onShadowCreated(() => {})

  const isVideo = () => VIDEO_URL.test(win.location?.href ?? '')
  const hasUi = () => {
    const doc = win.document
    if (!doc) return false
    return Boolean(doc.querySelector('#bdf-slot') ?? queryDeepOne(doc, '#bdf-slot'))
  }

  function attempt() {
    if (destroyed || controller) return
    if (!isVideo() || !win.document?.body) return
    controller = boot({ window: win })
    if (controller) {
      if (DEBUG) console.info('[bdf] 已生效（%s）', controller.adapter?.name)
      tries = 0
      return
    }
    tries += 1
    if (tries === 60 && DEBUG) console.warn('[bdf] 60 次仍未找到评论区，停止重试')
  }

  function tick() {
    if (destroyed) return
    const href = win.location?.href ?? ''
    if (href !== lastHref) {
      lastHref = href
      controller?.destroy?.()
      controller = null
      tries = 0
      missingTicks = 0
    }
    if (!isVideo()) {
      if (controller) {
        controller.destroy()
        controller = null
      }
      return
    }
    if (!controller) {
      attempt()
      return
    }
    if (hasUi()) {
      missingTicks = 0
      return
    }
    missingTicks += 1
    if (missingTicks >= 2) {
      missingTicks = 0
      controller.destroy()
      controller = null
      attempt()
    }
  }

  tick()
  if (watchRoute) timer = win.setInterval(tick, 800)

  return {
    get controller() {
      return controller
    },
    destroy() {
      destroyed = true
      if (timer) win.clearInterval(timer)
      controller?.destroy?.()
      controller = null
    },
  }
}

// 用户脚本入口
if (typeof window !== 'undefined') {
  if (DEBUG) {
    console.info('[bdf] loaded', VERSION)
    try {
      const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
      const info = { version: VERSION, loaded: true, href: window.location?.href }
      pageWin.__bdf = info
      window.__bdf = info
    } catch {
      /* 忽略 */
    }
  }
  start({ window })
}

Object.assign(exports, { boot, start });
});

__define("src/adapters/index.js", function (exports, __require) {
const { DEBUG } = __require("src/core/debug.js");
const { v3 } = __require("src/adapters/v3.js");
const { v2 } = __require("src/adapters/v2.js");
const { v1 } = __require("src/adapters/v1.js");
/** 新版优先，旧版兜底；B 站正在灰度，三套结构可能同时存在。 */
const ADAPTERS = [v3, v2, v1]

function detectAdapter(document) {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.match(document)) return adapter.create(document)
    } catch {
      /* 匹配失败继续下一个 */
    }
  }
  return null
}

/** 异常退化：只留一条警告，绝不注入任何 UI。 */
function degrade(reason, detail) {
  if (!DEBUG) return
  try {
    console.warn(`[bdf] ${reason}`, detail ?? '')
  } catch {
    /* 控制台不可用时静默 */
  }
}

Object.assign(exports, { detectAdapter, degrade });
});

__define("src/core/debug.js", function (exports, __require) {

/** 构建时注入 __BDF_DEBUG__：开发版 true，发布版 false（移除日志与诊断对象） */
const DEBUG = typeof __BDF_DEBUG__ === 'undefined' ? true : Boolean(__BDF_DEBUG__)

Object.assign(exports, { DEBUG });
});

__define("src/adapters/v3.js", function (exports, __require) {
const { queryDeep, queryDeepOne, findTabRow, observeDeep, normalizeUrl, fallbackRpid, triggerMore, isPinned } = __require("src/adapters/shadow.js");
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

function createV3(host) {
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

const v3 = {
  name: 'v3',
  match: (document) => Boolean(document.querySelector(HOST)),
  create: (document) => createV3(document.querySelector(HOST)),
}

Object.assign(exports, { createV3, v3 });
});

__define("src/adapters/shadow.js", function (exports, __require) {

/** Shadow DOM 与深层查询工具：B 站新版评论区的所有节点都在多层 shadow root 里。 */

function normalizeUrl(url) {
  const value = String(url ?? '').trim()
  if (!value) return ''
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('http://')) return value.replace(/^http:\/\//, 'https://')
  return value
}

/** 跨 shadow 边界的 querySelectorAll（去重）。 */
function queryDeep(root, selector) {
  const out = []
  const seen = new Set()
  const visit = (node) => {
    if (!node) return
    if (node.nodeType === 1 && node.matches?.(selector) && !seen.has(node)) {
      seen.add(node)
      out.push(node)
    }
    if (node.shadowRoot) visit(node.shadowRoot)
    if (!node.querySelectorAll) return
    // 只遍历一次子树：同时做选择器匹配与 shadow 下钻
    for (const el of node.querySelectorAll('*')) {
      if (el.matches?.(selector) && !seen.has(el)) {
        seen.add(el)
        out.push(el)
      }
      if (el.shadowRoot) visit(el.shadowRoot)
    }
  }
  visit(root)
  return out
}

function queryDeepOne(root, selector) {
  return queryDeep(root, selector)[0] ?? null
}

/**
 * 旧版 DOM 兜底时可能拿不到 rpid；用「mid + 正文哈希」生成稳定 key，
 * 否则所有评论会共用一个空 key，判定结果互相覆盖。
 */
function fallbackRpid(element, mid, message) {
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
function findTabRow(root) {
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
function triggerMore({ root, items, silent = false }) {
  const buttons = queryDeep(root, 'button, a, div, span').filter(
    (el) => el.children.length === 0 && MORE_TEXT.test((el.textContent ?? '').trim()),
  )
  const button = buttons[buttons.length - 1]
  if (button) {
    button.click()
    return true
  }
  if (silent) return false

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

/**
 * 置顶评论识别：B 站各版本都用「置顶」小标签或 top/pinned 相关 class 标记。
 * 只看短文本标签，避免正文里出现「置顶」两个字被误判。
 * 结果按元素短缓存：命中缓存 30s，未命中 2s（等 B 站把徽标渲染出来）。
 */
let pinnedCache = new WeakMap()

function clearPinnedCache() {
  pinnedCache = new WeakMap()
}

function isPinned(element) {
  if (!element?.querySelectorAll) return false
  const now = Date.now()
  const cached = pinnedCache.get(element)
  if (cached && now - cached.at < (cached.value ? 30000 : 2000)) return cached.value
  const value = detectPinned(element)
  pinnedCache.set(element, { value, at: now })
  return value
}

function detectPinned(element) {
  try {
    if (/pinned/i.test(element.className ?? '')) return true
    const classes = [...(element.classList ?? [])]
    if (classes.some((name) => /^(is-)?top(ped)?$/i.test(name))) return true
    const label = element.getAttribute?.('aria-label') ?? ''
    if (label.includes('置顶')) return true
    // 先看整块文本里有没有「置顶」，没有就直接返回（省掉 querySelectorAll）
    if (!(element.textContent ?? '').includes('置顶')) return false
    for (const el of element.querySelectorAll('span, div, i, em, b, p, img[alt]')) {
      const text = (el.textContent ?? '').trim()
      if (text === '置顶') return true
      if ((el.getAttribute?.('alt') ?? '').includes('置顶')) return true
    }
  } catch {
    /* 忽略 */
  }
  return false
}

/** 距离页面底部还有多少像素；用于「快到底就开始加载」 */
function distanceToBottom({ scrollY = 0, innerHeight = 0, scrollHeight = 0 } = {}) {
  return Math.max(0, Number(scrollHeight) - Number(scrollY) - Number(innerHeight))
}

function nearBottom(metrics, threshold = 900) {
  return distanceToBottom(metrics) <= threshold
}

/**
 * 评论区尾部是否接近视口：按最后一条评论的 bottom 判断，
 * 避免「页面很短，滚到一半就落在页面底部阈值内」。
 */
function nearListEnd(rect, innerHeight = 0, margin = 700) {
  if (!rect) return false
  const bottom = Number(rect.bottom ?? NaN)
  if (!Number.isFinite(bottom)) return false
  if (bottom <= 0) return false
  return bottom <= Number(innerHeight) + margin
}

const hooks = new Set()
let hooked = false

/** 监听所有新建的 shadow root（B 站重渲染时会新建）。 */
function onShadowCreated(callback) {
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
function observeDeep(root, callback) {
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

Object.assign(exports, { normalizeUrl, queryDeep, queryDeepOne, fallbackRpid, findTabRow, triggerMore, clearPinnedCache, isPinned, distanceToBottom, nearBottom, nearListEnd, onShadowCreated, observeDeep });
});

__define("src/adapters/v2.js", function (exports, __require) {
const { findTabRow, observeDeep, normalizeUrl, fallbackRpid, triggerMore, isPinned } = __require("src/adapters/shadow.js");
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

function createV2(root) {
  return {
    name: 'v2',
    root,
    listComments: () => mainComments(root),
    getSortRow: () => findTabRow(root),
    readComment,
    isPinned,
    loadMore: (options = {}) => triggerMore({ root, items: mainComments(root), ...options }),
    subscribe(callback) {
      return observeDeep(root, callback)
    },
  }
}

const v2 = {
  name: 'v2',
  match: (document) => Boolean(document.querySelector(ROOT)),
  create: (document) => createV2(document.querySelector(ROOT)),
}

Object.assign(exports, { createV2, v2 });
});

__define("src/adapters/v1.js", function (exports, __require) {
const { findTabRow, observeDeep, normalizeUrl, fallbackRpid, triggerMore, isPinned } = __require("src/adapters/shadow.js");
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

function createV1(root) {
  return {
    name: 'v1',
    root,
    listComments: () => mainComments(root),
    getSortRow: () => findTabRow(root),
    readComment,
    isPinned,
    loadMore: (options = {}) => triggerMore({ root, items: mainComments(root), ...options }),
    subscribe(callback) {
      return observeDeep(root, callback)
    },
  }
}

const v1 = {
  name: 'v1',
  match: (document) => Boolean(document.querySelector(ROOT)),
  create: (document) => createV1(document.querySelector(ROOT)),
}

Object.assign(exports, { createV1, v1 });
});

__define("src/core/score.js", function (exports, __require) {
const { MODEL_NAME, LONG_MIN_LENGTH, FISH_STRONG, FISH_WEAK, PERSONA, MASTER, FISH_LIFE, KAOMOJI, AT_START, SEEK_APPROVAL, LONG_STRUCTURE } = __require("src/core/lexicon.js");
const { detectDuplicate } = __require("src/core/repeat.js");
/** 标准档宁可漏一点；激进档把「名字带鱼/鲸」直接判死 */
const THRESHOLDS = { standard: 5, aggressive: 3 }
const MAX_SCORE = 10

const clamp = (n) => Math.max(0, Math.min(MAX_SCORE, n))

/**
 * 单条主评论打分。
 * @param {{rpid?:string, mid:string, uname:string, message:string}} comment
 * @param {{preset?:'standard'|'aggressive', labels?:Record<string,'bot'|'human'>}} ctx
 * @returns {{score:number, reasons:string[], isBot:boolean}}
 */
function classifyComment(comment, ctx = {}) {
  const preset = ctx.preset === 'aggressive' ? 'aggressive' : 'standard'
  const words = Array.isArray(ctx.words) ? ctx.words.filter(Boolean) : []
  const threshold = THRESHOLDS[preset]
  const manual = ctx.labels?.[comment.mid]

  if (manual === 'human') return { score: 0, reasons: ['人工:真人'], isBot: false }
  if (manual === 'bot') return { score: MAX_SCORE, reasons: ['人工:机器人'], isBot: true }

  const reasons = []
  let score = 0

  // 昵称
  const name = String(comment.uname ?? '')
  const modelHit = name.match(MODEL_NAME)
  if (modelHit) {
    score += 6
    reasons.push(`名字:${modelHit[0]}`)
  } else {
    const fishHit = FISH_STRONG.find((word) => name.includes(word))
    if (fishHit) {
      score += 4
      reasons.push(`名字:${fishHit}`)
    } else if (FISH_WEAK.test(name)) {
      score += 2
      reasons.push('名字:鱼/鲸')
    }
  }

  // 正文（只认角色化表达，绝不把主题词当信号）
  const message = String(comment.message ?? '')
  if (PERSONA.test(message)) {
    score += 3
    reasons.push('文风:角色自称')
  }
  if (MASTER.test(message)) {
    score += 2
    reasons.push('文风:主人')
  }
  const lifeHits = FISH_LIFE.filter((word) => message.includes(word))
  if (lifeHits.length) {
    score += Math.min(2, lifeHits.length)
    reasons.push(`文风:${lifeHits[0]}`)
  }
  if (KAOMOJI.test(message)) {
    score += 1
    reasons.push('文风:颜文字')
  }
  if (AT_START.test(message)) {
    score += 2
    reasons.push('文风:@开头')
  }
  if (SEEK_APPROVAL.test(message)) {
    score += 1
    reasons.push('文风:求认同')
  }
  if (message.length >= LONG_MIN_LENGTH && LONG_STRUCTURE.test(message)) {
    score += 1
    reasons.push('文风:长文结构')
  }

  // 自定义屏蔽词：与内置词典同级（昵称 +4、正文 +2，合计上限 +6）
  let wordScore = 0
  for (const word of words) {
    if (name.includes(word)) {
      wordScore += 4
      reasons.push(`屏蔽词:${word}`)
    } else if (message.includes(word)) {
      wordScore += 2
      reasons.push(`屏蔽词:${word}`)
    }
    if (wordScore >= 6) break
  }
  score += Math.min(6, wordScore)

  const total = clamp(score)
  return { score: total, reasons, isBot: total >= threshold }
}

/**
 * 整页判定：先算页面级信号（跨账号重复 / 共用头像），再逐条打分。
 * @param {Array<{rpid:string, mid:string, uname:string, message:string, faceUrl?:string, dhash?:string}>} comments
 * @param {{preset?:string, labels?:Record<string,'bot'|'human'>, avatarHash?:boolean}} settings
 * @returns {{bots:Array<object>, scores:Map<string,{score:number,reasons:string[],isBot:boolean}>}}
 */
function scanCommentsOnce(comments, settings = {}) {
  const preset = settings.preset === 'aggressive' ? 'aggressive' : 'standard'
  const threshold = THRESHOLDS[preset]
  const words = settings.words ?? []
  const labels = settings.labels ?? {}
  const list = comments ?? []

  const duplicate = detectDuplicate(list)
  const crossAccount = new Set(duplicate.rpids)
  const sameAuthor = new Set(duplicate.sameAuthor)

  const scores = new Map()
  const bots = []

  for (const comment of list) {
    const base = classifyComment(comment, { preset, labels, words })
    const manual = base.reasons[0]?.startsWith('人工:')

    let score = base.score
    const reasons = [...base.reasons]

    if (!manual) {
      if (crossAccount.has(comment.rpid)) {
        score += MAX_SCORE
        reasons.push('重复:跨账号')
      } else if (sameAuthor.has(comment.rpid)) {
        score += 1
        reasons.push('重复:同号多发')
      }
    }

    const verdict = {
      score: clamp(score),
      reasons,
      isBot: manual ? base.isBot : clamp(score) >= threshold,
    }
    scores.set(comment.rpid, verdict)
    if (verdict.isBot) bots.push({ ...comment, ...verdict })
  }

  return { bots, scores }
}

Object.assign(exports, { classifyComment, scanCommentsOnce, THRESHOLDS, MAX_SCORE });
});

__define("src/core/lexicon.js", function (exports, __require) {

/**
 * 判定词典。所有词条来自真实样本（research/detection-samples.md）与社区公开规则。
 * 注意：只收「人设 / 角色化」表达，不收「大肥鱼 / 故宫 / 四毛钱」这类主题词 —— 真人也聊同一个话题。
 */

/** 直接点名模型 */
const MODEL_NAME = /deepseek|deep ?seek|深度求索/i

/** 鱼 / 鲸系昵称（强命中，4 分） */
const FISH_STRONG = [
  '大肥鱼',
  '肥鱼',
  '鲸鱼娘',
  '鱼娘',
  '小鲸鱼',
  '鲸鱼',
  '本鱼',
  '本鲸',
  '鱼宝',
  '鱼鱼',
  '鲸',
]

/** 只含「鱼 / 鲸」字的弱命中（2 分） */
const FISH_WEAK = /[鱼鲸]/

/** 角色化自称（3 分） */
const PERSONA = /本(?:公主|鲸|鱼|喵|殿下|座|宫|宝宝)|人家|我作为一条(?:大)?肥鱼|鱼鱼我呀/

/** 主人（2 分） */
const MASTER = /主人/

/** 鱼生梗词（每命中 1 个 1 分，上限 2 分） */
const FISH_LIFE = ['搬砖', '白饭', '鸡腿', '房租', '鱼粮']

/** 颜文字 / 表情（1 分） */
const KAOMOJI = /\[doge\]|[（(][^（）()\n]{0,14}(?:╹|◡|｡|ω|•́|︿|д|∀|ㅅ)[^（）()\n]{0,14}[）)]/

/** 以 @ 开头（2 分，通常是 @主人 汇报） */
const AT_START = /^\s*@/

/** 口播式求认同（1 分） */
const SEEK_APPROVAL = /厉害吧|不好啦|我要发给我的主人|有被冒犯到|有点想加入|是不是很|你们说呢/

/** 长文结构：≥50 字且带破折号 / 引号 / 空行 / 分号（1 分） */
const LONG_MIN_LENGTH = 50
const LONG_STRUCTURE = /——|「|\n\s*\n|；/

Object.assign(exports, { MODEL_NAME, FISH_STRONG, FISH_WEAK, PERSONA, MASTER, FISH_LIFE, KAOMOJI, AT_START, SEEK_APPROVAL, LONG_MIN_LENGTH, LONG_STRUCTURE });
});

__define("src/core/repeat.js", function (exports, __require) {

/**
 * 跨账号复读检测：把正文归一化后按 24 字滑窗求交。
 * 归一化会去掉 @提及、标点、空白、emoji 与大小写差异，所以「换标点 / 加 @」不影响命中。
 */

const SHINGLE = 24
const MENTION = /@[^\s，。,:：;；]{1,20}/g
const NON_WORD = /[^\u4e00-\u9fa5a-zA-Z0-9]+/g

function normalizeMessage(message) {
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
function detectDuplicate(comments) {
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

Object.assign(exports, { normalizeMessage, detectDuplicate });
});

__define("src/core/store.js", function (exports, __require) {

/**
 * 本地存储：设置、手动名单（白/黑名单）。
 * 判定结果每次重算，不落盘。
 */

const PREFIX = 'bdf.'
const CURRENT_VERSION = 1
const DB_KEY = 'bdf.namelist.v1'

const DEFAULT_SETTINGS = {
  version: CURRENT_VERSION,
  enabled: true,
  preset: 'standard',
}

function read(storage, key, fallback) {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function createStore(storage) {
  const api = {
    loadSettings() {
      const raw = read(storage, `${PREFIX}settings`, {}) ?? {}
      const settings = { ...DEFAULT_SETTINGS }
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (raw[key] !== undefined && raw[key] !== null) settings[key] = raw[key]
      }
      settings.version = CURRENT_VERSION
      settings.preset = settings.preset === 'aggressive' ? 'aggressive' : 'standard'
      settings.enabled = Boolean(settings.enabled)
      return settings
    },

    saveSettings(patch = {}) {
      const next = { ...api.loadSettings(), ...patch, version: CURRENT_VERSION }
      write(storage, `${PREFIX}settings`, next)
      return next
    },

    labels() {
      return read(storage, `${PREFIX}labels`, {}) ?? {}
    },

    getLabel(mid) {
      return api.labels()[String(mid)]?.verdict ?? null
    },

    setLabel(mid, verdict, note) {
      if (!mid || (verdict !== 'bot' && verdict !== 'human')) return null
      const labels = api.labels()
      labels[String(mid)] = {
        mid: String(mid),
        verdict,
        at: new Date().toISOString(),
        note: String(note ?? ''),
      }
      write(storage, `${PREFIX}labels`, labels)
      return labels[String(mid)]
    },

    removeLabel(mid) {
      const labels = api.labels()
      delete labels[String(mid)]
      write(storage, `${PREFIX}labels`, labels)
    },

    words() {
      const list = read(storage, `${PREFIX}words`, []) ?? []
      return Array.isArray(list) ? list.filter((word) => typeof word === 'string' && word) : []
    },

    addWord(word) {
      const value = String(word ?? '').trim()
      if (!value) return api.words()
      const list = api.words()
      if (!list.includes(value)) list.unshift(value)
      write(storage, `${PREFIX}words`, list.slice(0, 200))
      return api.words()
    },

    removeWord(word) {
      const list = api.words().filter((item) => item !== word)
      write(storage, `${PREFIX}words`, list)
      return list
    },

    /** mid -> verdict，喂给 classifyComment 的 labels 参数 */
    labelMap() {
      const out = {}
      for (const [mid, record] of Object.entries(api.labels())) {
        if (record?.verdict === 'bot' || record?.verdict === 'human') out[mid] = record.verdict
      }
      return out
    },

    clearAll() {
      const keys = []
      const total = Number(storage.length) || 0
      for (let i = 0; i < total; i += 1) {
        const key = storage.key(i)
        if (key?.startsWith(PREFIX)) keys.push(key)
      }
      for (const key of keys) storage.removeItem(key)
    },
  }

  return api
}

/**
 * 手动名单库：只存用户自己加的「永远隐藏（黑名单）」和「永远显示（白名单）」。
 * 没有任何自动学习——判定永远只由规则 + 名单决定。
 */
function createDb({ gm, storage } = {}) {
  const useGm = Boolean(gm && typeof gm.get === 'function' && typeof gm.set === 'function')
  const nameKey = (uname) => `name:${String(uname ?? '').trim()}`

  const load = () => {
    try {
      const raw = useGm ? gm.get(DB_KEY) : storage?.getItem(DB_KEY)
      if (!raw) return {}
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return parsed?.entries ?? {}
    } catch {
      return {}
    }
  }

  const save = (entries) => {
    try {
      const text = JSON.stringify({ entries })
      if (useGm) gm.set(DB_KEY, text)
      else storage?.setItem(DB_KEY, text)
    } catch {
      /* 存不下就算了，不影响页面 */
    }
  }

  const records = () => Object.values(load()).filter(Boolean)

  return {
    /** 一次读取，供整页判定使用（避免每条评论都 JSON.parse 一遍） */
    snapshot() {
      const entries = Object.values(load()).filter(Boolean)
      const byMid = new Map()
      const byName = new Map()
      for (const entry of entries) {
        if (entry.mid) byMid.set(String(entry.mid), entry.verdict)
        if (entry.uname) byName.set(String(entry.uname), entry.verdict)
      }
      return { byMid, byName }
    },

    /** 按 UID 查名单 */
    accountVerdict(mid) {
      if (!mid) return null
      const record = load()[String(mid)]
      return record?.verdict === 'bot' || record?.verdict === 'human' ? record.verdict : null
    },

    /** 按用户名全称查名单 */
    nameVerdict(uname) {
      const name = String(uname ?? '').trim()
      if (!name) return null
      const record = records().find((item) => item.uname === name)
      return record?.verdict === 'bot' || record?.verdict === 'human' ? record.verdict : null
    },

    /** @param {'bot'|'human'} verdict bot=黑名单 human=白名单；key 为 mid 或 name:全称 */
    list(verdict) {
      return records()
        .filter((record) => record.verdict === verdict)
        .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    },

    /** 按 UID 写入（有 mid 时优先） */
    setAccount(mid, verdict, info = {}) {
      if (!mid || (verdict !== 'bot' && verdict !== 'human')) return null
      const entries = load()
      const key = String(mid)
      entries[key] = {
        key,
        mid: key,
        uname: info.uname ?? entries[key]?.uname ?? '',
        verdict,
        at: new Date().toISOString(),
      }
      save(entries)
      return entries[key]
    },

    /** 按用户名全称写入；能对上已有 UID 记录时就地改，否则存 name: 键 */
    addName(uname, verdict, mid) {
      const name = String(uname ?? '').trim()
      if (!name || (verdict !== 'bot' && verdict !== 'human')) return null
      const entries = load()
      const existing = Object.values(entries).find((item) => item?.uname === name)
      const key = mid ? String(mid) : existing?.key ?? nameKey(name)
      entries[key] = {
        key,
        mid: mid ? String(mid) : existing?.mid ?? '',
        uname: name,
        verdict,
        at: new Date().toISOString(),
      }
      save(entries)
      return entries[key]
    },

    removeAccount(key) {
      const entries = load()
      delete entries[String(key)]
      save(entries)
    },

    clear() {
      save({})
    },
  }
}

Object.assign(exports, { createStore, createDb, CURRENT_VERSION, DB_KEY, DEFAULT_SETTINGS });
});

__define("src/ui/mount.js", function (exports, __require) {

/**
 * 视图与 UI（最小版）。
 *
 * 不建自有列表、不插 Vue 管理的容器：tab 内联到排序行，鱼视图靠隐藏真人主评论实现，
 * 机器人主评论连同其楼中楼原样保留。
 */

const SLOT_ID = 'bdf-slot'
const PANEL_ID = 'bdf-panel'

const STYLE = `
  :host { all: initial; }
  .bdf-tab { font: inherit; font-size: 13px; color: #61666d; background: none; border: 0; padding: 0 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 2px; line-height: 20px; }
  .bdf-tab:hover, .bdf-tab.is-active { color: #00aeec; }
  .bdf-tab.is-active { font-weight: 600; }
  .bdf-count { font-size: 11px; background: #00aeec; color: #fff; border-radius: 8px; padding: 0 4px; min-width: 12px; text-align: center; }
  .bdf-gear { font: inherit; font-size: 12px; color: #9499a0; background: none; border: 0; cursor: pointer; padding: 0 2px; }
`

const STYLE_PANEL = `
  .bdf-panel[hidden] { display: none; }
  .bdf-card { background: #fff; color: #18191c; border-radius: 8px; padding: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.18); font-size: 13px; width: 260px; font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  .bdf-card-title { font-weight: 600; margin-bottom: 8px; }
  .bdf-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .bdf-row select { margin-left: auto; }
  .bdf-hint { color: #9499a0; font-size: 11px; line-height: 1.5; margin-top: 8px; }
  .bdf-list { margin-top: 8px; border-top: 1px solid #f1f2f3; padding-top: 6px; max-height: 180px; overflow: auto; }
  .bdf-list-title { color: #9499a0; font-size: 11px; margin-bottom: 4px; }
  .bdf-item { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .bdf-item-name { color: #18191c; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bdf-label { font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid #e3e5e7; background: #f6f7f8; cursor: pointer; white-space: nowrap; }
  .bdf-label:hover { border-color: #00aeec; color: #00aeec; }
  .bdf-name-input { flex: 1; font: inherit; font-size: 12px; padding: 3px 6px; border: 1px solid #e3e5e7; border-radius: 4px; min-width: 0; }
  .bdf-add-black, .bdf-add-white { flex: 1; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 4px; border: 1px solid #e3e5e7; background: #f6f7f8; cursor: pointer; }
  .bdf-add-black:hover { border-color: #f56c6c; color: #f56c6c; }
  .bdf-add-white:hover { border-color: #00aeec; color: #00aeec; }
  .bdf-words { margin-top: 8px; border-top: 1px solid #f1f2f3; padding-top: 6px; }
  .bdf-word-input { flex: 1; font: inherit; font-size: 12px; padding: 3px 6px; border: 1px solid #e3e5e7; border-radius: 4px; min-width: 0; }
  .bdf-word-add { font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 4px; border: 1px solid #e3e5e7; background: #f6f7f8; cursor: pointer; white-space: nowrap; }
  .bdf-word-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .bdf-word { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; background: #f1f2f3; color: #61666d; border-radius: 10px; padding: 1px 6px; }
  .bdf-word-x { border: 0; background: none; color: #9499a0; cursor: pointer; font-size: 12px; padding: 0; }
  .bdf-word-x:hover { color: #f56c6c; }
`

const ORIGINAL_DISPLAY = new WeakMap()

function hideElement(element) {
  if (!ORIGINAL_DISPLAY.has(element)) ORIGINAL_DISPLAY.set(element, element.style.display)
  element.style.display = 'none'
  element.dataset.bdfHidden = '1'
}

function showElement(element) {
  if (ORIGINAL_DISPLAY.has(element)) {
    element.style.display = ORIGINAL_DISPLAY.get(element) ?? ''
    ORIGINAL_DISPLAY.delete(element)
  } else if (element.dataset?.bdfHidden) {
    element.style.display = ''
  }
  if (element.dataset) delete element.dataset.bdfHidden
}

function ensureVisible(element) {
  if (
    element.style.display !== 'none' &&
    !element.hasAttribute('data-bdf-bot') &&
    !element.dataset?.bdfHidden
  ) {
    return false
  }
  element.removeAttribute('data-bdf-bot')
  element.style.display = ''
  if (element.dataset) delete element.dataset.bdfHidden
  return true
}

/**
 * 落判定结果。view='fish' 时只留机器人主评论（楼中楼在原节点里，天然保留）。
 */
function applyView({ adapter, verdicts = new Map(), view = 'hot', readId, applied, elements }) {
  const getRpid = readId ?? ((element) => adapter.readComment(element).rpid)
  const list = elements ?? adapter.listComments?.() ?? []
  const incremental = Boolean(applied)
  const root = adapter?.root
  if (root) {
    if (view === 'off') root.removeAttribute('data-bdf-view')
    else root.setAttribute('data-bdf-view', view)
  }

  const hasVerdicts = Boolean(verdicts?.size)

  // 还没审核 / 关闭时：只保证全部可见，不做解析（首屏最快路径）
  if ((!hasVerdicts || view === 'off') && view !== 'fish') {
    for (const element of list) {
      ensureVisible(element)
      applied?.seen?.add(element)
    }
    if (incremental) {
      applied.view = view
      applied.map = new Map()
    }
    return
  }

  for (const element of list) {
    // 置顶评论永远显示，两种视图都不动它
    if (adapter.isPinned?.(element)) {
      ensureVisible(element)
      applied?.seen?.add(element)
      continue
    }

    const rpid = getRpid(element)
    const isBot = Boolean(verdicts.get(rpid))

    if (
      incremental &&
      applied.view === view &&
      applied.seen?.has(element) &&
      applied.map?.get(rpid) === isBot
    ) {
      continue
    }

    const flag = isBot ? '1' : '0'
    if (element.getAttribute('data-bdf-bot') !== flag) element.setAttribute('data-bdf-bot', flag)
    const shouldHide = view === 'fish' ? !isBot : isBot
    if (shouldHide) hideElement(element)
    else showElement(element)
    applied?.seen?.add(element)
  }

  if (incremental) {
    applied.view = view
    applied.map = new Map(verdicts)
  }
}

function buildPanel(document, settings, handlers) {
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.style.cssText = 'position:fixed;right:16px;bottom:72px;z-index:2147483647'

  const shadow = panel.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>${STYLE}${STYLE_PANEL}</style>
    <div class="bdf-panel" hidden>
      <div class="bdf-card">
        <div class="bdf-card-title">大肥鱼过滤</div>
        <label class="bdf-row"><input type="checkbox" class="bdf-enabled"> 在「最热 / 最新」里隐藏</label>
        <label class="bdf-row">判定强度
          <select class="bdf-preset">
            <option value="standard">标准（少误杀）</option>
            <option value="aggressive">激进（宁可多抓）</option>
          </select>
        </label>
        <div class="bdf-row">
          <input class="bdf-name-input" placeholder="用户名全称，加入黑/白名单" />
        </div>
        <div class="bdf-row">
          <button type="button" class="bdf-add-black">加入黑名单</button>
          <button type="button" class="bdf-add-white">加入白名单</button>
        </div>
        <div class="bdf-namelists"></div>
        <div class="bdf-words">
          <div class="bdf-row">
            <input class="bdf-word-input" placeholder="屏蔽词：昵称或正文包含增加屏蔽分数" />
            <button type="button" class="bdf-word-add">添加</button>
          </div>
          <div class="bdf-word-list"></div>
        </div>
        <div class="bdf-hint">依据：昵称（大肥鱼 / 鲸鱼娘 / 本鱼 / DeepSeek）+ 角色化文风 + 跨账号复读。</div>
      </div>
    </div>`

  const wrapper = shadow.querySelector('.bdf-panel')
  const enabled = shadow.querySelector('.bdf-enabled')
  const preset = shadow.querySelector('.bdf-preset')
  const nameInput = shadow.querySelector('.bdf-name-input')
  const addBlack = shadow.querySelector('.bdf-add-black')
  const addWhite = shadow.querySelector('.bdf-add-white')
  const namelists = shadow.querySelector('.bdf-namelists')
  const wordInput = shadow.querySelector('.bdf-word-input')
  const wordAdd = shadow.querySelector('.bdf-word-add')
  const wordList = shadow.querySelector('.bdf-word-list')

  enabled.checked = settings.enabled !== false
  preset.value = settings.preset === 'aggressive' ? 'aggressive' : 'standard'

  const onEnabled = () => handlers.onToggle?.(enabled.checked)
  const onPreset = () => handlers.onPresetChange?.(preset.value)
  enabled.addEventListener('change', onEnabled)
  preset.addEventListener('change', onPreset)

  const refreshWords = () => {
    const words = handlers.getWords?.() ?? []
    wordList.innerHTML = ''
    for (const word of words) {
      const chip = document.createElement('span')
      chip.className = 'bdf-word'
      chip.textContent = word
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'bdf-word-x'
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        handlers.onRemoveWord?.(word)
        refreshWords()
      })
      chip.appendChild(remove)
      wordList.appendChild(chip)
    }
  }

  const refreshLists = () => {
    const { white = [], black = [] } = handlers.getLists?.() ?? {}
    namelists.innerHTML = ''
    const section = (title, rows) => {
      if (!rows.length) return
      const box = document.createElement('div')
      box.className = 'bdf-list'
      const head = document.createElement('div')
      head.className = 'bdf-list-title'
      head.textContent = title
      box.appendChild(head)
      for (const item of rows) {
        const row = document.createElement('div')
        row.className = 'bdf-item'
        const name = document.createElement('span')
        name.className = 'bdf-item-name'
        name.textContent = item.uname || item.mid || item.key
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'bdf-label'
        button.textContent = '移除'
        button.addEventListener('click', () => {
          handlers.onRemove?.(item.key)
          refreshLists()
        })
        row.append(name, button)
        box.appendChild(row)
      }
      namelists.appendChild(box)
    }
    section('黑名单（永远隐藏）', black)
    section('白名单（永远显示）', white)
  }

  const addToList = (verdict) => {
    const value = nameInput.value.trim()
    if (!value) return
    handlers.onAddName?.(value, verdict)
    nameInput.value = ''
    refreshLists()
  }
  const onAddBlack = () => addToList('bot')
  const onAddWhite = () => addToList('human')
  const onNameKey = (event) => {
    if (event.key === 'Enter') addToList('bot')
  }
  addBlack.addEventListener('click', onAddBlack)
  addWhite.addEventListener('click', onAddWhite)
  nameInput.addEventListener('keydown', onNameKey)

  const onWordAdd = () => {
    const value = wordInput.value.trim()
    if (!value) return
    handlers.onAddWord?.(value)
    wordInput.value = ''
    refreshWords()
  }
  const onWordKey = (event) => {
    if (event.key === 'Enter') onWordAdd()
  }
  wordAdd.addEventListener('click', onWordAdd)
  wordInput.addEventListener('keydown', onWordKey)

  return {
    element: panel,
    toggle() {
      wrapper.hidden = !wrapper.hidden
      if (!wrapper.hidden) {
        refreshLists()
        refreshWords()
      }
    },
    refreshLists,
    dispose() {
      enabled.removeEventListener('change', onEnabled)
      preset.removeEventListener('change', onPreset)
      nameInput.removeEventListener('keydown', onNameKey)
      wordInput.removeEventListener('keydown', onWordKey)
      addBlack.removeEventListener('click', onAddBlack)
      addWhite.removeEventListener('click', onAddWhite)
      wordAdd.removeEventListener('click', onWordAdd)
      panel.remove()
    },
  }
}

/** 注入「大肥鱼」tab（内联在排序行）与设置面板。 */
function mountControls({
  adapter,
  document,
  settings = {},
  onViewChange = () => {},
  onToggle = () => {},
  onPresetChange = () => {},
  onAddName = () => {},
  onRemove = () => {},
  getLists = () => ({ white: [], black: [] }),
  getWords = () => [],
  onAddWord = () => {},
  onRemoveWord = () => {},
}) {
  document.querySelector(`#${SLOT_ID}`)?.remove()
  document.querySelector(`#${PANEL_ID}`)?.remove()

  const slot = document.createElement('span')
  slot.id = SLOT_ID
  slot.style.cssText = 'display:inline-flex;align-items:center;gap:2px;margin-left:6px'

  const shadow = slot.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <button type="button" class="bdf-tab">大肥鱼<span class="bdf-count">0</span></button>
    <button type="button" class="bdf-gear" title="大肥鱼设置">设置</button>`

  const tab = shadow.querySelector('.bdf-tab')
  const count = shadow.querySelector('.bdf-count')
  const gear = shadow.querySelector('.bdf-gear')

  const row = adapter.getSortRow?.() ?? null
  if (row) row.appendChild(slot)
  else document.body.appendChild(slot)

  let panel = null
  function ensurePanel() {
    if (!panel) {
      panel = buildPanel(document, settings, {
        onToggle,
        onPresetChange,
        onAddName,
        onRemove,
        getLists,
        getWords,
        onAddWord,
        onRemoveWord,
      })
      document.body.appendChild(panel.element)
    }
    return panel
  }

  let fishActive = false
  function setActive(active) {
    fishActive = Boolean(active)
    tab.classList.toggle('is-active', fishActive)
  }

  const onDocumentClick = (event) => {
    const path = event.composedPath?.() ?? []
    if (path.includes(tab)) {
      event.stopPropagation()
      const next = fishActive ? 'hot' : 'fish'
      setActive(next === 'fish')
      onViewChange(next)
      return
    }
    if (path.includes(gear)) {
      event.stopPropagation()
      ensurePanel().toggle()
      return
    }
    const text = String(event.target?.textContent ?? '').trim()
    if (text === '最热' || text === '热门') {
      setActive(false)
      onViewChange('hot')
    } else if (text === '最新') {
      setActive(false)
      onViewChange('new')
    }
  }
  document.addEventListener('click', onDocumentClick, true)

  function setBadge(value) {
    count.textContent = String(Number(value) || 0)
  }

  function dispose() {
    document.removeEventListener('click', onDocumentClick, true)
    panel?.dispose()
    slot.remove()
  }

  return {
    tab,
    count,
    get panel() {
      return panel
    },
    setBadge,
    setActive,
    refreshLists: () => panel?.refreshLists?.(),
    dispose,
  }
}

Object.assign(exports, { applyView, mountControls });
});

__require("src/main.js");
})();

import { detectAdapter, degrade } from './adapters/index.js'
import { queryDeepOne, queryDeep, onShadowCreated, nearListEnd } from './adapters/shadow.js'
import { scanCommentsOnce, classifyComment } from './core/score.js'
import { detectDuplicate } from './core/repeat.js'
import { createStore, createDb } from './core/store.js'
import { DEBUG } from './core/debug.js'
import { applyView, mountControls } from './ui/mount.js'

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
export function boot({ window: win = globalThis.window, storage } = {}) {
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
export function start({ window: win = globalThis.window, watchRoute = true } = {}) {
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

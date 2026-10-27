import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { detectAdapter } from '../src/adapters/index.js'
import { findTabRow, nearBottom, distanceToBottom, nearListEnd } from '../src/adapters/shadow.js'

function fixtureHtml(name) {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')
}

function deepUnmaterialized(root) {
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.hasAttribute('data-bdf-shadow')) {
        if (!el.shadowRoot) return el
        const nested = walk(el.shadowRoot)
        if (nested) return nested
        continue
      }
      if (el.shadowRoot) {
        const hit = walk(el.shadowRoot)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(root)
}

/** 把 fixture 里带 data-bdf-shadow 的元素真正变成 shadow 宿主（HTML 无法声明 shadow 树）。 */
function materializeShadows(document) {
  let host = deepUnmaterialized(document)
  while (host) {
    const shadow = host.attachShadow({ mode: 'open' })
    while (host.firstChild) shadow.appendChild(host.firstChild)
    host = deepUnmaterialized(document)
  }
}

function mount(name) {
  const dom = new JSDOM(fixtureHtml(name))
  const { document } = dom.window
  materializeShadows(document)
  return { dom, document }
}

test('v3：识别 bili-comments + Shadow DOM，主评论 2 条', () => {
  const { document } = mount('v3')
  const adapter = detectAdapter(document)
  assert.equal(adapter?.name, 'v3')
  assert.equal(adapter.listComments().length, 2)
})

test('v3：优先读 el.__data', () => {
  const { document } = mount('v3')
  const adapter = detectAdapter(document)
  const [thread] = adapter.listComments()
  thread.__data = {
    rpid_str: '9001',
    member: {
      mid: 111,
      uname: '蓝紫色大肥鱼',
      face: '//i0.hdslb.com/bfs/face/aaa.jpg',
      level_info: { current_level: 2 },
    },
    content: { message: '来自 __data 的正文' },
  }
  const signal = adapter.readComment(thread)
  assert.equal(signal.rpid, '9001')
  assert.equal(signal.mid, '111')
  assert.equal(signal.uname, '蓝紫色大肥鱼')
  assert.equal(signal.message, '来自 __data 的正文')
  assert.equal(signal.level, 2)
  assert.match(signal.faceUrl, /aaa\.jpg$/)
})

test('v3：没有 __data 时走 DOM 兜底', () => {
  const { document } = mount('v3')
  const adapter = detectAdapter(document)
  const signal = adapter.readComment(adapter.listComments()[1])
  assert.equal(signal.mid, '222')
  assert.equal(signal.uname, '鲸鱼娘0705')
  assert.match(signal.message, /本鱼不接这活/)
  assert.equal(signal.level, 1)
  assert.match(signal.faceUrl, /bbb\.jpg$/)
})

test('v3：DOM 兜底时 rpid 不塌缩（没有 data-id 也能区分两条）', () => {
  const { document } = mount('v3')
  const adapter = detectAdapter(document)
  const signals = adapter.listComments().map((el) => adapter.readComment(el))
  assert.ok(signals.every((s) => s.rpid), 'rpid 不能为空')
  assert.notEqual(signals[0].rpid, signals[1].rpid)
})

test('v3：排序行能被文本锚点找到', () => {
  const { document } = mount('v3')
  const adapter = detectAdapter(document)
  const row = adapter.getSortRow()
  assert.ok(row, '应找到最热/最新所在行')
  assert.match(row.textContent, /最热/)
  assert.match(row.textContent, /最新/)
})

test('v2：识别 .bili-comment 并抽取 2 条主评论', () => {
  const { document } = mount('v2')
  const adapter = detectAdapter(document)
  assert.equal(adapter?.name, 'v2')
  const comments = adapter.listComments()
  assert.equal(comments.length, 2)
  const signal = adapter.readComment(comments[0])
  assert.equal(signal.mid, '222')
  assert.equal(signal.uname, '鲸鱼娘0705')
  assert.match(signal.message, /本鱼不接这活/)
  assert.match(signal.faceUrl, /bbb\.jpg$/)
})

test('v2：楼中楼不算主评论', () => {
  const { document } = mount('v2')
  const adapter = detectAdapter(document)
  const signals = adapter.listComments().map((el) => adapter.readComment(el))
  assert.equal(signals.length, 2)
  assert.ok(signals.every((s) => !s.message.includes('楼中楼')))
})

test('v1：识别 .bb-comment，排除楼中楼，能点到「查看更多」', () => {
  const { document } = mount('v1')
  const adapter = detectAdapter(document)
  assert.equal(adapter?.name, 'v1')
  const comments = adapter.listComments()
  assert.equal(comments.length, 2)
  assert.equal(adapter.readComment(comments[0]).mid, '333')

  let clicked = 0
  document.querySelector('.view-more').addEventListener('click', () => {
    clicked += 1
  })
  assert.equal(adapter.loadMore(), true)
  assert.equal(clicked, 1)
})

test('找不到评论区时返回 null（用于降级）', () => {
  const { document } = new JSDOM('<div id="nothing">没有评论区</div>').window
  assert.equal(detectAdapter(document), null)
})

test('findTabRow 取最热/最新父节点', () => {
  const { document } = mount('v1')
  const row = findTabRow(document)
  assert.ok(row)
  assert.equal(row.className, 'tabs')
})

test('v2：有「点击查看更多」时只点按钮，不滚动页面', () => {
  const { dom, document } = mount('v2')
  const more = document.createElement('div')
  more.textContent = '点击查看更多'
  document.querySelector('.reply-list').appendChild(more)
  let clicked = 0
  more.addEventListener('click', () => {
    clicked += 1
  })
  let pageScrolls = 0
  dom.window.scrollTo = () => {
    pageScrolls += 1
  }
  const adapter = detectAdapter(document)
  assert.equal(adapter.loadMore(), true)
  assert.equal(clicked, 1)
  assert.equal(pageScrolls, 0)
})

test('v2：没有按钮时只把最后一条评论滚进视野，不整页跳底部', () => {
  const { dom, document } = mount('v2')
  let pageScrolls = 0
  dom.window.scrollTo = () => {
    pageScrolls += 1
  }
  const adapter = detectAdapter(document)
  const comments = adapter.listComments()
  let scrolled = 0
  comments[comments.length - 1].scrollIntoView = () => {
    scrolled += 1
  }
  assert.equal(adapter.loadMore(), true)
  assert.equal(scrolled, 1)
  assert.equal(pageScrolls, 0)
})

test('isPinned：识别「置顶」标签，忽略正文里的置顶二字', () => {
  const { document } = mount('v2')
  const adapter = detectAdapter(document)
  const [first] = adapter.listComments()
  assert.equal(adapter.isPinned(first), false)

  const tag = document.createElement('span')
  tag.textContent = '置顶'
  first.prepend(tag)
  assert.equal(adapter.isPinned(first), true)
})

test('nearBottom：距离底部 900px 内算接近', () => {
  assert.equal(distanceToBottom({ scrollY: 0, innerHeight: 800, scrollHeight: 1500 }), 700)
  assert.equal(nearBottom({ scrollY: 0, innerHeight: 800, scrollHeight: 1500 }, 900), true)
  assert.equal(nearBottom({ scrollY: 0, innerHeight: 800, scrollHeight: 2000 }, 900), false)
  assert.equal(nearBottom({ scrollY: 400, innerHeight: 800, scrollHeight: 2000 }, 900), true)
})

test('silent 模式：只点加载更多，不滚动页面', () => {
  const { dom, document } = mount('v2')
  const more = document.createElement('div')
  more.textContent = '点击查看更多'
  document.querySelector('.reply-list').appendChild(more)
  let clicked = 0
  more.addEventListener('click', () => {
    clicked += 1
  })
  let scrolls = 0
  dom.window.scrollTo = () => {
    scrolls += 1
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {
    scrolls += 1
  }
  const adapter = detectAdapter(document)
  assert.equal(adapter.loadMore({ silent: true }), true)
  assert.equal(clicked, 1)
  assert.equal(scrolls, 0)
})

test('silent 模式：没有按钮时不做任何事（不乱滚）', () => {
  const { dom, document } = mount('v2')
  let scrolls = 0
  dom.window.scrollTo = () => {
    scrolls += 1
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {
    scrolls += 1
  }
  const adapter = detectAdapter(document)
  assert.equal(adapter.loadMore({ silent: true }), false)
  assert.equal(scrolls, 0)
})

test('nearListEnd：按最后一条评论的位置判断，提前一屏半就触发', () => {
  assert.equal(nearListEnd({ bottom: 1200 }, 800, 700), true)
  assert.equal(nearListEnd({ bottom: 1600 }, 800, 700), false)
  assert.equal(nearListEnd({ bottom: 0 }, 800, 700), false)
  assert.equal(nearListEnd(null, 800, 700), false)
  // 1.5 屏：视口 800 → margin 1200，最后一条在视口下 1500 也算接近
  assert.equal(nearListEnd({ bottom: 1500 }, 800, 1200), true)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { detectAdapter } from '../src/adapters/index.js'
import { mountControls, applyView } from '../src/ui/mount.js'
import { boot, start } from '../src/main.js'

function mount(name) {
  const html = readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')
  const dom = new JSDOM(html)
  return { dom, document: dom.window.document }
}

function adapterOf(document) {
  const adapter = detectAdapter(document)
  assert.ok(adapter)
  return adapter
}

test('注入「大肥鱼」tab：内联在排序行里', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  mountControls({ adapter, document, onViewChange: () => {} })
  const slot = document.querySelector('#bdf-slot')
  assert.ok(slot)
  assert.ok(slot.closest('.reply-sort'), 'tab 应贴在排序行')
  assert.ok(slot.shadowRoot.querySelector('.bdf-tab'))
})


test('重复注入保持幂等（只剩一个 slot）', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  mountControls({ adapter, document, onViewChange: () => {} })
  mountControls({ adapter, document, onViewChange: () => {} })
  assert.equal(document.querySelectorAll('#bdf-slot').length, 1)
})

test('点击大肥鱼触发视图切换', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  const views = []
  const ui = mountControls({ adapter, document, onViewChange: (view) => views.push(view) })
  ui.tab.click()
  assert.deepEqual(views, ['fish'])
})

test('点原生「最新」tab 会切回 new 视图', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  const views = []
  mountControls({ adapter, document, onViewChange: (view) => views.push(view) })
  const tabs = [...adapter.getSortRow().querySelectorAll('span')]
  tabs.find((el) => el.textContent.trim() === '最新').click()
  assert.deepEqual(views, ['new'])
})

test('徽标显示命中数', () => {
  const { document } = mount('v2')
  const ui = mountControls({ adapter: adapterOf(document), document, onViewChange: () => {} })
  ui.setBadge(3)
  assert.equal(ui.count.textContent, '3')
})


test('applyView：最热/最新隐藏机器人主评论，楼中楼不动', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  const comments = adapter.listComments()
  const verdicts = new Map([
    ['201', true],
    ['202', false],
  ])

  applyView({ adapter, verdicts, view: 'hot' })
  assert.equal(adapter.root.getAttribute('data-bdf-view'), 'hot')
  assert.equal(comments[0].getAttribute('data-bdf-bot'), '1')
  assert.equal(comments[0].style.display, 'none')
  assert.notEqual(comments[1].style.display, 'none')
  const reply = comments[0].querySelector('.sub-reply-item')
  assert.notEqual(reply.style.display, 'none')

  applyView({ adapter, verdicts, view: 'fish' })
  assert.equal(adapter.root.getAttribute('data-bdf-view'), 'fish')
  assert.notEqual(comments[0].style.display, 'none')
  assert.equal(comments[1].style.display, 'none')

  applyView({ adapter, verdicts, view: 'off' })
  assert.equal(adapter.root.hasAttribute('data-bdf-view'), false)
  assert.equal(comments[0].hasAttribute('data-bdf-bot'), false)
  assert.notEqual(comments[0].style.display, 'none')
  assert.notEqual(comments[1].style.display, 'none')
})

test('applyView：判定还没算出来时不动任何评论', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  const comments = adapter.listComments()
  applyView({ adapter, verdicts: new Map(), view: 'hot' })
  assert.equal(comments[0].hasAttribute('data-bdf-bot'), false)
  assert.notEqual(comments[0].style.display, 'none')
})

test('面板总开关能触发回调', () => {
  const { document } = mount('v2')
  const toggles = []
  mountControls({
    adapter: adapterOf(document),
    document,
    onViewChange: () => {},
    onToggle: (enabled) => toggles.push(enabled),
    settings: { enabled: true, preset: 'standard' },
  })
  const panel = document.querySelector('#bdf-panel')
  assert.ok(panel)
  const checkbox = panel.shadowRoot.querySelector('.bdf-enabled')
  assert.equal(checkbox.checked, true)
  checkbox.checked = false
  checkbox.dispatchEvent(new document.defaultView.Event('change'))
  assert.deepEqual(toggles, [false])
})

test('dispose 会移除 tab 与面板', () => {
  const { document } = mount('v2')
  const ui = mountControls({ adapter: adapterOf(document), document, onViewChange: () => {} })
  ui.dispose()
  assert.equal(document.querySelector('#bdf-slot'), null)
  assert.equal(document.querySelector('#bdf-panel'), null)
})

// —— boot / start：装配层 ——

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
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

test('boot：自动判定并隐藏机器人主评论', () => {
  const { dom, document } = mount('v2')
  const controller = boot({ window: dom.window, storage: memoryStorage() })
  assert.ok(controller)
  const comments = controller.adapter.listComments()
  assert.equal(comments[0].getAttribute('data-bdf-bot'), '1')
  assert.equal(comments[0].style.display, 'none')
  assert.notEqual(comments[1].style.display, 'none')
  controller.destroy()
})

test('boot：没有评论区时退化为原样并只 warn', () => {
  const dom = new JSDOM('<div id="nothing">空页面</div>')
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const controller = boot({ window: dom.window, storage: memoryStorage() })
    assert.equal(controller, null)
    assert.equal(dom.window.document.querySelector('#bdf-slot'), null)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /\[bdf\]/)
  } finally {
    console.warn = original
  }
})

test('boot：总开关关闭时不改页面', () => {
  const { dom } = mount('v2')
  const controller = boot({
    window: dom.window,
    storage: memoryStorage({ 'bdf.settings': JSON.stringify({ enabled: false }) }),
  })
  const comments = controller.adapter.listComments()
  assert.equal(comments[0].hasAttribute('data-bdf-bot'), false)
  assert.notEqual(comments[0].style.display, 'none')
  controller.destroy()
})

test('boot：人工标「真人」后不再隐藏', () => {
  const { dom } = mount('v2')
  const controller = boot({
    window: dom.window,
    storage: memoryStorage({ 'bdf.labels': JSON.stringify({ 222: { mid: '222', verdict: 'human' } }) }),
  })
  const comments = controller.adapter.listComments()
  assert.notEqual(comments[0].style.display, 'none')
  controller.destroy()
})

test('boot：重复调用只注入一个 tab', () => {
  const { dom, document } = mount('v2')
  const first = boot({ window: dom.window, storage: memoryStorage() })
  const second = boot({ window: dom.window, storage: memoryStorage() })
  assert.equal(document.querySelectorAll('#bdf-slot').length, 1)
  first?.destroy()
  second?.destroy()
})

test('start：非视频页不注入，但保留监听（SPA 进视频页后再生效）', () => {
  const dom = new JSDOM('<div class="bili-comment"></div>', { url: 'https://www.bilibili.com/' })
  const handle = start({ window: dom.window, watchRoute: false })
  try {
    assert.ok(handle)
    assert.equal(handle.controller, null)
    assert.equal(dom.window.document.querySelector('#bdf-slot'), null)
  } finally {
    handle.destroy()
    dom.window.close()
  }
})

test('面板名单：输入用户名全称可加入白名单/黑名单', () => {
  const { document } = mount('v2')
  const adapter = adapterOf(document)
  const added = []
  mountControls({
    adapter,
    document,
    onViewChange: () => {},
    onAddName: (name, verdict) => added.push([name, verdict]),
  })
  document.querySelector('#bdf-slot').shadowRoot.querySelector('.bdf-gear').click()
  const panel = document.querySelector('#bdf-panel')
  const input = panel.shadowRoot.querySelector('.bdf-name-input')
  input.value = '鲸鱼娘0705'
  panel.shadowRoot.querySelector('.bdf-add-white').click()
  input.value = '路人甲'
  panel.shadowRoot.querySelector('.bdf-add-black').click()
  assert.deepEqual(added, [
    ['鲸鱼娘0705', 'human'],
    ['路人甲', 'bot'],
  ])
})

test('boot：把机器人作者加入白名单后评论立刻恢复显示', () => {
  const { dom } = mount('v2')
  const controller = boot({ window: dom.window, storage: memoryStorage() })
  try {
    const document = dom.window.document
    const comments = controller.adapter.listComments()
    assert.equal(comments[0].style.display, 'none')

    document.querySelector('#bdf-slot').shadowRoot.querySelector('.bdf-gear').click()
    const panel = document.querySelector('#bdf-panel')
    const input = panel.shadowRoot.querySelector('.bdf-name-input')
    input.value = '鲸鱼娘0705'
    panel.shadowRoot.querySelector('.bdf-add-white').click()

    assert.notEqual(comments[0].style.display, 'none')
    const names = [...panel.shadowRoot.querySelectorAll('.bdf-item-name')].map((el) => el.textContent)
    assert.ok(names.includes('鲸鱼娘0705'), names.join(','))
  } finally {
    controller.destroy()
    dom.window.close()
  }
})

test('start：评论区晚于脚本挂载也能生效（异步挂载）', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://www.bilibili.com/video/BV1xx411c7mD' })
  const html = readFileSync(new URL('./fixtures/v2.html', import.meta.url), 'utf8')
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1]
  const ctrl = start({ window: dom.window })
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    dom.window.document.getElementById('app').innerHTML = body
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok(dom.window.document.querySelector('#bdf-slot'), '迟到的评论区也应注入 tab')
  } finally {
    ctrl.destroy()
    dom.window.close()
  }
})

test('start：首页 SPA 跳到视频页后自动生效（不重新加载页面）', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://www.bilibili.com/' })
  const html = readFileSync(new URL('./fixtures/v2.html', import.meta.url), 'utf8')
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1]
  const handle = start({ window: dom.window })
  try {
    dom.reconfigure({ url: 'https://www.bilibili.com/video/BV1xx411c7mD' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    dom.window.document.getElementById('app').innerHTML = body
    await new Promise((resolve) => setTimeout(resolve, 1800))
    assert.ok(dom.window.document.querySelector('#bdf-slot'), 'SPA 进视频页后应注入 tab')
  } finally {
    handle.destroy()
    dom.window.close()
  }
})



test('置顶评论：最热和大肥鱼里都始终显示', () => {
  const { dom } = mount('v2')
  const controller = boot({ window: dom.window, storage: memoryStorage() })
  try {
    const document = dom.window.document
    const comments = controller.adapter.listComments()
    // 给“真人”那条打上置顶标记，再让规则把它判成机器人也不该被隐藏
    const tag = document.createElement('span')
    tag.textContent = '置顶'
    comments[1].prepend(tag)
    controller.compute()
    controller.render()

    assert.notEqual(comments[1].style.display, 'none', '最热里置顶应显示')
    document.querySelector('#bdf-slot').shadowRoot.querySelector('.bdf-tab').click()
    assert.notEqual(comments[1].style.display, 'none', '大肥鱼里置顶也应显示')
  } finally {
    controller.destroy()
    dom.window.close()
  }
})

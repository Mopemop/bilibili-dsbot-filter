import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, createDb, DEFAULT_SETTINGS, DB_KEY } from '../src/core/store.js'

class MemoryStorage {
  constructor() {
    this.map = new Map()
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    this.map.set(key, String(value))
  }
  removeItem(key) {
    this.map.delete(key)
  }
  key(index) {
    return [...this.map.keys()][index] ?? null
  }
  get length() {
    return this.map.size
  }
}

function makeStore(now = () => 1_800_000_000_000) {
  const storage = new MemoryStorage()
  return { storage, store: createStore(storage, { now }) }
}

test('空存储时给出默认设置', () => {
  const { store } = makeStore()
  assert.deepEqual(store.loadSettings(), DEFAULT_SETTINGS)
})

test('saveSettings 合并并持久化', () => {
  const { store } = makeStore()
  const next = store.saveSettings({ enabled: false, preset: 'aggressive' })
  assert.equal(next.enabled, false)
  assert.equal(next.preset, 'aggressive')
  assert.equal(store.loadSettings().enabled, false)
})

test('version 迁移：旧版本数据补默认值并升版', () => {
  const { storage, store } = makeStore()
  storage.setItem('bdf.settings', JSON.stringify({ version: 0, enabled: false }))
  const settings = store.loadSettings()
  assert.equal(settings.version, DEFAULT_SETTINGS.version)
  assert.equal(settings.enabled, false)
  assert.equal(settings.preset, DEFAULT_SETTINGS.preset)
})

test('非法 preset 被纠正', () => {
  const { storage, store } = makeStore()
  storage.setItem('bdf.settings', JSON.stringify({ preset: 'crazy' }))
  assert.equal(store.loadSettings().preset, 'standard')
})

test('人工标签按 mid 存取，且能导出 map', () => {
  const { store } = makeStore()
  assert.equal(store.getLabel('111'), null)
  store.setLabel('111', 'human')
  assert.equal(store.getLabel('111'), 'human')
  assert.deepEqual(store.labelMap(), { 111: 'human' })
})

test('人工标签：非法 verdict 被忽略', () => {
  const { store } = makeStore()
  assert.equal(store.setLabel('111', 'maybe'), null)
  assert.equal(store.getLabel('111'), null)
})




test('clearAll 清空所有 bdf.* 键', () => {
  const { storage, store } = makeStore()
  store.saveSettings({ enabled: false })
  store.setLabel('111', 'bot')
  store.clearAll()
  assert.equal(storage.length, 0)
})

// —— 手动白/黑名单（GM / localStorage）——

test('名单：加入黑名单后按 mid 生效', () => {
  const db = createDb({ storage: new MemoryStorage() })
  db.setAccount('111', 'bot', { uname: '蓝紫色大肥鱼' })
  assert.equal(db.accountVerdict('111'), 'bot')
  assert.equal(db.list('bot')[0].uname, '蓝紫色大肥鱼')
})

test('名单：白名单覆盖黑名单（同一 mid 后写为准）', () => {
  const db = createDb({ storage: new MemoryStorage() })
  db.setAccount('111', 'bot')
  db.setAccount('111', 'human')
  assert.equal(db.accountVerdict('111'), 'human')
  assert.equal(db.list('bot').length, 0)
  assert.equal(db.list('human').length, 1)
})

test('名单：移除与清空', () => {
  const db = createDb({ storage: new MemoryStorage() })
  db.setAccount('111', 'bot')
  db.setAccount('222', 'human')
  db.removeAccount('111')
  assert.equal(db.accountVerdict('111'), null)
  assert.equal(db.list('human').length, 1)
  db.clear()
  assert.equal(db.list('human').length, 0)
})

test('名单：优先用 GM 存储', () => {
  const gmv = new Map()
  const db = createDb({
    gm: { get: (k) => gmv.get(k) ?? null, set: (k, v) => gmv.set(k, v) },
    storage: new MemoryStorage(),
  })
  db.setAccount('111', 'bot', { uname: '鱼' })
  assert.ok(gmv.has(DB_KEY))
})

test('屏蔽词：添加去重、移除、持久化', () => {
  const { storage, store } = makeStore()
  store.addWord(' 广告 ')
  store.addWord('广告')
  store.addWord('代刷')
  assert.deepEqual(store.words(), ['代刷', '广告'])
  store.removeWord('广告')
  assert.deepEqual(store.words(), ['代刷'])
  const again = createStore(storage)
  assert.deepEqual(again.words(), ['代刷'])
})

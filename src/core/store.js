/**
 * 本地存储：设置、手动名单（白/黑名单）。
 * 判定结果每次重算，不落盘。
 */

const PREFIX = 'bdf.'
export const CURRENT_VERSION = 1
export const DB_KEY = 'bdf.namelist.v1'

export const DEFAULT_SETTINGS = {
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

export function createStore(storage) {
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
export function createDb({ gm, storage } = {}) {
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

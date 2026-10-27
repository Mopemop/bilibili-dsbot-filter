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
  .bdf-card { background: #fff; color: #18191c; border-radius: 8px; padding: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.18); font-size: 13px; width: 260px; font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  .bdf-card-title { font-weight: 600; margin-bottom: 8px; }
  .bdf-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
  .bdf-row select { margin-left: auto; }
  .bdf-hint { color: #9499a0; font-size: 11px; line-height: 1.5; margin-top: 8px; }
  .bdf-list { margin-top: 8px; border-top: 1px solid #f1f2f3; padding-top: 6px; max-height: 180px; overflow: auto; }
  .bdf-list-title { color: #9499a0; font-size: 11px; margin-bottom: 4px; }
  .bdf-item { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .bdf-item-name { color: #18191c; max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bdf-item-text { color: #9499a0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .bdf-panel[hidden] { display: none; }
`

const ORIGINAL_DISPLAY = new WeakMap()

function hideElement(element) {
  if (!ORIGINAL_DISPLAY.has(element)) ORIGINAL_DISPLAY.set(element, element.style.display)
  element.style.display = 'none'
  element.dataset.bdfHidden = '1'
}

function showElement(element) {
  if (!ORIGINAL_DISPLAY.has(element)) {
    if (element.dataset?.bdfHidden) {
      element.style.display = ''
      delete element.dataset.bdfHidden
    }
    return
  }
  element.style.display = ORIGINAL_DISPLAY.get(element) ?? ''
  delete element.dataset.bdfHidden
  ORIGINAL_DISPLAY.delete(element)
}

/**
 * 落判定结果。view='fish' 时只留机器人主评论（楼中楼在原节点里，天然保留）。
 * @param {{adapter:object, verdicts?:Map<string,boolean>, view?:'hot'|'new'|'fish'|'off'}} args
 */
export function applyView({ adapter, verdicts = new Map(), view = 'hot' }) {
  const root = adapter?.root
  if (!root) return
  if (view === 'off') root.removeAttribute('data-bdf-view')
  else root.setAttribute('data-bdf-view', view)

  const hasVerdicts = Boolean(verdicts?.size)
  for (const element of adapter.listComments?.() ?? []) {
    if (view === 'off' || !hasVerdicts) {
      element.removeAttribute('data-bdf-bot')
      // 强制显示：可能被旧版本 / 上一次运行隐藏过
      element.style.display = ''
      delete element.dataset.bdfHidden
      showElement(element)
      continue
    }
    const { rpid } = adapter.readComment(element)
    const isBot = Boolean(verdicts.get(rpid))
    element.setAttribute('data-bdf-bot', isBot ? '1' : '0')
    const shouldHide = view === 'fish' ? !isBot : isBot
    if (shouldHide) hideElement(element)
    else showElement(element)
  }
}

function buildPanel(document, settings, handlers) {
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.style.cssText = 'position:fixed;right:16px;bottom:72px;z-index:2147483647'

  const shadow = panel.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>${STYLE}</style>
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
  const namelists = shadow.querySelector('.bdf-namelists')
  const nameInput = shadow.querySelector('.bdf-name-input')
  const addBlack = shadow.querySelector('.bdf-add-black')
  const addWhite = shadow.querySelector('.bdf-add-white')
  const wordInput = shadow.querySelector('.bdf-word-input')
  const wordAdd = shadow.querySelector('.bdf-word-add')
  const wordList = shadow.querySelector('.bdf-word-list')

  enabled.checked = settings.enabled !== false
  preset.value = settings.preset === 'aggressive' ? 'aggressive' : 'standard'

  const onEnabled = () => handlers.onToggle?.(enabled.checked)
  const onPreset = () => handlers.onPresetChange?.(preset.value)
  enabled.addEventListener('change', onEnabled)
  preset.addEventListener('change', onPreset)

  function refreshWords() {
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

  function refreshLists() {
    if (wrapper.hidden) return
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

  const onAddToList = (verdict) => {
    const value = nameInput.value.trim()
    if (!value) return
    handlers.onAddName?.(value, verdict)
    nameInput.value = ''
    refreshLists()
  }
  const onAddBlack = () => onAddToList('bot')
  const onAddWhite = () => onAddToList('human')
  const onNameKey = (event) => {
    if (event.key === 'Enter') onAddToList('bot')
  }
  addBlack.addEventListener('click', onAddBlack)
  addWhite.addEventListener('click', onAddWhite)
  nameInput.addEventListener('keydown', onNameKey)

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
      addBlack.removeEventListener('click', onAddBlack)
      addWhite.removeEventListener('click', onAddWhite)
      nameInput.removeEventListener('keydown', onNameKey)
      wordAdd.removeEventListener('click', onWordAdd)
      wordInput.removeEventListener('keydown', onWordKey)
      panel.remove()
    },
  }
}

/** 注入「大肥鱼」tab（内联在排序行）与设置面板。 */
export function mountControls({
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

  const panel = buildPanel(document, settings, {
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
      panel.toggle()
      return
    }
    // 点原生「最热 / 最新 / 热门」时同步视图状态
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
    panel.dispose()
    slot.remove()
  }

  return {
    tab,
    count,
    panel,
    setBadge,
    setActive,
    refreshLists: panel.refreshLists,
    dispose,
  }
}

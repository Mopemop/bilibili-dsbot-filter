import { DEBUG } from '../core/debug.js'
import { v3 } from './v3.js'
import { v2 } from './v2.js'
import { v1 } from './v1.js'

/** 新版优先，旧版兜底；B 站正在灰度，三套结构可能同时存在。 */
const ADAPTERS = [v3, v2, v1]

export function detectAdapter(document) {
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
export function degrade(reason, detail) {
  if (!DEBUG) return
  try {
    console.warn(`[bdf] ${reason}`, detail ?? '')
  } catch {
    /* 控制台不可用时静默 */
  }
}

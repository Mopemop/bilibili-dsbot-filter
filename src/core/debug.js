/** 构建时注入 __BDF_DEBUG__：开发版 true，发布版 false（移除日志与诊断对象） */
export const DEBUG = typeof __BDF_DEBUG__ === 'undefined' ? true : Boolean(__BDF_DEBUG__)

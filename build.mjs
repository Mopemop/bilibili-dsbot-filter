/**
 * 打包成单文件 userscript。
 *
 * 为什么不用 esbuild：原生 esbuild 每次构建都要 spawn 一个子进程，
 * 在受限沙箱里会 EPERM；esbuild-wasm 的 initialize 在 Node 下同样会 spawn。
 * 本项目只在打包时用到「按依赖顺序拼接 ESM」这一件事，所以这里自带一个
 * 极小的打包器：解析 import / export，按模块包一层函数，运行时不依赖任何库。
 */
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))

const IMPORT_RE = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g
const EXPORT_FN_RE = /export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/g
const EXPORT_VAR_RE = /export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/g

export function bundle(entryFile, { debug = true } = {}) {
  const records = []
  const byPath = new Map()

  function load(absPath) {
    if (byPath.has(absPath)) return byPath.get(absPath).id
    const id = path.relative(here, absPath).split(path.sep).join('/')
    const record = { id, code: '' }
    byPath.set(absPath, record)
    records.push(record)

    let text = readFileSync(absPath, 'utf8')
    const prelude = []

    text = text.replace(IMPORT_RE, (_match, names, spec) => {
      if (!spec.startsWith('.')) {
        throw new Error(`不支持外部依赖：${spec}（${id}）`)
      }
      const depPath = path.resolve(path.dirname(absPath), spec)
      const depId = load(depPath)
      const bindings = names
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [original, alias] = part.split(/\s+as\s+/)
          return alias ? `${original.trim()}: ${alias.trim()}` : original.trim()
        })
        .join(', ')
      prelude.push(`const { ${bindings} } = __require(${JSON.stringify(depId)});`)
      return ''
    })

    if (/^\s*import\s/m.test(text)) throw new Error(`存在未支持的 import 形式：${id}`)

    const exported = []
    text = text.replace(EXPORT_FN_RE, (_m, asyncKw, name) => {
      exported.push(name)
      return `${asyncKw ?? ''}function ${name}`
    })
    text = text.replace(EXPORT_VAR_RE, (_m, keyword, name) => {
      exported.push(name)
      return `${keyword} ${name}`
    })

    if (/\bexport\s+(default|class|\{)/.test(text)) {
      throw new Error(`存在未支持的 export 形式：${id}`)
    }

    record.code = `${prelude.join('\n')}\n${text}\nObject.assign(exports, { ${exported.join(', ')} });`
    return id
  }

  const entryId = load(entryFile)

  const modules = records
    .map(
      (record) =>
        `__define(${JSON.stringify(record.id)}, function (exports, __require) {\n${record.code}\n});`,
    )
    .join('\n\n')

  return `(function () {
'use strict';
var __BDF_DEBUG__ = ${debug};
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

${modules}

__require(${JSON.stringify(entryId)});
})();
`
}

function banner() {
  return `// ==UserScript==
// @name         B站大肥鱼过滤器（DeepSeek 机器人）
// @name:en      Bilibili DeepSeek Bot Comment Filter
// @name:zh-CN   B站大肥鱼过滤器（DeepSeek 机器人）
// @version      ${pkg.version}
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
`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const release = process.argv.includes('--release')
  let code = bundle(path.join(here, 'src', 'main.js'), { debug: !release })
  if (release) {
    // 发布版：物理删除 bdf 的调试输出与诊断对象赋值
    code = code
      .split('\n')
      .filter((line) => !/console\.(info|warn|log)\(.*\[bdf\]/.test(line))
      .filter((line) => !/__bdf\s*=/.test(line))
      .join('\n')
  }
  const outDir = path.join(here, 'dist')
  mkdirSync(outDir, { recursive: true })
  const fileName = release ? 'bili-deepseek-filter.release.user.js' : 'bili-deepseek-filter.user.js'
  const outFile = path.join(outDir, fileName)
  writeFileSync(outFile, `${banner()}\n${code}`, 'utf8')
  const kb = (statSync(outFile).size / 1024).toFixed(1)
  console.log(`built ${path.relative(here, outFile)} (${kb} KB)${release ? ' [release: 无日志/无诊断]' : ''}`)
}

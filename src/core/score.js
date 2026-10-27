import {
  MODEL_NAME,
  LONG_MIN_LENGTH,
  FISH_STRONG_RE,
  FISH_LIFE_RE,
  FISH_WEAK,
  PERSONA,
  MASTER,
  KAOMOJI,
  AT_START,
  SEEK_APPROVAL,
  LONG_STRUCTURE,
} from './lexicon.js'
import { detectDuplicate } from './repeat.js'

/** 标准档宁可漏一点；激进档把「名字带鱼/鲸」直接判死 */
export const THRESHOLDS = { standard: 5, aggressive: 3 }
export const MAX_SCORE = 10

const clamp = (n) => Math.max(0, Math.min(MAX_SCORE, n))

/**
 * 单条主评论打分。
 * @param {{rpid?:string, mid:string, uname:string, message:string}} comment
 * @param {{preset?:'standard'|'aggressive', labels?:Record<string,'bot'|'human'>}} ctx
 * @returns {{score:number, reasons:string[], isBot:boolean}}
 */
export function classifyComment(comment, ctx = {}) {
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
    const fishMatch = FISH_STRONG_RE.exec(name)
    const fishHit = fishMatch?.[0]
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
  const lifeHits = []
  FISH_LIFE_RE.lastIndex = 0
  let lifeMatch = FISH_LIFE_RE.exec(message)
  while (lifeMatch && lifeHits.length < 3) {
    if (!lifeHits.includes(lifeMatch[0])) lifeHits.push(lifeMatch[0])
    lifeMatch = FISH_LIFE_RE.exec(message)
  }
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
export function scanCommentsOnce(comments, settings = {}) {
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

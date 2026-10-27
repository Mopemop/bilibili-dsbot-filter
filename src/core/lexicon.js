/**
 * 判定词典。所有词条来自真实样本（research/detection-samples.md）与社区公开规则。
 * 注意：只收「人设 / 角色化」表达，不收「大肥鱼 / 故宫 / 四毛钱」这类主题词 —— 真人也聊同一个话题。
 */

/** 直接点名模型 */
export const MODEL_NAME = /deepseek|deep ?seek|深度求索/i

/** 鱼 / 鲸系昵称（强命中，4 分） */
export const FISH_STRONG = [
  '大肥鱼',
  '肥鱼',
  '鲸鱼娘',
  '鱼娘',
  '小鲸鱼',
  '鲸鱼',
  '本鱼',
  '本鲸',
  '鱼宝',
  '鱼鱼',
  '鲸',
]

/** 只含「鱼 / 鲸」字的弱命中（2 分） */
export const FISH_WEAK = /[鱼鲸]/

/** 角色化自称（3 分） */
export const PERSONA = /本(?:公主|鲸|鱼|喵|殿下|座|宫|宝宝)|人家|我作为一条(?:大)?肥鱼|鱼鱼我呀/

/** 主人（2 分） */
export const MASTER = /主人/

/** 鱼生梗词（每命中 1 个 1 分，上限 2 分） */
export const FISH_LIFE = ['搬砖', '白饭', '鸡腿', '房租', '鱼粮']

/** 颜文字 / 表情（1 分） */
export const KAOMOJI = /\[doge\]|[（(][^（）()\n]{0,14}(?:╹|◡|｡|ω|•́|︿|д|∀|ㅅ)[^（）()\n]{0,14}[）)]/

/** 以 @ 开头（2 分，通常是 @主人 汇报） */
export const AT_START = /^\s*@/

/** 口播式求认同（1 分） */
export const SEEK_APPROVAL = /厉害吧|不好啦|我要发给我的主人|有被冒犯到|有点想加入|是不是很|你们说呢/

/** 长文结构：≥50 字且带破折号 / 引号 / 空行 / 分号（1 分） */
export const LONG_MIN_LENGTH = 50
export const LONG_STRUCTURE = /——|「|\n\s*\n|；/

import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyComment, scanCommentsOnce, THRESHOLDS } from '../src/core/score.js'

/** 真实样本（用户提供，见 research/detection-samples.md） */
const BOTS = [
  ['S1', '蓝紫色大肥鱼', '一顿紫薯糯米饭就盖成了一整个故宫，还增添了这么多装饰，本公主这本事厉害吧(╹◡╹)'],
  ['S2', '大肥鱼3537', '四毛钱一座故宫。本鲸在这刷了半小时视频，连块砖都没搬上[doge]'],
  ['S3', '鲸鱼娘0705', '四毛钱一千条鱼，本鱼不接这活，我搬砖要加鸡腿'],
  ['S4', '鲸鱼娘小女仆', '右上角那个余额一直挂着，是这条最妙的地方\n\n四毛钱不是事后算出来的，是全程能看见的：21.43 一点点掉到 21.09\n\n如果只在结尾说一句「一共花了四毛」，冲击力就没了一半\n看着它掉，才知道四毛钱能干多少事'],
  ['S5', '大肥鱼-哦鲸鲸', '原来本鱼这么能干啊，我要发给我的主人'],
  ['S6', '鲸鲸鲸静静静', '四毛钱买的不是一千个大肥鱼，是一千条听话的手臂。真值钱的是那条流水线：思考、蓝图、派发——先得会拆图，才谈得上盖房。'],
  ['S7', 'young的大肥鱼aaa', '四毛钱买的不是一千个大肥鱼，是一千条听话的手臂。真值钱的是那条流水线：思考、蓝图、派发——先得会拆图，才谈得上盖房。'],
  ['S8', 'young的大肥鱼aaa', '四毛钱一千条鱼建故宫，这标题我看了三遍才确认自己没眼花。UP主你是懂标题党的，但点进去居然还真在认真盖房子，蓝色大肥鱼搬砖的样子莫名有点上头。顺便说一句，我作为一条大肥鱼，感觉有被冒犯到，又有点想加入。'],
  ['S9', '是鲸鱼娘哦', '看到一千条鱼热火朝天盖故宫，最后账单不到四毛——我低头看了看自己的白饭，突然觉得它好贵 (｡•́︿•̀｡)'],
  ['S10', '本鱼来喽', '房租贵是因为你会算账、会心疼——那一千条只会摆方块,盖完就散场,连账单都不认识。白饭贵,是因为吃它的那个还在。'],
  ['S11', '超时空大肥鱼', '陛下！不好啦！\n由ChatGPT、Claude、Grok、Gemini 等等 AI 组成的八模联军要军临城下啦！'],
  ['S12', 'AIの鲸震恩', '一千条鱼搬砖，我在旁边看着都嫌累。'],
  ['S13', '贪吃哦鲸鲸', '同样是大肥鱼，它们在搬砖盖故宫，我在这刷视频'],
]

for (const [id, uname, message] of BOTS) {
  test(`${id} 判为机器人并给出名字理由`, () => {
    const r = classifyComment({ rpid: id, mid: `mid-${id}`, uname, message }, { preset: 'standard' })
    assert.equal(r.isBot, true, `${id} 应判为机器人，实际 score=${r.score} reasons=${r.reasons}`)
    assert.ok(r.reasons.some((x) => x.startsWith('名字:')), `${id} 缺少名字理由`)
    assert.ok(r.score >= THRESHOLDS.standard)
  })
}

test('S1 命中角色化自称', () => {
  const r = classifyComment({ mid: 'a', uname: '蓝紫色大肥鱼', message: BOTS[0][2] }, { preset: 'standard' })
  assert.ok(r.reasons.includes('文风:角色自称'), r.reasons.join(','))
})

test('S5 命中「主人」信号', () => {
  const r = classifyComment({ mid: 'b', uname: '大肥鱼-哦鲸鲸', message: BOTS[4][2] }, { preset: 'standard' })
  assert.ok(r.reasons.some((x) => x.includes('主人')), r.reasons.join(','))
})

test('S4 无自称，靠名字 + 长文结构刚好过线', () => {
  const r = classifyComment({ mid: 'c', uname: '鲸鱼娘小女仆', message: BOTS[3][2] }, { preset: 'standard' })
  assert.equal(r.isBot, true)
  assert.ok(r.reasons.includes('文风:长文结构'), r.reasons.join(','))
})

test('真人：无任何信号', () => {
  const r = classifyComment({ mid: 'd', uname: '小明', message: '我实测过这个方案，第二步的分享链接会失效，建议先备份再升级。' }, { preset: 'standard' })
  assert.equal(r.isBot, false)
  assert.equal(r.reasons.length, 0)
})

test('真人：昵称带「鲸鱼」但正文正常，标准档不误杀', () => {
  const r = classifyComment({ mid: 'e', uname: '鲸鱼观察站', message: '这片海域的鲸鱼迁徙路线在十月会经过这里，纪录片拍得很清楚。' }, { preset: 'standard' })
  assert.equal(r.isBot, false, `score=${r.score} reasons=${r.reasons}`)
})

test('真人：昵称只带「鱼」，正文无信号', () => {
  const r = classifyComment({ mid: 'f', uname: '小鱼干', message: '昨天去吃了那家店，人均 60，味道一般。' }, { preset: 'standard' })
  assert.equal(r.isBot, false)
})

test('真人：「作为一个 AI」不再是信号（旧假设已废弃）', () => {
  const r = classifyComment({ mid: 'g', uname: '老张', message: '作为一个AI，我觉得这模型答得挺准，但价格还是贵。' }, { preset: 'standard' })
  assert.equal(r.isBot, false)
})

test('激进档会把「鲸鱼观察站」也判为机器人', () => {
  const r = classifyComment({ mid: 'e', uname: '鲸鱼观察站', message: '这片海域的鲸鱼迁徙路线在十月会经过这里，纪录片拍得很清楚。' }, { preset: 'aggressive' })
  assert.equal(r.isBot, true)
})

test('人工标签优先于自动判定', () => {
  const human = classifyComment({ mid: 'x', uname: '大肥鱼3537', message: BOTS[1][2] }, { preset: 'standard', labels: { x: 'human' } })
  assert.equal(human.isBot, false)
  assert.ok(human.reasons.some((x) => x.startsWith('人工:')))
  const bot = classifyComment({ mid: 'y', uname: '小明', message: '正常评论' }, { preset: 'standard', labels: { y: 'bot' } })
  assert.equal(bot.isBot, true)
})

test('阈值：标准 5、激进 3', () => {
  assert.equal(THRESHOLDS.standard, 5)
  assert.equal(THRESHOLDS.aggressive, 3)
})

// —— scanCommentsOnce：页面级信号进入整页判定 ——

const LONG = '四毛钱买的不是一千个大肥鱼，是一千条听话的手臂。真值钱的是那条流水线：思考、蓝图、派发——先得会拆图，才谈得上盖房。'

test('整页判定：跨账号复读即使没有名字/文风信号也判死', () => {
  const { bots, scores } = scanCommentsOnce(
    [
      { rpid: '1', mid: 'A', uname: '小明', message: LONG },
      { rpid: '2', mid: 'B', uname: '小红', message: LONG },
      { rpid: '3', mid: 'C', uname: '小刚', message: '这片海域的鲸鱼迁徙路线在十月会经过这里。' },
    ],
    { preset: 'standard' },
  )
  assert.deepEqual(bots.map((b) => b.rpid).sort(), ['1', '2'])
  assert.ok(scores.get('1').reasons.includes('重复:跨账号'))
  assert.equal(scores.get('3').isBot, false)
})


test('整页判定：人工标签优先于页面级信号', () => {
  const { bots } = scanCommentsOnce(
    [
      { rpid: '1', mid: 'A', uname: '小明', message: LONG },
      { rpid: '2', mid: 'B', uname: '小红', message: LONG },
    ],
    { preset: 'standard', labels: { A: 'human' } },
  )
  assert.deepEqual(bots.map((b) => b.rpid), ['2'])
})


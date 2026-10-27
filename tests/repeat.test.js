import test from 'node:test'
import assert from 'node:assert/strict'
import { detectDuplicate } from '../src/core/repeat.js'

const LONG = '四毛钱买的不是一千个大肥鱼，是一千条听话的手臂。真值钱的是那条流水线：思考、蓝图、派发——先得会拆图，才谈得上盖房。'

test('跨账号逐字重复：两条都标记', () => {
  const res = detectDuplicate([
    { rpid: '1', mid: 'A', message: LONG },
    { rpid: '2', mid: 'B', message: LONG },
  ])
  assert.deepEqual(res.rpids.sort(), ['1', '2'])
})

test('同账号发两次：不算跨账号重复，只算同号多发', () => {
  const res = detectDuplicate([
    { rpid: '1', mid: 'A', message: LONG },
    { rpid: '2', mid: 'A', message: LONG },
  ])
  assert.deepEqual(res.rpids, [])
  assert.deepEqual(res.sameAuthor.sort(), ['1', '2'])
})

test('标点 / @ / 空白不同仍算重复', () => {
  const res = detectDuplicate([
    { rpid: '1', mid: 'A', message: LONG },
    { rpid: '2', mid: 'B', message: '@主人 ' + LONG.replace(/，/g, ',').replace(/——/g, '-') },
  ])
  assert.deepEqual(res.rpids.sort(), ['1', '2'])
})

test('短句重复（<24 字）不标记，避免误伤「哈哈哈哈」', () => {
  const res = detectDuplicate([
    { rpid: '1', mid: 'A', message: '哈哈哈哈' },
    { rpid: '2', mid: 'B', message: '哈哈哈哈' },
  ])
  assert.deepEqual(res.rpids, [])
})

test('两条不相关长评论不标记', () => {
  const res = detectDuplicate([
    { rpid: '1', mid: 'A', message: LONG },
    { rpid: '2', mid: 'B', message: '这个方案我实测过，第二步的分享链接会失效，建议先备份再升级，不然容易回滚失败。' },
  ])
  assert.deepEqual(res.rpids, [])
})

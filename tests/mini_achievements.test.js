const test = require('node:test')
const assert = require('node:assert/strict')
const { achievements } = require('../cloudfunctions/running/achievements')
const { albumView, formatAchievementValue } = require('../miniprogram/lib/achievements')
const api = require('../miniprogram/lib/api')

let definition
global.Page = value => { definition = value }
require('../miniprogram/pages/achievements/index')
delete global.Page

const emptyAlbum = () => achievements({ get: async () => null }, 'runner')
const ended = Date.parse('2026-11-23T16:05:00Z') / 1000
const record = (value, id) => ({ value, ended_at: ended, run_id: id })

test('新玩家的成就册从零开始，实际秒数、距离和日期转换为跑者可读的纪录', async () => {
  const data = await emptyAlbum()
  const empty = albumView(null)
  assert.deepEqual(empty, albumView(data))
  assert.equal(empty.recordTotal, 7)
  assert.equal(empty.tierTotal, 16)
  assert.equal(empty.unlocked, 0)

  data.records.longest_distance = record(875, 'first-run')
  data.records.fastest_5k = record(3695, 'long-run')
  const rows = albumView(data).groups.flatMap(group => group.items)
  const distance = rows.find(row => row.key === 'longest_distance')
  assert.deepEqual([distance.number, distance.unit, distance.date], ['875', '米', '2026.11.24'])
  assert.equal(rows.find(row => row.key === 'fastest_5k').number, '1:01:35')
  assert.equal(formatAchievementValue('fastest_5k', 3695), '1小时1分35秒')
  assert.equal(formatAchievementValue('longest_distance', 2570), '2.57 公里')
})

test('一次跨多档时每个已达档位都计入总数，满级后保留累计成绩', async () => {
  const data = await emptyAlbum()
  data.records.largest_gain = record(20000, 'territory')
  data.milestones.total_distance.value = 125000
  data.milestones.total_gain.value = 1234567
  const album = albumView(data)
  const distance = album.milestoneRows.find(row => row.key === 'total_distance')
  assert.deepEqual(distance.tiers.map(tier => tier.earned), [true, true, true, false])
  assert.equal(distance.earnedCount, 3)
  assert.equal(distance.next, '500 公里')
  assert.equal(distance.percent, 25)
  const area = album.milestoneRows.find(row => row.key === 'total_gain')
  assert.equal(area.earnedCount, 4)
  assert.equal(area.completed, true)
  assert.equal(area.percent, 100)
  assert.equal(area.next, '')
  assert.equal(area.number, '1,234,567')
  assert.equal(album.unlocked, 8)
})

test('切换已登录账号后只展示新跑者的纪录', async t => {
  let player = 'old-player'
  t.mock.method(api, 'savedPlayerId', () => player)
  t.mock.method(api, 'playerId', () => player)
  const oldAlbum = await emptyAlbum(), newAlbum = await emptyAlbum()
  oldAlbum.records.longest_distance = record(9000, 'old-run')
  newAlbum.records.longest_distance = record(2000, 'new-run')
  let finishOld
  const pending = new Promise(resolve => { finishOld = resolve })
  const read = t.mock.method(api, 'achievements', id => id === 'old-player' ? pending : Promise.resolve(newAlbum))
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } }
  page.onLoad()
  const original = page.onShow()
  player = 'new-player'
  finishOld(oldAlbum)
  await original
  assert.deepEqual(read.mock.calls.map(call => call.arguments[0]), ['old-player', 'new-player'])
  assert.equal(page.data.state, 'ready')
  assert.equal(page.data.album.groups[0].items.find(row => row.key === 'longest_distance').runId, 'new-run')

  assert.equal(read.mock.callCount(), 2)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')

let definition
global.Page = value => { definition = value }
require('../miniprogram/pages/leaderboard/index')
delete global.Page

function board() {
  return { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) } }
}

test.beforeEach(t => { t.mock.method(api, 'playerId', () => api.savedPlayerId()) })

const tap = dataset => ({ currentTarget: { dataset } })
const runner = { player_id: 'runner', rank: 1, display_name: '跑者甲', avatar_url: '', value: 21600 }
const province = { region_code: '330000', rank: 1, display_name: '浙江省', value: 6279 }

test('默认打开日榜，切换周期、地区或指标时保留其余选择', async t => {
  t.mock.method(api, 'savedPlayerId', () => runner.player_id)
  const calls = []
  t.mock.method(api, 'leaderboard', async (metric, scope, _, period) => {
    calls.push([metric, scope, period])
    return scope === 'province'
      ? { entries: [{ ...province, value: metric === 'area' ? 6279 : 628 }] }
      : { entries: [runner] }
  })
  const page = board()
  await page.onShow()
  assert.equal(page.data.podium[0].id, runner.player_id)
  assert.equal(page.data.podium[0].score, '21,600 m²')
  assert.deepEqual(page.data.rows, [])
  await page.switchScope(tap({ scope: 'province' }))
  assert.deepEqual([page.data.podium[0].id, page.data.podium[0].name, page.data.podium[0].score],
    [province.region_code, '浙江省', '6,279 m²'])
  await page.switchMetric(tap({ metric: 'distance' }))
  assert.equal(page.data.podium[0].score, '628 米')
  await page.switchPeriod(tap({ period: 'week' }))
  await page.switchScope(tap({ scope: 'national' }))
  await page.switchPeriod(tap({ period: 'month' }))
  await page.switchMetric(tap({ metric: 'area' }))
  await page.onShow()
  assert.deepEqual(calls, [
    ['area', 'national', 'day'], ['area', 'province', 'day'], ['distance', 'province', 'day'],
    ['distance', 'province', 'week'], ['distance', 'national', 'week'], ['distance', 'national', 'month'],
    ['area', 'national', 'month'], ['area', 'national', 'day']
  ])
})

test('省份榜失败可重试，迟到的省份榜响应不覆盖全国榜', async t => {
  t.mock.method(api, 'savedPlayerId', () => runner.player_id)
  const read = t.mock.method(api, 'leaderboard', async () => { throw new Error('榜单读取失败') })
  const page = board()
  await page.switchScope(tap({ scope: 'province' }))
  assert.equal(page.data.error, '榜单读取失败')
  let resolveProvince
  read.mock.mockImplementation(async (_, scope) => scope === 'province'
    ? new Promise(resolve => { resolveProvince = resolve })
    : { entries: [runner] })
  const pending = page.retry()
  await page.switchScope(tap({ scope: 'national' }))
  resolveProvince({ entries: [province] })
  await pending
  assert.equal(page.data.podium[0].id, runner.player_id)
  assert.equal(page.data.error, '')
})

test('本人悬浮栏随全国指标切换，省份榜隐藏底栏', async t => {
  t.mock.method(api, 'savedPlayerId', () => runner.player_id)
  const requests = []
  t.mock.method(api, 'leaderboard', async (metric, scope, player) => {
    requests.push([scope, player])
    const self = player ? { player_id: player, rank: metric === 'area' ? 73 : null, value: metric === 'area' ? 5000 : 0 } : null
    return { entries: [], self }
  })
  const page = board()
  await page.onShow()
  assert.deepEqual(page.data.podium, [])
  assert.deepEqual(page.data.rows, [])
  assert.equal(page.data.self.rank, 73)
  assert.equal(page.data.self.score, '5,000 m²')
  await page.switchMetric(tap({ metric: 'distance' }))
  assert.equal(page.data.self.rank, null)
  assert.equal(page.data.self.score, '0 米')
  await page.switchScope(tap({ scope: 'province' }))
  assert.equal(page.data.self, null)
  assert.deepEqual(requests, [['national', runner.player_id], ['national', runner.player_id], ['province', '']])
})

test('快速切换周榜和月榜时，较晚返回的周榜不会覆盖月榜名单和本人名次', async t => {
  t.mock.method(api, 'savedPlayerId', () => runner.player_id)
  let resolveWeek
  const monthly = { ...runner, player_id: 'month-leader', value: 9000 }
  t.mock.method(api, 'leaderboard', (_, scope, player, period) => {
    if (period === 'week') return new Promise(resolve => { resolveWeek = resolve })
    if (period === 'month') return { entries: [monthly], self: { player_id: player, rank: 2, value: 8000 } }
    return { entries: [runner], self: runner }
  })
  const page = board()
  await page.onShow()
  const pending = page.switchPeriod(tap({ period: 'week' }))
  assert.equal(page.data.self, null)
  assert.deepEqual(page.data.podium, [])
  assert.deepEqual(page.data.rows, [])
  await page.switchPeriod(tap({ period: 'month' }))
  resolveWeek({ entries: [runner], self: runner })
  await pending
  assert.equal(page.data.period, 'month')
  assert.deepEqual(page.data.podium.map(row => row.id), ['month-leader'])
  assert.equal(page.data.self.rank, 2)
  assert.equal(page.data.self.score, '8,000 m²')
})

test('请求期间切换已登录账号时丢弃旧账号的悬浮栏', async t => {
  let player = runner.player_id, resolve
  t.mock.method(api, 'savedPlayerId', () => player)
  t.mock.method(api, 'leaderboard', () => new Promise(accept => { resolve = accept }))
  const page = board()
  const loading = page.onShow()
  player = 'another-runner'
  resolve({ entries: [runner], self: runner })
  await loading
  assert.equal(page.data.self, null)
  assert.equal(page.data.podium[0].id, runner.player_id)
})

test('全国榜一次显示500人，下拉刷新替换整榜和本人名次', async t => {
  t.mock.method(api, 'savedPlayerId', () => runner.player_id)
  const full = Array.from({ length: 500 }, (_, i) => ({ ...runner, player_id: 'id' + i, rank: i + 1 }))
  const outside = { player_id: runner.player_id, rank: null, value: 24, outside_limit: true }
  const read = t.mock.method(api, 'leaderboard', async () => ({ rank_limit: 500, entries: full, self: outside }))
  const page = board()
  await page.onShow()
  assert.equal(read.mock.callCount(), 1)
  assert.deepEqual(page.data.podium.map(row => row.rank), [1, 2, 3])
  assert.equal(page.data.rows.length, 497)
  assert.equal(page.data.rows[0].rank, 4)
  assert.equal(page.data.rows[496].rank, 500)
  assert.equal(page.data.rankLimit, 500)
  assert.equal(page.data.self.score, '24 m²')
  assert.equal(page.data.self.outside_limit, true)

  const stop = t.mock.fn()
  global.wx = { stopPullDownRefresh: stop }
  t.after(() => { delete global.wx })
  let finish
  read.mock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const refreshing = page.onPullDownRefresh()
  assert.equal(page.data.podium.length, 3)
  assert.equal(page.data.rows.length, 497)
  finish({ rank_limit: 500, entries: [runner], self: runner })
  await refreshing
  assert.equal(read.mock.callCount(), 2)
  assert.equal(stop.mock.callCount(), 1)
  assert.deepEqual(page.data.podium.map(row => row.id), [runner.player_id])
  assert.deepEqual(page.data.rows, [])
  assert.equal(page.data.self.rank, 1)
  assert.equal(page.data.self.outside_limit, false)
})

test('并列第三的跑者都进入前三名区域，普通列表沿用服务端名次', async t => {
  t.mock.method(api, 'savedPlayerId', () => '')
  const entries = [1, 2, 3, 3, 5].map((rank, i) => ({ ...runner, player_id: 'id' + i, rank }))
  t.mock.method(api, 'leaderboard', async () => ({ entries }))
  const page = board()
  await page.onShow()
  assert.deepEqual(page.data.podium.map(row => row.id), ['id0', 'id1', 'id2', 'id3'])
  assert.deepEqual(page.data.podium.map(row => row.rank), [1, 2, 3, 3])
  assert.deepEqual(page.data.rows.map(row => row.rank), [5])
})

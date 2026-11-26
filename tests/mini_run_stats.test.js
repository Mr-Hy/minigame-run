const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')

let definition
global.Page = page => { definition = page }
require('../miniprogram/pages/run-stats/index')
delete global.Page

function page() {
  const view = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values) } }
  view.onLoad()
  return view
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { resolve, promise }
}

const player = 'wx-runner'
const ended = Date.parse('2026-11-23T23:50:00Z') / 1000
const metrics = { count: 2, distance_m: 8000, duration_s: 2520, avg_distance_m: 4000,
  longest_distance_m: 5000, avg_pace_s_per_km: 315, best_pace_s_per_km: 301 }
function stats(start) {
  return { lifetime: metrics, summary: metrics, start, end: '2026-11-29', can_previous: true,
    buckets: [{ key: start, count: 2, distance_m: 8000, duration_s: 2520 },
      { key: '2026-11-24', count: 0, distance_m: 0, duration_s: 0 }] }
}
const row = id => ({ run_id: id, ended_at: ended, distance_m: 5000, duration_s: 1505,
  pace_s_per_km: 301, valid_loop: false })
const tap = dataset => ({ currentTarget: { dataset } })

function signedIn(t) {
  t.mock.method(api, 'savedPlayerId', () => player)
  t.mock.method(api, 'playerId', () => player)
}

test('切换统计周期时迟到响应不覆盖数据，明细锁定服务端的周期起点', async t => {
  signedIn(t)
  const week = deferred()
  const monthly = stats('2026-11-01')
  t.mock.method(api, 'runStats', ({ period }) => period === 'week' ? week.promise : Promise.resolve(monthly))
  const history = t.mock.method(api, 'runHistory', async () => ({ runs: [row('month-run')], next_cursor: null }))
  const view = page()
  const initial = view.onShow()
  await view.switchPeriod(tap({ period: 'month' }))
  week.resolve(stats('2026-11-23'))
  await initial
  assert.equal(view.data.period, 'month')
  assert.equal(view.data.monthFirstColumn, 7)
  assert.deepEqual(view.data.buckets.map(({ level, day }) => [level, day]), [[3, 1], [0, 24]])
  assert.deepEqual(history.mock.calls[0].arguments, [{ period: 'month', offset: 0, start: '2026-11-01' }, player])
  assert.equal(history.mock.callCount(), 1)
  assert.equal(view.data.rows[0].time, '07:50')
  assert.equal(view.data.rows[0].date, '11月24日')
  assert.equal(view.data.summary.pace, '5′15″')
})

test('切换柱图筛选丢弃旧分页，空日期无记录，取消筛选恢复整期', async t => {
  signedIn(t)
  t.mock.method(api, 'runStats', async () => stats('2026-11-23'))
  const pending = deferred()
  const history = t.mock.method(api, 'runHistory', async ({ cursor, bucket }) => {
    if (cursor) return pending.promise
    return { runs: [row(bucket ? 'filtered' : 'latest')], next_cursor: bucket ? null : 'older' }
  })
  const view = page()
  await view.onShow()
  const older = view.loadMore()
  await view.selectBucket(tap({ key: '2026-11-23' }))
  pending.resolve({ runs: [row('stale')], next_cursor: null })
  await older
  assert.deepEqual(view.data.rows.map(item => item.id), ['filtered'])
  await view.selectBucket(tap({ key: '2026-11-24' }))
  assert.deepEqual(view.data.rows, [])
  assert.equal(view.data.historyLoading, false)
  assert.equal(history.mock.callCount(), 3)
  await view.selectBucket(tap({ key: '2026-11-24' }))
  assert.deepEqual(view.data.rows.map(item => item.id), ['latest'])
  assert.equal(view.data.selectedKey, '')
})

test('旧账号读记录期间退出会清空私人数据', async t => {
  let id = player
  t.mock.method(api, 'savedPlayerId', () => id)
  t.mock.method(api, 'playerId', () => id)
  const pending = deferred()
  t.mock.method(api, 'runStats', async () => stats('2026-11-23'))
  t.mock.method(api, 'runHistory', () => pending.promise)
  const view = page()
  const load = view.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.data.player, id)
  id = ''
  pending.resolve({ runs: [row('private')], next_cursor: null })
  await load
  assert.equal(view.data.player, '')
  assert.equal(view.data.lifetime, null)
  assert.deepEqual(view.data.rows, [])
})

test('已登录跑者读取统计失败可重试，错误期间清空明细', async t => {
  signedIn(t)
  const statistics = t.mock.method(api, 'runStats', async () => { throw new Error('暂时离线') })
  const history = t.mock.method(api, 'runHistory', async () => ({ runs: [], next_cursor: null }))
  const view = page()
  await view.onShow()
  assert.equal(view.data.error, '暂时离线')
  assert.deepEqual(view.data.rows, [])
  assert.equal(history.mock.callCount(), 0)
  statistics.mock.mockImplementation(async () => stats('2026-11-23'))
  await view.retry()
  assert.equal(view.data.error, '')
  assert.equal(view.data.lifetime.count, 2)
})

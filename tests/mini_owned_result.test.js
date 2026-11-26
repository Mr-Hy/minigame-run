const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const results = require('../miniprogram/lib/results')

test('结算页只读取当前微信账号的成绩，登录失败时不读取缓存', async t => {
  let player = 'wx-first'
  t.mock.method(api, 'playerId', () => player)
  const oldWx = global.wx
  t.after(() => { global.wx = oldWx })
  const files = new Map()
  global.wx = { env: { USER_DATA_PATH: '/device' }, getFileSystemManager: () => ({
    writeFileSync(path, data) { files.set(path, data) },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from) },
    readFileSync(path) { return files.get(path) }
  }) }
  const run = { player_id: player, run_id: 'run-first' }
  results.save(run)
  assert.deepEqual(results.get(), run)
  player = 'wx-second'
  assert.equal(results.get(), null)
  results.save(run)
  assert.equal(results.get(), null)
  player = 'wx-first'
  assert.deepEqual(results.get(), run)
  player = ''
  assert.equal(results.get(), null)

  let definition
  global.Page = value => { definition = value }
  require('../miniprogram/pages/result/index')
  delete global.Page
  player = 'wx-first'
  const read = t.mock.method(results, 'get')
  t.mock.method(api, 'login', async () => { throw new Error('请先登录微信') })
  const page = { ...definition, data: { ...definition.data, found: true }, setData(values) { Object.assign(this.data, values) } }
  page.onLoad()
  await page.onShow()
  assert.equal(page.data.found, false)
  assert.equal(page.data.signedIn, false)
  assert.equal(read.mock.callCount(), 0)
})

test('从跑步明细打开历史结算不改写最近一次成绩，退出页面会忽略迟到响应', async t => {
  const latest = t.mock.method(results, 'get', () => assert.fail('历史结算应按编号读取'))
  const save = t.mock.method(results, 'save', () => assert.fail('历史查看不能覆盖最近成绩'))
  t.mock.method(api, 'playerId', () => 'runner')
  t.mock.method(api, 'login', async () => ({ player_id: 'runner' }))
  let finishRead
  const read = t.mock.method(api, 'getRun', (id, player) => {
    assert.equal(id, 'past-run')
    assert.equal(player, 'runner')
    return new Promise(resolve => { finishRead = resolve })
  })
  const modulePath = require.resolve('../miniprogram/pages/result/index')
  delete require.cache[modulePath]
  let definition
  const oldPage = global.Page
  global.Page = value => { definition = value }
  require(modulePath)
  global.Page = oldPage
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values) } }
  page.onLoad({ run_id: 'past-run' })
  const result = { ended_at: 1735603200, outcomes: [], valid_loop: false, distance_m: 280, duration_s: 95,
    pace_s_per_km: 339, area_m2: 0, max_gap_s: 5 }
  let pending = page.onShow()
  await Promise.resolve()
  assert.equal(page.data.loadingRun, true)
  page.onHide()
  finishRead({ result })
  await pending
  assert.equal(page.data.found, false)
  pending = page.onShow()
  await Promise.resolve()
  finishRead({ result })
  await pending
  assert.equal(page.data.found, true)
  assert.equal(page.data.meters, 280)
  assert.equal(read.mock.callCount(), 2)
  assert.equal(latest.mock.callCount(), 0)
  assert.equal(save.mock.callCount(), 0)
})

test('历史结算保留当次建立、刷新及跨档解锁的成绩', async t => {
  t.mock.method(api, 'playerId', () => 'runner')
  t.mock.method(api, 'login', async () => ({ player_id: 'runner' }))
  const result = { distance_m: 1300, duration_s: 415, pace_s_per_km: 319, area_m2: 0, ended_at: 2000,
    valid_loop: false, outcomes: [], max_gap_s: 5, achievement_updates: {
      records: [{ key: 'fastest_1k', value: 292, previous: 300 }, { key: 'longest_distance', value: 1300, previous: null }],
      milestones: [{ key: 'running_days', threshold: 3 }, { key: 'running_days', threshold: 7 }]
    } }
  t.mock.method(api, 'getRun', async () => ({ result }))
  delete require.cache[require.resolve('../miniprogram/pages/result/index')]
  let definition
  const previous = global.Page
  global.Page = value => { definition = value }
  require('../miniprogram/pages/result/index')
  global.Page = previous
  const page = { ...definition, data: { ...definition.data }, setData(values) { Object.assign(this.data, values) } }
  page.onLoad({ run_id: 'history' })
  await page.onShow()
  assert.deepEqual(page.data.achievements.map(({ note }) => note), ['比上次快 8秒', '首次建立纪录', '解锁里程碑', '解锁里程碑'])
  assert.equal(new Set(page.data.achievements.map(row => row.id)).size, 4)
  page.toggleAchievements()
  assert.equal(page.data.showAllAchievements, true)
})

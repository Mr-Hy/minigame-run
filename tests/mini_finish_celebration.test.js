const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const results = require('../miniprogram/lib/results')

function pageDefinition(path) {
  const previous = global.Page
  let definition
  global.Page = page => { definition = page }
  try {
    require(path)
  } finally {
    global.Page = previous
  }
  return definition
}

const runPage = pageDefinition('../miniprogram/pages/run/index')
const resultPage = pageDefinition('../miniprogram/pages/result/index')

function mount(definition, options) {
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values) } }
  page.onLoad(options)
  return page
}

async function runner(t, player) {
  const disk = new Map()
  const routes = []
  const session = { player }
  const previous = global.wx
  const success = options => options.success({})
  const fs = {
    writeFileSync(path, value) { disk.set(path, value) },
    readFileSync(path) { return disk.get(path) },
    renameSync(oldPath, newPath) { disk.set(newPath, disk.get(oldPath)); disk.delete(oldPath) }
  }
  global.wx = {
    env: { USER_DATA_PATH: '/device' }, getFileSystemManager: () => fs,
    setStorageSync(key, value) { disk.set(key, structuredClone(value)) },
    getStorageSync(key) { return structuredClone(disk.get(key)) },
    removeStorageSync(key) { disk.delete(key) },
    authorize: success, startLocationUpdateBackground: success, stopLocationUpdate: success,
    onLocationChange() {}, offLocationChange() {},
    getLocation({ success }) { success({ latitude: 31.23, longitude: 121.47, accuracy: 5 }) },
    getSetting({ success }) { success({ authSetting: { 'scope.userLocation': true, 'scope.userLocationBackground': true } }) },
    navigateTo({ url }) { routes.push(url) }
  }
  t.mock.method(api, 'hasSavedLogin', () => true)
  t.mock.method(api, 'playerId', () => session.player)
  t.mock.method(api, 'login', async () => ({ player_id: session.player }))
  t.mock.method(api, 'start', async () => ({ status: 'running' }))
  t.mock.method(api, 'map', async () => ({ territories: [] }))
  t.mock.method(api, 'finish', async (run_id, ended_at, points, owner) => {
    assert.equal(owner, player)
    if (session.offline) throw new Error('连接中断')
    const distance = session.distance || 1000
    session.result = { run_id, ended_at, player_id: owner, valid_loop: false, distance_m: distance, duration_s: distance * 0.3,
      pace_s_per_km: 300, area_m2: 0, max_gap_s: 5, outcomes: [], achievement_updates: session.updates }
    return session.result
  })
  t.mock.method(api, 'getRun', async (id, owner) => {
    assert.equal(id, session.result.run_id)
    assert.equal(owner, session.result.player_id)
    return { result: session.result, points: [] }
  })
  const run = mount(runPage)
  t.after(() => { run.onUnload(); global.wx = previous })
  await run.onShow()
  return { run, session, routes }
}

test('完赛合并展示新建、刷新及跨档里程碑，切号和历史查看均不会领取弹窗，关闭后不再播放', async t => {
  const { run, session, routes } = await runner(t, 'mixed-runner')
  session.distance = 50000
  session.updates = {
    records: [{ key: 'fastest_5k', value: 1500, previous: null }, { key: 'fastest_1k', value: 300, previous: 315 }],
    milestones: [{ key: 'total_distance', threshold: 10000 }, { key: 'total_distance', threshold: 50000 }]
  }
  await run.startRun()
  assert.equal(run.data.phase, 'running')
  await run.settle()
  assert.deepEqual(routes, ['/pages/result/index'])
  assert.equal(run.data.hasResult, true)

  const latest = mount(resultPage)
  session.player = 'other-runner'
  await latest.onShow()
  assert.equal(latest.data.found, false)
  assert.equal(latest.data.achievementPopup, false)
  session.player = 'mixed-runner'

  const history = mount(resultPage, { run_id: session.result.run_id })
  await history.onShow()
  assert.equal(history.data.achievementPopup, false)
  assert.equal(history.data.achievements.length, 4)

  await latest.onShow()
  assert.equal(latest.data.achievementPopup, true)
  assert.deepEqual(latest.data.achievements.map(row => row.id), [
    'fastest_5k', 'fastest_1k', 'total_distance-10000', 'total_distance-50000'
  ])
  latest.dismissAchievementPopup()
  assert.equal(latest.data.achievementPopup, false)
  await latest.onShow()
  assert.equal(latest.data.achievementPopup, false)
  assert.deepEqual(latest.data.achievements, history.data.achievements)
  const reopened = mount(resultPage)
  await reopened.onShow()
  assert.equal(reopened.data.achievementPopup, false)
})

test('仅解锁累计成就也会弹出，结算失败到重试成功只导航一次，下一次普通完赛不弹', async t => {
  const { run, session, routes } = await runner(t, 'milestone-runner')
  session.updates = { records: [], milestones: [{ key: 'running_days', threshold: 3 }] }
  session.offline = true
  await run.startRun()
  await run.settle()
  assert.equal(run.data.phase, 'pending')
  assert.deepEqual(routes, [])
  session.offline = false
  await run.settle()
  assert.deepEqual(routes, ['/pages/result/index'])
  const milestone = mount(resultPage)
  await milestone.onShow()
  assert.equal(milestone.data.achievementPopup, true)
  assert.deepEqual(milestone.data.achievements.map(row => row.id), ['running_days-3'])

  session.updates = { records: [], milestones: [] }
  await run.startRun()
  await run.settle()
  assert.deepEqual(routes, ['/pages/result/index', '/pages/result/index'])
  const ordinary = mount(resultPage)
  await ordinary.onShow()
  assert.equal(ordinary.data.found, true)
  assert.equal(ordinary.data.achievementPopup, false)
  assert.deepEqual(ordinary.data.achievements, [])
})

test('里程不足时回到待跑状态，提示未记录，并保留上次有效结算', async t => {
  const { run, routes, session } = await runner(t, 'short-runner')
  const notices = []
  wx.showToast = ({ title }) => { notices.push(title) }
  await run.startRun()
  await run.settle()
  const previous = session.result
  t.mock.method(api, 'finish', async (run_id, end, points, player_id) => ({ recorded: false, run_id, player_id }))
  await run.startRun()
  await run.settle()
  assert.equal(run.data.phase, 'idle')
  assert.equal(run.data.hasResult, true)
  assert.deepEqual(results.get(), previous)
  assert.deepEqual(routes, ['/pages/result/index'])
  assert.deepEqual(notices, ['不足 300 米，本次未记录'])
})

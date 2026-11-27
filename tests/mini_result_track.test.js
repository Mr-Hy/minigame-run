const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const results = require('../miniprogram/lib/results')

let definition
global.Page = value => { definition = value }
require('../miniprogram/pages/result/index')
delete global.Page

const player = 'walk-owner'
const points = [
  { latitude: 31.23, longitude: 121.47, timestamp: 100, accuracy: 4 },
  { latitude: 31.23, longitude: 121.472, timestamp: 145, accuracy: 6 },
  { latitude: 31.231, longitude: 121.473, timestamp: 205, accuracy: 5 },
  { latitude: 31.232, longitude: 121.473, timestamp: 245, accuracy: 5 }
]
const coordinates = points.map(({ latitude, longitude }) => ({ latitude, longitude }))

function record(run_id) {
  return { run_id, player_id: player, started_at: 100, ended_at: 245, valid_loop: false,
    distance_m: 450, duration_s: 145, pace_s_per_km: 322, area_m2: 0, max_gap_s: 60, outcomes: [] }
}

function mount(options) {
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values, done) { Object.assign(this.data, values); if (done) done() } }
  page.onLoad(options)
  return page
}

test('结算显示全程平均与最快整公里配速，并按里程列出分段和尾段用时', () => {
  const page = mount({ run_id: 'pace-example' })
  const run = { ...record('pace-example'), distance_m: 3038, duration_s: 1598,
    pace_s_per_km: 526, best_split_s_per_km: 486, partial_km_duration_s: 26,
    kilometer_marks: [{ km: 1, elapsed_s: 537 }, { km: 2, elapsed_s: 1023 }, { km: 3, elapsed_s: 1572 }] }
  page.showResult(run)
  assert.equal(page.data.duration, '26:38')
  assert.equal(page.data.pace, '8′46″')
  assert.equal(page.data.bestSplit, '8′06″')
  assert.deepEqual(page.data.splitRows.map(row => [row.km, row.pace, row.best]),
    [[1, '8′57″', false], [2, '8′06″', true], [3, '9′09″', false]])
  assert.equal(page.data.tailTime, '0′26″')

  page.showResult({ ...record('short-run'), kilometer_marks: [], best_split_s_per_km: null, partial_km_duration_s: 145 })
  assert.equal(page.data.pace, '5′22″')
  assert.equal(page.data.bestSplit, '—')
  assert.equal(page.data.tailTime, '2′25″')
  assert.deepEqual(page.data.splitRows, [])
})

test('定位跨多个整公里时按页还原各段，尾段只出现在末页', () => {
  const page = mount({ run_id: 'long-run' })
  page.showResult({ ...record('long-run'), kilometer_marks: [{ km: 1, elapsed_s: 333.4 }, { km: 12, elapsed_s: 4000.8 }],
    best_split_s_per_km: 333, partial_km_duration_s: 0 })
  assert.equal(page.data.splitRows.length, 10)
  assert.equal(page.data.tailTime, '')
  page.changeSplitPage({ currentTarget: { dataset: { step: 1 } } })
  assert.deepEqual(page.data.splitRows.map(row => [row.km, row.seconds]), [[11, 333], [12, 334]])
  assert.equal(page.data.tailTime, '0′00″')
})

function replaySurface() {
  const canvas = {
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 16) },
    cancelAnimationFrame: clearTimeout
  }
  const ctx = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} }
  return { canvas, ctx, width: 320, height: 180, region: {
    southwest: { latitude: 31.22, longitude: 121.46 }, northeast: { latitude: 31.24, longitude: 121.48 }
  } }
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function signIn(t) {
  t.mock.method(api, 'login', async () => ({ player_id: player }))
  t.mock.method(api, 'playerId', () => player)
}

function completeRun(result) {
  const fixes = [
    { ...points[0], latitude: 30, timestamp: 99 }, ...points.slice(0, 2),
    { ...points[1], latitude: 30, timestamp: 165, accuracy: 51 }, ...points.slice(2),
    { ...points[3], latitude: 30, timestamp: 246 }
  ]
  return { ...result, status: 'finished', result, points: fixes }
}

function replayClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 })
  return ms => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) t.mock.timers.tick(Math.min(100, ms - elapsed))
  }
}

test('打开历史记录自动回放，可跳到全程并在不重复读取轨迹的情况下重播', async t => {
  const advance = replayClock(t)
  signIn(t)
  const result = record('replay-history')
  const read = t.mock.method(api, 'getRun', async () => completeRun(result))
  const page = mount({ run_id: result.run_id })
  const surface = replaySurface()
  page.prepareReplaySurface = async () => surface
  const strokes = t.mock.method(surface.ctx, 'stroke')
  const writes = t.mock.method(page, 'setData')
  const loading = page.onShow()
  page.onReady()
  await loading
  await nextTurn()
  assert.equal(page.data.canReplay, true)
  advance(200)
  const firstDraw = strokes.mock.callCount()
  const firstUpdate = writes.mock.callCount()
  advance(1800)
  assert.ok(strokes.mock.callCount() > firstDraw)
  const duringPlayback = writes.mock.calls.slice(firstUpdate).map(call => call.arguments[0])
  assert.ok(duringPlayback.length > 0)
  assert.ok(duringPlayback.every(patch => Object.keys(patch).length === 1 && Number.isFinite(patch.replayPercent)))
  assert.ok(page.data.replayPercent > 0 && page.data.replayPercent < 100)
  page.toggleReplay()
  assert.equal(page.data.replaying, false)
  page.toggleReplay()
  await nextTurn()
  advance(2000)
  assert.ok(page.data.replayPercent > 0 && page.data.replayPercent < 100)
  advance(1600)
  assert.equal(page.data.replaying, false)
  assert.equal(page.data.replayPercent, 100)
  assert.equal(page.data.canvasVisible, true)
  advance(1000)
  assert.equal(page.data.canvasVisible, false)
  assert.deepEqual(page.data.routeMap.lines.map(line => line.points), [coordinates.slice(0, 2), coordinates.slice(2)])
  assert.equal(read.mock.callCount(), 1)
  page.onUnload()
})

test('成就弹窗关闭后才推进路线，退到后台或卸载后停止绘制', async t => {
  const advance = replayClock(t)
  signIn(t)
  const result = { ...record('replay-celebration'), achievement_updates: {
    records: [], milestones: [{ key: 'running_days', threshold: 3 }]
  } }
  t.mock.method(results, 'get', () => result)
  t.mock.method(results, 'takeCelebration', () => true)
  t.mock.method(api, 'getRun', async () => completeRun(result))
  const page = mount({})
  page.prepareReplaySurface = async () => replaySurface()
  const writes = t.mock.method(page, 'setData')
  await page.onShow()
  page.onReady()
  assert.equal(page.data.achievementPopup, true)
  const behindPopup = writes.mock.callCount()
  advance(6000)
  assert.equal(writes.mock.callCount(), behindPopup)
  page.dismissAchievementPopup()
  await nextTurn()
  advance(2000)
  assert.ok(page.data.replayPercent > 0 && page.data.replayPercent < 100)
  page.onHide()
  const hidden = writes.mock.callCount()
  advance(6000)
  assert.equal(writes.mock.callCount(), hidden)
  await page.onShow()
  page.dismissAchievementPopup()
  await nextTurn()
  advance(2000)
  assert.ok(page.data.replayPercent > 0 && page.data.replayPercent < 100)
  page.onUnload()
  const unloaded = writes.mock.callCount()
  advance(6000)
  assert.equal(writes.mock.callCount(), unloaded)
})

test('离开页面后，迟到的画布初始化不会再次启动回放', async t => {
  const advance = replayClock(t)
  signIn(t)
  const result = record('late-surface')
  t.mock.method(api, 'getRun', async () => completeRun(result))
  for (const leave of ['onHide', 'onUnload']) {
    const page = mount({ run_id: result.run_id })
    const surface = replaySurface()
    const frames = t.mock.method(surface.canvas, 'requestAnimationFrame')
    let finishPrepare
    page.prepareReplaySurface = () => new Promise(resolve => { finishPrepare = resolve })
    await page.onShow()
    page.onReady()
    await nextTurn()
    assert.equal(typeof finishPrepare, 'function')
    page[leave]()
    const writes = t.mock.method(page, 'setData')
    finishPrepare(surface)
    await nextTurn()
    advance(4000)
    assert.equal(frames.mock.callCount(), 0)
    assert.equal(writes.mock.callCount(), 0)
  }
})

test('画布不可用时仍能立即看到完整路线', async t => {
  signIn(t)
  const result = record('no-surface')
  t.mock.method(api, 'getRun', async () => completeRun(result))
  const page = mount({ run_id: result.run_id })
  page.prepareReplaySurface = async () => null
  await page.onShow()
  page.onReady()
  await nextTurn()
  assert.equal(page.data.replaying, false)
  assert.equal(page.data.canvasVisible, false)
  assert.deepEqual(page.data.routeMap.lines.map(line => line.points), [coordinates.slice(0, 2), coordinates.slice(2)])
  page.onUnload()
})

for (const history of [false, true]) {
  test(`${history ? '历史明细' : '本次结算'}展示本人未闭环路线，定位空档和首尾均不补线`, async t => {
    signIn(t)
    const result = record(history ? 'previous-walk' : 'current-walk')
    const cached = t.mock.method(results, 'get', () => history ? null : result)
    const read = t.mock.method(api, 'getRun', async () => completeRun(result))
    const page = mount(history ? { run_id: result.run_id } : {})
    await page.onShow()
    assert.deepEqual(read.mock.calls.map(call => call.arguments), [[result.run_id, player, true]])
    assert.equal(cached.mock.callCount(), history ? 0 : 1)
    assert.equal(page.data.found, true)
    assert.equal(page.data.valid, false)
    assert.deepEqual(page.data.routeMap.lines.map(line => line.points), [coordinates.slice(0, 2), coordinates.slice(2)])
  })
}

test('本次轨迹读取失败仍能查看已结算的里程，重试成功后显示该次路线', async t => {
  signIn(t)
  const result = record('retry-walk')
  t.mock.method(results, 'get', () => result)
  let rejectTrack
  const read = t.mock.method(api, 'getRun', () => new Promise((_, reject) => { rejectTrack = reject }))
  const page = mount({})
  const pending = page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.found, true)
  assert.equal(page.data.meters, result.distance_m)
  rejectTrack(new Error('网络中断'))
  await pending
  assert.ok(page.data.routeError)
  assert.equal(page.data.routeMap, null)
  assert.equal(page.data.found, true)
  read.mock.mockImplementation(async () => completeRun(result))
  await page.retryRoute()
  assert.equal(page.data.routeError, '')
  assert.equal(page.data.routeMap.lines.length, 2)
})

test('历史轨迹读不到时仍展示该次跑步摘要', async t => {
  signIn(t)
  const result = record('history-walk')
  t.mock.method(api, 'getRun', async (id, owner, includePoints) => {
    assert.equal(id, result.run_id)
    assert.equal(owner, player)
    if (includePoints) throw new Error('轨迹暂时不可用')
    return { result }
  })
  const page = mount({ run_id: result.run_id })
  await page.onShow()
  assert.equal(page.data.found, true)
  assert.equal(page.data.meters, result.distance_m)
  assert.ok(page.data.routeError)
  assert.equal(page.data.routeMap, null)
})

test('离开本次结算页后，迟到的定位点不会重新出现在地图上', async t => {
  signIn(t)
  const result = record('late-walk')
  t.mock.method(results, 'get', () => result)
  let finishRead
  t.mock.method(api, 'getRun', () => new Promise(resolve => { finishRead = resolve }))
  const page = mount({})
  const pending = page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  page.onHide()
  finishRead(completeRun(result))
  await pending
  assert.equal(page.data.found, false)
  assert.equal(page.data.routeMap, null)
})

test('超长历史轨迹分批写入地图，保留起终点、每段路线和中途空档', async t => {
  signIn(t)
  const gapAt = 20000
  const fixes = Array.from({ length: 22000 }, (_, i) => ({
    latitude: 31.123456789 + i * 0.00003, longitude: 121.123456789 + i * 0.00001,
    accuracy: 6, timestamp: 100 + i + (i >= gapAt ? 60 : 0)
  }))
  const result = { ...record('long-walk'), ended_at: fixes.at(-1).timestamp }
  t.mock.method(api, 'getRun', async () => ({ ...result, result, points: fixes }))
  const page = mount({ run_id: result.run_id })
  const limit = 1024 * 1024
  let largestUpdate = 0
  page.setData = function(values, callback) {
    largestUpdate = Math.max(largestUpdate, Buffer.byteLength(JSON.stringify(values)))
    for (const [path, value] of Object.entries(values)) {
      const fields = path.match(/[^.[\]]+/g)
      let target = this.data
      for (let i = 0; i < fields.length - 1; i++) {
        const name = fields[i]
        target[name] ??= /^\d+$/.test(fields[i + 1]) ? [] : {}
        target = target[name]
      }
      target[fields.at(-1)] = value
    }
    if (callback) setImmediate(callback)
  }
  await page.onShow()
  const positions = fixes.map(({ latitude, longitude }) => ({ latitude, longitude }))
  assert.ok(Buffer.byteLength(JSON.stringify(positions.slice(0, gapAt))) > limit)
  assert.ok(largestUpdate < limit, `最大一次地图更新为 ${largestUpdate} 字节`)
  const edges = page.data.routeMap.lines.flatMap(({ points }) =>
    points.slice(1).map((point, i) => [points[i], point]))
  const expected = positions.flatMap((point, i) => i === 0 || i === gapAt ? [] : [[positions[i - 1], point]])
  assert.deepEqual(edges, expected)
  const endpoints = page.data.routeMap.circles.map(({ latitude, longitude }) => ({ latitude, longitude }))
  assert.deepEqual(endpoints, [positions[0], positions.at(-1)])
})

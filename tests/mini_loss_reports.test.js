const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const results = require('../miniprogram/lib/results')

function loadPage(file) {
  let definition
  const previous = global.Page
  global.Page = page => { definition = page }
  try {
    delete require.cache[require.resolve(file)]
    require(file)
  } finally { global.Page = previous }
  const page = { ...definition, data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values) } }
  return page
}

const reportsPath = '../miniprogram/pages/reports/index'
function response(reports = [], cursor = null, template = 'example') {
  return { reports, next_cursor: cursor, notification: { template_id: template, subscribed: false } }
}
function report(id) {
  return { id, challenger_name: '跑者乙', ended_at: 1700000000, pace_s_per_km: 340, area_m2: 100,
    regions: [{ latitude: 31, longitude: 121, area_m2: 100 }] }
}

function device(t) {
  const previous = global.wx
  const storage = new Map()
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    setNavigationBarTitle: t.mock.fn(),
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, val) => storage.set(key, val),
    removeStorageSync: key => storage.delete(key),
    requestSubscribeMessage: t.mock.fn(() => assert.fail('不得自动弹订阅窗')),
    navigateTo: t.mock.fn()
  }
  t.after(() => { global.wx = previous })
  const current = { player: 'alice' }
  t.mock.method(api, 'playerId', () => current.player)
  t.mock.method(api, 'savedPlayerId', () => current.player)
  return current
}

test('开发版和体验版可直接看示例地块，正式版仍读取本人的战报', async t => {
  device(t)
  const read = t.mock.method(api, 'lossReports', async () => response())
  const boundary = t.mock.method(api, 'lossReportBoundary', async () => assert.fail('示例使用本地边界'))
  for (const envVersion of ['develop', 'trial', 'release']) {
    wx.getAccountInfoSync = () => ({ miniProgram: { envVersion } })
    const page = loadPage(reportsPath)
    page.onLoad({ samples: '1' })
    await page.onShow()
    if (envVersion === 'release') {
      assert.equal(page.data.sampleView, false)
      assert.equal(page.data.showSamplesLink, false)
      assert.deepEqual(page.data.rows, [])
      assert.equal(read.mock.callCount(), 1)
    } else {
      assert.equal(page.data.rows.length, 3)
      await page.showLocation({ currentTarget: { dataset: { report: 1, region: 2 } } })
      assert.equal(page.data.selected.index, 2)
      assert.equal(page.data.selected.bounds.length, 2)
      await page.onReachBottom()
      assert.equal(read.mock.callCount(), 0)
      assert.equal(boundary.mock.callCount(), 0)
    }
  }
})

test('实际跑步新占、夺得或守住后显示战报入口，只有失利或未闭环时隐藏', async t => {
  device(t)
  t.mock.method(api, 'login', async () => ({ player_id: 'alice' }))
  const run = { player_id: 'alice', distance_m: 800, ended_at: 1700000000, duration_s: 272,
    pace_s_per_km: 340, area_m2: 100, valid_loop: true }
  t.mock.method(results, 'get', () => run)
  const page = loadPage('../miniprogram/pages/result/index')
  page.onLoad()
  for (const outcome of ['claimed', 'captured', 'defended', 'failed']) {
    run.outcomes = [{ outcome, area_m2: 100, previous_owner: 'alice', pace_s_per_km: 340,
      previous_pace_s_per_km: 336, geometry: { coordinates: [[[121, 31], [121.01, 31], [121.01, 31.01], [121, 31]]] } }]
    await page.onShow()
    assert.equal(page.data.showReportEntry, outcome !== 'failed')
  }
  run.valid_loop = false
  run.outcomes = []
  await page.onShow()
  assert.equal(page.data.showReportEntry, false)
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 0)
})

test('已登录跑者查看战报时，分页使用服务端游标并显示地块位置', async t => {
  device(t)
  const read = t.mock.method(api, 'lossReports', async cursor =>
    cursor ? response([report('old')]) : response([report('recent')], 8))
  const boundary = t.mock.method(api, 'lossReportBoundary', async () => ({ geometry: null }))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  await page.loadMore()
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [[null, 'alice'], [8, 'alice']])
  assert.equal(page.data.cursor, null)
  assert.equal(page.data.rows[1].pace, '5:40')
  assert.equal(boundary.mock.callCount(), 0)
  await page.showLocation({ currentTarget: { dataset: { report: 1, region: 0 } } })
  assert.equal(page.data.selected.id, 'old')
  assert.equal(page.data.selected.markers[0].longitude, 121)
  assert.match(page.data.selected.hint, /仅记录了地块位置/)
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 0)
})

const select = (region, reportIndex = 0) => ({ currentTarget: { dataset: { report: reportIndex, region } } })
const outer = [[121, 31], [121.003, 31], [121.003, 31.002], [121.001, 31.001], [121, 31.002], [121, 31]]
const inner = [[121.0002, 31.0002], [121.0003, 31.0006], [121.0006, 31.0002], [121.0002, 31.0002]]
const polygon = (...coordinates) => ({ geometry: { type: 'Polygon', coordinates } })

test('点选才读边界，含洞地块只画真实环，同一地块收起再打开复用在途读取', async t => {
  device(t)
  const r = report('loss')
  r.regions.push({ latitude: 31.1, longitude: 121.1, area_m2: 120 })
  t.mock.method(api, 'lossReports', async () => response([r]))
  let resolveFirst
  const read = t.mock.method(api, 'lossReportBoundary', (_, index) => index === 1
    ? Promise.resolve(polygon(outer)) : new Promise(resolve => { resolveFirst = resolve }))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  assert.equal(read.mock.callCount(), 0)
  const first = page.showLocation(select(0))
  page.showLocation(select(0))
  const again = page.showLocation(select(0))
  assert.equal(read.mock.callCount(), 1)
  await page.showLocation(select(1))
  resolveFirst(polygon(outer, inner))
  await Promise.all([first, again])
  assert.equal(page.data.selected.index, 1)
  assert.equal(page.data.selected.markers.length, 0)
  assert.equal(page.data.selected.polygons.length, 1)
  assert.equal(page.data.selected.polygons[0].points.length, outer.length - 1)
  assert.equal(page.data.selected.lines.length, 0)
  await page.showLocation(select(0))
  const { bounds, markers, polygons, lines } = page.data.selected
  assert.equal(bounds.length, 2)
  assert.ok(bounds[0].longitude < outer[0][0])
  assert.ok(bounds[1].longitude > outer[1][0])
  assert.deepEqual(markers, [])
  assert.deepEqual(polygons, [])
  assert.deepEqual(lines.map(line => line.points.map(p => [p.longitude, p.latitude])), [outer, inner])
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [['loss', 0, 'alice'], ['loss', 1, 'alice']])
})

test('同页缓存最近使用的二十块边界，重访的地块优先保留', async t => {
  device(t)
  const r = report('loss')
  r.regions = Array.from({ length: 21 }, () => r.regions[0])
  t.mock.method(api, 'lossReports', async () => response([r]))
  const read = t.mock.method(api, 'lossReportBoundary', async () => polygon(outer))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  for (let i = 0; i < 20; i++) await page.showLocation(select(i))
  await page.showLocation(select(0))
  await page.showLocation(select(20))
  await page.showLocation(select(0))
  assert.equal(read.mock.callCount(), 21)
  await page.showLocation(select(1))
  assert.equal(read.mock.callCount(), 22)
  assert.equal(read.mock.calls[21].arguments[1], 1)
})

test('边界失败可重试，超密边界保留地块定位和原因，换号后不使用旧账号的边界缓存', async t => {
  const current = device(t)
  t.mock.method(api, 'lossReports', async () => response([report('loss')]))
  const read = t.mock.method(api, 'lossReportBoundary', async () => { throw new Error('连接中断') })
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  await page.showLocation(select(0))
  assert.equal(page.data.selected.error, '连接中断')
  let resolveRetry
  read.mock.mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve }))
  const retry = page.retryBoundary(select(0))
  current.player = 'bob'
  await page.onShow()
  assert.equal(page.data.selected, null)
  read.mock.mockImplementation(async () => ({ geometry: null, reason: 'too_complex' }))
  await page.showLocation(select(0))
  resolveRetry(polygon(outer))
  await retry
  assert.match(page.data.selected.hint, /边界过于复杂/)
  assert.equal(page.data.selected.markers.length, 1)
  assert.equal(read.mock.callCount(), 3)
  assert.equal(read.mock.calls[2].arguments[2], 'bob')
})

test('缺少模板或拒绝时仍可查报，云端不登记订阅', async t => {
  device(t)
  const read = t.mock.method(api, 'lossReports', async () => response([report('new')], null, ''))
  const save = t.mock.method(api, 'subscribeLossNotice', async () => assert.fail('没有授权不得登记'))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  await page.subscribe()
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 0)
  read.mock.mockImplementation(async () => response([report('new')]))
  await page.onShow()
  wx.requestSubscribeMessage.mock.mockImplementation(({ success }) => success({ example: 'reject' }))
  await page.subscribe()
  assert.equal(save.mock.callCount(), 0)
  assert.equal(page.data.subscribed, false)
  assert.equal(page.data.rows[0].id, 'new')
})

test('授权弹窗在点击时同步发起；连点、响应丢失后重新打开均只使用同一份授权', async t => {
  device(t)
  t.mock.method(api, 'lossReports', async () => response())
  const save = t.mock.method(api, 'subscribeLossNotice', async () => { throw new Error('网络断开') })
  let accept
  wx.requestSubscribeMessage.mock.mockImplementation(({ tmplIds, success }) => {
    assert.deepEqual(tmplIds, ['example'])
    accept = () => success({ example: 'accept' })
  })
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  const first = page.subscribe()
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 1)
  await page.subscribe()
  accept()
  await first
  assert.equal(page.data.pending, true)
  page.onUnload()
  const reopened = loadPage(reportsPath)
  reopened.onLoad()
  await reopened.onShow()
  assert.equal(reopened.data.pending, true)
  save.mock.mockImplementation(async () => ({ template_id: 'example', subscribed: true }))
  await reopened.subscribe()
  await reopened.subscribe()
  assert.equal(reopened.data.subscribed, true)
  assert.equal(reopened.data.pending, false)
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 1)
  assert.equal(save.mock.callCount(), 2)
  const [template, grant, player] = save.mock.calls[0].arguments
  assert.ok(grant)
  assert.deepEqual(save.mock.calls[1].arguments, [template, grant, player])
})

test('切换微信身份后丢弃旧战报及未完成的弹窗授权', async t => {
  const current = device(t)
  const read = t.mock.method(api, 'lossReports', async (_, owner) => response([report(owner)]))
  const save = t.mock.method(api, 'subscribeLossNotice', async () => assert.fail('不能为另一账号登记'))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  let accept, finish
  wx.requestSubscribeMessage.mock.mockImplementation(({ success }) => { accept = success })
  const prompt = page.subscribe()
  read.mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = page.onShow()
  current.player = 'bob'
  await page.onShow()
  finish(response([report('alice')]))
  accept({ example: 'accept' })
  await Promise.all([prompt, old])
  assert.equal(save.mock.callCount(), 0)
  assert.equal(page.data.player, 'bob')
  assert.deepEqual(page.data.rows.map(row => row.id), ['bob'])
})

test('微信授权期间模板停用，保留战报并停止登记旧模板', async t => {
  device(t)
  let template = 'example'
  t.mock.method(api, 'lossReports', async () => response([report('recent')], null, template))
  t.mock.method(api, 'subscribeLossNotice', async () => {
    template = ''
    throw Object.assign(new Error('模板已停用'), { code: 'notice_unavailable' })
  })
  wx.requestSubscribeMessage.mock.mockImplementation(({ success }) => success({ example: 'accept' }))
  const page = loadPage(reportsPath)
  page.onLoad()
  await page.onShow()
  await page.subscribe()
  await page.subscribe()
  assert.equal(page.data.template, '')
  assert.equal(page.data.pending, false)
  assert.equal(page.data.rows[0].id, 'recent')
  assert.equal(wx.requestSubscribeMessage.mock.callCount(), 1)
})

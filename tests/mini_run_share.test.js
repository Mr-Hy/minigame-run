const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const results = require('../miniprogram/lib/results')
const poster = require('../miniprogram/lib/run-poster')

let stats, resultPage
global.Page = definition => { stats = definition }
require('../miniprogram/pages/run-stats/index')
global.Page = definition => { resultPage = definition }
require('../miniprogram/pages/result/index')
delete global.Page

const player = 'runner'
const current = { run_id: 'latest', player_id: player, started_at: 100, ended_at: 145,
  outcomes: [], valid_loop: false, distance_m: 450, duration_s: 45, pace_s_per_km: 100, area_m2: 0, max_gap_s: 45 }
const past = { ...current, run_id: '旧记录/a&b', distance_m: 800 }
const standings = { national: { distance: { rank: 2, value: 1250 }, area: null }, provinces: [] }
const points = [{ latitude: 31.23, longitude: 121.47, timestamp: 100, accuracy: 5 },
  { latitude: 31.231, longitude: 121.472, timestamp: 145, accuracy: 5 }]
const turn = () => new Promise(resolve => setImmediate(resolve))

function mount(options = {}) {
  const page = { ...resultPage, data: structuredClone(resultPage.data), prepareReplaySurface: async () => null,
    setData(values, done) { Object.assign(this.data, values); if (done) done() } }
  page.onLoad(options)
  return page
}

function setup(t) {
  t.mock.method(api, 'login', async () => ({ player_id: player }))
  t.mock.method(api, 'playerId', () => player)
  t.mock.method(results, 'get', () => current)
  t.mock.method(api, 'shareStandings', async () => standings)
  const oldWx = global.wx
  t.after(() => { global.wx = oldWx })
  global.wx = { showShareImageMenu: t.mock.fn(({ success }) => success()), previewImage: t.mock.fn(({ success }) => success()) }
  return t.mock.method(poster, 'generateRunPoster', async (_, result) => result.run_id + '.png')
}

test('历史分享按选中的记录与完整轨迹生成海报，返回详情后不会自动再弹', async t => {
  const generate = setup(t)
  const navigate = wx.navigateTo = t.mock.fn()
  const list = { ...stats, data: { player, rows: [{ id: current.run_id }, { id: past.run_id }] } }
  for (const share of [false, true]) list.openRun({ currentTarget: { dataset: { id: past.run_id, share } } })
  const [detail, share] = navigate.mock.calls.map(call => call.arguments[0].url)
  assert.equal(detail, '/pages/result/index?run_id=' + encodeURIComponent(past.run_id))
  assert.equal(share, detail + '&share=1')
  let finishRead
  const read = t.mock.method(api, 'getRun', () => new Promise(resolve => { finishRead = resolve }))
  const page = mount(Object.fromEntries(new URL(share, 'https://test.invalid').searchParams))
  const pending = page.onShow()
  page.onReady()
  await turn()
  assert.deepEqual(read.mock.calls[0].arguments, [past.run_id, player, true])
  assert.equal(generate.mock.callCount(), 0)
  const run = { ...past, result: past, points }
  finishRead(run)
  await pending
  await turn()
  assert.equal(generate.mock.callCount(), 1)
  const [, result, route, scores] = generate.mock.calls[0].arguments
  assert.deepEqual(api.shareStandings.mock.calls[0].arguments, [past.run_id, player])
  assert.equal(scores, standings)
  assert.equal(result, past)
  assert.deepEqual(route.lines[0].points, points.map(({ latitude, longitude }) => ({ latitude, longitude })))
  const menu = wx.showShareImageMenu.mock.calls[0].arguments[0]
  assert.equal(menu.path, past.run_id + '.png')
  assert.equal(menu.needShowEntrance, true)
  assert.equal(menu.entrancePath, '/pages/run/index')
  page.onHide()
  read.mock.mockImplementation(async () => run)
  await page.onShow()
  assert.equal(generate.mock.callCount(), 1)
})

test('当次结算等待轨迹读完再分享，连续点击仅生成一次', async t => {
  const generate = setup(t)
  let finishRead, finishPoster
  t.mock.method(api, 'getRun', () => new Promise(resolve => { finishRead = resolve }))
  generate.mock.mockImplementation(() => new Promise(resolve => { finishPoster = resolve }))
  const page = mount()
  const pending = page.onShow()
  page.onReady()
  await turn()
  assert.equal(page.data.found, true)
  await page.shareRun()
  assert.equal(generate.mock.callCount(), 0)
  finishRead({ ...current, result: current, points })
  await pending
  const sharing = page.shareRun()
  await page.shareRun()
  assert.equal(generate.mock.callCount(), 1)
  assert.equal(generate.mock.calls[0].arguments[1], current)
  assert.equal(generate.mock.calls[0].arguments[2].lines[0].points.length, 2)
  finishPoster('current.png')
  await sharing
  assert.deepEqual(wx.showShareImageMenu.mock.calls.map(call => call.arguments[0].path), ['current.png'])
})

test('离开跑步记录后生成完成的海报不会打开微信分享或预览', async t => {
  const generate = setup(t)
  t.mock.method(api, 'getRun', async () => ({ result: past }))
  for (const leave of ['onHide', 'onUnload']) {
    let finishPoster
    generate.mock.mockImplementation(() => new Promise(resolve => { finishPoster = resolve }))
    const page = mount({ run_id: past.run_id, share: '1' })
    await page.onShow()
    page.onReady()
    await turn()
    page[leave]()
    finishPoster('late.png')
    await turn()
  }
  assert.equal(wx.showShareImageMenu.mock.callCount(), 0)
  assert.equal(wx.previewImage.mock.callCount(), 0)
})

test('榜单网络故障仍可分享基础记录，账号切换则停止分享', async t => {
  const generate = setup(t)
  t.mock.method(api, 'getRun', async () => ({ result: current }))
  const page = mount()
  await page.onShow()
  page.onReady()
  api.shareStandings.mock.mockImplementation(async () => { throw new Error('网络错误') })
  await page.shareRun()
  assert.equal(generate.mock.calls[0].arguments[3], undefined)
  assert.match(page.data.shareHint, /排行榜/)
  api.shareStandings.mock.mockImplementation(async () => {
    api.playerId.mock.mockImplementation(() => 'other')
    return standings
  })
  await page.shareRun()
  assert.equal(generate.mock.callCount(), 1)
  assert.equal(wx.showShareImageMenu.mock.callCount(), 1)
})

test('取消分享后可再次操作，微信无分享图片菜单时预览同一张海报', async t => {
  setup(t)
  t.mock.method(api, 'getRun', async () => ({ result: current }))
  wx.showShareImageMenu.mock.mockImplementation(({ fail }) => fail({ errMsg: 'showShareImageMenu:fail cancel' }))
  const page = mount()
  await page.onShow()
  page.onReady()
  await page.shareRun()
  assert.equal(page.data.sharing, false)
  assert.equal(page.data.shareHint, '')
  assert.equal(wx.previewImage.mock.callCount(), 0)
  delete wx.showShareImageMenu
  await page.shareRun()
  const { current: image, urls } = wx.previewImage.mock.calls[0].arguments[0]
  assert.equal(image, current.run_id + '.png')
  assert.deepEqual(urls, [image])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const tracker = require('../miniprogram/lib/tracker')
const results = require('../miniprogram/lib/results')
const { shortNickname } = require('../miniprogram/lib/nickname')

let definition
global.Page = page => { definition = page }
require('../miniprogram/pages/run/index')
delete global.Page

const bounds = { west: 0, east: 10, south: 0, north: 10 }
const territory = {
  id: 9, owner: 'runner-a', area_m2: 1000, pace_s_per_km: 360,
  geometry: { coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  label_point: { latitude: 4, longitude: 6 }, owner_number: 7,
  owner_display_name: '跑者_00007'
}

function mapPage(t, playerId = () => 'runner-a') {
  t.mock.method(api, 'playerId', playerId)
  const page = { ...definition, data: { ...definition.data }, _visible: true,
    setData(values) { Object.assign(this.data, values) } }
  page.onLoad()
  page._player = playerId()
  page.data.signedIn = !!page._player
  return page
}

test('旗面保留四个字符，超长昵称保留前三个完整字符和省略号', () => {
  for (const [name, expected] of [
    ['跑者乙', '跑者乙'], ['东门跑者', '东门跑者'], ['东门跑步小队', '东门跑…'],
    ['👩🏽‍🚀🇨🇳e\u0301乙', '👩🏽‍🚀🇨🇳e\u0301乙'], ['👩🏽‍🚀🇨🇳e\u0301乙甲', '👩🏽‍🚀🇨🇳e\u0301…']
  ]) assert.equal(shortNickname(name), expected)
})

test('本人标记常显简称，点地块或昵称均可查看全名', async t => {
  const page = mapPage(t)
  t.mock.method(api, 'map', async () => ({ bounds, territories: [territory] }))
  await page.refreshMap()
  const [marker] = page.data.markers
  assert.equal(marker.id, territory.id)
  assert.equal(marker.latitude, territory.label_point.latitude)
  assert.equal(marker.longitude, territory.label_point.longitude)
  assert.equal(marker.callout.content, '我 · 跑者_…')
  assert.equal(marker.callout.bgColor, '#244E3C')
  assert.equal(marker.iconPath, '/assets/park-active.png')
  assert.equal(marker.callout.display, 'ALWAYS')
  assert.deepEqual(page.data.ownerCallouts, [])
  page.selectTerritory({ detail: territory.label_point })
  assert.equal(page.data.circles[0].color, '#173F32')
  assert.equal(page.data.selection.label, '我 · 跑者_00007')
  page.selectMarker({ detail: { markerId: territory.id } })
  assert.equal(page.data.selection.label, '我 · 跑者_00007')
  assert.match(page.data.selection.detail, /6:00/)
})

test('实地地图选中、缩放、切换和取消时，头像昵称与顶面同步，轨迹仍在实际位置', async t => {
  const page = mapPage(t)
  const first = { ...territory, id: 1, owner: 'runner-b', owner_display_name: '跑者乙',
    marker_icon: 'https://storage.example/b.jpg' }
  const second = { ...territory, id: 2 }
  function place(land, west) {
    const east = west + 0.001
    land.geometry = { coordinates: [[[west,31], [east,31], [east,31.001], [west,31.001], [west,31]]] }
    land.label_point = { longitude: west + 0.0005, latitude: 31.0005 }
  }
  place(first, 121)
  place(second, 121.001)
  const view = { west: 120.998, east: 121.004, south: 30.998, north: 31.002 }
  t.mock.method(api, 'map', async () => structuredClone({ bounds: view, territories: [first, second] }))
  const route = { points: [first.label_point, second.label_point], color: '#BE542A' }
  page._routeLines = [route]
  await page.refreshMap()
  page.selectMarker({ detail: { markerId: first.id } })
  const marker = id => page.data.markers.find(item => item.id === id)
  assert.ok(marker(first.id).latitude > first.label_point.latitude)
  assert.equal(marker(first.id).latitude, page.data.circles[0].latitude)
  assert.equal(marker(second.id).latitude, second.label_point.latitude)
  assert.deepEqual(page.data.ownerCallouts.map(({ nickname, avatar }) => [nickname, avatar]), [['跑者乙', first.marker_icon]])
  const flatToRaised = marker(first.id).latitude - first.label_point.latitude
  page._mapWidth = 375
  const span = 360 * page._mapWidth / (2 * page._viewScale)
  page.regionChanged({ type: 'regionchange', detail: { type: 'end', scale: 18,
    region: { southwest: { longitude: 121, latitude: 31 }, northeast: { longitude: 121 + span, latitude: 31.002 } } } })
  clearTimeout(page._regionTimer)
  const afterZoom = marker(first.id).latitude - first.label_point.latitude
  assert.ok(Math.abs(afterZoom / flatToRaised - 0.5) < 0.001)
  await page.refreshMap()
  assert.equal(page.data.selection.label, first.owner_display_name)
  assert.equal(marker(first.id).latitude, page.data.circles[0].latitude)
  page.selectTerritory({ detail: second.label_point })
  assert.equal(marker(first.id).latitude, first.label_point.latitude)
  assert.ok(marker(second.id).latitude > second.label_point.latitude)
  page.selectTerritory({ detail: { longitude: 120.999, latitude: 30.999 } })
  assert.equal(page.data.selection.label, '空地')
  assert.equal(marker(second.id).latitude, second.label_point.latitude)
  assert.deepEqual(page.data.polylines.at(-1), route)
})

test('夺地后常显新领主简称，较早的地图响应不能覆盖新领主', async t => {
  const page = mapPage(t)
  const pending = []
  t.mock.method(api, 'map', () => new Promise(resolve => pending.push(resolve)))
  const first = page.refreshMap()
  await Promise.resolve()
  const second = page.refreshMap()
  await Promise.resolve()
  const captured = { ...territory, owner: 'runner-b', owner_number: 45219,
    owner_display_name: '西湖晨跑小队', marker_icon: 'https://storage.example/runner-b.png' }
  pending[1]({ bounds, territories: [captured] })
  await second
  pending[0]({ bounds, territories: [territory] })
  await first
  const marker = page.data.markers[0]
  assert.equal(marker.iconPath, '/assets/park-active.png')
  assert.equal(marker.customCallout.display, 'ALWAYS')
  assert.equal(page.data.ownerCallouts[0].nickname, '西湖晨…')
  assert.equal(page.data.ownerCallouts[0].avatar, captured.marker_icon)
  page.selectMarker({ detail: { markerId: marker.id } })
  assert.equal(page.data.selection.label, '西湖晨跑小队')
})

test('游客进入实地跑步页自动定位一次，仍可手动定位和点选领地，点开始跑步才去登录', async t => {
  const page = mapPage(t, () => '')
  t.mock.method(api, 'hasSavedLogin', () => false)
  const login = t.mock.method(api, 'login')
  const subscribe = t.mock.method(tracker, 'subscribe')
  const restore = t.mock.method(tracker, 'restore')
  const start = t.mock.method(tracker, 'start')
  const lastResult = t.mock.method(results, 'get')
  const readMap = t.mock.method(api, 'map', async () => ({ bounds, territories: [territory] }))
  const oldWx = global.wx
  t.after(() => { global.wx = oldWx })
  const navigate = t.mock.fn()
  const settings = {}
  const fixes = [{ latitude: 5, longitude: 6 }, { latitude: 8, longitude: 3 }]
  const authorize = t.mock.fn(({ scope, success }) => {
    assert.equal(scope, 'scope.userLocation')
    settings[scope] = true
    success({})
  })
  const locate = t.mock.fn(({ type, success }) => {
    assert.equal(type, 'gcj02')
    assert.equal(settings['scope.userLocation'], true)
    success(fixes.shift())
  })
  global.wx = {
    getSetting: ({ success }) => success({ authSetting: settings }),
    authorize,
    createMapContext: () => ({
      getRegion: ({ success }) => success({ southwest: { latitude: 0, longitude: 0 }, northeast: { latitude: 10, longitude: 10 } }),
      moveToLocation() {}
    }),
    navigateTo: navigate, getLocation: locate
  }
  await page.onShow()
  await page.onReady()
  assert.equal(locate.mock.callCount(), 1)
  assert.equal(page.data.latitude, 5)
  assert.equal(page.data.longitude, 6)
  assert.equal(page.data.locationEnabled, true)
  assert.equal(page.data.signedIn, false)
  assert.deepEqual(readMap.mock.calls[0].arguments, [bounds])
  const [marker] = page.data.markers
  assert.equal(page.data.ownerCallouts[0].nickname, '跑者_…')
  assert.equal(page.data.ownerCallouts[0].avatar, '')
  page.selectMarker({ detail: { markerId: marker.id } })
  assert.equal(page.data.selection.area, '1,000 m²')
  assert.match(page.data.selection.detail, /6:00/)
  await page.locate()
  assert.equal(locate.mock.callCount(), 2)
  assert.equal(authorize.mock.callCount(), 1)
  assert.equal(page.data.latitude, 8)
  assert.equal(page.data.longitude, 3)
  assert.equal(navigate.mock.callCount(), 0)
  await page.startRun()
  assert.deepEqual(navigate.mock.calls[0].arguments[0], { url: '/pages/login/index?from=run' })
  for (const method of [login, subscribe, restore, start, lastResult]) assert.equal(method.mock.callCount(), 0)
})

test('游客已拒绝前台定位时每次进入都提示，首次取消后可在下次进入授权并立即定位', async t => {
  const page = mapPage(t, () => '')
  const oldWx = global.wx
  t.after(() => { page.onUnload(); global.wx = oldWx })
  t.mock.method(api, 'hasSavedLogin', () => false)
  t.mock.method(api, 'map', async () => ({ bounds, territories: [] }))
  const events = []
  let confirm = false
  let returnedFromSettings
  const settings = { 'scope.userLocation': false }
  const fix = { latitude: 30.25, longitude: 120.16 }
  global.wx = {
    getSetting: ({ success }) => success({ authSetting: settings }),
    showModal(options) {
      events.push('modal')
      assert.doesNotMatch(options.title + options.content, /后台/)
      options.success({ confirm, cancel: !confirm })
    },
    openSetting({ success }) {
      events.push('settings')
      page.onHide()
      settings['scope.userLocation'] = true
      returnedFromSettings = page.onShow()
      success({ authSetting: settings })
    },
    getLocation({ type, success, fail }) {
      if (!settings['scope.userLocation']) return fail({ errMsg: 'getLocation:fail auth deny' })
      assert.equal(type, 'gcj02')
      events.push('located')
      success(fix)
    },
    createMapContext: () => ({ getRegion: ({ fail }) => fail(), moveToLocation() {} })
  }
  await page.onShow()
  await page.onReady()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['modal'])
  page.onHide()
  confirm = true
  await page.onShow()
  await new Promise(resolve => setImmediate(resolve))
  await returnedFromSettings
  assert.deepEqual(events, ['modal', 'modal', 'settings', 'located'])
  assert.equal(page.data.latitude, fix.latitude)
  assert.equal(page.data.longitude, fix.longitude)
  assert.equal(page.data.locationEnabled, true)
})

test('进入跑步页的定位迟于跑步轨迹返回时，地图保持在轨迹位置', async t => {
  const page = mapPage(t)
  const oldWx = global.wx
  t.after(() => { page.onUnload(); global.wx = oldWx })
  t.mock.method(api, 'hasSavedLogin', () => true)
  t.mock.method(api, 'map', async () => ({ bounds, territories: [] }))
  t.mock.method(results, 'get', () => null)
  t.mock.method(tracker, 'restore', async () => {})
  const locate = t.mock.fn()
  global.wx = {
    getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': true } }),
    getLocation: locate,
    createMapContext: () => ({ getRegion: ({ fail }) => fail(), moveToLocation() {} })
  }
  const showing = page.onShow()
  const ready = page.onReady()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(locate.mock.callCount(), 1)
  const trail = { latitude: 30.25, longitude: 120.16 }
  page.showTrack({ phase: 'running', elapsed: 1, points: [trail] })
  locate.mock.calls[0].arguments[0].success({ latitude: 23.13, longitude: 113.26 })
  await Promise.all([showing, ready])
  assert.equal(page.data.latitude, trail.latitude)
  assert.equal(page.data.longitude, trail.longitude)
})

for (const [reason, service, authorization, failure, guidance] of [
  ['手机定位关闭', false, 'authorized', '', /位置服务|定位服务|定位开关|(?:开启|打开).{0,6}(?:定位|位置)/],
  ['微信的系统定位权限被拒绝', true, 'denied', '', /微信/],
  ['系统状态未知但定位接口返回系统权限被拒绝', undefined, undefined, 'getLocation:fail system permission denied', /微信|系统/]
]) {
  test(reason + '时进入和点定位均提示，恢复后重新进入按实际坐标居中', async t => {
    const page = mapPage(t, () => '')
    const oldWx = global.wx
    t.after(() => { page.onUnload(); global.wx = oldWx })
    t.mock.method(api, 'hasSavedLogin', () => false)
    t.mock.method(api, 'map', async () => ({ bounds, territories: [] }))
    const dialogs = []
    const move = t.mock.fn()
    const fix = { latitude: 30.25, longitude: 120.16 }
    let restored = false
    global.wx = {
      getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': true } }),
      getSystemSetting: () => ({ locationEnabled: restored || service }),
      getAppAuthorizeSetting: () => ({ locationAuthorized: restored ? 'authorized' : authorization }),
      showModal({ title, content, success }) {
        dialogs.push(title + content)
        success({ confirm: false, cancel: true })
      },
      getLocation({ success, fail }) {
        if (failure && !restored) return fail({ errMsg: failure })
        success(fix)
      },
      createMapContext: () => ({ getRegion: ({ fail }) => fail(), moveToLocation: move })
    }
    await page.onShow()
    await page.onReady()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(dialogs.length, 1)
    assert.match(dialogs[0], guidance)
    await page.locate()
    assert.equal(dialogs.length, 2)
    assert.match(dialogs[1], guidance)
    assert.equal(move.mock.callCount(), 0)
    assert.equal(page.data.locationEnabled, false)

    page.onHide()
    restored = true
    await page.onShow()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(dialogs.length, 2)
    assert.equal(page.data.latitude, fix.latitude)
    assert.equal(page.data.longitude, fix.longitude)
    assert.equal(page.data.locationEnabled, true)
  })
}

test('点去设置打开微信的系统权限，未重新触发 onShow 也会在授权后立即定位', async t => {
  const page = mapPage(t, () => '')
  const oldWx = global.wx
  t.after(() => { page.onUnload(); global.wx = oldWx })
  const events = []
  let permission = 'denied'
  const checked = []
  const fix = { latitude: 30.26, longitude: 120.15 }
  global.wx = {
    getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': true } }),
    getSystemSetting: () => ({ locationEnabled: true }),
    getAppAuthorizeSetting() {
      checked.push(permission)
      return { locationAuthorized: permission }
    },
    showModal({ success }) {
      events.push('modal')
      success({ confirm: true })
    },
    openAppAuthorizeSetting({ success }) {
      events.push('systemSettings')
      permission = 'authorized'
      success({})
    },
    getLocation({ success }) {
      events.push('located')
      success(fix)
    }
  }
  await page.locate()
  assert.deepEqual(events, ['modal', 'systemSettings', 'located'])
  assert.equal(checked.at(-1), 'authorized')
  assert.equal(page.data.latitude, fix.latitude)
  assert.equal(page.data.longitude, fix.longitude)
  assert.equal(page.data.locationEnabled, true)
})

test('已授予定位权限但取点超时时，点定位会反馈失败并保留地图位置', async t => {
  const page = mapPage(t, () => '')
  const oldWx = global.wx
  t.after(() => { page.onUnload(); global.wx = oldWx })
  const notices = []
  const center = { latitude: 30.25, longitude: 120.16 }
  page.setData(center)
  global.wx = {
    getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': true } }),
    getSystemSetting: () => ({ locationEnabled: true }),
    getAppAuthorizeSetting: () => ({ locationAuthorized: 'authorized' }),
    getLocation: ({ fail }) => fail({ errMsg: 'getLocation:fail timeout' }),
    showToast: ({ title }) => notices.push(title),
    showModal({ title, content, success }) {
      notices.push(title + content)
      success({ confirm: false, cancel: true })
    }
  }
  await page.locate()
  assert.match([page.data.locationError, ...notices].join(' '), /重试|再试|失败|超时/)
  assert.equal(page.data.latitude, center.latitude)
  assert.equal(page.data.longitude, center.longitude)
})

test('会话在地图请求期间失效，清除原账号位置与轨迹后仍可查看公园领地', async t => {
  let player = territory.owner
  const page = mapPage(t, () => player)
  page._routeLines = [{ points: [territory.label_point] }]
  page.setData({ latitude: 1, locationEnabled: true, hasResult: true, polylines: page._routeLines })
  let deliverOld
  const read = t.mock.method(api, 'map', () => new Promise(resolve => { deliverOld = resolve }))
  const pending = page.refreshMap()
  await Promise.resolve()
  player = ''
  read.mock.mockImplementation(async () => ({ bounds, territories: [territory] }))
  deliverOld({ bounds, territories: [] })
  await pending
  assert.equal(page.data.signedIn, false)
  assert.equal(page.data.hasResult, false)
  assert.equal(page.data.locationEnabled, false)
  assert.equal(page.data.latitude, api.config.origin.latitude)
  assert.equal(page._routeLines.length, 0)
  assert.equal(page.data.ownerCallouts[0].nickname, '跑者_…')
  assert.equal(read.mock.callCount(), 2)
})

test('头像按地块绑定，头像加载失败后同一领主的多个标记都退回昵称，新头像可再次显示', async t => {
  const page = mapPage(t)
  const other = { ...territory, id: 10, owner: 'runner-b', owner_display_name: '西湖晨跑小队',
    marker_icon: 'https://storage.example/b-1.png' }
  const second = { ...other, id: 11, label_point: { latitude: 1, longitude: 2 } }
  const own = { ...territory, marker_icon: 'https://storage.example/me.png' }
  // Separate the shapes so a tap on the second marker resolves to its own land.
  const square = (low, high) => ({ coordinates: [[[low,low],[high,low],[high,high],[low,high],[low,low]]] })
  own.geometry = square(7, 10)
  own.label_point = { latitude: 8, longitude: 8 }
  other.geometry = square(4, 7)
  second.geometry = square(0, 3)
  const territories = [own, other, second]
  t.mock.method(api, 'map', async () => ({ bounds, territories }))
  await page.refreshMap()
  assert.deepEqual(page.data.ownerCallouts.map(flag => flag.id), [10, 11])
  assert.ok(page.data.ownerCallouts.every(flag => flag.avatar === other.marker_icon))
  page.selectMarker({ currentTarget: { dataset: { id: '11' } }, detail: {} })
  assert.deepEqual(page._selected, second.label_point)
  assert.equal(page.data.selection.label, other.owner_display_name)
  assert.match(page.data.selection.detail, /6:00/)

  const fail = url => page.markerAvatarError({ currentTarget: { dataset: { avatar: url } } })
  fail(other.marker_icon)
  page.selectTerritory({ detail: other.label_point })
  assert.equal(page.data.selection.label, other.owner_display_name)
  assert.ok(page.data.ownerCallouts.every(flag => !flag.avatar && flag.nickname === '西湖晨…'))
  const previous = other.marker_icon
  other.marker_icon = second.marker_icon = 'https://storage.example/b-2.png'
  await page.refreshMap()
  fail(previous)
  assert.ok(page.data.ownerCallouts.every(flag => flag.avatar === other.marker_icon))
})

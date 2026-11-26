const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')
const tracker = require('../miniprogram/lib/tracker')

let definition
global.Page = page => { definition = page }
require('../miniprogram/pages/run/index')
delete global.Page

function locationDenied(scope) {
  return Object.assign(new Error('位置权限未开启'), { code: 'location_permission_denied', scope })
}
const denied = locationDenied('scope.userLocationBackground')
const granted = { 'scope.userLocation': true, 'scope.userLocationBackground': true }

async function clickStart(t, { failures = [], confirm = true, settings = granted, knownSettings }) {
  const events = []
  let currentSettings = {}
  const oldWx = global.wx
  t.after(() => { global.wx = oldWx })
  t.mock.method(api, 'playerId', () => 'wx-first')
  t.mock.method(tracker, 'start', async () => {
    events.push('start')
    const failure = failures.shift()
    if (failure) throw failure
  })

  function reply(options = {}, result) {
    return Promise.resolve(result).then(value => {
      if (options.success) options.success(value)
      if (options.complete) options.complete(value)
      return value
    })
  }

  global.wx = {
    getSetting(options) { return reply(options, { authSetting: currentSettings }) },
    showModal(options) {
      events.push('modal')
      return reply(options, { confirm, cancel: !confirm })
    },
    openSetting(options) {
      events.push('settings')
      currentSettings = settings
      return reply(options, { authSetting: settings })
    }
  }
  const page = { ...definition, data: { ...definition.data }, _visible: true,
    setData(values) { Object.assign(this.data, values) } }
  page.onLoad()
  page._player = 'wx-first'
  page.data.signedIn = true
  if (knownSettings) {
    currentSettings = knownSettings
    page.updatePermissions(knownSettings)
  }
  await page.startRun()
  await new Promise(resolve => setImmediate(resolve))
  return events
}

const scenarios = [
  ['首次开跑成功不弹窗', {}, ['start']],
  ['普通定位失败不弹窗', { failures: [new Error('定位信号不足')] }, ['start']],
  ['拒绝授权后取消弹窗，停在跑步页', { failures: [denied], confirm: false }, ['start', 'modal']],
  ['设置里后台授权仍被拒绝，不重试', { failures: [denied], settings: { ...granted, 'scope.userLocationBackground': false } }, ['start', 'modal', 'settings']],
  ['设置里前台授权仍被拒绝，不重试', { failures: [denied], settings: { ...granted, 'scope.userLocation': false } }, ['start', 'modal', 'settings']],
  ['首次补授前台定位后，继续发起尚未询问的后台授权', {
    failures: [locationDenied('scope.userLocation')], settings: { 'scope.userLocation': true }
  }, ['start', 'modal', 'settings', 'start']],
  ['已知此前拒绝定位，点击开跑直接去授权，授权后仅开跑一次', {
    knownSettings: { 'scope.userLocation': false, 'scope.userLocationBackground': false }
  }, ['modal', 'settings', 'start']],
  ['确认去设置并授予两项权限，自动开跑一次', { failures: [denied] }, ['start', 'modal', 'settings', 'start']],
  ['重试时再次被拒绝，不循环弹窗或重试', { failures: [denied, denied] }, ['start', 'modal', 'settings', 'start']]
]

for (const [name, input, expected] of scenarios) {
  test(name, async t => assert.deepEqual(await clickStart(t, input), expected))
}

for (const verified of [true, false]) {
  const state = verified ? '微信身份已核验而页面仍为游客' : '冷启动进入实跑页且云端身份仍在恢复'
  test(state + '时，连点开跑只订阅和开始一次', async t => {
    const player = 'wx-' + 'a'.repeat(64)
    const events = []
    const oldWx = global.wx
    t.after(() => { global.wx = oldWx })
    global.wx = {
      navigateTo: () => events.push('navigate'),
      getSetting: ({ success }) => success({ authSetting: granted }),
      getStorageSync: () => null
    }
    const account = { player_id: player, runner_number: 1, display_name: '跑者_00001',
      avatar_url: 'cloud://test.storage/running-avatars/1.png' }
    let restoreIdentity
    const cloud = t.mock.fn(({ data }) => {
      assert.deepEqual(data, { action: 'login' })
      return new Promise(resolve => { restoreIdentity = () => resolve({ result: account }) })
    })
    if (verified) {
      t.mock.method(api, 'hasSavedLogin', () => true)
      t.mock.method(api, 'playerId', () => player)
      t.mock.method(api, 'login', () => assert.fail('已核验的身份应直接同步到页面'))
    } else {
      wx.getStorageSync = key => key.startsWith('park.cloud.profile.') ? account : null
      wx.setStorageSync = () => {}
      wx.cloud = { init() {}, callFunction: cloud }
    }
    t.mock.method(tracker, 'subscribe', listener => {
      events.push('subscribe')
      listener(tracker.snapshot())
      return () => {}
    })
    t.mock.method(tracker, 'restore', async () => {})
    t.mock.method(tracker, 'start', async () => { events.push('start') })

    const page = { ...definition, data: { ...definition.data }, _visible: true,
      setData(values) { Object.assign(this.data, values) } }
    page.onLoad()
    t.after(() => page.onHide())
    assert.equal(page.data.signedIn, false)
    const onShow = verified ? null : page.onShow()
    const first = page.startRun()
    const second = page.startRun()
    if (!verified) {
      assert.equal(api.playerId(), '')
      assert.equal(cloud.mock.callCount(), 1)
      assert.deepEqual(events, [])
      restoreIdentity()
    }
    await Promise.all([onShow, first, second])

    assert.equal(page.data.signedIn, true)
    assert.equal(page.canUseRun(), true)
    assert.deepEqual(events, ['subscribe', 'start'])
  })
}

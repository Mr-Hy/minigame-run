const test = require('node:test')
const assert = require('node:assert/strict')

const apiFile = require.resolve('../miniprogram/lib/api')
const cloudStorage = 'cloud://cloud1-d5gnvayfnb1fa1cd4.636c-cloud1-d5gnvayfnb1fa1cd4-1234567890/running-avatars/'

function device(t, send) {
  const previous = global.wx
  const storage = new Map()
  t.after(() => { global.wx = previous; delete require.cache[apiFile] })
  global.wx = {
    cloud: {
      init() {},
      callFunction(options) {
        assert.equal(options.name, 'running')
        const task = Promise.resolve().then(() => send(options.data)).then(result => ({ result }))
        if (options.success || options.fail) task.then(options.success, options.fail)
        return task
      }
    },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({
      readFile: ({ filePath, encoding, success }) => {
        assert.equal(encoding, 'base64')
        success({ data: Buffer.from(filePath).toString('base64') })
      }
    })
  }
  return function restart() {
    delete require.cache[apiFile]
    return require(apiFile)
  }
}

function profile(id, number) {
  return { player_id: 'wx-' + id.repeat(64), runner_number: number,
    display_name: '跑者_' + String(number).padStart(5, '0'),
    avatar_url: cloudStorage + '40e6215d-b5c6-4896-987c-f30f3678' + id.repeat(4) + '.png' }
}

test('地图需要登录，退出后清除身份并通知一次', async t => {
  const first = profile('a', 1)
  const changedAvatar = { ...first, avatar_url: profile('b', 1).avatar_url }
  const events = []
  const api = device(t, event => {
    events.push(event)
    switch (event.action) {
      case 'map': return { territories: [] }
      case 'login': return first
      case 'updateAvatar': return changedAvatar
      case 'logout': return { logged_in: false }
      default: assert.fail('unexpected action ' + event.action)
    }
  })()
  const onLogout = t.mock.fn(() => assert.equal(api.hasSavedLogin(), false))
  api.onLogout(onLogout)
  const bounds = { west: 121, east: 122, south: 31, north: 32 }
  await assert.rejects(api.map(bounds), { code: 'login_required' })
  await assert.rejects(api.start('guest-run', {}), { code: 'login_required' })
  await assert.rejects(api.loginWithWechat(''), /请选择微信头像/)
  assert.equal(api.playerId(), '')
  assert.deepEqual(events, [])
  const loggedIn = await api.loginWithWechat('chosen.png')
  assert.equal(loggedIn.display_name, first.display_name)
  assert.equal(api.playerId(), first.player_id)
  assert.deepEqual(await api.map(bounds), { territories: [] })
  const updated = await api.updateAvatar('changed.jpg')
  assert.equal(updated.display_name, first.display_name)
  assert.equal(api.avatarUrl(updated.avatar_url), changedAvatar.avatar_url)
  await api.logout()
  assert.equal(api.hasSavedLogin(), false)
  await assert.rejects(api.me(), { code: 'login_required' })
  await api.logout()
  assert.equal(onLogout.mock.callCount(), 1)
  assert.deepEqual(events, [
    { action: 'login', avatar_base64: Buffer.from('chosen.png').toString('base64') },
    { action: 'map', bounds, expected_player: first.player_id },
    { action: 'updateAvatar', avatar_base64: Buffer.from('changed.jpg').toString('base64'), expected_player: first.player_id },
    { action: 'logout', expected_player: first.player_id }
  ])
})

test('冷启动后恢复微信身份，开跑、补传与完赛使用相同云函数', async t => {
  const first = profile('a', 5)
  const summary = { ...first, territory_count: 0, area_m2: 0 }
  const events = []
  const restart = device(t, event => {
    events.push(event)
    switch (event.action) {
      case 'login': return first
      case 'me': return summary
      case 'start':
      case 'append':
      case 'finish': return { run_id: event.run_id, player_id: first.player_id }
      default: assert.fail('unexpected action ' + event.action)
    }
  })
  await restart().loginWithWechat('chosen.png')
  const api = restart()
  events.length = 0
  assert.equal(api.hasSavedLogin(), true)
  assert.equal((await api.login()).player_id, first.player_id)
  assert.ok(events.some(({ action }) => action === 'login' || action === 'me'))
  assert.equal((await api.me()).area_m2, 0)
  const run_id = 'native-run'
  const point = { latitude: 31.23, longitude: 121.47, timestamp: 123, accuracy: 4 }
  await api.start(run_id, point, first.player_id)
  await api.append(run_id, [point], first.player_id)
  await api.finish(run_id, 456, [point], first.player_id)
  assert.deepEqual(events.filter(e => ['start', 'append', 'finish'].includes(e.action)), [
    { action: 'start', run_id, first_point: point, expected_player: first.player_id },
    { action: 'append', run_id, points: [point], expected_player: first.player_id },
    { action: 'finish', run_id, ended_at: 456, points: [point], expected_player: first.player_id }
  ])
})

test('全国榜和省份榜均验证登录，仅全国榜请求本人名次', async t => {
  const first = profile('a', 1)
  const events = []
  const restart = device(t, event => {
    events.push(event)
    if (event.action === 'login') return first
    assert.equal(event.action, 'leaderboard')
    return { entries: [] }
  })
  let api = restart()
  await assert.rejects(api.leaderboard(), { code: 'login_required' })
  await assert.rejects(api.leaderboard('distance', 'province'), { code: 'login_required' })
  assert.deepEqual(events, [])
  await api.loginWithWechat('chosen.png')
  api = restart()
  await api.leaderboard('area', 'national', api.savedPlayerId(), 'week')
  await api.leaderboard('distance', 'province', api.savedPlayerId(), 'month')
  assert.deepEqual(events.map(e => e.action), ['login', 'login', 'leaderboard', 'leaderboard'])
  assert.deepEqual(events.filter(e => e.action === 'leaderboard'), [
    { action: 'leaderboard', metric: 'area', scope: 'national', period: 'week', include_self: true, expected_player: first.player_id },
    { action: 'leaderboard', metric: 'distance', scope: 'province', period: 'month', expected_player: first.player_id }
  ])
})

test('冷启动时云端微信身份变化，拒绝提交前一账号的缓存跑步', async t => {
  const first = profile('a', 1), other = profile('b', 2)
  let current = first
  const actions = []
  const restart = device(t, event => {
    actions.push(event.action)
    assert.ok(['login', 'me'].includes(event.action))
    return current
  })
  await restart().loginWithWechat('chosen.png')
  current = other
  const api = restart()
  const onLogout = t.mock.fn()
  api.onLogout(onLogout)
  await assert.rejects(api.finish('previous-run', 10, [], first.player_id), { code: 'account_changed' })
  assert.equal(api.hasSavedLogin(), false)
  assert.equal(api.playerId(), '')
  assert.equal(onLogout.mock.callCount(), 1)
  assert.ok(!actions.includes('finish'))
})

test('并发请求被云端拒绝后清除本机资料并通知一次', async t => {
  const account = profile('a', 1)
  const api = device(t, event => {
    if (event.action === 'login') return account
    assert.ok(['map', 'leaderboard'].includes(event.action))
    assert.equal(event.expected_player, account.player_id)
    return { error: { status: 409, code: 'account_changed', message: '微信身份已更换' } }
  })()
  const onLogout = t.mock.fn()
  api.onLogout(onLogout)
  await api.loginWithWechat('first.png')
  await Promise.all([
    assert.rejects(api.map(), { code: 'account_changed' }),
    assert.rejects(api.leaderboard(), { code: 'account_changed' })
  ])
  assert.equal(api.hasSavedLogin(), false)
  assert.equal(onLogout.mock.callCount(), 1)
})

test('云端登录错误在登录页可读，失败后可以重新选择头像', async t => {
  const account = profile('a', 1)
  let retry = false
  const api = device(t, () => retry ? account : {
    error: { status: 400, code: 'invalid_avatar', message: '请选择有效的 PNG、JPEG 或 WebP 格式头像' }
  })()
  await assert.rejects(api.loginWithWechat('bad.jpg'), {
    code: 'invalid_avatar', message: '请选择有效的 PNG、JPEG 或 WebP 格式头像'
  })
  assert.equal(api.hasSavedLogin(), false)
  retry = true
  assert.equal((await api.loginWithWechat('good.jpg')).player_id, account.player_id)
})

test('修改昵称带上当前身份并更新登录资料，地图保留领主完整昵称', async t => {
  let account = profile('a', 1)
  const restart = device(t, event => {
    if (event.action === 'login') return account
    if (event.action === 'map') return { territories: [{ id: 1, owner: account.player_id, owner_display_name: account.display_name, owner_avatar_url: account.avatar_url }] }
    assert.deepEqual(event, { action: 'updateNickname', expected_player: account.player_id, nickname: '公园夜跑队长' })
    account = { ...account, display_name: event.nickname }
    return account
  })
  const api = restart()
  await assert.rejects(api.updateNickname('游客'), {code: 'login_required'})
  await api.loginWithWechat('selected.png')
  await api.updateNickname('公园夜跑队长')
  assert.equal((await api.login()).display_name, '公园夜跑队长')
  assert.equal((await restart().login()).display_name, '公园夜跑队长')
  const getURL = wx.cloud.getTempFileURL = t.mock.fn()
  assert.equal((await api.map()).territories[0].owner_display_name, '公园夜跑队长')
  assert.equal(getURL.mock.callCount(), 0)
})

test('地图只请求一次相同头像，读不到头像时仍能显示领主昵称', async t => {
  const first = profile('a', 1), second = profile('b', 2)
  const territories = [first, first, second, { ...second, avatar_url: '' }].map((runner, index) => ({
    id: index + 1, owner: runner.player_id, owner_avatar_url: runner.avatar_url, owner_display_name: runner.display_name
  }))
  const api = device(t, event => {
    if (event.action === 'login') return profile('c', 3)
    assert.equal(event.action, 'map')
    return { territories: structuredClone(territories) }
  })()
  await api.loginWithWechat('viewer.png')
  const url = 'https://example.test/avatar.jpg'
  wx.cloud.getTempFileURL = t.mock.fn(async ({ fileList }) => {
    assert.deepEqual(fileList, [first.avatar_url, second.avatar_url])
    return { fileList: [{ fileID: first.avatar_url, status: 0, tempFileURL: url }, { fileID: second.avatar_url, status: -1 }] }
  })
  const lands = (await api.map()).territories
  assert.equal(wx.cloud.getTempFileURL.mock.callCount(), 1)
  assert.deepEqual(lands.map(land => land.marker_icon), [url, url, '', ''])
  assert.deepEqual(lands.map(land => land.owner_display_name), territories.map(land => land.owner_display_name))
  wx.cloud.getTempFileURL = async () => { throw new Error('unavailable') }
  t.mock.method(console, 'warn', () => {})
  assert.deepEqual((await api.map()).territories.map(land => land.marker_icon), ['', '', '', ''])
})

test('开发者工具启动小程序时绑定部署 running 的微信云环境', t => {
  const file = require.resolve('../miniprogram/app')
  const oldApp = global.App, previousWx = global.wx
  let definition
  global.App = settings => { definition = settings }
  const init = t.mock.fn()
  global.wx = { cloud: { init } }
  t.after(() => { global.App = oldApp; global.wx = previousWx; delete require.cache[file] })
  delete require.cache[file]
  require(file)
  definition.onLaunch()
  assert.equal(init.mock.callCount(), 1)
  assert.equal(init.mock.calls[0].arguments[0].env, 'cloud1-d5gnvayfnb1fa1cd4')
})

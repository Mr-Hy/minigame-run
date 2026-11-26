const test = require('node:test')
const assert = require('node:assert/strict')
const api = require('../miniprogram/lib/api')

let definition
global.Page = value => { definition = value }
require('../miniprogram/pages/me/index')
const personalCenter = definition
require('../miniprogram/pages/login/index')
const loginPage = definition
delete global.Page

function pageFrom(def) {
  const page = { ...def, route: def === loginPage ? 'pages/login/index' : 'pages/me/index',
    options: {}, data: { ...def.data }, setData(values) { Object.assign(this.data, values) } }
  page.onLoad(page.options)
  return page
}

function messages(t) {
  const previous = global.wx
  const events = []
  global.wx = {
    getStorageSync: () => undefined,
    reLaunch({ url, success, complete }) { events.push(url); success?.(); complete?.() },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    navigateTo: ({ url }) => events.push(url),
    switchTab: ({ url }) => events.push(url),
    showToast: ({ title }) => events.push(title),
    openPrivacyContract: () => events.push('privacy')
  }
  t.after(() => { global.wx = previous })
  return events
}

test('未登录打开个人中心直接进入登录页，跳转前不读取个人资料', async t => {
  const events = messages(t)
  t.mock.method(api, 'hasSavedLogin', () => false)
  t.mock.method(api, 'playerId', () => '')
  const me = t.mock.method(api, 'me', () => assert.fail('游客不能查询已登录账户'))
  const page = pageFrom(personalCenter)
  await page.onShow()
  assert.deepEqual(events, ['/pages/login/index'])
  assert.equal(me.mock.callCount(), 0)
  assert.equal(page.data.playerId, '')
  assert.equal(page.data.me, null)
})

test('已登录跑者从个人中心打开地图，开发版与体验版可见跑步测试入口', t => {
  const events = messages(t)
  t.mock.method(api, 'playerId', () => 'wx-runner')
  for (const envVersion of ['develop', 'trial', 'release']) {
    wx.getAccountInfoSync = () => ({ miniProgram: { envVersion } })
    assert.equal(pageFrom(personalCenter).data.showRunTest, envVersion !== 'release')
  }
  pageFrom(personalCenter).openMap()
  assert.deepEqual(events, ['/pages/run/index'])
})

test('同意隐私指引并选取头像后才登录，原生弹层取消后可以再次选择', async t => {
  const events = messages(t)
  t.mock.method(api, 'playerId', () => '')
  const auth = t.mock.method(api, 'loginWithWechat', async () => ({}))
  const page = pageFrom(loginPage)
  const select = { detail: { avatarUrl: 'wxfile://chosen' } }
  await page.login(select)
  assert.equal(auth.mock.callCount(), 0)
  page.openPrivacy()
  page.onConsent({ detail: { value: ['privacy'] } })
  await page.login({ detail: {} })
  assert.equal(page.data.loading, false)
  assert.equal(auth.mock.callCount(), 0)
  await page.login(select)
  assert.deepEqual(auth.mock.calls[0].arguments, ['wxfile://chosen'])
  assert.deepEqual(events, ['privacy', '微信登录成功', '/pages/me/index'])
})

test('登录失败留在登录页，可以重试登录', async t => {
  const events = messages(t)
  t.mock.method(api, 'playerId', () => '')
  const auth = t.mock.method(api, 'loginWithWechat', async () => { throw new Error('网络不可用') })
  const page = pageFrom(loginPage)
  page.onConsent({ detail: { value: ['privacy'] } })
  await page.login({ detail: { avatarUrl: 'wxfile://chosen' } })
  assert.equal(page.data.error, '网络不可用')
  assert.equal(page.data.loading, false)
  assert.deepEqual(events, [])
  auth.mock.mockImplementation(async () => ({}))
  await page.login({ detail: { avatarUrl: 'wxfile://chosen' } })
  assert.deepEqual(events, ['微信登录成功', '/pages/me/index'])
})

test('已登录玩家可重试读取领地、更换头像、退出，迟到响应无法恢复旧资料', async t => {
  messages(t)
  const me = { player_id: 'wx-112233', runner_number: 9, display_name: '跑者_00009', avatar_url: 'cloud://test.storage/running-avatars/a.png', territory_count: 3, area_m2: 4000 }
  me.running_summary = { distance_m: 12560, count: 4, duration_s: 4331 }
  let id = me.player_id
  t.mock.method(api, 'hasSavedLogin', () => !!id)
  t.mock.method(api, 'playerId', () => id)
  t.mock.method(api, 'avatarUrl', path => path)
  const read = t.mock.method(api, 'me', async () => { throw new Error('共享服务暂不可用') })
  const auth = t.mock.method(api, 'updateAvatar', async () => {
    me.avatar_url = 'cloud://test.storage/running-avatars/b.png'
    return me
  })
  t.mock.method(api, 'logout', async () => { id = '' })
  const page = pageFrom(personalCenter)
  await page.onShow()
  assert.equal(page.data.playerId, id)
  assert.equal(page.data.error, '共享服务暂不可用')
  assert.equal(page.data.running, null)
  read.mock.mockImplementation(async () => me)
  await page.loadMe()
  assert.equal(page.data.avatar, 'cloud://test.storage/running-avatars/a.png')
  assert.equal(page.data.name, '跑者_00009')
  assert.deepEqual(page.data.running, { distance: '12.56', count: 4, duration: '1小时12分' })
  page.toggleManage()
  assert.equal(page.data.manageOpen, true)
  await page.updateAvatar({ detail: { avatarUrl: 'wxfile://b' } })
  assert.deepEqual(auth.mock.calls[0].arguments, ['wxfile://b'])
  assert.equal(page.data.avatar, 'cloud://test.storage/running-avatars/b.png')
  assert.deepEqual(page.data.me, { count: 3, area: '4,000 m²' })

  let finish
  read.mock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const refresh = page.onShow()
  await page.logout()
  finish(me)
  await refresh
  assert.equal(page.data.playerId, '')
  assert.equal(page.data.me, null)
  assert.equal(page.data.running, null)
  assert.equal(page.data.manageOpen, false)
  assert.equal(page.data.avatar, '')
  assert.equal(page.data.name, '')
})

test('昵称使用原生表单提交值，保存失败保留草稿，切换账号丢弃旧响应', async t => {
  const events = messages(t)
  let id = 'wx-first'
  const names = { 'wx-first': '原昵称', 'wx-second': '另一位跑者' }
  t.mock.method(api, 'hasSavedLogin', () => true)
  t.mock.method(api, 'playerId', () => id)
  t.mock.method(api, 'me', async () => ({
    player_id: id, display_name: names[id], avatar_url: '', territory_count: 0, area_m2: 0
  }))
  const update = t.mock.method(api, 'updateNickname', async () => { throw new Error('网络不可用') })
  const page = pageFrom(personalCenter)
  await page.onShow()
  page.editNickname()
  const submit = nickname => page.saveNickname({ detail: { value: { nickname } } })
  await submit(' ')
  await submit('跑'.repeat(33))
  assert.equal(update.mock.callCount(), 0)
  const nickname = '🏃'.repeat(32)
  await submit(nickname)
  assert.deepEqual(update.mock.calls[0].arguments, [nickname])
  assert.equal(page.data.name, '原昵称')
  assert.equal(page.data.nicknameDraft, nickname)
  assert.equal(page.data.nicknameError, '网络不可用')
  update.mock.mockImplementation(async value => {
    names[id] = value
    return { player_id: id, display_name: value }
  })
  await submit(nickname)
  assert.equal(page.data.name, nickname)
  assert.equal(page.data.editingNickname, false)
  assert.deepEqual(events, ['昵称已更新'])

  let finish
  update.mock.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  page.editNickname()
  const pending = submit('旧账号的昵称')
  id = 'wx-second'
  finish({ player_id: 'wx-first', display_name: '旧账号的昵称' })
  await pending
  assert.equal(page.data.name, names[id])
  assert.equal(page.data.editingNickname, false)
  assert.equal(page.data.nicknameDraft, '')
  assert.deepEqual(events, ['昵称已更新'])
})

test('头像加载失败后刷新地址一次，忽略旧图片事件，持续失败时保留占位图', async t => {
  messages(t)
  const id = 'wx-avatar'
  const account = { player_id: id, display_name: '跑者', area_m2: 0, territory_count: 0,
    avatar_url: 'cloud://test.storage/avatar.jpg', avatar_display_url: 'https://storage.test/avatar?first' }
  t.mock.method(api, 'hasSavedLogin', () => true)
  t.mock.method(api, 'playerId', () => id)
  const read = t.mock.method(api, 'me', async () => ({ ...account }))
  const page = pageFrom(personalCenter)
  const event = src => ({ currentTarget: { dataset: { src } } })
  await page.onShow()
  const first = event(page.data.avatar)
  assert.equal(page.data.avatar, account.avatar_display_url)
  account.avatar_display_url = 'https://storage.test/avatar?second'
  await page.avatarFailed(first)
  const second = event(page.data.avatar)
  page.avatarLoaded(first)
  await page.avatarFailed(first)
  assert.equal(page.data.loadedAvatar, '')
  page.avatarLoaded(second)
  assert.equal(page.data.loadedAvatar, account.avatar_display_url)
  await page.avatarFailed(second)
  assert.equal(read.mock.callCount(), 2)
  assert.equal(page.data.avatar, '')
  assert.equal(page.data.loadedAvatar, '')
  assert.equal(page.data.name, '跑者')
})

test('有缓存的微信账号在登录页完成身份恢复后才进入个人中心', async t => {
  const events = messages(t)
  let id = ''
  let finish
  t.mock.method(api, 'hasSavedLogin', () => true)
  t.mock.method(api, 'playerId', () => id)
  t.mock.method(api, 'login', () => new Promise(resolve => { finish = resolve }))
  const page = pageFrom(loginPage)
  assert.deepEqual(events, [])
  id = 'wx-current'
  finish({ player_id: id })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['/pages/me/index'])
})


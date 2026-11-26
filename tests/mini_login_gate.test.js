const test = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../miniprogram/app.json')

const loginRoute = 'pages/login/index'
const account = {
  player_id: 'wx-' + 'a'.repeat(64),
  avatar_url: 'cloud://test.env/running-avatars/test.jpg',
  display_name: '测试跑者'
}

function reload(path) {
  const file = require.resolve(path)
  delete require.cache[file]
  return require(file)
}

function simulator(t) {
  const previous = { wx: global.wx, Page: global.Page, App: global.App, getCurrentPages: global.getCurrentPages }
  t.after(() => Object.assign(global, previous))
  const storage = new Map()
  const urls = []
  let current, definition, app
  global.Page = value => { definition = value }
  global.App = value => { app = value }
  global.getCurrentPages = () => current ? [current] : []
  global.wx = {
    cloud: { init() {}, callFunction: async () => ({ result: account }) },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: 'YQ==' }) }),
    reLaunch(options) {
      urls.push(options.url)
      options.success?.({})
      options.complete?.({})
    },
    showToast() {}
  }
  const api = reload('../miniprogram/lib/api')
  const gate = reload('../miniprogram/lib/login-gate')
  reload('../miniprogram/app')
  app.onLaunch()

  function open(route, options = {}, customPage) {
    if (customPage) gate.protectedPage(customPage)
    else reload('../miniprogram/' + route)
    current = { ...definition, route, options, data: structuredClone(definition.data || {}),
      setData(update) { Object.assign(this.data, update) } }
    return current
  }
  return { open, api, urls, storage }
}

async function show(view) {
  await view.onLoad?.(view.options)
  await view.onShow?.()
  await view.onReady?.()
}

test('登录是默认入口，每个业务页单独打开都先要求登录', async t => {
  assert.equal(manifest.entryPagePath || manifest.pages[0], loginRoute)
  for (const route of manifest.pages.filter(path => path !== loginRoute)) {
    await t.test(route, async t => {
      const { open, urls } = simulator(t)
      const view = open(route)
      await show(view)
      assert.equal(view.data.accessGranted, false)
      assert.deepEqual(urls, ['/' + loginRoute])
    })
  }
})

test('未登录不执行页面生命周期，登录后返回原始深链及查询参数', async t => {
  const { open, urls } = simulator(t)
  const calls = []
  const hooks = {
    onLoad(query) { calls.push(['load', query]) },
    onShow() { calls.push(['show']) },
    onReady() { calls.push(['ready']) }
  }
  const route = 'pages/result/index'
  const query = { run_id: 'run-42', tag: '东门 & 南门' }
  await show(open(route, query, hooks))
  assert.deepEqual(calls, [])
  assert.deepEqual(urls, ['/' + loginRoute])

  const login = open(loginRoute)
  await show(login)
  await login.login({ detail: {} })
  assert.equal(urls.length, 1)
  login.onConsent({ detail: { value: ['privacy'] } })
  await login.login({ detail: { avatarUrl: 'wxfile://avatar' } })
  assert.equal(urls.length, 2)
  const target = new URL(urls[1], 'https://test.invalid')
  assert.equal(target.pathname, '/' + route)
  assert.deepEqual(Object.fromEntries(target.searchParams), query)

  const restored = open(route, query, hooks)
  await show(restored)
  assert.equal(restored.data.accessGranted, true)
  assert.deepEqual(calls, [['load', query], ['show'], ['ready']])
  assert.equal(urls.length, 2)
})

test('冷启动恢复已保存账号后进入个人中心，退出后立即回到登录页', async t => {
  const { api, open, urls, storage } = simulator(t)
  storage.set('park.cloud.profile.' + api.config.cloudEnv, account)
  assert.equal(api.playerId(), '')
  await show(open(loginRoute))
  assert.equal(api.playerId(), account.player_id)
  assert.deepEqual(urls, ['/pages/me/index'])
  const me = open('pages/me/index', {}, { data: {} })
  await show(me)
  await api.logout()
  assert.equal(api.playerId(), '')
  assert.deepEqual(urls, ['/pages/me/index', '/' + loginRoute])
})

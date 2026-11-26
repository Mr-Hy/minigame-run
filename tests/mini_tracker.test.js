const test = require('node:test')
const assert = require('node:assert/strict')

const trackerFile = require.resolve('../miniprogram/lib/tracker')
const apiFile = require.resolve('../miniprogram/lib/api')
const tick = () => new Promise(resolve => setImmediate(resolve))
const origin = 1800000000

function device(disk, denied = false) {
  const handlers = new Set()
  const log = { starts: [], stops: 0 }
  global.wx = {
    authorize(options) { options.success({}) },
    startLocationUpdateBackground(options) {
      log.starts.push(options.type)
      if (denied) options.fail({ errMsg: 'auth deny' })
      else options.success({})
    },
    getSetting(options) { options.success({ authSetting: { 'scope.userLocationBackground': true } }) },
    stopLocationUpdate(options) { log.stops++; options.success({}) },
    onLocationChange(fn) { handlers.add(fn) },
    offLocationChange(fn) { handlers.delete(fn) },
    getLocation() {},
    setStorageSync(key, data) { disk.set(key, JSON.parse(JSON.stringify(data))) },
    getStorageSync(key) { return disk.has(key) ? JSON.parse(JSON.stringify(disk.get(key))) : '' },
    removeStorageSync(key) { disk.delete(key) }
  }
  return {
    log, handlers,
    emit(accuracy, longitude = 121.47, timestamp) {
      handlers.forEach(fn => fn({ latitude: 31.23, longitude, accuracy, timestamp }))
    }
  }
}

function load(api) {
  delete require.cache[trackerFile]
  require.cache[apiFile] = { exports: {
    playerId: () => 'wx-first',
    login: async () => ({ player_id: 'wx-first' }),
    ...api
  } }
  return require(trackerFile)
}

test('微信未登录时，启动和恢复均不申请定位、不建立草稿', async () => {
  const disk = new Map()
  const phone = device(disk)
  let attempts = 0
  const tracker = load({ playerId: () => '', login: async () => { attempts++; throw new Error('微信登录失败') } })
  await tracker.restore()
  assert.equal(attempts, 0)
  await assert.rejects(tracker.start(), /微信登录失败/)
  assert.deepEqual(phone.log.starts, [])
  assert.equal(phone.handlers.size, 0)
  assert.equal(disk.size, 0)
})

test('等待用户确认定位授权期间切换微信账号，不启动采点', async t => {
  const disk = new Map()
  const phone = device(disk)
  let player = 'wx-first'
  t.mock.method(wx, 'authorize', ({ success }) => { player = 'wx-second'; success({}) })
  const tracker = load({ playerId: () => player })
  await assert.rejects(tracker.start(), { code: 'account_changed' })
  assert.deepEqual(phone.log.starts, [])
  assert.equal(disk.size, 0)
})

test('其他账号无法恢复、结算或上传本人的离线轨迹，原账号仍能恢复', async () => {
  const disk = new Map()
  let player = 'wx-first'
  const calls = []
  const service = {
    playerId: () => player, login: async () => ({ player_id: player }),
    start: async (id, point, owner) => { calls.push(owner); throw new Error('离线') }
  }
  const phone = device(disk)
  let tracker = load(service)
  const begun = tracker.start()
  await tick()
  phone.emit(5)
  await begun
  await tick()
  player = 'wx-second'
  assert.deepEqual(tracker.snapshot().points, [])
  phone.emit(8)
  assert.equal(phone.handlers.size, 0)
  await assert.rejects(tracker.finish(), /微信账号/)
  disk.set('running-territory.active', { id: 'unbound-draft', endedAt: null })
  tracker = load(service)
  await tracker.restore()
  assert.equal(tracker.snapshot().phase, 'idle')
  assert.deepEqual(calls, ['wx-first'])
  player = 'wx-first'
  await tracker.restore()
  assert.equal(tracker.snapshot().points.length, 1)
  assert.equal(tracker.snapshot().phase, 'running')
  assert.deepEqual(calls, ['wx-first', 'wx-first'])
})

test('拒绝后台授权时不计时，不留下定位监听和草稿', async () => {
  const disk = new Map()
  const phone = device(disk, true)
  const tracker = load({})
  await assert.rejects(tracker.start(), { code: 'location_permission_denied',
    scope: 'scope.userLocationBackground', message: /使用小程序期间和离开小程序后/ })
  assert.equal(tracker.snapshot().phase, 'idle')
  assert.equal(tracker.snapshot().startedAt, null)
  assert.equal(disk.size, 0)
  assert.equal(phone.handlers.size, 0)
})

test('有效首点才开始计时，实时展示过滤低精度点，结算仍上传原始点', async t => {
  let clock = origin
  t.mock.method(Date, 'now', () => clock * 1000)
  const disk = new Map()
  const phone = device(disk)
  const sent = []
  const api = {
    async start(id, first) { sent.push(first) },
    async append(id, batch) { sent.push(...batch) },
    async finish(id, end, batch) { sent.push(...batch); return { id, end } }
  }
  const tracker = load(api)
  let displayed
  t.after(tracker.subscribe(state => { displayed = state }))
  const begun = tracker.start()
  assert.equal(tracker.start(), begun)
  await tick()
  phone.emit(75)
  const firstEstimate = displayed.message
  phone.emit(65)
  const bestEstimate = displayed.message
  phone.emit(88)
  const waiting = displayed
  clock += 25
  phone.emit(50, 121.47, clock * 1000)
  await begun
  assert.match(firstEstimate, /75\s*米/)
  assert.match(bestEstimate, /65\s*米/)
  assert.match(bestEstimate, /50\s*米/)
  assert.equal(waiting.phase, 'locating')
  assert.equal(waiting.message, bestEstimate)
  assert.equal(waiting.startedAt, null)
  assert.equal(displayed.phase, 'running')
  assert.equal(displayed.message, '')
  assert.equal(tracker.snapshot().startedAt, clock)
  await tracker.restore()
  assert.deepEqual(phone.log.starts, ['gcj02'])
  clock++
  phone.emit(70, 121.49)
  clock++
  phone.emit(5, 121.471)
  assert.equal(tracker.snapshot().elapsed, 2)
  assert.equal(tracker.snapshot().points.length, 2)
  assert.ok(tracker.snapshot().distance > 93 && tracker.snapshot().distance < 98)
  const finished = tracker.finish()
  assert.equal(tracker.finish(), finished)
  assert.equal((await finished).end, clock)
  assert.deepEqual(sent.map(p => p.accuracy), [50, 70, 5])
  assert.equal(phone.handlers.size, 0)
  assert.equal(tracker.snapshot().phase, 'idle')
  assert.equal(disk.size, 0)
})

test('断网跨多批缓存、重启恢复与结算响应丢失均保留整圈和首次结束时间', async t => {
  let clock = origin
  t.mock.method(Date, 'now', () => clock * 1000)
  let online = false
  let lostResponse = true
  let result
  const ids = new Set()
  const saved = new Map()
  const sizes = []
  const disk = new Map()
  const api = {
    async start(id, p) {
      if (!online) throw new Error('离线')
      ids.add(id)
      saved.set(p.timestamp, p)
      return { status: result ? 'finished' : 'running' }
    },
    async append(id, points) {
      ids.add(id)
      sizes.push(points.length)
      for (const p of points) saved.set(p.timestamp, p)
    },
    async finish(id, end, points) {
      ids.add(id)
      if (!result) {
        sizes.push(points.length)
        for (const p of points) saved.set(p.timestamp, p)
        result = { end, count: saved.size }
      }
      if (lostResponse) { lostResponse = false; throw new Error('响应丢失') }
      return result
    }
  }
  let phone = device(disk)
  let tracker = load(api)
  const begun = tracker.start()
  await tick()
  phone.emit(5)
  await begun
  for (let i = 1; i <= 300; i++) {
    clock++
    phone.emit(5, 121.47 + i / 1e5)
  }
  await tick()
  phone = device(disk)
  tracker = load(api)
  await Promise.all([tracker.restore(), tracker.restore()])
  assert.equal(phone.handlers.size, 1)
  assert.equal(tracker.snapshot().points.length, 301)
  clock += 95
  phone.emit(5)
  const end = clock
  await assert.rejects(tracker.finish(), /待提交/)
  assert.equal(tracker.snapshot().phase, 'pending')
  phone = device(disk)
  tracker = load(api)
  await tracker.restore()
  assert.equal(phone.log.starts.length, 0)
  clock += 500
  assert.equal(tracker.snapshot().elapsed, end - origin)
  online = true
  await assert.rejects(tracker.finish(), /响应丢失/)
  assert.deepEqual(await tracker.finish(), { end, count: 302 })
  assert.ok(sizes.length >= 3 && sizes.every(n => n <= 128))
  assert.equal(saved.get(end).timestamp - saved.get(origin + 300).timestamp, 95)
  assert.equal(ids.size, 1)
  assert.equal(disk.size, 0)
})

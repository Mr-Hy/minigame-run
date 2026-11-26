const api = require('./api')

const HEADER = 'running-territory.active'
const BATCH = 128
const listeners = new Set()
const now = () => Date.now() / 1000
const headerKey = player => HEADER + '.' + player
const chunkKey = (draft, i) => headerKey(draft.playerId) + '.' + draft.id + '.' + i
let phase = 'idle'
let message = ''
let run = null
let samples = []
let path = []
let distance = 0
let listening = false
let firstFix = null
let startTask = null
let restoreTask = null
let uploadTask = null
let finishTask = null
let stopTask = Promise.resolve()
let lastUpload = 0

function snapshot() {
  if (run && api.playerId() !== run.playerId) {
    return { phase: 'idle', message: '', points: [], distance: 0, startedAt: null, elapsed: 0 }
  }
  const elapsed = run ? (run.endedAt === null ? now() : run.endedAt) - run.startedAt : 0
  return {
    phase, message, points: path.slice(), distance: Math.max(0, distance),
    startedAt: run ? run.startedAt : null, elapsed: Math.max(0, Math.floor(elapsed))
  }
}

function publish() {
  if (listeners.size) {
    const value = snapshot()
    listeners.forEach(listener => listener(value))
  }
}

function subscribe(listener) {
  listeners.add(listener)
  listener(snapshot())
  return () => listeners.delete(listener)
}

function callWx(method, options = {}) {
  return new Promise((resolve, reject) => wx[method]({ ...options, success: resolve, fail: reject }))
}

function permissionDenied(scope) {
  return Object.assign(new Error('请在小程序设置中允许「使用小程序期间和离开小程序后」获取位置，再开始跑步。'), {
    code: 'location_permission_denied', scope
  })
}

async function enableLocation(player) {
  await stopTask
  checkPlayer(player)
  let scope = 'scope.userLocation'
  let setting
  try {
    await callWx('authorize', { scope })
    scope = 'scope.userLocationBackground'
    checkPlayer(player)
    await callWx('authorize', { scope })
    checkPlayer(player)
    await callWx('startLocationUpdateBackground', { type: 'gcj02' })
    setting = await callWx('getSetting')
  } catch (error) {
    if (error.code === 'account_changed') throw error
    const detail = String(error && (error.errMsg || error.message) || '').replace(/^\w+:fail\s*/i, '')
    if (!/system|privacy|接口权限/i.test(detail) &&
        /auth deny|auth denied|user (deny|denied|reject|cancel)|permission denied|not authorized|unauthorized|未授权|拒绝授权/i.test(detail)) {
      throw permissionDenied(scope)
    }
    throw new Error('无法开启后台定位，请检查手机定位和小程序后台定位权限。')
  }
  if (setting.authSetting[scope] === false) throw permissionDenied(scope)
}

function normalizedPoint(raw) {
  const { latitude, longitude } = raw
  const accuracy = Number.isFinite(raw.accuracy) && raw.accuracy >= 0 ? raw.accuracy : raw.horizontalAccuracy
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 || !Number.isFinite(accuracy) || accuracy < 0) return null
  // onLocationChange 的标准回调没有时间字段，在收到该回调时立即打点。
  // 若设备附带采集时间则保留它，毫秒与秒统一为协议所用的 Unix 秒。
  const time = raw.timestamp
  const timestamp = Number.isFinite(time) && time > 0 ? (time >= 1e11 ? time / 1000 : time) : now()
  return { latitude, longitude, accuracy, timestamp }
}

function meters(a, b) {
  if (!a || !b) return 0
  const rad = Math.PI / 180
  const dx = (b.longitude - a.longitude) * Math.cos((a.latitude + b.latitude) * rad / 2)
  return 6371008.8 * rad * Math.hypot(dx, b.latitude - a.latitude)
}

function addToPath(point) {
  if (point.accuracy > 50 || point.timestamp < run.startedAt) return
  // 回调通常有序。延迟送达的采集点只修正其相邻两段的展示里程。
  let i = path.length
  while (i && path[i - 1].timestamp >= point.timestamp) i--
  const old = path[i] && path[i].timestamp === point.timestamp ? path[i] : null
  if (old && (old.accuracy < point.accuracy || (old.accuracy === point.accuracy &&
      (old.latitude < point.latitude || (old.latitude === point.latitude && old.longitude <= point.longitude))))) return
  const prev = path[i - 1]
  const next = path[i + (old ? 1 : 0)]
  const oldLength = old ? meters(prev, old) + meters(old, next) : meters(prev, next)
  distance += meters(prev, point) + meters(point, next) - oldLength
  path.splice(i, old ? 1 : 0, point)
}

function saveSample(point) {
  samples.push(point)
  const index = Math.floor((samples.length - 1) / BATCH)
  wx.setStorageSync(chunkKey(run, index), samples.slice(index * BATCH))
}

function onPoint(raw) {
  if (run && run.playerId !== api.playerId()) {
    stopLocation()
    publish()
    return
  }
  const point = normalizedPoint(raw)
  if (!point) return
  if (firstFix) {
    firstFix(point)
    return
  }
  if (phase !== 'running') return
  if (point.accuracy <= 50 && message.startsWith('暂时收不到定位点')) message = ''
  try {
    saveSample(point)
  } catch (error) {
    message = '本机无法缓存新定位点，请尽快联网并结束本圈。'
  }
  addToPath(point)
  publish()
  backgroundUpload()
}

function onLocationError() {
  if (phase === 'running') {
    message = '暂时收不到定位点，已记录的轨迹仍然保留。'
    publish()
  }
}

function listen() {
  if (listening) return
  wx.onLocationChange(onPoint)
  if (wx.onLocationChangeError) wx.onLocationChangeError(onLocationError)
  listening = true
}

function stopLocation() {
  if (listening) {
    wx.offLocationChange(onPoint)
    if (wx.offLocationChangeError) wx.offLocationChangeError(onLocationError)
    listening = false
  }
  stopTask = callWx('stopLocationUpdate').catch(() => {})
}

function waitForFirstFix() {
  return new Promise((resolve, reject) => {
    let bestAccuracy = Infinity
    const timer = setTimeout(() => {
      firstFix = null
      const reason = Number.isFinite(bestAccuracy) ? '定位误差最小为 ' + bestAccuracy + ' 米，开跑需要 50 米以内。'
        : '暂未取得误差在 50 米内的起点。'
      reject(new Error(reason + '请到开阔处重试。'))
    }, 30000)
    firstFix = point => {
      if (point.accuracy > 50) {
        const meters = Math.ceil(point.accuracy)
        if (meters < bestAccuracy) {
          bestAccuracy = meters
          message = '目前最小定位误差为 ' + meters + ' 米，降到 50 米以内后开始计时。'
          publish()
        }
        return
      }
      clearTimeout(timer)
      firstFix = null
      resolve(point)
    }
    const accept = firstFix
    listen()
    // 主动取起点，避免静止时一直等不到位置变化；忽略上次定位的迟到回调。
    wx.getLocation({ type: 'gcj02', isHighAccuracy: true, success(raw) {
      if (firstFix === accept) onPoint(raw)
    } })
  })
}

async function upload(final) {
  if (!run.sent) {
    const summary = await api.start(run.id, samples[0], run.playerId)
    if (final && summary && summary.status === 'finished') return api.finish(run.id, run.endedAt, [], run.playerId)
    run.sent = 1
    wx.setStorageSync(headerKey(run.playerId), run)
  }
  const end = samples.length
  while (end - run.sent > (final ? BATCH : 0)) {
    const stop = Math.min(run.sent + BATCH, end)
    await api.append(run.id, samples.slice(run.sent, stop), run.playerId)
    run.sent = stop
    wx.setStorageSync(headerKey(run.playerId), run)
  }
  if (final) return api.finish(run.id, run.endedAt, samples.slice(run.sent), run.playerId)
}

function backgroundUpload(force = false) {
  if (phase !== 'running' || uploadTask || (!force && now() - lastUpload < 15)) return
  lastUpload = now()
  uploadTask = upload(false).then(() => {
    if (message.startsWith('轨迹已缓存在本机')) {
      message = ''
      publish()
    }
  }).catch(error => {
    if (phase === 'running') {
      if (run.playerId !== api.playerId()) {
        stopLocation()
        message = error.message || '请到个人中心重新登录微信。'
      } else message = '轨迹已缓存在本机，连接服务后会继续上传。'
      publish()
    }
  }).finally(() => { uploadTask = null })
}

function resetRun() {
  run = null
  samples = []
  path = []
  distance = 0
  phase = 'idle'
  message = ''
}

function checkPlayer(player) {
  if (!player || player !== api.playerId()) {
    throw Object.assign(new Error('请使用本次跑步的微信账号登录。'), { code: 'account_changed' })
  }
}

async function loadDraft(player) {
  if (run && run.playerId !== player) {
    stopLocation()
    if (uploadTask) await uploadTask
    resetRun()
  }
  checkPlayer(player)
  if (run) return
  const saved = wx.getStorageSync(headerKey(player))
  if (!saved || saved.playerId !== player) return
  run = saved
  for (let i = 0; ; i++) {
    const chunk = wx.getStorageSync(chunkKey(run, i))
    if (!Array.isArray(chunk) || !chunk.length) break
    chunk.forEach(point => { samples.push(point); addToPath(point) })
    if (chunk.length < BATCH) break
  }
  phase = run.endedAt === null ? 'running' : 'pending'
  message = phase === 'pending' ? '跑步已结束，点击重试提交。' : ''
  publish()
}

function start() {
  if (startTask) return startTask
  if (finishTask) return Promise.reject(new Error('请先完成当前跑步的结算。'))
  startTask = (async () => {
    if (restoreTask) await restoreTask
    const { player_id: player } = await api.login()
    await loadDraft(player)
    if (phase !== 'idle') throw new Error('请先结束并提交当前跑步。')
    phase = 'locating'
    message = '正在取得起点，请在开阔处稍候。'
    publish()
    try {
      await enableLocation(player)
      checkPlayer(player)
      const first = await waitForFirstFix()
      checkPlayer(player)
      const id = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
      run = { id, playerId: player, startedAt: first.timestamp, endedAt: null, sent: 0 }
      try {
        saveSample(first)
        wx.setStorageSync(headerKey(player), run)
      } catch (error) {
        wx.removeStorageSync(chunkKey(run, 0))
        throw new Error('本机无法保存跑步起点，请清理小程序存储后重试。')
      }
      addToPath(first)
      phase = 'running'
      message = ''
      publish()
      backgroundUpload(true)
      return snapshot()
    } catch (error) {
      stopLocation()
      resetRun()
      message = error.message
      publish()
      throw error
    }
  })().finally(() => { startTask = null })
  return startTask
}

function restore() {
  if (restoreTask) return restoreTask
  if (startTask) return startTask
  if (finishTask) return finishTask
  const currentPlayer = api.playerId()
  if (listening && run && currentPlayer !== run.playerId) stopLocation()
  if (!currentPlayer || (!run && !wx.getStorageSync(headerKey(currentPlayer)))) return Promise.resolve()
  restoreTask = (async () => {
    const { player_id: player } = await api.login()
    await loadDraft(player)
    if (phase !== 'running' || listening) return
    const restoring = run
    try {
      await enableLocation(player)
      if (run === restoring && phase === 'running') {
        checkPlayer(player)
        listen()
        message = ''
        publish()
        backgroundUpload(true)
      } else if (phase !== 'locating' && phase !== 'running') stopLocation()
    } catch (error) {
      if (run === restoring && phase === 'running') {
        stopLocation()
        message = '之前的轨迹已保留。' + error.message
        publish()
        throw new Error(message)
      }
    }
  })().finally(() => { restoreTask = null })
  return restoreTask
}

function finish() {
  if (finishTask) return finishTask
  if (phase !== 'running' && phase !== 'pending') return Promise.reject(new Error('当前没有可结束的跑步。'))
  const finishing = run
  const endedAt = Math.max(run.startedAt, now())
  finishTask = (async () => {
    if (restoreTask) await restoreTask.catch(() => {})
    const session = await api.login()
    checkPlayer(finishing.playerId)
    if (session.player_id !== finishing.playerId || run !== finishing) throw new Error('请使用本次跑步的微信账号登录。')
    phase = 'finishing'
    if (run.endedAt === null) run.endedAt = endedAt
    message = '正在提交本圈轨迹。'
    stopLocation()
    publish()
    try {
      wx.setStorageSync(headerKey(run.playerId), run)
      if (uploadTask) await uploadTask
      const result = await upload(true)
      wx.removeStorageSync(headerKey(run.playerId))
      for (let i = 0; i * BATCH < samples.length; i++) wx.removeStorageSync(chunkKey(run, i))
      resetRun()
      publish()
      return result
    } catch (error) {
      phase = 'pending'
      message = '本圈待提交。' + (error.message || '请检查网络后重试。')
      publish()
      throw new Error(message)
    }
  })().finally(() => { finishTask = null })
  return finishTask
}

module.exports = { start, finish, restore, snapshot, subscribe }

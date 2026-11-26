const config = require('../config')

const profileKey = 'park.cloud.profile.' + config.cloudEnv
let initialized = false
let profile
let verified = false
let restoring
let profileChange = Promise.resolve()
let logoutListener

function initCloud() {
  if (initialized || !wx.cloud) return
  wx.cloud.init({ env: config.cloudEnv })
  initialized = true
}

async function request(action, data = {}) {
  initCloud()
  if (!initialized) throw new Error('请更新微信后再使用云开发服务')
  let response
  try {
    response = await wx.cloud.callFunction({ name: 'running', data: { action, ...data } })
  } catch (cause) {
    console.warn('云函数调用失败', action, cause.errCode || cause.errMsg || cause.message)
    throw new Error('暂时无法连接微信云开发，请稍后重试')
  }
  const result = response && response.result
  if (!result || typeof result !== 'object') throw new Error('云函数返回异常，请重试')
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.error.status })
  return result
}

function avatarUrl(id) {
  return typeof id === 'string' && id.startsWith('cloud://') ? id : ''
}

function hasProfile(value) {
  return value && /^wx-[0-9a-f]{64}$/.test(value.player_id) && !!avatarUrl(value.avatar_url) && !!value.display_name
}

function savedProfile() {
  if (profile === undefined) {
    const value = wx.getStorageSync(profileKey)
    profile = hasProfile(value) ? value : null
  }
  return profile
}

function saveProfile(value) {
  if (!hasProfile(value)) throw new Error('云端登录资料不完整，请重试')
  wx.setStorageSync(profileKey, value)
  profile = value
  verified = true
  return value
}

function clearProfile() {
  if (!savedProfile()) return
  wx.removeStorageSync(profileKey)
  profile = null
  verified = false
  if (logoutListener) logoutListener()
}

function onLogout(callback) {
  logoutListener = callback
}

function accountChanged() {
  return Object.assign(new Error('微信账号已切换，请重新登录'), { code: 'account_changed' })
}

function clearRejected(error, account) {
  if ((error.code === 'login_required' || error.code === 'account_changed') && savedProfile() === account) clearProfile()
}

async function login() {
  const account = savedProfile()
  if (!account) throw Object.assign(new Error('请先使用微信登录'), { code: 'login_required' })
  if (verified) return account
  if (!restoring) {
    restoring = request('login').then(result => {
      if (savedProfile() !== account || result.player_id !== account.player_id) throw accountChanged()
      return saveProfile(result)
    }).catch(error => {
      clearRejected(error, account)
      throw error
    }).finally(() => { restoring = null })
  }
  return restoring
}

async function authenticated(action, data = {}, playerId) {
  const account = await login()
  if (playerId && playerId !== account.player_id) throw accountChanged()
  try {
    const result = await request(action, { ...data, expected_player: account.player_id })
    if (!verified || profile.player_id !== account.player_id) throw accountChanged()
    return result
  } catch (error) {
    clearRejected(error, account)
    throw error
  }
}

function readAvatar(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath) return reject(new Error('请选择微信头像'))
    wx.getFileSystemManager().readFile({
      filePath, encoding: 'base64',
      success({ data }) {
        if (typeof data !== 'string' || !data) return reject(new Error('头像读取失败'))
        if (data.length > 4 * Math.ceil(2 * 1024 * 1024 / 3)) return reject(new Error('头像图片大小不能超过 2 MiB'))
        resolve(data)
      },
      fail: () => reject(new Error('头像读取失败，请重新选择'))
    })
  })
}

function changeProfile(operation) {
  const next = profileChange.then(operation)
  profileChange = next.catch(() => {})
  return next
}

function loginWithWechat(filePath) {
  return changeProfile(async () => {
    const avatar_base64 = await readAvatar(filePath)
    return saveProfile(await request('login', { avatar_base64 }))
  })
}

function updateAvatar(filePath) {
  const player = savedProfile()?.player_id
  return changeProfile(async () => {
    const avatar_base64 = await readAvatar(filePath)
    return saveProfile(await authenticated('updateAvatar', { avatar_base64 }, player))
  })
}

function updateNickname(nickname) {
  const player = savedProfile()?.player_id
  if (!player) return Promise.reject(Object.assign(new Error('请先使用微信登录'), { code: 'login_required' }))
  return changeProfile(async () => saveProfile(await authenticated('updateNickname', { nickname }, player)))
}

function logout() {
  return changeProfile(async () => {
    if (!savedProfile()) return
    try {
      await authenticated('logout')
    } catch (error) {
      if (error.code !== 'login_required') throw error
    }
    clearProfile()
  })
}

function leaderboard(metric = 'area', scope = 'national', ownPlayer = '', period = 'day') {
  const data = { metric, scope, period }
  if (scope === 'national' && ownPlayer) data.include_self = true
  return authenticated('leaderboard', data, ownPlayer)
}

async function map(bounds) {
  const data = await authenticated('map', bounds ? { bounds } : {})
  const ownPlayer = verified && profile ? profile.player_id : ''
  const others = data.territories.filter(land => land.owner !== ownPlayer)
  const files = [...new Set(others.map(land => avatarUrl(land.owner_avatar_url)).filter(Boolean))]
  const icons = new Map()
  for (let i = 0; i < files.length; i += 50) {
    try {
      const { fileList } = await wx.cloud.getTempFileURL({ fileList: files.slice(i, i + 50) })
      for (const file of fileList) {
        if (file.status === 0 && typeof file.tempFileURL === 'string' && file.tempFileURL.startsWith('https://')) {
          icons.set(file.fileID, file.tempFileURL)
        }
      }
    } catch (error) {
      console.warn('地图头像暂时无法读取', error.errMsg || error.message)
    }
  }
  for (const land of others) land.marker_icon = icons.get(land.owner_avatar_url) || ''
  return data
}

module.exports = {
  config, initCloud, map, login, loginWithWechat, updateAvatar, updateNickname, avatarUrl, logout, onLogout,
  hasSavedLogin: () => !!savedProfile(),
  savedPlayerId: () => savedProfile()?.player_id || '',
  playerId: () => verified && profile ? profile.player_id : '',
  leaderboard,
  lossReports: (cursor, player) => authenticated('lossReports', cursor ? { cursor } : {}, player),
  lossReportBoundary: (reportId, regionIndex, player) => authenticated('lossReportBoundary', {
    report_id: reportId, region_index: regionIndex
  }, player),
  subscribeLossNotice: (templateId, grantId, player) => authenticated('subscribeLossNotice', {
    template_id: templateId, grant_id: grantId, env_version: wx.getAccountInfoSync().miniProgram.envVersion
  }, player),
  me: () => authenticated('me'),
  achievements: player => authenticated('achievements', {}, player),
  runStats: (query, player) => authenticated('runStats', query, player),
  runHistory: (query, player) => authenticated('runHistory', query, player),
  getRun: (id, player) => authenticated('getRun', { run_id: id, include_points: false }, player),
  start: (id, firstPoint, playerId) => authenticated('start', { run_id: id, first_point: firstPoint }, playerId),
  append: (id, points, playerId) => authenticated('append', { run_id: id, points }, playerId),
  finish: (id, endedAt, points, playerId) => authenticated('finish', { run_id: id, ended_at: endedAt, points }, playerId)
}

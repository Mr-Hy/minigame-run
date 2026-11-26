const api = require('./api')
let latest = null
let pendingCelebration = null

function path(player) {
  return wx.env.USER_DATA_PATH + '/last-territory-run-' + player + '.json'
}

function save(result) {
  const player = api.playerId()
  if (!player || result.player_id !== player) return
  if (latest?.run_id !== result.run_id || latest?.player_id !== player) {
    const updates = result.achievement_updates
    pendingCelebration = updates && (updates.records.length || updates.milestones.length)
      ? { player, runId: result.run_id } : null
  }
  latest = result
  try {
    const fs = wx.getFileSystemManager()
    const file = path(player)
    fs.writeFileSync(file + '.tmp', JSON.stringify(result), 'utf8')
    fs.renameSync(file + '.tmp', file)
  } catch (err) {
    console.warn('本次成绩已结算，设备未能保存副本', err.errMsg || err.message)
  }
}

function get() {
  const player = api.playerId()
  if (!player) return null
  if (!latest || latest.player_id !== player) {
    try { latest = JSON.parse(wx.getFileSystemManager().readFileSync(path(player), 'utf8')) } catch (_) { return null }
  }
  return latest && latest.player_id === player ? latest : null
}

function takeCelebration(result) {
  if (!pendingCelebration || pendingCelebration.player !== api.playerId() ||
      pendingCelebration.player !== result.player_id || pendingCelebration.runId !== result.run_id) return false
  pendingCelebration = null
  return true
}

module.exports = { get, save, takeCelebration }

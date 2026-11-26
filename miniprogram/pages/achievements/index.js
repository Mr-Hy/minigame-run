const api = require('../../lib/api')
const { albumView } = require('../../lib/achievements')

Page({
  data: { state: 'loading', tab: 'records', album: albumView(null), error: '' },

  onLoad(options = {}) {
    this._read = 0
    if (options.tab === 'milestones') this.setData({ tab: 'milestones' })
  },
  onShow() { return this.refresh() },
  onHide() { this._read++ },
  onUnload() { this._read++ },
  async onPullDownRefresh() {
    try { await this.refresh() } finally { wx.stopPullDownRefresh() }
  },

  async refresh() {
    const read = ++this._read
    const player = api.savedPlayerId()
    if (!player || this._player !== player) this.setData({ album: albumView(null) })
    const keepAlbum = player && this._player === player && this.data.state === 'ready'
    this._player = player
    this.setData({ state: player ? (keepAlbum ? 'ready' : 'loading') : 'guest', error: '' })
    if (!player) return
    try {
      const data = await api.achievements(player)
      if (read !== this._read) return
      if (player !== api.savedPlayerId()) return this.refresh()
      this.setData({ state: 'ready', album: albumView(data) })
    } catch (error) {
      if (read !== this._read) return
      if (player !== api.savedPlayerId()) return this.refresh()
      this.setData({ state: keepAlbum ? 'ready' : 'error', error: error.message || '成就暂时无法读取，请重试。' })
    }
  },

  switchTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }) },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=achievements' }) },
  openRun(event) {
    const run = event.currentTarget.dataset.run
    if (this._player !== api.playerId()) return this.refresh()
    if (run) wx.navigateTo({ url: '/pages/result/index?run_id=' + encodeURIComponent(run) })
  }
})

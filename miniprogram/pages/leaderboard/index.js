const api = require('../../lib/api')
const { areaText } = require('../../lib/map')

function distanceText(meters) {
  if (meters > 0 && meters < 1) return '<1 米'
  return meters < 1000 ? Math.round(meters) + ' 米' : (meters / 1000).toFixed(2) + ' 公里'
}

Page({
  data: {
    metric: 'area', scope: 'national', period: 'day',
    podium: [], rows: [], loading: true, error: '', self: null, rankLimit: null
  },

  onShow() {
    return this.load({ metric: 'area', scope: 'national', period: 'day' })
  },

  onUnload() {
    this.requestToken = null
  },

  async onPullDownRefresh() {
    try {
      await this.load()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  switchMetric(event) {
    const metric = event.currentTarget.dataset.metric
    if (metric !== this.data.metric) return this.load({ metric })
  },

  switchScope(event) {
    const scope = event.currentTarget.dataset.scope
    if (scope !== this.data.scope) return this.load({ scope })
  },

  switchPeriod(event) {
    const period = event.currentTarget.dataset.period
    if (period !== this.data.period) return this.load({ period })
  },

  retry() {
    return this.load()
  },

  async load(changes) {
    const token = {}
    this.requestToken = token
    const { metric, scope, period } = { ...this.data, ...changes }
    const player = scope === 'national' ? api.savedPlayerId() : ''
    const reset = changes ? { ...changes, podium: [], rows: [], rankLimit: null } : {}
    const self = !changes && this.data.self?.player_id === player ? this.data.self : null
    this.setData({ ...reset, self, loading: true, error: '' })
    try {
      const result = await api.leaderboard(metric, scope, player, period)
      if (this.requestToken !== token) return
      const formatScore = metric === 'area' ? areaText : distanceText
      const podium = [], rows = []
      for (const entry of result.entries) {
        const group = entry.rank <= 3 ? podium : rows
        group.push({
          id: scope === 'province' ? entry.region_code : entry.player_id,
          rank: entry.rank, name: entry.display_name,
          avatar: api.avatarUrl(entry.avatar_url), initial: Array.from(entry.display_name)[0],
          score: formatScore(entry.value)
        })
      }
      const own = result.self
      const currentSelf = own && own.player_id === player && api.savedPlayerId() === player
        ? { player_id: player, rank: own.rank, outside_limit: !!own.outside_limit, value: own.value, score: formatScore(own.value) } : null
      this.setData({ podium, rows, self: currentSelf, loading: false, rankLimit: result.rank_limit || null })
    } catch (error) {
      if (this.requestToken === token) this.setData({ loading: false, error: error.message || '排行榜暂时无法加载' })
    }
  }
})

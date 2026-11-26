const api = require('../../lib/api')
const { areaText, durationText, frame, outcomeLayers } = require('../../lib/map')

const pendingGrants = new Map()
const requests = new Map()
const BOUNDARY_CACHE_LIMIT = 20

function boundaryCache() {
  return { recent: new Map(), pending: new Map() }
}

function grantKey(player, template) {
  return ['park.loss-notice', api.config.cloudEnv, player, template].join('.')
}

function pendingGrant(key) {
  return pendingGrants.get(key) || wx.getStorageSync(key) || ''
}

function askWechat(template) {
  if (typeof wx.requestSubscribeMessage !== 'function') {
    throw new Error('当前微信版本无法订阅提醒，请更新后重试。')
  }
  return new Promise((resolve, reject) => wx.requestSubscribeMessage({
    tmplIds: [template],
    success: result => resolve(result[template] === 'accept'),
    fail: () => reject(new Error('未能请求微信提醒，你仍可在这里查看领地战报。'))
  }))
}

async function registerNotice(player, template, key) {
  let grant = pendingGrant(key)
  if (!grant) {
    if (!await askWechat(template)) return null
    if (api.playerId() !== player) throw new Error('微信账号已切换')
    grant = 'loss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
    pendingGrants.set(key, grant)
    wx.setStorageSync(key, grant)
  }
  let notice
  try {
    notice = await api.subscribeLossNotice(template, grant, player)
  } catch (error) {
    if (error.code === 'notice_unavailable') {
      pendingGrants.delete(key)
      wx.removeStorageSync(key)
    }
    throw error
  }
  wx.removeStorageSync(key)
  pendingGrants.delete(key)
  return notice
}

function reportRow(report) {
  const time = new Date(report.ended_at * 1000)
  const pad = n => String(n).padStart(2, '0')
  return {
    id: report.id, name: report.challenger_name,
    time: time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) + ' ' +
      pad(time.getHours()) + ':' + pad(time.getMinutes()),
    area: areaText(report.area_m2), pace: durationText(report.pace_s_per_km),
    regions: report.regions.map((region, index) => ({
      index, latitude: region.latitude, longitude: region.longitude, area: areaText(region.area_m2),
      coordinates: region.latitude.toFixed(5) + ', ' + region.longitude.toFixed(5)
    }))
  }
}

function boundaryMap(geometry) {
  const feature = { geometry, outcome: 'captured' }
  const bounds = frame([feature])
  const { polygons, lines } = outcomeLayers([feature], 'captured')
  if (polygons.length) {
    // 无孔时由一个原生多边形同时填色、描边，顶点只传一次。
    Object.assign(polygons[0], { fillColor: '#CF794D40', strokeColor: lines[0].color, strokeWidth: 3 })
  }
  return { bounds, polygons, lines: polygons.length ? [] : lines, markers: [],
    latitude: (bounds[0].latitude + bounds[1].latitude) / 2,
    longitude: (bounds[0].longitude + bounds[1].longitude) / 2 }
}

Page({
  data: {
    player: '', rows: [], cursor: null, loading: false, error: '', selected: null, showSamplesLink: false, sampleView: false,
    template: '', subscribed: false, noticeBusy: false, noticeMessage: '', pending: false
  },

  onLoad(options = {}) {
    this._read = 0
    this._noticeVersion = 0
    this._boundaryRead = 0
    this._boundaries = boundaryCache()
    const { envVersion } = wx.getAccountInfoSync().miniProgram
    const canPreview = envVersion === 'develop' || envVersion === 'trial'
    const sampleView = canPreview && options.samples === '1'
    this.setData({ sampleView, showSamplesLink: canPreview && !sampleView })
    if (sampleView) {
      this.setData({ rows: require('./samples').map(reportRow) })
      wx.setNavigationBarTitle({ title: '示例战报' })
    }
  },
  onShow() { if (!this.data.sampleView) return this.refresh() },
  onUnload() { this._unloaded = true; this._read++; this._boundaryRead++; this._boundaries = null },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=reports' }) },

  refresh() {
    const player = api.savedPlayerId()
    const read = ++this._read
    if (!player || this.data.player !== player) {
      this._boundaryRead++
      this._boundaries = boundaryCache()
      this.setData({ player, rows: [], cursor: null, selected: null, template: '', subscribed: false,
        noticeBusy: false, noticeMessage: '', pending: false })
    }
    this.setData({ error: '', loading: !!player })
    if (player) return this.loadPage(player, null, read)
  },

  loadMore() {
    if (this.data.sampleView) return
    if (this.data.player !== api.savedPlayerId()) return this.refresh()
    if (this.data.loading || !this.data.cursor) return
    this.setData({ loading: true, error: '' })
    return this.loadPage(this.data.player, this.data.cursor, ++this._read)
  },
  onReachBottom() { return this.loadMore() },
  retry() { return this._failedCursor ? this.loadMore() : this.refresh() },

  async loadPage(player, cursor, read) {
    const version = this._noticeVersion
    try {
      const result = await api.lossReports(cursor, player)
      if (read !== this._read) return
      if (api.playerId() !== player) return this.refresh()
      const rows = result.reports.map(reportRow)
      const values = { rows: cursor ? this.data.rows.concat(rows) : rows, cursor: result.next_cursor,
        loading: false, error: '' }
      if (!cursor && this.data.selected && !rows.some(row => row.id === this.data.selected.id)) {
        this._boundaryRead++
        values.selected = null
      }
      if (version === this._noticeVersion) {
        const { template_id: template, subscribed } = result.notification
        Object.assign(values, { template, subscribed, pending: !!template && !!pendingGrant(grantKey(player, template)) })
      }
      this._failedCursor = null
      this.setData(values)
    } catch (error) {
      if (read !== this._read) return
      if (api.savedPlayerId() !== player) return this.refresh()
      this._failedCursor = cursor
      this.setData({ loading: false, error: error.message || '战报读取失败，请重试。' })
    }
  },

  async subscribe() {
    const { player, template, subscribed, pending, noticeBusy } = this.data
    if (!player || player !== api.playerId()) return this.refresh()
    if (!template || (subscribed && !pending) || noticeBusy) return
    const key = grantKey(player, template)
    this.setData({ noticeBusy: true, noticeMessage: '' })
    try {
      let request = requests.get(key)
      if (!request) {
        request = registerNotice(player, template, key).finally(() => requests.delete(key))
        requests.set(key, request)
      }
      const notice = await request
      if (this._unloaded) return
      if (api.playerId() !== player || this.data.player !== player || this.data.template !== template) return this.refresh()
      this._noticeVersion++
      if (notice) this.setData({ subscribed: notice.subscribed, pending: false })
      this.setData({ noticeMessage: notice ? '' : '本次未订阅，你可以随时回来查看战报。' })
    } catch (error) {
      if (this._unloaded) return
      if (api.playerId() !== player || this.data.player !== player) return this.refresh()
      if (error.code === 'notice_unavailable') return this.refresh()
      const pending = !!pendingGrant(key)
      this.setData({ pending, noticeMessage: pending ? '微信已授权，登记失败。请重试登记。' : error.message })
    } finally {
      if (!this._unloaded && this.data.player === player) this.setData({ noticeBusy: false })
    }
  },

  showLocation(event) {
    if (!this.data.sampleView && this.data.player !== api.playerId()) return this.refresh()
    const { report, region } = event.currentTarget.dataset
    const row = this.data.rows[report]
    const point = row && row.regions[region]
    if (!point) return
    if (this.data.selected?.id === row.id && this.data.selected.index === point.index) {
      this._boundaryRead++
      return this.setData({ selected: null })
    }
    return this.openBoundary(report, row, point)
  },

  retryBoundary(event) {
    const { report, region } = event.currentTarget.dataset
    const row = this.data.rows[report]
    const point = row && row.regions[region]
    if (point && this.data.selected?.id === row.id && this.data.selected.index === point.index) {
      return this.openBoundary(report, row, point)
    }
  },

  readBoundary(reportId, index, player) {
    const cache = this._boundaries
    const key = reportId + ':' + index
    if (cache.recent.has(key)) {
      const result = cache.recent.get(key)
      cache.recent.delete(key)
      cache.recent.set(key, result)
      return result
    }
    if (!cache.pending.has(key)) {
      const request = api.lossReportBoundary(reportId, index, player).then(result => {
        if (this._boundaries === cache) {
          cache.recent.set(key, result)
          if (cache.recent.size > BOUNDARY_CACHE_LIMIT) cache.recent.delete(cache.recent.keys().next().value)
        }
        return result
      }).finally(() => cache.pending.delete(key))
      cache.pending.set(key, request)
    }
    return cache.pending.get(key)
  },

  async openBoundary(report, row, point) {
    const { player, sampleView } = this.data
    if (!sampleView && (!player || player !== api.playerId())) return this.refresh()
    const read = ++this._boundaryRead
    const { index, latitude, longitude } = point
    const center = { id: row.id, index, latitude, longitude, bounds: [], polygons: [], lines: [],
      markers: [{ id: 1, latitude, longitude, iconPath: '/assets/route-active.png', width: 30, height: 30 }] }
    this.setData({ selected: { ...center, loading: true } })
    try {
      const result = sampleView ? require('./samples')[report].regions[index] : await this.readBoundary(row.id, index, player)
      if (read !== this._boundaryRead) return
      if (!sampleView && player !== api.playerId()) return this.refresh()
      const map = result.geometry ? boundaryMap(result.geometry) : {
        hint: result.reason === 'too_complex' ? '边界过于复杂，显示地块位置' : '这份战报仅记录了地块位置'
      }
      this.setData({ selected: { ...center, ...map } })
    } catch (error) {
      if (read !== this._boundaryRead) return
      if (!sampleView && player !== api.savedPlayerId()) return this.refresh()
      this.setData({ selected: { ...center, error: error.message || '暂时无法读取地块边界' } })
    }
  }
})

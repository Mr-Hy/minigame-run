const api = require('../../lib/api')
const results = require('../../lib/results')
const { achievementRows } = require('../../lib/achievements')
const { areaText, durationText, frame, outcomeLayers, ownerText, territoryAt } = require('../../lib/map')

const categories = [
  { key: 'claimed', label: '新占' }, { key: 'captured', label: '夺得' },
  { key: 'defended', label: '守住' }, { key: 'failed', label: '未夺得' }
]

function detail(region, result) {
  if (region.outcome === 'claimed') return '首次占领空地'
  const owner = ownerText(region.previous_owner, result.player_id)
  const prior = durationText(region.previous_pace_s_per_km)
  if (region.outcome === 'captured') return '从' + owner + '手中夺得 · 原配速 ' + prior
  if (region.outcome === 'defended') {
    return region.pace_s_per_km < region.previous_pace_s_per_km
      ? '守住自己的领地 · 原配速 ' + prior : '守住自己的领地 · 保留原成绩'
  }
  return owner + (result.pace_s_per_km === region.previous_pace_s_per_km ? ' 同速守住' : ' 配速更快，守住领地')
}

Page({
  data: { achievementPopup: false, signedIn: false, loginError: '', found: false, loadingRun: false, runError: '', valid: false, rows: [], page: 0, selectedIndex: -1 },

  onLoad(options = {}) {
    this._view = 0
    this._runId = options.run_id
  },

  onShow() { return this.loadRun() },

  async loadRun() {
    const view = ++this._view
    this.setData({ signedIn: false, found: false, achievementPopup: false, loginError: '', runError: '' })
    let account
    try {
      account = await api.login()
    } catch (error) {
      if (view === this._view) this.setData({ loginError: error.message || '请登录微信后查看跑步记录。' })
      return
    }
    if (view !== this._view) return
    this.setData({ signedIn: true, loadingRun: !!this._runId })
    let result
    if (this._runId) {
      try {
        const run = await api.getRun(this._runId, account.player_id)
        if (view !== this._view) return
        result = run.result
      } catch (error) {
        if (view !== this._view) return
        if (error.code === 'account_changed' || error.code === 'login_required') {
          this.setData({ signedIn: false, loginError: error.message, loadingRun: false })
        } else {
          this.setData({ runError: error.message || '跑步记录读取失败', loadingRun: false })
        }
        return
      }
      this.setData({ loadingRun: false })
    } else {
      result = results.get()
    }
    if (!result) return
    this.result = result
    const totals = { claimed: 0, captured: 0, defended: 0, failed: 0 }
    result.outcomes.forEach(region => { totals[region.outcome] += region.area_m2 })
    const acquired = totals.claimed + totals.captured
    let title = '本圈挑战结束'
    if (!result.valid_loop) title = '已保存运动记录'
    else if (acquired > 0) title = '新增领地 ' + areaText(acquired)
    else if (totals.defended > 0) title = '守住领地 ' + areaText(totals.defended)
    const achievements = achievementRows(result.achievement_updates)
    const achievementPopup = !this._runId && achievements.length > 0 && results.takeCelebration(result)
    const time = new Date((result.ended_at + 8 * 3600) * 1000)
    this.setData({
      found: true, valid: result.valid_loop, title,
      achievements, achievementPopup, showAllAchievements: false,
      showReportEntry: result.valid_loop && (acquired > 0 || totals.defended > 0),
      day: time.getUTCFullYear() + ' 年 ' + (time.getUTCMonth() + 1) + ' 月 ' + time.getUTCDate() + ' 日',
      meters: Math.round(result.distance_m), duration: durationText(result.duration_s),
      pace: result.pace_s_per_km == null ? '—' : durationText(result.pace_s_per_km),
      area: areaText(result.area_m2), reasons: result.reason_messages || [],
      gap: Math.round(result.max_gap_s), closure: result.closure_distance_m == null ? '—' : Math.round(result.closure_distance_m),
      filters: categories.map(c => ({ ...c, area: areaText(totals[c.key]) }))
    })
    if (result.valid_loop) this.select((categories.find(c => totals[c.key] > 0) || categories[0]).key)
  },

  onHide() { this._view++; this.setData({ signedIn: false, found: false }) },
  onUnload() { this._view++ },

  filter(e) { this.select(e.currentTarget.dataset.key) },

  select(key, selectedRegion = null) {
    this.filtered = this.result.outcomes.filter(region => region.outcome === key)
    const selectedIndex = this.filtered.indexOf(selectedRegion)
    this.setData({ selected: key, selectedIndex })
    this.showPage(Math.max(0, Math.floor(selectedIndex / 12)))
    this.drawMap(selectedRegion)
  },

  drawMap(selectedRegion) {
    const focus = this.filtered.length ? this.filtered : this.result.outcomes
    const bounds = frame(selectedRegion ? [selectedRegion] : focus)
    if (!bounds.length) return
    const layers = outcomeLayers(this.result.outcomes, this.data.selected, selectedRegion, this.result.player_id)
    this.setData({ polygons: layers.polygons, lines: layers.lines, mapBounds: bounds,
      longitude: (bounds[0].longitude + bounds[1].longitude) / 2,
      latitude: (bounds[0].latitude + bounds[1].latitude) / 2 })
  },

  showPage(page) {
    const start = page * 12
    const rows = this.filtered.slice(start, start + 12).map((region, i) => ({
      index: start + i, area: areaText(region.area_m2), detail: detail(region, this.result),
      pace: durationText(region.pace_s_per_km)
    }))
    this.setData({ rows, page, pages: Math.ceil(this.filtered.length / 12) })
  },

  locateRegion(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.select(this.data.selected, index === this.data.selectedIndex ? null : this.filtered[index])
  },

  tapMap(e) {
    const point = e.detail
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return
    const region = territoryAt(this.result.outcomes, point)
    if (region) this.select(region.outcome, region)
  },

  changePage(page) {
    this.setData({ selectedIndex: -1 })
    this.showPage(page)
    this.drawMap(null)
  },
  previous() { if (this.data.page > 0) this.changePage(this.data.page - 1) },
  next() { if (this.data.page + 1 < this.data.pages) this.changePage(this.data.page + 1) },
  dismissAchievementPopup() { this.setData({ achievementPopup: false }) },
  toggleAchievements() { this.setData({ showAllAchievements: !this.data.showAllAchievements }) },
  openAchievements() {
    const pages = getCurrentPages()
    if (pages[pages.length - 2]?.route === 'pages/achievements/index') wx.navigateBack()
    else wx.navigateTo({ url: '/pages/achievements/index' })
  },
  openMap() { wx.switchTab({ url: '/pages/run/index' }) },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=result' }) }
})

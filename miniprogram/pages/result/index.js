const api = require('../../lib/api')
const results = require('../../lib/results')
const { achievementRows } = require('../../lib/achievements')
const { areaText, createTrackPlayback, durationText, frame, outcomeLayers, ownerText,
  playbackFrame, recordedTrackMap, territoryAt } = require('../../lib/map')
const { prepareReplaySurface, drawReplayFrame } = require('../../lib/replay-canvas')
const runPoster = require('../../lib/run-poster')
const { callWx } = require('../../lib/location')

const PLAYBACK_DURATION_MS = 3500

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

function loginError(error) {
  return error.code === 'account_changed' || error.code === 'login_required'
}

function* routeOverlays(map) {
  let index = 0
  for (const line of map.lines) {
    // Adjacent native polylines share an endpoint and stay inside the same GPS segment.
    for (let start = 0; start < line.points.length - 1; start += 1024) {
      const points = line.points.slice(start, start + 1025)
      yield [`routeMap.lines[${index++}]`, { ...line, points }, points.length]
    }
  }
  for (const [i, circle] of map.circles.entries()) yield [`routeMap.circles[${i}]`, circle, 1]
}

Page({
  data: { achievementPopup: false, signedIn: false, loginError: '', found: false, loadingRun: false, runError: '',
    routeMap: null, routeLoading: false, routeError: '', canReplay: false, replaying: false,
    replayPercent: 0, canvasVisible: false, emptyOverlays: [],
    sharing: false, shareHint: '', valid: false, rows: [], page: 0, selectedIndex: -1 },

  onLoad(options = {}) {
    this._view = 0
    this._runId = options.run_id
    this._requestedShare = !!this._runId && options.share === '1'
    this._previewWalk = options.example === 'temporary-walk' && wx.getAccountInfoSync().miniProgram.envVersion === 'develop'
  },

  onShow() { return this.loadRun() },

  onReady() {
    this._ready = true
    this.startReplayClock()
    this.shareIfRequested()
  },

  async loadRun() {
    const view = ++this._view
    this.clearReplayClock()
    this._playback = null
    this.result = null
    this.setData({ signedIn: false, found: false, achievementPopup: false, loginError: '', runError: '',
      routeMap: null, routeLoading: false, routeError: '', canReplay: false, replaying: false,
      replayPercent: 0, canvasVisible: false, sharing: false, shareHint: '' })
    let account
    try {
      account = await api.login()
    } catch (error) {
      if (view === this._view) this.setData({ loginError: error.message || '请登录微信后查看跑步记录。' })
      return
    }
    if (view !== this._view) return
    if (this._previewWalk) {
      const { result, points } = require('./temporary-walk-example')
      this.setData({ signedIn: true, loadingRun: false })
      this.showResult(result)
      await this.showTrack(points, result.started_at, result.ended_at, view)
      if (view !== this._view) return
      this.startReplayClock()
      wx.setNavigationBarTitle({ title: '本圈结算 · 临时示例' })
      return
    }
    this.setData({ signedIn: true, loadingRun: !!this._runId })
    if (!this._runId) {
      const latest = results.get()
      if (!latest) return
      this.showResult(latest)
    }
    await this.readRoute(this._runId || this.result.run_id, account.player_id, view)
    if (view === this._view) this.shareIfRequested()
  },

  shareIfRequested() {
    if (!this._requestedShare || !this._ready || !this.data.found || this.data.loadingRun || this.data.routeLoading) return
    this._requestedShare = false
    return this.shareRun()
  },

  async shareRun() {
    if (!this.data.signedIn || !this.data.found || this.data.sharing || this.data.routeLoading) return
    const view = this._view
    const result = this.result
    const player = api.playerId()
    this.setData({ sharing: true, shareHint: '' })
    try {
      let standings
      if (!this._previewWalk) {
        if (!player || result.player_id !== player) return
        try {
          standings = await api.shareStandings(result.run_id, player)
        } catch (error) {
          if (view !== this._view) return
          if (loginError(error) || error.code === 'run_not_found') {
            this.setData({ shareHint: error.message || '请重新打开这条记录后再分享。' })
            return
          }
          this.setData({ shareHint: '排行榜暂时无法读取，本次海报仅展示跑步记录。' })
        }
      }
      if (view !== this._view || player !== api.playerId()) return
      const path = await runPoster.generateRunPoster(this, result, this.data.routeMap, standings)
      if (view !== this._view || player !== api.playerId()) return
      if (typeof wx.showShareImageMenu === 'function') {
        try {
          await callWx('showShareImageMenu', { path, needShowEntrance: true, entrancePath: '/pages/run/index' })
          return
        } catch (error) {
          if (view !== this._view || /cancel/i.test(error.errMsg || '')) return
        }
      }
      this.setData({ shareHint: '长按海报可发给好友或保存图片，也可从相册发朋友圈。' })
      await callWx('previewImage', { current: path, urls: [path] })
    } catch (error) {
      if (view === this._view && !/cancel/i.test(error.errMsg || '')) {
        this.setData({ shareHint: '海报打开失败，请点「分享跑步记录」重试。' })
      }
    } finally {
      if (view === this._view) this.setData({ sharing: false })
    }
  },

  async readRoute(id, player, view) {
    this.setData({ routeLoading: true, routeError: '' })
    try {
      let run
      try {
        run = await api.getRun(id, player, true)
      } catch (error) {
        if (view !== this._view) return
        if (loginError(error) || error.code === 'run_not_found' || this.data.found) throw error
        // A stored track can fail to load while its settlement is still readable.
        this.setData({ routeError: error.message || '轨迹读取失败' })
        run = await api.getRun(id, player)
      }
      if (view !== this._view) return
      if (run.result && !this.data.found) this.showResult(run.result)
      if (run.points) await this.showTrack(run.points, run.started_at, run.ended_at, view)
    } catch (error) {
      if (view !== this._view) return
      if (loginError(error)) this.setData({ signedIn: false, found: false, loginError: error.message, routeMap: null })
      else if (this.data.found) this.setData({ routeError: error.message || '轨迹读取失败' })
      else this.setData({ runError: error.message || '跑步记录读取失败' })
    } finally {
      if (view === this._view) {
        this.setData({ loadingRun: false, routeLoading: false })
        this.startReplayClock()
      }
    }
  },

  async showTrack(points, start, end, view) {
    const playback = createTrackPlayback(points, start, end)
    this._playback = playback
    this.setData({ canReplay: !!playback, replaying: !!playback, canvasVisible: !!playback, replayPercent: 0 })
    await this.showRouteMap(recordedTrackMap(points, start, end), view)
  },

  prepareReplaySurface,

  async startReplayClock() {
    if (!this._ready || !this.data.found || !this.data.replaying || this.data.routeLoading ||
        this.data.achievementPopup || this._animation) return
    const animation = {}
    this._animation = animation
    const isCurrent = () => this._animation === animation
    try {
      const surface = await this.prepareReplaySurface(this, isCurrent)
      if (!isCurrent()) return
      if (!surface) return this.finishReplay()
      animation.surface = surface
      const started = Date.now()
      const draw = () => {
        if (!isCurrent()) return
        const fraction = (Date.now() - started) / PLAYBACK_DURATION_MS
        if (fraction >= 1) return this.finishReplay()
        const frame = playbackFrame(this._playback, fraction)
        if (!drawReplayFrame(surface.ctx, surface.width, surface.height, surface.region, frame)) return this.finishReplay()
        if (frame.percent !== this.data.replayPercent) this.setData({ replayPercent: frame.percent })
        animation.handle = surface.canvas.requestAnimationFrame(draw)
      }
      draw()
    } catch (error) {
      if (!isCurrent()) return
      console.warn('轨迹回放画布未就绪', error.message || error.errMsg)
      this.finishReplay()
    }
  },

  replayRegionChanged(event) {
    if (event.type !== 'end' && event.detail?.type !== 'end') return
    const animation = this._animation
    const surface = animation?.surface
    if (!surface?.mapContext) return
    surface.mapContext.getRegion({ success: region => {
      if (this._animation === animation) surface.region = region
    } })
  },

  clearReplayClock() {
    const animation = this._animation
    this._animation = null
    if (animation?.handle != null) animation.surface.canvas.cancelAnimationFrame(animation.handle)
    clearTimeout(this._canvasHandoff)
  },

  finishReplay() {
    const surface = this._animation?.surface
    this.clearReplayClock()
    if (surface) drawReplayFrame(surface.ctx, surface.width, surface.height, surface.region, playbackFrame(this._playback, 1))
    this.setData({ replaying: false, replayPercent: 100, canvasVisible: !!surface })
    // Leave the finished stroke in place while the native map paints its full-resolution route.
    if (surface) this._canvasHandoff = setTimeout(() => this.setData({ canvasVisible: false }), 240)
  },

  toggleReplay() {
    if (!this._playback) return
    if (this.data.replaying) return this.finishReplay()
    this.clearReplayClock()
    this.setData({ replaying: true, replayPercent: 0, canvasVisible: true })
    this.startReplayClock()
  },

  async showRouteMap(map, view) {
    // Map data contains only numbers and ASCII styles. Keep each setData under 1 MiB.
    if (!map || JSON.stringify(map).length < 1000 * 1024) {
      this.setData({ routeMap: map })
      return
    }
    this.setData({ routeMap: { ...map, lines: [], circles: [] } })
    let batch = {}, count = 0
    for (const [path, overlay, points] of routeOverlays(map)) {
      batch[path] = overlay
      count += points
      if (count >= 2048) {
        await new Promise(resolve => this.setData(batch, resolve))
        if (view !== this._view) return
        batch = {}
        count = 0
      }
    }
    if (count) this.setData(batch)
  },

  retryRoute() {
    if (!this.data.found || this.data.routeLoading) return
    return this.readRoute(this.result.run_id, this.result.player_id, this._view)
  },

  showResult(result) {
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

  onHide() {
    this._view++
    this.clearReplayClock()
    this._playback = null
    this.setData({ signedIn: false, found: false, canReplay: false, replaying: false, canvasVisible: false })
  },
  onUnload() { this._view++; this.clearReplayClock(); this._playback = null },

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
  dismissAchievementPopup() { this.setData({ achievementPopup: false }); this.startReplayClock() },
  toggleAchievements() { this.setData({ showAllAchievements: !this.data.showAllAchievements }) },
  openAchievements() {
    const pages = getCurrentPages()
    if (pages[pages.length - 2]?.route === 'pages/achievements/index') wx.navigateBack()
    else wx.navigateTo({ url: '/pages/achievements/index' })
  },
  openMap() { wx.switchTab({ url: '/pages/run/index' }) },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=result' }) }
})

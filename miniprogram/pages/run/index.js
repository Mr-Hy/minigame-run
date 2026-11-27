const api = require('../../lib/api')
const tracker = require('../../lib/tracker')
const results = require('../../lib/results')
const { callWx, issues, deviceLocationIssue, getMapPosition } = require('../../lib/location')
const { shortNickname } = require('../../lib/nickname')
const { pace } = require('../../lib/run-format')
const { territoryAt, pickTerritorySurface, inBounds, areaText, territoryLayers, trackLines, durationText } = require('../../lib/map')
const { ownTerritory } = require('../../lib/territory-theme')

const labels = {
  idle: '准备出发', locating: '正在获取起点', running: '跑步中', finishing: '正在结算', pending: '等待重新结算'
}

function regionBounds(region) {
  if (!region || !region.southwest || !region.northeast) return null
  const { southwest, northeast } = region
  return { west: southwest.longitude, south: southwest.latitude,
    east: northeast.longitude, north: northeast.latitude }
}

function visibleRegion(context) {
  if (!context) return Promise.resolve(null)
  return new Promise(resolve => context.getRegion({
    success(region) { resolve(regionBounds(region)) },
    fail() { resolve(null) }
  }))
}

function territoryOwner(land, player, name = land.owner_display_name) {
  return (land.owner === player ? '我 · ' : '') + name
}

function ownerMarkers(territories, player, failedAvatars, relief) {
  const ownerCallouts = []
  const markers = territories.map(land => {
    const raised = relief && relief.land === land
    const position = raised ? relief.liftedPoint(land.label_point) : land.label_point
    const marker = {
      id: land.id, ...position, zIndex: raised ? 2 : 1,
      iconPath: '/assets/park-active.png', width: 1, height: 1, anchor: { x: 0.5, y: 0.5 }
    }
    const nickname = shortNickname(land.owner_display_name)
    if (player && land.owner === player) {
      marker.callout = { display: 'ALWAYS', content: territoryOwner(land, player, nickname), padding: 4,
        borderRadius: 6, fontSize: 12, color: '#FFFFFF', bgColor: ownTerritory.base }
    } else {
      marker.customCallout = { display: 'ALWAYS' }
      ownerCallouts.push({ id: land.id, nickname, pillWidth: 14 + 11 * Math.min(4, Array.from(nickname).length),
        avatar: failedAvatars.has(land.marker_icon) ? '' : (land.marker_icon || '') })
    }
    return marker
  })
  return { markers, ownerCallouts }
}

Page({
  data: {
    latitude: api.config.origin.latitude, longitude: api.config.origin.longitude,
    initialZoom: 17,
    signedIn: false, starting: false, polygons: [], polylines: [], circles: [], markers: [], ownerCallouts: [], locationEnabled: false, locationError: '',
    locating: false, mapLoading: false, mapError: '', mapCount: 0, mapLoaded: false,
    selection: null, phase: 'idle', phaseLabel: labels.idle, distanceText: '0.00',
    elapsedText: '0:00', paceText: '—', runMessage: '', actionError: '',
    permissionDenied: false, hasResult: false
  },

  onLoad() {
    this._view = 0
    this._request = 0
    this._outlines = []
    this._routeLines = []
    this._failedAvatars = new Set()
    this._zoom = this.data.initialZoom
    this._viewScale = 256 * 2 ** this._zoom
  },

  async onShow() {
    this._visible = true
    const view = ++this._view
    const changedPlayer = !!this._player && this._player !== api.playerId()
    if (changedPlayer) this.clearPlayerView()
    else this.drawTerritories()
    if (this._context) {
      this.locate(true)
      this.refreshMap(changedPlayer)
    }
    if (!api.hasSavedLogin()) return
    try {
      if (await this.syncRunner(view) && this._deferredResultPlayer === this._player && this.canUseRun()) {
        this._deferredResultPlayer = ''
        this.openResult()
      }
    } catch (error) {
      if (view === this._view) this.setData({ actionError: error.message })
    }
  },

  async syncRunner(view) {
    const player = api.playerId() || (await api.login()).player_id
    if (view !== this._view || !this._visible || player !== api.playerId()) return false
    if (this.canUseRun() && this._unsubscribe) return true
    if (this._unsubscribe) this.stopRunner()
    this._player = player
    this.setData({ signedIn: true, hasResult: !!results.get(), actionError: '' })
    this.drawTerritories()
    this._unsubscribe = tracker.subscribe(state => this.showTrack(state || tracker.snapshot()))
    tracker.restore().catch(error => {
      if (view === this._view) this.setData({ actionError: error.message })
    })
    this._clock = setInterval(() => {
      if (!this.canUseRun()) {
        this.stopRunner()
        this.clearPlayerView()
        this.refreshMap(true)
        return
      }
      const s = this._snapshot
      if (s && s.phase === 'running') this.showMetrics(s, Math.max(s.elapsed, Date.now() / 1000 - s.startedAt))
    }, 1000)
    this.readPermissions()
    return true
  },

  onReady() {
    this._context = wx.createMapContext('park-map', this)
    this.measureMapWidth()
    return Promise.all([this.locate(true), this.refreshMap()])
  },

  onResize() {
    this.measureMapWidth()
    if (this._context && this._visible) this.refreshMap()
  },

  measureMapWidth() {
    if (!wx.createSelectorQuery) return
    wx.createSelectorQuery().in(this).select('#park-map').boundingClientRect(rect => {
      if (!rect || rect.width <= 0) return
      this._mapWidth = rect.width
      this.updateMapScale(this._viewport)
    }).exec()
  },

  updateMapScale(bounds, zoom) {
    if (bounds) this._viewport = bounds
    let width = this._viewScale
    if (this._mapWidth && bounds && bounds.east > bounds.west) {
      // Convert the visible longitude span to the Mercator world width in screen pixels.
      width = this._mapWidth * 360 / (bounds.east - bounds.west)
    } else if (Number.isFinite(zoom)) {
      width *= 2 ** (zoom - this._zoom)
    }
    if (Number.isFinite(zoom)) this._zoom = zoom
    if (!Number.isFinite(width) || Math.abs(width / this._viewScale - 1) < 0.001) return
    this._viewScale = width
    if (this._selectedLand && this._visible) this.drawTerritories()
  },

  clearPlayerView() {
    this._player = ''
    this._locatingView = null
    this._mapData = this._selected = this._selectedLand = this._relief = null
    this._outlines = []
    this.setData({ ...api.config.origin, selection: null, polygons: [], polylines: [], markers: [], ownerCallouts: [],
      circles: [], mapLoaded: false, mapError: '', locating: false, locationError: '' })
  },

  onHide() { this.stopWatching() },
  onUnload() { this.stopWatching() },

  stopWatching() {
    this._visible = false
    this._view++
    this._request++
    clearTimeout(this._regionTimer)
    this.stopRunner()
  },

  stopRunner() {
    clearInterval(this._clock)
    if (this._unsubscribe) this._unsubscribe()
    this._unsubscribe = null
    this._snapshot = this._deniedScope = this._promptedRun = null
    this._routeLines = []
    this.setData({ signedIn: false, hasResult: false, locating: false, locationEnabled: false, actionError: '', runMessage: '',
      polylines: this._outlines, permissionDenied: false, phase: 'idle', phaseLabel: labels.idle,
      distanceText: '0.00', elapsedText: '0:00', paceText: '—' })
  },

  canUseRun() {
    return this._visible && this.data.signedIn && !!this._player && api.playerId() === this._player
  },

  readPermissions() {
    if (!this.canUseRun()) return
    const view = this._view
    wx.getSetting({ success: ({ authSetting }) => {
      if (view !== this._view || !this.canUseRun()) return
      this.updatePermissions(authSetting)
      const recording = this._snapshot
      if (!authSetting['scope.userLocation'] || !this.data.permissionDenied || !recording || recording.phase !== 'running') return
      if (this._promptedRun === recording.startedAt || deviceLocationIssue()) return
      this._promptedRun = recording.startedAt
      this.offerLocationSettings()
    } })
  },

  updatePermissions(settings) {
    const foreground = settings['scope.userLocation']
    const background = settings['scope.userLocationBackground']
    this._deniedScope = ['scope.userLocation', 'scope.userLocationBackground'].find(scope => settings[scope] === false)
    this.setData({ ...(foreground === false && { locationEnabled: false }), permissionDenied: !!this._deniedScope })
    if (foreground && background) this._promptedRun = null
  },

  async openSettings() {
    const view = this._view
    try {
      const { authSetting } = await callWx('openSetting')
      if (view !== this._view || !this._visible) return null
      if (this.canUseRun()) {
        this.updatePermissions(authSetting)
        if (authSetting['scope.userLocation'] && authSetting['scope.userLocationBackground'] && tracker.snapshot().phase === 'running') {
          tracker.restore().catch(err => {
            if (view === this._view && this.canUseRun()) this.setData({ actionError: err.message })
          })
        }
      }
      return authSetting
    } catch {
      if (view === this._view && this._visible) this.setData({ actionError: '未能打开小程序设置，请重试。' })
      return null
    }
  },

  offerLocationSettings() {
    const view = this._view
    return new Promise(resolve => wx.showModal({
      title: '开启后台定位',
      content: '锁屏后记录跑步轨迹需要后台定位。请在设置的「位置信息」中选择「使用小程序期间和离开小程序后」。',
      confirmText: '去设置', cancelText: '暂不开启', confirmColor: '#195D46',
      success: ({ confirm }) => resolve(confirm && view === this._view && this.canUseRun() ? this.openSettings() : null),
      fail: () => resolve(null)
    }))
  },

  regionChanged(event) {
    if ((event.detail && event.detail.type || event.type) !== 'end' || !this._visible) return
    const detail = event.detail || {}
    this.updateMapScale(regionBounds(detail.region), detail.scale)
    clearTimeout(this._regionTimer)
    this._regionTimer = setTimeout(() => this.refreshMap(), 180)
  },

  async refreshMap(useParkOrigin = false) {
    if (!this._visible) return
    const request = ++this._request
    this.setData({ mapLoading: true })
    try {
      const area = useParkOrigin === true ? null : await visibleRegion(this._context)
      if (request !== this._request) return
      this.updateMapScale(area)
      const response = await api.map(area || undefined)
      if (request !== this._request) return
      if (this.data.signedIn && !this.canUseRun()) {
        this.stopRunner()
        this.clearPlayerView()
        return this.refreshMap(true)
      }
      this._mapData = response
      this._failedAvatars.clear()
      if (this._selected) {
        const previous = this._selectedLand && response.territories.find(land => land.id === this._selectedLand.id)
        if (previous) this._selectedLand = previous
        else if (inBounds(response.bounds, this._selected)) this._selectedLand = territoryAt(response.territories, this._selected)
        else this._selected = this._selectedLand = null
      }
      this.drawTerritories()
      this.setData({ mapLoaded: true, mapError: '', mapLoading: false, mapCount: response.territories.length })
    } catch (err) {
      if (request !== this._request) return
      this._mapData = this._selected = this._selectedLand = this._relief = null
      this._outlines = []
      this.setData({ selection: null, circles: [], markers: [], ownerCallouts: [], mapLoaded: false, mapLoading: false,
        mapError: err.message || '地图读取失败，请重试', polygons: [], polylines: this._routeLines })
    }
  },

  drawTerritories() {
    if (!this._mapData) return
    const player = this.canUseRun() ? this._player : ''
    const selected = this._selectedLand
    const layer = territoryLayers(this._mapData.territories, player, selected, this._viewScale)
    this._relief = layer.relief
    this._outlines = layer.lines
    const selection = !this._selected ? null : selected ? {
      label: territoryOwner(selected, player), area: areaText(selected.area_m2),
      detail: '守地配速 ' + pace(selected.pace_s_per_km) + '/公里'
    } : { label: '空地', area: '', detail: '有效闭环可首次占领' }
    const pin = layer.relief ? layer.relief.liftedPoint(this._selected) : this._selected
    const ownSelection = player && selected?.owner === player
    const circles = pin ? [{ ...pin, radius: 2,
      strokeWidth: 2, color: ownSelection ? ownTerritory.dark : '#8E421D',
      fillColor: ownSelection ? ownTerritory.rim : '#FEF5DD' }] : []
    this.setData({ selection, polygons: layer.polygons, circles, polylines: layer.lines.concat(this._routeLines),
      ...ownerMarkers(this._mapData.territories, player, this._failedAvatars, layer.relief) })
  },

  markerAvatarError(event) {
    const url = event.currentTarget.dataset.avatar
    if (!url || !this.data.ownerCallouts.some(flag => flag.avatar === url)) return
    this._failedAvatars.add(url)
    this.setData({ ownerCallouts: this.data.ownerCallouts.map(flag => flag.avatar === url ? { ...flag, avatar: '' } : flag) })
  },

  selectTerritory(event) {
    const pos = event.detail
    if (!this._mapData || !pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) return
    const hit = pickTerritorySurface(this._mapData.territories, this._relief, { latitude: pos.latitude, longitude: pos.longitude })
    if (!hit.land && !inBounds(this._mapData.bounds, pos)) { this.refreshMap(); return }
    this._selected = hit.point
    this._selectedLand = hit.land
    this.drawTerritories()
  },

  selectMarker(event) {
    if (!this._mapData) return
    const id = Number(event.currentTarget?.dataset?.id ?? event.detail?.markerId)
    const land = this._mapData.territories.find(item => item.id === id)
    if (!land) return
    this._selected = land.label_point
    this._selectedLand = land
    this.drawTerritories()
  },

  focus(point) {
    if (!point) return
    const { latitude, longitude } = point
    this.setData({ latitude, longitude })
    if (this._context) this._context.moveToLocation({ latitude, longitude })
  },

  async offerMapPermission(issue, current) {
    const canOpen = issue === issues.mini || (issue === issues.wechat && typeof wx.openAppAuthorizeSetting === 'function')
    const { confirm } = await callWx('showModal', {
      title: issue.title, content: issue.content, confirmColor: '#195D46',
      showCancel: canOpen, confirmText: canOpen ? '去设置' : '知道了', cancelText: '暂不开启'
    })
    if (!current() || !confirm || !canOpen) return false
    if (issue === issues.mini) return (await this.openSettings())?.['scope.userLocation'] === true
    try {
      await callWx('openAppAuthorizeSetting')
      return true
    } catch {
      // 部分系统无法直接跳转，页面继续显示手动开启路径。
      return false
    }
  },

  async locate(onEntry = false) {
    const view = this._view
    if (!this._visible || this._locatingView === view) return
    this._locatingView = view
    const current = () => this._visible && view === this._view && this._locatingView === view
    this.setData({ locating: true, locationError: '' })
    try {
      const prompted = new Set()
      while (current()) {
        const { point, issue } = await getMapPosition(current)
        if (!current()) return
        if (point) {
          this.setData({ locationEnabled: true, locationError: '' })
          if (onEntry !== true || this.data.phase !== 'running') this.focus(point)
          return
        }
        this.setData({ locationEnabled: false, locationError: issue.title + '。' + issue.content })
        if (prompted.has(issue)) return
        prompted.add(issue)
        if (!await this.offerMapPermission(issue, current)) return
      }
    } catch {
      if (current()) {
        this.setData({ locationEnabled: false, locationError: '尚未取得当前位置，请到开阔处点「定位」重试。' })
        if (onEntry !== true) wx.showToast({ title: '定位失败，请重试', icon: 'none' })
      }
    } finally {
      if (current()) {
        this._locatingView = null
        this.setData({ locating: false })
      }
    }
  },

  showMetrics(s, elapsed) {
    const distance = s.distance || 0
    this.setData({ distanceText: (distance / 1000).toFixed(2), elapsedText: durationText(elapsed),
      paceText: distance > 0 ? pace(elapsed * 1000 / distance) : '—' })
  },

  showTrack(s) {
    if (!this.canUseRun()) return
    const last = this._snapshot
    this._snapshot = s
    this.setData({ phase: s.phase, phaseLabel: labels[s.phase], runMessage: s.message || '' })
    this.showMetrics(s, s.elapsed)
    const points = s.points || []
    const tail = points[points.length - 1]
    const changed = !last || s.phase !== last.phase || !last.points || last.points.length !== points.length ||
      (tail && tail !== last.points[last.points.length - 1])
    if (changed) {
      this._routeLines = trackLines(points)
      this.setData({ polylines: this._outlines.concat(this._routeLines) })
    }
    if (s.phase === 'running' && (!last || last.phase !== 'running')) {
      this.focus(tail)
      this.readPermissions()
    }
  },

  async startRun() {
    if (!this._visible || this._action || this.data.phase !== 'idle') return
    this._action = true
    const view = this._view
    this.setData({ starting: true, actionError: '' })
    try {
      if (!this.canUseRun()) {
        if (!api.hasSavedLogin()) return this.openLogin()
        if (!await this.syncRunner(view) || this.data.phase !== 'idle') return
      }
      let deniedScope = this._deniedScope
      if (!deniedScope) {
        try {
          await tracker.start()
          return
        } catch (err) {
          if (err.code !== 'location_permission_denied' || view !== this._view || !this.canUseRun()) throw err
          deniedScope = err.scope || 'scope.userLocationBackground'
          this._deniedScope = deniedScope
          this.setData({ actionError: err.message, permissionDenied: true })
        }
      }
      const settings = await this.offerLocationSettings()
      if (view !== this._view || !this.canUseRun() || !settings || settings['scope.userLocation'] !== true) return
      const background = settings['scope.userLocationBackground']
      // 首次拒绝前台定位时，微信还没有询问后台定位。继续原流程以请求第二项授权。
      if (background !== true && !(background === undefined && deniedScope === 'scope.userLocation')) return
      this.setData({ actionError: '' })
      await tracker.start()
    } catch (err) {
      if (view !== this._view || !this._visible) return
      if (err.code === 'login_required' && !api.hasSavedLogin()) return this.openLogin()
      this.setData({ actionError: err.message || '开始失败，请重试' })
      this.readPermissions()
    } finally {
      this._action = false
      this.setData({ starting: false })
    }
  },

  endRun() {
    if (!this.canUseRun()) return this.openLogin()
    if (this._action) return
    if (this.data.phase === 'pending') { this.settle(); return }
    if (this.data.phase !== 'running') return
    const view = this._view
    wx.showModal({ title: '结束这次跑步？', content: '若有效里程不足 300 米，本次跑步将不计入记录。',
      confirmText: '结束跑步', cancelText: '继续跑', confirmColor: '#A24D2D',
      success: ({ confirm }) => { if (confirm && view === this._view && this.canUseRun()) this.settle() } })
  },

  async settle() {
    if (!this.canUseRun()) return this.openLogin()
    if (this._action) return
    this._action = true
    this.setData({ actionError: '' })
    try {
      const result = await tracker.finish()
      if (result.player_id !== api.playerId()) return
      if (result.recorded === false) {
        if (this.canUseRun()) wx.showToast({ title: '不足 300 米，本次未记录', icon: 'none' })
        return
      }
      results.save(result)
      if (!this.canUseRun()) {
        this._deferredResultPlayer = result.player_id
        return
      }
      this.setData({ hasResult: true })
      this.refreshMap()
      this.openResult()
    } catch (err) {
      this.setData({ actionError: err.message || '结算未完成，请重试' })
    } finally { this._action = false }
  },

  openResult() { wx.navigateTo({ url: '/pages/result/index' }) },
  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=run' }) }
})

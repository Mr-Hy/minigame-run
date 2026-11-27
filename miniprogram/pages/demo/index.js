const demo = require('../../lib/demo')
const { pace } = require('../../lib/run-format')
const map = require('../../lib/shape-map')

const runners = [
  { id: 'a', name: '甲' },
  { id: 'b', name: '乙' }
]
const paces = [340, 360, 370].map((value) => ({ value, label: pace(value) }))
const scenarios = [
  { id: 'normal', label: '正常闭环' },
  { id: 'open', label: '提前结束' },
  { id: 'gap', label: '定位中断' }
]
function amount(value) {
  // Geometric area sums may differ by a few floating-point digits at a half metre.
  return Math.round(Number(value.toFixed(6)))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
function summary(result) {
  const metrics = []
  const notes = []
  for (const key of Object.keys(demo.kinds)) {
    const events = result.events.filter((event) => event.kind === key)
    const size = events.reduce((sum, event) => sum + event.size, 0)
    metrics.push({ key, label: demo.kinds[key], value: amount(size) })
    for (const event of events) {
      const text = demo.explain(event, result)
      if (!notes.includes(text)) notes.push(text)
    }
  }
  return {
    name: demo.names[result.owner],
    valid: result.valid,
    reasons: result.reasons,
    gap: Number(result.maxGap.toFixed(1)),
    closure: result.closureDistance == null ? '—' : amount(result.closureDistance) + ' 米',
    samples: result.sampleCount,
    area: amount(result.size),
    distance: amount(result.meters),
    time: demo.time(result.seconds),
    pace: result.pace == null ? '—' : pace(result.pace) + '/公里',
    metrics,
    notes
  }
}
function initialPlay() {
  return {
    owner: 'a',
    ownerName: '甲',
    pace: 360,
    mode: 'draw',
    scenario: 'normal',
    count: 0,
    round: 0,
    totalA: '0',
    totalB: '0',
    last: null,
    selected: null,
    error: ''
  }
}

Page({
  data: Object.assign({ runners, paces, scenarios }, initialPlay()),
  onLoad() {
    this.territories = []
    this.draft = []
    this.savedPaces = { a: 360, b: 340 }
    this.scrollTop = 0
  },
  onReady() {
    this.canvasReady()
  },
  onResize() {
    this.canvasReady()
  },
  canvasReady() {
    if (this.unloaded || this.queryPending) return
    this.queryPending = true
    wx.createSelectorQuery()
      .in(this)
      .select('#park-map')
      .fields({ node: true, size: true, rect: true })
      .exec((results) => {
        this.queryPending = false
        if (this.unloaded) return
        const item = results[0]
        if (!item || !item.node || !item.width || !item.height) return
        if (!this.territories || !this.draft || !this.savedPaces) {
          this.onLoad()
          this.setData(initialPlay())
        }
        const scale =
          (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 1
        const canvas = item.node
        this.panel = {
          width: item.width,
          height: item.height,
          left: item.left,
          top: item.top + this.scrollTop
        }
        const width = Math.round(item.width * scale)
        const height = Math.round(item.height * scale)
        const newCanvas = canvas !== this.canvas
        if (!newCanvas && canvas.width === width && canvas.height === height) {
          this.paint()
          return
        }
        this.canvas = canvas
        canvas.width = width
        canvas.height = height
        this.ctx = canvas.getContext('2d')
        this.ctx.scale(canvas.width / map.WIDTH, canvas.height / map.HEIGHT)
        if (newCanvas) this.loadRunnerBAvatar(canvas)
        this.paint()
      })
  },
  loadRunnerBAvatar(canvas) {
    this.runnerBAvatar = null
    if (!canvas.createImage) return
    const image = canvas.createImage()
    image.onload = () => {
      if (canvas !== this.canvas || !image.width || !image.height) return
      this.runnerBAvatar = image
      this.paint()
    }
    image.onerror = () => {
      if (canvas !== this.canvas) return
      this.runnerBAvatar = null
      this.paint()
    }
    image.src = '/assets/runner-b.jpg'
  },
  onPageScroll(event) {
    this.scrollTop = event.scrollTop
  },
  paint() {
    if (!this.ctx) return
    const drawing = this.data.mode === 'draw'
    map.render(this.ctx, {
      territories: this.territories,
      owner: this.data.owner,
      guide: drawing && !this.draft.length ? demo.scenarioRoute(demo.routes[this.data.owner], this.data.scenario) : null,
      draft: drawing ? this.draft : [],
      selection: this.selection,
      runnerBAvatar: this.runnerBAvatar
    })
  },
  ownerChange(event) {
    const owner = event.currentTarget.dataset.owner
    this.selection = null
    this.setData({ owner, ownerName: demo.names[owner], pace: this.savedPaces[owner], mode: 'draw', selected: null, error: '' })
    this.paint()
  },
  paceChange(event) {
    const pace = Number(event.currentTarget.dataset.pace)
    this.savedPaces[this.data.owner] = pace
    this.setData({ pace })
  },
  scenarioChange(event) {
    this.selection = null
    this.setData({ scenario: event.currentTarget.dataset.scenario, mode: 'draw', selected: null, error: '' })
    this.paint()
  },
  modeChange(event) {
    this.selection = null
    this.setData({ mode: event.currentTarget.dataset.mode, selected: null, error: '' })
    this.paint()
  },
  touchPoint(event) {
    const list = event.touches && event.touches.length ? event.touches : event.changedTouches
    const p = list && list[0]
    if (!p || !this.panel) return null
    const panel = this.panel
    const px = Number.isFinite(p.x) ? p.x : p.clientX - panel.left
    const py = Number.isFinite(p.y) ? p.y : p.clientY - panel.top + this.scrollTop
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null
    function clamp(value, max) {
      return Math.round(Math.max(0, Math.min(max, value)) * 10) / 10
    }
    return [
      clamp((px / panel.width) * map.WIDTH, map.WIDTH),
      clamp((1 - py / panel.height) * map.HEIGHT, map.HEIGHT)
    ]
  },
  touchStart(event) {
    if (typeof wx !== 'undefined') this.canvasReady()
    if (!this.draft || !this.territories) return
    const p = this.touchPoint(event)
    if (!p) return
    if (this.data.mode === 'inspect') {
      this.inspect(p)
      return
    }
    this.selection = null
    this.strokeStart = p
    this.strokeDraftLength = this.draft.length
    // A tap near the first vertex can finish a previously drawn polyline.
    this.tapClose = this.draft.length >= 3 && demo.distance(this.draft[0], p) < 6
    if (!this.tapClose) this.addPoint(p, 1.4)
    if (this.data.error || this.data.selected) this.setData({ error: '', selected: null })
  },
  touchMove(event) {
    if (!this.strokeStart) return
    const p = this.touchPoint(event)
    if (!p || demo.distance(p, this.strokeStart) < 2) return
    if (this.tapClose) {
      this.tapClose = false
      this.addPoint(this.strokeStart, 1.4)
    }
    this.addPoint(p, 3)
  },
  touchEnd(event) {
    if (!this.strokeStart) return
    const p = this.touchPoint(event)
    const close =
      this.tapClose || (p && this.draft.length >= 3 && demo.distance(p, this.draft[0]) < 6)
    this.strokeStart = null
    this.tapClose = false
    if (close) {
      // Snap to the start rather than creating a small loop at the join.
      while (
        this.draft.length > 3 &&
        demo.distance(this.draft[this.draft.length - 1], this.draft[0]) < 6
      )
        this.draft.pop()
      this.setData({ count: this.draft.length })
      this.closeAndSubmit()
    } else if (p) this.addPoint(p, 1.4)
  },
  touchCancel() {
    if (!this.strokeStart) return
    this.draft.length = this.strokeDraftLength
    this.strokeStart = null
    this.tapClose = false
    this.setData({ count: this.draft.length })
    this.paint()
  },
  addPoint(p, spacing) {
    if (this.draft.length && demo.distance(p, this.draft[this.draft.length - 1]) < spacing) return
    this.draft.push(p)
    this.setData({ count: this.draft.length })
    this.paint()
  },
  undo() {
    if (!this.draft.length) return
    this.draft.pop()
    this.setData({ count: this.draft.length, error: '' })
    this.paint()
  },
  clearDraft() {
    this.draft = []
    this.setData({ count: 0, error: '' })
    this.paint()
  },
  submit() {
    if (!this.draft.length) return
    this.finish(this.draft)
  },
  closeAndSubmit() {
    if (this.draft.length < 3) return
    this.finish([...this.draft, this.draft[0]])
  },
  example() {
    this.finish(demo.routes[this.data.owner], this.data.scenario)
  },
  finish(points, scenario = 'normal') {
    let result
    try {
      result = demo.settle(this.territories, points, this.data.owner, this.data.pace, scenario)
    } catch (error) {
      this.setData({ error: error.message })
      this.paint()
      return
    }
    this.result = result
    this.territories = result.territories
    this.draft = []
    this.selection = null
    const totals = { a: 0, b: 0 }
    for (const land of this.territories) totals[land.owner] += demo.area(land.geometry)
    const nextRunner = result.owner === 'a' ? 'b' : 'a'
    const owner = result.valid ? nextRunner : result.owner
    this.setData({
      round: this.data.round + 1,
      owner,
      ownerName: demo.names[owner],
      pace: this.savedPaces[owner],
      count: 0,
      mode: 'inspect',
      last: summary(result),
      totalA: amount(totals.a),
      totalB: amount(totals.b),
      selected: null,
      error: ''
    })
    this.paint()
  },
  inspect(p) {
    this.selection = map.pickTerritory(this.territories, this.selection && this.selection.land, p, this.runnerBAvatar)
    const { land, point } = this.selection
    const outcome =
      land && this.result && this.result.events.find((part) => demo.contains(part.geometry, point))
    const selected = land
      ? {
          title: land.owner === 'a' ? '我的领地' : map.territoryNickname(land) + '的领地',
          pace: pace(land.pace) + '/公里',
          reason: outcome ? demo.explain(outcome, this.result) : '这片领地保留原来的守地成绩。'
        }
      : { title: '空地', pace: '', reason: '用一条闭合跑线圈住这里，就能首次占领。' }
    this.setData({ selected })
    this.paint()
  },
  reset() {
    this.result = null
    this.selection = null
    this.strokeStart = null
    this.territories = []
    this.draft = []
    this.savedPaces = { a: 360, b: 340 }
    this.setData(initialPlay())
    this.paint()
  },
  onShow() {
    wx.nextTick(() => this.canvasReady())
  },
  onUnload() {
    this.unloaded = true
    this.canvas = null
    this.ctx = null
    this.runnerBAvatar = null
  }
})

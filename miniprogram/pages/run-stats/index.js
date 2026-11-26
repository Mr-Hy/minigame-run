const api = require('../../lib/api')
const { kilometers, duration } = require('../../lib/run-format')

const tabs = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '年度' }
]
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const chinaOffset = 8 * 3600 * 1000

function pace(seconds) {
  if (seconds == null) return '—'
  const total = Math.round(seconds)
  return Math.floor(total / 60) + '′' + String(total % 60).padStart(2, '0') + '″'
}

function summaryView(entry) {
  return {
    count: entry.count, km: kilometers(entry.distance_m), duration: duration(entry.duration_s),
    avgKm: entry.count ? kilometers(entry.avg_distance_m) : '—',
    longestKm: entry.count ? kilometers(entry.longest_distance_m) : '—',
    pace: pace(entry.avg_pace_s_per_km), bestPace: pace(entry.best_pace_s_per_km)
  }
}

function calendarLabel(key, includeYear) {
  const [year, month, day] = key.split('-').map(Number)
  return (includeYear ? year + '年' : '') + month + '月' + (day ? day + '日' : '')
}

function rangeLabel(period, start, end) {
  if (period === 'year') return start.slice(0, 4) + '年'
  if (period === 'month') return calendarLabel(start.slice(0, 7), true)
  return calendarLabel(start, true) + ' – ' + calendarLabel(end, start.slice(0, 4) !== end.slice(0, 4))
}

function chartView(period, start, buckets) {
  const max = Math.max(0, ...buckets.map(bucket => bucket.distance_m))
  return {
    chartMaxKm: kilometers(max),
    monthFirstColumn: new Date(start + 'T00:00:00Z').getUTCDay() || 7,
    buckets: buckets.map((bucket, index) => {
      const day = Number(bucket.key.slice(8))
      const fullLabel = calendarLabel(bucket.key, true)
      const label = period === 'week' ? weekdays[index] : period === 'year' ? String(index + 1) : String(day)
      const height = max ? bucket.distance_m / max * 100 : 0
      return { key: bucket.key, label, fullLabel, day, km: kilometers(bucket.distance_m),
        count: bucket.count, duration: duration(bucket.duration_s), height, level: Math.ceil(height * 3 / 100) }
    })
  }
}

function runRow(run) {
  const ended = new Date(run.ended_at * 1000 + chinaOffset).toISOString()
  return {
    id: run.run_id, date: calendarLabel(ended.slice(0, 10), false), time: ended.slice(11, 16),
    km: kilometers(run.distance_m), duration: duration(run.duration_s), pace: pace(run.pace_s_per_km),
    validLoop: run.valid_loop
  }
}

const emptyPeriod = {
  summary: null, rangeText: '', start: '', buckets: [], chartMaxKm: '0', monthFirstColumn: 1,
  canPrevious: true, selectedKey: '', selectedBucket: null,
  rows: [], cursor: null, historyLoading: false, historyError: ''
}

Page({
  data: {
    player: '', restoring: false, authError: '', period: 'week', offset: 0, tabs, periodLabel: '本周',
    lifetime: null, loading: false, error: '', ...emptyPeriod
  },

  onLoad() { this._read = 0; this._historyRead = 0 },

  onShow() {
    const today = new Date(Date.now() + chinaOffset).toISOString().slice(0, 10)
    if (this.data.player && this.data.player === api.playerId() && this.data.summary && this._today === today) return
    return this.refresh()
  },

  onUnload() { this._read++; this._historyRead++ },

  async onPullDownRefresh() {
    try { await this.refresh() } finally { wx.stopPullDownRefresh() }
  },

  openLogin() { wx.navigateTo({ url: '/pages/login/index?from=run-stats' }) },

  async refresh() {
    const saved = api.savedPlayerId()
    const verified = api.playerId()
    const read = ++this._read
    this._historyRead++
    if (!saved || verified !== this.data.player || !verified) {
      this.setData({ player: '', period: 'week', offset: 0, periodLabel: '本周', lifetime: null, ...emptyPeriod })
    }
    this.setData({ restoring: !!saved && !verified, authError: '', loading: false, error: '' })
    if (!saved) return
    if (!verified) {
      try {
        await api.login()
      } catch (error) {
        if (read !== this._read) return
        if (api.savedPlayerId() !== saved) return this.refresh()
        this.setData({ restoring: false, authError: error.message || '登录状态读取失败，请重试。' })
        return
      }
      if (read !== this._read) return
      if (api.playerId() !== saved) return this.refresh()
    }
    this.setData({ player: saved, restoring: false })
    return this.loadPeriod(this.data.period, this.data.offset)
  },

  switchPeriod(event) {
    const period = event.currentTarget.dataset.period
    if (period !== this.data.period && tabs.some(tab => tab.key === period)) return this.loadPeriod(period, 0)
  },

  previous() { if (this.data.canPrevious) return this.loadPeriod(this.data.period, this.data.offset - 1) },
  next() { if (this.data.offset < 0) return this.loadPeriod(this.data.period, this.data.offset + 1) },
  current() { if (this.data.offset < 0) return this.loadPeriod(this.data.period, 0) },
  retry() { return this.refresh() },

  async loadPeriod(period, offset) {
    const player = this.data.player
    if (!player || player !== api.playerId()) return this.refresh()
    const read = ++this._read
    this._historyRead++
    const today = new Date(Date.now() + chinaOffset).toISOString().slice(0, 10)
    const labels = offset ? { week: '该周', month: '该月', year: '该年' } : { week: '本周', month: '本月', year: '今年' }
    this.setData({ period, offset, periodLabel: labels[period], ...emptyPeriod, loading: true, error: '' })
    try {
      const result = await api.runStats({ period, offset }, player)
      if (read !== this._read) return
      if (player !== api.playerId()) return this.refresh()
      this._today = today
      this.setData({
        lifetime: summaryView(result.lifetime), summary: summaryView(result.summary), loading: false,
        rangeText: rangeLabel(period, result.start, result.end), start: result.start,
        canPrevious: result.can_previous !== false, ...chartView(period, result.start, result.buckets)
      })
    } catch (error) {
      if (read !== this._read) return
      if (player !== api.savedPlayerId()) return this.refresh()
      this.setData({ loading: false, error: error.message || '跑步统计暂时无法读取。' })
      return
    }
    return this.loadHistory(null)
  },

  selectBucket(event) {
    const key = event.currentTarget.dataset.key
    if (key === this.data.selectedKey) return this.clearBucket()
    const selectedBucket = this.data.buckets.find(bucket => bucket.key === key)
    if (!selectedBucket) return
    this.setData({ selectedKey: key, selectedBucket })
    return this.loadHistory(null)
  },

  clearBucket() {
    this.setData({ selectedKey: '', selectedBucket: null })
    return this.loadHistory(null)
  },

  loadMore() {
    if (this.data.cursor && !this.data.historyLoading) return this.loadHistory(this.data.cursor)
  },

  retryHistory() { if (!this.data.historyLoading) return this.loadHistory(this.data.cursor) },

  async loadHistory(cursor) {
    const { player, period, offset, start, selectedKey, selectedBucket, summary } = this.data
    if (!player || player !== api.playerId()) return this.refresh()
    if (!summary) return
    const read = ++this._historyRead
    if (!cursor) this.setData({ rows: [], cursor: null })
    const hasRuns = (selectedBucket || summary).count > 0
    this.setData({ historyLoading: hasRuns, historyError: '' })
    if (!hasRuns) return
    const query = { period, offset, start }
    if (selectedKey) query.bucket = selectedKey
    if (cursor) query.cursor = cursor
    try {
      const page = await api.runHistory(query, player)
      if (read !== this._historyRead) return
      if (player !== api.playerId()) return this.refresh()
      this.setData({ rows: this.data.rows.concat(page.runs.map(runRow)), cursor: page.next_cursor, historyLoading: false })
    } catch (error) {
      if (read !== this._historyRead) return
      if (player !== api.savedPlayerId()) return this.refresh()
      this.setData({ historyLoading: false, historyError: error.message || '跑步记录暂时无法读取。' })
    }
  },

  openRun(event) {
    if (this.data.player !== api.playerId()) return this.refresh()
    const id = event.currentTarget.dataset.id
    if (this.data.rows.some(row => row.id === id)) wx.navigateTo({ url: '/pages/result/index?run_id=' + encodeURIComponent(id) })
  }
})

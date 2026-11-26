const { duration } = require('./run-format')

const records = [
  { key: 'longest_distance', title: '单次最远距离', icon: 'route', kind: 'distance', rule: '一次实跑的最长有效里程' },
  { key: 'fastest_1k', title: '最快 1 公里', icon: 'sprint', kind: 'time', rule: '连续跑完 1 公里的最短用时' },
  { key: 'fastest_5k', title: '最快 5 公里', icon: 'endurance', kind: 'time', rule: '连续跑完 5 公里的最短用时' },
  { key: 'best_week', title: '单周最高里程', icon: 'week', kind: 'distance', rule: '周一至周日累计的最高里程' },
  { key: 'largest_gain', title: '单次新增领地最多', icon: 'gain', kind: 'area', rule: '一趟新占空地与夺得领地的总面积' },
  { key: 'largest_capture', title: '单次夺地最多', icon: 'capture', kind: 'area', rule: '一趟从其他跑者手里夺得的总面积' },
  { key: 'peak_area', title: '历史最大领地面积', icon: 'peak', kind: 'area', rule: '曾经同时拥有的最大领地总面积' }
]

const milestones = [
  { key: 'total_distance', title: '累计跑步里程', icon: 'route', kind: 'distance',
    rule: '每次实跑的有效里程都会计入。', thresholds: [10000, 50000, 100000, 500000] },
  { key: 'running_days', title: '累计跑步天数', icon: 'days', kind: 'days',
    rule: '有有效里程的完赛日按北京时间计数，同一天只计一次。', thresholds: [3, 7, 30, 100] },
  { key: 'total_gain', title: '累计圈地面积', icon: 'gain', kind: 'area',
    rule: '新占与夺得的面积都计入，失地后仍保留进度。', thresholds: [10000, 50000, 200000, 1000000] },
  { key: 'capture_runs', title: '累计成功夺地次数', icon: 'capture', kind: 'count',
    rule: '一趟成功夺地计一次，同一趟夺下多块也只计一次。', thresholds: [1, 5, 20, 100] }
]

const definitions = new Map(records.concat(milestones).map(item => [item.key, item]))
const units = { distance: '公里', area: '平方米', days: '天', count: '次' }

function achievementTitle(key) { return definitions.get(key)?.title || '' }

function clockValue(value) {
  const seconds = Math.round(value)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const pad = number => String(number).padStart(2, '0')
  return (hours ? hours + ':' + pad(minutes) : minutes) + ':' + pad(seconds % 60)
}

function metricValue(kind, value) {
  if (kind === 'time') return { number: clockValue(value), unit: '' }
  if (kind === 'distance') {
    if (value > 0 && value < 1000) return { number: String(Math.floor(value) || '<1'), unit: '米' }
    return { number: String(Math.floor(value / 10) / 100), unit: '公里' }
  }
  const whole = Math.floor(value)
  if (kind === 'area' && value > 0 && whole === 0) return { number: '<1', unit: units.area }
  return { number: String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ','), unit: units[kind] }
}

function formatAchievementValue(key, value) {
  const kind = definitions.get(key)?.kind
  if (!kind || !Number.isFinite(value)) return '—'
  if (kind === 'time') {
    const seconds = Math.round(value)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor(seconds / 60) % 60
    return (hours ? hours + '小时' : '') + (hours || minutes ? minutes + '分' : '') + seconds % 60 + '秒'
  }
  const { number, unit } = metricValue(kind, value)
  return number + ' ' + unit
}

function achievementRows(updates) {
  if (!updates) return []
  const rows = updates.records.map(({ key, value, previous }) => {
    let note = '首次建立纪录'
    if (previous != null) {
      const delta = Math.abs(value - previous)
      if (key === 'fastest_1k' || key === 'fastest_5k') note = '比上次快 ' + duration(delta)
      else note = delta >= 1 ? '比上次多 ' + formatAchievementValue(key, delta) : '刷新个人纪录'
    }
    return { id: key, title: achievementTitle(key), value: formatAchievementValue(key, value), note }
  })
  for (const { key, threshold } of updates.milestones) {
    rows.push({ id: key + '-' + threshold, title: achievementTitle(key),
      value: formatAchievementValue(key, threshold), note: '解锁里程碑' })
  }
  return rows
}

function tierLabel(kind, value) {
  if (kind === 'distance') return value / 1000 + ' 公里'
  if (kind === 'area' && value >= 10000) return value / 10000 + '万 m²'
  return value + ' ' + units[kind]
}

function recordDate(seconds) {
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, '.')
}

function albumView(data) {
  const recordRows = records.map(def => {
    const record = data && data.records[def.key]
    const metric = record ? metricValue(def.kind, record.value) : { number: '', unit: '' }
    return { ...def, ...metric, earned: !!record,
      date: record ? recordDate(record.ended_at) : '', runId: record ? record.run_id : '' }
  })
  const milestoneRows = milestones.map(def => {
    const entry = data && data.milestones[def.key]
    const thresholds = entry ? entry.thresholds : def.thresholds
    const value = entry ? entry.value : 0
    const tiers = thresholds.map(target => ({ target, label: tierLabel(def.kind, target), earned: !!entry && value >= target }))
    const earnedCount = tiers.filter(tier => tier.earned).length
    const next = tiers.find(tier => !tier.earned)
    const current = metricValue(def.kind, value)
    return { key: def.key, title: def.title, icon: def.icon, rule: def.rule, tiers, earnedCount,
      number: current.number, unit: current.unit, completed: !next,
      next: next ? next.label : '', percent: next ? Math.min(100, 100 * value / next.target) : 100 }
  })
  const groups = [{ title: '跑步纪录', items: recordRows.slice(0, 4) }, { title: '领地纪录', items: recordRows.slice(4) }]
  const recordCount = recordRows.filter(row => row.earned).length
  const tierCount = milestoneRows.reduce((sum, row) => sum + row.earnedCount, 0)
  const tierTotal = milestoneRows.reduce((sum, row) => sum + row.tiers.length, 0)
  return { groups, milestoneRows, recordCount, tierCount, tierTotal, recordTotal: recordRows.length,
    unlocked: recordCount + tierCount, total: recordRows.length + tierTotal }
}

module.exports = { achievementTitle, formatAchievementValue, achievementRows, albumView }

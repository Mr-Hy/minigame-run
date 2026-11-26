'use strict'

const BEIJING_OFFSET = 8 * 3600
const PAGE_SIZE = 20

function invalid(code, message) {
  throw Object.assign(new Error(message), { status: 400, code })
}

function dayKey(seconds) {
  return new Date((Math.floor(seconds) + BEIJING_OFFSET) * 1000).toISOString().slice(0, 10)
}

// Move a UTC calendar representing the local date; convert to Unix seconds only at the edges.
function runPeriod({ period = 'week', offset = 0, start }, now) {
  if (!['week', 'month', 'year'].includes(period)) invalid('invalid_period', '请选择周、月或年度统计')
  if (!Number.isSafeInteger(offset) || offset > 0) invalid('invalid_offset', '只能查看当前或更早的周期')
  let anchor = now
  if (start !== undefined) {
    if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start)) invalid('invalid_start', '周期起始日期无效')
    anchor = Date.parse(start + 'T00:00:00+08:00') / 1000
    if (!Number.isFinite(anchor) || anchor > now) invalid('invalid_start', '周期起始日期无效')
    offset = 0
  }
  const date = new Date(dayKey(anchor) + 'T00:00:00Z')
  let stop
  if (period === 'week') {
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + offset * 7)
    stop = date.getTime() + 7 * 86400000
  } else if (period === 'month') {
    date.setUTCMonth(date.getUTCMonth() + offset, 1)
    stop = new Date(date).setUTCMonth(date.getUTCMonth() + 1)
  } else {
    date.setUTCFullYear(date.getUTCFullYear() + offset, 0, 1)
    stop = new Date(date).setUTCFullYear(date.getUTCFullYear() + 1)
  }
  const first = date.getTime() / 1000 - BEIJING_OFFSET
  const end = stop / 1000 - BEIJING_OFFSET
  if (!Number.isFinite(first) || end <= 0) invalid('invalid_offset', '已到最早可查周期')
  if (start !== undefined && first !== anchor) invalid('invalid_start', '日期与所选周期不符')
  const boundaries = [first]
  const keys = []
  while (date.getTime() < stop) {
    const key = date.toISOString().slice(0, period === 'year' ? 7 : 10)
    keys.push(key)
    if (period === 'year') date.setUTCMonth(date.getUTCMonth() + 1)
    else date.setUTCDate(date.getUTCDate() + 1)
    boundaries.push(date.getTime() / 1000 - BEIJING_OFFSET)
  }
  return { start: dayKey(first), end: dayKey(end - 1), can_previous: first > 0, boundaries, keys }
}

function emptyTotals() {
  return { count: 0, distance_m: 0, duration_s: 0, longest_distance_m: 0, best_pace_s_per_km: null }
}

function addTotals(target, part) {
  target.count += part.count
  target.distance_m += part.distance_m
  target.duration_s += part.duration_s
  target.longest_distance_m = Math.max(target.longest_distance_m, part.longest_distance_m)
  const best = part.best_pace_s_per_km
  if (best != null && (target.best_pace_s_per_km == null || best < target.best_pace_s_per_km)) target.best_pace_s_per_km = best
}

function withAverages(totals) {
  return { ...totals, avg_distance_m: totals.count ? totals.distance_m / totals.count : 0,
    avg_pace_s_per_km: totals.distance_m ? Math.round(1000 * totals.duration_s / totals.distance_m) : null }
}

async function runStats(repo, unpack, player, window) {
  const boundaries = window?.boundaries
  const lifetime = emptyTotals()
  const summary = emptyTotals()
  const buckets = (window?.keys || []).map(key => ({ key, count: 0, distance_m: 0, duration_s: 0 }))
  function add(index, part) {
    addTotals(lifetime, part)
    if (index < 0) return
    addTotals(summary, part)
    const bucket = buckets[index]
    bucket.count += part.count
    bucket.distance_m += part.distance_m
    bucket.duration_s += part.duration_s
  }
  const [groups, firstPacked] = await Promise.all([
    repo.inlineRunTotals(player, boundaries), repo.personalRunRows(player, { packedOnly: true }, null, 100)
  ])
  for (const group of groups) add(boundaries ? boundaries.indexOf(group._id) : -1, group)
  // A large settlement stores its result in immutable blocks. Only these records need unpacking.
  let packed = firstPacked
  for (;;) {
    for (const run of packed) {
      const result = await unpack(repo, run.result)
      const index = boundaries ? boundaries.findIndex((start, i) => run.ended_at >= start && run.ended_at < boundaries[i + 1]) : -1
      add(index, { count: 1, duration_s: result.duration_s, distance_m: result.distance_m,
        longest_distance_m: result.distance_m, best_pace_s_per_km: result.pace_s_per_km })
    }
    if (packed.length < 100) break
    packed = await repo.personalRunRows(player, { packedOnly: true }, packed[packed.length - 1], 100)
  }
  if (!window) return withAverages(lifetime)
  return { start: window.start, end: window.end, can_previous: window.can_previous,
    lifetime: withAverages(lifetime), summary: withAverages(summary), buckets }
}

function decodeCursor(cursor, range) {
  if (cursor == null) return null
  if (typeof cursor === 'string' && cursor.length <= 240) {
    try {
      const [ended_at, run_id] = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
      if (Number.isFinite(ended_at) && ended_at >= range.from && ended_at < range.until &&
          typeof run_id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(run_id)) return { ended_at, run_id }
    } catch {}
  }
  invalid('invalid_cursor', '跑步记录翻页参数无效')
}

async function runHistory(repo, unpack, player, window, bucket, cursor) {
  const { boundaries, keys } = window
  let from = boundaries[0], until = boundaries[boundaries.length - 1]
  if (bucket !== undefined) {
    const index = keys.indexOf(bucket)
    if (index < 0) invalid('invalid_bucket', '日期不在所选周期内')
    from = boundaries[index]
    until = boundaries[index + 1]
  }
  const range = { from, until }
  const rows = await repo.personalRunRows(player, range, decodeCursor(cursor, range), PAGE_SIZE + 1)
  const runs = await Promise.all(rows.slice(0, PAGE_SIZE).map(async ({ run_id, ended_at, result }) => {
    const { distance_m, duration_s, pace_s_per_km, valid_loop, pace_anomaly } = result.value ?? await unpack(repo, result)
    return { run_id, ended_at, distance_m, duration_s, pace_s_per_km, valid_loop, pace_anomaly }
  }))
  const last = runs[runs.length - 1]
  const next = rows.length > PAGE_SIZE ? Buffer.from(JSON.stringify([last.ended_at, last.run_id])).toString('base64') : null
  return { runs, next_cursor: next }
}

module.exports = { runPeriod, runStats, runHistory }

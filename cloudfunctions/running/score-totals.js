'use strict'

const { createHash } = require('node:crypto')
const { catalog, getRegion } = require('./regions')

const AREA_UNITS = 100
const DISTANCE_UNITS = 1000
const BEIJING_OFFSET_SECONDS = 8 * 60 * 60
const cityProvince = new Map(catalog.flatMap(province => province.cities.map(city => [city.code, province.code])))

function scorePeriods(unixSeconds) {
  const date = new Date((Math.floor(unixSeconds) + BEIJING_OFFSET_SECONDS) * 1000)
  const day = date.toISOString().split('T')[0]
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  const monday = date.toISOString().split('T')[0]
  return { day: 'day:' + day, week: 'week:' + monday, month: 'month:' + day.slice(0, -3) }
}

function periodBoard(scope, periodKey) {
  return periodKey === undefined ? scope : scope + ':' + periodKey
}

function scoreKey(board, subject) {
  const hash = createHash('sha256')
  let prefix = 't'
  if (board === 'national') prefix = 'p'
  else if (board === 'province') prefix = 's'
  else hash.update(board).update('\0')
  return prefix + hash.update(subject).digest('hex').slice(0, 31)
}

function addScore(changes, board, subject, area, distance) {
  if (!area && !distance) return
  const key = scoreKey(board, subject)
  if (!changes.has(key)) changes.set(key, { board, subject, area_units: 0, distance_units: 0 })
  const row = changes.get(key)
  row.area_units += area
  row.distance_units += distance
}

// At most the provinces touched by the track/land's bounding box need actual boundaries.
function candidateProvinces(grid, points) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const point of points) {
    const { longitude, latitude } = grid.toGeo(...point)
    west = Math.min(west, longitude)
    east = Math.max(east, longitude)
    south = Math.min(south, latitude)
    north = Math.max(north, latitude)
  }
  return catalog.filter(({ bbox }) => south <= bbox[3] && north >= bbox[1] &&
    (east - west > 180 || west <= bbox[2] && east >= bbox[0]))
}

function provinceDistances(grid, paths) {
  const totals = {}
  for (const points of paths) {
    if (points.length < 2) continue
    for (const province of candidateProvinces(grid, points)) {
      const meters = getRegion('province', province.code).trackDistance(grid, points)
      if (meters > 0) totals[province.code] = (totals[province.code] || 0) + meters
    }
  }
  return totals
}

function groupCityDistances(cities) {
  const provinces = {}
  for (const [city, meters] of Object.entries(cities)) {
    const code = cityProvince.get(city)
    if (code) provinces[code] = (provinces[code] || 0) + meters
  }
  return provinces
}

function provinceLandUnits(grid, land) {
  const totals = {}
  for (const province of candidateProvinces(grid, land.shape[0])) {
    const area = getRegion('province', province.code).landArea(grid, land)
    const units = Math.round(area * AREA_UNITS)
    if (units) totals[province.code] = units
  }
  return totals
}

function addLand(changes, grid, land, sign) {
  addScore(changes, 'national', land.owner, sign * Math.round(land.area_m2 * AREA_UNITS), 0)
  const provinces = land.province_area_units || provinceLandUnits(grid, land)
  for (const [code, units] of Object.entries(provinces)) {
    addScore(changes, 'province', code, sign * units, 0)
  }
}

function addDistance(changes, player, meters, provinces) {
  addScore(changes, 'national', player, 0, Math.round(meters * DISTANCE_UNITS))
  for (const [code, distance] of Object.entries(provinces)) {
    addScore(changes, 'province', code, 0, Math.round(distance * DISTANCE_UNITS))
  }
}

async function publishScores(tx, changes, runId, endedAt) {
  const periods = Object.values(scorePeriods(endedAt))
  const rows = []
  for (const [id, delta] of changes) {
    if (!delta.area_units && !delta.distance_units) continue
    rows.push([id, delta])
    for (const period of periods) {
      const board = periodBoard(delta.board, period)
      rows.push([scoreKey(board, delta.subject), { ...delta, board }])
    }
  }
  // Read before writing, in the same order across concurrent settlements.
  rows.sort(([a], [b]) => a.localeCompare(b))
  const reachedAt = Date.now()
  const updates = []
  for (const [id, delta] of rows) {
    const old = await tx.getScore(id)
    updates.push([id, {
      ...delta, last_run_id: runId,
      area_units: (old?.area_units || 0) + delta.area_units,
      distance_units: (old?.distance_units || 0) + delta.distance_units,
      area_reached_at: delta.area_units ? reachedAt : old?.area_reached_at ?? null,
      distance_reached_at: delta.distance_units ? reachedAt : old?.distance_reached_at ?? null
    }])
  }
  for (const [id, row] of updates) await tx.setScore(id, row)
}

module.exports = {
  scoreKey, scorePeriods, periodBoard, AREA_UNITS, DISTANCE_UNITS, provinceDistances, groupCityDistances, provinceLandUnits,
  addLand, addDistance, publishScores
}

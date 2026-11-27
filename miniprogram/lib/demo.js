const { labelClearance } = require('./relief-geometry')
const { pace } = require('./run-format')
const { Grid, insidePoint } = require('./generated/geometry')
const grid = new Grid()

const routes = {
  a: [
    [38, 58],
    [118, 33],
    [185, 52],
    [165, 94],
    [199, 132],
    [152, 177],
    [83, 162],
    [43, 128],
    [38, 58]
  ],
  b: [
    [116, 47],
    [206, 27],
    [285, 54],
    [279, 112],
    [229, 100],
    [211, 159],
    [145, 137],
    [158, 91],
    [116, 47]
  ]
}
const names = { a: '甲', b: '乙' }
const kinds = { claimed: '新占', captured: '夺得', defended: '守住', failed: '未夺得' }

function time(seconds) {
  const value = Math.round(seconds)
  return Math.floor(value / 60) + ':' + ('0' + (value % 60)).slice(-2)
}
function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}
function signed(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
function onSegment(a, b, p) {
  return (
    Math.abs(signed(a, b, p)) < 1e-7 &&
    (p[0] - a[0]) * (p[0] - b[0]) <= 1e-7 &&
    (p[1] - a[1]) * (p[1] - b[1]) <= 1e-7
  )
}
function ringArea(ring) {
  let sum = 0
  for (let i = 1; i < ring.length; i++)
    sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
  return Math.abs(sum) / 2
}
function area(geometry) {
  return geometry.reduce(
    (sum, polygon) =>
      sum + polygon.reduce((part, ring, i) => part + (i === 0 ? 1 : -1) * ringArea(ring), 0),
    0
  )
}
// Stop at the last vertex outside the finish radius to replay an unfinished route.
function scenarioRoute(points, scenario) {
  if (scenario !== 'open' || points.length < 2) return points
  for (let end = points.length - 1; end > 0; end--) {
    if (distance(points[0], points[end]) > 30) return points.slice(0, end + 1)
  }
  return points
}

function samplesFor(route, pace, scenario) {
  if (!route.length) return []
  const points = [{ ...grid.toGeo(...route[0]), accuracy: 5, timestamp: 0 }]
  let timestamp = 0
  for (let i = 1; i < route.length; i++) {
    const from = route[i - 1], to = route[i]
    const seconds = distance(from, to) * pace / 1000
    const steps = Math.ceil(seconds / 5)
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps
      const x = from[0] + (to[0] - from[0]) * fraction
      const y = from[1] + (to[1] - from[1]) * fraction
      points.push({ ...grid.toGeo(x, y), accuracy: 5, timestamp: timestamp + seconds * fraction })
    }
    timestamp += seconds
  }
  if (scenario === 'gap' && points.length > 1) {
    // Keep the fixes on either side of a one-minute loss of signal.
    const resume = Math.floor(points.length / 2)
    for (let i = resume; i < points.length; i++) points[i].timestamp += 60
  }
  return points
}

function settle(territories, points, owner, pace, scenario = 'normal') {
  const ring = scenarioRoute(points, scenario)
  const samples = samplesFor(ring, pace, scenario)
  const end = samples.length ? samples[samples.length - 1].timestamp : 0
  const run = grid.analyze(0, end, samples)
  const result = {
    valid: run.valid_loop, reasons: run.reason_messages, sampleCount: run.valid_point_count,
    maxGap: run.max_gap_s, closureDistance: run.closure_distance_m,
    meters: run.distance_m, seconds: run.duration_s, size: run.area_m2, pace: run.pace_s_per_km,
    ring, owner, territories, events: []
  }
  if (!run.valid_loop) return result

  // The canvas draws MultiPolygons in metres. The service settles one Polygon per land
  // and describes each outcome in geographic coordinates.
  const lands = territories.map(land => ({
    owner: land.owner, pace_s_per_km: land.pace, shape: land.geometry[0]
  }))
  const next = grid.settle(lands, owner, result.pace, run.polygon)
  result.territories = next.lands.map(land => {
    const labelPoint = insidePoint(land.shape)
    return { owner: land.owner, pace: land.pace_s_per_km, geometry: [land.shape],
      labelPoint, labelClearance: labelClearance(land.shape, labelPoint) }
  })
  result.events = next.outcomes.map(outcome => ({
    kind: outcome.outcome, size: outcome.area_m2,
    previousOwner: outcome.previous_owner, previousPace: outcome.previous_pace_s_per_km,
    geometry: [outcome.geometry.coordinates.map(coords => coords.map(([lng, lat]) => grid.toXY(lat, lng)))]
  }))
  return result
}

// -1 outside, 0 on the edge, 1 inside; a point in an interior hole is vacant.
function ringContains(ring, p) {
  let inside = false
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1],
      b = ring[i]
    if (onSegment(a, b, p)) return 0
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside
  }
  return inside ? 1 : -1
}
function contains(geometry, p) {
  return geometry.some(
    (poly) =>
      ringContains(poly[0], p) >= 0 && poly.slice(1).every((hole) => ringContains(hole, p) <= 0)
  )
}
function explain(event, result) {
  if (event.kind === 'claimed') return '原为空地，跑回起点后首次占领。'
  if (event.kind === 'defended') return '再次圈住自己的领地，这部分保留两圈中更快的配速。'
  const prior = names[event.previousOwner] + '的守地配速 ' + pace(event.previousPace) + '/公里'
  const current = '本圈 ' + pace(result.pace) + '/公里'
  if (event.kind === 'captured')
    return current + ' 快于' + prior + '，重叠部分易主。'
  return (
    current +
    (result.pace === event.previousPace ? ' 与' : ' 慢于') +
    prior +
    (result.pace === event.previousPace ? ' 相同，' : '，') +
    '原领主守住。'
  )
}
module.exports = { routes, names, kinds, time, distance, area, contains, scenarioRoute, settle, explain }

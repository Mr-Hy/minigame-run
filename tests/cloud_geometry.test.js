const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Grid } = require('../cloudfunctions/running/geometry')
const { analyzeRunTrack } = require('../cloudfunctions/running/track')
const { routes } = require('../miniprogram/lib/demo')

const grid = new Grid(31.23, 121.47)
const square = [[0, 0], [200, 0], [200, 200], [0, 200], [0, 0]]

function samples(ring, pace = 360) {
  let timestamp = 1750000000
  const first = { ...grid.toGeo(...ring[0]), accuracy: 5, timestamp }
  const points = [first]
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.ceil(length / 20)
    for (let step = 1; step <= steps; step++) {
      const x = a[0] + (b[0] - a[0]) * step / steps, y = a[1] + (b[1] - a[1]) * step / steps
      points.push({ ...grid.toGeo(x, y), accuracy: 5, timestamp: timestamp + length * pace * step / (steps * 1000) })
    }
    timestamp += length * pace / 1000
  }
  return points
}

function analyze(points) {
  return grid.analyze(points[0].timestamp, points[points.length - 1].timestamp, points)
}

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} vs ${expected}`)
}

function viewport(left, bottom, right, top) {
  const sw = grid.toGeo(left, bottom), ne = grid.toGeo(right, top)
  return { west: sw.longitude, south: sw.latitude, east: ne.longitude, north: ne.latitude }
}

test('整圈均速超过十八公里每小时才标记配速异常，边界两侧均可正常圈地', () => {
  function finish(width) {
    const ring = [[0, 0], [width, 0], [width, 75], [0, 75], [0, 0]]
    const points = ring.map(([x, y], index) => ({ ...grid.toGeo(x, y), timestamp: 100 + index, accuracy: 3 }))
    points.push({ ...grid.toGeo(4000, 0), timestamp: 110, accuracy: 51 })
    return analyzeRunTrack(grid, 100, 160, points.reverse()).analysis
  }
  const limit = finish(75)
  approx(limit.distance_m, 300)
  assert.equal(limit.pace_anomaly, false)
  assert.equal(limit.valid_loop, true)
  assert.deepEqual(limit.reasons, [])
  const fast = finish(75.05)
  approx(fast.distance_m, 300.1)
  assert.equal(fast.pace_anomaly, true)
  assert.equal(fast.valid_loop, true)
  assert.deepEqual(fast.reasons, [])
  assert.deepEqual(fast.reason_messages, [])
  assert.equal(fast.pace_s_per_km, limit.pace_s_per_km)
  approx(fast.area_m2, 75.05 * 75)
})

test('完赛取同一时刻最精确的点；闭合线不计里程，配速包含停留', () => {
  const points = samples([...square.slice(0, 4), [0, 20]])
  const start = points[0].timestamp, end = start + 290
  const alternative = { ...points[2], accuracy: 30, latitude: 31.24 }
  const result = grid.analyze(start, end, [alternative, ...points].reverse())
  approx(result.area_m2, 40000)
  approx(result.distance_m, 780)
  assert.equal(result.pace_s_per_km, 372)
  assert.equal(result.valid_point_count, points.length)
  assert.equal(result.valid_loop, true)
})

test('纯折返不圈地，定位空档只记录时长', () => {
  const back = samples([[0, 0], [200, 0], [0, 0]])
  assert.ok(analyze(back).reasons.includes('degenerate_loop'))
  const points = samples(square)
  const start = points[0].timestamp
  const gap = points.map(p => p.timestamp > start + 20 && p.timestamp < start + 86 ? {...p, accuracy: 51} : p)
  const result = analyze(gap)
  assert.ok(result.max_gap_s >= 60)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.valid_loop, true)
})

test('两条实跑示例只争重叠斜面，同速守住，较快易主', () => {
  const a = analyze(samples(routes.a)), b = analyze(samples(routes.b, 340))
  const first = grid.settle([], 'a', a.pace_s_per_km, a.polygon)
  for (const [pace, expected] of [[340, 'captured'], [360, 'failed'], [370, 'failed']]) {
    const next = grid.settle(first.lands, 'b', pace, b.polygon)
    approx(next.outcomes.find(part => part.outcome === expected).area_m2, 3590.385165)
    approx(next.outcomes.find(part => part.outcome === 'claimed').area_m2, 9193.114835)
    approx(next.lands.reduce((sum, land) => sum + land.area_m2, 0), 25545.614835)
  }
})

test('洞内视野只包含新领主；面积、地图无洞填色片和标注点一致', () => {
  const first = grid.settle([], 'a', 360, [square])
  const inner = [[40, 40], [150, 40], [150, 150], [40, 150], [40, 40]]
  const { lands } = grid.settle(first.lands, 'b', 340, [inner])
  const outside = lands.find(land => land.owner === 'a')
  assert.equal(grid.visible(outside.shape, viewport(70, 70, 85, 85)), false)
  assert.equal(grid.visible(outside.shape, viewport(200, 200, 230, 230)), true)
  const shape = grid.describe(outside.shape)
  assert.equal(shape.geometry.coordinates.length, 2)
  const local = shape.fill_rings.map(ring => ring.map(([lng, lat]) => grid.toXY(lat, lng)))
  approx(local.reduce((sum, ring) => sum + grid.describe([ring]).area_m2, 0), 27900)
  const [x, y] = grid.toXY(shape.label_point.latitude, shape.label_point.longitude)
  assert.ok(x > 0 && x < 200 && y > 0 && y < 200)
  assert.ok(x < 40 || x > 150 || y < 40 || y > 150)
})

test('同领主同配速只合并碰边地块，端点相接保留原编号', () => {
  const first = grid.settle([], 'a', 360, [square])
  first.lands[0].id = 19
  const touching = [[200, 200], [250, 200], [250, 250], [200, 250], [200, 200]]
  const touchingResult = grid.settle(first.lands, 'a', 360, [touching])
  assert.equal(touchingResult.lands.length, 2)
  assert.ok(touchingResult.lands.includes(first.lands[0]))
  const adjacent = square.map(([x, y]) => [x + 200, y])
  const merged = grid.settle(first.lands, 'a', 360, [adjacent])
  assert.equal(merged.lands.length, 1)
  approx(merged.lands[0].area_m2, 80000)
})

test('相同的东西向经度跨度在高纬度产生更短的里程和更小的地块', () => {
  function at(latitude) {
    const ring = [[120,latitude],[120.01,latitude],[120.01,latitude + 0.001],[120,latitude + 0.001],[120,latitude]]
    const points = ring.map(([lng, lat]) => grid.toXY(lat, lng))
    return { distance: grid.measureDistance(points[0], points[1]), area: grid.measureArea([points]) }
  }
  const south = at(20), north = at(50)
  const ratio = Math.cos(50 * Math.PI / 180) / Math.cos(20 * Math.PI / 180)
  assert.ok(Math.abs(north.distance / south.distance - ratio) < 0.0001)
  assert.ok(Math.abs(north.area / south.area - ratio) < 0.0001)
})

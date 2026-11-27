'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Grid } = require('../cloudfunctions/running/geometry')
const { analyzeRunTrack } = require('../cloudfunctions/running/track')

const grid = new Grid()
const kilometer = Array.from({ length: 11 }, (_, i) => [i * 100, i * 30])

function analyze(samples) {
  const points = samples.map(([x, timestamp]) => ({ ...grid.toGeo(x, 0), accuracy: 5, timestamp }))
  return analyzeRunTrack(grid, points[0].timestamp, points.at(-1).timestamp, points)
}

test('最快一公里允许终点或起点落在两个采样点之间', () => {
  const samples = [[0, 0], [110, 44], [290, 89], [470, 134], [650, 179], [830, 224],
    [1010, 269], [1110, 319], [1210, 369], [1310, 419]]
  const outward = analyze(samples)
  assert.equal(outward.fastest_1k, 265)
  assert.equal(outward.fastest_5k, null)
  const reversed = samples.slice().reverse().map(([x, t]) => [x, 419 - t])
  assert.equal(analyze(reversed).fastest_1k, 265)
})

test('段内停留计入用时，段首出发前和段尾抵达后的停留不计', () => {
  const samples = [[0, 0], [0, 20], [100, 45], [200, 70], [300, 95], [400, 120],
    [500, 145], [500, 175], [600, 200], [700, 225], [800, 250], [900, 275], [1000, 300], [1000, 330]]
  assert.equal(analyze(samples).fastest_1k, 280)
})

test('达到五公里即可建立纪录，开放路线同样计算', () => {
  const samples = Array.from({ length: 41 }, (_, i) => [i * 125, i * 30])
  const effort = analyze(samples)
  assert.equal(effort.analysis.valid_loop, false)
  assert.equal(effort.fastest_1k, 240)
  assert.equal(effort.fastest_5k, 1200)
  assert.equal(analyze(samples.slice(0, -1)).fastest_5k, null)
})

test('六十秒及更长的定位空档照常计入整公里用时', () => {
  for (const delay of [30, 150]) {
    const samples = kilometer.map(([x, t]) => [x, x < 500 ? t : t + delay])
    const effort = analyze(samples)
    assert.equal(effort.analysis.pace_anomaly, false)
    assert.equal(effort.fastest_1k, 300 + delay)
  }
})

test('整圈配速正常时，局部高速路段计入路线、里程和最快一公里', () => {
  const samples = [...kilometer.slice(0, 5), [720, 135], ...kilometer.slice(5)]
  const effort = analyze(samples)
  assert.equal(effort.analysis.pace_anomaly, false)
  assert.equal(effort.analysis.distance_m, 1440)
  assert.deepEqual(effort.paths, [samples.map(([x]) => [x, 0])])
  assert.equal(effort.fastest_1k, 168)
})

test('全程配速异常仍按完整路线统计最快分段', () => {
  const steady = Array.from({ length: 51 }, (_, i) => [i * 100, i * 18])
  const effort = analyze([...steady, [6000, 910]])
  assert.equal(effort.analysis.pace_anomaly, true)
  assert.equal(effort.fastest_1k, 10)
  assert.equal(effort.fastest_5k, 730)
})

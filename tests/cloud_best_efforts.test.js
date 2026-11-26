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

test('不跨越满六十秒的定位中断或速度跳变，中断后的完整公里仍有效', () => {
  const gap = kilometer.map(([x, t]) => [x, x < 500 ? t : t + 30])
  const jump = kilometer.map(([x, t]) => x < 500 ? [x, t] : [x + 100, t - 29])
  for (const samples of [gap, jump]) {
    const effort = analyze(samples)
    assert.equal(effort.analysis.pace_anomaly, false)
    assert.equal(effort.fastest_1k, null)
  }
  const following = kilometer.slice(6).map(([x, t]) => [x + 500, t + 180])
  assert.equal(analyze([...gap, ...following]).fastest_1k, 300)
})

test('孤立跳点保留在整圈里程和路径中，分段用两侧连续点计时', () => {
  const samples = [...kilometer.slice(0, 5), [720, 135], ...kilometer.slice(5)]
  const effort = analyze(samples)
  assert.equal(effort.analysis.distance_m, 1440)
  assert.deepEqual(effort.paths, [samples.map(([x]) => [x, 0])])
  assert.equal(effort.fastest_1k, 300)
})

test('配速异常的运动照常计算连续分段，末尾跳变不会刷新纪录', () => {
  const steady = Array.from({ length: 51 }, (_, i) => [i * 100, i * 18])
  const effort = analyze([...steady, [6000, 910]])
  assert.equal(effort.analysis.pace_anomaly, true)
  assert.equal(effort.fastest_1k, 180)
  assert.equal(effort.fastest_5k, 900)
})

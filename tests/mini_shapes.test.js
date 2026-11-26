const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { area, contains, routes, settle } = require('../miniprogram/lib/demo')
const clip = require('../miniprogram/vendor/polygon-clipping')

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${actual} ≠ ${expected}`)
}

test('自画的三角形按斜边圈地，凹形的缺口保留为空地', () => {
  const triangle = settle([], [[0, 0], [160, 0], [15, 100], [0, 0]], 'a', 360)
  close(triangle.size, 8000)
  assert.equal(contains(triangle.territories[0].geometry, [150, 90]), false)
  const concave = settle([], [[0, 0], [200, 0], [200, 50], [70, 50], [70, 140], [0, 140], [0, 0]], 'b', 350)
  close(concave.size, 16300)
  assert.equal(contains(concave.territories[0].geometry, [120, 100]), false)
  assert.equal(contains(concave.territories[0].geometry, [60, 100]), true)
})

test('示例按交叠面积争夺，同速与慢速均由原领主守住', () => {
  const a = settle([], routes.a, 'a', 360)
  for (const [pace, kind] of [[340, 'captured'], [360, 'failed'], [370, 'failed']]) {
    const b = settle(a.territories, routes.b, 'b', pace)
    close(b.events.find(event => event.kind === kind).size, 3590.385165)
    close(b.events.find(event => event.kind === 'claimed').size, 9193.114835)
    close(b.territories.reduce((sum, part) => sum + area(part.geometry), 0), 25545.614835)
  }
})

test('乙夺地后从甲的轮廓中切除争夺区，甲按原配速重跑也无法取回', () => {
  const first = settle([], routes.a, 'a', 360)
  const captured = settle(first.territories, routes.b, 'b', 340)
  const challenge = settle(captured.territories, routes.a, 'a', 360)
  const disputedPoint = [165, 77]
  const capturedArea = captured.events.find(event => event.kind === 'captured').size
  assert.ok(contains(first.territories[0].geometry, disputedPoint))
  for (const { territories } of [captured, challenge]) {
    const a = territories.find(land => land.owner === 'a')
    const b = territories.find(land => land.owner === 'b')
    assert.deepEqual(clip.intersection(a.geometry, b.geometry), [])
    close(area(a.geometry), first.size - capturedArea)
    assert.deepEqual(territories.filter(land => contains(land.geometry, disputedPoint)).map(land => land.owner), ['b'])
  }
})

test('内圈易主后，从洞内点选能查到新领主', () => {
  const outer = [[0, 0], [200, 0], [200, 200], [0, 200], [0, 0]]
  const inner = [[45, 45], [155, 45], [145, 145], [50, 145], [45, 45]]
  const a = settle([], outer, 'a', 360)
  const b = settle(a.territories, inner, 'b', 340)
  const hits = point => b.territories.filter(t => contains(t.geometry, point)).map(t => t.owner)
  assert.deepEqual(hits([100, 100]), ['b'])
  assert.deepEqual(hits([20, 20]), ['a'])
  assert.deepEqual(hits(a.territories[0].labelPoint), ['b'])
  for (const land of b.territories) assert.deepEqual(hits(land.labelPoint), [land.owner])
})

test('测试页使用当前云函数的判定源码', () => {
  execFileSync(process.execPath, [require.resolve('../scripts/sync-demo-geometry'), '--check'])
})

test('未回起点和不足里程仍有原因，定位断点可正常结算', () => {
  const first = settle([], routes.a, 'a', 360)
  assert.equal(first.valid, true)
  assert.equal(first.pace, 360)
  const unfinished = settle(first.territories, routes.b, 'b', 340, 'open')
  assert.equal(unfinished.valid, false)
  assert.equal(unfinished.territories, first.territories)
  assert.deepEqual(unfinished.events, [])
  assert.equal(unfinished.size, 0)
  assert.ok(unfinished.closureDistance > 30)
  assert.deepEqual(unfinished.reasons, ['终点距起点超过 30 米'])
  assert.deepEqual(unfinished.ring, routes.b.slice(0, -1))
  const resumed = settle(first.territories, routes.b, 'b', 340, 'gap')
  assert.ok(resumed.maxGap >= 60)
  assert.equal(resumed.valid, true)
  assert.deepEqual(resumed.reasons, [])
  const short = settle([], [[0, 0], [10, 0], [10, 10], [0, 0]], 'a', 360)
  assert.equal(short.valid, false)
  assert.deepEqual(short.reasons, ['有效轨迹不足 300 米'])
  const open = settle([], routes.a.slice(0, -1), 'a', 360)
  assert.equal(open.valid, false)
  assert.deepEqual(open.reasons, ['终点距起点超过 30 米'])
})

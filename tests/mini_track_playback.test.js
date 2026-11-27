const test = require('node:test')
const assert = require('node:assert/strict')
const { createTrackPlayback, playbackFrame } = require('../miniprogram/lib/map')

function fix(longitude, timestamp, accuracy = 5) {
  return { latitude: 31, longitude, timestamp, accuracy }
}

test('回放用位置表示里程进度，较慢的一段占用稍长时间，完成时到达终点', () => {
  const playback = createTrackPlayback([fix(1, 0), fix(2, 10), fix(3, 50)], 0, 50)
  const start = playbackFrame(playback, 0)
  assert.equal(start.percent, 0)
  assert.deepEqual(start.lines, [])
  assert.equal(start.circles[0].longitude, 1)
  const middle = playbackFrame(playback, 0.5)
  assert.equal(middle.percent, 60)
  assert.ok(Math.abs(middle.circles[1].longitude - 2.2) < 1e-8)
  assert.deepEqual(middle.lines[0].points.at(-1), { latitude: 31, longitude: middle.circles[1].longitude })
  const finish = playbackFrame(playback, 1)
  assert.equal(finish.percent, 100)
  assert.deepEqual(finish.lines[0].points.map(p => p.longitude), [1, 2, 3])
  assert.equal(finish.circles[1].longitude, 3)
})

test('停驻和定位空档不占回放时长，两段有效轨迹独立推进', () => {
  const points = [fix(-90, -3), fix(1, 0), fix(77, 3, 51), fix(2, 10),
    fix(2, 45), fix(10, 105), fix(11, 115), fix(60, 119)]
  const playback = createTrackPlayback(points, 0, 115)
  const before = playbackFrame(playback, 0.49)
  const after = playbackFrame(playback, 0.51)
  assert.equal(before.percent, 49)
  assert.ok(Math.abs(before.circles[1].longitude - 1.98) < 1e-8)
  assert.equal(after.percent, 51)
  assert.deepEqual(after.lines[0].points.map(p => p.longitude), [1, 2])
  assert.ok(Math.abs(after.circles[1].longitude - 10.02) < 1e-8)
  assert.deepEqual(after.lines[1].points[0], { latitude: 31, longitude: 10 })
  const finish = playbackFrame(playback, 1)
  assert.deepEqual(finish.lines.map(line => line.points.map(p => p.longitude)), [[1, 2], [10, 11]])
  assert.equal(createTrackPlayback([fix(1, 1), fix(1, 2), fix(3, 62)]), null)
})

test('长轨迹与数千个断开的短段均限制回放帧大小，保留当前精确位置', () => {
  for (const gaps of [false, true]) {
    const points = Array.from({ length: 22000 }, (_, i) =>
      fix(100 + i * 0.000001, i + (gaps ? Math.floor(i / 2) * 60 : 0)))
    const playback = createTrackPlayback(points)
    const frame = playbackFrame(playback, 0.9)
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 160 * 1024)
    assert.equal(frame.percent, 90)
    assert.ok(Math.abs(frame.circles[1].longitude - 100.0198) < 0.000002)
    if (gaps) {
      for (const line of frame.lines) {
        assert.ok(line.points.at(-1).longitude - line.points[0].longitude <= 0.00000101)
      }
    }
  }
})

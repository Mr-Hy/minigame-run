const test = require('node:test')
const assert = require('node:assert/strict')
const { drawReplayFrame, prepareReplaySurface } = require('../miniprogram/lib/replay-canvas')
const { createTrackPlayback, playbackFrame } = require('../miniprogram/lib/track-playback')

function canvas() {
  const calls = []
  const ctx = { calls }
  for (const method of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke']) {
    ctx[method] = (...args) => calls.push({ method, args, style: ctx.strokeStyle, width: ctx.lineWidth })
  }
  return ctx
}

test('一帧内绘制完整的分段线和端点，跨日期变更线的视野使用就近经度', () => {
  const ctx = canvas()
  const region = { southwest: { longitude: 178, latitude: 55 }, northeast: { longitude: -178, latitude: 61 } }
  const points = [[178.5, 55, 0], [179, 58, 10], [-179.5, 59, 80], [-179, 61, 90]]
    .map(([longitude, latitude, timestamp]) => ({ longitude, latitude, timestamp, accuracy: 3 }))
  const frame = playbackFrame(createTrackPlayback(points), 1)
  assert.equal(drawReplayFrame(ctx, 400, 200, region, frame), true)
  assert.deepEqual(ctx.calls[0].args, [0, 0, 400, 200])
  assert.equal(ctx.calls.filter(c => c.method === 'clearRect').length, 1)
  const moves = ctx.calls.filter(c => c.method === 'moveTo' || c.method === 'lineTo')
  assert.deepEqual(moves.map(({ method, args }) => [method, args[0]]), [
    ['moveTo', 50], ['lineTo', 100], ['moveTo', 250], ['lineTo', 300]
  ])
  assert.equal(moves[0].args[1], 200)
  assert.ok(moves[1].args[1] > 100 && moves[1].args[1] < 110)
  assert.equal(moves[3].args[1], 0)
  const strokes = ctx.calls.filter(c => c.method === 'stroke')
  assert.deepEqual(strokes.slice(0, 4).map(c => [c.style, c.width]),
    [['#FFFDF3', 7], ['#BE542A', 5], ['#FFFDF3', 7], ['#BE542A', 5]])
  assert.ok(ctx.calls.findIndex(c => c.method === 'arc') > ctx.calls.indexOf(moves[3]))
  assert.deepEqual(ctx.calls.filter(c => c.method === 'arc').map(c => c.args.slice(0, 2)), [[50, 200], [300, 0]])
})

test('视野尚未就绪或容器为零时保留上一个画面', () => {
  const ctx = canvas()
  const region = { southwest: { longitude: 120, latitude: 30 }, northeast: { longitude: 121, latitude: 31 } }
  const frame = { lines: [], circles: [] }
  assert.equal(drawReplayFrame(ctx, 0, 400, region, frame), false)
  assert.equal(drawReplayFrame(ctx, 200, 400, null, frame), false)
  assert.equal(drawReplayFrame(ctx, 200, 400, { ...region, northeast: region.southwest }, frame), false)
  assert.deepEqual(ctx.calls, [])
})

test('读取连续稳定的原生地图视野，在 CSS 坐标系中按屏幕密度绘制', async t => {
  const previousWx = global.wx
  t.after(() => { global.wx = previousWx })
  const page = {}, scales = []
  const canvas = { getContext() { return { scale(x, y) { scales.push([x, y]) } } } }
  const node = { node: canvas, width: 300, height: 180 }
  const from = { southwest: { longitude: 100, latitude: 10 }, northeast: { longitude: 110, latitude: 20 } }
  const to = { southwest: { longitude: 105, latitude: 13 }, northeast: { longitude: 107, latitude: 15 } }
  let reads = 0
  const map = { getRegion({ success }) { success(++reads === 1 ? from : to) } }
  const query = { in(p) { assert.equal(page, p); return this }, select(s) { assert.equal(s, '#walk-replay-canvas'); return this },
    fields() { return this }, exec(done) { done([node]) } }
  global.wx = { nextTick: queueMicrotask, createMapContext: () => map, createSelectorQuery: () => query,
    getWindowInfo: () => ({ pixelRatio: 2 }) }
  const surface = await prepareReplaySurface(page, () => true)
  assert.equal(surface.mapContext, map)
  assert.equal(surface.region, to)
  assert.equal(reads, 3)
  assert.deepEqual([canvas.width, canvas.height], [600, 360])
  assert.deepEqual(scales, [[2, 2]])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { territoryLayers, pickTerritorySurface, territoryAt, outcomeLayers } = require('../miniprogram/lib/map')
const { ownTerritory } = require('../miniprogram/lib/territory-theme')

const scale = 256 * 2 ** 17
const north = latitude => Math.asinh(Math.tan(latitude * Math.PI / 180)) / (2 * Math.PI)
function at(x, y) {
  return { longitude: 121.47 + x * 360 / scale,
    latitude: Math.atan(Math.sinh((north(31.23) + y / scale) * 2 * Math.PI)) * 180 / Math.PI }
}
function ring(xys) { return xys.map(([x, y]) => { const p = at(x, y); return [p.longitude, p.latitude] }) }
function rect(l, b, r, t) { return ring([[l,b], [r,b], [r,t], [l,t], [l,b]]) }
function land(owner, rings, anchor) {
  return { owner, geometry: { type: 'Polygon', coordinates: rings }, label_point: at(...anchor), area_m2: 500 }
}
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`) }

test('原生浮起顶面遮住邻地，侧壁还原到真实边界，旁边领地保持原轮廓', () => {
  const a = land('me', [rect(0, 0, 80, 80)], [40,40])
  const b = land('other', [rect(0, 80, 80, 160)], [40,120])
  const lands = [a, b], original = structuredClone(lands)
  const flat = territoryLayers(lands, 'me', null, scale)
  const raised = territoryLayers(lands, 'me', a, scale)
  const pick = (x, y) => pickTerritorySurface(lands, raised.relief, at(x, y))
  near(raised.relief.height, 9)
  assert.equal(territoryAt(lands, at(30, 86)), b)
  const top = pick(30, 86)
  assert.equal(top.land, a)
  near(top.point.latitude, at(30, 77).latitude)
  const front = pick(30, 4)
  assert.equal(front.land, a)
  near(front.point.latitude, at(30, 0).latitude)
  assert.deepEqual(pick(30, 120), { land: b, point: at(30,120) })
  assert.deepEqual(pick(-20, 30), { land: null, point: at(-20,30) })
  assert.deepEqual(raised.polygons[0], flat.polygons[1])
  assert.deepEqual(raised.lines[0], flat.lines[1])
  // At the centre only the top is painted, even if the native map ignores zIndex.
  const covering = raised.polygons.filter(({ points }) => {
    const ring = [...points, points[0]].map(p => [p.longitude, p.latitude])
    return territoryAt([{ geometry: { coordinates: [ring] } }], a.label_point)
  })
  assert.deepEqual(covering, [raised.polygons[raised.polygons.length - 1]])
  assert.deepEqual(lands, original)
})

test('洞口保留，抬起的洞缘和可见侧壁优先于洞内地块，凹形缺口可点选空地', () => {
  const hole = rect(40, 40, 80, 80)
  const frame = land('me', [rect(0,0,120,120), [...hole].reverse()], [20,60])
  frame.fill_rings = [rect(0,0,120,40), rect(0,80,120,120), rect(0,40,40,80), rect(80,40,120,80)]
  const inside = land('other', [hole], [60,60])
  const lands = [inside, frame]
  const { relief, polygons } = territoryLayers(lands, '', frame, scale)
  const pick = (x,y) => pickTerritorySurface(lands, relief, at(x,y))
  assert.equal(pick(60,45).land, frame)
  const face = pick(60,84)
  assert.equal(face.land, frame)
  near(face.point.latitude, at(60,80).latitude)
  assert.equal(pick(60,60).land, inside)
  const topDepth = Math.max(...polygons.map(p => p.zIndex))
  const topPieces = polygons.filter(p => p.zIndex === topDepth).map(({ points }) => ({
    geometry: { coordinates: [[...points, points[0]].map(p => [p.longitude, p.latitude])] }
  }))
  assert.equal(topPieces.length, 4)
  assert.equal(territoryAt(topPieces, at(60,60)), null)

  const concave = land('me', [ring([[0,0],[80,0],[80,20],[24,20],[24,80],[0,80],[0,0]])], [12,40])
  const l = territoryLayers([concave], 'me', concave, scale).relief
  assert.equal(pickTerritorySurface([concave], l, at(40,45)).land, null)
  assert.equal(pickTerritorySurface([concave], l, at(10,84)).land, concave)
})

test('缩放保持九个地图像素高度，狭小地块按实际宽度降低高度', () => {
  const wide = land('me', [rect(0,0,200,200)], [100,100])
  for (const width of [scale / 2, scale, scale * 2]) {
    const { relief } = territoryLayers([wide], 'me', wide, width)
    const anchor = relief.liftedPoint(wide.label_point)
    near((north(anchor.latitude) - north(wide.label_point.latitude)) * width, 9)
    near(anchor.longitude, wide.label_point.longitude)
    for (const [longitude, latitude] of wide.geometry.coordinates[0]) {
      assert.equal(pickTerritorySurface([wide], relief, relief.liftedPoint({ longitude, latitude })).land, wide)
    }
  }
  const tiny = land('other', [rect(0,0,4,60)], [2,30])
  near(territoryLayers([tiny], 'me', tiny, scale).relief.height, 1)
})

test('实地与结算都按地块归属着色，失地战报不会误用本人的颜色', () => {
  const mine = { ...land('me', [rect(0,0,100,100)], [50,50]), outcome: 'captured' }
  const other = { ...land('other', [rect(100,0,200,100)], [150,50]), outcome: 'failed' }
  const flat = territoryLayers([mine, other], 'me', null, scale)
  const raised = territoryLayers([mine, other], 'me', mine, scale)
  const result = outcomeLayers([mine, other], 'captured', null, 'me')
  assert.ok(flat.polygons[0].fillColor.startsWith(ownTerritory.base))
  assert.equal(flat.polygons[0].fillColor, result.polygons[0].fillColor)
  assert.equal(raised.polygons.at(-1).fillColor, ownTerritory.base)
  assert.notEqual(flat.polygons[0].fillColor, flat.polygons[1].fillColor)
  assert.notEqual(outcomeLayers([mine], 'captured').polygons[0].fillColor, result.polygons[0].fillColor)
})

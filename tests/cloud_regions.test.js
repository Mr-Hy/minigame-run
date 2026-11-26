const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRegions } = require('../cloudfunctions/running/regions')

const grid = {
  toXY: (lat, lng) => [lng, lat],
  toGeo: (x, y) => ({ longitude: x, latitude: y }),
  measureDistance: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  planarArea(shape) {
    return shape.reduce((total, ring, i) => {
      const twice = ring.slice(1).reduce((sum, [x, y], j) => sum + ring[j][0] * y - x * ring[j][1], 0)
      return total + Math.abs(twice) / 2 * (i ? -1 : 1)
    }, 0)
  }
}
function rectangle(x, y, x2, y2) {
  return [[x,y], [x2,y], [x2,y2], [x,y2], [x,y]]
}
const enclave = rectangle(1, 1, 2, 3)
const catalog = [
  { code: '10', bbox: [0, 0, 8, 4], cities: [{code:'11'}, {code:'12'}] },
  { code: '20', bbox: [1, 0, 12, 4], cities: [{code:'21'}] }
]
const shapes = {
  '10': [{ code:'11', polygons:[[rectangle(0, 0, 4, 4), enclave]] }, {code:'12', polygons:[[rectangle(4, 0, 8, 4)]]}],
  '20': [{ code:'21', polygons:[[rectangle(8, 0, 12, 4)], [enclave]] }]
}
const { getRegion: region, distanceByCity } = createRegions(catalog, code => shapes[code])
const west = region('city', '11'), middle = region('city', '12'), east = region('city', '21')
const province = region('province', '10')
const other = region('province', '20')

test('跨界路线按经过的区间拆分，计入飞地、排除洞，相邻省市分别守恒', () => {
  const route = [[-2,2], [14,2]]
  const distance = r => r.trackDistance(grid, route)
  assert.deepEqual([west, middle, east, province, other].map(distance), [3, 4, 5, 7, 5])
  assert.equal(province.trackDistance(grid, [[-2,6], [14,6]]), 0)
  assert.equal(province.trackDistance(grid, [[0,0], [0,0]]), 0)
  assert.equal(province.trackDistance(grid, [[179,2], [-179,2]]), 0)
  assert.equal(province.landArea(grid, { shape:[rectangle(179,1,-179,3)], area_m2:4 }), 0)
})

test('沿市界、省界、外边界来回跑只结算给一侧，经过边界端点也正确拆分', () => {
  for (const [x, expected] of [[4, [4,0,0]], [8, [0,4,0]], [12, [0,0,4]]]) {
    const run = [[x,-1], [x,5]]
    for (const route of [run, run.slice().reverse()]) {
      const distances = [west,middle,east].map(r => r.trackDistance(grid,route))
      assert.deepEqual(distances, expected)
      assert.equal(province.trackDistance(grid, route) + other.trackDistance(grid, route), 4)
    }
  }
})

test('按当前地块及洞裁剪，省市分摊沿用整块已结算面积', () => {
  const holding = { shape: [rectangle(-1,0,13,4), rectangle(5,1,6,3)], area_m2: 108 }
  // 多包含境外两个宽度单位的面积，持有得分是平面面积的两倍。
  const actual = [west, middle, east, province, other].map(r => r.landArea(grid, holding))
  assert.deepEqual(actual, [28,28,36,56,36])
  assert.equal(west.landArea(grid, {shape:[rectangle(0.1,0.1,0.2,0.2)], area_m2:123}), 123)
  assert.equal(west.landArea(grid, {shape:[rectangle(1.1,1.1,1.2,1.2)], area_m2:123}), 0)
  assert.equal(west.landArea(grid, {shape:[rectangle(4,1,5,3)], area_m2:123}), 0)
  assert.equal(region('province', '11'), null)
  assert.equal(region('city', '10'), null)
})

test('连续沿界跨过第三个城市时，按交会点切换唯一的归属城市', () => {
  // A 的直边未在 B/C 的交界点增加冗余顶点。
  const { getRegion: division } = createRegions([{ code:'P', bbox:[0,0,4,4], cities:[{code:'A2'}, {code:'A1'}, {code:'A3'}] }],
    () => [{ code:'A2', polygons:[[rectangle(0,0,2,4)]] }, {code:'A1', polygons:[[rectangle(2,0,4,2)]]},
      {code:'A3', polygons:[[rectangle(2,2,4,4)]]}])
  const forward = [[2,0],[2,4]]
  for (const route of [forward, forward.slice().reverse()]) {
    const values = ['A1','A2','A3'].map(code => division('city',code).trackDistance(grid,route))
    assert.deepEqual(values, [2,2,0])
    assert.equal(division('province','P').trackDistance(grid,route), 4)
  }
})

test('完赛保存的分市里程可直接还原实时省市成绩，不读取远处省份的边界', () => {
  const route = [[-2,2], [14,2], [8,2], [8,4]]
  const totals = distanceByCity(grid, route)
  assert.deepEqual(totals, {'11':3, '12':6, '21':9})
  for (const board of [west, middle, east, province, other]) {
    assert.equal(board.distanceFromCities(totals), board.trackDistance(grid, route))
  }
  const reads = []
  const near = createRegions([...catalog, { code:'30', bbox:[90,10,95,20], cities:[{code:'31'}] }],
    code => { reads.push(code); return shapes[code] })
  assert.deepEqual(near.distanceByCity(grid, [[-70,-10],[-65,-9]]), {})
  assert.deepEqual(near.distanceByCity(grid, [[179,2],[-179,2]]), {})
  assert.deepEqual(reads, [])
  assert.deepEqual(near.distanceByCity(grid, route), totals)
  assert.deepEqual(reads.sort(), ['10','20'])
})

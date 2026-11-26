const test = require('node:test')
const assert = require('node:assert/strict')
const { heightFor, frontEdges, pickLand } = require('../miniprogram/lib/raised-land')

function rectangle(left, bottom, right, top) {
  return [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]
}

test('浮起顶面优先于后方邻地，侧壁投影回边线，空地清除选择', () => {
  const a = { geometry: [[rectangle(0, 0, 40, 40)]], labelClearance: 20 }
  const b = { geometry: [[rectangle(0, 40, 40, 80)]], labelClearance: 20 }
  const lands = [b, a]
  const pick = (selected, point) => pickLand(lands, selected, point)
  assert.equal(heightFor(a), 9)
  assert.equal(heightFor({ labelClearance: 2 }), 1)
  assert.equal(pick(null, [10, 30]).land, a)
  assert.deepEqual(pick(a, [20, 47]), { land: a, point: [20, 38] })
  assert.deepEqual(pick(a, [20, 3]), { land: a, point: [20, 0] })
  assert.deepEqual(pick(a, [20, 60]), { land: b, point: [20, 60] })
  assert.deepEqual(pick(b, [20, 20]), { land: a, point: [20, 20] })
  assert.deepEqual(pick(a, [50, 20]), { land: null, point: [50, 20] })
})

test('带洞地块的顶面、洞口侧壁和洞内其他领地均可分别点选', () => {
  const hole = rectangle(30, 30, 70, 70)
  const frame = { geometry: [[rectangle(0, 0, 100, 100), [...hole].reverse()]], labelClearance: 20 }
  const island = { geometry: [[hole]], labelClearance: 20 }
  const pick = point => pickLand([island, frame], frame, point)
  assert.deepEqual(frontEdges(frame), [
    { a: [30, 70], b: [70, 70] }, { a: [0, 0], b: [100, 0] }
  ])
  assert.deepEqual(pick([50, 34]), { land: frame, point: [50, 25] })
  assert.deepEqual(pick([50, 74]), { land: frame, point: [50, 70] })
  assert.deepEqual(pick([50, 50]), { land: island, point: [50, 50] })
})

test('长度不同的斜侧壁重叠时，点中在前方的边', () => {
  const near = [[0, 0], [100, 100], [99, 102], [-1, 2], [0, 0]]
  const far = [[1, 5], [5, 9], [5, 10], [1, 6], [1, 5]]
  const land = { geometry: [[near], [far]], labelClearance: 20 }
  const walls = frontEdges(land)
  assert.ok(walls.findIndex(w => w.a === far[0]) < walls.findIndex(w => w.a === near[0]))
  assert.deepEqual(pickLand([land], land, [3, 8]), { land, point: [3, 3] })
})

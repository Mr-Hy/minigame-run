const test = require('node:test')
const assert = require('node:assert/strict')
const { buildLandIndex, updateLandIndex, queryLandIndex, compareOrder } = require('../cloudfunctions/running/land-index')

const pack = (_, value) => ({ value }), unpack = (_, data) => data.value
const world = [[-1e7, -1e7, 1e7, 1e7]]

function repository() {
  const docs = new Map(), reads = [], writes = []
  return {
    docs, reads, writes,
    async set(key, value) {
      if (docs.has(key)) assert.deepEqual(value, docs.get(key))
      docs.set(key, structuredClone(value))
      writes.push(key)
    },
    async getMapNodes(keys) {
      reads.push(...keys)
      return new Map(keys.filter(key => docs.has(key)).map(key => [key, structuredClone(docs.get(key))]))
    }
  }
}

function land(id, x, y) {
  return {
    id, owner: 'owner-' + (id % 5), pace_s_per_km: 301, settlementOrder: [0, id],
    area_m2: 300, province_area_units: { '310000': 30000 },
    shape: [[[x, y], [x + 20, y], [x + 20, y + 15], [x, y + 15], [x, y]]]
  }
}

function checkTree(repo, root) {
  const keys = new Set(), depths = new Set()
  function visit({ key, bbox, lastOrder }, depth) {
    assert.ok(!keys.has(key), 'each immutable document occurs once per tree')
    keys.add(key)
    const data = repo.docs.get(key)
    assert.ok(data)
    if (data.value) {
      const [[x, y]] = data.value.shape[0]
      assert.deepEqual(bbox, [x, y, x + 20, y + 15])
      assert.deepEqual(lastOrder, data.value.settlementOrder)
      depths.add(depth)
      return
    }
    assert.ok(data.children.length > 0 && data.children.length <= 16)
    const boxes = data.children.map(child => child.bbox)
    assert.deepEqual(bbox, [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
      Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))])
    assert.deepEqual(lastOrder, data.children.map(c => c.lastOrder).sort(compareOrder).at(-1))
    for (const child of data.children) visit(child, depth + 1)
  }
  if (root) visit(root, 0)
  assert.ok(depths.size <= 1, 'all leaves have the same depth')
  return { keys, depth: [...depths][0] }
}

function byId(rows) {
  return [...rows].sort((a, b) => a.id - b.id)
}

test('跳过的分支给出准确的末尾顺序，并且不读取该节点', async () => {
  assert.deepEqual([[7], [2, 10], [2, 8], [2], [2, 8, 9]].sort(compareOrder),
    [[2, 8, 9], [2, 8], [2, 10], [2], [7]])
  const repo = repository()
  const lands = Array.from({length: 300}, (_, id) => land(id, id * 1000, 0))
  lands[298].settlementOrder = [5, 6]
  lands[299].settlementOrder = [5]
  const root = await buildLandIndex(repo, [], lands, pack)
  let skipped = []
  const note = ref => skipped.push(ref)
  assert.deepEqual(await queryLandIndex(repo, root, [[-10, -10, -1, -1]], unpack, note), [])
  assert.deepEqual(skipped, [root])
  assert.deepEqual(root.lastOrder, [5])
  assert.deepEqual(repo.reads, [])

  const box = [[0, 0, 1, 1]]
  skipped = []
  assert.deepEqual(await queryLandIndex(repo, root, box, unpack, note), [lands[0]])
  assert.deepEqual(skipped.map(r => r.lastOrder).sort(compareOrder).at(-1), [5])
  assert.ok(skipped.some(ref => repo.docs.get(ref.key).children))
  assert.ok(skipped.some(ref => repo.docs.get(ref.key).value))
  assert.ok(skipped.every(ref => !repo.reads.includes(ref.key)))

  const newRoot = await updateLandIndex(repo, root, [lands[299]], [], pack)
  skipped = []
  await queryLandIndex(repo, newRoot, box, unpack, note)
  assert.deepEqual(newRoot.lastOrder, [5, 6])
  assert.deepEqual(skipped.map(r => r.lastOrder).sort(compareOrder).at(-1), [5, 6])
  assert.deepEqual(root.lastOrder, [5])
})

test('局部增删保留远处子树，只写入最终根可达的文档', async () => {
  const repo = repository()
  const lands = Array.from({ length: 2048 }, (_, i) => land(i, (i % 64) * 1000, Math.floor(i / 64) * 1000))
  const oldRoot = await buildLandIndex(repo, [], lands, pack)
  const oldKeys = checkTree(repo, oldRoot).keys
  const next = land(2048, 3, 4)
  repo.reads.length = repo.writes.length = 0
  const loadedBranches = new Map(), view = [[1, 1, 18, 12]]
  const original = await queryLandIndex(repo, oldRoot, view, unpack, undefined, loadedBranches)
  const readByQuery = repo.reads.length
  assert.ok(loadedBranches.size > 0)
  assert.deepEqual(original, [lands[0]])
  const root = await updateLandIndex(repo, oldRoot, original, [next], pack, loadedBranches)
  const { keys } = checkTree(repo, root)
  assert.ok(repo.reads.length < 12 && repo.writes.length < 12, 'local work is bounded by the path through the tree')
  assert.equal(repo.reads.length, new Set(repo.reads).size)
  assert.ok(repo.reads.slice(readByQuery).every(key => repo.docs.get(key).children), 'updating the index reads only branch metadata')
  assert.ok(repo.writes.every(key => keys.has(key) && !oldKeys.has(key)))
  assert.equal(repo.writes.filter(key => repo.docs.get(key).value).length, 1)
  assert.deepEqual(await queryLandIndex(repo, oldRoot, view, unpack), [lands[0]])
  assert.deepEqual(await queryLandIndex(repo, root, view, unpack), [next])
  repo.reads.length = repo.writes.length = 0
  const unchanged = await updateLandIndex(repo, root, [next], [structuredClone(next)], pack)
  assert.equal(unchanged, root)
  assert.deepEqual(repo.reads, [])
  assert.deepEqual(repo.writes, [])
})

test('空树逐步升层，删除空分支后根能降回单块和空树', async () => {
  const repo = repository()
  const lands = Array.from({length: 400}, (_, i) => land(i, i, i % 7))
  const root = await updateLandIndex(repo, null, [], lands, pack)
  const tree = checkTree(repo, root)
  assert.ok(tree.depth >= 3)
  assert.deepEqual(new Set(repo.writes), tree.keys, 'transient splits were never persisted')
  const [single, ...deleted] = lands
  const leaf = await updateLandIndex(repo, root, deleted, [], pack)
  assert.equal(checkTree(repo, leaf).depth, 0)
  assert.deepEqual(await queryLandIndex(repo, leaf, world, unpack), [single])
  assert.equal(await updateLandIndex(repo, leaf, [single], [], pack), null)
  assert.deepEqual(byId(await queryLandIndex(repo, root, world, unpack)), lands)
  repo.writes.length = 0
  await assert.rejects(updateLandIndex(repo, leaf, [deleted[0]], [land(500, 50, 50)], pack),
    { code: 'storage_unavailable' })
  assert.deepEqual(repo.writes, [])
})

test('重叠地块随机批量增删、投影字段变更与全量结果一致', async () => {
  let seed = 20261202
  function random(limit) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % limit
  }
  let nextId = 0
  const create = () => land(nextId++, random(70), random(65))
  let live = Array.from({ length: 140 }, create)
  const repo = repository()
  let root = await buildLandIndex(repo, [], live, pack)
  for (let step = 0; step < 20; step++) {
    const prior = root, before = [...live]
    const removed = []
    for (let i = 0; i < 11; i++) removed.push(...live.splice(random(live.length), 1))
    const modified = { ...removed[0], settlementOrder: [step + 1, 1], area_m2: 301,
      province_area_units: { '310000': 30100 } }
    const additions = [modified, ...Array.from({ length: 12 }, create)]
    repo.writes.length = 0
    root = await updateLandIndex(repo, root, removed, additions, pack)
    live = live.concat(additions)
    const { keys } = checkTree(repo, root)
    assert.ok(repo.writes.every(key => keys.has(key)))
    assert.deepEqual(byId(await queryLandIndex(repo, prior, world, unpack)), byId(before))
    assert.deepEqual(byId(await queryLandIndex(repo, root, world, unpack)), byId(live))
    const x = random(70), y = random(65), box = [x, y, x + 10, y + 10]
    const expected = live.filter(row => {
      const [left, bottom] = row.shape[0][0]
      return left <= box[2] && bottom <= box[3] && left + 20 >= x && bottom + 15 >= y
    })
    assert.deepEqual(byId(await queryLandIndex(repo, root, [box], unpack)), byId(expected))
  }
})

'use strict'

const { createHash } = require('node:crypto')
const { bounds } = require('./geometry')

const FANOUT = 16
const IO_BATCH = 8
const LAND_PREFIX = 't'
const NODE_PREFIX = 'i'

function contentKey(prefix, value) {
  return prefix + createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 31)
}

function landPayload(land) {
  const { id, owner, pace_s_per_km, shape } = land
  const payload = { id, owner, pace_s_per_km, shape }
  for (const field of ['settlementOrder', 'area_m2', 'province_area_units']) {
    if (land[field] !== undefined) payload[field] = land[field]
  }
  return payload
}

function landRef(payload) {
  return indexRef(bounds(payload.shape), contentKey(LAND_PREFIX, payload), payload.settlementOrder)
}

// A split piece precedes its parent if the two keys have the same prefix.
function compareOrder(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return b.length - a.length
}

function lastChildOrder(children) {
  let last
  for (const { lastOrder } of children) {
    if (lastOrder && (!last || compareOrder(lastOrder, last) > 0)) last = lastOrder
  }
  return last
}

function indexRef(bbox, key, lastOrder) {
  return lastOrder ? { bbox, key, lastOrder } : { bbox, key }
}

function storageError() {
  return Object.assign(new Error('暂时无法读取完整的地图数据'), { status: 503, code: 'storage_unavailable' })
}

function enclosingBox(children) {
  const bbox = children[0].bbox.slice()
  for (const child of children) {
    const [left, bottom, right, top] = child.bbox
    bbox[0] = Math.min(bbox[0], left)
    bbox[1] = Math.min(bbox[1], bottom)
    bbox[2] = Math.max(bbox[2], right)
    bbox[3] = Math.max(bbox[3], top)
  }
  return bbox
}

function byCenter(axis) {
  return (a, b) => (a.bbox[axis] + a.bbox[axis + 2]) - (b.bbox[axis] + b.bbox[axis + 2]) ||
    a.key.localeCompare(b.key)
}

// Pack each level in vertical slices, then by height within each slice (STR).
function buildTree(lands, landRefs, record) {
  let level = lands.map(land => {
    const payload = landPayload(land)
    let ref = landRefs.get(land)
    if (!ref) {
      ref = landRef(payload)
      landRefs.set(land, ref)
    }
    record(ref.key, payload)
    return ref
  })
  while (level.length > 1) {
    const next = []
    const sliceSize = FANOUT * Math.ceil(Math.sqrt(Math.ceil(level.length / FANOUT)))
    level.sort(byCenter(0))
    for (let x = 0; x < level.length; x += sliceSize) {
      const slice = level.slice(x, x + sliceSize).sort(byCenter(1))
      for (let y = 0; y < slice.length; y += FANOUT) {
        const children = slice.slice(y, y + FANOUT)
        const node = { children }
        const key = contentKey(NODE_PREFIX, node)
        record(key, node)
        next.push(indexRef(enclosingBox(children), key, lastChildOrder(children)))
      }
    }
    level = next
  }
  return level[0] || null
}

async function forEachBatch(items, work) {
  for (let i = 0; i < items.length; i += IO_BATCH) {
    await Promise.all(items.slice(i, i + IO_BATCH).map(work))
  }
}

async function writeDocuments(repo, pending, pack) {
  await forEachBatch([...pending], async ([key, value]) => {
    await repo.set(key, key.startsWith(LAND_PREFIX) ? await pack(repo, value) : value)
  })
}

async function buildLandIndex(repo, previousLands, lands, pack) {
  const landRefs = new WeakMap()
  const published = new Set()
  buildTree(previousLands, landRefs, key => published.add(key))
  const pending = new Map()
  const root = buildTree(lands, landRefs, (key, value) => {
    if (!published.has(key)) pending.set(key, value)
  })
  // Only the caller's map transaction publishes the new root after these writes.
  await writeDocuments(repo, pending, pack)
  return root
}

function isLand(ref) {
  return ref.key?.startsWith(LAND_PREFIX)
}

function containsBox(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

function branch(children) {
  return { bbox: enclosingBox(children), children }
}

// Choose the existing branch that needs the least extra area. Smaller boxes win ties.
function insertionBranch(children, box) {
  let best = 0, leastGrowth = Infinity, smallestArea = Infinity
  for (let i = 0; i < children.length; i++) {
    const [left, bottom, right, top] = children[i].bbox
    const area = (right - left) * (top - bottom)
    const width = Math.max(right, box[2]) - Math.min(left, box[0])
    const height = Math.max(top, box[3]) - Math.min(bottom, box[1])
    const growth = width * height - area
    if (growth < leastGrowth || (growth === leastGrowth && area < smallestArea)) {
      best = i
      leastGrowth = growth
      smallestArea = area
    }
  }
  return best
}

function splitBranch(children) {
  const node = branch(children)
  if (children.length <= FANOUT) return [node]
  const [left, bottom, right, top] = node.bbox
  const axis = right - left >= top - bottom ? 0 : 1
  children.sort((a, b) => (a.bbox[axis] + a.bbox[axis + 2]) - (b.bbox[axis] + b.bbox[axis + 2]))
  const middle = Math.floor(children.length / 2)
  return [branch(children.slice(0, middle)), branch(children.slice(middle))]
}

async function updateLandIndex(repo, root, removedLands, addedLands, pack, loadedBranches = new Map()) {
  const removed = new Map(), additions = new Map(), pending = new Map()
  for (const land of removedLands) {
    const ref = landRef(landPayload(land))
    removed.set(ref.key, ref)
  }
  for (const land of addedLands) {
    const payload = landPayload(land)
    const ref = landRef(payload)
    additions.set(ref.key, ref)
    pending.set(ref.key, payload)
  }
  for (const key of additions.keys()) {
    if (removed.delete(key)) {
      additions.delete(key)
      pending.delete(key)
    }
  }
  if (!removed.size && !additions.size) return root

  // Published nodes have keys. Edited nodes hold their children in memory until
  // the whole delta is applied, so intermediate splits never enter the database.
  async function loadBranches(refs) {
    const keys = refs.map(ref => ref.key).filter(key => key && !loadedBranches.has(key))
    if (!keys.length) return
    const docs = await repo.getMapNodes(keys)
    for (const key of keys) {
      const children = docs.get(key)?.children
      if (!children?.length) throw storageError()
      loadedBranches.set(key, children)
    }
  }

  async function childrenOf(ref) {
    if (ref.children) return ref.children
    await loadBranches([ref])
    return loadedBranches.get(ref.key)
  }

  async function remove(ref, candidates) {
    if (isLand(ref)) return removed.delete(ref.key) ? null : ref
    const children = await childrenOf(ref)
    const targets = new Map()
    for (const child of children) {
      if (isLand(child)) continue
      const inside = candidates.filter(item => containsBox(child.bbox, item.bbox))
      if (inside.length) targets.set(child, inside)
    }
    await loadBranches([...targets.keys()])
    const retained = []
    let changed = false
    for (const child of children) {
      let next = child
      if (isLand(child)) {
        if (removed.delete(child.key)) next = null
      } else if (targets.has(child)) {
        next = await remove(child, targets.get(child))
      }
      if (next !== child) changed = true
      if (next) retained.push(next)
    }
    if (!changed) return ref
    return retained.length ? branch(retained) : null
  }

  async function insert(node, addition) {
    const children = (await childrenOf(node)).slice()
    if (isLand(children[0])) children.push(addition)
    else {
      const i = insertionBranch(children, addition.bbox)
      const replacements = await insert(children[i], addition)
      children.splice(i, 1, ...replacements)
    }
    return splitBranch(children)
  }

  if (removed.size) {
    if (root) root = await remove(root, [...removed.values()])
    if (removed.size) throw storageError()
    // Unary internal nodes keep all siblings at the same depth. Only the root
    // can discard its last level while preserving that invariant.
    while (root && !isLand(root)) {
      const children = await childrenOf(root)
      if (children.length !== 1) break
      root = children[0]
    }
  }
  for (const addition of additions.values()) {
    if (!root) root = addition
    else if (isLand(root)) root = branch([root, addition])
    else {
      const replacements = await insert(root, addition)
      root = replacements.length === 1 ? replacements[0] : branch(replacements)
    }
  }

  function freeze(ref) {
    if (!ref || ref.key) return ref
    const children = ref.children.map(freeze)
    const node = { children }
    const key = contentKey(NODE_PREFIX, node)
    if (!loadedBranches.has(key)) pending.set(key, node)
    return indexRef(ref.bbox, key, lastChildOrder(children))
  }
  const result = freeze(root)
  await writeDocuments(repo, pending, pack)
  return result
}

async function queryLandIndex(repo, root, boxes, unpack, onSkipped, loadedBranches) {
  function matches(ref) {
    const [left, bottom, right, top] = ref.bbox
    if (boxes.some(box => left <= box[2] && right >= box[0] && bottom <= box[3] && top >= box[1])) return true
    onSkipped?.(ref)
    return false
  }

  const lands = []
  let level = root && matches(root) ? [root] : []
  while (level.length) {
    const next = []
    for (let i = 0; i < level.length; i += FANOUT) {
      const keys = level.slice(i, i + FANOUT).map(ref => ref.key)
      const nodes = await repo.getMapNodes(keys)
      if (nodes.size !== keys.length) {
        throw storageError()
      }
      await forEachBatch(keys, async key => {
        const data = nodes.get(key)
        if (key.startsWith(LAND_PREFIX)) lands.push(await unpack(repo, data))
        else {
          loadedBranches?.set(key, data.children)
          next.push(...data.children.filter(matches))
        }
      })
    }
    level = next
  }
  return lands
}

module.exports = { buildLandIndex, updateLandIndex, queryLandIndex, compareOrder }

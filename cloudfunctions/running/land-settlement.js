'use strict'

const { bounds } = require('./geometry')
const { compareOrder, queryLandIndex, updateLandIndex } = require('./land-index')
const { addLand, provinceLandUnits } = require('./score-totals')

async function settleInBounds(repo, grid, map, regions, player, pace, scores, pack, unpack) {
  let lastUnmoved
  function rememberOrder(order) {
    if (!lastUnmoved || compareOrder(order, lastUnmoved) > 0) lastUnmoved = order
  }
  const branches = new Map()
  const lands = await queryLandIndex(repo, map.viewRoot, regions.map(bounds), unpack, ref => rememberOrder(ref.lastOrder), branches)
  lands.sort((a, b) => compareOrder(a.settlementOrder, b.settlementOrder))
  const placements = new Map()
  let settled = lands
  const outcomes = []
  for (const region of regions) {
    const changes = new Map()
    const result = grid.settle(settled, player, pace, region, changes)
    settled = result.lands
    for (const outcome of result.outcomes) outcomes.push(outcome)
    // A parcel split by several regions still belongs to the same original index entry.
    for (const [land, source] of changes) {
      placements.set(land, placements.has(source) ? placements.get(source) : source)
    }
  }
  const retained = new Set(settled.filter(land => land.id != null))
  const removed = lands.filter(land => !retained.has(land))
  const moved = lands.filter(land => retained.has(land) && placements.has(land))
  for (const land of retained) {
    if (!placements.has(land)) rememberOrder(land.settlementOrder)
  }
  const holdings = new Map()
  // A same-pace defence can move a retained land to the end of the settlement
  // sequence. If these lands already form its suffix, the old map was unchanged.
  if (!removed.length && retained.size === settled.length &&
      (!moved.length || !lastUnmoved || compareOrder(moved[0].settlementOrder, lastUnmoved) > 0)) {
    return { outcomes, holdings }
  }

  function accountLand(land, sign) {
    const change = holdings.get(land.owner) || { count: 0, area: 0 }
    change.count += sign
    change.area += sign * land.area_m2
    holdings.set(land.owner, change)
    addLand(scores, grid, land, sign)
  }

  const revision = map.revision + 1
  let nextId = map.next_id
  const lastPiece = new Map()
  for (const land of settled) {
    const source = placements.get(land)
    if (source) lastPiece.set(source, land)
  }
  const added = []
  for (const [i, land] of settled.entries()) {
    if (!placements.has(land)) continue
    const source = placements.get(land)
    let order = [revision, i]
    if (source) {
      // Split pieces stay where their parent was scanned. The last piece can
      // reuse the parent's key because compareOrder puts descendants first.
      order = lastPiece.get(source) === land ? source.settlementOrder : [...source.settlementOrder, revision, i]
    }
    const updated = { ...land, settlementOrder: order }
    if (land.id == null) {
      updated.id = nextId++
      updated.province_area_units = provinceLandUnits(grid, updated)
      accountLand(updated, 1)
    }
    added.push(updated)
  }
  for (const land of removed) accountLand(land, -1)
  const viewRoot = await updateLandIndex(repo, map.viewRoot, [...removed, ...moved], added, pack, branches)
  const nextMap = { origin: map.origin, next_id: nextId, revision, viewRevision: revision, settlementRevision: revision, viewRoot }
  return { outcomes, holdings, nextMap }
}

module.exports = { settleInBounds }

'use strict'

const { enclosedRegions } = require('./enclosed-regions')
const EPSILON_M = 1e-6

// Between samples the time at a distance is linear. A fastest window must
// therefore have a sampled start or end. Scan both cases in distance order.
function fastestFromAnchors(path, offset) {
  const total = path[path.length - 1].distance
  let best = Infinity, match = 0
  for (const anchor of path) {
    const target = anchor.distance + offset
    if (target < -EPSILON_M) continue
    if (target > total + EPSILON_M) break
    while (path[match].distance < target - EPSILON_M) match++
    const next = path[match]
    let time
    if (next.distance <= target + EPSILON_M) {
      // A stop at the end of a window finishes on arrival; a window
      // starting at the stop can begin on departure.
      time = offset > 0 ? next.arrival : next.departure
    } else {
      const prev = path[match - 1]
      const fraction = (target - prev.distance) / (next.distance - prev.distance)
      time = prev.departure + fraction * (next.arrival - prev.departure)
    }
    best = Math.min(best, offset > 0 ? time - anchor.departure : anchor.arrival - time)
  }
  return best
}

function fastestEffort(path, distance) {
  if (!path.length || path[path.length - 1].distance < distance - EPSILON_M) return null
  return Math.round(Math.min(fastestFromAnchors(path, distance), fastestFromAnchors(path, -distance)))
}

function timedPath(grid, fixes, route) {
  const start = fixes[0].timestamp
  const path = [{ distance: 0, arrival: start, departure: start }]
  for (let i = 1; i < fixes.length; i++) {
    const time = fixes[i].timestamp
    const leg = grid.measureDistance(route[i - 1], route[i])
    const last = path[path.length - 1]
    if (leg === 0) last.departure = time
    else path.push({ distance: last.distance + leg, arrival: time, departure: time })
  }
  return path
}

function analyzeRunTrack(grid, start, end, points) {
  const fixes = grid.validFixes(start, end, points)
  const { polygon, ...analysis } = grid.analyzeFixes(start, end, fixes)
  const route = fixes.map(p => grid.toXY(p.latitude, p.longitude))
  let regions = polygon ? [polygon] : []
  if (!polygon && !analysis.reasons.includes('distance_too_short')) {
    // Preserve the usual closing segment only when the finish is near the start.
    // Longer open tracks may still contain one or more completed loops.
    const boundary = analysis.reasons.includes('finish_too_far') ? route : [...route, route[0]]
    regions = enclosedRegions(boundary)
    analysis.area_m2 = regions.reduce((sum, region) => sum + grid.measureArea(region), 0)
    analysis.valid_loop = regions.length > 0
    analysis.reasons = regions.length ? [] : ['no_enclosed_area']
    analysis.reason_messages = regions.length ? [] : ['轨迹没有围出面积']
  }
  const path = analysis.distance_m < 1000 - EPSILON_M ? [] : timedPath(grid, fixes, route)
  return { analysis, regions, paths: route.length ? [route] : [],
    fastest_1k: fastestEffort(path, 1000), fastest_5k: fastestEffort(path, 5000) }
}

module.exports = { analyzeRunTrack }

'use strict'

const MAX_EFFORT_SPEED_M_PER_S = 12
const MAX_EFFORT_GAP_SECONDS = 60
const EPSILON_M = 1e-6

function speedJump(a, b, meters) {
  const seconds = b.timestamp - a.timestamp
  return meters > MAX_EFFORT_SPEED_M_PER_S * seconds + a.accuracy + b.accuracy + EPSILON_M
}

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

function fastestEffort(paths, distance) {
  let best = Infinity
  for (const path of paths) {
    if (path[path.length - 1].distance < distance - EPSILON_M) continue
    best = Math.min(best, fastestFromAnchors(path, distance), fastestFromAnchors(path, -distance))
  }
  return Number.isFinite(best) ? Math.round(best) : null
}

// Split records need continuous timed samples, even when the full route is usable.
function continuousEffortPaths(grid, fixes, xy) {
  const paths = []
  let path, previous = -1
  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i]
    const prior = fixes[previous]
    let leg = null
    if (prior && fix.timestamp - prior.timestamp < MAX_EFFORT_GAP_SECONDS) {
      const length = grid.measureDistance(xy[previous], xy[i])
      if (!speedJump(prior, fix, length)) {
        leg = length
      } else {
        const next = fixes[i + 1]
        if (next && next.timestamp - prior.timestamp < MAX_EFFORT_GAP_SECONDS &&
            speedJump(fix, next, grid.measureDistance(xy[i], xy[i + 1])) &&
            !speedJump(prior, next, grid.measureDistance(xy[previous], xy[i + 1]))) {
          continue
        }
      }
    }
    if (leg === null) {
      path = [{ distance: 0, arrival: fix.timestamp, departure: fix.timestamp }]
      paths.push(path)
    } else {
      const last = path[path.length - 1]
      if (leg === 0) last.departure = fix.timestamp
      else path.push({ distance: last.distance + leg, arrival: fix.timestamp, departure: fix.timestamp })
    }
    previous = i
  }
  return paths
}

function analyzeRunTrack(grid, start, end, points) {
  const fixes = grid.validFixes(start, end, points)
  const analysis = grid.analyzeFixes(start, end, fixes)
  const route = fixes.map(p => grid.toXY(p.latitude, p.longitude))
  const effortPaths = analysis.distance_m < 1000 - EPSILON_M ? [] : continuousEffortPaths(grid, fixes, route)
  return { analysis, paths: route.length ? [route] : [],
    fastest_1k: fastestEffort(effortPaths, 1000), fastest_5k: fastestEffort(effortPaths, 5000) }
}

module.exports = { analyzeRunTrack }

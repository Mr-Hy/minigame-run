const clip = require('../../vendor/polygon-clipping')

const METERS_PER_DEGREE = Math.PI / 180 * 6371008.8
const EPSILON_M = 1e-6
const PACE_ANOMALY_THRESHOLD_M_PER_S = 5
const reasonMessages = {
  no_valid_points: '跑步期间没有精度误差在 50 米以内的定位点',
  finish_too_far: '终点距起点超过 30 米',
  distance_too_short: '有效轨迹不足 300 米',
  degenerate_loop: '轨迹折返或重叠，无法围出单一区域',
  self_intersection: '轨迹与自身相交'
}

function longitude(value) {
  return Math.abs(value) <= 180 ? value : ((value + 180) % 360 + 360) % 360 - 180
}

function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function crosses(a, b, c, d) {
  for (const axis of [0, 1]) {
    if (Math.max(a[axis], b[axis]) < Math.min(c[axis], d[axis]) ||
        Math.max(c[axis], d[axis]) < Math.min(a[axis], b[axis])) return false
  }
  return Math.sign(orientation(a, b, c)) * Math.sign(orientation(a, b, d)) <= 0 &&
    Math.sign(orientation(c, d, a)) * Math.sign(orientation(c, d, b)) <= 0
}

function ringArea(ring) {
  let twice = 0
  for (let i = 2; i < ring.length; i++) twice += orientation(ring[0], ring[i - 1], ring[i])
  return Math.abs(twice) / 2
}

function area(shape) {
  return shape.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * ringArea(ring), 0)
}

function bounds(shape) {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity
  for (const [x, y] of shape[0]) {
    left = Math.min(left, x)
    bottom = Math.min(bottom, y)
    right = Math.max(right, x)
    top = Math.max(top, y)
  }
  return [left, bottom, right, top]
}

function rectangle(left, bottom, right, top) {
  return [[[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]]
}

// Collect intersections with a horizontal scanline. Its interior spans are
// consecutive pairs under the even-odd rule, including for polygons with holes.
function crossings(shape, y) {
  const xs = []
  for (const ring of shape) {
    for (let i = 1; i < ring.length; i++) {
      const [a, b] = [ring[i - 1], ring[i]]
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
    }
  }
  return xs.sort((a, b) => a - b)
}

function insidePoint(shape) {
  const [, bottom, , top] = bounds(shape)
  const mid = (bottom + top) / 2
  let low = bottom, high = top
  for (const ring of shape) {
    for (const [, y] of ring) {
      if (y <= mid) low = Math.max(low, y)
      else high = Math.min(high, y)
    }
  }
  const y = (low + high) / 2
  const xs = crossings(shape, y)
  let widest = 0
  for (let i = 2; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > xs[widest + 1] - xs[widest]) widest = i
  }
  return [(xs[widest] + xs[widest + 1]) / 2, y]
}

function withoutHoles(shape) {
  const pieces = []
  const pending = [shape]
  while (pending.length) {
    const piece = pending.pop()
    if (piece.length === 1) {
      pieces.push(piece[0])
      continue
    }
    const [left, bottom, right, top] = bounds(piece)
    const cut = insidePoint([piece[1]])[1]
    for (const slab of [rectangle(left, bottom, right, cut), rectangle(left, cut, right, top)]) {
      for (const polygon of clip.intersection(piece, slab)) pending.push(polygon)
    }
  }
  return pieces
}

function loopProblem(ring) {
  const n = ring.length - 1
  if (n < 3) return 'degenerate_loop'
  const segments = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n], b = ring[i], c = ring[i + 1]
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
    if (dot < 0 && Math.abs(orientation(a, b, c)) <= EPSILON_M * distance(a, b)) return 'degenerate_loop'
    segments.push({ a: b, b: c, i, left: Math.min(b[0], c[0]), right: Math.max(b[0], c[0]) })
  }
  segments.sort((a, b) => a.left - b.left)
  let active = []
  for (const segment of segments) {
    active = active.filter(other => other.right >= segment.left)
    for (const other of active) {
      const separation = Math.abs(segment.i - other.i)
      if (separation !== 1 && separation !== n - 1 && crosses(segment.a, segment.b, other.a, other.b)) {
        return 'self_intersection'
      }
    }
    active.push(segment)
  }
  return ringArea(ring) > 0 ? null : 'degenerate_loop'
}

function intersectsView(shape, box) {
  const [left, bottom, right, top] = box
  const [xmin, ymin, xmax, ymax] = bounds(shape)
  if (xmax < left || xmin > right || ymax < bottom || ymin > top) return false
  const boundary = rectangle(left, bottom, right, top)[0]
  for (const ring of shape) {
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = ring[i]
      if (x >= left && x <= right && y >= bottom && y <= top) return true
      for (let j = 1; j < boundary.length; j++) {
        if (crosses(ring[i - 1], ring[i], boundary[j - 1], boundary[j])) return true
      }
    }
  }
  // Without a boundary crossing, the viewport lies completely inside or outside.
  return crossings(shape, (bottom + top) / 2).filter(x => x > (left + right) / 2).length % 2 === 1
}

class Grid {
  constructor(latitude = 31.23, longitude = 121.47) {
    if (!(latitude > -90 && latitude < 90 && longitude >= -180 && longitude <= 180)) {
      throw new Error('invalid grid origin')
    }
    this.origin = { latitude, longitude }
    this.lngScale = METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180)
  }

  toXY(latitude, lng) {
    const x = longitude(lng - this.origin.longitude) * this.lngScale
    const y = (latitude - this.origin.latitude) * METERS_PER_DEGREE
    return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]
  }

  toGeo(x, y) {
    return { latitude: this.origin.latitude + y / METERS_PER_DEGREE,
      longitude: longitude(this.origin.longitude + x / this.lngScale) }
  }

  defaultBounds() {
    const sw = this.toGeo(-750, -750), ne = this.toGeo(750, 750)
    return { west: sw.longitude, south: sw.latitude, east: ne.longitude, north: ne.latitude }
  }

  viewportBoxes({ west, south, east, north }) {
    const [left, bottom] = this.toXY(south, west)
    const [right, top] = this.toXY(north, east)
    const limit = this.lngScale * 180
    if (east - west === 360) return [[-limit, bottom, limit, top]]
    if (left > right) {
      return [[left, bottom, limit, top], [-limit, bottom, right, top]]
    }
    return [[left, bottom, right, top]]
  }

  visible(shape, viewport, boxes = this.viewportBoxes(viewport)) {
    return boxes.some(box => intersectsView(shape, box))
  }

  // XY is the common frame for intersecting shapes. Convert its east-west axis
  // to local metres on a nearby standard parallel (within 0.005 degrees).
  localScale(y) {
    const latitude = Math.min(90, Math.max(-90, this.origin.latitude + Math.round(y / METERS_PER_DEGREE * 100) / 100))
    return METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180) / this.lngScale
  }

  measureDistance(a, b) {
    return Math.hypot((b[0] - a[0]) * this.localScale((a[1] + b[1]) / 2), b[1] - a[1])
  }

  planarArea(shape) {
    return area(shape)
  }

  measureArea(shape) {
    const [, bottom, , top] = bounds(shape)
    return area(shape) * this.localScale((bottom + top) / 2)
  }

  validFixes(start, end, points) {
    const samples = new Map()
    for (const p of points) {
      if (p.timestamp < start || p.timestamp > end || p.accuracy < 0 || p.accuracy > 50) continue
      const old = samples.get(p.timestamp)
      if (!old || p.accuracy < old.accuracy || (p.accuracy === old.accuracy &&
          (p.latitude < old.latitude || (p.latitude === old.latitude && p.longitude < old.longitude)))) {
        samples.set(p.timestamp, p)
      }
    }
    return Array.from(samples.values()).sort((a, b) => a.timestamp - b.timestamp)
  }

  analyze(start, end, points) {
    return this.analyzeFixes(start, end, this.validFixes(start, end, points))
  }

  analyzeFixes(start, end, samples) {
    const ring = []
    let previousTime = start, maxGap = 0, meters = 0
    for (const sample of samples) {
      const t = sample.timestamp
      maxGap = Math.max(maxGap, t - previousTime)
      previousTime = t
      const point = this.toXY(sample.latitude, sample.longitude)
      if (ring.length) meters += this.measureDistance(ring[ring.length - 1], point)
      if (!ring.length || distance(ring[ring.length - 1], point) > 0) ring.push(point)
    }
    maxGap = Math.max(maxGap, end - previousTime)
    const closure = ring.length ? this.measureDistance(ring[0], ring[ring.length - 1]) : null
    const reasons = []
    if (!samples.length) reasons.push('no_valid_points')
    const duration = end - start
    if (closure !== null && closure > 30 + EPSILON_M) reasons.push('finish_too_far')
    if (meters < 300 - EPSILON_M) reasons.push('distance_too_short')
    let polygon = null
    if (!reasons.length) {
      if (closure > 0 || ring.length === 1) ring.push(ring[0])
      const issue = loopProblem(ring)
      if (issue) reasons.push(issue)
      else polygon = [ring]
    }
    return { distance_m: meters, duration_s: duration, pace_s_per_km: meters ? Math.round(duration * 1000 / meters) : null,
      pace_anomaly: meters > PACE_ANOMALY_THRESHOLD_M_PER_S * duration + EPSILON_M,
      valid_point_count: samples.length, max_gap_s: maxGap, closure_distance_m: closure,
      valid_loop: !reasons.length, reasons, reason_messages: reasons.map(r => reasonMessages[r]),
      area_m2: polygon ? this.measureArea(polygon) : 0, polygon }
  }

  describe(shape) {
    const geoRing = ring => ring.map(([x, y]) => {
      const p = this.toGeo(x, y)
      return [p.longitude, p.latitude]
    })
    const result = { area_m2: this.measureArea(shape), geometry: { type: 'Polygon', coordinates: shape.map(geoRing) },
      label_point: this.toGeo(...insidePoint(shape)) }
    if (shape.length > 1) result.fill_rings = withoutHoles(shape).map(geoRing)
    return result
  }

  settle(lands, player, pace, loop, placements) {
    const remaining = [], acquisitions = [], occupied = [], sameScore = []
    const events = new Map()
    const [left, bottom, right, top] = bounds(loop)
    const record = (outcome, previousOwner, oldPace, owner, score, parts) => {
      const key = JSON.stringify([outcome, previousOwner, oldPace, owner, score])
      if (!events.has(key)) events.set(key, { info: {outcome, previous_owner: previousOwner,
        previous_pace_s_per_km: oldPace, owner, pace_s_per_km: score}, parts: [] })
      for (const part of parts) events.get(key).parts.push(part)
    }
    const addLand = (owner, score, shape, source) => {
      const land = { owner, pace_s_per_km: score, shape, area_m2: this.measureArea(shape) }
      remaining.push(land)
      if (placements) placements.set(land, source)
    }
    for (const land of lands) {
      const { owner, pace_s_per_km: score, shape } = land
      const [xmin, ymin, xmax, ymax] = bounds(shape)
      if (xmin > right || ymin > top || xmax < left || ymax < bottom) {
        remaining.push(land)
        continue
      }
      const overlap = clip.intersection(loop, shape)
      const own = owner === player, wins = pace < score
      if (overlap.length) {
        occupied.push(shape)
        record(own ? 'defended' : wins ? 'captured' : 'failed', owner, score,
          wins ? player : owner, Math.min(score, pace), overlap)
        if (wins) {
          for (const part of clip.difference(shape, loop)) addLand(owner, score, part, land)
          for (const part of overlap) acquisitions.push(part)
          continue
        }
      }
      if (own && pace === score) sameScore.push(land)
      else remaining.push(land)
    }
    const empty = clip.difference(loop, ...occupied)
    if (empty.length) {
      record('claimed', null, null, player, pace, empty)
      for (const part of empty) acquisitions.push(part)
    }
    let acquired = acquisitions.length ? clip.union(acquisitions) : []
    for (const land of sameScore) {
      if (acquired.length) {
        const merged = clip.union(acquired, land.shape)
        // Sharing a boundary segment merges components; touching at one vertex does not.
        if (merged.length < acquired.length + 1) {
          acquired = merged
          continue
        }
      }
      remaining.push(land)
      if (placements) placements.set(land, null)
    }
    for (const part of acquired) addLand(player, pace, part)
    const outcomes = []
    for (const { info, parts } of events.values()) {
      for (const shape of clip.union(parts)) {
        outcomes.push({ ...info, ...this.describe(shape) })
      }
    }
    return { lands: remaining, outcomes }
  }
}

module.exports = { Grid, insidePoint, bounds }

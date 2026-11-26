'use strict'

const { readFileSync } = require('node:fs')
const path = require('node:path')
const { gunzipSync } = require('node:zlib')
const clip = require('polygon-clipping')

// At most a few micrometres: Grid stores XY rounded to a micrometre.
const EPS = 3e-11
const BLOCK_EDGES = 32

function bounds(points, start = 0, end = points.length - 1) {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity
  for (let i = start; i <= end; i++) {
    const [x, y] = points[i]
    left = Math.min(left, x)
    bottom = Math.min(bottom, y)
    right = Math.max(right, x)
    top = Math.max(top, y)
  }
  return [left, bottom, right, top]
}

function overlaps(a, b) {
  return a[0] <= b[2] + EPS && a[2] >= b[0] - EPS && a[1] <= b[3] + EPS && a[3] >= b[1] - EPS
}

function prepare(shape) {
  // Neighbouring vertices on an administrative outline are usually close.
  // Reject whole runs of edges before testing a runner's short GPS segment.
  const blocks = []
  for (const ring of shape) {
    for (let start = 0; start + 1 < ring.length; start += BLOCK_EDGES) {
      const end = Math.min(start + BLOCK_EDGES, ring.length - 1)
      blocks.push({ ring, start, end, box: bounds(ring, start, end) })
    }
  }
  return { shape, box: bounds(shape[0]), blocks }
}

function crossesBox(a, b, box) {
  return Math.min(a[0], b[0]) <= box[2] + EPS && Math.max(a[0], b[0]) >= box[0] - EPS &&
    Math.min(a[1], b[1]) <= box[3] + EPS && Math.max(a[1], b[1]) >= box[1] - EPS
}

// Calling visit() can stop the scan by returning true.
function someEdge(polygon, box, visit) {
  for (const { box: blockBox, ring, start, end } of polygon.blocks) {
    if (!overlaps(blockBox, box)) continue
    for (let i = start; i < end; i++) {
      const a = ring[i], b = ring[i + 1]
      if (crossesBox(a, b, box) && visit(a, b)) return true
    }
  }
  return false
}

function pointRelation(polygon, [x, y]) {
  if (!overlaps(polygon.box, [x, y, x, y])) return 'outside'
  let inside = false
  const boundary = someEdge(polygon, [x, y, polygon.box[2], y], (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const cross = dx * (y - a[1]) - dy * (x - a[0])
    if (Math.abs(cross) <= EPS * (Math.abs(dx) + Math.abs(dy)) && crossesBox(a, b, [x, y, x, y])) return true
    if ((a[1] > y) !== (b[1] > y) && (dy > 0 ? cross > 0 : cross < 0)) inside = !inside
    return false
  })
  if (boundary) return 'boundary'
  return inside ? 'inside' : 'outside'
}

function addCuts(cuts, start, dx, dy, c, d) {
  const ex = d[0] - c[0], ey = d[1] - c[1]
  const cx = c[0] - start[0], cy = c[1] - start[1]
  const denom = dx * ey - dy * ex
  const tolerance = EPS * (Math.abs(dx) + Math.abs(dy))
  if (Math.abs(cx * dy - cy * dx) <= tolerance && Math.abs((cx + ex) * dy - (cy + ey) * dx) <= tolerance) {
    // A neighbouring city's border can start or stop halfway along this edge.
    const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1
    const delta = axis === 0 ? dx : dy
    const t0 = (c[axis] - start[axis]) / delta
    const t1 = (d[axis] - start[axis]) / delta
    if (Math.min(1, Math.max(t0, t1)) <= Math.max(0, Math.min(t0, t1))) return false
    if (t0 > 0 && t0 < 1) cuts.push(t0)
    if (t1 > 0 && t1 < 1) cuts.push(t1)
    return true
  }
  if (Math.abs(denom) <= Number.EPSILON * 8 * (Math.abs(dx * ey) + Math.abs(dy * ex))) return false
  const t = (cx * ey - cy * ex) / denom
  const u = (cx * dy - cy * dx) / denom
  if (t > 0 && t < 1 && u >= -1e-12 && u <= 1 + 1e-12) cuts.push(t)
  return false
}

function geo(grid, point) {
  const { longitude, latitude } = grid.toGeo(...point)
  return [longitude, latitude]
}

function createRegions(catalog, readProvince) {
  const provinces = new Map(catalog.map(p => [p.code, p]))
  const parents = new Map(catalog.flatMap(p => p.cities.map(city => [city.code, p])))
  const cache = new Map()
  function polygons(province) {
    if (!cache.has(province.code)) {
      const parts = []
      for (const city of readProvince(province.code)) {
        for (const shape of city.polygons) parts.push({ city: city.code, ...prepare(shape) })
      }
      if (cache.size >= 3) cache.delete(cache.keys().next().value)
      cache.set(province.code, parts)
    }
    return cache.get(province.code)
  }

  // Only a GPS segment lying along a border needs to consult its neighbours.
  // Give coincident boundaries to one city, independently of route direction.
  function adjacentParts(box) {
    const parts = []
    for (const province of catalog) {
      if (province.bbox && !overlaps(province.bbox, box)) continue
      for (const part of polygons(province)) {
        if (overlaps(part.box, box)) parts.push(part)
      }
    }
    return parts
  }

  function borderOwner(point, neighbours) {
    let owner = null
    for (const part of neighbours || adjacentParts([...point, ...point])) {
      if ((!owner || part.city < owner) && pointRelation(part, point) !== 'outside') owner = part.city
    }
    return owner
  }

  function getRegion(scope, code) {
    const province = scope === 'province' ? provinces.get(code) : scope === 'city' ? parents.get(code) : null
    if (!province) return null
    const selected = new Set(scope === 'city' ? [code] : province.cities.map(city => city.code))
    const regionBox = scope === 'city' ? province.cities.find(city => city.code === code).bbox || province.bbox : province.bbox
    const centerLng = province.bbox ? (province.bbox[0] + province.bbox[2]) / 2 : 105
    let parts
    function candidates(box) {
      if (regionBox && !overlaps(regionBox, box)) return []
      if (!parts) parts = polygons(province).filter(part => selected.has(part.city))
      return parts.filter(part => overlaps(part.box, box))
    }

    function landArea(grid, land) {
      // Keep a date-line crossing loop continuous when converting stored XY to longitude.
      const firstLng = geo(grid, land.shape[0][0])[0]
      const anchor = firstLng + 360 * Math.round((centerLng - firstLng) / 360)
      const shape = land.shape.map(ring => ring.map(point => {
        const [lng, lat] = geo(grid, point)
        return [lng + 360 * Math.round((anchor - lng) / 360), lat]
      }))
      const box = bounds(shape[0])
      const pieces = []
      for (const part of candidates(box)) {
        if (!someEdge(part, box, () => true)) {
          if (pointRelation(part, shape[0][0]) === 'inside') return land.area_m2
        } else {
          for (const piece of clip.intersection(shape, part.shape)) pieces.push(piece)
        }
      }
      if (!pieces.length) return 0
      const merged = pieces.length === 1 ? pieces : clip.union(pieces)
      let clippedArea = 0
      for (const piece of merged) {
        clippedArea += grid.planarArea(piece.map(ring => ring.map(([lng, lat]) => grid.toXY(lat, lng))))
      }
      const original = grid.planarArea(land.shape)
      return original > 0 ? land.area_m2 * Math.min(1, clippedArea / original) : 0
    }

    function segmentFraction(start, end) {
      if (Math.abs(end[0] - start[0]) > 180) {
        const lng = end[0] + (start[0] > end[0] ? 360 : -360)
        const shift = 360 * Math.round((centerLng - (start[0] + lng) / 2) / 360)
        start = [start[0] + shift, start[1]]
        end = [lng + shift, end[1]]
      }
      const dx = end[0] - start[0], dy = end[1] - start[1]
      if (!dx && !dy) return 0
      const box = bounds([start, end])
      const nearby = candidates(box)
      if (!nearby.length) return 0
      const cuts = [0, 1]
      let alongBorder = false, neighbours
      for (const part of nearby) {
        someEdge(part, box, (c, d) => { if (addCuts(cuts, start, dx, dy, c, d)) alongBorder = true })
      }
      if (alongBorder) {
        neighbours = adjacentParts(box)
        for (const part of neighbours) {
          if (!selected.has(part.city)) someEdge(part, box, (c, d) => { addCuts(cuts, start, dx, dy, c, d) })
        }
      }
      cuts.sort((a, b) => a - b)
      let fraction = 0
      for (let j = 1; j < cuts.length; j++) {
        const span = cuts[j] - cuts[j - 1]
        if (span <= 1e-13) continue
        const mid = cuts[j - 1] + span / 2
        const point = [start[0] + dx * mid, start[1] + dy * mid]
        let onBorder = false
        const inside = nearby.some(part => {
          const relation = pointRelation(part, point)
          if (relation === 'boundary') onBorder = true
          return relation === 'inside'
        })
        if (inside || (onBorder && selected.has(borderOwner(point, neighbours)))) fraction += span
      }
      return Math.min(1, fraction)
    }

    function trackDistance(grid, points) {
      if (points.length < 2) return 0
      let meters = 0, start = geo(grid, points[0])
      for (let i = 1; i < points.length; i++) {
        const end = geo(grid, points[i])
        const fraction = segmentFraction(start, end)
        if (fraction) meters += grid.measureDistance(points[i - 1], points[i]) * fraction
        start = end
      }
      return meters
    }
    function distanceFromCities(totals) {
      if (scope === 'city') return totals[code] || 0
      let meters = 0
      for (const city of selected) meters += totals[city] || 0
      return meters
    }
    return { scope, code, landArea, trackDistance, distanceFromCities }
  }

  function distanceByCity(grid, points) {
    const totals = {}
    if (points.length < 2) return totals
    const box = bounds(points.map(point => geo(grid, point)))
    // A date-line crossing has two longitude intervals. Let each city's
    // segment check choose the continuous chart before it loads boundaries.
    if (box[2] - box[0] > 180) { box[0] = -180; box[2] = 180 }
    for (const province of catalog) {
      if (province.bbox && !overlaps(province.bbox, box)) continue
      for (const city of province.cities) {
        if (city.bbox && !overlaps(city.bbox, box)) continue
        const meters = getRegion('city', city.code).trackDistance(grid, points)
        if (meters > 0) totals[city.code] = meters
      }
    }
    return totals
  }
  return { getRegion, distanceByCity }
}

const catalog = require('./region-data/catalog.json')
const { getRegion, distanceByCity } = createRegions(catalog, code => {
  const bytes = readFileSync(path.join(__dirname, 'region-data', code + '.json.gz'))
  return JSON.parse(gunzipSync(bytes).toString('utf8'))
})

module.exports = { catalog, getRegion, distanceByCity, createRegions }

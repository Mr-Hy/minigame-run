const { heightFor, frontEdges, labelClearance, wallPoint } = require('./relief-geometry')
const { ownTerritory } = require('./territory-theme')

// 微信原生地图使用 GCJ-02 经纬度对象，GeoJSON 使用 [经度, 纬度]。
function nativePoint(coordinate) {
  return { longitude: coordinate[0], latitude: coordinate[1] }
}

function inBounds(bounds, point) {
  return point.longitude >= bounds.west && point.longitude <= bounds.east &&
    point.latitude >= bounds.south && point.latitude <= bounds.north
}

// 返回 1（环内）、0（边界）或 -1（环外）。容差仅吸收浮点运算误差。
function ringPosition(ring, x, y, tolerance) {
  let inside = false
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i]
    const dx = bx - ax, dy = by - ay
    if (!dx && !dy) continue
    const epsilon = Math.max(tolerance, Number.EPSILON * 8 * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(ax), Math.abs(ay)))
    const cross = dx * (y - ay) - dy * (x - ax)
    if (Math.abs(cross) <= epsilon * (Math.abs(dx) + Math.abs(dy)) &&
        x >= Math.min(ax, bx) - epsilon && x <= Math.max(ax, bx) + epsilon &&
        y >= Math.min(ay, by) - epsilon && y <= Math.max(ay, by) + epsilon) return 0
    if ((ay > y) !== (by > y) && x - ax < dx * ((y - ay) / dy)) inside = !inside
  }
  return inside ? 1 : -1
}

function polygonPosition(rings, x, y, tolerance = 0) {
  const outer = ringPosition(rings[0], x, y, tolerance)
  if (outer < 0) return -1
  for (let i = 1; i < rings.length; i++) {
    const hole = ringPosition(rings[i], x, y, tolerance)
    if (hole >= 0) return -hole
  }
  return outer
}

function territoryAt(territories, point, exclude) {
  let boundary = null
  for (const territory of territories) {
    if (territory === exclude) continue
    const position = polygonPosition(territory.geometry.coordinates, point.longitude, point.latitude)
    if (position < 0) continue
    if (position === 1) return territory
    if (position === 0 && !boundary) boundary = territory
  }
  return boundary
}

const mine = { fill: ownTerritory.base + 'C7', stroke: ownTerritory.base, selectedStroke: ownTerritory.dark,
  top: ownTerritory.base, walls: ['#285B47', '#204936', '#15382B'] }
const other = { fill: '#CACCCFCC', stroke: '#85888C', selectedStroke: '#6C7076',
  top: '#D3D5D7', rim: '#EEF0F1', walls: ['#A3A6A9', '#929498', '#808389'] }
const resultColors = {
  claimed: { fill: '#28765D8F', stroke: '#23644D' },
  captured: { fill: '#CF794DA3', stroke: '#9B4D29' },
  defended: { fill: '#43759D8A', stroke: '#3D6282' },
  failed: { fill: '#9C77778F', stroke: '#815757' }
}
const muted = { fill: '#7182732C', stroke: '#87998A' }
const mutedMine = { fill: ownTerritory.base + '48', stroke: '#779585' }

function layers(features, colors, selected) {
  const polygons = [], lines = []
  for (const feature of features) {
    const rings = feature.geometry.coordinates
    const color = colors(feature)
    const active = feature === selected
    // 原生 polygons 无孔洞属性。只填服务端拆好的无孔片，描边则用未经拆分的真实边界。
    const fills = rings.length === 1 ? [rings[0]] : (feature.fill_rings || [])
    for (const ring of fills) {
      polygons.push({ points: ring.slice(0, -1).map(nativePoint), fillColor: color.fill,
        strokeWidth: 0, strokeColor: '#00000000', zIndex: 1 })
    }
    for (const ring of rings) {
      lines.push({ points: ring.map(nativePoint), width: active ? 4 : 2,
        color: active ? (color.selectedStroke || '#A44922') : color.stroke, zIndex: active ? 4 : 2 })
    }
  }
  return { polygons, lines }
}

// Mercator height in fractions of the world, increasing northwards.
function mercatorY(latitude) {
  const limited = Math.max(-85.05112878, Math.min(85.05112878, latitude))
  return Math.asinh(Math.tan(limited * Math.PI / 180)) / (2 * Math.PI)
}

function makeRelief(land, scale) {
  const origin = land.label_point
  const north = mercatorY(origin.latitude)
  function project({ longitude, latitude }) {
    const delta = longitude - origin.longitude
    const dx = Math.abs(delta) <= 180 ? delta : delta - Math.sign(delta) * 360
    return [dx * scale / 360, (mercatorY(latitude) - north) * scale]
  }
  function unproject([x, y]) {
    const lng = origin.longitude + x * 360 / scale
    return { longitude: Math.abs(lng) <= 180 ? lng : lng - Math.sign(lng) * 360,
      latitude: Math.atan(Math.sinh((north + y / scale) * 2 * Math.PI)) * 180 / Math.PI }
  }
  const rings = land.geometry.coordinates.map(ring => ring.map(coord => project(nativePoint(coord))))
  const height = heightFor({ labelClearance: labelClearance(rings, [0, 0]) })
  if (!height) return null
  const walls = frontEdges({ geometry: [rings] })
  function liftedPoint(point) {
    const [x, y] = project(point)
    return unproject([x, y + height])
  }
  return { land, rings, walls, height, project, unproject, liftedPoint, tolerance: 8 * Number.EPSILON * scale }
}

function territoryLayers(territories, player, selected, viewScale) {
  const colors = t => player && t.owner === player ? mine : other
  const relief = selected?.label_point && territories.includes(selected) && Number.isFinite(viewScale) && viewScale > 0
    ? makeRelief(selected, viewScale) : null
  if (!relief) return { ...layers(territories, colors, selected), relief: null }

  const { polygons, lines } = layers(territories.filter(t => t !== selected), colors)
  const rings = selected.geometry.coordinates
  const fills = rings.length === 1 ? rings : selected.fill_rings || []
  const color = colors(selected)
  function polygon(points, fillColor, zIndex) {
    polygons.push({ points, fillColor, zIndex, strokeWidth: 0, strokeColor: '#00000000' })
  }
  const { height, unproject, liftedPoint } = relief
  let depth = 3
  for (const { a, b } of relief.walls) {
    const dy = b[1] - a[1]
    const slope = dy / Math.hypot(b[0] - a[0], dy)
    const shade = slope > 0.3 ? 2 : slope < -0.3 ? 0 : 1
    polygon([a, b, [b[0], b[1] + height], [a[0], a[1] + height]].map(unproject), color.walls[shade], depth++)
  }
  for (const ring of fills) polygon(ring.slice(0, -1).map(p => liftedPoint(nativePoint(p))), color.top, depth)
  for (const ring of rings) {
    const points = ring.map(p => liftedPoint(nativePoint(p)))
    lines.push({ points, width: 4, color: color.selectedStroke, zIndex: depth + 1 })
    if (color.rim) lines.push({ points, width: 2, color: color.rim, zIndex: depth + 2 })
  }
  return { polygons, lines, relief }
}

function pickTerritorySurface(territories, relief, point) {
  if (relief && territories.includes(relief.land)) {
    const [x, y] = relief.project(point)
    const base = [x, y - relief.height]
    if (polygonPosition(relief.rings, ...base, relief.tolerance) >= 0) {
      return { land: relief.land, point: relief.unproject(base) }
    }
    const wall = wallPoint(relief.walls, relief.height, [x, y], relief.tolerance)
    if (wall) return { land: relief.land, point: relief.unproject(wall) }
  }
  return { land: territoryAt(territories, point, relief?.land), point }
}

function outcomeLayers(outcomes, category, selected, player) {
  return layers(outcomes, region => {
    const active = region.outcome === category
    if (player && region.owner === player) return active ? mine : mutedMine
    return active ? resultColors[category] : muted
  }, selected)
}

function frame(features) {
  if (!features.length) return []
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const feature of features) {
    for (const [x, y] of feature.geometry.coordinates[0]) {
      west = Math.min(west, x); east = Math.max(east, x)
      south = Math.min(south, y); north = Math.max(north, y)
    }
  }
  const padX = Math.max((east - west) * 0.09, 0.000015)
  const padY = Math.max((north - south) * 0.09, 0.000015)
  return [{ longitude: west - padX, latitude: south - padY },
    { longitude: east + padX, latitude: north + padY }]
}

function areaText(value) {
  if (value > 0 && value < 0.01) return '<0.01 m²'
  const rounded = Number(value.toFixed(value < 1 ? 2 : value < 100 ? 1 : 0))
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' m²'
}

function trackLines(points) {
  const segments = []
  let line, previous
  for (const p of points) {
    if (p.accuracy < 0 || p.accuracy > 50) continue
    if (!line || p.timestamp - previous.timestamp >= 60) {
      line = { points: [], color: '#BE542A', width: 5, borderColor: '#FFFDF3', borderWidth: 1 }
      segments.push(line)
    }
    line.points.push({ latitude: p.latitude, longitude: p.longitude })
    previous = p
  }
  return segments.filter(segment => segment.points.length > 1)
}

function durationText(seconds) {
  const value = Math.max(0, Math.round(seconds || 0))
  return `${Math.floor(value / 60)}:${('0' + value % 60).slice(-2)}`
}

function ownerText(owner, player) {
  if (owner === player) return '我'
  if (owner === 'demo-a') return '跑者甲'
  if (owner === 'demo-b') return '跑者乙'
  return '跑友 ' + owner.slice(-6)
}

function runnerLabel(number) {
  return '跑者 #' + number
}

module.exports = { inBounds, territoryAt, territoryLayers, pickTerritorySurface, outcomeLayers, frame, areaText, trackLines, durationText, ownerText, runnerLabel }

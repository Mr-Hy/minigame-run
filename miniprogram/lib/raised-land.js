const { contains } = require('./demo')

const { heightFor, frontEdges, wallPoint } = require('./relief-geometry')

function pickLand(territories, selected, point) {
  const [x, y] = point
  if (selected && territories.includes(selected)) {
    const height = heightFor(selected)
    const ground = [x, y - height]
    if (contains(selected.geometry, ground)) return { land: selected, point: ground }
    const walls = frontEdges(selected)
    const hit = wallPoint(walls, height, point)
    if (hit) return { land: selected, point: hit }
  }
  const land = territories.find(piece => piece !== selected && contains(piece.geometry, point))
  return { land: land || null, point }
}

module.exports = { heightFor, frontEdges, pickLand }

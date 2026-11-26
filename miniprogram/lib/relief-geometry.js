function heightFor(land) {
  if (!land) return 0
  return Number.isFinite(land.labelClearance) ? Math.max(0, Math.min(9, land.labelClearance / 2)) : 9
}

function edgeY({ a, b }, x) {
  return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]))
}

function frontEdges(land) {
  const edges = []
  for (const polygon of land.geometry) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i]
        // Polygon-clipping keeps the territory to the left, including around holes.
        if (b[0] > a[0]) edges.push({ a, b })
      }
    }
  }
  edges.sort((one, two) => one.a[0] - two.a[0])
  // Only edges sharing an x range can obscure one another. Compare their depth
  // at a common x: midpoint depths alone can reverse the order of sloped walls.
  const behind = edges.map(() => 0)
  const inFront = edges.map(() => [])
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length && edges[j].a[0] < edges[i].b[0]; j++) {
      const x = (edges[j].a[0] + Math.min(edges[i].b[0], edges[j].b[0])) / 2
      const [far, near] = edgeY(edges[i], x) >= edgeY(edges[j], x) ? [i, j] : [j, i]
      inFront[far].push(near)
      behind[near]++
    }
  }
  const order = []
  for (let i = 0; i < edges.length; i++) if (!behind[i]) order.push(i)
  for (let i = 0; i < order.length; i++) {
    for (const near of inFront[order[i]]) if (--behind[near] === 0) order.push(near)
  }
  return order.map(i => edges[i])
}

// Space available around the label before it touches an outline or a hole.
function labelClearance(shape, [x, y]) {
  let nearest = Infinity
  for (const ring of shape) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], [bx, by] = ring[i]
      const dx = bx - ax, dy = by - ay
      if (!dx && !dy) continue
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
      nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy))
    }
  }
  return nearest
}

function wallPoint(walls, height, [x, y], tolerance = 0) {
  for (let i = walls.length - 1; i >= 0; i--) {
    const wall = walls[i]
    if (x < wall.a[0] - tolerance || x > wall.b[0] + tolerance) continue
    const groundX = Math.max(wall.a[0], Math.min(wall.b[0], x))
    const base = edgeY(wall, groundX)
    if (y >= base - tolerance && y <= base + height + tolerance) return [groundX, base]
  }
  return null
}

module.exports = { heightFor, frontEdges, labelClearance, wallPoint }

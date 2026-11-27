'use strict'

const jsts = require('jsts')
const clip = require('polygon-clipping')

const reader = new jsts.io.GeoJSONReader()
const writer = new jsts.io.GeoJSONWriter()

function enclosedRegions(route) {
  const coordinates = route.filter(([x, y], i) =>
    i === 0 || x !== route[i - 1][0] || y !== route[i - 1][1])
  if (coordinates.length < 4) return []

  // Node intersections and dissolve retraced edges before finding bounded faces.
  // A LineString preserves open ends. Polygonizer discards dangling and bridge edges.
  const line = reader.read({ type: 'LineString', coordinates })
  const polygonizer = new jsts.operation.polygonize.Polygonizer()
  polygonizer.add(jsts.operation.union.UnaryUnionOp.union(line))

  const faces = polygonizer.getPolygons().toArray().map(face => writer.write(face).coordinates)
  return faces.length ? clip.union(faces) : []
}

module.exports = { enclosedRegions }

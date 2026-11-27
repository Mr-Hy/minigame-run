const { Grid } = require('../../lib/generated/geometry')

const grid = new Grid(31.2163, 121.4685)
const path = [
  // East and north offsets in metres, followed by elapsed walking time in seconds.
  [-196, -66, 0], [-158, -73, 36], [-119, -75, 71], [-88, -63, 100], [-66, -39, 129], [-45, -8, 155],
  [-42, 14, 178], [-51, 35, 194], [-40, 58, 208], [-10, 70, 222], [33, 74, 240], [67, 66, 255],
  [95, 45, 279], [121, 39, 299], [150, 46, 319], [178, 72, 346]
]
const start = Date.parse('2026-11-26T08:10:00+08:00') / 1000
const points = path.map(([x, y, seconds]) => ({ ...grid.toGeo(x, y), accuracy: 6, timestamp: start + seconds }))
const end = points[points.length - 1].timestamp

module.exports = {
  points,
  result: { ...grid.analyze(start, end, points), run_id: 'temporary-walk', player_id: 'example',
    kilometer_marks: [], best_split_s_per_km: null, partial_km_duration_s: end - start,
    started_at: start, ended_at: end, outcomes: [] }
}

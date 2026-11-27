const stroke = { color: '#BE542A', width: 5, borderColor: '#FFFDF3', borderWidth: 1 }
const FRAME_SAMPLES = 384

function coordinate({ latitude, longitude }) {
  return { latitude, longitude }
}

function trackSegments(points, start = -Infinity, end = Infinity, project = coordinate) {
  const segments = []
  let line, previous
  for (const p of points) {
    if (p.accuracy < 0 || p.accuracy > 50 || p.timestamp < start || p.timestamp > end) continue
    if (!line || p.timestamp - previous.timestamp >= 60) {
      line = { ...stroke, points: [] }
      segments.push(line)
    }
    line.points.push(project(p))
    previous = p
  }
  return segments
}

function trackEnds(first, last) {
  return [
    { ...coordinate(first), radius: 9, fillColor: '#245740', color: '#FFFFFF', strokeWidth: 2 },
    { ...coordinate(last), radius: 6, fillColor: stroke.color, color: '#FFFFFF', strokeWidth: 2 }
  ]
}

// Angular distances suffice here because only their relative lengths affect the animation.
function legLength(a, b) {
  const longitudeScale = Math.cos((a.latitude + b.latitude) * Math.PI / 360)
  return Math.hypot(b.latitude - a.latitude, (b.longitude - a.longitude) * longitudeScale)
}

function createTrackPlayback(points, start, end) {
  const segments = trackSegments(points, start, end, p => p)
  const legs = []
  let total = 0, movingSeconds = 0
  for (const segment of segments) {
    for (let i = 1; i < segment.points.length; i++) {
      const from = segment.points[i - 1], to = segment.points[i]
      const length = legLength(from, to)
      if (!length) continue
      const seconds = to.timestamp - from.timestamp
      legs.push({ from, to, segment, length, traveled: total })
      total += length
      movingSeconds += seconds
    }
  }
  if (!total) return null
  const averagePace = movingSeconds / total
  let weight = 0
  for (const leg of legs) {
    const relativePace = averagePace > 0 ? (leg.to.timestamp - leg.from.timestamp) / (leg.length * averagePace) : 1
    // Keep slower stretches perceptible without making the short replay stall.
    weight += leg.length * Math.max(0.75, Math.min(1.25, relativePace))
    leg.finish = weight
  }
  const lastSegment = segments[segments.length - 1].points
  return { legs, total, weight, first: segments[0].points[0], last: lastSegment[lastSegment.length - 1],
    stride: Math.ceil(legs.length / FRAME_SAMPLES) }
}

function playbackFrame(playback, fraction) {
  const { legs, total, weight, stride, first, last } = playback
  if (fraction <= 0) return { lines: [], circles: trackEnds(first, first).slice(0, 1), percent: 0 }
  const target = Math.min(1, fraction) * weight
  let low = 0, high = legs.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (legs[middle].finish < target) low = middle + 1
    else high = middle
  }
  const active = legs[low]
  const begin = low === 0 ? 0 : legs[low - 1].finish
  const portion = (target - begin) / (active.finish - begin)
  const tip = { latitude: active.from.latitude + (active.to.latitude - active.from.latitude) * portion,
    longitude: active.from.longitude + (active.to.longitude - active.from.longitude) * portion }

  const lines = []
  let segment, line
  function appendPoint(point) {
    const tail = line.points[line.points.length - 1]
    if (tail.latitude !== point.latitude || tail.longitude !== point.longitude) line.points.push(coordinate(point))
  }
  function add(leg, point) {
    if (segment !== leg.segment) {
      if (segment) appendPoint(segment.points[segment.points.length - 1])
      segment = leg.segment
      line = { ...stroke, points: [coordinate(segment.points[0])] }
      lines.push(line)
    }
    appendPoint(point)
  }
  // Only the animated trail is sampled. Its tip and progress use every original leg.
  for (let i = 0; i < low; i += stride) add(legs[i], legs[i].to)
  add(active, active.from)
  add(active, tip)
  const percent = fraction >= 1 ? 100 : Math.min(99, Math.round(100 * (active.traveled + active.length * portion) / total))
  return { lines, circles: trackEnds(first, fraction >= 1 ? last : tip), percent }
}

module.exports = { trackSegments, trackEnds, createTrackPlayback, playbackFrame }

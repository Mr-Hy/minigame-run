const { mercatorY } = require('./map')

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137

function longitudeSpan(region) {
  const sw = region?.southwest, ne = region?.northeast
  if (!sw || !ne || ![sw.latitude, sw.longitude, ne.latitude, ne.longitude].every(Number.isFinite) ||
      Math.abs(sw.latitude) > 90 || Math.abs(ne.latitude) > 90 || mercatorY(ne.latitude) <= mercatorY(sw.latitude)) return 0
  const rawSpan = ne.longitude - sw.longitude
  const span = rawSpan < 0 ? rawSpan + 360 : rawSpan
  return span > 0 && span <= 360 ? span : 0
}

// The caller sizes the backing canvas for pixel density. All coordinates here are CSS pixels.
function drawReplayFrame(ctx, width, height, region, frame) {
  if (!ctx || !frame || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  const span = longitudeSpan(region)
  if (!span) return false
  const { southwest: sw, northeast: ne } = region
  const north = mercatorY(ne.latitude), south = mercatorY(sw.latitude)

  const center = sw.longitude + span / 2
  function project(point) {
    // Pick the nearby copy of the world when the viewport straddles the date line.
    const lng = point.longitude + 360 * Math.round((center - point.longitude) / 360)
    return [(lng - sw.longitude) * width / span, (north - mercatorY(point.latitude)) * height / (north - south)]
  }

  ctx.clearRect(0, 0, width, height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const line of frame.lines) {
    if (line.points.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(...project(line.points[0]))
    for (let i = 1; i < line.points.length; i++) ctx.lineTo(...project(line.points[i]))
    ctx.strokeStyle = line.borderColor
    ctx.lineWidth = line.width + 2 * line.borderWidth
    ctx.stroke()
    ctx.strokeStyle = line.color
    ctx.lineWidth = line.width
    ctx.stroke()
  }
  for (const circle of frame.circles) {
    const latitude = Math.min(85.05112878, Math.abs(circle.latitude))
    const metersPerPixel = EARTH_CIRCUMFERENCE_M * span / (360 * width) * Math.cos(latitude * Math.PI / 180)
    const radius = Math.max(3, circle.radius / metersPerPixel)
    const [x, y] = project(circle)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = circle.fillColor
    ctx.fill()
    ctx.lineWidth = circle.strokeWidth
    ctx.strokeStyle = circle.color
    ctx.stroke()
  }
  return true
}

function readWithin(ms, read) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    const finish = value => { clearTimeout(timer); resolve(value) }
    try { read(finish) } catch (_) { finish(null) }
  })
}

function settled(previous, current) {
  if (!previous) return false
  const dx = longitudeSpan(current) * 0.001
  const dy = (current.northeast.latitude - current.southwest.latitude) * 0.001
  return ['southwest', 'northeast'].every(key => Math.abs(previous[key].longitude - current[key].longitude) <= dx &&
    Math.abs(previous[key].latitude - current[key].latitude) <= dy)
}

async function prepareReplaySurface(page, isCurrent) {
  if (typeof wx === 'undefined' || !wx.createMapContext || !wx.createSelectorQuery || !isCurrent()) return null
  const deadline = Date.now() + 1000
  await readWithin(150, done => wx.nextTick(() => done(true)))
  if (!isCurrent()) return null
  let mapContext
  try { mapContext = wx.createMapContext('walk-route', page) } catch (_) { return null }
  if (!mapContext?.getRegion) return null
  let item, region, previous
  while (isCurrent() && Date.now() < deadline) {
    const timeout = Math.min(180, deadline - Date.now())
    const [node, viewport] = await Promise.all([
      item || readWithin(timeout, done => wx.createSelectorQuery().in(page).select('#walk-replay-canvas')
        .fields({ node: true, size: true }).exec(results => done(results?.[0]))),
      readWithin(timeout, done => mapContext.getRegion({ success: done, fail: () => done(null) }))
    ])
    if (!isCurrent()) return null
    if (node?.node && node.width > 0 && node.height > 0) item = node
    if (longitudeSpan(viewport)) {
      region = viewport
      if (item && settled(previous, region)) break
      previous = region
    } else previous = null
    await new Promise(resolve => setTimeout(resolve, Math.min(75, Math.max(0, deadline - Date.now()))))
  }
  if (!isCurrent() || !item || !region) return null
  const { node: canvas, width, height } = item
  try {
    const ratio = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(canvas.width / width, canvas.height / height)
    return { canvas, ctx, width, height, region, mapContext }
  } catch (_) { return null }
}

module.exports = { drawReplayFrame, prepareReplaySurface }

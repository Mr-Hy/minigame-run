const { kilometers, pace } = require('./run-format')
const { areaText, durationText } = require('./map')
const { drawDistanceNumber } = require('./poster-numerals')
const config = require('../config')

const WIDTH = 720
const DENSITY = 1.5
const MAX_IMAGE_HEIGHT = 4096
const MARGIN = 38
const PAPER = '#f8f5e9'
const INK = '#242783'
const BLUE = '#292e92'
const LIME = '#e7f34c'
const ROUTE_COLOR = '#edfa69'

function text(ctx, value, x, y, font, color = INK, width) {
  ctx.font = font
  ctx.fillStyle = color
  if (width) ctx.fillText(value, x, y, width)
  else ctx.fillText(value, x, y)
}

function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

function drawMasthead(ctx, date) {
  ctx.fillStyle = INK
  ctx.fillRect(MARGIN, 30, 44, 33)
  ctx.save()
  ctx.transform(1, 0, -0.42, 1, MARGIN + 13, 36)
  ctx.fillStyle = LIME
  for (let i = 0; i < 3; i++) ctx.fillRect(i * 8, 0, 4, 21)
  ctx.restore()
  text(ctx, '跑步圈地', 94, 57, 'bold 29px sans-serif')
  if (date) {
    ctx.textAlign = 'right'
    text(ctx, date, WIDTH - MARGIN, 54, 'bold 23px monospace')
    ctx.textAlign = 'left'
  }
  ctx.fillStyle = INK
  ctx.fillRect(MARGIN, 81, WIDTH - 2 * MARGIN, 2)
}

function drawRunner(ctx, runner) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(364, 84, WIDTH - 364, 282)
  ctx.clip()
  disc(ctx, 585, 222, 122, LIME)
  ctx.save()
  ctx.translate(636, 234)
  ctx.rotate(-0.38)
  ctx.scale(2.7, 1)
  ctx.lineWidth = 1
  ctx.strokeStyle = '#aaaacc'
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.arc(0, 0, 67 + i * 9, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
  if (runner) {
    const scale = Math.min(295 / runner.width, 272 / runner.height)
    const width = runner.width * scale, height = runner.height * scale
    ctx.drawImage(runner, 558 - width / 2, 90 + (272 - height) / 2, width, height)
  }
  ctx.restore()
}

function localDateTime(seconds) {
  if (!Number.isFinite(seconds)) return ''
  return new Date((seconds + 8 * 3600) * 1000).toISOString()
}

function drawHero(ctx, result, runner, numerals) {
  const start = localDateTime(result.started_at), end = localDateTime(result.ended_at)
  drawMasthead(ctx, end.slice(0, 10).replace(/-/g, '.'))
  drawRunner(ctx, runner)
  text(ctx, '本次跑步里程', MARGIN, 143, 'bold 25px sans-serif')
  const km = Number.isFinite(result.distance_m) ? kilometers(result.distance_m) : '—'
  const distanceWidth = drawDistanceNumber(ctx, numerals, km, MARGIN - 3, 286, 188, 326)
  text(ctx, 'KM', MARGIN + distanceWidth + 7, 285, 'italic bold 33px sans-serif')
  if (start || end) {
    const startTime = start.slice(11, 16), endTime = end.slice(11, 16)
    const clock = start && end ? startTime + ' — ' + endTime : (start ? '出发 ' + startTime : '完赛 ' + endTime)
    ctx.fillStyle = INK
    ctx.fillRect(MARGIN, 323, 26, 3)
    text(ctx, clock, MARGIN + 37, 331, 'bold 21px monospace')
  }
}

function routeDimensions(map) {
  if (!map?.lines.some(({ points }) => points.some(point =>
    point.latitude !== points[0].latitude || point.longitude !== points[0].longitude))) return null
  const origin = map.lines[0].points[0]
  const longitudeScale = Math.cos(origin.latitude * Math.PI / 180)
  function east(point) {
    const delta = point.longitude - origin.longitude
    return (delta - 360 * Math.round(delta / 360)) * longitudeScale
  }
  let west = Infinity, right = -Infinity, south = Infinity, north = -Infinity
  function include(point) {
    const x = east(point)
    west = Math.min(west, x)
    right = Math.max(right, x)
    south = Math.min(south, point.latitude)
    north = Math.max(north, point.latitude)
  }
  for (const { points } of map.lines) points.forEach(include)
  map.circles.forEach(include)
  return { east, width: right - west, height: north - south,
    centerX: (west + right) / 2, centerY: (south + north) / 2 }
}

function drawEndpoint(ctx, x, y, finish) {
  disc(ctx, x, y, finish ? 9 : 7, PAPER)
  disc(ctx, x, y, finish ? 6 : 4, finish ? ROUTE_COLOR : BLUE)
  if (finish) disc(ctx, x, y, 3, BLUE)
}

function drawRoute(ctx, map, dimensions, bottom, area) {
  text(ctx, '跑步轨迹', MARGIN, 423, 'bold 25px sans-serif', PAPER)
  if (area) {
    text(ctx, '闭环面积', 167, 421, '18px sans-serif', PAPER)
    text(ctx, area, 251, 421, 'bold 21px sans-serif', PAPER, 250)
  }
  drawEndpoint(ctx, 535, 415, false)
  text(ctx, '起点', 549, 422, '20px sans-serif', PAPER)
  drawEndpoint(ctx, 619, 415, true)
  text(ctx, '终点', 634, 422, '20px sans-serif', PAPER)

  const top = 445
  ctx.fillStyle = '#5c61aa'
  for (let y = top; y <= bottom - 20; y += 22) {
    for (let x = MARGIN; x <= WIDTH - MARGIN; x += 22) ctx.fillRect(x, y, 1.8, 1.8)
  }
  const scale = Math.min(584 / (dimensions.width || 1e-9), (bottom - top - 51) / (dimensions.height || 1e-9))
  const xOf = p => WIDTH / 2 + (dimensions.east(p) - dimensions.centerX) * scale
  const yOf = p => (top + bottom - 17) / 2 - (p.latitude - dimensions.centerY) * scale
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = 7
  ctx.strokeStyle = ROUTE_COLOR
  for (const { points } of map.lines) {
    ctx.beginPath()
    let lastX = xOf(points[0]), lastY = yOf(points[0])
    ctx.moveTo(lastX, lastY)
    for (let i = 1; i < points.length; i++) {
      const x = xOf(points[i]), y = yOf(points[i])
      if (i < points.length - 1 && Math.abs(x - lastX) < 1 && Math.abs(y - lastY) < 1) continue
      ctx.lineTo(x, y)
      lastX = x
      lastY = y
    }
    ctx.stroke()
  }
  // recordedTrackMap appends the start and finish after isolated GPS fixes.
  const ends = map.circles.length - 2
  map.circles.forEach((p, i) => {
    if (i < ends) disc(ctx, xOf(p), yOf(p), 3, ROUTE_COLOR)
    else drawEndpoint(ctx, xOf(p), yOf(p), i === ends + 1)
  })
}

function drawStats(ctx, result, top, height, code, dark, area) {
  const ink = dark ? PAPER : INK
  const rule = dark ? '#6669a5' : '#ceced9'
  const stats = [
    ['用时 · 分:秒', Number.isFinite(result.duration_s) ? durationText(result.duration_s) : '—'],
    ['平均配速 / 公里', pace(result.pace_s_per_km)],
    ['最快配速 / 公里', pace(result.best_split_s_per_km)]
  ]
  const stub = 539
  const stride = (stub - MARGIN) / stats.length
  const labelY = top + (area ? 47 : 64)
  stats.forEach(([label, value], i) => {
    const left = MARGIN + i * stride
    text(ctx, label, left, labelY, 'bold 20px sans-serif', ink, stride - 12)
    text(ctx, value, left - 1, labelY + 59, 'bold 44px sans-serif', ink, stride - 16)
  })
  if (area) text(ctx, '闭环面积  ' + area, MARGIN, top + 145, '21px sans-serif', ink)
  ctx.fillStyle = rule
  for (let y = top + 17; y < height - 16; y += 10) ctx.fillRect(stub + 5, y, 1.5, 5)
  ctx.textAlign = 'center'
  const middle = 619
  if (code) {
    const side = 116, x = middle - side / 2, y = top + 12
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, y, side, side)
    ctx.drawImage(code, x + 4, y + 4, side - 8, side - 8)
    text(ctx, '长按进入小程序', middle, top + 151, '18px sans-serif', ink)
  } else {
    text(ctx, '微信小程序', middle, top + 65, '20px sans-serif', ink)
    text(ctx, '跑步出圈', middle, top + 111, 'bold 28px sans-serif', ink)
  }
  ctx.textAlign = 'left'
}

function distanceScore(value) {
  return kilometers(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km'
}

function standingsLayout(standings) {
  const national = [], provinces = []
  for (const [key, label, format] of [
    ['distance', '全国总里程', distanceScore], ['area', '全国领地面积', areaText]
  ]) {
    const entry = standings?.national?.[key]
    if (entry?.rank > 0 && Number.isFinite(entry.value) && entry.value > 0) {
      national.push({ label, rank: '第' + entry.rank + '名', total: '共 ' + format(entry.value) })
    }
  }
  for (const province of standings?.provinces || []) {
    const scores = []
    for (const [key, label, format] of [
      ['distance_m', '里程', distanceScore], ['area_m2', '圈地', areaText]
    ]) {
      if (!Number.isFinite(province[key]) || province[key] <= 0) continue
      const total = province['total_' + key]
      scores.push({ label, own: format(province[key]), total: Number.isFinite(total) ? format(total) : '—' })
    }
    if (scores.length) provinces.push({ name: province.display_name, scores })
  }
  const nationalHeight = national.length ? 134 : 0
  const tableHeight = provinces.length ? 115 + provinces.reduce((height, p) => height + 14 + 32 * p.scores.length, 0) : 0
  return { national, provinces, nationalHeight, height: nationalHeight + tableHeight }
}

function drawStandings(ctx, layout, top) {
  const { national, provinces, nationalHeight } = layout
  if (national.length) {
    ctx.fillStyle = LIME
    ctx.fillRect(0, top, WIDTH, nationalHeight)
    const column = (WIDTH - 2 * MARGIN) / national.length
    national.forEach((entry, i) => {
      const x = MARGIN + i * column
      if (i) {
        ctx.fillStyle = '#aab950'
        ctx.fillRect(x - 15, top + 21, 1.5, nationalHeight - 42)
      }
      text(ctx, entry.label, x, top + 40, 'bold 21px sans-serif')
      text(ctx, entry.rank, x, top + 84, 'bold 39px sans-serif', INK, column - 25)
      text(ctx, entry.total, x, top + 113, '22px sans-serif', INK, column - 25)
    })
    top += nationalHeight
  }
  if (!provinces.length) return
  ctx.fillStyle = INK
  ctx.fillRect(MARGIN, top + 24, 24, 4)
  text(ctx, '省份贡献', MARGIN + 35, top + 37, 'bold 26px sans-serif')
  const right = WIDTH - MARGIN, personal = 434, metric = 207
  const small = 'bold 19px sans-serif'
  const muted = '#5a5980'
  text(ctx, '省份', MARGIN, top + 76, small, muted)
  text(ctx, '项目', metric, top + 76, small, muted)
  ctx.textAlign = 'right'
  text(ctx, '我本次贡献', personal, top + 76, small, muted)
  text(ctx, '全省累计', right, top + 76, small, muted)
  ctx.textAlign = 'left'
  let y = top + 90
  for (const province of provinces) {
    ctx.fillStyle = '#c7c5cf'
    ctx.fillRect(MARGIN, y, right - MARGIN, 1.5)
    y += 6
    text(ctx, province.name, MARGIN, y + 26, 'bold 21px sans-serif', INK, metric - MARGIN - 12)
    for (const score of province.scores) {
      text(ctx, score.label, metric, y + 26, '20px sans-serif', muted)
      ctx.textAlign = 'right'
      text(ctx, score.own, personal, y + 26, 'bold 22px sans-serif', INK, personal - metric - 58)
      text(ctx, score.total, right, y + 26, '22px sans-serif', INK, right - personal - 20)
      ctx.textAlign = 'left'
      y += 32
    }
    y += 8
  }
}

function loadImage(canvas, path) {
  return new Promise(resolve => {
    const image = canvas.createImage()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = path
  })
}

async function generateRunPoster(page, result, routeMap, standings) {
  const canvas = await new Promise(resolve => {
    wx.createSelectorQuery().in(page).select('#run-share-canvas').fields({ node: true })
      .exec(nodes => resolve(nodes?.[0]?.node))
  })
  if (!canvas) throw new Error('海报画布未就绪，请重试')
  const route = routeDimensions(routeMap)
  const area = result.valid_loop && Number.isFinite(result.area_m2) ? areaText(result.area_m2) : ''
  const top = route ? (route.height > route.width ? 754 : 672) : 375
  const statsBottom = top + 170
  const layout = standingsLayout(standings)
  const height = statsBottom + layout.height
  // Keep every contributing province on the poster without exceeding a 4096-pixel canvas.
  const density = Math.min(DENSITY, MAX_IMAGE_HEIGHT / height)
  canvas.width = Math.floor(WIDTH * density)
  canvas.height = Math.floor(height * density)
  const [runner, numerals, code] = await Promise.all([
    loadImage(canvas, '/assets/run-poster-runner.png'),
    loadImage(canvas, '/assets/run-poster-numerals.png'),
    config.runPosterCodePath ? loadImage(canvas, config.runPosterCodePath) : null
  ])
  const ctx = canvas.getContext('2d')
  ctx.scale(density, density)
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, WIDTH, height)
  drawHero(ctx, result, runner, numerals)

  ctx.fillStyle = BLUE
  ctx.beginPath()
  ctx.moveTo(0, 381)
  ctx.lineTo(WIDTH, 345)
  ctx.lineTo(WIDTH, route ? top : statsBottom)
  ctx.lineTo(0, route ? top : statsBottom)
  ctx.closePath()
  ctx.fill()
  if (route) drawRoute(ctx, routeMap, route, top, area)
  drawStats(ctx, result, top, statsBottom, code, !route, route ? '' : area)
  drawStandings(ctx, layout, statsBottom)
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, fileType: 'png', destWidth: canvas.width, destHeight: canvas.height,
    success: ({ tempFilePath }) => resolve(tempFilePath), fail: reject
  }, page))
}

module.exports = { generateRunPoster }

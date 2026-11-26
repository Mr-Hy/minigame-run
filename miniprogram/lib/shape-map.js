const { heightFor, frontEdges, pickLand } = require('./raised-land')
const { names } = require('./demo')
const { shortNickname } = require('./nickname')
const { ownTerritory } = require('./territory-theme')

const WIDTH = 340
const HEIGHT = 220
const PILL_HEIGHT = 18
const AVATAR_SIZE = 24
const AVATAR_OVERLAP = 4
const myFlag = { cloth: ownTerritory.base, pole: ownTerritory.dark, edge: ownTerritory.dark, porcelain: '#F4FFF6' }
const ownLand = {
  ink: ownTerritory.dark, pin: myFlag.cloth, wash: ownTerritory.base + 'D1',
  light: ownTerritory.light + 'DE', shade: ownTerritory.base + 'E3',
  hue: 155, saturation: 38, wallLight: 22
}
const otherLand = {
  ink: '#85888C', pin: '#6C7076', wash: 'rgba(202,204,207,.80)',
  light: 'rgba(227,228,230,.86)', shade: 'rgba(192,194,198,.83)',
  rim: '#EEF0F1', rimWidth: 2, hue: 215, saturation: 3, wallLight: 59
}
function paletteFor(owner) {
  return owner === 'a' ? ownLand : otherLand
}

function park(ctx) {
  ctx.fillStyle = '#e9efdc'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  function patch(color, steps) {
    ctx.beginPath()
    ctx.moveTo(steps[0][0], steps[0][1])
    steps.slice(1).forEach((step) => ctx.bezierCurveTo(...step))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  patch('#d3e2c4', [
    [-12, 8],
    [45, -10, 100, -14, 124, 3],
    [141, 18, 119, 53, 94, 55],
    [58, 59, 24, 44, -12, 65]
  ])
  patch('#dae6cc', [
    [-3, 133],
    [18, 101, 48, 120, 60, 144],
    [80, 178, 99, 181, 112, 224],
    [50, 237, 16, 228, -8, 232]
  ])
  patch('#d2e2c3', [
    [245, -5],
    [286, -13, 332, -12, 350, 3],
    [367, 18, 353, 68, 322, 68],
    [287, 65, 266, 38, 245, -5]
  ])
  patch('#d4e2c3', [
    [228, 158],
    [249, 142, 280, 145, 288, 163],
    [297, 192, 282, 208, 262, 231],
    [237, 222, 218, 181, 228, 158]
  ])
  function path(strokes, color, width) {
    ctx.beginPath()
    ctx.moveTo(strokes[0][0], strokes[0][1])
    strokes.slice(1).forEach((step) => ctx.bezierCurveTo(...step))
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  const river = [
    [356, 70],
    [318, 85, 330, 107, 317, 129],
    [306, 150, 282, 160, 298, 185],
    [313, 207, 327, 210, 321, 231]
  ]
  path(river, '#d1e0ce', 27)
  path(river, '#a5c9c3', 21)
  path(river, '#b8d9d1', 12)
  const trails = [
    [
      [-8, 86],
      [40, 86, 56, 16, 111, 23],
      [155, 27, 166, 53, 191, 57],
      [229, 67, 255, 47, 285, -4]
    ],
    [
      [-9, 178],
      [26, 155, 54, 175, 82, 150],
      [113, 123, 129, 117, 157, 131],
      [202, 153, 237, 196, 287, 188],
      [308, 184, 321, 174, 348, 178]
    ],
    [
      [12, 230],
      [26, 190, 71, 186, 83, 161],
      [104, 117, 70, 94, 87, 67],
      [99, 46, 118, 39, 128, -7]
    ],
    [
      [213, -7],
      [188, 24, 206, 42, 221, 66],
      [244, 100, 218, 109, 205, 128],
      [186, 156, 192, 197, 215, 229]
    ]
  ]
  trails.forEach((line) => {
    path(line, '#cdd3b6', 5.2)
    path(line, '#f9f6e5', 3.5)
  })
  // Small tree symbols are drawn only on the basemap and do not take part in settlement.
  ctx.fillStyle = '#b6cba7'
  ;[
    [7, 10],
    [18, 7],
    [32, 14],
    [50, 11],
    [65, 5],
    [26, 29],
    [39, 25],
    [273, 9],
    [288, 15],
    [301, 11],
    [314, 24],
    [329, 29],
    [236, 175],
    [249, 168],
    [261, 176],
    [271, 189],
    [251, 197],
    [11, 178],
    [27, 185],
    [17, 198],
    [45, 207]
  ].forEach(([x, y]) => {
    ctx.beginPath()
    ctx.arc(x, y, 2, 0, Math.PI * 2)
    ctx.fill()
  })
  ctx.fillStyle = '#809379'
  ctx.font = '8px sans-serif'
  ctx.fillText('西侧林地', 10, 47)
  ctx.fillText('中央草坪', 140, 114)
  ctx.fillText('南门', 105, 210)
  ctx.fillStyle = '#63978b'
  ctx.fillText('湖湾', 314, 155)
  ctx.fillStyle = '#466b54'
  ctx.font = 'bold 9px sans-serif'
  ctx.fillText('N', 316, 15)
  ctx.beginPath()
  ctx.moveTo(319, 18)
  ctx.lineTo(316, 27)
  ctx.lineTo(322, 27)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = '#53765d'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(12, 201)
  ctx.lineTo(12, 204)
  ctx.lineTo(62, 204)
  ctx.lineTo(62, 201)
  ctx.stroke()
  ctx.font = '8px sans-serif'
  ctx.fillText('50 m', 23, 199)
}

function pathRing(ctx, ring) {
  ring.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, HEIGHT - y)
    else ctx.lineTo(x, HEIGHT - y)
  })
}
function shapePath(ctx, geometry) {
  ctx.beginPath()
  for (const polygon of geometry) {
    for (const ring of polygon) {
      pathRing(ctx, ring)
      ctx.closePath()
    }
  }
}
function drawShape(ctx, geometry, fill, stroke) {
  shapePath(ctx, geometry)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.25
  ctx.stroke()
}
function drawRoute(ctx, ring, color, dashed) {
  if (!ring || ring.length === 0) return
  ctx.beginPath()
  pathRing(ctx, ring)
  ctx.setLineDash(dashed ? [3.5, 3] : [])
  ctx.strokeStyle = color
  ctx.lineWidth = dashed ? 1.6 : 2.7
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.setLineDash([])
}
function dot(ctx, p, radius, color, outline) {
  ctx.beginPath()
  ctx.arc(p[0], HEIGHT - p[1], radius, 0, 2 * Math.PI)
  ctx.fillStyle = color
  ctx.fill()
  if (outline) {
    ctx.strokeStyle = outline
    ctx.lineWidth = 1.6
    ctx.stroke()
  }
}
function drawMyFlag(ctx, land) {
  const scale = Math.min(1, land.labelClearance / 20)
  if (scale < 0.68) {
    const radius = Math.min(3.5, land.labelClearance * 0.8)
    dot(ctx, land.labelPoint, radius, myFlag.cloth)
    dot(ctx, land.labelPoint, radius * 0.58, myFlag.porcelain)
    return
  }
  const [x, y] = land.labelPoint
  ctx.save()
  ctx.translate(x, HEIGHT - y)
  ctx.scale(scale, scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(-10, 11)
  ctx.lineTo(-10, -12)
  ctx.strokeStyle = myFlag.porcelain
  ctx.lineWidth = 3.3
  ctx.stroke()
  ctx.strokeStyle = myFlag.pole
  ctx.lineWidth = 1.7
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(-9.9, -10.2)
  ctx.bezierCurveTo(-2, -15, 5, -7.5, 14, -11)
  ctx.lineTo(10.5, -3.5)
  ctx.lineTo(14, 3.4)
  ctx.bezierCurveTo(5, 7, -2, -0.5, -9.9, 4)
  ctx.closePath()
  ctx.strokeStyle = myFlag.porcelain
  ctx.lineWidth = 2.5
  ctx.stroke()
  ctx.fillStyle = myFlag.cloth
  ctx.fill()
  ctx.strokeStyle = myFlag.edge
  ctx.lineWidth = 0.7
  ctx.stroke()
  ctx.fillStyle = myFlag.porcelain
  ctx.font = 'bold 11px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('我', 0.6, -3.6)
  ctx.restore()
}
function territoryNickname(land) {
  return land.owner_display_name || '跑者' + (names[land.owner] || '')
}

function profileMarker(land, lift, runnerBAvatar) {
  const title = shortNickname(territoryNickname(land))
  const avatar = land.owner === 'b' && runnerBAvatar
  const avatarLead = avatar ? AVATAR_SIZE - AVATAR_OVERLAP : 0
  const pillWidth = Math.min(4, Array.from(title).length) * 11 + 14
  const width = avatarLead + pillWidth
  const [x, y] = land.labelPoint
  const left = Math.max(1, Math.min(WIDTH - width - 1, x - width / 2))
  const radius = avatar ? AVATAR_SIZE / 2 : PILL_HEIGHT / 2
  const cy = Math.max(radius + 1, Math.min(HEIGHT - radius - 1, HEIGHT - y - lift - 14))
  return { title, avatar, left, cy, pillLeft: left + avatarLead, pillWidth }
}

function drawProfileMarker(ctx, { title, avatar, left, cy, pillLeft, pillWidth }) {
  const radius = PILL_HEIGHT / 2
  const right = pillLeft + pillWidth
  ctx.beginPath()
  ctx.arc(right - radius, cy, radius, -Math.PI / 2, Math.PI / 2)
  ctx.arc(pillLeft + radius, cy, radius, Math.PI / 2, Math.PI * 1.5)
  ctx.closePath()
  ctx.fillStyle = '#FFFCF5'
  ctx.fill()
  ctx.strokeStyle = '#CEC9C0'
  ctx.lineWidth = 0.8
  ctx.stroke()
  ctx.fillStyle = '#42433F'
  ctx.font = 'bold 11px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, pillLeft + pillWidth / 2 + (avatar ? 1 : 0), cy)
  if (!avatar) return

  const cx = left + AVATAR_SIZE / 2
  ctx.beginPath()
  ctx.arc(cx, cy, AVATAR_SIZE / 2, 0, Math.PI * 2)
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.save()
  const inner = AVATAR_SIZE / 2 - 1.5
  ctx.beginPath()
  ctx.arc(cx, cy, inner, 0, Math.PI * 2)
  ctx.clip()
  const side = Math.min(avatar.width, avatar.height)
  ctx.drawImage(avatar, (avatar.width - side) / 2, (avatar.height - side) / 2, side, side,
    cx - inner, cy - inner, inner * 2, inner * 2)
  ctx.restore()
}

function drawLandFlag(ctx, land, lift, runnerBAvatar) {
  ctx.save()
  if (land.owner === 'a') {
    ctx.translate(0, -lift)
    drawMyFlag(ctx, land)
  } else {
    drawProfileMarker(ctx, profileMarker(land, lift, runnerBAvatar))
  }
  ctx.restore()
}

function pickTerritory(lands, selected, point, runnerBAvatar) {
  function hitsMarker(land, lift) {
    if (!land || land.owner === 'a') return false
    const { avatar, left, cy, pillLeft, pillWidth } = profileMarker(land, lift, runnerBAvatar)
    const [x, y] = point
    const dy = HEIGHT - y - cy
    if (avatar && Math.hypot(x - left - AVATAR_SIZE / 2, dy) <= AVATAR_SIZE / 2) return true
    const radius = PILL_HEIGHT / 2
    const dx = Math.max(pillLeft + radius - x, x - (pillLeft + pillWidth - radius), 0)
    return Math.hypot(dx, dy) <= radius
  }
  if (selected && hitsMarker(selected, heightFor(selected))) return { land: selected, point: selected.labelPoint }
  for (let i = lands.length - 1; i >= 0; i--) {
    const land = lands[i]
    if (land !== selected && hitsMarker(land, 0)) return { land, point: land.labelPoint }
  }
  return pickLand(lands, selected, point)
}

function drawRaisedLand(ctx, land, height) {
  const style = paletteFor(land.owner)
  ctx.save()
  ctx.translate(2, 3)
  shapePath(ctx, land.geometry)
  ctx.fillStyle = 'rgba(54,48,32,.16)'
  ctx.shadowColor = 'rgba(48,40,24,.26)'
  ctx.shadowBlur = 5
  ctx.fill()
  ctx.restore()

  for (const { a, b } of frontEdges(land)) {
    const dy = b[1] - a[1]
    const lightness = Math.round(style.wallLight - 9 * dy / Math.hypot(b[0] - a[0], dy))
    const color = `hsl(${style.hue}, ${style.saturation}%, ${lightness}%)`
    ctx.beginPath()
    ctx.moveTo(a[0], HEIGHT - a[1])
    ctx.lineTo(b[0], HEIGHT - b[1])
    ctx.lineTo(b[0], HEIGHT - b[1] - height)
    ctx.lineTo(a[0], HEIGHT - a[1] - height)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 0.4
    ctx.stroke()
  }

  ctx.save()
  ctx.translate(0, -height)
  shapePath(ctx, land.geometry)
  ctx.save()
  ctx.clip()
  // Keep park labels aligned on both sides of the lifted outline.
  ctx.translate(0, height)
  park(ctx)
  ctx.translate(0, -height)
  const [x, y] = land.labelPoint
  const light = ctx.createLinearGradient(x - 36, HEIGHT - y - 36, x + 36, HEIGHT - y + 36)
  light.addColorStop(0, style.light)
  light.addColorStop(1, style.shade)
  ctx.fillStyle = light
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  if (style.rim) {
    shapePath(ctx, land.geometry)
    ctx.strokeStyle = style.rim
    ctx.lineWidth = style.rimWidth
    ctx.stroke()
  }
  ctx.restore()
  shapePath(ctx, land.geometry)
  ctx.strokeStyle = style.ink
  ctx.lineWidth = 1.1
  ctx.stroke()
  ctx.restore()
}
function render(ctx, state) {
  ctx.save()
  park(ctx)
  const selected = state.selection && state.selection.land
  const height = selected ? heightFor(selected) : 0
  for (const land of state.territories) {
    if (land === selected) continue
    const style = paletteFor(land.owner)
    drawShape(ctx, land.geometry, style.wash, style.ink)
  }
  if (selected) drawRaisedLand(ctx, selected, height)
  for (const land of state.territories) {
    if (land !== selected) drawLandFlag(ctx, land, 0, state.runnerBAvatar)
  }
  if (selected) drawLandFlag(ctx, selected, height, state.runnerBAvatar)
  if (state.guide) drawRoute(ctx, state.guide, '#7c8e72', true)
  if (state.draft.length) {
    const style = paletteFor(state.owner)
    drawRoute(ctx, state.draft, style.ink, false)
    dot(ctx, state.draft[0], 4, '#f9f5de', style.ink)
    if (state.draft.length > 1)
      dot(ctx, state.draft[state.draft.length - 1], 3.4, '#e17c36', '#fff6e5')
    if (state.draft.length >= 3) {
      drawRoute(ctx, [state.draft[state.draft.length - 1], state.draft[0]], '#a87944', true)
    }
  }
  if (state.selection) {
    ctx.translate(0, -height)
    const pin = selected ? paletteFor(selected.owner).pin : '#e17c36'
    dot(ctx, state.selection.point, 3.8, pin, selected ? myFlag.porcelain : '#fff6e5')
  }
  ctx.restore()
}
module.exports = { WIDTH, HEIGHT, render, pickTerritory, territoryNickname }

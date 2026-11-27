// Barlow Condensed Black Italic at 320 px/em, stored in two rows of seven cells.
const CHARACTERS = '0123456789.<—'
const CELL_WIDTH = 196
const CELL_HEIGHT = 240
const ADVANCE = [142.4, 94.08, 143.68, 140.8, 164.48, 142.4, 142.72, 135.04, 140.16, 141.44, 76.48, 135.36, 184]
const INK_RIGHT = [152, 109, 153, 157, 169, 159, 151, 154, 150, 150, 65, 145, 186]
const KERNING = { '12': 1.6, '41': -18.88, '47': -19.84, '7.': -12.8, '.0': -15.36, '.7': -12.8 }

function drawDistanceNumber(ctx, image, text, x, baseline, fontSize, maxWidth = Infinity) {
  const value = String(text)
  if (!value || fontSize <= 0 || maxWidth <= 0) return 0
  if (!image || [...value].some(c => !CHARACTERS.includes(c))) {
    ctx.save()
    ctx.font = 'italic 900 ' + fontSize + 'px sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#242783'
    const metrics = ctx.measureText(value)
    const width = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0)
    const scale = width > maxWidth ? maxWidth / width : 1
    ctx.font = 'italic 900 ' + (fontSize * scale) + 'px sans-serif'
    ctx.fillText(value, x, baseline)
    ctx.restore()
    return width * scale
  }

  let advance = 0
  let width = 0
  const glyphs = []
  for (let i = 0; i < value.length; i++) {
    const index = CHARACTERS.indexOf(value[i])
    if (i) advance += KERNING[value.slice(i - 1, i + 1)] || 0
    glyphs.push({ index, offset: advance })
    width = Math.max(width, advance + INK_RIGHT[index])
    advance += ADVANCE[index]
  }
  width = Math.max(width, advance)
  const scale = Math.min(fontSize / 320, maxWidth / width)
  for (const { index, offset } of glyphs) {
    // Each cell's typographic origin is (4, 232).
    ctx.drawImage(image, index % 7 * CELL_WIDTH, Math.floor(index / 7) * CELL_HEIGHT,
      CELL_WIDTH, CELL_HEIGHT, x + (offset - 4) * scale, baseline - 232 * scale,
      CELL_WIDTH * scale, CELL_HEIGHT * scale)
  }
  return width * scale
}

module.exports = { drawDistanceNumber }

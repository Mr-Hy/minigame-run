const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function fallbackCharacters(text) {
  const characters = []
  let joined = false, unpairedRegional = false
  for (const symbol of text) {
    const code = symbol.codePointAt(0)
    const regional = code >= 0x1F1E6 && code <= 0x1F1FF
    const modifier = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/.test(symbol) ||
      (code >= 0x1F3FB && code <= 0x1F3FF) || (code >= 0xE0020 && code <= 0xE007F) ||
      (code >= 0xE0100 && code <= 0xE01EF)
    if (characters.length && (joined || symbol === '\u200D' || modifier || (regional && unpairedRegional))) {
      characters[characters.length - 1] += symbol
    } else {
      characters.push(symbol)
    }
    joined = symbol === '\u200D'
    unpairedRegional = regional && !unpairedRegional
  }
  return characters
}

function shortNickname(name) {
  if (name.length <= 4) return name
  const characters = segmenter
    ? Array.from(segmenter.segment(name), part => part.segment)
    : fallbackCharacters(name)
  return characters.length <= 4 ? name : characters.slice(0, 3).join('') + '…'
}

module.exports = { shortNickname }

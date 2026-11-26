function kilometers(meters) {
  if (!meters) return '0'
  return meters < 5 ? '<0.01' : (meters / 1000).toFixed(2)
}

function duration(seconds) {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  if (hours) return hours + '小时' + (minutes ? minutes + '分' : '')
  if (minutes) return minutes + '分' + (total % 60 ? total % 60 + '秒' : '')
  return total + '秒'
}

module.exports = { kilometers, duration }

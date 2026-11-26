const colors = ['#f8d079', '#8cd3b5', '#ed9569', '#d3e49b', '#fff2c8']
const pieces = []
for (const side of [-1, 1]) {
  for (let i = 0; i < 12; i++) {
    const dx = -side * (17 + (i * 43) % 186)
    const dy = -(54 + (i * 31) % 112)
    const spin = side * (70 + i * 43)
    pieces.push({
      id: side + ':' + i,
      shape: ['strip', 'dot', 'curl'][i % 3],
      style: 'left:' + (side < 0 ? 15 : 85) + '%;color:' + colors[(i + (side < 0 ? 0 : 2)) % colors.length] +
        ';--dx:' + dx + 'rpx;--dy:' + dy + 'rpx;--end-x:' + dx * 1.48 + 'rpx;--spin:' + spin + 'deg' +
        ';animation-delay:' + (100 + (i % 4) * 65) + 'ms;animation-duration:' + (930 + (i % 5) * 110) + 'ms'
    })
  }
}

Component({
  properties: {
    rows: { type: Array, value: [] },
    dismissLabel: { type: String, value: '查看本次结算' }
  },
  data: { pieces },
  methods: { dismiss() { this.triggerEvent('dismiss') } }
})

const { achievementRows } = require('../../lib/achievements')

const sprint = { key: 'fastest_1k', value: 329, previous: 337 }
const distanceTier = { key: 'total_distance', threshold: 50000 }
const scenarios = [
  { key: 'pb', name: 'PB 刷新', icon: 'sprint', detail: '最快 1 公里从 5 分 37 秒缩短到 5 分 29 秒。',
    records: [sprint], milestones: [] },
  { key: 'milestone', name: '累计里程碑', icon: 'route', detail: '总里程越过 50 公里，点亮一枚里程碑勋章。',
    records: [], milestones: [distanceTier] },
  { key: 'multiple', name: '同时达成', icon: 'peak', detail: '一次跑步刷新四项个人纪录、解锁三档里程碑，可以滑动查看全部七项。',
    records: [sprint, { key: 'longest_distance', value: 12500, previous: 10000 },
      { key: 'best_week', value: 27300, previous: 25500 }, { key: 'largest_gain', value: 8200, previous: 6100 }],
    milestones: [distanceTier, { key: 'running_days', threshold: 7 }, { key: 'capture_runs', threshold: 5 }] },
  { key: 'empty', name: '无成就', icon: 'days', detail: '完成一次普通实跑，成绩尚未超过个人纪录或达到里程碑。',
    records: [], milestones: [] }
]

Page({
  data: {
    available: false, scenarios: scenarios.map(({ key, name, icon }) => ({ key, name, icon })),
    selected: scenarios[0].key, detail: scenarios[0].detail, rows: [], playing: false, emptyResult: false
  },
  onLoad() {
    const { envVersion } = wx.getAccountInfoSync().miniProgram
    if (envVersion === 'develop' || envVersion === 'trial') this.setData({ available: true })
    else wx.switchTab({ url: '/pages/me/index' })
  },
  selectScenario(event) {
    const scenario = scenarios.find(item => item.key === event.currentTarget.dataset.key)
    if (!scenario || !this.data.available) return
    this.setData({ selected: scenario.key, detail: scenario.detail, rows: [], playing: false, emptyResult: false })
  },
  play() {
    if (!this.data.available || this.data.playing) return
    const rows = achievementRows(scenarios.find(item => item.key === this.data.selected))
    this.setData({ rows, playing: rows.length > 0, emptyResult: rows.length === 0 })
  },
  dismiss() { this.setData({ playing: false, rows: [] }) }
})

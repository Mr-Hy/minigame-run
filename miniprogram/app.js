const api = require('./lib/api')
const tracker = require('./lib/tracker')

App({
  onLaunch() { api.initCloud() },
  async onShow() {
    if (!api.hasSavedLogin()) return
    try {
      await api.login()
      await tracker.restore()
    } catch (error) {
      console.warn('恢复跑步记录', error.message)
    }
  }
})

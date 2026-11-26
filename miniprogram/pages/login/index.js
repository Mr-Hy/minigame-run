const api = require('../../lib/api')

Page({
  data: { agreed: false, loading: false, avatar: '', error: '', fromRun: false },

  onLoad(options = {}) {
    this._from = options.from
    this.setData({ fromRun: options.from === 'run' })
    if (api.playerId()) this.finishLogin()
  },
  onUnload() { this._unloaded = true },

  onConsent(event) {
    this.setData({ agreed: event.detail.value.includes('privacy'), error: '' })
  },

  openPrivacy() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '请更新微信后查看隐私指引', icon: 'none' })
      return
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '隐私指引暂时无法打开', icon: 'none' })
    })
  },

  async login(event) {
    const avatar = event.detail.avatarUrl
    if (!avatar || this.data.loading) return
    if (!this.data.agreed) {
      this.setData({ error: '请先阅读并同意隐私保护指引' })
      return
    }
    this.setData({ loading: true, avatar, error: '' })
    try {
      await api.loginWithWechat(avatar)
      if (this._unloaded) return
      wx.showToast({ title: '微信登录成功', icon: 'none' })
      this.finishLogin()
    } catch (error) {
      if (!this._unloaded) this.setData({ error: error.message || '微信登录失败，请稍后重试。' })
    } finally {
      if (!this._unloaded) this.setData({ loading: false })
    }
  },

  finishLogin() {
    const target = ['run', 'result', 'reports', 'run-stats', 'achievements'].includes(this._from) ? 'pages/' + this._from + '/index' : ''
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const previous = pages[pages.length - 2]
    const fallback = () => this.returnToTab(this._from === 'run' ? '/pages/run/index' : '/pages/me/index')
    if (target && previous && previous.route === target) {
      wx.navigateBack({ delta: 1, fail: fallback })
    } else fallback()
  },

  cancel() {
    if (!this.data.loading) this.returnToTab(this.data.fromRun ? '/pages/run/index' : '/pages/me/index')
  },
  returnToTab(url) {
    wx.switchTab({ url, fail: () => this.setData({ error: '请点击左上角返回。' }) })
  }
})

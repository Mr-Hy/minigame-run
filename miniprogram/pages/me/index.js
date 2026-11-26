const api = require('../../lib/api')
const { areaText } = require('../../lib/map')
const { kilometers, duration } = require('../../lib/run-format')

function runningTotals(summary) {
  if (!summary) return null
  return { distance: kilometers(summary.distance_m), count: summary.count, duration: duration(summary.duration_s) }
}

Page({
  data: {
    hasSavedLogin: false, playerId: '', name: '', avatar: '', loadedAvatar: '', loading: false, busy: '', error: '',
    me: null, running: null, runnerNumber: '', manageOpen: false,
    showRunTest: false, editingNickname: false, nicknameDraft: '', nicknameError: ''
  },

  onLoad() {
    this._read = 0
    const { envVersion } = wx.getAccountInfoSync().miniProgram
    this.setData({ showRunTest: envVersion === 'develop' || envVersion === 'trial' })
  },
  onShow() {
    this._retriedAvatar = false
    if (!this.data.busy) return this.loadMe()
  },
  onUnload() { this._read++; this._unloaded = true },

  async loadMe() {
    const read = ++this._read
    const hasSavedLogin = api.hasSavedLogin()
    const playerId = api.playerId()
    const same = playerId && this.data.playerId === playerId
    const name = same ? this.data.name : '', avatar = same ? this.data.avatar : ''
    if (!same && this.data.editingNickname) this.cancelNicknameEdit()
    this.setData({ hasSavedLogin, playerId, name, avatar, loading: hasSavedLogin, error: '',
      ...(!same && { me: null, running: null, runnerNumber: '', manageOpen: false, loadedAvatar: '' }) })
    if (!hasSavedLogin) return
    try {
      const me = await api.me()
      if (read !== this._read) return
      const active = api.playerId()
      if (!active || me.player_id !== active) throw new Error('未能确认当前微信账号，请重新登录。')
      if (active !== playerId && this.data.editingNickname) this.cancelNicknameEdit()
      this.setData({ loading: false, playerId: active, name: me.display_name,
        avatar: me.avatar_display_url || api.avatarUrl(me.avatar_url),
        runnerNumber: me.runner_number ? String(me.runner_number).padStart(5, '0') : '',
        running: runningTotals(me.running_summary),
        me: { count: me.territory_count, area: areaText(me.area_m2) } })
    } catch (error) {
      if (read !== this._read) return
      if (!api.hasSavedLogin()) return this.loadMe()
      const active = api.playerId()
      if (active && active !== playerId) return this.loadMe()
      this.setData({ loading: false, playerId: active, name: active ? name : '', avatar: active ? avatar : '',
        error: error.message || '个人资料读取失败，请重试。' })
    }
  },

  avatarLoaded(event) {
    const src = event.currentTarget.dataset.src
    if (src && src === this.data.avatar) this.setData({ loadedAvatar: src })
  },

  avatarFailed(event) {
    const src = event.currentTarget.dataset.src
    if (!src || src !== this.data.avatar || this._unloaded) return
    this.setData({ avatar: '', loadedAvatar: '' })
    if (this._retriedAvatar || this.data.loading || this.data.busy || this.data.playerId !== api.playerId()) return
    this._retriedAvatar = true
    return this.loadMe()
  },

  openLogin() { wx.navigateTo({ url: '/pages/login/index' }) },

  toggleManage() {
    if (this.data.busy || !this.data.playerId) return
    if (this.data.playerId !== api.playerId()) return this.loadMe()
    if (this.data.editingNickname) this.cancelNicknameEdit()
    this.setData({ manageOpen: !this.data.manageOpen })
  },

  editNickname() {
    if (!this.data.playerId || this.data.busy) return
    if (this.data.playerId !== api.playerId()) return this.loadMe()
    this.setData({ editingNickname: true, nicknameDraft: this.data.name, nicknameError: '' })
  },

  cancelNicknameEdit() {
    this.setData({ editingNickname: false, nicknameDraft: '', nicknameError: '' })
  },

  async saveNickname(event) {
    const playerId = this.data.playerId
    if (!playerId || !this.data.editingNickname || this.data.busy) return
    if (playerId !== api.playerId()) return this.loadMe()
    const nickname = (event.detail.value.nickname || '').trim()
    if (!nickname || Array.from(nickname).length > 32) {
      this.setData({ nicknameDraft: nickname, nicknameError: '请输入 1 至 32 个字符的昵称。' })
      return
    }
    this._read++
    this.setData({ busy: 'nickname', nicknameDraft: nickname, nicknameError: '' })
    try {
      const account = await api.updateNickname(nickname)
      if (this._unloaded) return
      this.setData({ busy: '' })
      if (api.playerId() !== playerId || account.player_id !== playerId) return this.loadMe()
      this.setData({ name: account.display_name })
      this.cancelNicknameEdit()
      wx.showToast({ title: '昵称已更新', icon: 'none' })
      await this.loadMe()
    } catch (error) {
      if (this._unloaded) return
      this.setData({ busy: '', loading: false })
      if (api.playerId() !== playerId) return this.loadMe()
      this.setData({ nicknameError: error.message || '昵称保存失败，请重试。' })
    }
  },

  async updateAvatar(event) {
    const path = event.detail.avatarUrl
    if (!path || this.data.busy || !this.data.playerId) return
    if (this.data.playerId !== api.playerId()) return this.loadMe()
    this._read++
    this.setData({ busy: 'avatar', error: '' })
    try {
      const account = await api.updateAvatar(path)
      if (this._unloaded) return
      if (this.data.playerId !== api.playerId() || account.player_id !== api.playerId()) {
        this.setData({ busy: '' })
        return this.loadMe()
      }
      this._retriedAvatar = false
      this.setData({ name: account.display_name, avatar: path, busy: '' })
      wx.showToast({ title: '头像已更新', icon: 'none' })
      await this.loadMe()
    } catch (error) {
      if (!this._unloaded) {
        this.setData({ busy: '', loading: false, error: error.message || '头像更新失败，请重试。' })
        if (this.data.playerId !== api.playerId()) return this.loadMe()
      }
    }
  },

  async logout() {
    if (this.data.busy || !this.data.playerId) return
    this._read++
    this.setData({ busy: 'logout', error: '' })
    try {
      await api.logout()
      if (this._unloaded) return
      this.setData({ busy: '' })
      await this.loadMe()
    } catch (error) {
      if (this._unloaded) return
      if (!api.playerId()) await this.loadMe()
      this.setData({ busy: '', loading: false, error: error.message || '退出失败，请稍后重试。' })
    }
  },

  openMap() { wx.switchTab({ url: '/pages/run/index' }) }
})

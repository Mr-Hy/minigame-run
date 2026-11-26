const issues = {
  service: { title: '手机定位服务已关闭', content: '请在手机设置中开启「定位服务」或「位置信息」，再返回跑步页。' },
  wechat: { title: '微信没有位置权限', content: '请在手机设置中找到「微信」的权限，将「位置」设为使用期间允许，再返回跑步页。' },
  mini: { title: '小程序没有位置权限', content: '点「去设置」，或从右上角「…」进入设置，将「位置信息」设为使用小程序期间允许。' }
}

function callWx(method, options = {}) {
  return new Promise((resolve, reject) => wx[method]({ ...options, success: resolve, fail: reject }))
}

function deviceLocationIssue() {
  if (wx.getSystemSetting?.()?.locationEnabled === false) return issues.service
  if (wx.getAppAuthorizeSetting?.()?.locationAuthorized === 'denied') return issues.wechat
  return null
}

async function getMapPosition(current) {
  const deviceIssue = deviceLocationIssue()
  if (deviceIssue) return { issue: deviceIssue }
  try {
    const { authSetting } = await callWx('getSetting')
    if (!current()) return {}
    const foreground = authSetting['scope.userLocation']
    if (foreground === false) return { issue: issues.mini }
    if (!foreground) {
      await callWx('authorize', { scope: 'scope.userLocation' })
      if (!current()) return {}
    }
    const point = await callWx('getLocation', { type: 'gcj02', isHighAccuracy: true })
    return { point }
  } catch (error) {
    if (!current()) return {}
    // 首次取点可能刚触发系统授权，此时重新读取开关。
    const issue = deviceLocationIssue()
    if (issue) return { issue }
    const message = error?.errMsg || ''
    if (/location\s*switch\s*off|location services? (?:is |are )?(?:disabled|off)/i.test(message)) return { issue: issues.service }
    if (error?.errno === 3 || /system permission (denied|deny)/i.test(message)) return { issue: issues.wechat }
    if (error?.errno === 103 || /auth deny|auth denied|user (?:authorize )?(?:deny|denied)/i.test(message)) return { issue: issues.mini }
    const settings = await callWx('getSetting').catch(() => null)
    if (settings?.authSetting?.['scope.userLocation'] === false) return { issue: issues.mini }
    throw error
  }
}

module.exports = { callWx, issues, deviceLocationIssue, getMapPosition }

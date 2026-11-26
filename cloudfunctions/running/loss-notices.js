'use strict'

const { createHash } = require('node:crypto')

const BATTLE_RESULT_TEMPLATE = 'hyieEy8910ml7wX5E1z3a5WOj4WFYZqGv2tpQ3P0wEI'
const RETRY_DELAYS = [60000, 300000, 900000, 3600000]
const SEND_TIMEOUT = 3 * 60000

function key(prefix, ...parts) {
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 31)
}

function noticeData(report) {
  const time = new Date((report.ended_at + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const meters = report.area_m2
  const area = meters >= 100000000 ? Math.round(meters / 1000000) / 100 + '亿' : Math.round(meters)
  return {
    thing1: { value: '跑步圈地' },
    time3: { value: time },
    short_thing4: { value: '领地被夺' },
    thing5: { value: meters < 1 ? '失地不足1平方米' : '失地约' + area + '平方米' }
  }
}

async function queueLossNotice(tx, report) {
  if (process.env.LOSS_NOTICE_TEMPLATE_ID === '') return
  const subscriptionKey = key('s', report.recipient)
  const grant = await tx.get(subscriptionKey)
  if (!grant?.template_id) return
  const id = key('n', report.id)
  if (await tx.get(id)) return

  await tx.set(id, {
    state: 'pending', notice_due_at: Date.now(), attempts: 0, appid: grant.appid,
    message: { touser: grant.openid, templateId: grant.template_id, page: 'pages/reports/index',
      miniprogramState: grant.state, data: noticeData(report) }
  })
  await tx.set(subscriptionKey, { subscribed: false })
}

function deliveryResult(response, threw) {
  const raw = response?.errCode ?? response?.errcode
  const code = typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+$/.test(raw)) ? Number(raw) : null
  if (!threw && code === 0) return { state: 'sent' }
  const message = response?.errMsg || response?.errmsg || response?.message || ''
  // The SDK also uses -1 for generic network errors. Only an explicit WeChat
  // rejection is safe to retry: subscribeMessage.send has no idempotency key.
  if (code === 45009 || code === 45011 || (code === -1 && /system busy|系统繁忙/i.test(message))) {
    return { state: 'retry', code }
  }
  return { state: code > 0 ? 'rejected' : 'unknown', code }
}

function createLossNotices(repo, cloud, options = {}) {
  const configuredId = (options.env || process.env).LOSS_NOTICE_TEMPLATE_ID ?? BATTLE_RESULT_TEMPLATE
  const now = options.now || Date.now

  function settingsFor(grant) {
    return { template_id: configuredId, subscribed: Boolean(configuredId && grant?.template_id === configuredId) }
  }

  async function settings(player) {
    return settingsFor(configuredId && await repo.get(key('s', player)))
  }

  async function subscribe(player, wxContext, templateId, grantId, envVersion) {
    if (!configuredId || templateId !== configuredId) {
      throw Object.assign(new Error('微信提醒模板已变更或暂未启用，请刷新战报'), { status: 409, code: 'notice_unavailable' })
    }
    if (typeof grantId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(grantId)) {
      throw Object.assign(new Error('无效的订阅请求编号'), { status: 400, code: 'invalid_grant_id' })
    }
    const id = key('s', player)
    const receipt = key('g', player, templateId, grantId)
    return repo.transaction(async tx => {
      const previous = await tx.get(id)
      if (await tx.get(receipt)) return settingsFor(previous)
      const state = envVersion === 'develop' ? 'developer' : envVersion === 'trial' ? 'trial' : 'formal'
      const grant = { openid: wxContext.OPENID, appid: wxContext.APPID, template_id: templateId, state }
      await tx.set(receipt, { accepted: true })
      await tx.set(id, grant)
      return settingsFor(grant)
    })
  }

  async function deliver(id) {
    const job = await repo.transaction(async tx => {
      const record = await tx.get(id)
      if (record?.notice_due_at == null || record.notice_due_at > now()) return null
      if (record.state === 'sending') {
        // A worker disappeared while calling WeChat or recording its reply.
        await tx.set(id, { state: 'unknown', attempts: record.attempts })
        return null
      }
      const claim = { ...record, state: 'sending', notice_due_at: now() + SEND_TIMEOUT, attempts: record.attempts + 1 }
      await tx.set(id, claim)
      return claim
    })
    if (!job) return 'skipped'

    let result
    try {
      const reply = await cloud.openapi({ appid: job.appid }).subscribeMessage.send(job.message)
      result = deliveryResult(reply, false)
    } catch (err) {
      result = deliveryResult(err, true)
    }
    const delay = RETRY_DELAYS[job.attempts - 1]
    if (result.state === 'retry' && delay !== undefined) {
      await repo.set(id, { ...job, state: 'pending', notice_due_at: now() + delay, code: result.code })
      return 'retry'
    }
    const state = result.state === 'retry' ? 'rejected' : result.state
    await repo.set(id, { ...result, state, attempts: job.attempts })
    return state
  }

  async function dispatch() {
    if (!configuredId) return {}
    const ids = await repo.dueLossNotices(now(), 20)
    const counts = {}
    let failure
    // A short bounded batch leaves time to persist all responses before the timer exits.
    for (let i = 0; i < ids.length; i += 5) {
      const results = await Promise.allSettled(ids.slice(i, i + 5).map(deliver))
      for (const result of results) {
        if (result.status === 'rejected') failure = result.reason
        else counts[result.value] = (counts[result.value] || 0) + 1
      }
    }
    if (failure) throw failure
    return counts
  }

  return { settings, subscribe, dispatch }
}

module.exports = { queueLossNotice, createLossNotices }

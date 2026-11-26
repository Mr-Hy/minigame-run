const test = require('node:test')
const assert = require('node:assert/strict')
const { createLossNotices, queueLossNotice } = require('../cloudfunctions/running/loss-notices')

const templateId = 'hyieEy8910ml7wX5E1z3a5WOj4WFYZqGv2tpQ3P0wEI'
const context = { APPID: 'running-app', OPENID: 'private-wechat-recipient' }
const report = { id: 'report-one', recipient: 'alice', challenger: 'bob', ended_at: 1730000000,
  area_m2: 231.6, pace_s_per_km: 339, regions: [{ latitude: 31, longitude: 121, area_m2: 231.6 }] }

function setup(reply = () => ({ errCode: 0 }), config = {}) {
  const documents = new Map()
  let time = Date.now() + 10000, tail = Promise.resolve()
  const calls = []
  const repo = {
    get: async id => structuredClone(documents.get(id) ?? null),
    set: async (id, row) => { documents.set(id, structuredClone(row)) },
    transaction(fn) {
      const run = tail.then(() => fn(repo))
      tail = run.catch(() => {})
      return run
    },
    dueLossNotices: async (now, limit) => [...documents].filter(([, row]) => row.notice_due_at <= now)
      .slice(0, limit).map(([id]) => id)
  }
  const cloud = { openapi({ appid }) {
    return { subscribeMessage: { async send(message) {
      calls.push({ appid, ...message })
      return reply(calls.length)
    } } }
  } }
  const notices = createLossNotices(repo, cloud, { env: config, now: () => time })
  return { notices, repo, calls, documents, tick(ms) { time += ms },
    accept: (grantId = 'first', version) => notices.subscribe('alice', context, templateId, grantId, version),
    capture: (event = report) => repo.transaction(tx => queueLossNotice(tx, event)) }
}

test('一次接受只推下一次失地，重复登记或同时发送不重发，消息只寄给授权的微信身份', async () => {
  const { notices, calls, accept, capture } = setup()
  const settings = { template_id: templateId, subscribed: false }
  assert.deepEqual(await notices.settings('alice'), settings)
  await capture({ ...report, id: 'before-grant' })
  assert.deepEqual(await notices.dispatch(), {})
  assert.deepEqual(await accept(), { ...settings, subscribed: true })
  await accept()
  await capture({ ...report, recipient: 'charlie', id: 'charlie-loss' })
  assert.equal((await notices.settings('alice')).subscribed, true)
  await Promise.all([capture(), capture(), capture({ ...report, id: 'second-loss' })])
  assert.deepEqual(await accept(), settings)
  await Promise.all([notices.dispatch(), notices.dispatch()])
  assert.deepEqual(calls, [{ appid: context.APPID, touser: context.OPENID,
    templateId, miniprogramState: 'formal', page: 'pages/reports/index', data: {
      thing1: { value: '跑步圈地' }, time3: { value: '2024-10-27 11:33' },
      short_thing4: { value: '领地被夺' }, thing5: { value: '失地约232平方米' }
    } }])
  await accept('second')
  await capture()
  assert.equal((await notices.settings('alice')).subscribed, true)
  await capture({ ...report, id: 'third-loss' })
  assert.deepEqual(await notices.dispatch(), { sent: 1 })
  assert.deepEqual(await accept(), settings)
})

test('授权已撤回或投递结果未知时保留战报，不重复推送', async () => {
  for (const [error, expected] of [[{ errCode: 43101 }, 'rejected'], [new Error('socket reset'), 'unknown']]) {
    const { notices, accept, capture, calls, tick } = setup(() => { throw error })
    await accept()
    await capture()
    assert.deepEqual(await notices.dispatch(), { [expected]: 1 })
    tick(3600000)
    assert.deepEqual(await notices.dispatch(), {})
    assert.equal(calls.length, 1)
  }
})

test('收到微信明确限流响应后退避重试，成功后停止', async () => {
  const { notices, accept, capture, calls, tick } = setup(attempt => attempt === 1 ? { errcode: 45009 } : { errCode: 0 })
  await accept()
  await capture()
  assert.deepEqual(await notices.dispatch(), { retry: 1 })
  assert.deepEqual(await notices.dispatch(), {})
  tick(60000)
  assert.deepEqual(await notices.dispatch(), { sent: 1 })
  assert.deepEqual(await notices.dispatch(), {})
  assert.equal(calls.length, 2)
})

test('微信成功发送后若存储回执失败，超时的发送记录不重复投递', async () => {
  const { notices, repo, accept, capture, calls, tick, documents } = setup()
  await accept()
  await capture()
  const save = repo.set
  repo.set = async (id, record) => {
    if (record.state === 'sent') throw new Error('storage unavailable')
    return save(id, record)
  }
  await assert.rejects(notices.dispatch(), /storage unavailable/)
  tick(300000)
  await notices.dispatch()
  assert.equal(calls.length, 1)
  assert.equal([...documents.values()].some(record => record.state === 'unknown'), true)
})

test('点击通知打开接受订阅时的小程序版本，面积提示符合模板长度限制', async () => {
  const { accept, capture, calls, notices } = setup()
  for (const [version, state, area] of [['develop','developer',0.2], ['trial','trial',10000], ['release','formal',5.1e14]]) {
    await accept(version, version)
    await capture({ ...report, id: version, area_m2: area })
    await notices.dispatch()
    const message = calls.at(-1)
    assert.equal(message.miniprogramState, state)
    assert.ok(message.data.thing5.value.length <= 20)
  }
})

test('显式停用模板、模板变更或无效的登记编号不创建授权', async () => {
  const unconfigured = setup(null, { LOSS_NOTICE_TEMPLATE_ID: '' })
  assert.deepEqual(await unconfigured.notices.settings('alice'), { template_id: '', subscribed: false })
  await assert.rejects(unconfigured.accept(), { code: 'notice_unavailable' })
  assert.deepEqual(await unconfigured.notices.dispatch(), {})
  const { notices, accept, documents } = setup()
  await assert.rejects(notices.subscribe('alice', context, 'old-template', 'request'), { code: 'notice_unavailable' })
  await assert.rejects(accept('not/valid'), { code: 'invalid_grant_id' })
  assert.equal(documents.size, 0)
})

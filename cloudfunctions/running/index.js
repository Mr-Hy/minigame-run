const cloud = require('wx-server-sdk')
const { Grid } = require('./geometry')
const { createRepository } = require('./repository')
const { createAccounts } = require('./accounts')
const { createRuns } = require('./runs')
const { createHandler } = require('./api')
const { createLossNotices } = require('./loss-notices')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const repo = createRepository(db)
const grid = new Grid(Number(process.env.PARK_LATITUDE || 31.23), Number(process.env.PARK_LONGITUDE || 121.47))
const notices = createLossNotices(repo, cloud)
const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, cloud), notices)

exports.main = event => {
  const context = cloud.getWXContext()
  if (context.SOURCE === 'wx_trigger' || process.env.TRIGGER_SRC === 'timer') return notices.dispatch()
  return handle(event, context)
}

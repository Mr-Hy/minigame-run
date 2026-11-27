const { playerId } = require('./accounts')
const { catalog } = require('./regions')
const { scorePeriods } = require('./score-totals')
const provinceNames = new Map(catalog.map(({ code, name }) => [code, name]))

const RUN_ID = /^[A-Za-z0-9_-]{1,96}$/
const MAX_TIME = 253402300799
const MAX_BATCH_BYTES = 2 * 1024 * 1024
const MESSAGES = {
  run_not_found: '找不到这场跑步',
  run_finished: '这场跑步已结束，可查询首次结算结果',
  run_id_conflict: '跑步编号已使用，请为新跑步生成唯一编号',
  invalid_start_point: '请取得精度误差不超过 50 米的起点再开始',
  invalid_end_time: '结束时间早于开始时间'
}

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { status, code })
}

function number(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('invalid_field', name + ' 超出范围或不是有效数值')
  }
  return value
}

function point(sample) {
  if (!sample || typeof sample !== 'object') fail('invalid_point', '每个定位点都需要经纬度、采集时间和定位精度')
  return {
    latitude: number(sample.latitude, 'latitude', -90, 90),
    longitude: number(sample.longitude, 'longitude', -180, 180),
    accuracy: number(sample.accuracy, 'accuracy', 0, Number.MAX_VALUE),
    timestamp: number(sample.timestamp, 'timestamp', 0, MAX_TIME)
  }
}

function batch(samples) {
  if (!Array.isArray(samples)) fail('invalid_points', 'points 必须是定位点数组')
  if (Buffer.byteLength(JSON.stringify(samples)) > MAX_BATCH_BYTES) fail('batch_too_large', '请分批上传定位点', 413)
  return samples.map(point)
}

async function mapData(bounds, grid, runs, accounts) {
  if (bounds === undefined) bounds = grid.defaultBounds()
  if (!bounds || !Number.isFinite(bounds.west) || !Number.isFinite(bounds.east) ||
      !Number.isFinite(bounds.south) || !Number.isFinite(bounds.north) ||
      !(bounds.west >= -180 && bounds.west < bounds.east && bounds.east <= 180 &&
        bounds.south >= -90 && bounds.south < bounds.north && bounds.north <= 90)) {
    fail('invalid_region', '请提供有效的 west、south、east、north 范围')
  }
  const { west, south, east, north } = bounds
  const { territories } = await runs.territories(west, south, east, north)
  const owners = new Map()
  for (const { owner } of territories) {
    if (!owners.has(owner)) owners.set(owner, accounts.ownerProfile(owner))
  }
  const decorated = await Promise.all(territories.map(async t => ({ ...t, ...await owners.get(t.owner) })))
  return { coordinate_system: 'gcj02', origin: grid.origin, bounds: { west, south, east, north }, territories: decorated }
}

async function leaderboard(event, viewer, runs, accounts, now) {
  const { metric = 'area', scope = 'national', period = 'day', region_code } = event
  if (metric !== 'area' && metric !== 'distance') fail('invalid_metric', '请选择面积榜或里程榜')
  if (scope !== 'national' && scope !== 'province') fail('invalid_scope', '请选择全国榜或省份榜')
  if (!['day', 'week', 'month'].includes(period)) fail('invalid_period', '请选择日榜、周榜或月榜')
  if (region_code !== undefined) fail('invalid_region', '榜单不接受单个地区筛选')
  const periodKey = scorePeriods(now)[period]
  const board = await runs.leaderboard(metric, scope, periodKey)
  if (scope === 'province') {
    const entries = board.entries.map(({ rank, subject, value }) => ({
      rank, region_code: subject, display_name: provinceNames.get(subject), value
    }))
    return { ...board, period, entries }
  }
  const owners = await accounts.publicProfiles(board.entries.map(entry => entry.subject))
  const entries = board.entries.map(({ rank, subject, value }, i) => ({
    rank, player_id: subject, display_name: owners[i].owner_display_name,
    avatar_url: owners[i].owner_avatar_url, value
  }))
  const response = { ...board, period, entries }
  if (event.include_self === true) {
    const placement = await runs.personalRank(metric, viewer, board.entries, periodKey)
    response.self = { player_id: viewer, ...placement }
  }
  return response
}

function createHandler(grid, runs, accounts, lossNotices, now = () => Date.now() / 1000) {
  return async function handle(event, wxContext) {
    try {
      const { action, expected_player } = event || {}
      if (expected_player !== undefined && playerId(wxContext) !== expected_player) {
        fail('account_changed', '本次操作属于另一个微信账号，请重新登录', 409)
      }
      switch (action) {
        case 'login': return await accounts.login(wxContext, event)
        case 'logout': return await accounts.logout(wxContext)
        case 'updateAvatar': return await accounts.updateAvatar(wxContext, event)
        case 'updateNickname': return await accounts.updateNickname(wxContext, event)
      }
      const account = await accounts.current(wxContext)
      const { player_id } = account
      switch (action) {
        case 'map': return await mapData(event.bounds, grid, runs, accounts)
        case 'leaderboard': return await leaderboard(event, player_id, runs, accounts, now())
        case 'me': {
          const [land, running_summary, avatar_display_url] = await Promise.all([
            runs.playerSummary(player_id), runs.runningSummary(player_id), accounts.avatarDisplayUrl(account.avatar_url)
          ])
          return { ...land, ...account, running_summary, avatar_display_url }
        }
        case 'achievements': return await runs.achievements(player_id)
        case 'runStats':
        case 'runHistory': return await runs[action](player_id, event, now())
        case 'lossReports': {
          const [page, notification] = await Promise.all([
            runs.lossReports(player_id, event.cursor), lossNotices.settings(player_id)
          ])
          const players = [...new Set(page.reports.map(report => report.challenger))]
          const owners = await accounts.publicProfiles(players)
          const names = new Map(players.map((player, i) => [player, owners[i].owner_display_name]))
          const reports = page.reports.map(report => ({ ...report, challenger_name: names.get(report.challenger) }))
          return { ...page, reports, notification }
        }
        case 'lossReportBoundary': {
          return await runs.lossReportBoundary(player_id, event.report_id, event.region_index)
        }
        case 'subscribeLossNotice': {
          return await lossNotices.subscribe(player_id, wxContext, event.template_id, event.grant_id, event.env_version)
        }
        case 'start':
        case 'append':
        case 'finish':
        case 'shareStandings':
        case 'getRun': {
          const id = event.run_id
          if (typeof id !== 'string' || !RUN_ID.test(id)) fail('invalid_run_id', '跑步编号须为 1 至 96 位字母、数字、下划线或短横线')
          if (action === 'shareStandings') return await runs.shareStandings(player_id, id)
          if (action === 'getRun') return await runs.get(player_id, id, event.include_points !== false)
          if (action === 'start') {
            const first = point(event.first_point)
            return await runs.start(player_id, id, first.timestamp, first)
          }
          if (action === 'append') return await runs.append(player_id, id, batch(event.points))
          const end = number(event.ended_at, 'ended_at', 0, MAX_TIME)
          return await runs.finish(player_id, id, end, batch(event.points === undefined ? [] : event.points))
        }
        default: fail('not_found', '未知的云函数操作', 404)
      }
    } catch (error) {
      if (!Number.isInteger(error.status) || !error.code) throw error
      return { error: { status: error.status, code: error.code, message: MESSAGES[error.code] || error.message } }
    }
  }
}

module.exports = { createHandler }

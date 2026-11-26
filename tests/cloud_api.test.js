const test = require('node:test')
const assert = require('node:assert/strict')
const { createHandler } = require('../cloudfunctions/running/api')
const { createAccounts, playerId } = require('../cloudfunctions/running/accounts')
const { createLossNotices } = require('../cloudfunctions/running/loss-notices')
const { scoreKey } = require('../cloudfunctions/running/score-totals')
const { createRepository } = require('../cloudfunctions/running/repository')
const { createRuns } = require('../cloudfunctions/running/runs')
const { Grid } = require('../cloudfunctions/running/geometry')

function database() {
  const collections = { running_state: new Map(), running_scores: new Map() }
  const fields = (row, path) => path.split('.').reduce((value, prop) => value?.[prop], row)
  const matchesFilter = (row, filter) => typeof filter === 'function' ? filter(row) :
    Object.entries(filter).every(([path, expected]) => {
      const value = fields(row, path)
      return typeof expected === 'function' ? expected(value) : value === expected
    })
  function projected(row, spec) {
    if (!spec || !row) return structuredClone(row)
    const selected = { _id: row._id }
    for (const path of Object.keys(spec)) {
      const value = fields(row, path)
      if (value === undefined) continue
      const keys = path.split('.'), last = keys.pop()
      const dest = keys.reduce((parent, key) => parent[key] ||= {}, selected)
      dest[last] = structuredClone(value)
    }
    return selected
  }
  const accumulator = op => expr => ({ [op]: expr })
  const reads = []
  const db = {
    command: {
      aggregate: { push: accumulator('$push'), sum: accumulator('$sum'), max: accumulator('$max'), min: accumulator('$min') },
      and: terms => row => terms.every(term => matchesFilter(row, term)),
      or: terms => row => terms.some(term => matchesFilter(row, term)),
      exists: exists => value => (value !== undefined) === exists,
      gte: min => Object.assign(value => value != null && value >= min, {
        and: condition => value => value != null && value >= min && condition(value)
      }),
      gt: min => value => value > min,
      lt: max => value => value < max,
      lte: max => value => value <= max,
      in: ids => value => ids.includes(value)
    },
    collection(name) {
      const documents = collections[name]
      assert.ok(documents, name)
      const select = filter => [...documents.values()].filter(row => matchesFilter(row, filter))
      return {
        doc: key => ({
          get: async () => {
            reads.push(name + ':doc')
            return { data: structuredClone(documents.get(key)) ?? null }
          },
          field: spec => ({ get: async () => ({ data: projected(documents.get(key), spec) ?? null }) }),
          set: async ({ data }) => documents.set(key, structuredClone({ _id: key, ...data }))
        }),
        aggregate() {
          let rows, scope, cap, group, bucket
          return {
            match(filter) { rows = select(filter); scope = filter.board; return this },
            sort(order) {
              rows.sort((a, b) => {
                for (const [path, direction] of Object.entries(order)) {
                  const x = fields(a, path), y = fields(b, path)
                  if (x !== y) return direction * (x > y ? 1 : -1)
                }
                return 0
              })
              return this
            },
            limit(n) { cap = n; rows = rows.slice(0, n); return this },
            group(spec) { group = spec; return this },
            bucket(spec) { bucket = spec; return this },
            async end() {
              if (name === 'running_state') {
                const groups = new Map()
                for (const row of rows) {
                  const timestamp = row.value.ended_at
                  const boundary = bucket?.boundaries.find((val, i) => val <= timestamp && timestamp < bucket.boundaries[i + 1])
                  const id = bucket ? (boundary ?? bucket.default) : group._id
                  if (!groups.has(id)) groups.set(id, { _id: id })
                  const target = groups.get(id)
                  for (const [prop, expr] of Object.entries(bucket?.output || group)) {
                    if (prop === '_id') continue
                    const [[op, arg]] = Object.entries(expr)
                    const value = typeof arg === 'number' ? arg : fields(row, arg.slice(1))
                    if (op === '$sum') target[prop] = (target[prop] || 0) + value
                    if (op === '$max') target[prop] = Math.max(target[prop] || 0, value)
                    if (op === '$min') target[prop] = value == null ? (target[prop] ?? null) : Math.min(target[prop] ?? Infinity, value)
                  }
                }
                return { list: [...groups.values()] }
              }
              assert.equal(name, 'running_scores')
              if (scope.split(':')[0] === 'national') assert.equal(cap, 500)
              reads.push(scope)
              const doc = { _id: group._id }
              for (const [field, accumulator] of Object.entries(group)) {
                if (field === '_id') continue
                doc[field] = rows.map(row => Object.fromEntries(Object.entries(accumulator.$push)
                  .map(([key, expr]) => [key, fields(row, expr.slice(1))])))
              }
              return { list: rows.length ? [doc] : [] }
            }
          }
        },
        where(filter) {
          const matches = select(filter)
          const orders = []
          let limit = 100, projection
          return {
            orderBy(path, direction) {
              orders.push([path, direction === 'asc' ? 1 : -1])
              return this
            },
            field(pick) { projection = pick; return this },
            limit(count) { limit = count; return this },
            async get() {
              assert.equal(name, 'running_state', '成绩聚合应在数据库内截取前 500 人')
              assert.ok(limit <= 100, '公开资料需分批读取')
              reads.push(limit)
              matches.sort((a, b) => {
                for (const [path, order] of orders) {
                  const x = fields(a, path), y = fields(b, path)
                  if (x !== y) return x > y ? order : -order
                }
                return 0
              })
              return { data: matches.slice(0, limit).map(row => projected(row, projection)) }
            }
          }
        }
      }
    },
    runTransaction(work) { return work(this) }
  }
  return { repo: createRepository(db), reads }
}

test('running routes use the WeChat caller, preserve map ownership and keep tracks private', async () => {
  const { repo } = database()
  const grid = new Grid()
  const accounts = createAccounts(repo, {
    uploadFile: async ({ cloudPath }) => ({ fileID: 'cloud://test/' + cloudPath }),
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map(fileID => ({ fileID, status: 0 })) })
  })
  const handle = createHandler(grid, createRuns(repo, grid), accounts, undefined, () => 1120)
  const alice = { APPID: 'demo', OPENID: 'alice' }
  const bob = { APPID: 'demo', OPENID: 'bob' }
  const avatar_base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgaGAAAAEEAIFw9selAAAAAElFTkSuQmCC'
  const call = (action, fields, identity = alice) => handle({ action, ...fields }, identity)
  for (const identity of [{}, alice]) {
    for (const [action, fields] of [['map', {}], ['leaderboard', {}], ['leaderboard', { scope: 'province' }], ['me', {}]]) {
      const { error } = await call(action, { ...fields, ...alice }, identity)
      assert.equal(error.status, 401, action)
      assert.equal(error.code, 'login_required', action)
    }
  }
  const account = await call('login', { avatar_base64 })
  assert.ok(account.player_id, JSON.stringify(account))
  const other = await call('login', { avatar_base64 }, bob)
  const expected = { expected_player: account.player_id }
  for (const action of ['login', 'map', 'leaderboard', 'me', 'start', 'append', 'finish', 'getRun', 'logout', 'updateAvatar', 'updateNickname',
    'achievements', 'lossReports', 'lossReportBoundary', 'subscribeLossNotice']) {
    const { error } = await call(action, expected, bob)
    assert.equal(error.status, 409, action)
    assert.equal(error.code, 'account_changed', action)
  }
  assert.equal((await call('me', expected, {})).error.code, 'login_required')
  assert.equal((await call('me', expected)).player_id, account.player_id)
  assert.equal((await call('me', {}, bob)).avatar_url, other.avatar_url)
  assert.deepEqual((await call('map', expected)).territories, [])
  assert.deepEqual(await call('leaderboard', expected), { period: 'day', metric: 'area', rank_limit: 500, entries: [] })
  const points = [[0,0], [100,0], [100,100], [0,100], [0,0]].map(([x,y], i) =>
    ({ ...grid.toGeo(x, y), accuracy: 3, timestamp: 1000 + i * 30 }))
  const run_id = 'native-demo'
  const run = await call('start', { run_id, first_point: points[0], player_id: 'other' })
  assert.equal(run.player_id, account.player_id)
  assert.equal((await call('getRun', { run_id, ...alice }, bob)).error.code, 'run_not_found')
  assert.equal((await call('append', { run_id, points: points.slice(1) })).point_count, 5)
  const result = await call('finish', { run_id, ended_at: 1120 })
  assert.equal(result.area_m2, 10000)
  assert.equal((await call('achievements', {}, {})).error.code, 'login_required')
  assert.equal((await call('achievements', { player_id: other.player_id })).records.peak_area.run_id, run_id)
  assert.equal((await call('achievements', { player_id: account.player_id }, bob)).records.peak_area, null)
  assert.deepEqual((await call('getRun', { run_id, include_points: false })).result.achievement_updates,
    result.achievement_updates)
  assert.deepEqual((await call('getRun', { run_id })).result, result)
  assert.equal((await call('me', {})).area_m2, 10000)
  const [land] = (await call('map', {})).territories
  assert.equal(land.owner_display_name, account.display_name)
  assert.equal(land.owner_avatar_url, account.avatar_url)
  const renamed = await call('updateNickname', { ...expected, player_id: other.player_id, nickname: ' 河边跑者 ' })
  assert.deepEqual(renamed, { ...account, display_name: '河边跑者' })
  assert.equal((await call('me')).display_name, renamed.display_name)
  assert.equal((await call('me', {}, bob)).display_name, other.display_name)
  assert.equal((await call('map', {})).territories[0].owner_display_name, renamed.display_name)
  assert.deepEqual(await call('leaderboard', {}), {
    period: 'day', metric: 'area', rank_limit: 500, entries: [{
      rank: 1, player_id: account.player_id, display_name: renamed.display_name,
      avatar_url: account.avatar_url, value: 10000
    }]
  })
  assert.deepEqual(await call('leaderboard', {scope:'province'}), {
    period: 'day', metric: 'area', entries: [{ rank:1, region_code:'310000', display_name:'上海市', value:10000 }]
  })
  assert.equal((await call('leaderboard', {scope:'province',region_code:'310000'})).error.code, 'invalid_region')
  assert.equal((await call('leaderboard', {scope:'city'})).error.code, 'invalid_scope')
  assert.equal((await call('leaderboard', {period:'year'})).error.code, 'invalid_period')
  assert.equal((await call('map', { bounds: {} })).error.code, 'invalid_region')
  await call('logout')
  for (const action of ['map', 'leaderboard']) {
    assert.equal((await call(action, expected)).error.code, 'login_required')
  }
})

test('失地战报和微信提醒只归属原领主，重试完赛后各一条', async () => {
  const { repo } = database()
  const grid = new Grid()
  const first = { APPID: 'demo', OPENID: 'first' }, second = { APPID: 'demo', OPENID: 'second' }
  for (const [context, name] of [[first, '甲'], [second, '乙']]) {
    await repo.set('a' + playerId(context).slice(3, 34), { avatar_url: 'cloud://avatar', display_name: name, runner_number: 1 })
  }
  const delivered = []
  const notices = createLossNotices(repo, {
    openapi: () => ({ subscribeMessage: { send: message => { delivered.push(message); return { errCode: 0 } } } })
  }, { env: { LOSS_NOTICE_TEMPLATE_ID: 'test-template' } })
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, {}), notices)
  const call = (context, action, fields) => handle({ action, ...fields }, context)
  assert.equal((await call({}, 'lossReports')).error.code, 'login_required')
  const grant = { template_id: 'test-template', grant_id: 'approved-once', env_version: 'trial', openid: second.OPENID }
  assert.equal((await call(first, 'subscribeLossNotice', grant)).subscribed, true)
  async function run(context, run_id, step) {
    const points = [[0,0], [100,0], [100,100], [0,100], [0,0]].map(([x,y], i) =>
      ({ ...grid.toGeo(x, y), accuracy: 3, timestamp: 1000 + i * step }))
    const ended_at = points.at(-1).timestamp
    await call(context, 'start', { run_id, first_point: points[0] })
    return call(context, 'finish', { run_id, ended_at, points })
  }
  await run(first, 'first-claim', 30)
  const win = await run(second, 'next-claim', 25)
  await call(second, 'finish', { run_id: 'next-claim', ended_at: 1100 })
  const inbox = await call(first, 'lossReports')
  assert.equal(inbox.reports.length, 1)
  assert.equal(inbox.reports[0].challenger_name, '乙')
  assert.equal(inbox.reports[0].area_m2, 10000)
  assert.equal(inbox.notification.subscribed, false)
  assert.equal(inbox.next_cursor, null)
  assert.deepEqual((await call(second, 'lossReports', { player_id: playerId(first) })).reports, [])
  const selected = { report_id: inbox.reports[0].id, region_index: 0 }
  const query = (who, changes) => call(who, 'lossReportBoundary', { ...selected, ...changes })
  const expected = { geometry: win.outcomes.find(part => part.outcome === 'captured').geometry }
  assert.deepEqual(await query(first), expected)
  assert.deepEqual(Object.keys((await repo.lossReportRows(playerId(first), null, 20))[0]).sort(), ['loss_revision', 'report'])
  assert.equal((await query({}, {})).error.code, 'login_required')
  assert.equal((await query(second, { player_id: playerId(first) })).error.code, 'report_not_found')
  assert.equal((await query(first, { region_index: 1 })).error.code, 'invalid_region_index')
  assert.equal((await query(first, { region_index: -1 })).error.code, 'invalid_region_index')
  assert.equal((await query(first, { report_id: 'park-map' })).error.code, 'invalid_report_id')
  await run(first, 'recapture', 20)
  assert.deepEqual(await query(first), expected)
  const old = await repo.get(selected.report_id)
  delete old.boundaries
  await repo.set(selected.report_id, old)
  assert.deepEqual(await query(first), { geometry: null })
  assert.deepEqual(await notices.dispatch(), { sent: 1 })
  assert.equal(delivered[0].touser, first.OPENID)
  assert.equal(delivered[0].miniprogramState, 'trial')
})


test('全国和省份榜按精确成绩、该指标的达成时间以及主体编号排出连续名次', async () => {
  const { repo } = database()
  for (const board of ['national', 'province']) {
    for (const [subject, units, areaTime, distanceTime] of [
      ['330000', 1000, 1000, 1001], ['310000', 1000, 1000, 1001],
      ['320000', 1000, 1001, 1000], ['340000', 1001, 2000, 2000], ['350000', 0, 900, 900]
    ]) {
      await repo.setScore(scoreKey(board, subject), {
        board, subject, area_units: units, distance_units: units, area_reached_at: areaTime, distance_reached_at: distanceTime
      })
    }
  }
  for (const scope of ['national', 'province']) {
    const area = await repo.scoreBoard('area', scope)
    const distance = await repo.scoreBoard('distance', scope)
    assert.deepEqual(area.entries.map(row => [row.rank, row.subject, row.value]), [
      [1, '340000', 10.01], [2, '310000', 10], [3, '330000', 10], [4, '320000', 10]
    ])
    assert.deepEqual(distance.entries.map(row => [row.rank, row.subject, row.value]), [
      [1, '340000', 1.001], [2, '320000', 1], [3, '310000', 1], [4, '330000', 1]
    ])
  }
})

test('北京时间零点、周一和月初换榜，跨期完赛的距离和领地净增归入结束周期', async () => {
  const { repo } = database()
  const grid = new Grid()
  const runs = createRuns(repo, grid)
  const monday = Date.parse('2024-04-01T00:00:00+08:00') / 1000
  let now = monday - 0.25
  const handle = createHandler(grid, runs, createAccounts(repo, {}), undefined, () => now)
  const first = { APPID: 'periods', OPENID: 'first' }, later = { APPID: 'periods', OPENID: 'later' }
  for (const context of [first, later]) {
    await repo.set('a' + playerId(context).slice(3, 34), {
      runner_number: 1, display_name: context.OPENID, avatar_url: 'cloud://avatar'
    })
  }
  async function finish(context, runId, endedAt, offset, step) {
    const path = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
    const points = path.map(([x, y], i) => ({
      ...grid.toGeo(x + offset, y), accuracy: 3, timestamp: endedAt - (4 - i) * step
    }))
    await runs.start(playerId(context), runId, points[0].timestamp, points[0])
    await runs.finish(playerId(context), runId, endedAt, points)
  }
  function board(period, metric, scope = 'national') {
    return handle({ action: 'leaderboard', period, metric, scope, include_self: true }, first)
  }

  await finish(first, 'sunday', now, 0, 30)
  assert.equal((await board('day', 'area')).self.value, 10000)
  now = monday
  for (const period of ['day', 'week', 'month']) {
    assert.deepEqual((await board(period, 'distance')).entries, [])
  }
  // 乙在午夜结束，夺得甲的半块地并新占另一半。省内覆盖只增加新占的部分。
  await finish(later, 'monday', now, 50, 20)
  await runs.finish(playerId(later), 'monday', now)
  for (const period of ['day', 'week', 'month']) {
    const area = await board(period, 'area')
    assert.equal(area.period, period)
    assert.deepEqual(area.entries.map(row => [row.display_name, row.value]), [['later', 10000]])
    assert.deepEqual(area.self, { player_id: playerId(first), rank: null, value: 0 })
    assert.equal((await board(period, 'area', 'province')).entries[0].value, 5000)
    assert.equal((await board(period, 'distance', 'province')).entries[0].value, 400)
  }
  now += 86400
  await finish(first, 'tuesday', now, 250, 30)
  assert.equal((await board('day', 'area')).self.value, 10000)
  assert.deepEqual((await board('week', 'area')).self, { player_id: playerId(first), rank: 2, value: 5000 })
  now = monday + 7 * 86400
  assert.deepEqual((await board('week', 'area')).entries, [])
  assert.equal((await board('month', 'area')).self.value, 5000)
  assert.equal((await board('month', 'distance', 'province')).entries[0].value, 800)
})

test('全国榜未满时复用榜单判断名次和零分，未登录请求在读榜前拦截', async () => {
  const { repo, reads } = database()
  const grid = new Grid()
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, {}), undefined, () => 1120)
  const board = 'national:day:1970-01-01'
  const context = name => ({ APPID: 'test', OPENID: name })
  async function seed(name, distance, loggedIn = true, reachedAt = 1000) {
    const subject = playerId(context(name))
    await repo.set('a' + subject.slice(3, 34), { runner_number: 1, avatar_url: loggedIn ? 'cloud://avatar' : '' })
    await repo.setScore(scoreKey(board, subject), { board, subject, distance_units: distance, area_units: 0, distance_reached_at: reachedAt })
    return subject
  }
  const viewer = await seed('viewer', 750)
  const tied = await seed('tied', 750, true, 1001)
  const top = await seed('top', 100000)
  for (let i = 0; i < 49; i++) await seed('runner' + i, 1000)
  await seed('logged-out', 500, false)
  await seed('zero', 0)
  async function call(identity, fields = {}) {
    reads.length = 0
    return handle({ action: 'leaderboard', metric: 'distance', include_self: true, ...fields }, identity)
  }
  const own = await call(context('viewer'), { expected_player: viewer })
  assert.deepEqual(own.self, { player_id: viewer, rank: 51, value: 0.75 })
  assert.deepEqual(reads, ['running_state:doc', board, 53])
  assert.deepEqual((await call(context('tied'))).self, { player_id: tied, rank: 52, value: 0.75 })
  assert.deepEqual(await call(context('viewer'), { offset: 999999 }), own)
  assert.deepEqual((await call(context('top'))).self, { player_id: top, rank: 1, value: 100 })
  assert.deepEqual((await call(context('viewer'), { metric: 'area' })).self, { player_id: viewer, rank: null, value: 0 })
  assert.deepEqual(reads, ['running_state:doc', board])
  assert.equal((await call(context('zero'))).self.rank, null)
  assert.deepEqual(reads, ['running_state:doc', board, 53])
  assert.equal((await call(context('logged-out'))).error.code, 'login_required')
  assert.deepEqual(reads, ['running_state:doc'])
  assert.equal((await call({}, { expected_player: viewer })).error.code, 'login_required')
  assert.deepEqual(reads, [])
  assert.equal((await call(context('top'), { expected_player: viewer })).error.code, 'account_changed')
  assert.deepEqual(reads, [])
  assert.equal((await call(context('top'), { scope: 'province' })).self, undefined)
  assert.deepEqual(reads, ['running_state:doc', 'province:day:1970-01-01'])
})

test('榜满时一次返回500位，榜外同分、低分及零分各只点读本人一条成绩', async () => {
  const { repo, reads } = database()
  const grid = new Grid()
  const now = Date.parse('2024-04-03T12:00:00+08:00') / 1000
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, {}), undefined, () => now)
  const weekly = 'national:week:2024-04-01'
  const context = name => ({ APPID: 'cap', OPENID: name })
  async function add(name, units, areaTime = 1000, distanceTime = 1000) {
    const subject = playerId(context(name))
    await repo.set('a' + subject.slice(3, 34), { runner_number: 1, display_name: name, avatar_url: 'cloud://avatar' })
    await repo.setScore(scoreKey(weekly, subject), {
      board: weekly, subject, area_units: units, distance_units: units, area_reached_at: areaTime, distance_reached_at: distanceTime
    })
    return { name, subject }
  }
  for (let i = 0; i < 499; i++) await add('leading' + i, 1000)
  const earlyArea = await add('earlyArea', 500, 1000, 1001)
  const earlyDistance = await add('earlyDistance', 500, 1001, 1000)
  const outside = await add('outside', 100)
  const zero = await add('zero', 0)
  for (const metric of ['area', 'distance']) {
    async function call(runner) {
      reads.length = 0
      return handle({ action: 'leaderboard', metric, period: 'week', include_self: true }, context(runner.name))
    }
    const [earlier, later] = metric === 'area' ? [earlyArea, earlyDistance] : [earlyDistance, earlyArea]
    const board = await call(earlier)
    assert.equal(board.entries.length, 500)
    assert.equal(board.rank_limit, 500)
    assert.equal('has_more' in board, false)
    assert.deepEqual(reads, ['running_state:doc', weekly, 100, 100, 100, 100, 100])
    const ids = new Set(board.entries.map(row => row.player_id))
    assert.equal(ids.size, 500)
    assert.equal(ids.has(later.subject), false)
    assert.equal(board.entries[498].rank, 499)
    const last = board.entries[499]
    assert.equal(last.player_id, earlier.subject)
    assert.equal(last.display_name, earlier.name)
    assert.equal(last.rank, 500)
    assert.deepEqual(board.self, { player_id: earlier.subject, rank: 500, value: last.value })
    const extraRead = ['running_state:doc', weekly, 100, 100, 100, 100, 100, 'running_scores:doc']
    assert.deepEqual((await call(later)).self, { player_id: later.subject, rank: null, outside_limit: true, value: last.value })
    assert.deepEqual(reads, extraRead)
    assert.deepEqual((await call(outside)).self, {
      player_id: outside.subject, rank: null, value: metric === 'area' ? 1 : 0.1, outside_limit: true
    })
    assert.deepEqual(reads, extraRead)
    assert.deepEqual((await call(zero)).self, { player_id: zero.subject, rank: null, value: 0 })
    assert.deepEqual(reads, extraRead)
  }
})

test('个人跑步从有效里程满 300 米起记，按北京时间归档并汇总跨年周、闰月和分块结算', async () => {
  const { repo } = database()
  const grid = new Grid()
  const owner = { APPID: 'diary', OPENID: 'owner' }, other = { APPID: 'diary', OPENID: 'other' }
  const player = playerId(owner), stranger = playerId(other)
  for (const id of [player, stranger]) {
    await repo.set('a' + id.slice(3, 34), { runner_number: 1, avatar_url: 'cloud://avatar', display_name: '跑者' })
  }
  let now = Date.parse('2025-01-01T00:00:01+08:00') / 1000
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, {}), undefined, () => now)
  const call = (action, fields = {}, ctx = owner) => handle({ action, ...fields }, ctx)
  const epoch = time => Date.parse(time + '+08:00') / 1000
  const empty = await call('runStats')
  assert.equal(empty.lifetime.count, 0)
  assert.equal(empty.lifetime.avg_pace_s_per_km, null)
  assert.equal(empty.buckets.length, 7)

  async function seed(run_id, date, distance_m, duration_s, packed, player_id = player) {
    const ended_at = epoch(date)
    const value = { distance_m, duration_s, pace_s_per_km: distance_m ? Math.round(1000 * duration_s / distance_m) : null,
      valid_loop: false }
    const result = packed ? { blocks: ['blob-' + run_id] } : { value }
    if (packed) await repo.set(result.blocks[0], { bytes: Buffer.from(JSON.stringify(value)).toString('base64') })
    await repo.set(run_id, { run_id, player_id, ended_at, started_at: ended_at - duration_s, result })
  }
  await seed('leap', '2024-02-29T23:59:59', 500, 125)
  await seed('sunday', '2024-12-29T23:59:59.999', 700, 420)
  await seed('monday', '2024-12-30T00:00:00', 1200, 540, true)
  const endedAt = epoch('2024-12-31T23:59:59')
  const cases = [['standing', 0, 60], ['short', 299.99, 60], ['fast-short', 200, 20], ['boundary', 300, 60], ['too-fast', 400, 60]]
  for (const [run_id, meters, seconds] of cases) {
    const first = { ...grid.toGeo(0, 0), accuracy: 5, timestamp: endedAt - seconds }
    const points = [{ ...grid.toGeo(meters, 0), accuracy: 5, timestamp: endedAt }]
    await call('start', { run_id, first_point: first })
    await call('append', { run_id, points })
    const result = await call('finish', { run_id, ended_at: endedAt })
    if (meters >= 300) {
      assert.equal(result.distance_m, meters)
      assert.equal(result.valid_loop, false)
      assert.equal(result.pace_anomaly, run_id === 'too-fast')
      assert.deepEqual((await call('getRun', { run_id, include_points: false })).result, result)
    } else {
      const expected = { recorded: false, run_id, player_id: player }
      if (run_id === 'fast-short') expected.pace_anomaly = true
      assert.deepEqual(result, expected)
      assert.equal((await call('start', { run_id, first_point: first })).status, 'finished')
      assert.equal((await call('append', { run_id, points })).error.code, 'run_finished')
      for (const include_points of [false, true]) {
        assert.equal((await call('getRun', { run_id, include_points })).error.code, 'run_not_found')
      }
    }
    assert.deepEqual(await call('finish', { run_id, ended_at: endedAt + 100 }), result)
  }
  assert.equal((await call('achievements')).milestones.total_distance.value, 700)
  assert.equal((await call('leaderboard', { metric: 'distance', period: 'week' })).entries[0].value, 700)
  await seed('new-year', '2025-01-01T00:00:00', 3000, 900)
  await seed('unrelated', '2025-01-01T00:00:00', 8000, 100, false, stranger)
  await repo.set('live', { run_id: 'live', player_id: player, ended_at: null, result: null })

  const weekly = await call('runStats', { player_id: stranger })
  assert.deepEqual([weekly.start, weekly.end], ['2024-12-30', '2025-01-05'])
  assert.deepEqual(weekly.summary, { count: 4, distance_m: 4900, duration_s: 1560,
    avg_distance_m: 1225, longest_distance_m: 3000, best_pace_s_per_km: 150, avg_pace_s_per_km: 318 })
  assert.deepEqual(weekly.buckets.map(b => b.count), [1,2,1,0,0,0,0])
  assert.deepEqual(weekly.buckets[0], { key: '2024-12-30', count: 1, distance_m: 1200, duration_s: 540 })
  assert.equal(weekly.lifetime.count, 6)
  assert.equal(weekly.lifetime.distance_m, 6100)
  assert.deepEqual((await call('me')).running_summary, weekly.lifetime)
  const monthly = await call('runStats', { period: 'month', offset: -11 })
  assert.equal(monthly.end, '2024-02-29')
  assert.equal(monthly.buckets.length, 29)
  assert.equal(monthly.buckets[28].count, 1)
  const annual = await call('runStats', { period: 'year', offset: -1 })
  assert.equal(annual.buckets.length, 12)
  assert.equal(annual.buckets[11].key, '2024-12')
  assert.equal(annual.buckets[11].count, 4)
  const december = await call('runHistory', { period: 'year', start: annual.start, bucket: '2024-12' })
  assert.deepEqual(december.runs.map(r => r.run_id), ['too-fast', 'boundary', 'monday', 'sunday'])
  assert.equal(december.runs[0].pace_anomaly, true)
  assert.equal(december.runs[1].pace_anomaly, false)
  const { pace_anomaly, ...mondayRun } = december.runs[2]
  assert.equal(pace_anomaly, undefined)
  assert.deepEqual(mondayRun, { run_id: 'monday', ended_at: epoch('2024-12-30T00:00:00'),
    distance_m: 1200, duration_s: 540, pace_s_per_km: 450, valid_loop: false })
  assert.equal(december.next_cursor, null)
  now += 7 * 86400
  assert.equal((await call('runHistory', { period: 'week', start: weekly.start })).runs.length, 4)
  assert.equal((await call('runStats', { offset: 1 })).error.code, 'invalid_offset')
  assert.equal((await call('runStats', { period: 'day' })).error.code, 'invalid_period')
  assert.equal((await call('runHistory', { bucket: '2025-02-30' })).error.code, 'invalid_bucket')
  assert.equal((await call('runHistory', { start: '2025-01-01' })).error.code, 'invalid_start')
  assert.equal((await call('runHistory', { cursor: '{}' })).error.code, 'invalid_cursor')
  for (const action of ['runStats', 'runHistory']) {
    assert.equal((await call(action, {}, {})).error.code, 'login_required')
    assert.equal((await call(action, { expected_player: player }, other)).error.code, 'account_changed')
  }
})

test('同一完赛时间按编号稳定翻页，明细查询可以省略轨迹并保留完整分块结算', async () => {
  const { createHash } = require('node:crypto')
  const { repo } = database()
  const grid = new Grid()
  const who = { APPID: 'diary', OPENID: 'runner' }, player = playerId(who)
  await repo.set('a' + player.slice(3, 34), { runner_number: 1, avatar_url: 'cloud://avatar', display_name: '跑者' })
  const ended_at = Date.parse('2026-11-24T10:00:00+08:00') / 1000
  const run = { player_id: player, ended_at, started_at: ended_at - 60, point_count: 3,
    points: { blocks: ['unread-track'] } }
  const stats = { distance_m: 300, duration_s: 60, pace_s_per_km: 200, valid_loop: false }
  const full = { ...stats, reason_messages: ['轨迹未闭合'], outcomes: [] }
  await repo.set('result-block', { bytes: Buffer.from(JSON.stringify(full)).toString('base64') })
  const key = id => 'r' + createHash('sha256').update(id).digest('hex').slice(0, 31)
  for (let i = 0; i < 23; i++) {
    const id = 'tie-' + String(i).padStart(2, '0')
    await repo.set(key(id), { ...run, run_id: id, result: { value: stats, blocks: ['result-block'] } })
  }
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, {}), undefined, () => ended_at)
  const call = (action, fields) => handle({ action, ...fields }, who)
  const week = await call('runStats')
  assert.equal(week.summary.count, 23)
  const first = await call('runHistory', { bucket: '2026-11-24' })
  assert.equal(first.runs.length, 20)
  assert.equal(first.runs[0].run_id, 'tie-22')
  await repo.set(key('newer'), { ...run, run_id: 'newer', ended_at: ended_at + 1, result: { value: stats } })
  const next = await call('runHistory', { bucket: '2026-11-24', cursor: first.next_cursor })
  assert.deepEqual(next.runs.map(r => r.run_id), ['tie-02', 'tie-01', 'tie-00'])
  assert.equal(next.next_cursor, null)
  const record = await call('getRun', { run_id: 'tie-01', include_points: false })
  assert.equal('points' in record, false)
  assert.deepEqual(record.result, full)
  assert.equal((await call('getRun', { run_id: 'tie-01' })).error.code, 'storage_unavailable')
})

test('个人资料只为微信登录账号的当前头像签发 COS 地址，签名失败仍可读取资料和统计', async () => {
  const { repo } = database()
  const grid = new Grid()
  const alice = { APPID: 'profile', OPENID: 'a' }, bob = { APPID: 'profile', OPENID: 'b' }
  const ownFile = 'cloud://env.bucket/running-avatars/alice.jpg'
  const otherFile = 'cloud://env.bucket/running-avatars/bob.jpg'
  for (const [context, file] of [[alice, ownFile], [bob, otherFile]]) {
    await repo.set('a' + playerId(context).slice(3, 34), { runner_number: 1, display_name: '跑者', avatar_url: file })
  }

  const url = 'https://bucket.cos.example/running-avatars/alice.jpg?signature=test'
  const signed = []
  let response = { fileList: [{ fileID: ownFile, status: 0, tempFileURL: url }] }
  const cloud = { async getTempFileURL(options) {
    signed.push(options)
    if (response instanceof Error) throw response
    return response
  } }
  const handle = createHandler(grid, createRuns(repo, grid), createAccounts(repo, cloud))
  const call = (context, fields) => handle({ action: 'me', ...fields }, context)
  assert.equal((await call({}, { fileID: ownFile })).error.code, 'login_required')
  assert.equal((await call(bob, { expected_player: playerId(alice) })).error.code, 'account_changed')
  assert.equal(signed.length, 0)
  const account = await call(alice, { fileID: otherFile, avatar_url: otherFile, player_id: playerId(bob) })
  assert.deepEqual(signed, [{ fileList: [{ fileID: ownFile, maxAge: 600, urlType: 'COS_URL' }] }])
  assert.equal(account.avatar_url, ownFile)
  assert.equal(account.avatar_display_url, url)
  assert.equal(account.running_summary.count, 0)

  for (const failure of [
    { fileList: [{ fileID: ownFile, status: 1, tempFileURL: '' }] },
    { fileList: [{ fileID: otherFile, status: 0, tempFileURL: url }] },
    new Error('云存储超时')
  ]) {
    response = failure
    assert.deepEqual(await call(alice), { ...account, avatar_display_url: '' })
  }
})

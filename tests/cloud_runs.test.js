const test = require('node:test')
const assert = require('node:assert/strict')
const { createRuns } = require('../cloudfunctions/running/runs')
const { buildLandIndex, queryLandIndex } = require('../cloudfunctions/running/land-index')
const { Grid } = require('../cloudfunctions/running/geometry')
const { buildLossReports } = require('../cloudfunctions/running/reports')
const { AREA_UNITS, DISTANCE_UNITS, scoreKey, scorePeriods, periodBoard } = require('../cloudfunctions/running/score-totals')

// Independent callers can read concurrently. The mock publishes each group of
// writes atomically, just like cloud runTransaction.
function repository() {
  const docs = new Map()
  const scores = new Map()
  let queue = Promise.resolve()
  const get = async id => structuredClone(docs.get(id) ?? null)
  const set = async (id, data) => { docs.set(id, structuredClone(data)) }
  return {
    get, getRunResult: get, getRunShareSummary: get, set, docs, scores,
    getScore: async id => structuredClone(scores.get(id) ?? null),
    async getMapView(key) {
      const map = docs.get(key)
      if (!map) return null
      const { origin, revision, next_id, viewRoot, viewRevision, settlementRevision } = map
      return structuredClone({ origin, revision, next_id, viewRoot, viewRevision, settlementRevision })
    },
    async getMapNodes(keys) {
      return new Map(keys.filter(key => docs.has(key)).map(key => [key, structuredClone(docs.get(key))]))
    },
    async lossReportRows(player, before, limit) {
      return [...docs.values()].filter(row => row.report?.recipient === player && (before == null || row.loss_revision < before))
        .sort((a, b) => b.loss_revision - a.loss_revision).slice(0, limit)
    },
    async reportBoundaryRef(player, id) {
      const row = docs.get(id)
      return row?.report.recipient === player ? (row.boundaries || {}) : null
    },
    async scoreBoard(metric, scope, periodKey) {
      const board = periodBoard(scope, periodKey)
      const field = metric === 'area' ? 'area_units' : 'distance_units'
      const reachedAt = metric + '_reached_at'
      const factor = metric === 'area' ? AREA_UNITS : DISTANCE_UNITS
      const rows = [...scores.values()].filter(row => row.board === board && row[field] > 0)
        .sort((a, b) => b[field] - a[field] || a[reachedAt] - b[reachedAt] || a.subject.localeCompare(b.subject))
      const entries = rows.map((row, i) => ({ rank: i + 1, subject: row.subject, value: row[field] / factor }))
      return scope === 'national' ? { metric, rank_limit: 500, entries: entries.slice(0, 500) } : { metric, entries }
    },
    async *finishedRuns() {
      for (const doc of docs.values()) {
        if (Number.isFinite(doc.ended_at)) yield structuredClone(doc)
      }
    },
    transaction(fn) {
      const run = queue.then(async () => {
        const writes = new Map(), scoreWrites = new Map()
        const result = await fn({
          getScore: async id => structuredClone(scores.get(id) ?? null),
          setScore: async (id, data) => { scoreWrites.set(id, structuredClone(data)) },
          get, set: async (id, data) => { writes.set(id, structuredClone(data)) }
        })
        for (const [id, data] of writes) docs.set(id, data)
        for (const [id, data] of scoreWrites) scores.set(id, data)
        return result
      })
      queue = run.catch(() => {})
      return run
    }
  }
}

const grid = new Grid()
function fix(timestamp, x = 0, y = 0, accuracy = 5) {
  return { ...grid.toGeo(x, y), timestamp, accuracy }
}

const square = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]
const loop = square.map(([x, y], i) => fix(1000 + 30 * i, x, y))

test('多层空间索引只读取局部地块，多视窗重叠时不重读，更新后旧快照仍可读', async t => {
  const repo = repository()
  const lands = Array.from({ length: 1024 }, (_, id) => {
    const x = id % 32 * 1000, y = Math.floor(id / 32) * 1000
    return { id, owner: 'A', pace_s_per_km: 300, shape: [square.map(([dx, dy]) => [x + dx, y + dy])] }
  })
  const pack = (_, value) => ({ value }), unpack = (_, ref) => ref.value
  const root = await buildLandIndex(repo, [], lands, pack)
  const reads = t.mock.method(repo, 'getMapNodes')
  const boxes = [[995, 1995, 2020, 2020], [1000, 2000, 1010, 2010]]
  const found = await queryLandIndex(repo, root, boxes, unpack)
  const expected = [65, 66]
  assert.deepEqual(found.map(land => land.id).sort((a, b) => a - b), expected)
  const keys = reads.mock.calls.flatMap(call => call.arguments[0])
  assert.equal(new Set(keys).size, keys.length)
  const fetchedLands = keys.map(key => repo.docs.get(key).value).filter(Boolean)
  assert.deepEqual(fetchedLands.map(land => land.id).sort((a, b) => a - b), expected)
  assert.ok(keys.length < 32, '局部视野只访问相交分支')

  const next = lands.filter(land => land.id !== 65)
  const nextRoot = await buildLandIndex(repo, lands, next, pack)
  assert.deepEqual((await queryLandIndex(repo, nextRoot, boxes, unpack)).map(land => land.id), [66])
  assert.equal((await queryLandIndex(repo, root, boxes, unpack)).length, 2)
})

test('视野查询在夺地分割后返回相交的各块，附近查询跳过远处地块', async t => {
  const model = new Grid()
  const repo = repository()
  const writer = createRuns(repo, model), reader = createRuns(repo, model)
  async function runRectangle(owner, left, bottom, right, top, interval) {
    const points = [[left,bottom], [right,bottom], [right,top], [left,top], [left,bottom]]
      .map(([x, y], i) => fix(1000 + interval * i, x, y))
    await writer.start(owner, owner, 1000, points[0])
    const result = await writer.finish(owner, owner, points.at(-1).timestamp, points)
    assert.equal(result.valid_loop, true)
  }
  async function viewport(left, bottom, right, top) {
    const sw = model.toGeo(left, bottom), ne = model.toGeo(right, top)
    return (await reader.territories(sw.longitude, sw.latitude, ne.longitude, ne.latitude)).territories
  }

  await runRectangle('original', 0, 0, 200, 200, 50)
  const [original] = await viewport(0, 0, 200, 200)
  await runRectangle('distant', 800000, 0, 800100, 100, 30)
  await runRectangle('challenger', 60, -20, 140, 220, 34)
  assert.deepEqual((await viewport(800000, 0, 800100, 100)).map(land => land.owner), ['distant'])

  const preciseCheck = t.mock.method(model, 'visible')
  const reads = t.mock.method(repo, 'get')
  const mapReads = t.mock.method(repo, 'getMapNodes')
  const [left] = await viewport(10, 10, 20, 20)
  const [middle] = await viewport(70, 10, 80, 20)
  const [right] = await viewport(145, 10, 155, 20)
  assert.deepEqual([left.owner, middle.owner, right.owner], ['original', 'challenger', 'original'])
  const ids = [left.id, middle.id, right.id]
  assert.equal(new Set(ids).size, 3)
  assert.ok(!ids.includes(original.id))
  assert.deepEqual((await viewport(-10, 90, 210, 91)).map(land => land.id), ids.sort((a, b) => a - b))
  assert.deepEqual(await viewport(210, 210, 230, 230), [])
  assert.ok(preciseCheck.mock.calls.every(({ arguments: [shape] }) => shape[0][0][0] < 800000),
    '附近视野不应逐一检查远处地块的轮廓')
  assert.ok(reads.mock.calls.every(({ arguments: [key] }) => key !== 'park-map'),
    '视野查询不应读取包含全部地块的完整地图文档')
  for (const call of mapReads.mock.calls) {
    for (const key of call.arguments[0]) assert.notEqual(repo.docs.get(key).value?.owner, 'distant')
  }
})

test('地块跨经度换日线且含洞时，战报位置仍位于失地内部', () => {
  const border = new Grid(31, 179.9998)
  const outer = square
  const hole = [[10,10],[90,10],[90,90],[10,90],[10,10]]
  const formerLand = { shape: [outer, hole], owner: 'old', pace_s_per_km: 400 }
  const { outcomes } = border.settle([formerLand], 'new', 350, [outer])
  const [report] = buildLossReports({ run_id: 'run', player_id: 'new', ended_at: 1000, pace_s_per_km: 350, outcomes })
  const captured = outcomes.find(part => part.outcome === 'captured')
  assert.deepEqual(report.regions, [{ ...captured.label_point, area_m2: captured.area_m2 }])
  const { latitude, longitude } = report.regions[0]
  const [x, y] = border.toXY(latitude, longitude)
  assert.ok(x > 0 && x < 100 && y > 0 && y < 100)
  assert.ok(x < 10 || x > 90 || y < 10 || y > 90)
})

test('局部完赛与全量结算逐场一致，保留远处面积且只读取本次圈地附近的地块', async t => {
  const model = new Grid()
  const repo = repository(), runs = createRuns(repo, model)
  // 前两块按历史版本入账，同一轮廓的现行测量值与原值有差异。
  const currentArea = model.measureArea.bind(model)
  const historicArea = t.mock.method(model, 'measureArea', shape => currentArea(shape) + 14.25)
  const reads = t.mock.method(repo, 'get')
  const nodeReads = t.mock.method(repo, 'getMapNodes')
  const players = new Set()
  let lands = [], nextId = 1, peakArea = 0, splitReads = []
  const cases = [
    // 跑者、场次、矩形两端坐标和每条边的用时（秒）。
    ['A', 'far', 800000, 0, 800100, 100, 30],
    ['A', 'near', 0, 0, 100, 100, 30],
    ['A', 'shared-edge', 100, 0, 200, 100, 30],
    ['A', 'shared-point', 200, 100, 300, 200, 30],
    ['E', 'neighbour', 200, 0, 300, 100, 32],
    ['C', 'slow', 40, 0, 160, 100, 40],
    ['B', 'split', 70, -25, 130, 125, 22],
    ['D', 'mixed', 25, -10, 280, 150, 42]
  ]
  for (const [owner, runId, left, bottom, right, top, interval] of cases) {
    if (runId === 'shared-edge') historicArea.mock.restore()
    const points = [[left,bottom], [right,bottom], [right,top], [left,top], [left,bottom]]
      .map(([x, y], i) => fix(1000 + i * interval, x, y))
    const end = points.at(-1).timestamp
    const analysis = model.analyze(1000, end, points)
    assert.equal(analysis.valid_loop, true, runId)
    const expected = model.settle(lands, owner, analysis.pace_s_per_km, analysis.polygon)
    lands = expected.lands.map(land => land.id == null ? { ...land, id: nextId++ } : land)

    await runs.start(owner, runId, 1000, points[0])
    reads.mock.resetCalls()
    nodeReads.mock.resetCalls()
    const actual = await runs.finish(owner, runId, end, points)
    if (runId === 'split') {
      const docs = await Promise.all(reads.mock.calls.map(call => call.result))
      const batches = await Promise.all(nodeReads.mock.calls.map(call => call.result))
      splitReads = docs.concat(batches.flatMap(batch => [...batch.values()])).filter(Boolean)
    }
    assert.deepEqual(actual.outcomes, expected.outcomes, runId)
    const all = await runs.territories(-180, -90, 180, 90)
    const territories = lands.map(({ id, owner, pace_s_per_km, shape }) => ({
      id, owner, pace_s_per_km, ...model.describe(shape)
    })).sort((a, b) => a.id - b.id)
    assert.deepEqual(all.territories, territories, runId)
    players.add(owner)
    for (const player of players) {
      const owned = lands.filter(land => land.owner === player)
      const area = owned.reduce((sum, land) => sum + land.area_m2, 0)
      assert.deepEqual(await runs.playerSummary(player), {
        player_id: player, territory_count: owned.length, area_m2: area
      }, runId)
      if (player === 'A') peakArea = Math.max(peakArea, area)
    }
    assert.equal((await runs.achievements('A')).records.peak_area.value, peakArea, runId)
  }
  for (const doc of splitReads) {
    assert.ok(!doc.lands?.value?.length, '局部完赛不应加载全量地块数组')
    const shape = doc.value?.shape
    assert.ok(!shape || shape[0][0][0] < 800000, '局部完赛不应读取八百公里外的地块轮廓')
  }
})

test('只给失地主各记一份战报；同场多块合并，同速并发挑战与重复完赛不重记', async () => {
  const runs = createRuns(repository(), grid)
  async function finish(player, id, points) {
    await runs.start(player, id, points[0].timestamp, points[0])
    return runs.finish(player, id, points.at(-1).timestamp, points)
  }
  for (const [owner, x] of [['A', 0], ['A', 150], ['C', 300]]) {
    await finish(owner, 'claim-' + x, square.map(([dx, y], i) => fix(1000 + 30 * i, x + dx, y)))
  }
  await finish('A', 'defend', loop)
  assert.deepEqual(await runs.lossReports('A'), { reports: [], next_cursor: null })
  const route = [[50,0],[400,0],[400,100],[50,100],[50,0]].map(([x,y], i) => fix(2000 + 45 * i, x, y))
  const outcomes = await Promise.all(['B','D'].map(player => finish(player, 'challenge-' + player, route)))
  const winningRun = outcomes.find(result => result.outcomes.some(part => part.outcome === 'captured'))
  await runs.finish(winningRun.player_id, winningRun.run_id, 2200)
  const first = await runs.lossReports('A'), second = await runs.lossReports('C')
  assert.equal(first.reports.length, 1)
  assert.equal(second.reports.length, 1)
  assert.equal(first.next_cursor, null)
  const a = first.reports[0], c = second.reports[0]
  assert.equal(a.challenger, winningRun.player_id)
  assert.equal(a.ended_at, route.at(-1).timestamp)
  assert.equal(a.pace_s_per_km, winningRun.pace_s_per_km)
  assert.notEqual(a.id, c.id)
  assert.equal(a.area_m2, 15000)
  assert.equal(c.area_m2, 10000)
  assert.deepEqual(a.regions.map(region => region.area_m2).sort((l,r) => l-r), [5000, 10000])
  assert.equal(c.regions.length, 1)
  for (const [recipient, report] of [['A', a], ['C', c]]) {
    const captures = winningRun.outcomes.filter(part => part.outcome === 'captured' && part.previous_owner === recipient)
    for (const [index, part] of captures.entries()) {
      assert.deepEqual(await runs.lossReportBoundary(recipient, report.id, index), { geometry: part.geometry })
    }
  }
  for (const region of [...a.regions, ...c.regions]) {
    assert.deepEqual(Object.keys(region).sort(), ['area_m2', 'latitude', 'longitude'])
    const [x, y] = grid.toXY(region.latitude, region.longitude)
    assert.ok(y > 0 && y < 100)
    if (c.regions.includes(region)) assert.ok(x > 300 && x < 400)
    else assert.ok((x > 50 && x < 100) || (x > 150 && x < 250))
  }
  assert.deepEqual((await runs.lossReports('D')).reports, [])
  assert.deepEqual((await runs.lossReports('B')).reports, [])
})

test('战报分页固定在提交顺序；补传完赛时间和后来产生的新战报不扰乱下一页', async () => {
  const repo = repository()
  const runs = createRuns(repo, grid)
  async function insert(revision, recipient = 'A') {
    const report = { id: 'report-' + revision, recipient, ended_at: 2000 - revision }
    await repo.set(report.id, { loss_revision: revision, report })
  }
  for (let i = 1; i <= 22; i++) await insert(i)
  await insert(23, 'B')
  const first = await runs.lossReports('A')
  assert.deepEqual(first.reports.map(r => r.id), Array.from({ length: 20 }, (_, i) => 'report-' + (22 - i)))
  assert.equal(first.next_cursor, 3)
  await insert(24)
  const second = await runs.lossReports('A', first.next_cursor)
  assert.deepEqual(second.reports.map(r => r.id), ['report-2', 'report-1'])
  assert.equal(second.next_cursor, null)
  await assert.rejects(runs.lossReports('A', '3'), { code: 'invalid_cursor' })
})

test('competing finishes publish one owner and stable, independently replayable results', async () => {
  const repo = repository()
  const a = createRuns(repo, grid), b = createRuns(repo, grid)
  await Promise.all([a.start('A', 'A', 1000, loop[0]), b.start('B', 'B', 1000, loop[0])])
  const results = await Promise.all([a.finish('A', 'A', 1120, loop), b.finish('B', 'B', 1120, loop)])
  assert.deepEqual(results.map(r => r.outcomes[0].outcome).sort(), ['claimed', 'failed'])
  const winner = results.find(r => r.outcomes[0].outcome === 'claimed').player_id
  const loser = winner === 'A' ? 'B' : 'A'
  const { territories } = await a.territories(-180, -90, 180, 90)
  assert.equal(territories.length, 1)
  assert.equal(territories[0].id, 1)
  assert.equal(territories[0].owner, winner)
  assert.equal(territories[0].area_m2, 10000)
  assert.deepEqual(await b.playerSummary(loser), {player_id: loser, territory_count: 0, area_m2: 0})
  assert.deepEqual(await a.playerSummary(winner), {player_id: winner, territory_count: 1, area_m2: 10000})
  assert.deepEqual(await b.finish('A', 'A', 1250, []), results[0])
  assert.deepEqual(await a.get('B', 'B').then(r => r.result), results[1])
  await assert.rejects(a.append('A', 'A', []), { code: 'run_finished' })
})

test('run ownership, retries and concurrent overlapping GPS uploads preserve the best sample', async () => {
  const repo = repository()
  const a = createRuns(repo, grid), b = createRuns(repo, grid)
  const start = await a.start('A', 'run', 1000, loop[0])
  assert.deepEqual(await b.start('A', 'run', 1000, loop[0]), start)
  await assert.rejects(b.start('B', 'run', 1000, loop[0]), { code: 'run_id_conflict' })
  await assert.rejects(b.get('B', 'run'), { code: 'run_not_found' })
  await assert.rejects(a.finish('A', 'run', 999, []), { code: 'invalid_end_time' })
  const better = fix(1001, 50, 30, 4)
  await Promise.all([
    a.append('A', 'run', [fix(1001, 30, 20, 5), fix(1002)]),
    b.append('A', 'run', [fix(1003), better, fix(1001, 60, 30, 4)])
  ])
  const saved = await a.get('A', 'run')
  assert.equal(saved.point_count, 4)
  assert.deepEqual(saved.points, [loop[0], better, fix(1002), fix(1003)])
  const otherOrigin = createRuns(repo, new Grid(35, 120))
  await assert.rejects(otherOrigin.start('C', 'other', 1000, loop[0]), { code: 'origin_mismatch' })
})

test('leaderboards use current land ownership and each finished run’s distance once', async () => {
  const runs = createRuns(repository(), grid)
  async function run(player, id, route, interval) {
    const points = route.map(([x, y], i) => fix(1000 + i * interval, x, y))
    await runs.start(player, id, 1000, points[0])
    return runs.finish(player, id, points.at(-1).timestamp, points)
  }
  await run('A', 'claim', square, 30)
  await run('A', 'defend', square, 30)
  assert.deepEqual((await runs.leaderboard('area')).entries, [
    { rank: 1, subject: 'A', value: 10000 }
  ])

  // B wins the right half of A's square and claims the same area next to it.
  await run('B', 'capture', square.map(([x, y]) => [x + 50, y]), 20)
  await run('A', 'separate-land', [[300, 0], [360, 0], [360, 90], [300, 90], [300, 0]], 30)
  const open = await run('B', 'open', [[0, 0], [250, 0], [500, 0], [750, 0], [1000, 0]], 55)
  assert.equal(open.valid_loop, false)
  await runs.finish('B', 'open', open.ended_at)
  await runs.start('C', 'unfinished', 1000, fix(1000))
  await runs.append('C', 'unfinished', [fix(1030, 1500)])

  assert.deepEqual((await runs.leaderboard('area')).entries, [
    { rank: 1, subject: 'A', value: 10400 }, { rank: 2, subject: 'B', value: 10000 }
  ])
  assert.deepEqual((await runs.leaderboard('distance')).entries, [
    { rank: 1, subject: 'B', value: 1400 }, { rank: 2, subject: 'A', value: 1100 }
  ])
})

test('长空档和局部高速可以圈地，按整场点位累计全国和省份里程', async () => {
  const runs = createRuns(repository(), grid)
  const points = [fix(1000), fix(1206, 100), fix(1208, 100, 100), fix(1238, 0, 100), fix(1268)]
  await runs.start('A', 'walk', 1000, points[0])
  await runs.append('A', 'walk', points.slice(1, 3))
  const result = await runs.finish('A', 'walk', 1268, points.slice(3))
  assert.equal(result.valid_loop, true)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.pace_anomaly, false)
  assert.equal(result.max_gap_s, 206)
  assert.equal(result.valid_point_count, 5)
  assert.equal(result.distance_m, 400)
  assert.equal(result.pace_s_per_km, 670)
  assert.equal(result.area_m2, 10000)

  const saved = await runs.get('A', 'walk')
  assert.deepEqual(saved.points, points)
  assert.deepEqual(saved.result, result)
  assert.deepEqual(await runs.finish('A', 'walk', 1300), result)
  const { territories } = await runs.territories(-180, -90, 180, 90)
  assert.equal(territories.length, 1)
  assert.equal(territories[0].owner, 'A')
  assert.equal(territories[0].pace_s_per_km, 670)
  assert.deepEqual((await runs.leaderboard('distance')).entries, [{ rank: 1, subject: 'A', value: 400 }])
  assert.deepEqual((await runs.leaderboard('distance', 'province')).entries, [{ rank: 1, subject: '310000', value: 400 }])
})

test('沙漏与 8 字路线各圈出两块地，每个闭环分别新占或夺地，一次完赛只记一份里程', async () => {
  const corners = [[-60, -80], [60, 80], [-60, 80], [60, -80], [-60, -80]]
  for (const occupied of [false, true]) {
    const runs = createRuns(repository(), grid)
    if (occupied) {
      // 原地块覆盖两个三角形各自的右半边。
      const lot = [[0, -80], [80, -80], [80, 80], [0, 80], [0, -80]]
        .map(([x, y], i) => fix(1000 + i * 80, x, y))
      await runs.start('A', 'lot', 1000, lot[0])
      await runs.finish('A', 'lot', lot.at(-1).timestamp, lot)
    }
    // 沙漏的交点在两段线的中途，8 字路线在交点处也有原始定位。
    const route = occupied ? [corners[0], [0, 0], corners[1], corners[2], [0, 0], ...corners.slice(3)] : corners
    const points = route.map(([x, y], i) => fix(2000 + i * 40, x, y))
    await runs.start('B', 'eight', 2000, points[0])
    await runs.append('B', 'eight', points.slice(1, 3))
    const result = await runs.finish('B', 'eight', points.at(-1).timestamp, points.slice(3))
    assert.equal(result.valid_loop, true)
    assert.deepEqual(result.reasons, [])
    assert.equal(result.distance_m, 640)
    assert.equal(result.area_m2, 9600)
    assert.deepEqual((await runs.get('B', 'eight')).points, points)
    assert.deepEqual(await runs.finish('B', 'eight', 3000), result)
    const { territories } = await runs.territories(-180, -90, 180, 90)
    assert.deepEqual(territories.filter(row => row.owner === 'B').map(row => row.area_m2), [4800, 4800])
    assert.deepEqual(result.outcomes.filter(row => row.outcome === 'claimed').map(row => row.area_m2),
      occupied ? [2400, 2400] : [4800, 4800])
    assert.deepEqual(result.outcomes.filter(row => row.outcome === 'captured').map(row => row.area_m2),
      occupied ? [2400, 2400] : [])
    assert.equal((await runs.playerSummary('A')).area_m2, occupied ? 8000 : 0)
    const score = await runs.achievements('B')
    assert.equal(score.milestones.total_distance.value, 640)
    assert.equal(score.milestones.capture_runs.value, occupied ? 1 : 0)
    assert.equal((await runs.leaderboard('distance')).entries.find(row => row.subject === 'B').value, 640)
    if (occupied) {
      const { reports } = await runs.lossReports('A')
      assert.equal(reports.length, 1)
      assert.equal(reports[0].area_m2, 4800)
    }
  }
})

test('厘米级尖刺保留实跑里程和主区域，纯往返记录里程但不产生领地', async () => {
  const runs = createRuns(repository(), grid)
  const spike = [[0, 0], [50, 0], [50.025, 0], [50, 0], ...square.slice(1)]
  const points = spike.map(([x, y], i) => fix(1000 + i * 20, x, y))
  await runs.start('A', 'spike', 1000, points[0])
  const claimed = await runs.finish('A', 'spike', points.at(-1).timestamp, points)
  assert.deepEqual(claimed.reasons, [])
  assert.equal(claimed.valid_loop, true)
  assert.ok(Math.abs(claimed.distance_m - 400.05) < 1e-6)
  assert.equal(claimed.area_m2, 10000)
  assert.deepEqual((await runs.get('A', 'spike')).points, points)
  assert.equal((await runs.playerSummary('A')).territory_count, 1)

  const outAndBack = [fix(2000), fix(2100, 250), fix(2200)]
  await runs.start('B', 'out-and-back', 2000, outAndBack[0])
  const result = await runs.finish('B', 'out-and-back', 2200, outAndBack)
  assert.equal(result.distance_m, 500)
  assert.equal(result.valid_loop, false)
  assert.deepEqual(result.outcomes, [])
  assert.equal((await runs.playerSummary('B')).territory_count, 0)
})

test('开放路线按所有实际围住的区域结算，进出闭环的路段只计里程', async t => {
  // 先走完底线，再用折线在底线上下穿行。交点均在采样点之间。
  const triangles = [[200, 0], [0, 0], [20, 20], [60, -20], [100, 20], [140, -20], [180, 20], [220, 60]]
  const cases = [
    { name: '折线穿越同一直线围成四个三角形', route: triangles, area: 1600, parcels: [400, 400, 400, 400] },
    { name: '长路线中途绕完十二米见方的小圈', route: [[-300, 0], [0, 0], [12, 0], [12, 12], [0, 12], [0, 0], [0, -200]],
      area: 144, parcels: [144] },
    { name: '开口折线两端相距一百二十米', route: [[0, 0], [0, 120], [120, 120], [120, 0]],
      area: 0, parcels: [] }
  ]
  for (const { name, route, area, parcels } of cases) await t.test(name, async () => {
    const runs = createRuns(repository(), grid)
    const points = route.map(([x, y], i) => fix(1000 + i * 35, x, y))
    await runs.start('A', 'open', 1000, points[0])
    const result = await runs.finish('A', 'open', points.at(-1).timestamp, points.slice(1))
    assert.equal(result.valid_loop, area > 0)
    assert.equal(result.area_m2, area)
    const distance = route.slice(1).reduce((meters, [x, y], i) =>
      meters + Math.hypot(x - route[i][0], y - route[i][1]), 0)
    assert.ok(Math.abs(result.distance_m - distance) < 1e-6)
    const { territories } = await runs.territories(-180, -90, 180, 90)
    assert.deepEqual(territories.map(land => land.area_m2), parcels)
    assert.equal((await runs.playerSummary('A')).area_m2, area)
  })
})

test('反向重走同一区域和嵌套反绕均保留完整领地，围住的面积只计一次', async t => {
  const reverse = square.slice(0, -1).reverse()
  const inner = [[25, 25], [25, 75], [75, 75], [75, 25], [25, 25], [0, 0]]
  for (const [name, extra] of [['原路反向绕一圈', reverse], ['外圈内部反绕一圈', inner]]) await t.test(name, async () => {
    const runs = createRuns(repository(), grid)
    const route = [...square, ...extra]
    const points = route.map(([x, y], i) => fix(1000 + i * 30, x, y))
    await runs.start('A', 'rewind', 1000, points[0])
    const result = await runs.finish('A', 'rewind', points.at(-1).timestamp, points.slice(1))
    assert.equal(result.valid_loop, true)
    assert.equal(result.area_m2, 10000)
    const claimed = result.outcomes.filter(row => row.outcome === 'claimed')
    assert.equal(claimed.reduce((sum, row) => sum + row.area_m2, 0), 10000)
    assert.equal((await runs.playerSummary('A')).area_m2, 10000)
    const sw = grid.toGeo(48, 48), ne = grid.toGeo(52, 52)
    const center = await runs.territories(sw.longitude, sw.latitude, ne.longitude, ne.latitude)
    assert.deepEqual(center.territories.map(land => land.owner), ['A'])
  })
})

test('整场不足三百米即使围成闭环也只返回重试回执', async () => {
  const runs = createRuns(repository(), grid)
  const points = square.map(([x, y], i) => fix(1000 + i * 25, x / 2, y / 2))
  await runs.start('A', 'short-loop', 1000, points[0])
  const receipt = await runs.finish('A', 'short-loop', points.at(-1).timestamp, points)
  assert.deepEqual(receipt, { recorded: false, run_id: 'short-loop', player_id: 'A' })
  assert.deepEqual(await runs.finish('A', 'short-loop', 2000), receipt)
  await assert.rejects(runs.get('A', 'short-loop'), { code: 'run_not_found' })
  assert.deepEqual((await runs.leaderboard('distance')).entries, [])
  assert.equal((await runs.achievements('A')).milestones.total_distance.value, 0)
  assert.equal((await runs.playerSummary('A')).territory_count, 0)
})

test('超速闭环正常夺地、计里程和成就，异常标记随并发结算与重试保留', async () => {
  const runs = createRuns(repository(), grid)
  await runs.start('A', 'owner', 1000, loop[0])
  await runs.finish('A', 'owner', 1120, loop)

  const route = square.map(([x, y], i) => fix(2000 + 30 * i, 3 * x, 3 * y))
  await runs.start('B', 'too-fast', 2000, route[0])
  await runs.append('B', 'too-fast', route.slice(1, 3))
  const [result, concurrent] = await Promise.all([
    runs.finish('B', 'too-fast', 2120, route.slice(3)),
    runs.finish('B', 'too-fast', 2120, route.slice(3))
  ])
  assert.equal(result.run_id, 'too-fast')
  assert.equal(result.player_id, 'B')
  assert.equal(result.pace_anomaly, true)
  assert.equal(result.valid_loop, true)
  assert.deepEqual(result.reasons, [])
  assert.equal(result.distance_m, 1200)
  assert.equal(result.pace_s_per_km, 100)
  assert.deepEqual(result.kilometer_marks, [{ km: 1, elapsed_s: 100 }])
  assert.equal(result.best_split_s_per_km, 100)
  assert.equal(result.partial_km_duration_s, 20)
  assert.equal(result.outcomes.find(row => row.outcome === 'captured').area_m2, 10000)
  assert.deepEqual(concurrent, result)
  assert.deepEqual(await runs.finish('B', 'too-fast', 2300), result)
  assert.deepEqual((await runs.get('B', 'too-fast')).result, result)
  assert.equal((await runs.playerSummary('B')).area_m2, 90000)
  const achievements = await runs.achievements('B')
  assert.equal(achievements.milestones.total_distance.value, 1200)
  assert.equal(achievements.milestones.capture_runs.value, 1)
  assert.equal(achievements.records.fastest_1k.value, 100)
  assert.deepEqual((await runs.leaderboard('distance')).entries, [
    { rank: 1, subject: 'B', value: 1200 }, { rank: 2, subject: 'A', value: 400 }
  ])
  assert.deepEqual((await runs.leaderboard('distance', 'province')).entries, [{ rank: 1, subject: '310000', value: 1600 }])
})

test('同里程先结算的跑者名次更高', async t => {
  let serverTime = 100000
  t.mock.method(Date, 'now', () => ++serverTime)
  const runs = createRuns(repository(), grid)
  for (let i = 0; i < 52; i++) {
    const player = 'runner-' + (52 - i)
    const distance = i < 49 ? 350 : i < 51 ? 325 : 300
    await runs.start(player, player, 1000, fix(1000))
    await runs.finish(player, player, 1075, [fix(1075, distance)])
  }
  const { entries } = await runs.leaderboard('distance')
  assert.equal(entries.length, 52)
  assert.deepEqual(entries.slice(-3).map(row => [row.rank, row.subject]), [[50, 'runner-3'], [51, 'runner-2'], [52, 'runner-1']])
  assert.equal(new Set(entries.map(row => row.subject)).size, 52)
})

test('long GPS uploads remain readable from another instance and partial writes stay unpublished', async () => {
  const repo = repository()
  const runs = createRuns(repo, grid)
  await runs.start('A', 'long', 0, fix(0))
  const batch = Array.from({length: 4000}, (_, i) => fix(i + 1, i, 1))
  const set = repo.set
  let writes = 0
  repo.set = async (id, data) => {
    if (++writes === 2) throw new Error('interrupted upload')
    await set(id, data)
  }
  await assert.rejects(runs.append('A', 'long', batch), /interrupted upload/)
  assert.deepEqual((await runs.get('A', 'long')).points, [fix(0)])
  repo.set = set
  const fresh = createRuns(repo, grid)
  assert.equal((await fresh.append('A', 'long', batch)).point_count, batch.length + 1)
  assert.deepEqual((await runs.get('A', 'long')).points, [fix(0), ...batch])
  for (const [id, document] of repo.docs) {
    assert.ok(id.length <= 32)
    assert.ok(Buffer.byteLength(JSON.stringify(document)) < 512 * 1024)
  }
})

test('全国个人和全省集体成绩区分多人、两市、领地转移和重复完赛', async t => {
  let serverTime = 100000
  t.mock.method(Date, 'now', () => ++serverTime)
  const repo = repository()
  const runs = createRuns(repo, grid)
  async function visit(player, id, latitude, longitude, interval) {
    const path = [[0,0],[0.0015,0],[0.0015,0.0003],[0,0.0003],[0,0]]
    const fixes = path.map(([x,y], i) => ({ latitude: latitude+y, longitude: longitude+x, accuracy:5, timestamp:1000 + i*interval }))
    fixes.push({latitude:31.23, longitude:121.47, accuracy:90, timestamp:1035})
    await runs.start(player, id, 1000, fixes[0])
    return runs.finish(player, id, 1000 + 4*interval, fixes)
  }
  const h = await visit('A', 'hangzhou', 30.25, 120.15, 25)
  const firstTime = serverTime
  const n = await visit('B', 'ningbo', 29.87, 121.55, 25)
  const secondTime = serverTime
  const captured = await visit('B', 'capture', 30.25, 120.15, 20)
  const captureTime = serverTime
  assert.equal(captured.outcomes[0].outcome, 'captured')
  await runs.finish('B', 'capture', captured.ended_at)
  for (const period of [undefined, ...Object.values(scorePeriods(captured.ended_at))]) {
    const subjects = [
      ['national', 'A', captureTime, firstTime],
      ['national', 'B', captureTime, captureTime],
      ['province', '330000', secondTime, captureTime]
    ]
    for (const [scope, subject, areaTime, distanceTime] of subjects) {
      const row = repo.scores.get(scoreKey(periodBoard(scope, period), subject))
      assert.deepEqual([row.area_reached_at, row.distance_reached_at], [areaTime, distanceTime])
    }
  }
  const zhejiang = repo.scores.get(scoreKey('province','330000'))
  assert.equal(zhejiang.area_units, Math.round(h.area_m2 * AREA_UNITS) + Math.round(n.area_m2 * AREA_UNITS))
  assert.equal(zhejiang.distance_units, [h,n,captured].reduce((sum,r) => sum + Math.round(r.distance_m * DISTANCE_UNITS),0))
  const a = repo.scores.get(scoreKey('national','A'))
  const b = repo.scores.get(scoreKey('national','B'))
  assert.equal(a.area_units, 0)
  assert.equal(a.distance_units, Math.round(h.distance_m * DISTANCE_UNITS))
  assert.equal(b.area_units, zhejiang.area_units)
  assert.equal(repo.scores.has(scoreKey('province','310000')), false)
  const baseline = await runs.scoreBaseline()
  for (const row of baseline) {
    const { last_run_id, area_reached_at, distance_reached_at, ...score } = repo.scores.get(scoreKey(row.board,row.subject))
    assert.ok(last_run_id)
    assert.deepEqual(score, row)
  }

  // Existing settled runs can have city totals or only original fixes and the awarded distance.
  const hRun = [...repo.docs.values()].find(doc => doc.run_id === 'hangzhou')
  delete hRun.province_distances
  hRun.result.value.distance_m = 410
  const nRun = [...repo.docs.values()].find(doc => doc.run_id === 'ningbo')
  delete nRun.province_distances
  nRun.city_distances = {'330200': n.distance_m}
  const rebuilt = await runs.scoreBaseline()
  const rebuiltProvince = rebuilt.find(row => row.board === 'province' && row.subject === '330000')
  assert.equal(rebuiltProvince.distance_units, zhejiang.distance_units - a.distance_units + 410 * DISTANCE_UNITS)
})

test('穿沪苏边界的地块和两次同时提交的跑步都按实际省份入账', async () => {
  const repo = repository()
  const runs = createRuns(repo, grid)
  const [x, y] = grid.toXY(31.724751,121.151915)
  const rectangle = square.map(([dx,dy],i) => fix(1000 + 25*i,x+dx-50,y+dy-50))
  await runs.start('A','border',1000,rectangle[0])
  const loop = await runs.finish('A','border',1100,rectangle)
  const both = ['310000','320000'].map(code => repo.scores.get(scoreKey('province',code)))
  assert.ok(both.every(row => row.area_units > 0 && row.distance_units > 0))
  assert.ok(Math.abs(both[0].area_units + both[1].area_units - Math.round(loop.area_m2*AREA_UNITS)) <= 1)
  assert.ok(Math.abs(both[0].distance_units + both[1].distance_units - Math.round(loop.distance_m*DISTANCE_UNITS)) <= 1)
  for (const id of ['open-1','open-2']) await runs.start('A',id,1000,fix(1000))
  const end = await Promise.all(['open-1','open-2'].map(id => runs.finish('A',id,1060,[fix(1060,300)])))
  const owner = repo.scores.get(scoreKey('national','A'))
  assert.equal(owner.distance_units,[loop,...end].reduce((sum,r) => sum + Math.round(r.distance_m*DISTANCE_UNITS),0))
  const shanghai = repo.scores.get(scoreKey('province','310000'))
  assert.equal(shanghai.distance_units,both[0].distance_units + 600*DISTANCE_UNITS)
})

test('分享成绩按真实省界拆分，保留历史贡献，并从累计榜读取当前名次与全省总量', async () => {
  const repo = repository(), runs = createRuns(repo, grid)
  const [x, y] = grid.toXY(31.724751, 121.151915)
  async function finish(player, id, interval) {
    const path = square.map(([dx, dy], i) => fix(1000 + interval * i, x + dx - 50, y + dy - 50))
    await runs.start(player, id, 1000, path[0])
    return runs.finish(player, id, path.at(-1).timestamp, path)
  }
  await finish('A', 'border-share', 25)
  const claimed = await runs.shareStandings('A', 'border-share')
  assert.deepEqual(claimed.provinces.map(row => row.display_name), ['上海市', '江苏省'])
  for (const row of claimed.provinces) {
    const total = repo.scores.get(scoreKey('province', row.region_code))
    assert.equal(row.area_m2, total.area_units / AREA_UNITS)
    assert.equal(row.distance_m, total.distance_units / DISTANCE_UNITS)
    assert.ok(row.area_m2 > 0 && row.distance_m > 0)
  }
  assert.equal(claimed.national.distance.rank, 1)
  assert.equal(claimed.national.area.value, repo.scores.get(scoreKey('national', 'A')).area_units / AREA_UNITS)

  await finish('B', 'capture-share', 15)
  await finish('B', 'defend-share', 15)
  for (const id of ['capture-share', 'defend-share']) {
    const { provinces } = await runs.shareStandings('B', id)
    assert.ok(provinces.every(row => row.area_m2 === 0 && row.distance_m > 0))
  }
  const doc = [...repo.docs.values()].find(row => row.run_id === 'border-share')
  delete doc.province_area_units
  const old = await runs.shareStandings('A', 'border-share')
  assert.equal(old.national.distance.rank, 2)
  assert.equal(old.national.area, null)
  for (const [i, row] of old.provinces.entries()) {
    assert.deepEqual(row, { ...claimed.provinces[i], total_distance_m: Math.round(row.distance_m * 3 * DISTANCE_UNITS) / DISTANCE_UNITS })
  }
})

test('分享拒绝他人、进行中、舍弃的跑步，全国 500 名之外不返回名次', async t => {
  const repo = repository(), runs = createRuns(repo, grid)
  await runs.start('A', 'open-share', 1000, fix(1000))
  const boards = t.mock.method(repo, 'scoreBoard')
  for (const player of ['A', 'B']) await assert.rejects(runs.shareStandings(player, 'open-share'), { code: 'run_not_found' })
  await runs.finish('A', 'open-share', 1005, [fix(1005, 5)])
  await assert.rejects(runs.shareStandings('A', 'open-share'), { code: 'run_not_found' })
  await runs.start('A', 'short-share', 1000, fix(1000))
  await runs.finish('A', 'short-share', 1060, [fix(1060, 300)])
  await assert.rejects(runs.shareStandings('B', 'short-share'), { code: 'run_not_found' })
  assert.equal(boards.mock.callCount(), 0)
  for (let i = 0; i < 500; i++) {
    const subject = 'ahead' + i
    repo.scores.set(scoreKey('national', subject), { board: 'national', subject, distance_units: 301000 })
  }
  const readResult = t.mock.method(repo, 'getRunResult', () => assert.fail('本次和全省汇总足够生成分享数据'))
  const { national, provinces } = await runs.shareStandings('A', 'short-share')
  assert.deepEqual(national, { distance: null, area: null })
  assert.deepEqual(provinces[0], { region_code: '310000', display_name: '上海市', distance_m: 300,
    area_m2: 0, total_distance_m: 300, total_area_m2: 0 })
  readResult.mock.restore()
  delete [...repo.docs.values()].find(row => row.run_id === 'short-share').province_area_units
  repo.scores.delete(scoreKey('province', '310000'))
  assert.deepEqual((await runs.shareStandings('A', 'short-share')).provinces, [])
})

test('失地边界按需复用不可变结果块，保留孔，超出点数或字节上限只返回标记', async () => {
  const repo = repository()
  const model = new Grid()
  const settle = model.settle.bind(model)
  function ring(count, radius) {
    const coords = Array.from({ length: count - 1 }, (_, i) => {
      const angle = i * 2 * Math.PI / (count - 1)
      return [121.47 + radius * Math.cos(angle), 31.23 + radius * Math.sin(angle)]
    })
    return [...coords, coords[0]]
  }
  const withHole = { type: 'Polygon', coordinates: [ring(420, 0.001), ring(36, 0.0001).reverse()] }
  const maxPoints = { type: 'Polygon', coordinates: [Array(2048).fill([121, 31])] }
  const overPoints = { type: 'Polygon', coordinates: [...maxPoints.coordinates, [[121, 31]]] }
  const overBytes = { type: 'Polygon', coordinates: [ring(2000, 0.001)] }
  assert.ok(Buffer.byteLength(JSON.stringify(overBytes)) > 64 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(overPoints)) < 64 * 1024)
  model.settle = (...args) => {
    const settlement = settle(...args)
    const capture = settlement.outcomes.find(row => row.outcome === 'captured')
    if (!capture) return settlement
    // Put the first geometry across a 96 KiB block boundary in a much larger settlement.
    settlement.outcomes = [{ outcome: 'claimed', area_m2: 0, padding: '路'.repeat(31 * 1024) },
      ...[withHole, maxPoints, overPoints, overBytes].map(geometry => ({ ...capture, geometry, fill_rings: ['unused'] })),
      { outcome: 'claimed', area_m2: 0, padding: '路'.repeat(110 * 1024) }]
    return settlement
  }
  const runs = createRuns(repo, model)
  for (const [player, step] of [['first', 30], ['winner', 15]]) {
    const route = square.map(([x,y], i) => fix(1000 + step * i, x, y))
    await runs.start(player, player, 1000, route[0])
    await runs.finish(player, player, route.at(-1).timestamp, route)
  }
  const replay = await runs.finish('winner', 'winner', 1100)
  const packed = [...repo.docs.values()].find(row => row.run_id === 'winner').result
  assert.ok(packed.blocks.length > 1)
  assert.equal(packed.value.pace_anomaly, true)
  assert.equal(replay.pace_anomaly, true)
  assert.ok(replay.achievement_updates.records.some(row => row.key === 'largest_capture'))
  assert.deepEqual((await runs.get('winner', 'winner')).result.achievement_updates, replay.achievement_updates)
  const { reports: [report] } = await runs.lossReports('first')
  assert.equal(report.boundaries, undefined)
  const { boundaries } = await repo.get(report.id)
  assert.ok(Buffer.byteLength(JSON.stringify(boundaries)) < 700)
  assert.equal(boundaries.r0.blocks.length, 2)
  const get = repo.get
  const reads = []
  repo.get = async id => { reads.push(id); return get(id) }
  assert.deepEqual(await runs.lossReportBoundary('first', report.id, 0), { geometry: withHole })
  assert.deepEqual(reads.splice(0), boundaries.r0.blocks)
  assert.deepEqual(await runs.lossReportBoundary('first', report.id, 1), { geometry: maxPoints })
  reads.length = 0
  for (const index of [2, 3]) {
    assert.deepEqual(await runs.lossReportBoundary('first', report.id, index), { geometry: null, reason: 'too_complex' })
  }
  assert.deepEqual(reads, [])
})

test('成就按有效完赛日和北京时间周累计，补传、并发、平纪录和重复结算均只记一次', async () => {
  const runs = createRuns(repository(), grid)
  const monday = Date.parse('2026-11-23T00:00:00+08:00') / 1000
  async function straight(id, end, meters, secondsPer100) {
    const steps = meters / 100
    const points = Array.from({ length: steps + 1 }, (_, i) => fix(end - (steps - i) * secondsPer100, i * 100))
    await runs.start('A', id, points[0].timestamp, points[0])
    return runs.finish('A', id, end, points)
  }
  const empty = await runs.achievements('A')
  assert.ok(Object.values(empty.records).every(value => value === null))
  assert.deepEqual(Object.values(empty.milestones).map(metric => metric.value), [0, 0, 0, 0])

  const first = await straight('sunday-long', monday - 1, 5000, 25)
  assert.equal(first.valid_loop, false)
  assert.deepEqual(Object.fromEntries(first.achievement_updates.records.map(row => [row.key, row.value])), {
    longest_distance: 5000, fastest_1k: 250, fastest_5k: 1250, best_week: 5000
  })
  assert.ok(first.achievement_updates.records.every(row => row.previous === null))
  const mondayRuns = await Promise.all([
    straight('monday-1', monday, 1000, 20), straight('monday-2', monday + 600, 1000, 20)
  ])
  assert.deepEqual(mondayRuns.flatMap(run => run.achievement_updates.records), [
    { key: 'fastest_1k', value: 200, previous: 250 }
  ])
  const zero = await straight('standing', monday + 86400, 0, 0)
  assert.equal(zero.recorded, false)
  assert.equal((await runs.achievements('A')).milestones.running_days.value, 2)
  const tuesday = await straight('tuesday', monday + 88000, 2000, 20)
  assert.deepEqual(tuesday.achievement_updates.milestones, [{ key: 'running_days', threshold: 3 }])

  const late = await straight('late-sunday', monday - 5000, 1000, 20)
  assert.deepEqual(late.achievement_updates, {
    records: [{ key: 'best_week', value: 6000, previous: 5000 }],
    milestones: [{ key: 'total_distance', threshold: 10000 }]
  })
  assert.deepEqual(await runs.finish('A', 'late-sunday', monday), late)
  assert.deepEqual((await runs.get('A', 'late-sunday')).result, late)
  const state = await runs.achievements('A')
  assert.deepEqual(state.records.best_week, { value: 6000, ended_at: monday - 5000, run_id: 'late-sunday' })
  assert.equal(state.milestones.running_days.value, 3)
  assert.deepEqual(state.milestones.total_distance, { value: 10000, thresholds: [10000, 50000, 100000, 500000] })
})

test('分清新占、夺地和守地，多人失地只算一次成功夺地，版图峰值在失地后保留', async () => {
  const runs = createRuns(repository(), grid)
  async function rectangle(player, id, startX, width, step, start = 10000) {
    const points = [[0,0], [width,0], [width,100], [0,100], [0,0]]
      .map(([x,y], i) => fix(start + i * step, x + startX, y))
    await runs.start(player, id, start, points[0])
    return runs.finish(player, id, points.at(-1).timestamp, points)
  }
  await rectangle('A', 'west', 0, 100, 35)
  await rectangle('B', 'east', 100, 100, 35)
  const win = await rectangle('C', 'two-captures', 0, 250, 40)
  assert.deepEqual(win.achievement_updates.milestones, [
    { key: 'total_gain', threshold: 10000 }, { key: 'capture_runs', threshold: 1 }
  ])
  const before = await runs.achievements('C')
  assert.equal(before.records.largest_gain.value, 25000)
  assert.equal(before.records.largest_capture.value, 20000)
  assert.equal(before.records.peak_area.value, 25000)
  await rectangle('C', 'defend', 0, 250, 40)
  await rectangle('C', 'new-land', 500, 100, 35)
  const after = await runs.achievements('C')
  assert.equal(after.milestones.total_gain.value, 35000)
  assert.equal(after.milestones.capture_runs.value, 1)
  assert.equal(after.records.largest_gain.run_id, 'two-captures')
  assert.equal(after.records.peak_area.value, 35000)

  await rectangle('A', 'take-land', 500, 100, 25)
  assert.equal((await runs.playerSummary('C')).area_m2, 25000)
  assert.deepEqual(await runs.achievements('C'), after)
})

'use strict'

const { createHash } = require('node:crypto')
const { analyzeRunTrack } = require('./track')
const { provinceDistances, groupCityDistances, claimedProvinceUnits, addLand, addDistance, publishScores,
  AREA_UNITS, DISTANCE_UNITS, scoreKey } = require('./score-totals')
const { catalog } = require('./regions')
const { buildLossReports, publishLossReports, lossReports, lossReportBoundary } = require('./reports')
const { runStats, runHistory, runPeriod, historyMetrics } = require('./run-statistics')
const { achievements, runPerformance, publishAchievements } = require('./achievements')
const { queryLandIndex } = require('./land-index')
const { settleInBounds } = require('./land-settlement')

const MAP_KEY = 'park-map'
const INLINE_BYTES = 32 * 1024
const BLOCK_BYTES = 96 * 1024
const MAX_ATTEMPTS = 8

function keyFor(prefix, value) {
  return prefix + createHash('sha256').update(value).digest('hex').slice(0, 31)
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

// Large values are immutable blocks. Publish their references together in a
// short transaction, so failed/retried writes never expose a partial route/map.
async function pack(repo, value, previousRef, bytes = Buffer.from(JSON.stringify(value))) {
  if (bytes.length <= INLINE_BYTES) return { value }

  const reusable = new Set(previousRef?.blocks)
  const blocks = []
  for (let i = 0; i < bytes.length; i += BLOCK_BYTES) {
    const block = bytes.subarray(i, i + BLOCK_BYTES)
    const id = keyFor('b', block)
    blocks.push(id)
    if (!reusable.has(id)) {
      await repo.set(id, { bytes: block.toString('base64') })
      reusable.add(id)
    }
  }
  return { blocks }
}

async function unpack(repo, ref) {
  if (!ref.blocks) return ref.value
  const chunks = []
  for (const id of ref.blocks) {
    const block = await repo.get(id)
    if (!block) fail(503, 'storage_unavailable', '暂时无法读取完整的跑步数据')
    chunks.push(Buffer.from(block.bytes, 'base64'))
  }
  const content = Buffer.concat(chunks)
  const slice = ref.byte_length == null ? content : content.subarray(ref.byte_offset, ref.byte_offset + ref.byte_length)
  return JSON.parse(slice.toString('utf8'))
}

async function readRunResult(repo, ref) {
  const result = await unpack(repo, ref)
  // Record changes are decided inside the transaction, after large result blocks have been staged.
  if (ref.blocks && ref.value?.achievement_updates) result.achievement_updates = ref.value.achievement_updates
  return result
}

function summary(run) {
  const endedAt = run.discarded_at ?? run.ended_at
  return {
    run_id: run.run_id, player_id: run.player_id,
    started_at: run.started_at, ended_at: endedAt,
    status: endedAt === null ? 'running' : 'finished',
    point_count: run.point_count ?? 0
  }
}

function owned(run, player) {
  if (!run || run.player_id !== player) fail(404, 'run_not_found', '找不到这场跑步')
  return run
}

function betterFix(a, b) {
  if (a.accuracy !== b.accuracy) return a.accuracy < b.accuracy
  if (a.latitude !== b.latitude) return a.latitude < b.latitude
  return a.longitude < b.longitude
}

function mergePoints(previous, batch) {
  const byTime = new Map(previous.map(p => [p.timestamp, p]))
  let changed = false
  for (const point of batch) {
    const current = byTime.get(point.timestamp)
    if (!current || betterFix(point, current)) {
      changed = true
      byTime.set(point.timestamp, point)
    }
  }
  return changed ? [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp) : previous
}

function createRuns(repo, grid) {
  function checkMap(map) {
    if (!map) return { revision: 0, next_id: 1, origin: grid.origin, viewRoot: null, viewRevision: 0, settlementRevision: 0 }
    if (map.origin.latitude !== grid.origin.latitude || map.origin.longitude !== grid.origin.longitude) {
      fail(409, 'origin_mismatch', '数据库已有公园坐标原点，请使用原来的经纬度')
    }
    return map
  }

  async function start(player, runId, startedAt, first) {
    const key = keyFor('r', runId)
    return repo.transaction(async tx => {
      const run = await tx.get(key)
      if (run) {
        if (run.player_id !== player || run.started_at !== startedAt) {
          fail(409, 'run_id_conflict', '跑步编号已使用，请为新跑步生成唯一编号')
        }
        return summary(run)
      }
      if (first.accuracy > 50 || first.timestamp < startedAt) {
        fail(400, 'invalid_start_point', '请取得精度误差不超过 50 米的起点再开始')
      }
      const existingMap = await tx.get(MAP_KEY)
      const map = checkMap(existingMap)
      const created = {
        revision: 1, run_id: runId, player_id: player, started_at: startedAt, ended_at: null,
        point_count: 1, points: { value: [first] }, result: null
      }
      if (!existingMap) await tx.set(MAP_KEY, map)
      await tx.set(key, created)
      return summary(created)
    })
  }

  async function changeRun(player, runId, batch, endedAt) {
    const key = keyFor('r', runId)
    const finishing = endedAt !== null
    const discardedResult = { recorded: false, run_id: runId, player_id: player }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const run = owned(await repo.get(key), player)
      if (run.discarded_at != null || run.ended_at !== null) {
        if (!finishing) fail(409, 'run_finished', '这场跑步已结束，可查询首次结算结果')
        if (run.discarded_at != null) return run.result?.value ?? discardedResult
        return readRunResult(repo, run.result)
      }
      if (finishing && endedAt < run.started_at) {
        fail(400, 'invalid_end_time', '结束时间早于开始时间')
      }
      const previous = await unpack(repo, run.points)
      const points = mergePoints(previous, batch)
      if (!finishing && points === previous) return summary(run)
      const track = finishing ? analyzeRunTrack(grid, run.started_at, endedAt, points) : null
      if (track?.analysis.reasons.includes('distance_too_short')) {
        // Keep only a retry receipt. Finished-run queries select rows by ended_at.
        const receipt = track.analysis.pace_anomaly ? { ...discardedResult, pace_anomaly: true } : discardedResult
        const discarded = await repo.transaction(async tx => {
          if ((await tx.get(key)).revision !== run.revision) return false
          await tx.set(key, { revision: run.revision + 1, run_id: runId, player_id: player,
            started_at: run.started_at, discarded_at: endedAt, result: { value: receipt } })
          return true
        })
        if (discarded) return receipt
        continue
      }
      const pointsRef = points === previous ? run.points : await pack(repo, points, run.points)
      const nextRun = { ...run, revision: run.revision + 1, points: pointsRef, point_count: points.length }
      let map, nextMap, result, holdings
      const scores = new Map()
      let reports = []

      if (finishing) {
        const { analysis, regions } = track
        result = { ...analysis, run_id: runId, player_id: player, started_at: run.started_at,
          ended_at: endedAt, outcomes: [] }
        if (regions.length) {
          map = checkMap(await repo.getMapView(MAP_KEY))
          if (map.revision && map.settlementRevision !== map.revision) fail(503, 'storage_unavailable', '地图结算索引尚未就绪')
          const settled = await settleInBounds(repo, grid, map, regions, player, analysis.pace_s_per_km, scores, pack, unpack)
          result.outcomes = settled.outcomes
          nextMap = settled.nextMap
          holdings = settled.holdings
        }
        nextRun.province_distances = provinceDistances(grid, track.paths)
        // Keep the province board's net change, including its rounding when parcels split or merge.
        nextRun.province_area_units = {}
        if (result.outcomes.some(row => row.outcome === 'claimed')) {
          for (const row of scores.values()) {
            if (row.board === 'province' && row.area_units > 0) nextRun.province_area_units[row.subject] = row.area_units
          }
        }
        nextRun.score_version = 1
        addDistance(scores, player, analysis.distance_m, nextRun.province_distances)
        nextRun.ended_at = endedAt
        const resultBytes = Buffer.from(JSON.stringify(result))
        nextRun.result = await pack(repo, result, undefined, resultBytes)
        const { blocks } = nextRun.result
        reports = buildLossReports(result, blocks && { content: resultBytes, blocks, blockSize: BLOCK_BYTES })
        if (nextRun.result.blocks) {
          // Keep the chart and list fields queryable even when the full result spans blocks.
          nextRun.result.value = historyMetrics(result)
        }
      }

      // Re-read the revisions inside a cloud transaction. Even two previously
      // empty, overlapping claims contend on the same map document.
      const published = await repo.transaction(async tx => {
        if ((await tx.get(key)).revision !== run.revision) return false
        if (map && checkMap(await tx.get(MAP_KEY)).revision !== map.revision) return false
        if (finishing) {
          const ownedArea = map ? await publishHoldings(tx, player, holdings) : 0
          const performance = runPerformance(result, track, ownedArea)
          nextRun.result.value.achievement_updates = await publishAchievements(tx, result, performance)
          await publishScores(tx, scores, runId, endedAt)
        }
        if (reports.length) await publishLossReports(tx, reports, nextMap.revision)
        await tx.set(key, nextRun)
        if (nextMap) await tx.set(MAP_KEY, nextMap)
        return true
      })
      if (published) return finishing ? { ...result, achievement_updates: nextRun.result.value.achievement_updates } : summary(nextRun)
    }
    fail(503, 'write_conflict', '多人同时提交，请重试本次请求')
  }

  async function get(player, runId, includePoints = true) {
    const key = keyFor('r', runId)
    const run = owned(includePoints ? await repo.get(key) : await repo.getRunResult(key), player)
    if (run.discarded_at != null) fail(404, 'run_not_found', '找不到这场跑步')
    const [result, points] = await Promise.all([
      run.result ? readRunResult(repo, run.result) : null, includePoints ? unpack(repo, run.points) : null
    ])
    return { ...summary(run), ...(includePoints ? { points } : {}), result }
  }

  async function publishHoldings(tx, player, changes) {
    const owners = [...new Set([player, ...changes.keys()])].sort()
    let ownedArea = 0
    for (const owner of owners) {
      const key = keyFor('o', owner)
      const previous = await tx.get(key) || { territory_count: 0, area_m2: 0 }
      const delta = changes.get(owner)
      let area = previous.area_m2
      if (delta && (delta.count || delta.area)) {
        const count = previous.territory_count + delta.count
        area = count === 0 ? 0 : area + delta.area
        await tx.set(key, { territory_count: count, area_m2: area })
      }
      if (owner === player) ownedArea = area
    }
    return ownedArea
  }

  async function territories(west, south, east, north) {
    const bounds = { west, south, east, north }
    const map = checkMap(await repo.getMapView(MAP_KEY))
    if (map.revision > 0 && map.viewRevision !== map.revision) fail(503, 'storage_unavailable', '地图空间索引尚未就绪')
    const boxes = grid.viewportBoxes(bounds)
    const lands = await queryLandIndex(repo, map.viewRoot, boxes, unpack)
    return { territories: lands.filter(land => grid.visible(land.shape, bounds, boxes)).map(land => ({
      id: land.id, owner: land.owner, pace_s_per_km: land.pace_s_per_km, ...grid.describe(land.shape)
    })).sort((a, b) => a.id - b.id) }
  }

  async function playerSummary(player) {
    const holdings = await repo.get(keyFor('o', player)) || { territory_count: 0, area_m2: 0 }
    return { player_id: player, ...holdings }
  }

  async function recordedProvinceDistances(run, meters, key) {
    if (run.province_distances) return run.province_distances
    if (run.city_distances) return groupCityDistances(run.city_distances)
    // Only old runs without a regional breakdown need the full GPS track.
    const points = run.points || (await repo.get(key)).points
    const fixes = grid.validFixes(run.started_at, run.ended_at, await unpack(repo, points))
    const path = fixes.map(p => grid.toXY(p.latitude, p.longitude))
    const provinces = provinceDistances(grid, [path])
    let measured = 0
    for (let i = 1; i < path.length; i++) measured += grid.measureDistance(path[i - 1], path[i])
    for (const code of Object.keys(provinces)) provinces[code] *= meters / measured
    return provinces
  }

  async function shareStandings(player, runId) {
    const key = keyFor('r', runId)
    const run = owned(await repo.getRunShareSummary(key), player)
    if (run.ended_at == null || run.discarded_at != null) fail(404, 'run_not_found', '找不到这场跑步')
    let areas = run.province_area_units
    let result
    if (!areas) {
      const receipt = await repo.getRunResult(key)
      result = await readRunResult(repo, receipt.result)
      areas = claimedProvinceUnits(grid, result.outcomes || [])
    }
    const distances = await recordedProvinceDistances(run, result?.distance_m, key)
    async function national(metric) {
      const { entries } = await repo.scoreBoard(metric, 'national')
      const own = entries.find(row => row.subject === player)
      return own ? { rank: own.rank, value: own.value } : null
    }
    const provinces = []
    for (const { code, name } of catalog) {
      const area = areas[code] || 0
      const distance = Math.round((distances[code] || 0) * DISTANCE_UNITS)
      if (!area && !distance) continue
      provinces.push({ region_code: code, display_name: name, distance_m: distance / DISTANCE_UNITS, area_m2: area / AREA_UNITS })
    }
    async function withProvinceTotal(row) {
      const total = await repo.getScore(scoreKey('province', row.region_code))
      if (!total) return null
      return { ...row, total_distance_m: total.distance_units / DISTANCE_UNITS, total_area_m2: total.area_units / AREA_UNITS }
    }
    const [distance, area, totals] = await Promise.all([
      national('distance'), national('area'), Promise.all(provinces.map(withProvinceTotal))
    ])
    return { national: { distance, area }, provinces: totals.filter(Boolean) }
  }

  // Administrative initialization/verification only. Normal board reads use the score index.
  async function scoreBaseline() {
    const totals = new Map()
    const { viewRoot } = checkMap(await repo.getMapView(MAP_KEY))
    if (viewRoot) {
      const lands = await queryLandIndex(repo, viewRoot, [viewRoot.bbox], unpack)
      for (const land of lands) addLand(totals, grid, land, 1)
    }
    for await (const run of repo.finishedRuns(true)) {
      const { distance_m: meters } = await unpack(repo, run.result)
      if (!meters) continue
      const provinces = await recordedProvinceDistances(run, meters)
      addDistance(totals, run.player_id, meters, provinces)
    }
    return [...totals.values()]
  }

  return {
    start, get, territories, playerSummary, scoreBaseline, shareStandings,
    achievements: player => achievements(repo, player),
    runningSummary: player => runStats(repo, unpack, player),
    runStats: (player, event, now) => runStats(repo, unpack, player, runPeriod(event, now)),
    runHistory: (player, event, now) => runHistory(repo, unpack, player, runPeriod(event, now), event.bucket, event.cursor),
    lossReports: (player, cursor) => lossReports(repo, player, cursor),
    lossReportBoundary: (player, id, index) => lossReportBoundary(repo, unpack, player, id, index),
    leaderboard: (metric, scope = 'national', periodKey) => repo.scoreBoard(metric, scope, periodKey),
    personalRank: (metric, player, entries, periodKey) => repo.personalRank(metric, player, entries, periodKey),
    append: (player, id, batch) => changeRun(player, id, batch, null),
    finish: (player, id, endedAt, batch = []) => changeRun(player, id, batch, endedAt)
  }
}

module.exports = { createRuns }

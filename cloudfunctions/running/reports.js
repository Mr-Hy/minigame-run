'use strict'

const { createHash } = require('node:crypto')
const { queueLossNotice } = require('./loss-notices')

const PAGE_SIZE = 20
const MAX_BOUNDARY_POINTS = 2048
const MAX_BOUNDARY_BYTES = 64 * 1024

function buildLossReports(result, packedResult) {
  const byRecipient = new Map()
  let searchFrom = 0
  function boundaryRef(geometry) {
    let points = 0
    for (const ring of geometry.coordinates) {
      points += ring.length
      if (points > MAX_BOUNDARY_POINTS) return { too_complex: true }
    }
    // An inline result fits in 32 KiB, so every geometry in it already fits the byte budget.
    if (!packedResult) return { value: geometry }
    const bytes = Buffer.from(JSON.stringify(geometry))
    if (bytes.length > MAX_BOUNDARY_BYTES) return { too_complex: true }
    // Outcomes are in settlement order. Reuse the exact bytes already published in immutable blocks.
    const { content, blocks, blockSize } = packedResult
    const start = content.indexOf(bytes, searchFrom)
    if (start < 0) throw new Error('未在结算快照中找到失地边界')
    searchFrom = start + bytes.length
    return { blocks: blocks.slice(Math.floor(start / blockSize), Math.ceil(searchFrom / blockSize)),
      byte_offset: start % blockSize, byte_length: bytes.length }
  }
  for (const part of result.outcomes) {
    if (part.outcome !== 'captured') continue
    const recipient = part.previous_owner
    let report = byRecipient.get(recipient)
    if (!report) {
      const digest = createHash('sha256').update(JSON.stringify([result.run_id, recipient])).digest('hex')
      report = {
        id: 'l' + digest.slice(0, 31), recipient, challenger: result.player_id,
        ended_at: result.ended_at, area_m2: 0, pace_s_per_km: result.pace_s_per_km, regions: [], boundaries: { count: 0 }
      }
      byRecipient.set(recipient, report)
    }
    report.area_m2 += part.area_m2
    report.boundaries['r' + report.regions.length] = boundaryRef(part.geometry)
    report.regions.push({ ...part.label_point, area_m2: part.area_m2 })
    report.boundaries.count = report.regions.length
  }
  return [...byRecipient.values()]
}

async function publishLossReports(tx, reports, revision) {
  for (const { boundaries, ...report } of reports) {
    await tx.set(report.id, { report, loss_revision: revision, boundaries })
    await queueLossNotice(tx, report)
  }
}

async function lossReports(repo, player, cursor) {
  if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
    throw Object.assign(new Error('战报翻页参数无效'), { status: 400, code: 'invalid_cursor' })
  }
  const rows = await repo.lossReportRows(player, cursor, PAGE_SIZE + 1)
  const page = rows.slice(0, PAGE_SIZE)
  return {
    reports: page.map(({ report: { recipient, ...report } }) => report),
    next_cursor: rows.length > PAGE_SIZE ? page[page.length - 1].loss_revision : null
  }
}

async function lossReportBoundary(repo, unpack, player, id, index) {
  if (typeof id !== 'string' || !/^l[0-9a-f]{31}$/.test(id)) {
    throw Object.assign(new Error('战报编号无效'), { status: 400, code: 'invalid_report_id' })
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw Object.assign(new Error('地块序号无效'), { status: 400, code: 'invalid_region_index' })
  }
  const boundaries = await repo.reportBoundaryRef(player, id, index)
  if (!boundaries) throw Object.assign(new Error('找不到这份失地战报'), { status: 404, code: 'report_not_found' })
  if (boundaries.count == null) return { geometry: null }
  if (index >= boundaries.count) throw Object.assign(new Error('地块序号超出范围'), { status: 400, code: 'invalid_region_index' })
  const ref = boundaries['r' + index]
  return ref.too_complex ? { geometry: null, reason: 'too_complex' } : { geometry: await unpack(repo, ref) }
}

module.exports = { buildLossReports, publishLossReports, lossReports, lossReportBoundary }

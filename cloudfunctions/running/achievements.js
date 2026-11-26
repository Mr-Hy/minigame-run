'use strict'

const { createHash } = require('node:crypto')
const { AREA_UNITS, DISTANCE_UNITS, scorePeriods } = require('./score-totals')

const THRESHOLDS = {
  total_distance: [10000, 50000, 100000, 500000],
  running_days: [3, 7, 30, 100],
  total_gain: [10000, 50000, 200000, 1000000],
  capture_runs: [1, 5, 20, 100]
}

function achievementKey(player, week = '') {
  return 'h' + createHash('sha256').update(player).update('\0').update(week).digest('hex').slice(0, 31)
}

function emptyState() {
  return {
    records: { longest_distance: null, fastest_1k: null, fastest_5k: null, largest_gain: null,
      largest_capture: null, best_week: null, peak_area: null },
    totals: { total_distance: 0, running_days: 0, total_gain: 0, capture_runs: 0 }
  }
}

async function achievements(repo, player) {
  const state = await repo.get(achievementKey(player)) || emptyState()
  const milestones = {}
  for (const [key, thresholds] of Object.entries(THRESHOLDS)) {
    milestones[key] = { value: state.totals[key], thresholds }
  }
  return { records: state.records, milestones }
}

function rounded(value, scale) {
  return Math.round(value * scale) / scale
}

function runPerformance(result, track, ownedArea) {
  let claimed = 0, captured = 0
  for (const part of result.outcomes) {
    if (part.outcome === 'claimed') claimed += part.area_m2
    if (part.outcome === 'captured') captured += part.area_m2
  }
  return { longest_distance: rounded(result.distance_m, DISTANCE_UNITS),
    fastest_1k: track.fastest_1k, fastest_5k: track.fastest_5k,
    largest_gain: rounded(claimed + captured, AREA_UNITS), largest_capture: rounded(captured, AREA_UNITS),
    peak_area: rounded(ownedArea, AREA_UNITS) }
}

async function publishAchievements(tx, result, performance) {
  const { player_id, run_id, ended_at } = result
  const updates = { records: [], milestones: [] }
  const distance = performance.longest_distance
  if (distance <= 0) return updates

  const { week, day } = scorePeriods(ended_at)
  const stateKey = achievementKey(player_id)
  const weekKey = achievementKey(player_id, week)
  const state = await tx.get(stateKey) || emptyState()
  // Each week has at most seven dates. Offline submissions can revisit any earlier week.
  const weekly = await tx.get(weekKey) || { distance_m: 0, days: [] }
  const newDay = !weekly.days.includes(day)
  if (newDay) weekly.days.push(day)
  weekly.distance_m = rounded(weekly.distance_m + distance, DISTANCE_UNITS)

  for (const [key, value] of Object.entries({ ...performance, best_week: weekly.distance_m })) {
    if (!(value > 0)) continue
    const previous = state.records[key]?.value ?? null
    const timed = key === 'fastest_1k' || key === 'fastest_5k'
    if (previous !== null && (timed ? value >= previous : value <= previous)) continue
    state.records[key] = { value, ended_at, run_id }
    updates.records.push({ key, value, previous })
  }

  const totals = {
    total_distance: rounded(state.totals.total_distance + distance, DISTANCE_UNITS),
    running_days: state.totals.running_days + Number(newDay),
    total_gain: rounded(state.totals.total_gain + performance.largest_gain, AREA_UNITS),
    capture_runs: state.totals.capture_runs + Number(performance.largest_capture > 0)
  }
  for (const [key, thresholds] of Object.entries(THRESHOLDS)) {
    for (const threshold of thresholds) {
      if (state.totals[key] < threshold && totals[key] >= threshold) updates.milestones.push({ key, threshold })
    }
  }
  await tx.set(weekKey, weekly)
  await tx.set(stateKey, { records: state.records, totals })
  return updates
}

module.exports = { achievements, runPerformance, publishAchievements }

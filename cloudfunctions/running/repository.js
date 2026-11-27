const { AREA_UNITS, DISTANCE_UNITS, periodBoard, scoreKey } = require('./score-totals')
const COLLECTION = 'running_state'
const SCORES = 'running_scores'
const NATIONAL_LIMIT = 500
const PROFILE_BATCH_SIZE = 100
const METRICS = {
  area: { property: 'area_units', reachedAt: 'area_reached_at', scale: AREA_UNITS },
  distance: { property: 'distance_units', reachedAt: 'distance_reached_at', scale: DISTANCE_UNITS }
}

function documents(database) {
  const collection = database.collection(COLLECTION)
  return {
    async get(key) {
      const { data } = await collection.doc(key).get()
      return data ? data.value : null
    },
    async set(key, value) {
      await collection.doc(key).set({ data: { value } })
    },
    async getScore(key) {
      const { data } = await database.collection(SCORES).doc(key).get()
      return data || null
    },
    async setScore(key, row) {
      await database.collection(SCORES).doc(key).set({ data: row })
    }
  }
}

function createRepository(db) {
  const records = documents(db)
  const scores = db.collection(SCORES)

  return {
    ...records,
    async getMapView(key) {
      const { data } = await db.collection(COLLECTION).doc(key).field({
        'value.origin': true, 'value.revision': true, 'value.next_id': true,
        'value.viewRoot': true, 'value.viewRevision': true, 'value.settlementRevision': true
      }).get()
      return data ? data.value : null
    },
    async getMapNodes(keys) {
      const { data } = await db.collection(COLLECTION).where({ _id: db.command.in(keys) })
        .limit(keys.length).get()
      return new Map(data.map(row => [row._id, row.value]))
    },
    async getRunResult(key) {
      const { data } = await db.collection(COLLECTION).doc(key).field({
        'value.player_id': true, 'value.run_id': true, 'value.started_at': true,
        'value.ended_at': true, 'value.discarded_at': true, 'value.point_count': true, 'value.result': true
      }).get()
      return data ? data.value : null
    },
    async getRunShareSummary(key) {
      const { data } = await db.collection(COLLECTION).doc(key).field({
        'value.player_id': true, 'value.started_at': true, 'value.ended_at': true, 'value.discarded_at': true,
        'value.province_distances': true, 'value.city_distances': true, 'value.province_area_units': true
      }).get()
      return data ? data.value : null
    },
    async inlineRunTotals(player, boundaries) {
      const $ = db.command.aggregate
      const metrics = '$value.result.value.'
      const output = { count: $.sum(1), distance_m: $.sum(metrics + 'distance_m'),
        duration_s: $.sum(metrics + 'duration_s'), longest_distance_m: $.max(metrics + 'distance_m'),
        best_pace_s_per_km: $.min(metrics + 'pace_s_per_km') }
      const query = db.collection(COLLECTION).aggregate().match({
        'value.player_id': player, 'value.ended_at': db.command.gte(0),
        'value.result.value.distance_m': db.command.exists(true)
      })
      // The outside bucket contributes to the lifetime total without returning individual runs.
      const grouped = boundaries ? query.bucket({ groupBy: '$value.ended_at', boundaries, default: 'outside', output })
        : query.group({ _id: null, ...output })
      const { list } = await grouped.end()
      return list
    },
    async personalRunRows(player, { from = 0, until, packedOnly = false }, before, limit) {
      const cmd = db.command
      const range = cmd.gte(from)
      const filter = { 'value.player_id': player, 'value.ended_at': until == null ? range : range.and(cmd.lt(until)) }
      if (packedOnly) {
        filter['value.result.blocks'] = cmd.exists(true)
        filter['value.result.value.distance_m'] = cmd.exists(false)
      }
      const query = before ? cmd.and([filter, cmd.or([
        { 'value.ended_at': cmd.lt(before.ended_at) },
        { 'value.ended_at': before.ended_at, 'value.run_id': cmd.lt(before.run_id) }
      ])]) : filter
      const { data } = await db.collection(COLLECTION).where(query)
        .orderBy('value.ended_at', 'desc').orderBy('value.run_id', 'desc').limit(limit)
        .field({ 'value.run_id': true, 'value.ended_at': true, 'value.result.blocks': true,
          'value.result.value.distance_m': true, 'value.result.value.duration_s': true,
          'value.result.value.pace_s_per_km': true, 'value.result.value.valid_loop': true,
          'value.result.value.pace_anomaly': true }).get()
      return data.map(doc => doc.value)
    },
    async lossReportRows(player, before, limit) {
      const filter = { 'value.report.recipient': player }
      if (before != null) filter['value.loss_revision'] = db.command.lt(before)
      const { data } = await db.collection(COLLECTION).where(filter)
        .orderBy('value.loss_revision', 'desc').limit(limit).field({ 'value.report': true, 'value.loss_revision': true }).get()
      return data.map(row => row.value)
    },
    async reportBoundaryRef(player, id, index) {
      const { data } = await db.collection(COLLECTION).where({ _id: id, 'value.report.recipient': player }).limit(1)
        .field({ 'value.report.id': true, 'value.boundaries.count': true, ['value.boundaries.r' + index]: true }).get()
      return data.length ? (data[0].value.boundaries || {}) : null
    },
    async dueLossNotices(now, limit) {
      const { data } = await db.collection(COLLECTION).where({ 'value.notice_due_at': db.command.lte(now) })
        .orderBy('value.notice_due_at', 'asc').limit(limit).field({ _id: true }).get()
      return data.map(row => row._id)
    },
    async getProfiles(keys) {
      const batches = []
      for (let i = 0; i < keys.length; i += PROFILE_BATCH_SIZE) {
        const ids = keys.slice(i, i + PROFILE_BATCH_SIZE)
        batches.push(db.collection(COLLECTION).where({ _id: db.command.in(ids) })
          .field({ _id: true, 'value.runner_number': true, 'value.display_name': true, 'value.avatar_url': true })
          .limit(ids.length).get())
      }
      const results = await Promise.all(batches)
      return new Map(results.flatMap(({ data }) => data.map(row => [row._id, row.value])))
    },

    async scoreBoard(metric, scope, periodKey) {
      const { property, reachedAt, scale } = METRICS[metric]
      const national = scope === 'national'
      let query = scores.aggregate().match({ board: periodBoard(scope, periodKey), [property]: db.command.gt(0) })
        .sort({ [property]: -1, [reachedAt]: 1, subject: 1 })
      if (national) query = query.limit(NATIONAL_LIMIT)
      // Assign positions from the same ordered read that determines the cutoff.
      const { list } = await query.group({
        _id: null, entries: db.command.aggregate.push({ subject: '$subject', units: '$' + property })
      }).end()
      const rows = list[0]?.entries || []
      const entries = rows.map(({ subject, units }, i) => ({ rank: i + 1, subject, value: units / scale }))
      return national ? { metric, rank_limit: NATIONAL_LIMIT, entries } : { metric, entries }
    },

    async personalRank(metric, player, entries, periodKey) {
      const own = entries.find(entry => entry.subject === player)
      if (own) return { rank: own.rank, value: own.value }
      if (entries.length < NATIONAL_LIMIT) return { rank: null, value: 0 }
      const { property, scale } = METRICS[metric]
      const row = await records.getScore(scoreKey(periodBoard('national', periodKey), player))
      if (!row || !(row[property] > 0)) return { rank: null, value: 0 }
      return { rank: null, value: row[property] / scale, outside_limit: true }
    },

    async *finishedRuns(withTrack = false) {
      const pageSize = 100
      const fields = { _id: true, 'value.player_id': true, 'value.result.value.distance_m': true, 'value.result.blocks': true }
      if (withTrack) Object.assign(fields, { 'value.province_distances': true, 'value.city_distances': true })
      let after
      for (;;) {
        const filter = { 'value.ended_at': db.command.gte(0) }
        if (after) filter._id = db.command.gt(after)
        // Inline results only need distance; larger results have immutable block references.
        const { data } = await db.collection(COLLECTION).where(filter)
          .orderBy('_id', 'asc').limit(pageSize).field(fields).get()
        if (withTrack) {
          // Settlements without a city breakdown use the original GPS fixes. Read only those tracks.
          const missing = data.filter(d => !d.value.province_distances && !d.value.city_distances)
          for (let i = 0; i < missing.length; i += 25) {
            const group = missing.slice(i, i + 25)
            const docs = new Map(group.map(doc => [doc._id, doc.value]))
            const tracks = await db.collection(COLLECTION).where({ _id: db.command.in([...docs.keys()]) })
              .limit(group.length).field({ _id: true, 'value.points': true, 'value.started_at': true, 'value.ended_at': true }).get()
            for (const track of tracks.data) Object.assign(docs.get(track._id), track.value)
          }
        }
        for (const doc of data) yield doc.value
        if (data.length < pageSize) return
        after = data[data.length - 1]._id
      }
    },
    transaction(work) {
      return db.runTransaction(tx => work(documents(tx)))
    }
  }
}

module.exports = { createRepository }

const test = require('node:test')
const assert = require('node:assert/strict')
const { recordedTrackMap } = require('../miniprogram/lib/map')
const { generateRunPoster } = require('../miniprogram/lib/run-poster')
const config = require('../miniprogram/config')

function mockCanvas(t) {
  const previous = global.wx
  t.after(() => { global.wx = previous })
  const text = [], paths = [], images = [], requested = []
  let vertices = []
  const ctx = {
    fillRect() {}, scale() {}, arc() {}, fill() {}, save() {}, restore() {}, rect() {}, clip() {},
    translate() {}, rotate() {}, transform() {}, closePath() {},
    beginPath() { vertices = [] },
    stroke() { if (vertices.length > 1) paths.push(vertices) },
    fillText(value) { text.push(value) },
    drawImage(image) { images.push(image.src) },
    measureText(value) { return { width: value.length * 100 } },
    moveTo(x, y) { vertices.push([x, y]) },
    lineTo(x, y) { vertices.push([x, y]) }
  }
  const page = {}, canvas = { getContext: () => ctx,
    createImage() {
      return { width: 512, height: 512, set src(path) {
        requested.push(path)
        Object.defineProperty(this, 'src', { value: path })
        // Exercise the readable numeric fallback on devices that cannot decode the atlas.
        if (path.endsWith('numerals.png')) this.onerror()
        else this.onload()
      } }
    }
  }
  const query = {
    in(value) { assert.equal(value, page); return this },
    select(id) { assert.equal(id, '#run-share-canvas'); return this },
    fields() { return this },
    exec(callback) { callback([{ node: canvas }]) }
  }
  global.wx = { createSelectorQuery: () => query, canvasToTempFilePath(options, owner) {
    assert.equal(options.canvas, canvas)
    assert.equal(owner, page)
    assert.deepEqual([options.destWidth, options.destHeight], [canvas.width, canvas.height])
    options.success({ tempFilePath: 'wxfile://tmp/run.png' })
  } }
  return { page, canvas, text, paths, images, requested }
}

test('生成海报保留定位断点、长轨迹端点和北京时间的完赛日期', async t => {
  const { page, paths, text, images, requested } = mockCanvas(t)
  const previous = config.runPosterCodePath
  t.after(() => { config.runPosterCodePath = previous })
  config.runPosterCodePath = ''
  const points = Array.from({ length: 2000 }, (_, i) => ({
    longitude: 121 + i * 0.000001, latitude: 31, timestamp: i, accuracy: 3
  }))
  points.push({ ...points[1999], timestamp: 2080, latitude: 31.001 },
    { ...points[0], timestamp: 2081, latitude: 31.001 })
  const map = recordedTrackMap(points)
  const path = await generateRunPoster(page, {
    ended_at: Date.parse('2026-11-26T16:02:00Z') / 1000,
    distance_m: 3038, duration_s: 1598, pace_s_per_km: 526, best_split_s_per_km: 486,
    valid_loop: true, area_m2: 220
  }, map)
  assert.equal(path, 'wxfile://tmp/run.png')
  assert.deepEqual(requested, ['/assets/run-poster-runner.png', '/assets/run-poster-numerals.png'])
  assert.ok(text.includes('微信小程序') && text.includes('跑步出圈'))
  assert.ok(!text.includes('长按进入小程序'))
  assert.ok(images.includes('/assets/run-poster-runner.png'))
  for (const value of ['2026.11.27', '3.04', '220 m²']) assert.ok(text.includes(value))
  const statsStart = text.indexOf('用时 · 分:秒')
  assert.deepEqual(text.slice(statsStart, statsStart + 6), [
    '用时 · 分:秒', '26:38', '平均配速 / 公里', '8′46″', '最快配速 / 公里', '8′06″'
  ])
  assert.equal(paths.length, 2)
  assert.ok(paths[0].length < 600)
  assert.equal(paths[0][0][0], paths[1].at(-1)[0])
  assert.equal(paths[0].at(-1)[0], paths[1][0][0])
  assert.ok(paths[1][0][1] < paths[0].at(-1)[1])
})

test('配置了可读取的微信小程序码才显示长按识别入口', async t => {
  const { page, images, text } = mockCanvas(t)
  const previous = config.runPosterCodePath
  t.after(() => { config.runPosterCodePath = previous })
  config.runPosterCodePath = '/assets/run-poster-code.png'
  await generateRunPoster(page, { distance_m: 700 }, null)
  assert.ok(images.includes(config.runPosterCodePath))
  assert.ok(text.includes('长按进入小程序'))
  assert.ok(!text.includes('微信小程序'))
})

test('无轨迹或缺少配速时仍可导出成绩图', async t => {
  const { page, canvas, paths, text } = mockCanvas(t)
  await generateRunPoster(page, { distance_m: 305, duration_s: 180, pace_s_per_km: null }, null)
  assert.ok(canvas.height < canvas.width)
  assert.deepEqual(paths, [])
  assert.ok(text.includes('0.30'))
  assert.ok(text.includes('3:00'))
  assert.equal(text[text.indexOf('最快配速 / 公里') + 1], '—')
  assert.equal(text[text.indexOf('平均配速 / 公里') + 1], '—')
  assert.ok(!text.includes('闭环面积'))
})

test('只有一个位置的历史记录使用紧凑海报', async t => {
  const { page, canvas, paths } = mockCanvas(t)
  const point = { longitude: 121, latitude: 31, timestamp: 100, accuracy: 4 }
  const route = recordedTrackMap([point, { ...point, timestamp: 110 }])
  await generateRunPoster(page, { distance_m: 0, duration_s: 10 }, route)
  assert.ok(canvas.height < canvas.width)
  assert.deepEqual(paths, [])
})

test('全国名次和累计成绩与分省个人贡献、全省累计各自对应', async t => {
  const { page, text } = mockCanvas(t)
  await generateRunPoster(page, { distance_m: 7200 }, null, {
    national: { distance: { rank: 189, value: 1034567 }, area: { rank: 51, value: 54321 } },
    provinces: [
      { display_name: '浙江省', distance_m: 4180, area_m2: 18.5, total_distance_m: 1234900, total_area_m2: 9988 },
      { display_name: '上海市', distance_m: 3020, area_m2: 0, total_distance_m: 73600, total_area_m2: 500 },
      { display_name: '江苏省', distance_m: 0, area_m2: 0, total_distance_m: 1000, total_area_m2: 500 }
    ]
  })
  assert.deepEqual(text.slice(text.indexOf('全国总里程')), [
    '全国总里程', '第189名', '共 1,034.57 km', '全国领地面积', '第51名', '共 54,321 m²',
    '省份贡献', '省份', '项目', '我本次贡献', '全省累计',
    '浙江省', '里程', '4.18 km', '1,234.90 km', '圈地', '18.5 m²', '9,988 m²',
    '上海市', '里程', '3.02 km', '73.60 km'
  ])
})

test('没有排名或本次省份贡献时保持原海报尺寸，有哪项展示哪项', async t => {
  const { page, canvas, text } = mockCanvas(t)
  const run = { distance_m: 300 }
  await generateRunPoster(page, run, null)
  const height = canvas.height
  await generateRunPoster(page, run, null, { national: { area: null, distance: null },
    provinces: [{ display_name: '无贡献', distance_m: 0, area_m2: 0 }] })
  assert.equal(canvas.height, height)
  assert.ok(!text.includes('省份贡献'))
  await generateRunPoster(page, run, null, { national: { distance: null, area: { rank: 23, value: 0.005 } },
    provinces: [{ display_name: '广西壮族自治区', area_m2: 0.005, total_area_m2: 1.25 }] })
  assert.ok(!text.includes('全国总里程'))
  assert.ok(!text.includes('里程'))
  assert.ok(text.includes('共 <0.01 m²'))
  assert.deepEqual(text.slice(-4), ['广西壮族自治区', '圈地', '<0.01 m²', '1.3 m²'])
})

test('长海报控制画布尺寸且仍包含最后一省', async t => {
  const { page, canvas, text } = mockCanvas(t)
  const provinces = Array.from({ length: 34 }, (_, i) => ({
    display_name: '省份' + i, distance_m: 10, total_distance_m: 3e12, area_m2: 3, total_area_m2: 6e15
  }))
  const route = recordedTrackMap([{ latitude: 30, longitude: 100, timestamp: 100, accuracy: 5 },
    { latitude: 31, longitude: 100, timestamp: 110, accuracy: 5 }])
  await generateRunPoster(page, { distance_m: 340 }, route, { provinces })
  assert.ok(canvas.height <= 4096)
  assert.ok(canvas.width >= 720)
  assert.equal(text.filter(value => value === '圈地').length, 34)
  assert.deepEqual(text.slice(-7), ['省份33', '里程', '0.01 km', '3,000,000,000.00 km',
    '圈地', '3 m²', '6,000,000,000,000,000 m²'])
})

const test = require('node:test')
const assert = require('node:assert/strict')
const map = require('../miniprogram/lib/shape-map')

let definition
global.Page = page => { definition = page }
require('../miniprogram/pages/demo/index')
delete global.Page

const land = {
  owner: 'b', owner_display_name: '公园跑步小队', pace: 360, labelPoint: [100, 100], labelClearance: 18,
  geometry: [[[[82, 82], [118, 82], [118, 118], [82, 118], [82, 82]]]]
}
const avatar = { width: 90, height: 60 }

function paintedMarker(piece, image, selected) {
  let crop, label
  const ctx = new Proxy({
    drawImage(...args) { crop = args },
    fillText(title, x, y) { if (title === '公园跑…') label = [x, y] },
    createLinearGradient() { return { addColorStop() {} } }
  }, { get: (target, key) => target[key] || (() => {}) })
  map.render(ctx, { territories: [piece], draft: [], runnerBAvatar: image, selection: selected })
  return { crop, label }
}

test('乙的头像与省略昵称都可点选全名，浮起时跟随地块', () => {
  const base = paintedMarker(land, avatar)
  assert.deepEqual(base.crop.slice(0, 5), [avatar, 15, 0, 60, 60])
  const page = { ...definition, territories: [land], runnerBAvatar: avatar, paint() {},
    setData(data) { this.selected = data.selected } }
  const [, , , , , left, top, width, height] = base.crop
  page.inspect([left + width / 2, map.HEIGHT - top - height / 2])
  assert.equal(page.selected.title, '公园跑步小队的领地')
  const lifted = paintedMarker(land, avatar, page.selection)
  assert.equal(lifted.label[1], base.label[1] - 9)
  assert.equal(lifted.crop[6], top - 9)
  page.inspect([lifted.label[0], map.HEIGHT - lifted.label[1]])
  assert.equal(page.selected.title, '公园跑步小队的领地')
  // This click is in the avatar extending outside the land's left edge.
  const avatarEdge = [left + 1, map.HEIGHT - base.label[1]]
  assert.equal(map.pickTerritory([land], null, avatarEdge, avatar).land, land)
  assert.equal(map.pickTerritory([land], null, avatarEdge, null).land, null)
  assert.equal(paintedMarker(land, null).crop, undefined)
  assert.equal(paintedMarker({ ...land, owner: 'c' }, avatar).crop, undefined)
})

test('画布替换和页面退出后忽略旧头像回调，加载失败可继续显示昵称', () => {
  const frames = []
  const page = { ...definition, paint() { frames.push(this.runnerBAvatar) } }
  const create = () => {
    const image = { width: 32, height: 32 }
    page.canvas = { createImage: () => image }
    page.loadRunnerBAvatar(page.canvas)
    assert.equal(image.src, '/assets/runner-b.jpg')
    return image
  }
  const oldImage = create()
  const image = create()
  oldImage.onload()
  image.onerror()
  assert.deepEqual(frames, [null])
  const loaded = create()
  loaded.onload()
  assert.deepEqual(frames, [null, loaded])
  page.onUnload()
  loaded.onerror()
  assert.deepEqual(frames, [null, loaded])
})

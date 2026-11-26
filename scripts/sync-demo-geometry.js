const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'cloudfunctions/running/geometry.js')
const target = path.join(root, 'miniprogram/lib/generated/geometry.js')
const npmImport = "require('polygon-clipping')"
const miniImport = "require('../../vendor/polygon-clipping')"
const server = fs.readFileSync(source, 'utf8')
if (!server.includes(npmImport)) throw new Error('请检查云函数的 polygon-clipping 依赖路径')
const generated = server.replace(npmImport, miniImport)

if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== generated) {
    throw new Error('圈地测试页的判定代码需要更新，请运行 node scripts/sync-demo-geometry.js')
  }
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, generated)
}

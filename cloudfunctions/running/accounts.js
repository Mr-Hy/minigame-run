'use strict'

const { createHash, randomUUID } = require('node:crypto')
const { imageSize } = require('image-size')

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const NICKNAME = /^[^\r\n\v\f\u0085\u2028\u2029]{1,32}$/u
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code })
}

function loginRequired() {
  fail(401, 'login_required', '请先选择微信头像并登录')
}

function playerId(context) {
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID ||
      typeof context.APPID !== 'string' || !context.APPID) loginRequired()
  const digest = createHash('sha256').update(context.APPID + '/' + context.OPENID).digest('hex')
  return 'wx-' + digest
}

function validPng(data) {
  let hasImage = false
  for (let pos = 8; pos + 12 <= data.length;) {
    const length = data.readUInt32BE(pos)
    const end = pos + 8 + length
    if (end + 4 > data.length) return false
    let crc = 0xffffffff
    for (let i = pos + 4; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ (crc >>> 8)
    if (((~crc) >>> 0) !== data.readUInt32BE(end)) return false
    const type = data.toString('ascii', pos + 4, pos + 8)
    if (pos === 8 && (type !== 'IHDR' || length !== 13)) return false
    if (type === 'IDAT' && length > 0) hasImage = true
    if (type === 'IEND') return hasImage && length === 0
    pos = end + 4
  }
  return false
}

function validWebp(data) {
  const end = data.readUInt32LE(4) + 8
  if (end > data.length || end < 20) return false
  let hasFrame = false
  let pos = 12
  while (pos + 8 <= end) {
    const type = data.toString('ascii', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    if (['VP8 ', 'VP8L', 'ANMF'].includes(type) && size >= 5) hasFrame = true
    pos += 8 + size + (size % 2)
  }
  return hasFrame && pos === end
}

function decodeAvatar(encoded) {
  const invalid = () => fail(400, 'invalid_avatar', '请选择有效的 PNG、JPEG 或 WebP 格式头像')
  const tooLarge = () => fail(413, 'avatar_too_large', '头像图片大小不能超过 2 MiB')
  if (typeof encoded !== 'string' || !encoded) invalid()
  if (encoded.length > 4 * Math.ceil(MAX_AVATAR_BYTES / 3)) tooLarge()
  const data = Buffer.from(encoded, 'base64')
  if (data.length > MAX_AVATAR_BYTES) tooLarge()
  if (data.toString('base64') !== encoded) invalid()

  let format
  if (data.subarray(0, 8).equals(PNG_SIGNATURE) && validPng(data)) format = 'png'
  if (data.length >= 4 && data.readUInt16BE(0) === 0xffd8) {
    const scan = data.indexOf(Buffer.from([0xff, 0xda]), 2)
    if (scan >= 0 && data.indexOf(Buffer.from([0xff, 0xd9]), scan + 2) >= 0) format = 'jpg'
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' &&
      validWebp(data)) format = 'webp'
  if (!format) invalid()

  let dimensions
  try {
    dimensions = imageSize(data)
  } catch {
    invalid()
  }
  if (dimensions.type !== format || !dimensions.width || !dimensions.height ||
      dimensions.width * dimensions.height > 178956970) invalid()
  return { data, format }
}

function publicProfile(player, account) {
  return {
    player_id: player,
    runner_number: account.runner_number,
    display_name: account.display_name || '跑者_' + String(account.runner_number).padStart(5, '0'),
    avatar_url: account.avatar_url
  }
}

function createAccounts(repo, cloud) {
  function key(player) { return 'a' + player.slice(3, 34) }

  async function current(context) {
    const player = playerId(context)
    const account = await repo.get(key(player))
    if (!account || !account.avatar_url) loginRequired()
    return publicProfile(player, account)
  }

  async function avatarDisplayUrl(fileID) {
    try {
      const { fileList } = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 600, urlType: 'COS_URL' }] })
      const file = fileList[0]
      return file?.status === 0 && file.fileID === fileID && file.tempFileURL?.startsWith('https://') ? file.tempFileURL : ''
    } catch {
      return ''
    }
  }

  async function deleteFiles(ids) {
    const { fileList } = await cloud.deleteFile({ fileList: ids })
    const done = new Set(fileList.filter(item => item.status === 0 || item.status === -503003)
      .map(item => item.fileID))
    if (!ids.every(id => done.has(id))) fail(503, 'storage_unavailable', '云存储暂时无法删除旧头像，请重试')
  }

  // Old IDs are retired in the same transaction as the profile update. A retry
  // can complete an interrupted deletion without touching a newer upload.
  async function removeRetired(player, ids) {
    if (!ids.length) return
    for (let start = 0; start < ids.length; start += 50) {
      await deleteFiles(ids.slice(start, start + 50))
    }
    await repo.transaction(async tx => {
      const account = await tx.get(key(player))
      account.retired = account.retired.filter(id => !ids.includes(id))
      await tx.set(key(player), account)
    })
  }

  async function changeAvatar(context, encoded, operation) {
    const player = playerId(context)
    let fileID = ''
    if (operation !== 'logout') {
      if (operation === 'update') await current(context)
      const { data, format } = decodeAvatar(encoded)
      const upload = await cloud.uploadFile({
        cloudPath: 'running-avatars/' + randomUUID() + '.' + format,
        fileContent: data
      })
      fileID = upload.fileID
      if (!fileID || !fileID.startsWith('cloud://')) fail(503, 'storage_unavailable', '云存储暂时无法保存头像')
    }

    let changed
    try {
      changed = await repo.transaction(async tx => {
        let account = await tx.get(key(player))
        if (operation !== 'login' && !account?.avatar_url) {
          // A logout retry may still have a previously retired file to delete.
          if (operation === 'logout' && account?.retired.length) return account
          loginRequired()
        }
        if (!account) {
          const counter = await tx.get('runner-counter')
          const number = (counter?.last || 0) + 1
          await tx.set('runner-counter', { last: number })
          account = { runner_number: number, avatar_url: '', retired: [] }
        }
        if (account.avatar_url) account.retired.push(account.avatar_url)
        account.avatar_url = fileID
        await tx.set(key(player), account)
        return account
      })
    } catch (err) {
      if (fileID) {
        // A lost commit reply is ambiguous. Keep any currently referenced file.
        const stored = await repo.get(key(player))
        if (stored?.avatar_url !== fileID) await deleteFiles([fileID])
      }
      throw err
    }
    await removeRetired(player, changed.retired)
    return operation === 'logout' ? { logged_in: false } : publicProfile(player, changed)
  }

  function ownerInfo(player, account) {
    if (!account) fail(503, 'storage_unavailable', '暂时无法读取领主资料')
    const profile = publicProfile(player, account)
    return { owner_number: profile.runner_number, owner_display_name: profile.display_name,
      owner_avatar_url: profile.avatar_url }
  }

  async function updateNickname(context, body = {}) {
    const player = playerId(context)
    const id = key(player)
    return repo.transaction(async tx => {
      const account = await tx.get(id)
      if (!account?.avatar_url) loginRequired()
      const name = typeof body.nickname === 'string' ? body.nickname.trim() : ''
      if (!NICKNAME.test(name)) fail(400, 'invalid_nickname', '昵称须为 1 至 32 个字符，且不能换行')
      account.display_name = name
      await tx.set(id, account)
      return publicProfile(player, account)
    })
  }

  return {
    current, avatarDisplayUrl,
    async ownerProfile(player) {
      return ownerInfo(player, await repo.get(key(player)))
    },
    async publicProfiles(players) {
      const profiles = await repo.getProfiles(players.map(key))
      return players.map(player => ownerInfo(player, profiles.get(key(player))))
    },
    updateNickname,
    login(context, body = {}) {
      return Object.hasOwn(body, 'avatar_base64') ? changeAvatar(context, body.avatar_base64, 'login') : current(context)
    },
    updateAvatar(context, body = {}) { return changeAvatar(context, body.avatar_base64, 'update') },
    logout(context) { return changeAvatar(context, null, 'logout') }
  }
}

module.exports = { createAccounts, playerId }

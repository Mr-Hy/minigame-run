'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const { createAccounts } = require('../cloudfunctions/running/accounts')

const ALICE = { APPID: 'wxtest', OPENID: 'a' }
const BOB = { APPID: 'wxtest', OPENID: 'b' }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mNkYGhgYGBgYmBgYGBgAAAFqgCE5sww9wAAAABJRU5ErkJggg=='
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCHALkZ/9k='
const WEBP = 'UklGRjgAAABXRUJQVlA4ICwAAABwAQCdASoCAAIAAUAmJaACdAFAAAD+/HaP/7B3//nAf/84D+mDyzOFefAAAA=='

function fixture() {
  const docs = new Map()
  const files = new Map()
  let tail = Promise.resolve()
  const repo = {
    async get(id) { return structuredClone(docs.get(id)) || null },
    transaction(work) {
      const result = tail.then(async () => {
        const changed = new Map()
        const value = await work({
          get: async id => changed.has(id) ? structuredClone(changed.get(id)) : repo.get(id),
          set: async (id, data) => changed.set(id, structuredClone(data))
        })
        for (const [id, data] of changed) docs.set(id, data)
        return value
      })
      tail = result.catch(() => {})
      return result
    }
  }
  const cloud = {
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = 'cloud://test/' + cloudPath
      files.set(fileID, fileContent)
      return { fileID }
    },
    async deleteFile({ fileList }) {
      return { fileList: fileList.map(fileID => ({ fileID, status: files.delete(fileID) ? 0 : -503003 })) }
    }
  }
  return { accounts: createAccounts(repo, cloud), repo, cloud, files }
}

const picture = avatar_base64 => ({ avatar_base64 })

test('trusted cloud context owns the profile and gives each runner a stable number', async () => {
  const { accounts } = fixture()
  await assert.rejects(accounts.login({}, { ...ALICE, avatar_base64: PNG }), { code: 'login_required' })
  await assert.rejects(accounts.login(ALICE, { avatar_file_id: 'cloud://other/file' }), { code: 'login_required' })
  const [alice, bob] = await Promise.all([
    accounts.login(ALICE, { ...picture(PNG), player_id: 'bob', OPENID: 'b' }),
    accounts.login(BOB, picture(PNG))
  ])
  assert.equal(alice.player_id, 'wx-' + createHash('sha256').update('wxtest/a').digest('hex'))
  assert.equal(alice.display_name, '跑者_00001')
  assert.equal(bob.runner_number, 2)
  assert.notEqual(alice.avatar_url, bob.avatar_url)
  assert.deepEqual(await accounts.login(ALICE), alice)
  assert.deepEqual(await accounts.logout(ALICE), { logged_in: false })
  assert.equal((await accounts.ownerProfile(alice.player_id)).owner_avatar_url, '')
  await assert.rejects(accounts.current(ALICE), { code: 'login_required' })
  assert.deepEqual(await accounts.current(BOB), bob)
  const registered = await accounts.login(ALICE, picture(PNG))
  assert.equal(registered.runner_number, alice.runner_number)
})

test('昵称按 Unicode 码点限制长度，退出和重新登录后仍保留', async () => {
  const { accounts } = fixture()
  const nickname = '🏃'.repeat(32)
  const before = await accounts.login(ALICE, picture(PNG))
  const saved = await accounts.updateNickname(ALICE, { nickname })
  assert.deepEqual(saved, { ...before, display_name: nickname })
  for (const invalid of [undefined, 5, '　 ', '跑\n者', '跑\u2028者', nickname + '🏃']) {
    await assert.rejects(accounts.updateNickname(ALICE, { nickname: invalid }), { status: 400, code: 'invalid_nickname' })
  }
  assert.deepEqual(await accounts.login(ALICE), saved)
  await accounts.logout(ALICE)
  await assert.rejects(accounts.updateNickname(ALICE, { nickname: '新名字' }), { code: 'login_required' })
  assert.equal((await accounts.ownerProfile(before.player_id)).owner_display_name, nickname)
  assert.equal((await accounts.login(ALICE, picture(PNG))).display_name, nickname)
})

test('valid PNG, JPEG and WebP pass, truncated and damaged images retain current avatar', async () => {
  const { accounts, files } = fixture()
  await accounts.login(ALICE, picture(PNG))
  for (const encoded of [JPEG, WEBP]) {
    const profile = await accounts.updateAvatar(ALICE, picture(encoded))
    assert.deepEqual(files.get(profile.avatar_url), Buffer.from(encoded, 'base64'))
    assert.equal(files.size, 1)
  }
  const before = await accounts.current(ALICE)
  const brokenPng = Buffer.from(PNG, 'base64')
  brokenPng[40] ^= 1
  for (const invalid of [brokenPng.toString('base64'), 'x', Buffer.from(JPEG, 'base64').subarray(0, -4).toString('base64'),
    Buffer.from(WEBP, 'base64').subarray(0, -4).toString('base64')]) {
    await assert.rejects(accounts.updateAvatar(ALICE, picture(invalid)), { code: 'invalid_avatar' })
  }
  assert.deepEqual(await accounts.current(ALICE), before)

  const padded = Buffer.alloc(2 * 1024 * 1024)
  Buffer.from(JPEG, 'base64').copy(padded)
  await accounts.updateAvatar(ALICE, picture(padded.toString('base64')))
  await assert.rejects(accounts.updateAvatar(ALICE, picture(Buffer.concat([padded, Buffer.from([0])]).toString('base64'))),
    { code: 'avatar_too_large' })
})

test('concurrent replacements retain the winning upload and retire older files', async () => {
  const { accounts, files } = fixture()
  const first = await accounts.login(ALICE, picture(PNG))
  await Promise.all([accounts.updateAvatar(ALICE, picture(JPEG)), accounts.updateAvatar(ALICE, picture(WEBP))])
  const current = await accounts.current(ALICE)
  assert.equal(files.has(first.avatar_url), false)
  assert.deepEqual([...files.keys()], [current.avatar_url])
  assert.equal((await accounts.ownerProfile(current.player_id)).owner_avatar_url, current.avatar_url)
})

test('ambiguous commit reply cannot erase a committed avatar; a failed delete can be retried', async () => {
  const { accounts, repo, cloud, files } = fixture()
  const tx = repo.transaction
  repo.transaction = async work => { await tx(work); throw Error('connection lost') }
  await assert.rejects(accounts.login(ALICE, picture(PNG)), /connection lost/)
  repo.transaction = tx
  const profile = await accounts.current(ALICE)
  assert.equal(files.has(profile.avatar_url), true)
  const remove = cloud.deleteFile
  cloud.deleteFile = async () => ({ fileList: [] })
  await assert.rejects(accounts.logout(ALICE), { code: 'storage_unavailable' })
  assert.equal((await accounts.ownerProfile(profile.player_id)).owner_avatar_url, '')
  cloud.deleteFile = remove
  assert.deepEqual(await accounts.logout(ALICE), { logged_in: false })
  assert.equal(files.size, 0)
})

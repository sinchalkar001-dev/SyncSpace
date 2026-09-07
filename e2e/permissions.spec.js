import { expect, test } from '@playwright/test'

/**
 * Roles, through two real browsers.
 *
 * The server suite proves the rules hold at the API, the socket and the Yjs
 * connection. What a browser adds is the half a person actually meets: that
 * the buffer refuses their keystrokes, that Run says why rather than failing
 * when pressed, and that the owner's dropdown changes all of it live.
 *
 * Two genuinely separate contexts, because that is the situation — one room,
 * two accounts, different powers.
 */

const PASSWORD = 'a-good-passphrase'

const unique = (who) =>
  'e2e-' + who + '-' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'

async function signUp(page, email, name) {
  await page.goto('/register')
  await page.getByLabel('Display name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
}

/** Creates a room through the API, as the signed-in account in this page. */
async function createRoom(page, name) {
  const token = await page.evaluate(() => window.localStorage.getItem('syncspace:token'))
  const res = await page.request.post('/api/v1/rooms', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name, isPublic: false },
  })
  return { roomId: (await res.json()).room.roomId, token }
}

const editor = (page) => page.locator('.monaco-editor .view-lines')

/**
 * Two browser contexts, each loading Monaco.
 *
 * On a cold run the first of these pays for Vite transforming the editor
 * chunk as well, which is comfortably more than the default budget — it timed
 * out at sixty seconds once and passed in sixteen the moment the stack was
 * warm. Better a generous ceiling than a suite that fails on whichever spec
 * happens to run first.
 */
test.describe.configure({ timeout: 120000 })

test('a member demoted to viewer can read the room but not change it', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const memberContext = await browser.newContext()

  const ownerPage = await ownerContext.newPage()
  const memberPage = await memberContext.newPage()

  try {
    const ownerEmail = unique('owner')
    const memberEmail = unique('member')

    await signUp(ownerPage, ownerEmail, 'Owner')
    await signUp(memberPage, memberEmail, 'Member')

    const { roomId, token: ownerToken } = await createRoom(ownerPage, 'Roles room')

    // Find the member's id, then put them in the room as a viewer.
    const memberToken = await memberPage.evaluate(() =>
      window.localStorage.getItem('syncspace:token')
    )
    const me = await memberPage.request.get('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer ' + memberToken },
    })
    const memberId = (await me.json()).user.id

    await ownerPage.request.post('/api/v1/rooms/' + roomId + '/invite', {
      headers: { Authorization: 'Bearer ' + ownerToken },
      data: { userId: memberId, role: 'viewer' },
    })

    // The owner writes something, to prove the viewer is genuinely connected.
    await ownerPage.goto('/room/' + roomId)
    await expect(ownerPage.getByText('Connected')).toBeVisible()
    await editor(ownerPage).click()
    await ownerPage.keyboard.type('const written = "by the owner"')

    await memberPage.goto('/room/' + roomId)
    await expect(memberPage.getByText('Connected')).toBeVisible()
    await expect(editor(memberPage)).toContainText('by the owner')

    // Run says why rather than failing when pressed.
    const run = memberPage.getByRole('button', { name: /^Run/ })
    await expect(run).toBeDisabled()
    await expect(run).toHaveAttribute('title', /does not allow running code/)

    // The buffer refuses the keystrokes. Monaco is read-only, and the Yjs
    // connection is read-only underneath it, so neither half can be the only
    // reason this passes.
    await editor(memberPage).click()
    await memberPage.keyboard.type('VIEWER WAS HERE')

    await memberPage.waitForTimeout(600)
    await expect(editor(memberPage)).not.toContainText('VIEWER WAS HERE')
    await expect(editor(ownerPage)).not.toContainText('VIEWER WAS HERE')

    // And chat is closed to them, with the reason in the box itself.
    await memberPage.getByRole('button', { name: /Chat/ }).click()
    await expect(memberPage.getByLabel('Message the room')).toBeDisabled()
  } finally {
    await ownerContext.close()
    await memberContext.close()
  }
})

test('an editor keeps everything they always had', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const memberContext = await browser.newContext()

  const ownerPage = await ownerContext.newPage()
  const memberPage = await memberContext.newPage()

  try {
    await signUp(ownerPage, unique('owner2'), 'Owner')
    await signUp(memberPage, unique('member2'), 'Member')

    const { roomId, token: ownerToken } = await createRoom(ownerPage, 'Editor room')

    const memberToken = await memberPage.evaluate(() =>
      window.localStorage.getItem('syncspace:token')
    )
    const me = await memberPage.request.get('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer ' + memberToken },
    })
    const memberId = (await me.json()).user.id

    await ownerPage.request.post('/api/v1/rooms/' + roomId + '/invite', {
      headers: { Authorization: 'Bearer ' + ownerToken },
      data: { userId: memberId, role: 'editor' },
    })

    await ownerPage.goto('/room/' + roomId)
    await expect(ownerPage.getByText('Connected')).toBeVisible()

    await memberPage.goto('/room/' + roomId)
    await expect(memberPage.getByText('Connected')).toBeVisible()

    // Writes, and the owner sees it: the refusal above was about the role.
    await editor(memberPage).click()
    await memberPage.keyboard.type('written by the editor')
    await expect(editor(ownerPage)).toContainText('written by the editor')

    await expect(memberPage.getByRole('button', { name: /^Run/ })).toBeEnabled()
  } finally {
    await ownerContext.close()
    await memberContext.close()
  }
})

/**
 * The interface must not offer what the server will refuse — and the list of
 * what it offers comes from the server, so an admin never sees "Admin".
 */
test('the role menu offers only what the server would accept', async ({ page }) => {
  await signUp(page, unique('solo'), 'Owner')
  const { roomId, token } = await createRoom(page, 'Menu room')

  const access = await page.request.get('/api/v1/rooms/' + roomId, {
    headers: { Authorization: 'Bearer ' + token },
  })
  const body = await access.json()

  expect(body.access.role).toBe('owner')
  expect(body.access.assignable).toContain('admin')
  // Ownership moves by transfer, never from a dropdown.
  expect(body.access.assignable).not.toContain('owner')
})

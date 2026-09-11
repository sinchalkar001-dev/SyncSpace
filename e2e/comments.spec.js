import { expect, test } from '@playwright/test'

/**
 * Comments, through two real browsers.
 *
 * The server suite proves the rules and the history; the unit suites prove the
 * anchors resolve. What a browser adds is the whole loop a person meets: a
 * commenter picks up the comment tool on a board they cannot draw on, pins a
 * question to a shape, mentions the owner — and the owner's badge lights up,
 * live, before they have opened anything.
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

const tokenOf = (page) => page.evaluate(() => window.localStorage.getItem('syncspace:token'))

/** Creates a room through the API, as the signed-in account in this page. */
async function createRoom(page, name) {
  const token = await tokenOf(page)
  const res = await page.request.post('/api/v1/rooms', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name, isPublic: false },
  })
  return { roomId: (await res.json()).room.roomId, token }
}

async function invite(ownerPage, ownerToken, roomId, memberPage, role) {
  const me = await memberPage.request.get('/api/v1/auth/me', {
    headers: { Authorization: 'Bearer ' + (await tokenOf(memberPage)) },
  })
  const memberId = (await me.json()).user.id

  await ownerPage.request.post('/api/v1/rooms/' + roomId + '/invite', {
    headers: { Authorization: 'Bearer ' + ownerToken },
    data: { userId: memberId, role },
  })
}

async function enter(page, roomId) {
  await page.goto('/room/' + roomId)
  await expect(page.getByText('Connected')).toBeVisible()
}

const commentsButton = (page) => page.getByRole('button', { name: /^Comments/ })
const commentsPanel = (page) => page.getByRole('dialog', { name: 'Comments' })
const tools = (page) => page.getByRole('toolbar', { name: 'Drawing tools' })

/** Two browser contexts, each loading Monaco — see permissions.spec.js. */
test.describe.configure({ timeout: 120000 })

test('a commenter pins a question to a shape, and the owner sees it arrive', async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const commenterContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  const commenterPage = await commenterContext.newPage()

  try {
    await signUp(ownerPage, unique('owner'), 'Owner')
    await signUp(commenterPage, unique('commenter'), 'Critic')

    const { roomId, token } = await createRoom(ownerPage, 'Review room')
    await invite(ownerPage, token, roomId, commenterPage, 'commenter')

    await enter(ownerPage, roomId)
    await enter(commenterPage, roomId)

    // The owner draws the thing to be talked about.
    await tools(ownerPage).getByRole('button', { name: 'Rectangle' }).click()
    const ownerBoard = await ownerPage.locator('.board').boundingBox()
    await ownerPage.mouse.move(ownerBoard.x + 260, ownerBoard.y + 220)
    await ownerPage.mouse.down()
    await ownerPage.mouse.move(ownerBoard.x + 520, ownerBoard.y + 400, { steps: 8 })
    await ownerPage.mouse.up()

    // A commenter cannot draw, but the comment tool is theirs to use.
    await expect(tools(commenterPage).getByRole('button', { name: 'Rectangle' })).toBeDisabled()
    const tool = tools(commenterPage).getByRole('button', { name: 'Comment' })
    await expect(tool).toBeEnabled()
    await tool.click()

    // On the rectangle's edge, so the hit does not depend on how its inside is tested.
    const board = await commenterPage.locator('.board').boundingBox()
    await expect(async () => {
      await commenterPage.mouse.click(board.x + 390, board.y + 221)
      await expect(commenterPage.getByRole('region', { name: 'New comment' })).toContainText(
        'New comment on Rectangle',
        { timeout: 1500 }
      )
    }).toPass({ timeout: 15000 })

    const field = commenterPage.getByRole('combobox', { name: 'New comment' })
    await field.pressSequentially('Is this the cache? @Ow')
    await commenterPage.getByRole('option', { name: 'Owner' }).click()
    await field.pressSequentially('can you confirm')
    await field.press('Control+Enter')

    await expect(
      commentsPanel(commenterPage).getByRole('article', { name: 'Comment on Rectangle' })
    ).toContainText('Is this the cache? @Owner can you confirm')

    // Live, and marked as a mention, before the owner has opened anything.
    await expect(
      ownerPage.getByRole('button', { name: 'Comments (1 new, 1 mentioning you)' })
    ).toBeVisible()

    await commentsButton(ownerPage).click()
    const thread = commentsPanel(ownerPage).getByRole('article', { name: 'Comment on Rectangle' })
    await expect(thread.getByText('@Owner')).toHaveClass(/thread__mention/)

    // Reading it clears the badge.
    await expect(ownerPage.getByRole('button', { name: 'Comments', exact: true })).toBeVisible()

    // Resolving travels back the other way.
    await thread.getByRole('button', { name: 'Resolve' }).click()
    await expect(
      commentsPanel(commenterPage).getByRole('article', { name: 'Comment on Rectangle' })
    ).toHaveCount(0)
    await commentsPanel(commenterPage).getByRole('tab', { name: /Resolved/ }).click()
    await expect(
      commentsPanel(commenterPage).getByRole('article', { name: 'Comment on Rectangle' })
    ).toContainText('Resolved')

    // And none of it was only in memory.
    await ownerPage.reload()
    await expect(ownerPage.getByText('Connected')).toBeVisible()
    await commentsButton(ownerPage).click()
    await commentsPanel(ownerPage).getByRole('tab', { name: /Resolved/ }).click()
    await expect(
      commentsPanel(ownerPage).getByRole('article', { name: 'Comment on Rectangle' })
    ).toContainText('Is this the cache?')
  } finally {
    await ownerContext.close()
    await commenterContext.close()
  }
})

test('a code comment stays with its line when lines are added above it', async ({ page }) => {
  await signUp(page, unique('coder'), 'Coder')
  const { roomId } = await createRoom(page, 'Code comments')
  await enter(page, roomId)

  const editor = page.locator('.monaco-editor .view-lines')
  await editor.click()
  await page.keyboard.type('const a = 1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const target = 2')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const c = 3')

  // Select the second line and comment on it.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('button', { name: 'Comment on this code' }).click()

  const draft = page.getByRole('region', { name: 'New comment' })
  await expect(draft).toContainText('New comment on Line 2')
  await page.getByRole('combobox', { name: 'New comment' }).pressSequentially('Rename this')
  await page.getByRole('combobox', { name: 'New comment' }).press('Control+Enter')

  await expect(commentsPanel(page).getByRole('article', { name: 'Comment on Line 2' })).toBeVisible()
  await expect(page.locator('.comment-glyph')).toHaveCount(1)

  // Ctrl+Enter sent the comment. It is also the editor's Run shortcut, and it
  // must not have run the program on the way.
  await expect(page.getByRole('region', { name: 'Program output' })).toHaveCount(0)

  // Two lines typed above it, by the same person, in the same buffer.
  await editor.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('// one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('// two')
  await page.keyboard.press('Enter')

  await commentsButton(page).click()
  await expect(commentsPanel(page).getByRole('article', { name: 'Comment on Line 4' })).toContainText(
    'Rename this'
  )
})

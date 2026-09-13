import { expect, test } from '@playwright/test'

/**
 * The copilot, driven in a real browser against the real stack.
 *
 * Everything here is real except the model: the real Yjs document, the real
 * server reading it, the real SSE stream, the real review screen, the real
 * buffer. The stand-in (e2e/fixtures/model-stub.js) shapes its answer from the
 * tool schema it is handed, so a `findings` list arriving on screen is proof
 * that the block registry built a schema, the model was asked with it, and the
 * sanitiser read it back — which a canned reply could never show.
 *
 * The test worth having is the last one. A copilot that applies a change over
 * editing somebody did while it was thinking is worse than no copilot, and it
 * is the kind of fault that only shows up with two things happening at once.
 */

const PASSWORD = 'a-good-passphrase'

const newRoom = () => 'cop-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

async function signUp(page) {
  const email = 'e2e' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Tester')
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
  return email
}

async function enterRoom(page, roomId) {
  await page.goto('/room/' + roomId)
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 30000 })
}

const BUGGY = ['function add(a, b) {', '  return a - b', '}'].join('\n')

async function focusEditor(page) {
  await page.locator('.monaco-editor .view-lines').click()
  await expect(page.locator('.monaco-editor textarea')).toBeFocused()
}

/**
 * Puts a program in the shared editor by pasting it.
 *
 * Typed, it would not survive: Monaco closes braces as they arrive and
 * re-indents around them, so `function add(a, b) {` ends up with a brace this
 * test never wrote. run.spec.js pastes for the same reason.
 */
async function writeCode(page, text = BUGGY, settled = 'return a - b') {
  await page.getByRole('tab', { name: 'Code' }).click()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await focusEditor(page)
  await page.evaluate((code) => navigator.clipboard.writeText(code), text)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+V')
  await expect(page.locator('.view-lines')).toContainText(settled)
}

const openCopilot = async (page) => {
  await page.getByRole('button', { name: 'Engineering copilot' }).click()
  await expect(page.getByRole('complementary', { name: 'Engineering copilot' })).toBeVisible()
}

const panel = (page) => page.getByRole('complementary', { name: 'Engineering copilot' })

test.describe('the engineering copilot', () => {
  test('answers about the code, saying what it read before it says anything else', async ({
    page,
  }) => {
    await signUp(page)
    const roomId = newRoom()
    await enterRoom(page, roomId)
    await writeCode(page, BUGGY)

    await openCopilot(page)

    // The code is what is on screen, so that is what it offers.
    await expect(panel(page).getByRole('button', { name: /Review/ })).toBeVisible()
    await panel(page).getByRole('button', { name: /Review/ }).click()

    // What it read, named and counted — and it counted the buffer, which only
    // the server could have done, because the browser never sent the code.
    await expect(panel(page).getByText('Shared code buffer')).toBeVisible()
    await expect(panel(page).locator('.copilot__chip.is-empty')).toHaveCount(1)
    await expect(panel(page).locator('.copilot__chipdetail').first()).toHaveText('3 lines')

    // The prose, then the structured part the action declared.
    await expect(panel(page).getByText(/Answering with/)).toBeVisible()
    await expect(
      panel(page).getByText('Subtraction where the name says addition')
    ).toBeVisible()

    // Worst first: the high finding is above the low one.
    const titles = await panel(page).locator('.copilot__finding strong').allTextContents()
    expect(titles[0]).toContain('Subtraction')
  })

  test('needs a selection before it will explain one, and says so', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await writeCode(page, BUGGY)
    await openCopilot(page)

    const explain = panel(page).getByRole('button', { name: /Explain selection/ })
    await expect(explain).toBeDisabled()
    await expect(explain).toHaveAccessibleName(/Select some code first/)

    // Select the whole buffer, and it becomes available. Clicking the text
    // layer rather than the hidden textarea: Monaco's own view lines sit on
    // top and intercept the pointer.
    await focusEditor(page)
    await page.keyboard.press('Control+A')

    await expect(explain).toBeEnabled()
  })

  test('follows the room: a failed run moves it to the runs', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())

    await writeCode(page, 'throw new Error("boom")', 'throw new Error')

    await page.getByRole('button', { name: /^Run/ }).click()
    await expect(page.getByText(/boom/).first()).toBeVisible({ timeout: 30000 })

    await openCopilot(page)

    // Without being told, the panel is now about the run that just failed.
    await expect(panel(page).getByRole('button', { name: /Diagnose failure/ })).toBeVisible()
    await expect(panel(page).getByRole('button', { name: /^Runs/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  test('can be corrected when its guess is wrong', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await openCopilot(page)

    await panel(page).getByRole('button', { name: /^Room/ }).click()

    await expect(panel(page).getByRole('button', { name: /Summarize session/ })).toBeVisible()
  })

  test('proposes a change to the code and applies nothing until it is accepted', async ({
    page,
  }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await writeCode(page, BUGGY)
    await openCopilot(page)

    await panel(page).getByRole('button', { name: /Find bug/ }).click()
    await expect(panel(page).getByText('Proposed change to the code')).toBeVisible()

    // Shown as the lines it would touch, and the buffer is untouched so far.
    await expect(panel(page).locator('.copilot__diffrow.is-removed')).toContainText('return a - b')
    await expect(panel(page).locator('.copilot__diffrow.is-added')).toContainText('return a + b')
    await expect(page.locator('.view-lines')).toContainText('return a - b')

    await panel(page).getByRole('button', { name: 'Apply to the code' }).click()

    await expect(page.locator('.view-lines')).toContainText('return a + b')
    await expect(panel(page).getByText('Applied to the buffer.')).toBeVisible()

    // Narrowed to the line that differs: the rest of the buffer is untouched,
    // which is what keeps cursors and comment anchors where they were.
    await expect(page.locator('.view-lines')).toContainText('function add(a, b)')
  })

  /**
   * The reason the patch carries the text it was written against.
   *
   * Somebody types while the answer is on screen. The approval would be for
   * code that is no longer there, so it is refused — and refused visibly,
   * before the button is pressed, because the person can see the code changing
   * beside them and a warning that only appeared afterwards would read as the
   * feature being broken.
   */
  test('refuses to apply over editing done while it was thinking', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await writeCode(page, BUGGY)
    await openCopilot(page)

    await panel(page).getByRole('button', { name: /Find bug/ }).click()
    await expect(panel(page).getByText('Proposed change to the code')).toBeVisible()

    // Now edit the buffer the proposal was written against.
    await focusEditor(page)
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\n// somebody else was here')
    await expect(page.locator('.view-lines')).toContainText('somebody else was here')

    await expect(panel(page).getByText(/code has changed since this was written/)).toBeVisible()
    await expect(panel(page).getByRole('button', { name: 'Apply to the code' })).toBeDisabled()

    // And the edit stands: nothing was written over it.
    await expect(page.locator('.view-lines')).toContainText('somebody else was here')
    await expect(page.locator('.view-lines')).toContainText('return a - b')
  })

  test('reviews proposed files one at a time, and refuses a path that escapes', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await writeCode(page, BUGGY)
    await openCopilot(page)

    await panel(page).getByRole('button', { name: /Generate tests/ }).click()
    await expect(panel(page).getByText('test/generated.test.js')).toBeVisible()

    /*
      The stub proposes one path that climbs out of the project. It must not
      appear as a file — but it does appear in the sentence explaining why it
      was refused, which is the point, so this asks about the file rows rather
      than about the whole panel.
    */
    await expect(panel(page).locator('.changeset__path')).toHaveText(['test/generated.test.js'])
    await expect(panel(page).getByText(/unusable path/)).toBeVisible()

    await panel(page).getByRole('button', { name: /^Apply 1/ }).click()
    await expect(panel(page).getByText('Applied', { exact: false }).first()).toBeVisible()

    // And it is a real file in the room now.
    await page.getByRole('button', { name: /^Files/ }).click()
    await expect(page.getByText('test_generated.test.js')).toBeVisible()
  })

  test('keeps what it was asked, with the room data it read', async ({ page }) => {
    await signUp(page)
    await enterRoom(page, newRoom())
    await writeCode(page, BUGGY)
    await openCopilot(page)

    await panel(page).getByRole('button', { name: /Review/ }).click()
    await expect(panel(page).getByText(/Answering with/)).toBeVisible()

    await panel(page).getByRole('button', { name: 'Back' }).click()

    await expect(panel(page).getByText('Asked in this room')).toBeVisible()
    await expect(panel(page).getByText(/Answering with/)).toBeVisible()
  })
})

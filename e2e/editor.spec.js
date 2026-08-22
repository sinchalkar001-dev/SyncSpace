import { expect, test } from '@playwright/test'

const newRoom = () => 'ed-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

/** Monaco's real textarea sits under the rendered lines; click those instead. */
async function focusEditor(page) {
  await page.locator('.monaco-editor .view-lines').click()
  await expect(page.locator('.monaco-editor textarea')).toBeFocused()
}

async function openRoom(page, id = newRoom()) {
  await page.goto('/room/' + id)
  await expect(page.getByText('Connected')).toBeVisible()
  await expect(page.locator('.statusbar')).toBeVisible()
  return id
}

test('the status bar reports the caret position as it moves', async ({ page }) => {
  await openRoom(page)

  const status = page.locator('.statusbar')
  await expect(status).toContainText('Ln 1, Col 1')

  await focusEditor(page)
  await page.keyboard.type('const answer = 42')
  await expect(status).toContainText('Ln 1, Col 18')

  await page.keyboard.press('Enter')
  await expect(status).toContainText('Ln 2, Col 1')

  await page.keyboard.press('Shift+Home')
  await expect(status).toContainText('Ln 2, Col 1')
})

test('the language picker searches, applies, and survives a reload', async ({ page }) => {
  const id = await openRoom(page)

  await page.locator('.langpicker__trigger').click()
  await page.locator('.langpicker__search').fill('pyth')

  const options = page.locator('.langpicker__item')
  await expect(options).toHaveCount(1)
  await options.first().click()

  await expect(page.locator('.langpicker__trigger')).toContainText('python')
  await expect(page.locator('.statusbar')).toContainText('python')

  // The choice is a stored workspace preference, not room state.
  await page.reload()
  await expect(page.locator('.langpicker__trigger')).toContainText('python')

  // Reopening shows it as a recent language rather than buried in the list.
  await page.locator('.langpicker__trigger').click()
  await expect(page.locator('.langpicker__item').first()).toContainText('python')
  await expect(page.locator('.langpicker__tag').first()).toHaveText('recent')
  await page.keyboard.press('Escape')

  expect(id).toBeTruthy()
})

test('the command palette collapses the board and the switcher agrees', async ({ page }) => {
  await openRoom(page)

  const board = page.locator('.pane--board')
  await expect(board).toBeVisible()

  await page.keyboard.press('Control+k')
  await expect(page.locator('.palette')).toBeVisible()

  await page.locator('.palette__input').fill('code only')
  await page.keyboard.press('Enter')

  await expect(page.locator('.palette')).toHaveCount(0)
  await expect(board).toBeHidden()

  // The header control reflects the same state the palette just changed.
  await expect(page.locator('.room__views [role="tab"][aria-selected="true"]')).toHaveText('Code')

  // And it is a workspace preference, so it is still collapsed after a reload.
  await page.reload()
  await expect(page.locator('.pane--board')).toBeHidden()

  await page.locator('.room__views [role="tab"]', { hasText: 'Split' }).click()
  await expect(page.locator('.pane--board')).toBeVisible()
})

test('editor display options toggle and persist', async ({ page }) => {
  await openRoom(page)

  const wrap = page.locator('.pane--editor button[aria-label="Word wrap"]')
  await expect(wrap).toHaveAttribute('aria-pressed', 'false')
  await wrap.click()
  await expect(wrap).toHaveAttribute('aria-pressed', 'true')

  const minimap = page.locator('.pane--editor button[aria-label="Minimap"]')
  await minimap.click()
  await expect(page.locator('.monaco-editor .minimap')).toBeVisible()

  await page.reload()
  await expect(page.locator('.pane--editor button[aria-label="Word wrap"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.locator('.monaco-editor .minimap')).toBeVisible()
})

test('the shortcuts panel opens with ? and not while typing', async ({ page }) => {
  await openRoom(page)

  await focusEditor(page)
  await page.keyboard.type('a ? b')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0)

  // Away from any text input, the same key opens the panel.
  await page.locator('.room__name').click()
  await page.keyboard.press('?')
  const panel = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Command palette')

  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

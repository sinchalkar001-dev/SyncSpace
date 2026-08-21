import { expect, test } from '@playwright/test'

/**
 * The room card's management menu opens BELOW the card. A clipping style on
 * the card once made it render but sit outside the clip, so it was invisible
 * and unclickable while every DOM assertion still passed.
 *
 * These tests click the items for real: Playwright hit-tests before clicking,
 * so a clipped or covered menu fails here the way it fails for a person.
 */
async function signUp(page) {
  const email = 'e2e' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Tester')
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill('a-good-passphrase')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
}

async function createRoom(page, name) {
  await page.getByLabel('New room name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL('**/room/**')
  await page.goto('/dashboard')
  await expect(page.locator('.roomcard').getByText(name)).toBeVisible()
}

test('the first card of several can still reach its own menu', async ({ page }) => {
  await signUp(page)

  // Several rooms on purpose. The first card's menu overlaps the cards listed
  // after it, and the card's own transform traps it in a stacking context - a
  // single-room dashboard never exposes that.
  for (const name of ['First room', 'Second room', 'Third room']) {
    await createRoom(page, name)
  }

  await page.locator('.roomcard__more').first().click()

  const menu = page.locator('.roomcard .popover--menu')
  await expect(menu).toBeVisible()

  for (const label of ['Rename', 'Make public', 'People', 'Delete room']) {
    await expect(menu.getByRole('menuitem', { name: label })).toBeVisible()
  }

  // The real check. A clipping ancestor leaves the menu in the DOM, sized and
  // "visible", but painted outside the clip box - so nothing reaches it.
  // Playwright's own .click() would NOT catch that: overflow:hidden is still
  // programmatically scrollable, so scrollIntoViewIfNeeded slides the menu
  // into view and clicks it, which a person with no scrollbar cannot do.
  const reachable = await page.evaluate(() => {
    const menu = document.querySelector('.roomcard .popover--menu')
    if (!menu) return { found: false }

    // Scroll the WINDOW only, never the card: a menu hanging below a short
    // viewport is not the bug, and scrolling the card itself would hide the
    // bug we are looking for.
    const first = menu.getBoundingClientRect()
    const below = first.bottom - window.innerHeight
    if (below > 0) window.scrollBy(0, below + 24)

    const box = menu.getBoundingClientRect()
    const at = (x, y) => menu.contains(document.elementFromPoint(Math.round(x), Math.round(y)))
    return {
      found: true,
      centre: at(box.left + box.width / 2, box.top + box.height / 2),
      firstItem: at(box.left + box.width / 2, box.top + 16),
    }
  })

  expect(reachable.found).toBe(true)
  expect(reachable.centre, 'menu centre must not be clipped away').toBe(true)
  expect(reachable.firstItem, 'first menu item must be reachable').toBe(true)

  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('renaming a room from the menu updates the card', async ({ page }) => {
  await signUp(page)
  await createRoom(page, 'Before rename')

  await page.locator('.roomcard__more').first().click()
  await page.locator('.roomcard .popover--menu').getByRole('menuitem', { name: 'Rename' }).click()

  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('Room name')
  await input.fill('After rename')
  await dialog.getByRole('button', { name: 'Save name' }).click()

  // Scope to the card: the success toast also carries the new name.
  await expect(page.locator('.roomcard').getByText('After rename')).toBeVisible()
  await expect(page.locator('.roomcard').getByText('Before rename')).toHaveCount(0)
})

test('deleting a room from the menu removes it', async ({ page }) => {
  await signUp(page)
  await createRoom(page, 'Doomed room')

  await page.locator('.roomcard__more').first().click()
  await page
    .locator('.roomcard .popover--menu')
    .getByRole('menuitem', { name: 'Delete room' })
    .click()

  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete room' }).click()

  await expect(page.locator('.roomcard').getByText('Doomed room')).toHaveCount(0)
})

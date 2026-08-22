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
  //
  // Nothing is scrolled here on purpose. The menu is absolutely positioned, so
  // it adds nothing to the page's scroll height: if it hangs past the bottom
  // edge there is no scrolling anyone could do to reach it, and the card is
  // expected to have flipped it upward instead.
  const reachable = await page.evaluate(() => {
    const menu = document.querySelector('.roomcard .popover--menu')
    if (!menu) return { found: false }

    const box = menu.getBoundingClientRect()

    // Naming what got in the way turns a bare false into a diagnosis: a
    // clipping ancestor reports the card, an overlay reports itself, and a
    // menu hanging off the screen reports that instead of a null.
    const at = (x, y) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 'offscreen'
      const el = document.elementFromPoint(Math.round(x), Math.round(y))
      if (menu.contains(el)) return 'menu'
      if (!el) return 'nothing'
      const classes = typeof el.className === 'string' ? el.className.trim() : ''
      return el.tagName.toLowerCase() + (classes ? '.' + classes.split(/\s+/).join('.') : '')
    }

    return {
      found: true,
      firstItem: at(box.left + box.width / 2, box.top + 16),
      centre: at(box.left + box.width / 2, box.top + box.height / 2),
      lastItem: at(box.left + box.width / 2, box.bottom - 16),
    }
  })

  expect(reachable.found).toBe(true)
  expect(reachable.firstItem, 'first menu item is covered, clipped or off screen').toBe('menu')
  expect(reachable.centre, 'menu centre is covered, clipped or off screen').toBe('menu')
  expect(reachable.lastItem, 'last menu item is covered, clipped or off screen').toBe('menu')

  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('a menu with no room below it flips up rather than off the screen', async ({ page }) => {
  await signUp(page)
  await createRoom(page, 'Only room')

  // Short enough that the last card sits hard against the bottom edge.
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

  const trigger = page.locator('.roomcard__more').last()
  await trigger.click()

  const menu = page.locator('.roomcard .popover--menu')
  await expect(menu).toBeVisible()

  const placement = await page.evaluate(() => {
    const menu = document.querySelector('.roomcard .popover--menu')
    const trigger = document.querySelector('.roomcard--open .roomcard__more')
    const box = menu.getBoundingClientRect()
    return {
      above: box.bottom <= trigger.getBoundingClientRect().top,
      withinViewport: box.top >= 0 && box.bottom <= window.innerHeight,
    }
  })

  expect(placement.above, 'menu should open upward here').toBe(true)
  expect(placement.withinViewport, 'menu should be fully on screen').toBe(true)

  // And it still works: a flipped menu that cannot be clicked is no better.
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

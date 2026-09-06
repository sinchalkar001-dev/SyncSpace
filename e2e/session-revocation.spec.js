import { expect, test } from '@playwright/test'

/**
 * Signing out a device you no longer have.
 *
 * The server suite proves the token stops being accepted. What a browser adds
 * is the part a person actually experiences: that the tab which made the
 * change stays signed in, and that the other one does not — through the real
 * UI, the real storage, and two genuinely separate browser contexts.
 *
 * The second context is given the first one's token directly rather than
 * signing in again, because that is precisely the situation being tested: one
 * account, two devices, one of them holding a session it should lose.
 */

const TOKEN_KEY = 'syncspace:token'

const unique = () => 'e2e' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'

const PASSWORD = 'a-good-passphrase'
const NEXT_PASSWORD = 'an-entirely-new-passphrase'

async function signUp(page, email) {
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Tester')
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
}

/** Opens a second device already holding this session's token. */
async function adoptSessionIn(context, baseURL, token) {
  const page = await context.newPage()
  // The origin has to exist before localStorage can be written to it.
  await page.goto(baseURL + '/login')
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [TOKEN_KEY, token]
  )
  return page
}

const openMenu = (page) => page.locator('.usermenu__trigger, .usermenu button').first().click()

async function changePassword(page) {
  await openMenu(page)
  await page.getByRole('menuitem', { name: 'Change password' }).click()

  // Exact, or "New password" also matches "Confirm new password".
  await page.getByLabel('Current password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('New password', { exact: true }).fill(NEXT_PASSWORD)
  await page.getByLabel('Confirm new password', { exact: true }).fill(NEXT_PASSWORD)
  await page.getByRole('button', { name: 'Update password' }).click()
}

test('changing the password signs out the other device but not this one', async ({
  page,
  browser,
  baseURL,
}) => {
  const email = unique()
  await signUp(page, email)

  const token = await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY)
  expect(token).toBeTruthy()

  // A second device holding the same session.
  const other = await browser.newContext()
  try {
    const otherPage = await adoptSessionIn(other, baseURL, token)
    await otherPage.goto('/dashboard')
    await expect(otherPage).toHaveURL(/\/dashboard/)

    await changePassword(page)

    // This tab adopted the replacement session, so it is still signed in and
    // still on the dashboard rather than back at the sign-in page.
    await expect(page.getByText(/other devices signed out/i)).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard/)
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)

    // The other device is holding a token that no longer names a live session.
    await otherPage.goto('/dashboard')
    await expect(otherPage).toHaveURL(/\/login/)
  } finally {
    await other.close()
  }
})

test('the device list shows both devices and can sign one of them out', async ({
  page,
  browser,
  baseURL,
}) => {
  const email = unique()
  await signUp(page, email)

  const token = await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY)

  const other = await browser.newContext()
  try {
    const otherPage = await adoptSessionIn(other, baseURL, token)
    await otherPage.goto('/dashboard')
    await expect(otherPage).toHaveURL(/\/dashboard/)

    await openMenu(page)
    await page.getByRole('menuitem', { name: 'Signed-in devices' }).click()

    // Both contexts hold the same session, so signing in again is what makes
    // a second row: the sign-up made one, and this is the other device.
    const rows = page.locator('.people__list li')
    await expect(rows).toHaveCount(1)
    await expect(page.getByText('This device')).toBeVisible()
    await expect(page.getByText(/only device signed in/i)).toBeVisible()

    // A genuinely separate sign-in, which is a second row.
    const third = await browser.newContext()
    const thirdPage = await third.newPage()
    await thirdPage.goto(baseURL + '/login')
    await thirdPage.getByLabel('Email').fill(email)
    await thirdPage.locator('input[type="password"]').first().fill(PASSWORD)
    await thirdPage.getByRole('button', { name: 'Sign in' }).click()
    await thirdPage.waitForURL('**/dashboard')

    await page.getByRole('button', { name: 'Close' }).click()
    await openMenu(page)
    await page.getByRole('menuitem', { name: 'Signed-in devices' }).click()
    await expect(rows).toHaveCount(2)

    // Sign the other one out from here.
    await rows.filter({ hasNot: page.getByText('This device') }).getByRole('button', { name: 'Sign out' }).click()
    await expect(rows).toHaveCount(1)

    // And it is genuinely out, not merely missing from a list.
    await thirdPage.goto('/dashboard')
    await expect(thirdPage).toHaveURL(/\/login/)

    await third.close()
  } finally {
    await other.close()
  }
})

test('the new password is the one that works afterwards', async ({ page }) => {
  const email = unique()
  await signUp(page, email)

  await changePassword(page)
  await expect(page.getByText(/other devices signed out/i)).toBeVisible()

  // Sign out and back in with each, so the change is proved from the outside.
  await openMenu(page)
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL(/\/(login)?$/)

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)

  // The input, not the reveal toggle beside it — both answer to "password".
  const password = page.locator('input[type="password"]').first()

  await password.fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText(/incorrect email or password/i)

  await password.fill(NEXT_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
})

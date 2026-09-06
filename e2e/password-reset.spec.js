import { expect, test } from '@playwright/test'

/**
 * Password recovery, as far as a browser can follow it.
 *
 * The half that needs an inbox is covered by the server suite, which reads the
 * emailed token out of the log the way a mailer would. What is left is exactly
 * what a browser can see, and it is the half that used to be missing entirely:
 * that the flow is reachable from the screen someone gets stuck on, that a
 * dead link leads somewhere useful, and — through the real API, not a mock —
 * that asking about a stranger's address looks identical to asking about your
 * own.
 */

const unique = () => 'e2e' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'

async function signUp(page, email) {
  await page.goto('/register')
  await page.getByLabel('Display name').fill('Tester')
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill('a-good-passphrase')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
}

test('a locked-out person can find the way out from the sign-in page', async ({ page }) => {
  await page.goto('/login')

  await page.getByRole('link', { name: 'Reset it' }).click()

  await page.waitForURL('**/forgot-password')
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible()
})

test('asking for a link confirms without promising one', async ({ page }) => {
  const email = unique()
  await signUp(page, email)

  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  // Hedged on purpose: the server refuses to say whether the account exists,
  // so the page cannot claim an email is definitely on its way.
  await expect(page.getByText(/if that address has an account/i)).toBeVisible()
})

/**
 * The security property, checked against the real server rather than a stub.
 *
 * If these two ever diverge — different text, a different heading, an error
 * banner on one of them — the endpoint has become a way for anyone to test
 * which addresses have accounts here.
 */
test('a registered and an unregistered address are answered identically', async ({ page }) => {
  const registered = unique()
  await signUp(page, registered)

  const screenFor = async (email) => {
    await page.goto('/forgot-password')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Email me a reset link' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    const text = await page.locator('.auth__card').innerText()
    return text.replace(email, '<address>')
  }

  const known = await screenFor(registered)
  const unknown = await screenFor('nobody-' + unique())

  expect(unknown).toBe(known)
})

test('a link with no token says so instead of failing silently', async ({ page }) => {
  await page.goto('/reset-password')

  await expect(page.getByRole('heading', { name: 'Nothing to reset' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Send a new link' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save and sign in' })).toHaveCount(0)
})

/**
 * A dead token is the ordinary way to land here badly — the links last an
 * hour and are single-use — so the refusal has to come from the server and
 * has to lead somewhere. A well-formed token that was never issued exercises
 * the same path an expired one takes.
 */
test('a dead reset link is refused by the server and offers a new one', async ({ page }) => {
  await page.goto('/reset-password?token=' + 'a'.repeat(64))

  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()

  const boxes = page.locator('input[type="password"]')
  await boxes.nth(0).fill('an-entirely-new-passphrase')
  await boxes.nth(1).fill('an-entirely-new-passphrase')
  await page.getByRole('button', { name: 'Save and sign in' }).click()

  await expect(page.getByRole('alert')).toContainText(/invalid or has expired/i)
  await expect(page.getByRole('link', { name: 'Ask for a new one' })).toBeVisible()
  // Refused, so nothing was signed in.
  await expect(page).toHaveURL(/\/reset-password/)
})

test('the two password boxes have to agree before anything is sent', async ({ page }) => {
  await page.goto('/reset-password?token=' + 'b'.repeat(64))

  const boxes = page.locator('input[type="password"]')
  await boxes.nth(0).fill('an-entirely-new-passphrase')
  await boxes.nth(1).fill('a-different-passphrase')
  await page.getByRole('button', { name: 'Save and sign in' }).click()

  await expect(page.getByText('These do not match.')).toBeVisible()
  // The mismatch is caught here, so the single-use link is not spent on a typo.
  await expect(page.getByRole('alert')).toHaveCount(0)
})

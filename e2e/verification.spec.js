import { expect, test } from '@playwright/test'

/**
 * Proving an address, through the browser.
 *
 * The server suite proves the rules — that a code expires, that attempts are
 * bounded, that a burned code stays burned. What a browser adds is the part a
 * person meets: that signing up lands them somewhere that tells them what to
 * do, that a wrong code says how many tries are left rather than just "no",
 * and that Resend counts down instead of silently refusing.
 *
 * The real code never appears here. It exists in an email this suite cannot
 * read, which is the point of the feature — so these tests cover the states
 * around it rather than pretending to hold the secret.
 */

const PASSWORD = 'a-good-passphrase'

const unique = (who) =>
  'e2e-' + who + '-' + Date.now() + Math.floor(Math.random() * 1000) + '@syncspace.test'

/**
 * Generous, because the first test in a cold run also pays for Vite building
 * the client bundle. It timed out at sixty seconds once and passed in three
 * the moment the stack was warm.
 */
test.describe.configure({ timeout: 120000 })

async function signUp(page, email, name = 'Tester') {
  await page.goto('/register')
  await page.getByLabel('Display name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL('**/dashboard')
}

test('the check-your-email screen shows a masked address and the code entry', async ({ page }) => {
  const email = unique('verify')
  await signUp(page, email)

  await page.goto('/check-email')

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByLabel('Verification code')).toBeVisible()

  /**
   * Masked, not printed. This screen is the one most likely to be open on a
   * shared or projected display, and the full address is not needed to
   * recognise which mailbox to go and look in.
   */
  const masked = email[0] + '***@' + email.split('@')[1]
  await expect(page.getByText(masked)).toBeVisible()
  await expect(page.getByText(email, { exact: true })).toHaveCount(0)
})

test('a wrong code says how many attempts are left', async ({ page }) => {
  await signUp(page, unique('wrong'))
  await page.goto('/check-email')

  const field = page.getByLabel('Verification code')
  const submit = page.getByRole('button', { name: 'Verify email' })

  // Nothing to submit until it is the right length — the server would only
  // refuse it, and spending an attempt on a typo would be unkind.
  await field.fill('123')
  await expect(submit).toBeDisabled()

  await field.fill('000000')
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByRole('alert')).toContainText(/attempts left/)
  // Cleared, so the next attempt starts from an empty field rather than a
  // wrong one somebody has to select and delete.
  await expect(field).toHaveValue('')
})

/**
 * The cooldown is already running when this screen first appears, because
 * signing up has just sent the email — which is the whole reason the button
 * has to show the wait rather than simply refusing when pressed.
 */
test('resend shows the wait rather than silently refusing', async ({ page }) => {
  await signUp(page, unique('resend'))
  await page.goto('/check-email')

  const waiting = page.getByRole('button', { name: /Resend in \d+s/ })

  await expect(waiting).toBeVisible()
  await expect(waiting).toBeDisabled()

  // And it is a countdown, not a frozen label: the number goes down.
  const first = Number((await waiting.textContent()).match(/(\d+)s/)[1])
  await page.waitForTimeout(2200)
  const later = Number((await waiting.textContent()).match(/(\d+)s/)[1])

  expect(later).toBeLessThan(first)
})

test('a dead verification link explains itself and offers a way forward', async ({ page }) => {
  await signUp(page, unique('deadlink'))

  await page.goto('/verify-email?token=' + 'a'.repeat(64))

  await expect(page.getByRole('heading', { name: 'That link did not work' })).toBeVisible()
  await expect(page.getByText(/can only be used once/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Send a new email|Resend in/ })).toBeVisible()
})

test('the server redirects a spent link to a page that says so', async ({ page }) => {
  // The GET the email's button points at. Whatever went wrong, it lands on the
  // client with the outcome in the query string and the token left behind.
  const res = await page.request.get('/api/v1/auth/verify-email?token=' + 'b'.repeat(64), {
    maxRedirects: 0,
  })

  expect(res.status()).toBe(302)
  const location = res.headers().location
  expect(location).toContain('status=invalid')
  expect(location).not.toContain('b'.repeat(64))
})

test('an invitation link says what it is for before asking anything', async ({ page }) => {
  await signUp(page, unique('inviter'), 'Priya')

  // Create a room and invite an address with no account, which is the case
  // that produces a token.
  const token = await page.evaluate(() => window.localStorage.getItem('syncspace:token'))
  const room = await page.request
    .post('/api/v1/rooms', {
      headers: { Authorization: 'Bearer ' + token },
      data: { name: 'Design review', isPublic: false },
    })
    .then((r) => r.json())

  await page.request.post('/api/v1/rooms/' + room.room.roomId + '/invite', {
    headers: { Authorization: 'Bearer ' + token },
    data: { email: unique('guest') },
  })

  // A link that was never issued reads the same as one that expired or was
  // spent — the server does not distinguish them, and neither does the page.
  await page.goto('/accept-invitation?token=' + 'c'.repeat(43))

  await expect(page.getByRole('heading', { name: 'That invitation did not work' })).toBeVisible()
  await expect(page.getByText(/only work for the address they were sent to/)).toBeVisible()
})

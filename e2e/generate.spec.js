import { expect, test } from '@playwright/test'

/**
 * Whiteboard to code, drawn and driven in a real browser.
 *
 * The diagram is drawn the way a person draws one — boxes dragged out with the
 * rectangle tool, labels typed into them, arrows between them — and everything
 * after that is the real thing: the real Yjs document, the real server reading
 * it, the real request, the real review screen, the real files.
 *
 * The only stand-in is the model itself (e2e/fixtures/model-stub.js), and it
 * answers from the prompt it was sent, so a file named after a box on the
 * board is proof the graph travelled the whole way.
 */

const newRoom = () => 'gen-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

const PASSWORD = 'a-good-passphrase'

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

/** Drags a rectangle out on the board and types a label inside it. */
async function drawLabelledBox(page, board, { x, y, width = 200, height = 90, label }) {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await page.mouse.move(board.x + x, board.y + y)
  await page.mouse.down()
  await page.mouse.move(board.x + x + width, board.y + y + height, { steps: 8 })
  await page.mouse.up()

  // The label is a separate text shape; only its position ties it to the box.
  await page.getByRole('button', { name: 'Text' }).click()
  await page.mouse.click(board.x + x + 20, board.y + y + height / 2 - 8)
  const composer = page.getByLabel('Text to place on the board')
  await composer.fill(label)
  await composer.press('Enter')
}

/** Draws an arrow between two vertical positions in the same column. */
async function drawArrow(page, board, { x, fromY, toY }) {
  await page.getByRole('button', { name: 'Arrow' }).click()
  await page.mouse.move(board.x + x, board.y + fromY)
  await page.mouse.down()
  await page.mouse.move(board.x + x, board.y + toY, { steps: 8 })
  await page.mouse.up()
}

/**
 * The diagram from the brief: Client -> API -> Database, stacked.
 *
 * Kept to three boxes rather than four so the whole thing fits the board at
 * the default viewport without panning — a test that has to scroll the canvas
 * is testing the canvas, not this.
 */
async function drawTheSystem(page) {
  const board = await page.locator('.board').boundingBox()

  await drawLabelledBox(page, board, { x: 220, y: 40, label: 'Client' })
  await drawLabelledBox(page, board, { x: 220, y: 200, label: 'API' })
  await drawLabelledBox(page, board, { x: 220, y: 360, label: 'Database' })

  await drawArrow(page, board, { x: 320, fromY: 130, toY: 200 })
  await drawArrow(page, board, { x: 320, fromY: 290, toY: 360 })

  // Back to select, so a stray click cannot draw a fourth thing.
  await page.getByRole('button', { name: 'Select' }).click()
}

const openGenerate = async (page) => {
  await page.getByRole('button', { name: 'Generate from whiteboard' }).click()
  await expect(page.getByRole('heading', { name: 'Generate from whiteboard' })).toBeVisible()
}

test('reads the drawn diagram, generates a change set, and applies part of it', async ({ page }) => {
  await signUp(page)
  const room = newRoom()

  await page.goto('/room/' + room)
  await expect(page.getByText('Connected')).toBeVisible()

  await drawTheSystem(page)
  await openGenerate(page)

  /* What the server read off the board -------------------------------------- */

  await expect(page.getByText('What the board says')).toBeVisible()
  await expect(page.locator('.arch__label')).toHaveText(['Client', 'API', 'Database'])
  await expect(page.getByText(/3 components · 2 connections/)).toBeVisible()

  // The arrows were resolved to the boxes they visually join. Nothing in the
  // document says so; it is recovered from the geometry.
  await expect(page.locator('.arch__edge')).toHaveCount(2)
  await expect(page.locator('.arch__edge').first()).toContainText('client')
  await expect(page.locator('.arch__edge').first()).toContainText('api')

  // A diagram this tidy should raise nothing.
  await expect(page.locator('.arch__warnings')).toHaveCount(0)

  /* Generating --------------------------------------------------------------- */

  await page.getByRole('button', { name: 'Generate', exact: true }).click()

  await expect(page.getByRole('heading', { name: /3-component system/ })).toBeVisible({
    timeout: 30000,
  })

  // Named after the boxes, which only the prompt could have carried.
  const paths = page.locator('.changeset__path')
  await expect(paths).toHaveText([
    'src/client.js',
    'src/api.js',
    'src/database.js',
  ])

  /*
   * The stub also proposed "../escaped.js". It must not be offered as a file —
   * the exact list above already says so — and the refusal must be visible
   * rather than silent, because a path that tried to climb out of the project
   * is worth seeing. The name appears on screen for exactly that reason, so
   * the check is scoped to the file list rather than to the whole dialog.
   */
  await expect(page.locator('.changeset__path', { hasText: 'escaped' })).toHaveCount(0)
  await expect(page.getByText(/unusable path/i)).toBeVisible()
  await expect(page.getByText(/escaped\.js/)).toBeVisible()

  // The parts that are not code get the same weight as the code.
  await expect(page.getByText(/because the diagram does not say otherwise/i)).toBeVisible()
  await expect(page.getByText(/which database should the store use/i)).toBeVisible()

  /* Reviewing ---------------------------------------------------------------- */

  const apiFile = page.locator('.changeset__file', { hasText: 'src/api.js' })
  await apiFile.getByRole('button', { name: 'View' }).click()
  await expect(apiFile.locator('.changeset__code')).toContainText('not implemented')

  // Take two of the three.
  await page.getByLabel('Accept src/database.js').uncheck()
  await expect(page.getByRole('button', { name: 'Apply 2' })).toBeVisible()

  await page.getByRole('button', { name: 'Apply 2' }).click()

  await expect(page.getByText('Reviewed')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.changeset__status.is-applied')).toHaveCount(2)

  /* The files really landed in the room -------------------------------------- */

  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /files/i }).first().click()

  await expect(page.getByText('src_client.js')).toBeVisible()
  await expect(page.getByText('src_api.js')).toBeVisible()
  // The one that was turned down was not written.
  await expect(page.getByText('src_database.js')).toHaveCount(0)
})

test('an empty board is explained rather than generated from', async ({ page }) => {
  await signUp(page)

  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()

  await openGenerate(page)

  await expect(page.getByText(/nothing to read yet/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled()
})

/**
 * The reading is geometric, so it is sometimes wrong — and the answer to that
 * is the person fixing the diagram, not the model guessing around it. What the
 * board could not say has to be visible before anything is generated.
 */
test('says what it could not read off the board', async ({ page }) => {
  await signUp(page)

  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()

  const board = await page.locator('.board').boundingBox()
  await drawLabelledBox(page, board, { x: 220, y: 40, label: 'Client' })
  // An arrow into empty space: it reaches nothing at its head.
  await drawArrow(page, board, { x: 320, fromY: 130, toY: 460 })
  await page.getByRole('button', { name: 'Select' }).click()

  await openGenerate(page)

  await expect(page.getByText(/what could not be read/i)).toBeVisible()
  await expect(page.getByText(/does not reach a box/i)).toBeVisible()
})

test('a guest is told to sign in rather than shown a button that fails', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()

  const button = page.getByRole('button', { name: 'Generate from whiteboard' })
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', /sign in/i)
})

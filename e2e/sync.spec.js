import { expect, test } from '@playwright/test'

/** A fresh room per test so state never leaks between runs. */
const newRoom = () => 'e2e-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

async function openRoom(context, room) {
  const page = await context.newPage()
  await page.goto('/room/' + room)
  await expect(page.getByText('Connected')).toBeVisible()
  return page
}

test('two tabs in one room see each other and each other edits', async ({ browser }) => {
  const room = newRoom()

  // Separate contexts so the two tabs are genuinely separate clients.
  const alice = await browser.newContext()
  const bob = await browser.newContext()

  try {
    const alicePage = await openRoom(alice, room)
    const bobPage = await openRoom(bob, room)

    // Awareness: both tabs must count two people.
    await expect(alicePage.getByText('2 people')).toBeVisible()
    await expect(bobPage.getByText('2 people')).toBeVisible()

    // Code typed in one tab must appear in the other.
    await alicePage.locator('.editor-host').click()
    await alicePage.keyboard.type('const shared = true')

    await expect(bobPage.locator('.view-lines')).toContainText('const shared = true')

    // ...and the reverse direction.
    await bobPage.locator('.editor-host').click()
    await bobPage.keyboard.press('End')
    await bobPage.keyboard.type(' // seen by bob')

    await expect(alicePage.locator('.view-lines')).toContainText('// seen by bob')
  } finally {
    await alice.close()
    await bob.close()
  }
})

test('a drawing made in one tab reaches the other', async ({ browser }) => {
  const room = newRoom()

  const alice = await browser.newContext()
  const bob = await browser.newContext()

  try {
    const alicePage = await openRoom(alice, room)
    const bobPage = await openRoom(bob, room)

    // Konva renders to canvas, so compare the rendered pixels rather than DOM.
    const bobCanvas = bobPage.locator('.board canvas').first()
    const before = await bobCanvas.screenshot()

    await alicePage.getByRole('button', { name: 'Rectangle' }).click()
    const box = await alicePage.locator('.board').boundingBox()
    await alicePage.mouse.move(box.x + 260, box.y + 220)
    await alicePage.mouse.down()
    await alicePage.mouse.move(box.x + 520, box.y + 400, { steps: 8 })
    await alicePage.mouse.up()

    await expect(async () => {
      const after = await bobCanvas.screenshot()
      expect(Buffer.compare(before, after)).not.toBe(0)
    }).toPass({ timeout: 15000 })
  } finally {
    await alice.close()
    await bob.close()
  }
})

test('the tool rail never overflows its pane', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible()

  for (const width of [1440, 1100, 900]) {
    await page.setViewportSize({ width, height: 800 })

    // Monaco relays out on a polling timer, so the frame right after a resize
    // can briefly report stale geometry. Poll until it settles rather than
    // measuring mid-reflow.
    await expect
      .poll(
        async () =>
          page.evaluate(() => document.body.scrollWidth - document.body.clientWidth),
        { message: 'horizontal overflow at ' + width + 'px', timeout: 10000 }
      )
      .toBe(0)
  }
})

test('the eraser removes every shape a drag passes over', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)

  const board = page.locator('.board')
  const box = await board.boundingBox()
  // Clip past the rail and the zoom pill: both live inside .board, and their
  // active-tool highlight changes between shots.
  const clip = {
    x: box.x + 140,
    y: box.y + 20,
    width: box.width - 180,
    height: box.height - 130,
  }
  const tool = (label) => page.locator('.rail button[aria-label="' + label + '"]')

  const empty = await page.screenshot({ clip })

  // Three rectangles in a row.
  await tool('Rectangle').click()
  for (const [x1, y1, x2, y2] of [
    [180, 170, 380, 330],
    [430, 170, 630, 330],
    [680, 170, 880, 330],
  ]) {
    await page.mouse.move(box.x + x1, box.y + y1)
    await page.mouse.down()
    await page.mouse.move(box.x + x2, box.y + y2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
  }

  const drawn = await page.screenshot({ clip })
  expect(Buffer.compare(empty, drawn), 'rectangles were drawn').not.toBe(0)

  // One eraser stroke straight through all three - not three separate clicks.
  await tool('Eraser').click()
  await page.mouse.move(box.x + 140, box.y + 250)
  await page.mouse.down()
  await page.mouse.move(box.x + 940, box.y + 250, { steps: 45 })
  await page.mouse.up()

  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(empty, after), 'board is clear again').toBe(0)
  }).toPass({ timeout: 12000 })
})

test('the eraser reaches a thin stroke without pixel-perfect aim', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)

  const box = await page.locator('.board').boundingBox()
  const clip = {
    x: box.x + 140,
    y: box.y + 20,
    width: box.width - 180,
    height: box.height - 130,
  }
  const tool = (label) => page.locator('.rail button[aria-label="' + label + '"]')

  const empty = await page.screenshot({ clip })

  // A thin horizontal freehand stroke.
  await tool('Freehand').click()
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  for (let i = 0; i <= 40; i += 1) await page.mouse.move(box.x + 300 + i * 10, box.y + 300)
  await page.mouse.up()
  await page.waitForTimeout(400)

  const drawn = await page.screenshot({ clip })
  expect(Buffer.compare(empty, drawn), 'stroke was drawn').not.toBe(0)

  // Drag deliberately BESIDE the stroke, not along it - nobody traces a 3px
  // line to the pixel.
  await tool('Eraser').click()
  await page.mouse.move(box.x + 340, box.y + 308)
  await page.mouse.down()
  await page.mouse.move(box.x + 660, box.y + 308, { steps: 30 })
  await page.mouse.up()

  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(empty, after), 'stroke was erased').toBe(0)
  }).toPass({ timeout: 12000 })
})

test('one stroke is one shape, so a single erase clears it', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)

  const box = await page.locator('.board').boundingBox()
  const clip = {
    x: box.x + 140,
    y: box.y + 20,
    width: box.width - 180,
    height: box.height - 130,
  }
  const tool = (label) => page.locator('.rail button[aria-label="' + label + '"]')

  const empty = await page.screenshot({ clip })

  await tool('Freehand').click()
  await page.mouse.move(box.x + 320, box.y + 300)
  await page.mouse.down()
  for (let i = 0; i <= 30; i += 1) await page.mouse.move(box.x + 320 + i * 12, box.y + 300)
  await page.mouse.up()
  await page.waitForTimeout(500)

  expect(Buffer.compare(empty, await page.screenshot({ clip })), 'stroke drawn').not.toBe(0)

  // A single click erases a single shape. If the stroke were committed twice
  // - two identical shapes stacked - the twin would survive this click.
  await tool('Eraser').click()
  await page.mouse.click(box.x + 500, box.y + 300)

  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(empty, after), 'no duplicate stroke left behind').toBe(0)
  }).toPass({ timeout: 12000 })
})

test('straight line, arrow and diamond each draw one shape', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)

  const box = await page.locator('.board').boundingBox()
  const clip = {
    x: box.x + 140,
    y: box.y + 20,
    width: box.width - 180,
    height: box.height - 130,
  }
  const tool = (label) => page.locator('.rail button[aria-label="' + label + '"]')

  for (const [label, from, to] of [
    ['Straight line', [220, 140], [460, 230]],
    ['Arrow', [220, 300], [460, 300]],
    ['Diamond', [540, 130], [680, 250]],
  ]) {
    const before = await page.screenshot({ clip })

    await tool(label).click()
    await page.mouse.move(box.x + from[0], box.y + from[1])
    await page.mouse.down()
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 10 })
    await page.mouse.up()

    await expect(async () => {
      const after = await page.screenshot({ clip })
      expect(Buffer.compare(before, after), label + ' drew something').not.toBe(0)
    }).toPass({ timeout: 10000 })
  }
})

test('hovering a shape names who drew it', async ({ page }) => {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)

  const box = await page.locator('.board').boundingBox()
  const tool = (label) => page.locator('.rail button[aria-label="' + label + '"]')

  await tool('Arrow').click()
  await page.mouse.move(box.x + 260, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 520, box.y + 300, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(500)

  // Nothing is attributed until the pointer is actually over a shape.
  await expect(page.locator('.authortip')).toHaveCount(0)

  await tool('Select and pan').click()
  await page.mouse.move(box.x + 390, box.y + 300)

  const tip = page.locator('.authortip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText(/Guest-/)

  // ...and it goes away again when the pointer leaves.
  await page.mouse.move(box.x + 390, box.y + 620)
  await expect(tip).toHaveCount(0)
})

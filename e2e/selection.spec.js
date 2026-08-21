import { expect, test } from '@playwright/test'

const newRoom = () => 'sel-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

async function openBoard(page) {
  await page.goto('/room/' + newRoom())
  await expect(page.getByText('Connected')).toBeVisible()
  await page.waitForTimeout(1200)
  return page.locator('.board').boundingBox()
}

const tool = (page, label) => page.locator('.rail button[aria-label="' + label + '"]')

async function drag(page, box, from, to, steps = 10) {
  await page.mouse.move(box.x + from[0], box.y + from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps })
  await page.mouse.up()
  await page.waitForTimeout(250)
}

/** Three rectangles, well inside the board so drags never leave the canvas. */
async function drawThree(page, box) {
  await tool(page, 'Rectangle').click()
  await drag(page, box, [200, 150], [300, 230])
  await drag(page, box, [330, 150], [430, 230])
  await drag(page, box, [460, 150], [560, 230])
  await page.waitForTimeout(500)
}

test('a marquee selects several shapes and offers actions on them', async ({ page }) => {
  const box = await openBoard(page)
  await drawThree(page, box)

  await tool(page, 'Select').click()
  await drag(page, box, [170, 110], [600, 270], 20)

  const bar = page.locator('.selbar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.selbar__count')).toHaveText('3')

  // The bar must sit inside the board, not off its edge.
  const barBox = await bar.boundingBox()
  expect(barBox.x).toBeGreaterThanOrEqual(box.x)
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(box.x + box.width + 1)
})

test('shift-click adds to the selection and Escape clears it', async ({ page }) => {
  const box = await openBoard(page)
  await drawThree(page, box)
  await tool(page, 'Select').click()

  await page.mouse.click(box.x + 250, box.y + 190)
  await expect(page.locator('.selbar__count')).toHaveText('1')

  await page.keyboard.down('Shift')
  await page.mouse.click(box.x + 380, box.y + 190)
  await page.keyboard.up('Shift')
  await expect(page.locator('.selbar__count')).toHaveText('2')

  await page.locator('.board').press('Escape')
  await expect(page.locator('.selbar')).toHaveCount(0)
})

test('duplicate and delete act on the whole selection', async ({ page }) => {
  const box = await openBoard(page)
  await drawThree(page, box)

  // Baseline BEFORE selecting: a selection draws a highlight, so a shot taken
  // while the three are selected could never match the cleared state later.
  const clip = { x: box.x + 140, y: box.y + 20, width: box.width - 180, height: box.height - 130 }
  const withThree = await page.screenshot({ clip })

  await tool(page, 'Select').click()
  await drag(page, box, [170, 110], [600, 270], 20)

  await page.locator('.selbar button[aria-label="Duplicate"]').click()
  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(withThree, after), 'copies appeared').not.toBe(0)
  }).toPass({ timeout: 10000 })

  // The copies stay selected, so deleting removes exactly them.
  await expect(page.locator('.selbar__count')).toHaveText('3')
  await page.locator('.selbar button[aria-label="Delete"]').click()

  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(withThree, after), 'back to the original three').toBe(0)
  }).toPass({ timeout: 10000 })
})

test('locking hides the destructive actions until it is unlocked', async ({ page }) => {
  const box = await openBoard(page)
  await drawThree(page, box)
  await tool(page, 'Select').click()
  await page.mouse.click(box.x + 250, box.y + 190)

  await page.locator('.selbar button[aria-label="Lock"]').click()

  await expect(page.locator('.selbar button[aria-label="Delete"]')).toHaveCount(0)
  await expect(page.locator('.selbar button[aria-label="Duplicate"]')).toHaveCount(0)
  await expect(page.locator('.selbar button[aria-label="Unlock"]')).toBeVisible()

  await page.locator('.selbar button[aria-label="Unlock"]').click()
  await expect(page.locator('.selbar button[aria-label="Delete"]')).toBeVisible()
})

test('the hand tool pans and leaves the shapes where they are', async ({ page }) => {
  const box = await openBoard(page)
  await drawThree(page, box)

  const zoomLabel = page.locator('.zoombar__value')
  await expect(zoomLabel).toHaveText('100%')

  await tool(page, 'Hand (pan)').click()
  const clip = { x: box.x + 140, y: box.y + 20, width: box.width - 180, height: box.height - 130 }
  const before = await page.screenshot({ clip })

  await drag(page, box, [400, 400], [520, 470], 15)

  // Panning moves the view, so the pixels change...
  await expect(async () => {
    const after = await page.screenshot({ clip })
    expect(Buffer.compare(before, after), 'view moved').not.toBe(0)
  }).toPass({ timeout: 8000 })

  // ...but it is a view change, not an edit: zoom is untouched and no
  // selection was made.
  await expect(zoomLabel).toHaveText('100%')
  await expect(page.locator('.selbar')).toHaveCount(0)
})

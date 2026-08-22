import { expect, test } from '@playwright/test'

const newRoom = () => 'run-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

async function openRoom(page, room = newRoom()) {
  await page.goto('/room/' + room)
  await expect(page.getByText('Connected')).toBeVisible()
  return room
}

/** Monaco's textarea sits under the rendered lines; click those instead. */
async function type(page, code) {
  await page.locator('.monaco-editor .view-lines').click()
  await expect(page.locator('.monaco-editor textarea')).toBeFocused()
  // Autoclosing brackets would double every one that is typed.
  await page.evaluate(() => window.monaco?.editor?.getEditors?.()[0]?.updateOptions({ autoClosingBrackets: 'never' }))
  await page.keyboard.type(code)
}

const runButton = (page) => page.getByRole('button', { name: /^Run/ })

test('runs a program and shows what it printed', async ({ page }) => {
  await openRoom(page)
  await type(page, 'console.log("hello from javascript")')

  await runButton(page).click()

  const output = page.locator('.runpanel')
  await expect(output).toBeVisible()
  await expect(output.locator('.runpanel__out')).toHaveText('hello from javascript\n')
  await expect(output.locator('.runpanel__state')).toContainText('Finished in')
})

test('shows the error when a program fails, with the exit code', async ({ page }) => {
  await openRoom(page)
  await type(page, 'throw new Error("it broke")')

  await runButton(page).click()

  const output = page.locator('.runpanel')
  await expect(output.locator('.runpanel__out--err')).toContainText('it broke')
  await expect(output.locator('.runpanel__state')).toContainText('Exited with 1')
})

test('feeds the input box to the program', async ({ page }) => {
  await openRoom(page)
  await type(
    page,
    [
      'let input = ""',
      'process.stdin.on("data", (c) => { input += c })',
      'process.stdin.on("end", () => console.log("you said: " + input.trim()))',
    ].join('\n')
  )

  await page.getByRole('button', { name: 'Program input' }).click()
  await page.locator('.stdin__field').fill('good morning')

  await runButton(page).click()

  await expect(page.locator('.runpanel__out')).toHaveText('you said: good morning\n')
})

test('Ctrl+Enter runs without reaching for the button', async ({ page }) => {
  await openRoom(page)
  await type(page, 'console.log("by keyboard")')

  await page.keyboard.press('Control+Enter')

  await expect(page.locator('.runpanel__out')).toHaveText('by keyboard\n')
})

test('the console is shared: the room sees a run it did not start', async ({ browser }) => {
  const room = newRoom()
  const alice = await browser.newContext()
  const bob = await browser.newContext()

  try {
    const alicePage = await alice.newPage()
    const bobPage = await bob.newPage()
    await openRoom(alicePage, room)
    await openRoom(bobPage, room)
    await expect(alicePage.getByText('2 people')).toBeVisible()

    await type(alicePage, 'console.log("everyone should see this")')
    await runButton(alicePage).click()

    // Bob never pressed anything, but the buffer is shared, so the output is.
    await expect(bobPage.locator('.runpanel__out')).toHaveText('everyone should see this\n')
    await expect(bobPage.locator('.runpanel__author')).toContainText('ran this')

    // And Alice is not told about her own run twice.
    await expect(alicePage.locator('.runpanel__author')).toHaveCount(0)
  } finally {
    await alice.close()
    await bob.close()
  }
})

test('says why a language cannot be run instead of failing on the press', async ({ page }) => {
  await openRoom(page)

  await page.locator('.langpicker__trigger').click()
  await page.locator('.langpicker__search').fill('markdown')
  await page.locator('.langpicker__item').first().click()

  const button = runButton(page)
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', /not run/)
})

test('runs python when the server has it', async ({ page }) => {
  const room = await openRoom(page)

  const support = await page.request.get('/api/v1/runners').then((r) => r.json())
  const python = support.languages.find((entry) => entry.language === 'python')
  test.skip(!python?.available, 'no python on this machine')

  await page.locator('.langpicker__trigger').click()
  await page.locator('.langpicker__search').fill('python')
  await page.locator('.langpicker__item').first().click()

  await type(page, 'print("hello from python")')
  await runButton(page).click()

  await expect(page.locator('.runpanel__out')).toHaveText('hello from python\n')
  await expect(page.locator('.statusbar')).toContainText('python')
})

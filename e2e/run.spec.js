import { expect, test } from '@playwright/test'

const newRoom = () => 'run-' + Date.now() + '-' + Math.floor(Math.random() * 1000)

async function openRoom(page, room = newRoom()) {
  await page.goto('/room/' + room)
  await expect(page.getByText('Connected')).toBeVisible()
  return room
}

/** Monaco's textarea sits under the rendered lines; click those instead. */
async function focusEditor(page) {
  await page.locator('.monaco-editor .view-lines').click()
  await expect(page.locator('.monaco-editor textarea')).toBeFocused()
}

async function type(page, code) {
  await focusEditor(page)
  await page.keyboard.type(code)
}

/**
 * Puts a whole program in the editor by pasting it.
 *
 * Typing anything with braces does not survive the editor: Monaco closes them
 * as they are typed and re-indents around them, so a Java class arrives with
 * doubled braces and does not compile. Pasting is both reliable and what
 * someone actually does with a program this size.
 */
async function paste(page, code) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await focusEditor(page)
  await page.evaluate((text) => navigator.clipboard.writeText(text), code)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Control+V')
  await expect(page.locator('.view-lines')).toContainText('public class Main')
}

const runButton = (page) => page.getByRole('button', { name: /^Run/ })

/**
 * Picks a language by its exact name. "java" also matches javascript, so the
 * first row is not necessarily the language that was asked for.
 */
async function chooseLanguage(page, name) {
  await page.locator('.langpicker__trigger').click()
  await page.locator('.langpicker__search').fill(name)
  await page.getByRole('option', { name, exact: true }).click()
  await expect(page.locator('.langpicker__trigger')).toContainText(name)
}

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

  await page.getByRole('button', { name: 'Input' }).click()
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

  await chooseLanguage(page, 'markdown')

  const button = runButton(page)
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', /not run/)
})

/**
 * The Scanner case, which is how most people meet standard input: the program
 * is correct, the input box was empty, and the only feedback used to be a
 * stack trace about an exception in somebody else's code.
 */
test('points at the input box when a program runs out of input', async ({ page }) => {
  const room = await openRoom(page)

  const support = await page.request.get('/api/v1/runners').then((r) => r.json())
  const java = support.languages.find((entry) => entry.language === 'java')
  test.skip(!java?.available, 'no JDK on this machine')

  await chooseLanguage(page, 'java')

  // The array-maximum exercise, as a person actually writes it.
  await paste(
    page,
    [
      'import java.util.*;',
      '',
      'public class Main {',
      '    static int findMaximum(int[] arr) {',
      '        int max = arr[0];',
      '        for (int num : arr) {',
      '            if (num > max) { max = num; }',
      '        }',
      '        return max;',
      '    }',
      '',
      '    public static void main(String[] args) {',
      '        Scanner sc = new Scanner(System.in);',
      '        System.out.print("Enter array size: ");',
      '        int n = sc.nextInt();',
      '        int[] arr = new int[n];',
      '        System.out.println("Enter " + n + " numbers:");',
      '        for (int i = 0; i < n; i++) { arr[i] = sc.nextInt(); }',
      '        System.out.println("Maximum = " + findMaximum(arr));',
      '        sc.close();',
      '    }',
      '}',
    ].join('\n')
  )

  await runButton(page).click()

  const hint = page.locator('.runhint')
  await expect(hint).toContainText('input box was empty')
  await expect(page.locator('.runpanel__out--err')).toContainText('NoSuchElementException')

  // The hint is the fix: it opens the box and puts the caret in it.
  await hint.getByRole('button', { name: 'Add input' }).click()
  await expect(page.locator('.stdin__field')).toBeFocused()
  await page.keyboard.type('5\n3 9 2 7 1')

  // Typing does not retract the explanation. It described the run that is
  // still on screen, and taking it away the moment someone acts on it leaves
  // them staring at the same stack trace with nothing to explain it.
  await expect(hint).toBeVisible()

  // What did change is that the output no longer matches the input box.
  const stale = page.locator('.runstale')
  await expect(stale).toContainText('older run')

  await stale.getByRole('button', { name: 'Run again' }).click()

  await expect(page.locator('.runpanel__out').first()).toContainText('Maximum = 9')
  await expect(page.locator('.runhint')).toHaveCount(0)
  await expect(page.locator('.runstale')).toHaveCount(0)
  expect(room).toBeTruthy()
})

/**
 * Editing the code leaves the last run's output on screen. Unmarked, a fix
 * looks like it did not work: the same failure is still sitting there.
 */
test('marks output as older once the code changes under it', async ({ page }) => {
  await openRoom(page)
  await type(page, 'console.log("first version")')

  await runButton(page).click()
  await expect(page.locator('.runpanel__out')).toHaveText('first version\n')
  await expect(page.locator('.runstale')).toHaveCount(0)

  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.type('\nconsole.log("second version")')

  await expect(page.locator('.runstale')).toBeVisible()
  // The old output is still there to read, just no longer presented as current.
  await expect(page.locator('.runpanel__out')).toHaveText('first version\n')

  await page.locator('.runstale').getByRole('button', { name: 'Run again' }).click()

  await expect(page.locator('.runpanel__out')).toContainText('second version')
  await expect(page.locator('.runstale')).toHaveCount(0)
})

test('runs python when the server has it', async ({ page }) => {
  const room = await openRoom(page)

  const support = await page.request.get('/api/v1/runners').then((r) => r.json())
  const python = support.languages.find((entry) => entry.language === 'python')
  test.skip(!python?.available, 'no python on this machine')

  await chooseLanguage(page, 'python')

  await type(page, 'print("hello from python")')
  await runButton(page).click()

  await expect(page.locator('.runpanel__out')).toHaveText('hello from python\n')
  await expect(page.locator('.statusbar')).toContainText('python')
})

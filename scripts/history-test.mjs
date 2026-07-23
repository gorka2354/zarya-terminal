/** Verify ↑/↓ input history in the bottom bar (shell mode, no agent needed). */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-h-'))
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, NODE_ENV: 'production' }
})
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const input = page.locator('.zy-agentbar-input')
  await input.click()
  // Send two commands (shell mode) to build history.
  await input.fill('echo first')
  await input.press('Enter')
  await page.waitForTimeout(200)
  await input.fill('echo second')
  await input.press('Enter')
  await page.waitForTimeout(200)

  // ↑ → last, ↑ → older, ↓ → back to newer.
  await input.press('ArrowUp')
  const up1 = await input.inputValue()
  await input.press('ArrowUp')
  const up2 = await input.inputValue()
  await input.press('ArrowDown')
  const down1 = await input.inputValue()
  console.log('after Enter x2, ArrowUp ->', JSON.stringify(up1))
  console.log('ArrowUp again  ->', JSON.stringify(up2))
  console.log('ArrowDown      ->', JSON.stringify(down1))
  console.log('history works:', up1 === 'echo second' && up2 === 'echo first' && down1 === 'echo second')
} finally {
  await app.close()
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
}

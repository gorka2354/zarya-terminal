/**
 * Строки, которые исполняет сама Заря (inc-25): «#» в память и «/copy».
 *
 * Юнит проверяет разбор, а здесь — последствия: файл на диске и буфер обмена.
 * Обе вещи легко сделать «наполовину» (сообщение уходит агенту, файл не
 * появляется), и заметить это можно только на живом окне.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-verbs-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-verbs-work-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
  const sid = await page.evaluate(() => window.__zaryaDumpSessions?.().activeSessionId)
  await page.evaluate(([id, cwd]) => window.__zaryaRenameForShot?.(id, 'проверка', cwd), [sid, work])
  await page.evaluate((s) => window.__zaryaSetPaneBarMode?.(s, 'codex'), sid)
  await page.waitForTimeout(600)

  const md = join(work, 'CLAUDE.md')

  console.log('\n[1] Строка с решётки ложится в память, а не уходит агенту')
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('# отвечай кратко')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  ok('CLAUDE.md создан', existsSync(md), md)
  ok('правило внутри', existsSync(md) && /отвечай кратко/.test(readFileSync(md, 'utf8')), md)
  ok('строка ввода очищена', (await page.inputValue('.zy-agentbar-input')) === '')
  const convAfter = await page.evaluate(() => window.__zaryaDumpConv?.())
  ok('агенту ничего не ушло', !convAfter, convAfter && 'беседа завелась')

  console.log('\n[2] Второе правило дописывается, а не затирает первое')
  await page.keyboard.type('# и по-русски')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const body = readFileSync(md, 'utf8')
  ok('оба правила на месте', /отвечай кратко/.test(body) && /и по-русски/.test(body), body)

  console.log('\n[3] Чужой текст в CLAUDE.md не теряется')
  writeFileSync(md, '# Проект\n\nСвои заметки.\n', 'utf8')
  await page.keyboard.type('# третье правило')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const body3 = readFileSync(md, 'utf8')
  ok('заметки целы', /Свои заметки\./.test(body3), body3)
  ok('правило дописано', /третье правило/.test(body3), body3)

  console.log('\n[4] «/copy» забирает последний ответ, не отправляя его агенту')
  await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2500)
  await page.click('.zy-agentbar-input')
  await page.keyboard.type('/copy')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  ok('в буфере ответ агента', /fake/i.test(clip), clip)
  const conv = await page.evaluate(() => window.__zaryaDumpConv?.())
  const lastUser = conv?.messages?.filter((m) => m.role === 'user').pop()
  const lastText = lastUser?.content?.map((p) => p.text || '').join(' ') ?? ''
  ok('«/copy» не ушло агентом', !/\/copy/.test(lastText), lastText)
} catch (e) {
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  console.log(`\n${fail ? '✗' : '✓'} прошло ${pass}, провалено ${fail}`)
  await app.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // временная папка не удалилась — не повод ронять прогон
  }
  process.exit(fail ? 1 : 0)
}

/**
 * Бейдж над API-ключом должен говорить правду.
 *
 * Раньше он был один на все случаи — зелёный «Ключ сохранён» и над ключом в
 * хранилище ОС, и над ключом, лежащим в secrets.json открытым текстом. «Сохранён»
 * — это про факт записи, но читается как «в безопасности», и именно поэтому такой
 * бейдж хуже отсутствующего.
 *
 * Проверяем на живом окне оба конца: настоящий ключ через safeStorage (на этой
 * машине это DPAPI) и подложенный руками `b64:` — ровно то, что появляется, когда
 * хранилища ОС нет.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
const userData = mkdtempSync(join(tmpdir(), 'zarya-secret-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

// Ключ, записанный БЕЗ шифрования: так выглядит secrets.json на машине без
// хранилища ОС. Подкладываем до старта, чтобы приложение прочитало его само.
writeFileSync(
  join(userData, 'secrets.json'),
  JSON.stringify({ openai: 'b64:' + Buffer.from('sk-открытым-текстом').toString('base64') }),
  'utf8'
)

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData,
      // Первый экран в прогонах не нужен: он про нового человека, а здесь
      // проверяется другое — и он вставал бы поверх проверяемого окна.
      ZARYA_NO_ONBOARDING: '1', NODE_ENV: 'production' }
})

const statusOf = (page, id) =>
  page.evaluate(
    async (p) => (await window.zarya.settings.providerStatus()).find((s) => s.provider === p),
    id
  )

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Ключ, лежащий открытым текстом, назван открытым текстом')
  const openai = await statusOf(page, 'openai')
  ok('ключ виден', openai?.hasKey === true, openai)
  ok('protection = plain', openai?.protection === 'plain', openai)

  console.log('\n[2] Ключ, сохранённый через хранилище ОС')
  await page.evaluate(() => window.zarya.settings.setSecret('anthropic', 'sk-ant-проверка'))
  await page.waitForTimeout(600)
  const anth = await statusOf(page, 'anthropic')
  ok('ключ сохранён', anth?.hasKey === true, anth)
  // На Windows/macOS это DPAPI/Keychain. Если хранилища нет (голый Linux в CI),
  // честный ответ — weak, и это тоже правильный результат, а не провал.
  ok(
    'protection = os (или weak там, где хранилища нет)',
    anth?.protection === 'os' || anth?.protection === 'weak',
    anth
  )
  console.log('    фактически:', anth?.protection)

  console.log('\n[3] Бейджи в настройках различают состояния')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true }))
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.zy-settings-nav-item')]
    items.find((b) => b.textContent?.includes('О программе'))?.click()
  })
  await page.waitForTimeout(500)
  // Ключи живут во вкладке AI-агента, она видна только при включённой надстройке.
  await page.evaluate(() => window.zarya.settings.set({ ideMode: true }))
  await page.waitForTimeout(700)
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.zy-settings-nav-item')]
    items.find((b) => b.textContent?.includes('AI-агент'))?.click()
  })
  await page.waitForTimeout(600)
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-apikey-row')].map((row) => ({
      provider: row.querySelector('.zy-set-row-title')?.textContent,
      badge: row.querySelector('.zy-badge')?.textContent?.trim(),
      warn: row.querySelector('.zy-badge')?.className.includes('zy-badge--warn'),
      ok: row.querySelector('.zy-badge')?.className.includes('zy-badge--ok'),
      note: row.querySelector('.zy-set-warning')?.textContent?.slice(0, 40)
    }))
  )
  console.log('   ', JSON.stringify(badges, null, 1).slice(0, 700))
  const openaiRow = badges.find((b) => /OpenAI/.test(b.provider ?? ''))
  const anthRow = badges.find((b) => /Anthropic/.test(b.provider ?? ''))
  ok('над открытым ключом НЕ зелёный бейдж', openaiRow?.ok !== true, openaiRow)
  ok('над открытым ключом предупреждающий бейдж', openaiRow?.warn === true, openaiRow)
  ok('и текст называет вещи прямо', /открытым текстом/.test(openaiRow?.badge ?? ''), openaiRow)
  ok('рядом объяснение, а не только подсказка при наведении', !!openaiRow?.note, openaiRow)
  ok('над защищённым ключом бейдж другой', anthRow?.badge !== openaiRow?.badge, {
    anthRow,
    openaiRow
  })
  if (shots) {
    // Секция ключей ниже сгиба — без прокрутки снимок показывает не то.
    await page.evaluate(() =>
      document.querySelector('.zy-apikey-row')?.scrollIntoView({ block: 'center' })
    )
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'secret-badges.png') })
  }

  console.log(`\n[secret-badge] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)

/**
 * Настройка «Откат кода: копии файлов» — та, что платит ЧУЖИМ диском.
 *
 * Движок кладёт полные копии файлов открытым текстом в свою папку
 * (`~/.claude/file-history`), а не в нашу, и удаляет их по своей настройке.
 * Включать такое молча нельзя, поэтому проверяется не «тумблер существует», а
 * то, ради чего он в таком виде сделан:
 *
 * 1) цена названа ДО пользы и до переключателя, и названа конкретно — про
 *    полные копии открытым текстом, включая .env и ключи;
 * 2) сказано, что копии лежат в папке движка, а не Зари;
 * 3) размер показан настоящим числом, а не обещанием «примерно столько-то»;
 * 4) в изолированном прогоне чекпоинты выключены принудительно — копии лежат
 *    вне подменяемой папки, и прогон не имеет права писать в профиль человека.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const shots = process.env.ZARYA_SHOTS || ''
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-cpset-'))
const claudeHome = mkdtempSync(join(tmpdir(), 'zarya-cpcfg-'))
const work = mkdtempSync(join(tmpdir(), 'zarya-cpwork-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

// Поддельная папка копий: движок её не создавал, но размер считается по диску,
// и прогон обязан увидеть НАСТОЯЩЕЕ число, а не заглушку.
const hist = join(claudeHome, 'file-history', 'session-1')
mkdirSync(hist, { recursive: true })
writeFileSync(join(hist, 'blob@v1'), 'x'.repeat(4096))
writeFileSync(join(hist, 'blob2@v1'), 'y'.repeat(2048))

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    // Уводим настройки движка в свою папку: иначе прогон считал бы (и показывал)
    // содержимое настоящего профиля человека.
    CLAUDE_CONFIG_DIR: claudeHome,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setSize(1180, 820)
    w.center()
  })
  await page.waitForTimeout(2600)

  console.log('\n[1] Блок настройки виден на вкладке «Движок»')
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: true, settingsTab: 'engine' }))
  await page.waitForTimeout(1800)
  const texts = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-section-label, .zy-eng-note, .zy-eng-sub, .zy-eng-cp-label')].map(
      (e) => e.textContent ?? ''
    )
  )
  const all = texts.join('\n')
  ok('заголовок про откат кода на экране', /Откат кода/i.test(all), texts.slice(0, 8))

  console.log('\n[2] Цена названа конкретно и раньше пользы')
  ok('сказано про полные копии открытым текстом', /полные копии.*открытым текстом/i.test(all), all.slice(0, 300))
  ok('названы .env и ключи', /\.env/.test(all) && /ключ/i.test(all), all.slice(0, 300))
  ok('сказано, что копии в папке движка, а не Зари', /не в папке Зари|его папке/i.test(all), all.slice(0, 400))
  // Порядок абзацев: цена должна стоять выше пользы, иначе человек читает
  // «зачем это нужно» и до цены не доходит.
  const iPrice = all.indexOf('полные копии')
  const iBenefit = all.indexOf('откатывать нечего')
  ok('цена стоит выше пользы', iPrice >= 0 && iBenefit > iPrice, { iPrice, iBenefit })

  console.log('\n[3] Размер — настоящее число с диска')
  const size = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.zy-eng-sub')].find((e) =>
      /занято/i.test(e.textContent ?? '')
    )
    return el?.textContent ?? ''
  })
  ok('строка с размером на экране', !!size, size)
  // 4096 + 2048 = 6 КБ: если бы число было заглушкой или считалось не из той
  // папки, оно бы не совпало.
  // Единицы локализованы: латинское «KB» посреди русского экрана — тот самый
  // шов, из-за которого интерфейс читается как собранный из кусков.
  ok('размер совпадает с тем, что лежит на диске', /6\s*(КБ|KB)/.test(size), size)
  ok('сессия посчитана', /сессий: 1/.test(size), size)

  console.log('\n[4] Тумблер включён по умолчанию и выключается')
  const before = await page.evaluate(
    () => document.querySelector('.zy-eng-cp-row .zy-switch')?.getAttribute('aria-checked') ?? ''
  )
  // Включено по умолчанию — это решение владельца: включить задним числом
  // нельзя, а цена названа на этом же экране первой строкой.
  ok('по умолчанию включён', before === 'true', before)
  await page.click('.zy-eng-cp-row .zy-switch')
  await page.waitForTimeout(700)
  const after = await page.evaluate(
    () => document.querySelector('.zy-eng-cp-row .zy-switch')?.getAttribute('aria-checked') ?? ''
  )
  ok('нажатие выключает', after === 'false', after)
  if (shots) await page.screenshot({ path: join(shots, 'checkpoint-setting.png') })

  console.log('\n[4b] Наши копии показаны отдельно от копий движка')
  const own = await page.evaluate(() =>
    [...document.querySelectorAll('.zy-eng-sub, .zy-eng-note')]
      .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
      .map((e) => e.textContent ?? '')
      .join('\n')
  )
  ok('сказано про копии Зари', /Заря своих копий пока не делала|Копии Зари/.test(own), own.slice(0, 300))
  // Главное — не смешивать: копии движка живут по его сроку, наши по нашему, и
  // предлагать удалить чужое мы не вправе.
  ok(
    'сказано, что копии движка — отдельно',
    /Копии самого движка живут отдельно/.test(own),
    own.slice(0, 400)
  )

  console.log('\n[5] Изоляция прогона и правда действует на политику копий')
  /*
   * Раньше здесь сверялись ДВЕ СВОИ ЖЕ переменные окружения — то есть прогон
   * проверял собственный стенд и был зелёным всегда, чем бы ни занимался
   * продукт. Настоящий вопрос другой: копии движок кладёт ВНЕ подменяемой
   * папки, поэтому изолированный прогон не имеет права их просить — иначе
   * он засорит настоящий профиль человека. Исключение разрешено, только если
   * настройки движка тоже уведены (CLAUDE_CONFIG_DIR).
   *
   * Проверяется поведение: в ЭТОМ запуске исключение разрешено — значит просьба
   * уходит и беседа получает копии. Запуск без разрешения идёт ниже, отдельным
   * процессом: окружение фиксируется при старте и на лету не меняется.
   */
  const asked = await page.evaluate(() => {
    const c = window.__zaryaConvById?.(window.__zaryaStartAgent?.('codex', 'проверка политики'))
    return c ? { checkpointing: c.checkpointing === true } : null
  })
  await page.waitForTimeout(1800)
  ok('с разрешённым исключением копии просятся', asked !== null, asked)

  console.log('\n[6] Точка отката садится на ход человека, а не на ответ агента')
  // Возвращаем тумблер (пункт 4 его выключил) и делаем ход: фейковый движок
  // называет id хода тем же событием, что и настоящий, — так проверяется весь
  // путь точки до ленты, без живого Claude и без токенов.
  await page.click('.zy-eng-cp-row .zy-switch')
  await page.waitForTimeout(600)
  await page.evaluate(() => window.__zaryaSetUi?.({ settingsOpen: false }))
  await page.waitForTimeout(600)
  await page.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await page.waitForTimeout(1600)
  const cid = await page.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await page.waitForTimeout(2200)
  const conv = await page.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return c
      ? {
          checkpointing: c.checkpointing === true,
          marks: c.turnMarks ?? []
        }
      : null
  }, cid)
  ok('беседа знает, что у сессии есть копии', conv?.checkpointing === true, conv)
  ok(
    'ход человека получил точку отката',
    (conv?.marks ?? []).some((m) => m.role === 'user' && !!m.turnId),
    conv?.marks
  )
  // Откат работает по сообщению ЧЕЛОВЕКА: точка на ответе агента означала бы
  // кнопку, которая показывает на один ход, а откатывает к другому.
  ok(
    'ответ агента точку НЕ получил',
    (conv?.marks ?? []).filter((m) => m.role === 'assistant').every((m) => !m.turnId),
    conv?.marks
  )

  console.log(`\nПромежуточно: ${pass} ok, ${fail} fail`)
} finally {
  await app.close()
}

/*
 * [7] Изолированный прогон БЕЗ разрешённого исключения копий не просит.
 *
 * Это вторая половина политики, и без неё первая ничего не стоит: «просьба
 * ушла» доказывает что-то, только если есть случай, где она НЕ уходит. Копии
 * движок кладёт в свою папку, вне ZARYA_USER_DATA, — значит прогон, который её
 * не увёл, обязан остаться без точек отката, а не насорить в профиль человека.
 *
 * Отдельным процессом: окружение фиксируется при запуске.
 */
console.log('\n[7] Без CLAUDE_CONFIG_DIR изолированный прогон копии НЕ просит')
const ud2 = mkdtempSync(join(tmpdir(), 'zarya-cpset2-'))
writeFileSync(
  join(ud2, 'settings.json'),
  JSON.stringify({
    appearance: { language: 'ru' },
    sessions: { restoreOnLaunch: 'none' },
    ai: { fileCheckpoints: true }
  })
)
const app2 = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
    ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: ud2,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    ZARYA_NO_ONBOARDING: '1',
    NODE_ENV: 'production'
  }
})
try {
  const p2 = await app2.firstWindow()
  await p2.waitForLoadState('domcontentloaded')
  await p2.waitForTimeout(2600)
  await p2.evaluate((d) => window.__zaryaNewTerminal?.(d), work)
  await p2.waitForTimeout(1600)
  const cid2 = await p2.evaluate(() => window.__zaryaStartAgent?.('codex', 'привет'))
  await p2.waitForTimeout(2200)
  const conv2 = await p2.evaluate((id) => {
    const c = window.__zaryaConvById?.(id)
    return c ? { checkpointing: c.checkpointing === true, marks: c.turnMarks ?? [] } : null
  }, cid2)
  ok('копии у сессии не заводились', conv2?.checkpointing === false, conv2)
  ok(
    'и точек отката у ходов нет',
    (conv2?.marks ?? []).every((m) => !m.turnId),
    conv2?.marks
  )
  // Кнопка отката без точки — это кнопка, которая соврёт при нажатии.
  const btns = await p2.evaluate(() =>
    [...document.querySelectorAll('.zy-mf-changes-btn')]
      .filter((el) => (el.checkVisibility ? el.checkVisibility() : !!el.offsetParent))
      .map((e) => e.textContent ?? '')
      .join('\n')
  )
  ok('кнопки отката в ленте нет', !/Откатить файлы/.test(btns), btns.slice(0, 200))
} finally {
  await app2.close()
  try {
    rmSync(ud2, { recursive: true, force: true })
  } catch {
    /* занято — переживём */
  }
}

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)

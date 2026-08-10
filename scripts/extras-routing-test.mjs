/**
 * Команды, перечитывание и наблюдатель — по СВОЕЙ панели.
 *
 * Две находки ревью, обе про одно: данные агента принадлежат беседе, а код брал
 * их «вообще».
 *
 *  1. `listCommands` и `reloadExtras` брали первую сессию из Map. При четырёх
 *     панелях в трёх проектах человек видел в «/» скиллы чужого репозитория, а
 *     «подхватить» перечитывало не ту панель, в которой он нажал.
 *  2. Наблюдатель следил за папкой ПРОЦЕССА — то есть за той, из которой
 *     запустили приложение. Личные скиллы это ловило, а проектные
 *     (`.claude/skills`, `.mcp.json` открытого проекта) не видело вовсе.
 *
 * Прогон заводит две папки с разным содержимым и требует, чтобы каждая панель
 * отвечала своей. Агенты фейковые: ни сети, ни живого Claude.
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
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

const userData = mkdtempSync(join(tmpdir(), 'zarya-routing-'))
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({ appearance: { language: 'ru' }, sessions: { restoreOnLaunch: 'none' } })
)

// Два «проекта» со своими скиллами — как два репозитория в разных панелях.
const projA = mkdtempSync(join(tmpdir(), 'zarya-proj-a-'))
const projB = mkdtempSync(join(tmpdir(), 'zarya-proj-b-'))
for (const p of [projA, projB]) mkdirSync(join(p, '.claude', 'skills'), { recursive: true })
writeFileSync(join(projA, '.claude', 'skills', 'a.md'), '# skill A\n')
writeFileSync(join(projB, '.claude', 'skills', 'b.md'), '# skill B\n')

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: {
    ...process.env,
      // Тихо: окно уезжает за край экрана, чтобы прогон не отбирал фокус
      // посреди работы человека. ZARYA_SHOW=1 возвращает его на экран.
      ...(process.env.ZARYA_SHOW ? {} : { ZARYA_QA_OFFSCREEN: '1' }),
    ZARYA_USER_DATA: userData,
    ZARYA_FAKE_AGENT: '1',
    ZARYA_NO_UPDATE_CHECK: '1',
    NODE_ENV: 'production'
  }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)

  console.log('\n[1] Две беседы в разных папках')
  await page.evaluate(
    ([a, b]) => {
      window.zarya.agent.start('codex', 'conv-a', { prompt: 'привет', cwd: a })
      window.zarya.agent.start('codex', 'conv-b', { prompt: 'привет', cwd: b })
    },
    [projA, projB]
  )
  await page.waitForTimeout(1500)

  console.log('\n[2] Команды приходят от СВОЕЙ панели')
  const listA = await page.evaluate(() => window.zarya.agent.listCommands('codex', 'conv-a'))
  const listB = await page.evaluate(() => window.zarya.agent.listCommands('codex', 'conv-b'))
  const namesA = (listA?.commands ?? []).map((c) => c.name)
  const namesB = (listB?.commands ?? []).map((c) => c.name)
  const leaf = (p) => p.split(/[\\/]/).filter(Boolean).pop()
  ok('панель A получила команду своего проекта', namesA.includes(`proj-${leaf(projA)}`), namesA)
  ok('и НЕ получила команду чужого', !namesA.includes(`proj-${leaf(projB)}`), namesA)
  ok('панель B получила команду своего проекта', namesB.includes(`proj-${leaf(projB)}`), namesB)
  ok('и НЕ получила команду чужого', !namesB.includes(`proj-${leaf(projA)}`), namesB)
  ok('общая команда есть у обеих', namesA.includes('fake-common') && namesB.includes('fake-common'))

  console.log('\n[3] Без названной беседы — только общее, без чужого проекта')
  const listNone = await page.evaluate(() => window.zarya.agent.listCommands('codex'))
  const namesNone = (listNone?.commands ?? []).map((c) => c.name)
  ok('общая команда на месте', namesNone.includes('fake-common'), namesNone)
  ok(
    'ни одна проектная не подставлена наугад',
    !namesNone.some((n) => n.startsWith('proj-')),
    namesNone
  )

  console.log('\n[4] «Подхватить» перечитывает ту панель, из которой нажали')
  const reA = await page.evaluate(() => window.zarya.agent.reloadExtras('codex', 'conv-a'))
  const reB = await page.evaluate(() => window.zarya.agent.reloadExtras('codex', 'conv-b'))
  ok('панель A перечитала свой проект', reA?.mcpServers?.[0]?.name === `mcp-of-${leaf(projA)}`, reA?.mcpServers)
  ok('панель B — свой', reB?.mcpServers?.[0]?.name === `mcp-of-${leaf(projB)}`, reB?.mcpServers)
  ok('и обе ответили успехом', reA?.ok === true && reB?.ok === true, { a: reA?.ok, b: reB?.ok })

  console.log('\n[5] Закрытую беседу не подменяют соседней')
  const reGone = await page.evaluate(() => window.zarya.agent.reloadExtras('codex', 'нет-такой'))
  ok('честное «нечего перечитывать»', reGone?.ok === false, reGone)
  ok('и ни одного сервера чужой панели', (reGone?.mcpServers ?? []).length === 0, reGone?.mcpServers)

  console.log('\n[6] Наблюдатель видит ПРОЕКТНУЮ папку панели')
  // Раньше следили за папкой процесса, поэтому новый скилл в проекте не
  // замечался вовсе — человек не узнавал, что можно подхватить.
  await page.evaluate(() => {
    globalThis.__extras = 0
    window.zarya.agent.onExtrasChanged(() => {
      globalThis.__extras++
    })
  })
  mkdirSync(join(projA, '.claude', 'skills', 'fresh'), { recursive: true })
  writeFileSync(join(projA, '.claude', 'skills', 'fresh', 'SKILL.md'), '# новый скилл\n')
  let seen = 0
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300)
    seen = await page.evaluate(() => globalThis.__extras)
    if (seen > 0) break
  }
  ok('появление скилла в проекте замечено', seen > 0, seen)
  ok('и сказано об этом один раз, а не потоком', seen <= 2, seen)

  console.log(`\n[extras-routing] PASS ${pass} · FAIL ${fail}`)
} catch (e) {
  // Ошибка внутри прогона обязана быть ВИДНА: `process.exit` в finally гасит
  // вывод необработанного отказа, и упавший прогон печатал «провалено 0» с
  // нулевым кодом выхода — то есть выглядел прошедшим.
  fail++
  console.log('  ✗ прогон упал:', e?.stack || e?.message || String(e))
} finally {
  await app.close()
}

if (fail) process.exit(1)

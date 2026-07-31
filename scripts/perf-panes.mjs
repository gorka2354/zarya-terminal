/**
 * Скорость работы в НЕСКОЛЬКИХ панелях.
 *
 * Четыре CLI с длинными лентами — это рабочий день Егора, а не крайний случай.
 * Замедление тут не «ощущение»: его видно в числах — сколько миллисекунд стоит
 * одно движение мыши при перетаскивании, одна набранная буква и сколько главный
 * поток стоит колом (long tasks) при ответе агента.
 *
 * Прогон печатает цифры и падает, если они хуже порога: производительность —
 * такое же обещание, как и всё остальное, и проверять её надо тем же способом.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'zarya-perf-'))
let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name, extra !== undefined ? '· ' + JSON.stringify(extra) : '')
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

/** Пороги. Выше — человек замечает задержку, и это уже не «мелочь». */
const LIMITS = {
  // Пороги стоят чуть выше нынешних цифр (7 мс на движение, 7 на кусок потока):
  // прогон должен ловить ОТКАТ, а не мигать от шума соседних процессов.
  dragoverAvgMs: 11,
  dragoverWorstMs: 60,
  typeAvgMs: 12,
  chunkAvgMs: 12,
  chunkWorstMs: 80,
  gutterAvgMs: 12,
  gutterWorstMs: 60,
  longTaskTotalMs: 1200
}

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js')],
  env: { ...process.env, ZARYA_USER_DATA: userData, ZARYA_FAKE_AGENT: '1', NODE_ENV: 'production' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3200)

  console.log('\n[1] Готовим рабочий день: четыре панели с длинными лентами')
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__zaryaSplitActive('row'))
    await page.waitForTimeout(900)
  }
  await page.waitForTimeout(1200)
  const ids = await page.evaluate(() => window.__zaryaDumpSessions().tabs[0].leaves)
  // Ленты набиваем блоками: пустая лента ничего не скажет о медленной. Столько
  // их и бывает к вечеру — по полсотни команд в каждой панели, у каждой свой
  // вывод в десяток строк.
  await page.evaluate((list) => {
    for (const sid of list) window.__zaryaSeedBlocks?.(sid, 50, 12)
  }, ids)
  await page.waitForTimeout(1500)
  // И разговором агента: разметка, запуски инструментов, их результаты — то, из
  // чего лента состоит после нескольких часов работы.
  const convs = await page.evaluate(
    (list) => list.map((sid) => window.__zaryaSeedConversation?.(sid, 25)),
    ids
  )
  await page.waitForTimeout(2500)
  const size = await page.evaluate(() => ({
    panes: document.querySelectorAll('.zy-pane').length,
    nodes: document.querySelectorAll('*').length,
    cmds: document.querySelectorAll('.zy-mf-cmd').length,
    lines: document.querySelectorAll('.zy-mf-line').length
  }))
  console.log('  размер сцены:', JSON.stringify(size))
  ok('четыре панели на месте', size.panes === 4, size.panes)

  console.log('\n[2] Перетаскивание: сколько стоит одно движение мыши')
  const drag = await page.evaluate(async ([target, guest]) => {
    const dt = new DataTransfer()
    dt.setData('application/x-zarya-session', guest)
    const pane = document.querySelector(`.zy-pane[data-session="${target}"]`)
    const r = pane.getBoundingClientRect()
    pane.dispatchEvent(
      new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true })
    )
    const times = []
    // Водим курсором по панели крест-накрест: сторона под курсором меняется,
    // как при настоящем перетаскивании.
    for (let i = 0; i < 60; i++) {
      const t = i / 59
      const x = r.left + 8 + (r.width - 16) * (i % 2 ? t : 1 - t)
      const y = r.top + 8 + (r.height - 16) * t
      const t0 = performance.now()
      pane.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: Math.round(x),
          clientY: Math.round(y)
        })
      )
      // Ждём кадр: настоящая цена движения — вместе с перерисовкой, а не только
      // с обработчиком.
      await new Promise((res) => requestAnimationFrame(() => res()))
      times.push(performance.now() - t0)
    }
    window.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }))
    times.sort((a, b) => a - b)
    return {
      avg: +(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1),
      p50: +times[Math.floor(times.length / 2)].toFixed(1),
      worst: +times[times.length - 1].toFixed(1)
    }
  }, [ids[1], ids[3]])
  console.log('  движение мыши, мс:', JSON.stringify(drag))
  ok(`среднее ≤ ${LIMITS.dragoverAvgMs} мс`, drag.avg <= LIMITS.dragoverAvgMs, drag.avg)
  ok(`худшее ≤ ${LIMITS.dragoverWorstMs} мс`, drag.worst <= LIMITS.dragoverWorstMs, drag.worst)

  console.log('\n[3] Набор текста в строке ввода')
  const typing = await page.evaluate(async (sid) => {
    const input = document.querySelector(`.zy-pane[data-session="${sid}"] .zy-agentbar-input`)
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    const times = []
    let text = ''
    for (const ch of 'проверка скорости набора') {
      text += ch
      const t0 = performance.now()
      setter?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((res) => requestAnimationFrame(() => res()))
      times.push(performance.now() - t0)
    }
    setter?.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    times.sort((a, b) => a - b)
    return {
      avg: +(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1),
      worst: +times[times.length - 1].toFixed(1)
    }
  }, ids[0])
  console.log('  буква, мс:', JSON.stringify(typing))
  ok(`средняя буква ≤ ${LIMITS.typeAvgMs} мс`, typing.avg <= LIMITS.typeAvgMs, typing.avg)

  console.log('\n[4] Тянем разделитель: живое изменение пропорций')
  // Красная полоса между панелями. Каждое движение меняет доли — а с ними
  // размеры терминалов, и каждый пересчёт размера уходит в ConPTY. Если это
  // делать на каждое движение мыши, тянуть панель невозможно.
  const gutter = await page.evaluate(async () => {
    const g = document.querySelector('.zy-gutter')
    if (!g) return { skipped: true }
    const r = g.getBoundingClientRect()
    const x0 = r.left + r.width / 2
    const y0 = r.top + r.height / 2
    g.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x0, clientY: y0 })
    )
    const times = []
    for (let i = 0; i < 60; i++) {
      // Ведём туда-обратно на ±120 пикселей, как рукой.
      const dx = Math.round(120 * Math.sin((i / 59) * Math.PI * 2))
      const t0 = performance.now()
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(x0 + dx),
          clientY: Math.round(y0)
        })
      )
      await new Promise((res) => requestAnimationFrame(() => res()))
      times.push(performance.now() - t0)
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
    times.sort((a, b) => a - b)
    return {
      avg: +(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1),
      p50: +times[Math.floor(times.length / 2)].toFixed(1),
      worst: +times[times.length - 1].toFixed(1)
    }
  })
  console.log('  движение разделителя, мс:', JSON.stringify(gutter))
  ok(`среднее <= ${LIMITS.gutterAvgMs} мс`, (gutter.avg ?? 99) <= LIMITS.gutterAvgMs, gutter.avg)
  ok(`худшее <= ${LIMITS.gutterWorstMs} мс`, (gutter.worst ?? 99) <= LIMITS.gutterWorstMs, gutter.worst)

  console.log('\n[4] Поток ответа: сколько стоит ОДИН пришедший кусок текста')
  // Настоящий стриминг сыплет десятками кусков в секунду. Если каждый кусок
  // заставляет ленту пересобрать себя целиком — в четырёх панелях не поработать.
  const stream = await page.evaluate(async (convId) => {
    const times = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      window.__zaryaSeedChunk?.(convId, ` ещё немного текста ${i}`)
      await new Promise((res) => requestAnimationFrame(() => res()))
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    return {
      avg: +(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1),
      p50: +times[Math.floor(times.length / 2)].toFixed(1),
      worst: +times[times.length - 1].toFixed(1)
    }
  }, convs[2])
  console.log('  кусок потока, мс:', JSON.stringify(stream))
  ok(`средний кусок <= ${LIMITS.chunkAvgMs} мс`, stream.avg <= LIMITS.chunkAvgMs, stream.avg)
  ok(`худший кусок <= ${LIMITS.chunkWorstMs} мс`, stream.worst <= LIMITS.chunkWorstMs, stream.worst)

  console.log('\n[4] Ответ агента в одной панели — сколько стоит главному потоку')
  const busy = await page.evaluate(async (sid) => {
    const tasks = []
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) tasks.push(Math.round(e.duration))
    })
    obs.observe({ entryTypes: ['longtask'] })
    window.__zaryaStartAgentIn?.('gemini', 'ещё раз про панели, подробно', sid)
    await new Promise((res) => setTimeout(res, 6000))
    obs.disconnect()
    return {
      count: tasks.length,
      total: tasks.reduce((s, x) => s + x, 0),
      worst: tasks.length ? Math.max(...tasks) : 0
    }
  }, ids[2])
  console.log('  длинные задачи за 6 с:', JSON.stringify(busy))
  ok(
    `главный поток стоял ≤ ${LIMITS.longTaskTotalMs} мс`,
    busy.total <= LIMITS.longTaskTotalMs,
    busy.total
  )

  console.log(`\n[perf] PASS ${pass} · FAIL ${fail}`)
} finally {
  await app.close()
}
process.exit(fail ? 1 : 0)

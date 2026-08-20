import { app, screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from './jsonStore'
import { FILE_MODE } from './filePerms'

/**
 * Окно помнит, каким его оставили.
 *
 * ПОВОД. Заря помнит сессии, блоки, разговоры, раскладку панелей, вкладки,
 * шрифт и тему — всё, кроме самого окна: каждый запуск открывал одни и те же
 * 1360×860 посреди экрана. На большом мониторе это выглядит как «программа не
 * доделана»: человек растягивает окно каждый раз заново, потому что вчерашнее
 * положение никого не интересовало.
 *
 * ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ. Мониторы отключают, ноутбук уносят из дока,
 * разрешение меняют — и вчерашний прямоугольник запросто оказывается там, где
 * экрана больше нет. Восстанавливать его вслепую значило бы открыть окно,
 * которого не видно, то есть выглядеть как «не запустилось». Поэтому положение
 * сначала сверяется с теми экранами, которые есть СЕЙЧАС (см. `fitsOnScreen`),
 * и не прошедшее проверку молча заменяется размером по умолчанию.
 *
 * Файл отдельный, а не поле в настройках: размер окна человек не выбирает в
 * списке, его двигают мышью — мешать это с тем, что он настроил осознанно, не
 * стоит.
 *
 * Правило «достижим ли прямоугольник» работает на ОБЕ стороны — и при чтении, и
 * при записи. Поэтому здесь нет ни одного признака харнесса: тихий прогон уводит
 * окно за край экрана, и оно отсекается тем же правилом, что и отключённый
 * монитор, — не особым случаем, а по существу.
 */

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

/** Столько же, сколько было зашито в createWindow до появления памяти. */
export const DEFAULT_SIZE = { width: 1360, height: 860 }
/** Нижняя граница окна — та же, что у minWidth/minHeight самого BrowserWindow. */
const MIN_SIZE = { width: 920, height: 560 }

/**
 * Видно ли этот прямоугольник хоть на одном из экранов.
 *
 * Требуем не «пересекается вообще», а заметный кусок: окно, торчащее на экран
 * одним пикселем, формально видно, а на деле недосягаемо. 120×40 — это полоса
 * заголовка, за которую окно можно вытащить мышью.
 */
export function fitsOnScreen(b: WindowState, areas: Rectangle[]): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return areas.some((a) => {
    const w = Math.min(b.x! + b.width, a.x + a.width) - Math.max(b.x!, a.x)
    const h = Math.min(b.y! + b.height, a.y + a.height) - Math.max(b.y!, a.y)
    return w >= 120 && h >= 40
  })
}

/**
 * Что передать в `new BrowserWindow` — с оглядкой на сегодняшние экраны.
 *
 * Размер берём даже тогда, когда положение не подошло: «окно было широким» —
 * это про привычку человека, а не про исчезнувший монитор.
 */
export function boundsFrom(
  saved: WindowState | null,
  areas: Rectangle[]
): { width: number; height: number; x?: number; y?: number } {
  if (!saved) return { ...DEFAULT_SIZE }
  const width = Math.max(MIN_SIZE.width, Math.round(saved.width) || DEFAULT_SIZE.width)
  const height = Math.max(MIN_SIZE.height, Math.round(saved.height) || DEFAULT_SIZE.height)
  const candidate: WindowState = { x: saved.x, y: saved.y, width, height }
  if (!fitsOnScreen(candidate, areas)) return { width, height }
  return { width, height, x: Math.round(saved.x!), y: Math.round(saved.y!) }
}

function file(): string {
  return join(app.getPath('userData'), 'window.json')
}

export function readWindowState(): WindowState | null {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<WindowState>
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : undefined
    const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : undefined
    return { x, y, width, height, maximized: !!raw.maximized }
  } catch {
    // Файла нет (первый запуск) или он испорчен — открываемся по умолчанию.
    return null
  }
}

/** Прямоугольник для `new BrowserWindow` плюс признак «было развёрнуто». */
export function initialBounds(): {
  bounds: { width: number; height: number; x?: number; y?: number }
  maximized: boolean
} {
  const saved = readWindowState()
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  return { bounds: boundsFrom(saved, areas), maximized: !!saved?.maximized }
}

/**
 * Запоминать движения окна, пока оно живо.
 *
 * Пишем с задержкой: перетаскивание окна поднимает событие на каждый кадр, и
 * запись файла на каждое из них была бы сотней записей на диск за один жест.
 */
export function trackWindow(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const snapshot = (): WindowState | null => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return null
    // getNormalBounds — размер ДО разворачивания: развёрнутое окно занимает
    // весь экран, и запомнить это как «его размер» значило бы потерять тот,
    // который человек выбрал сам.
    const b = win.getNormalBounds()
    const s: WindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: win.isMaximized()
    }
    /*
     * НЕ ЗАПОМИНАЕМ ТО, ЧТО ОТКАЗАЛИСЬ БЫ ВОССТАНОВИТЬ.
     *
     * Правило одно на обе стороны: прямоугольник, до которого на сегодняшних
     * экранах не дотянуться, при следующем запуске всё равно будет отброшен —
     * значит и записывать его незачем. Заодно это отсекает тихий прогон,
     * который уводит окно за край экрана (-32000): такое окно не человеческое,
     * и его положение не должно становиться ничьей настройкой.
     */
    return fitsOnScreen(
      s,
      screen.getAllDisplays().map((d) => d.workArea)
    )
      ? s
      : null
  }
  const save = (): void => {
    const s = snapshot()
    if (s) void writeJsonAtomic(file(), s).catch(() => undefined)
  }
  /*
   * Закрытие — единственный момент, когда отложенная запись не успеет: процесс
   * уходит раньше, чем промис дойдёт до диска. Здесь пишем сразу и через
   * временный файл, чтобы прерванная запись не оставила огрызок вместо файла.
   */
  const saveNow = (): void => {
    const s = snapshot()
    if (!s) return
    try {
      const target = file()
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: FILE_MODE })
      renameSync(tmp, target)
    } catch {
      // Не сумели запомнить размер — не повод мешать закрытию.
    }
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }

  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    saveNow()
  })
}

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.' },
  screen: { getAllDisplays: () => [] }
}))

const { boundsFrom, fitsOnScreen, DEFAULT_SIZE } = await import('../src/main/windowState')

/** Обычный ноутбучный экран с панелью задач снизу. */
const laptop = { x: 0, y: 0, width: 1920, height: 1040 }
/** Второй монитор слева — координаты отрицательные, и это норма. */
const left = { x: -2560, y: -200, width: 2560, height: 1440 }

describe('fitsOnScreen — окно должно быть достижимо мышью', () => {
  it('окно на своём месте — видно', () => {
    expect(fitsOnScreen({ x: 100, y: 100, width: 1360, height: 860 }, [laptop])).toBe(true)
  })

  it('окно с отключённого монитора — нет', () => {
    /*
     * Ради этого всё и затевалось. Монитор отключили, ноутбук унесли из дока —
     * вчерашний прямоугольник ведёт в никуда, и восстановить его вслепую значит
     * открыть окно, которого не видно: со стороны это «программа не
     * запустилась».
     */
    expect(fitsOnScreen({ x: -2000, y: -100, width: 1360, height: 860 }, [laptop])).toBe(false)
    expect(fitsOnScreen({ x: -2000, y: -100, width: 1360, height: 860 }, [laptop, left])).toBe(true)
  })

  it('край в край — не считается', () => {
    // Полоски в несколько пикселей формально видно, а ухватить нельзя.
    expect(fitsOnScreen({ x: 1900, y: 500, width: 1360, height: 860 }, [laptop])).toBe(false)
    expect(fitsOnScreen({ x: 1700, y: 500, width: 1360, height: 860 }, [laptop])).toBe(true)
  })

  it('без координат судить не о чем', () => {
    expect(fitsOnScreen({ width: 1360, height: 860 }, [laptop])).toBe(false)
  })
})

describe('boundsFrom — что достаётся окну при запуске', () => {
  it('первый запуск — размер по умолчанию и никакого положения', () => {
    expect(boundsFrom(null, [laptop])).toEqual({ ...DEFAULT_SIZE })
  })

  it('вчерашнее окно возвращается целиком', () => {
    const saved = { x: 40, y: 60, width: 1700, height: 900 }
    expect(boundsFrom(saved, [laptop])).toEqual(saved)
  })

  it('положение потеряно — РАЗМЕР всё равно помним', () => {
    /*
     * «Окно было широким» — это про привычку человека, а не про исчезнувший
     * монитор. Система сама поставит его по центру доступного экрана.
     */
    const out = boundsFrom({ x: -3000, y: -900, width: 1700, height: 900 }, [laptop])
    expect(out).toEqual({ width: 1700, height: 900 })
  })

  it('слишком маленькое окно поднимается до минимума', () => {
    // Иначе испорченный файл открыл бы окно, в котором ничего не помещается.
    const out = boundsFrom({ x: 10, y: 10, width: 200, height: 100 }, [laptop])
    expect(out.width).toBe(920)
    expect(out.height).toBe(560)
  })

  it('мусор в файле не превращается в NaN на экране', () => {
    const out = boundsFrom({ x: 10, y: 10, width: 0, height: 0 }, [laptop])
    expect(Number.isFinite(out.width) && out.width > 0).toBe(true)
    expect(Number.isFinite(out.height) && out.height > 0).toBe(true)
  })

  it('дробные координаты округляются', () => {
    // BrowserWindow ждёт целые; дробь давала бы каждый раз сдвиг на пиксель.
    const out = boundsFrom({ x: 40.6, y: 60.2, width: 1700.4, height: 900.7 }, [laptop])
    expect(out).toEqual({ x: 41, y: 60, width: 1700, height: 901 })
  })
})

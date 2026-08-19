import { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'

/**
 * Мост к блокам команд: главный процесс спрашивает окно, окно отвечает.
 *
 * ПОЧЕМУ НЕ КОПИЯ. Состав панелей мы держим зеркалом (см. `paneRegistry`) —
 * там несколько строк на панель. Блоки — это весь вывод терминала, сотни
 * записей на сессию; вторая их копия в главном процессе стоила бы памяти и
 * разъезжалась бы с первой. Спрашиваем по требованию.
 *
 * ПОЧЕМУ С ТАЙМАУТОМ. Молчание окна — не пустой ответ, а неизвестность:
 * панель могли закрыть, окно могло быть занято. Сказать агенту «команд нет»,
 * не дождавшись, значит соврать ему ровно так же, как соврала бы кнопка.
 */

/*
 * Блок в том виде, в каком его видит агент, живёт в @shared/types: он
 * пересекает IPC, и окно собирает его тем же типом, каким главный процесс
 * его читает. Две копии одной формы однажды разошлись бы молча.
 */
import type { BlockBrief } from '@shared/types'
export type { BlockBrief }

export type BlocksAnswer =
  | { ok: true; kind: 'list'; blocks: BlockBrief[] }
  | { ok: true; kind: 'one'; block: BlockBrief; output: string; truncated: boolean }
  | {
      ok: false
      reason:
        | 'no-window'
        | 'silent'
        | 'no-pane'
        | 'not-found'
        | 'off'
        | 'refused'
        | 'tail-off'
        | 'no-integration'
    }

/** Сколько ждать ответ окна. Чтение из памяти мгновенно; запас — на занятое окно. */
const REPLY_TIMEOUT_MS = 4000

class BlockBridge {
  private getWindow: (() => BrowserWindow | null) | null = null
  private waiting = new Map<string, (a: BlocksAnswer) => void>()
  private seq = 0

  bind(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  /** Окно ответило. */
  reply(queryId: string, answer: BlocksAnswer): void {
    const resolve = this.waiting.get(queryId)
    if (!resolve) return
    this.waiting.delete(queryId)
    resolve(answer)
  }

  private ask(payload: Record<string, unknown>): Promise<BlocksAnswer> {
    const win = this.getWindow?.()
    if (!win) return Promise.resolve({ ok: false, reason: 'no-window' })
    const queryId = `b${++this.seq}`
    return new Promise<BlocksAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(queryId)
        resolve({ ok: false, reason: 'silent' })
      }, REPLY_TIMEOUT_MS)
      this.waiting.set(queryId, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      win.webContents.send(CH.blocksQuery, { queryId, ...payload })
    })
  }

  /**
   * Какие команды человек запускал в панели этой беседы.
   *
   * `contains` — поиск по команде и по её выводу. Без него список как был:
   * последние N команд без единой строки вывода.
   */
  list(convId: string, limit: number, contains?: string): Promise<BlocksAnswer> {
    return this.ask({ kind: 'list', convId, limit, ...(contains ? { contains } : {}) })
  }

  /** Полный вывод одной команды. */
  read(convId: string, blockId: string): Promise<BlocksAnswer> {
    return this.ask({ kind: 'one', convId, blockId })
  }
}

export const blockBridge = new BlockBridge()

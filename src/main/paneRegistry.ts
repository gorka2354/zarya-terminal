import type { BrowserWindow } from 'electron'
import {
  clampText,
  emptySendLog,
  findPane,
  guardSend,
  type PaneRef,
  type SendLog
} from '@shared/paneMessage'
import { CH } from '@shared/ipc'

/**
 * Кто сейчас на экране и как передать соседу записку.
 *
 * ЗАЧЕМ ЗЕРКАЛО. Инструменты агента исполняются в ГЛАВНОМ процессе (их
 * обработчики живут внутри сессии движка), а состав панелей, их имена и
 * занятость знает ОКНО. Спрашивать окно синхронно посреди хода нечем — IPC
 * ходит из окна в главный процесс, не наоборот. Поэтому окно само присылает
 * список при каждом изменении, а здесь лежит его копия.
 *
 * Копия может отстать на доли секунды — и это не страшно: худшее, что случится,
 * — агент увидит панель, которую только что закрыли, и получит честный отказ
 * «такой панели нет». Обратное — синхронный запрос в окно из середины хода —
 * стоило бы зависания всего разговора.
 *
 * ЖУРНАЛ ОТПРАВОК ЖИВЁТ ЗДЕСЬ ЖЕ, и это не мелочь: он единственное, что мешает
 * двум агентам разговаривать друг с другом по кругу за деньги владельца. В
 * окне он бы обнулялся при каждой перезагрузке страницы.
 */
/** Что окно сделало с запиской. Слова для агента строятся из этого. */
export type NoteAck =
  { ok: true; held?: 'autopilot' | 'busy' } | { ok: false; reason: 'gone' | 'off' }

/** Сколько ждём ответа окна. Дольше — и агент решит, что мы зависли. */
const ACK_TIMEOUT_MS = 4000

class PaneRegistry {
  private panes: PaneRef[] = []
  private log: SendLog = emptySendLog()
  private getWindow: (() => BrowserWindow | null) | null = null
  /** Записки, ждущие ответа окна: id -> кому отдать результат. */
  private waiting = new Map<string, (a: NoteAck) => void>()
  private seq = 0

  /** Окно ставится один раз при регистрации IPC. */
  bind(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  /** Окно отчиталось, что сделало с запиской. */
  ack(noteId: string, result: NoteAck): void {
    const resolve = this.waiting.get(noteId)
    if (!resolve) return
    this.waiting.delete(noteId)
    resolve(result)
  }

  /** Новый состав панелей — целиком, как и всё уровневое в этом проекте. */
  setPanes(panes: PaneRef[]): void {
    this.panes = Array.isArray(panes) ? panes : []
  }

  /**
   * Что видит агент этой панели: все соседи, кроме него самого.
   *
   * Себя убираем здесь, а не в инструменте: панель в собственном списке — это
   * приглашение написать себе, а такой круг ничем не отличается от петли.
   */
  list(exceptConvId: string): PaneRef[] {
    return this.panes.filter((p) => p.convId !== exceptConvId)
  }

  /**
   * Рабочая папка САМОЙ панели — чтобы было с чем сравнивать соседей.
   *
   * Нужна одному месту: пометке «вы оба в этой папке». Пустая строка значит
   * «панель себя не назвала», и тогда сравнивать нечего — молчим, а не
   * объявляем совпадение с неизвестностью.
   */
  cwdOf(convId: string): string {
    return this.panes.find((p) => p.convId === convId)?.cwd ?? ''
  }

  /**
   * Доставить записку соседней панели.
   *
   * Возвращает СЛОВА ДЛЯ АГЕНТА, а не булево: он должен понять, что делать
   * дальше — уточнить адрес, подождать или бросить попытки. Ошибка, сведённая к
   * «не получилось», заставила бы его повторять то же самое, а повтор здесь
   * стоит денег.
   */
  async send(
    from: string,
    address: string,
    text: string
  ): Promise<{ ok: boolean; message: string }> {
    const body = clampText(text)
    if (!body) return { ok: false, message: 'Message text is empty — nothing was sent.' }

    const found = findPane(this.panes, address, from)
    if (!found.ok) {
      if (found.reason === 'self') {
        return { ok: false, message: 'That address is this very pane. Messages go to OTHER panes.' }
      }
      if (found.reason === 'ambiguous') {
        const names = (found.candidates ?? [])
          .map((p) => `${p.title} (${p.cwd ?? 'no folder'}) id=${p.convId}`)
          .join('; ')
        return {
          ok: false,
          message: `Several panes answer to that name: ${names}. Send again using the exact id.`
        }
      }
      const known = this.list(from)
        .map((p) => p.title)
        .join(', ')
      return {
        ok: false,
        message: known
          ? `No pane named "${address}". Panes right now: ${known}.`
          : 'There are no other panes open right now.'
      }
    }

    const verdict = guardSend(this.log, { from, to: found.pane.convId, text: body }, Date.now())
    this.log = verdict.log
    if (!verdict.allow) {
      return {
        ok: false,
        message:
          verdict.reason === 'rate'
            ? 'Too many messages from this pane in the last minute. Wait before sending again.'
            : verdict.reason === 'pair-cap'
              ? 'These two panes have exchanged too many notes this hour. Stop messaging that pane and tell the person instead.'
              : 'That exact message already went to that pane a moment ago; it was not sent twice.'
      }
    }

    const win = this.getWindow?.()
    if (!win) return { ok: false, message: 'The window is not available; nothing was delivered.' }

    /*
     * ЖДЁМ ОТВЕТ ОКНА, а не сочиняем его.
     *
     * Наш список панелей — копия, и она отстаёт: панель могли закрыть секунду
     * назад. Сказать агенту «доставлено», не спросив у окна, значит соврать ему
     * ровно в том месте, ради которого весь инкремент. Заодно окно знает то,
     * чего не знаем мы: включён ли у получателя автопилот и занят ли он.
     */
    const noteId = `n${++this.seq}`
    const ack = await new Promise<NoteAck>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(noteId)
        // Молчание окна — не «доставлено». Скорее всего панели уже нет.
        resolve({ ok: false, reason: 'gone' })
      }, ACK_TIMEOUT_MS)
      this.waiting.set(noteId, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      win.webContents.send(CH.paneMessage, {
        noteId,
        toConvId: found.pane.convId,
        fromConvId: from,
        text: body
      })
    })

    if (!ack.ok) {
      return {
        ok: false,
        message:
          ack.reason === 'off'
            ? 'That pane does not accept notes: the person turned pane messaging off.'
            : `Pane "${found.pane.title}" is no longer open; the note was not delivered.`
      }
    }
    if (ack.held) {
      return {
        ok: true,
        message:
          ack.held === 'autopilot'
            ? `The note is shown in "${found.pane.title}", but its agent has NOT been given it: that pane runs without permission prompts, so notes wait for the person there. Do not expect a reply.`
            : `The note is shown in "${found.pane.title}", but its agent is mid-turn and has not been given it yet. Do not expect a reply.`
      }
    }
    return {
      ok: true,
      message: `Delivered to "${found.pane.title}". The person there sees it as a message from another pane, and its agent decides what to do with it.`
    }
  }
}

/**
 * Один на приложение: и журнал отправок, и состав панелей должны быть общими
 * для всех сессий движка — иначе каждая беседа считала бы петли по-своему.
 */
export const paneRegistry = new PaneRegistry()

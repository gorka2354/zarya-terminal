import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { t, useLang } from '@/lib/i18n'
import './asktext.css'

/**
 * Спросить строку.
 *
 * В Electron `window.prompt()` не реализован — он бросает «prompt() is not
 * supported», и любой путь интерфейса, построенный на нём, молча не делал
 * НИЧЕГО: кнопка переименования стола нажималась, и ничего не происходило. Это
 * худший вид неправды в интерфейсе — не ошибка, а тишина.
 *
 * Отсюда своё окно: то же самое обещание («введите имя»), но выполненное.
 */
interface AskState {
  open: boolean
  title: string
  value: string
  resolve: ((v: string | null) => void) | null
  set: (patch: Partial<AskState>) => void
}

const useAsk = create<AskState>((set) => ({
  open: false,
  title: '',
  value: '',
  resolve: null,
  set: (patch) => set(patch)
}))

/**
 * Замена `window.prompt`: возвращает введённое или `null`, если человек
 * отказался. Отдельный промис на вызов — а прежний вопрос, если он висел,
 * закрывается отказом, чтобы никто не остался ждать ответа навсегда.
 */
export function askText(title: string, value = ''): Promise<string | null> {
  const prev = useAsk.getState().resolve
  if (prev) prev(null)
  return new Promise((resolve) => {
    useAsk.getState().set({ open: true, title, value, resolve })
  })
}

// Крючок для прогонов: окно вопроса открывают семь разных мест интерфейса, а
// проверять надо его САМО — что оно забирает Enter и Esc себе и не отдаёт их
// гейту в панели. Открывать его через контекстное меню значило бы проверять
// заодно и меню.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __zaryaAskText?: typeof askText }).__zaryaAskText = askText
}

/**
 * Открыто ли окно вопроса прямо сейчас.
 *
 * Нужно диспетчеру клавиш (features/ai/keyRouter): пока висит это окно, Enter и
 * Esc принадлежат ЕМУ. Без этого Enter, нажатый на кнопке «Сохранить», доходил
 * до окна вторым слушателем и одобрял ожидающий гейт в активной панели — то
 * есть переименование сессии запускало команду, которую человек ещё не смотрел.
 */
export function askOwnsKeys(): boolean {
  return useAsk.getState().open
}

export function AskText(): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого окна сменились бы не в момент
  // переключения, а при следующей перерисовке по другой причине.
  useLang()

  const open = useAsk((s) => s.open)
  const title = useAsk((s) => s.title)
  const initial = useAsk((s) => s.value)
  const [text, setText] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setText(initial)
    // Выделяем целиком: почти всегда имя меняют, а не дописывают.
    const id = window.setTimeout(() => inputRef.current?.select(), 0)
    return () => clearTimeout(id)
  }, [open, initial])

  if (!open) return null

  const finish = (v: string | null): void => {
    const { resolve } = useAsk.getState()
    useAsk.getState().set({ open: false, resolve: null, value: '' })
    resolve?.(v)
  }

  return (
    <div
      className="zy-overlay-backdrop zy-overlay-backdrop--center"
      onMouseDown={() => finish(null)}
    >
      <div className="zy-ask" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-ask-title">{title}</div>
        <input
          ref={inputRef}
          className="zy-input zy-ask-input"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // Пустая строка — это не имя: пустое поле значит «оставить как
              // было», и молча стирать имя по Enter было бы сюрпризом.
              finish(text.trim() ? text : null)
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              finish(null)
            }
          }}
        />
        <div className="zy-ask-actions">
          <button type="button" className="zy-btn" onClick={() => finish(null)}>
            {t('wf.cancel')}
          </button>
          <button
            type="button"
            className="zy-btn zy-btn--accent"
            onClick={() => finish(text.trim() ? text : null)}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

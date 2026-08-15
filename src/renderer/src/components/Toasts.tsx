import { useUiStore } from '@/state/uiStore'

/**
 * Глифы уровней — те же, что у строк уведомлений в ленте (`NoticeLine`).
 *
 * ПОВОД. Тост различался ТОЛЬКО цветом рамки: зелёной у удачи, красной у
 * ошибки. Для человека, который не различает эти два цвета, «скопировано» и
 * «не скопировалось» выглядели одинаково — а разница между ними как раз та,
 * ради которой тост и показывают. Внутри ленты этот же вопрос давно решён
 * глифами, и решение просто не доехало сюда.
 *
 * Знаки взяты оттуда дословно: два разных вида одного и того же сообщения в
 * одном приложении — сами по себе повод для сомнения «а это точно про то же?».
 */
const GLYPH: Record<string, string> = {
  success: '✓',
  error: '✗',
  info: '·'
}

export function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  return (
    /*
     * `aria-live` на КОНТЕЙНЕРЕ, а не на самом тосте: объявляется то, что
     * появилось внутри уже существующей живой области. Повесь мы её на сам
     * тост — он рождается вместе с ней, и вычитывать было бы нечего.
     *
     * `polite`, а не `assertive`: тост сообщает об исходе того, что человек
     * только что сделал сам, и обрывать ради этого его текущее чтение незачем.
     */
    <div className="zy-toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`zy-toast zy-toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {/* Глиф — украшение для скринридера: он и так прочтёт текст, а «галка»
              посреди фразы только помешает. Поэтому aria-hidden. */}
          <span className="zy-toast-glyph" aria-hidden="true">
            {GLYPH[t.kind] ?? GLYPH.info}
          </span>
          <span className="zy-toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}

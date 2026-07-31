import { useRef, useState } from 'react'
import { useAiStore } from '@/features/ai/aiStore'
import { nextGate } from '@/features/ai/gates'
import { useUiStore } from '@/state/uiStore'
import { FuelGauge, UsagePanel } from './AgentBar'
import { Icon } from './Icon'
import './agentbar.css'

/**
 * Общая нижняя полоса окна.
 *
 * Сюда уходит то, что принадлежит ПРИЛОЖЕНИЮ, а не панели. Топливомер —
 * главный пример: расход подписки за 5 часов и за неделю относится к аккаунту,
 * и четыре одинаковых индикатора в четырёх панелях показывали бы одно и то же
 * число, отнимая место у работы.
 *
 * Что НЕ уехало: заполнение контекста беседы. Оно у каждой панели своё, и в общей
 * полосе показывало бы чужое — поэтому остаётся в панели.
 *
 * Счётчик «ждут решения» здесь же: с четырьмя панелями гейт может висеть там,
 * куда вы сейчас не смотрите, а невидимый вопрос — это агент, вставший навсегда.
 */
export function BottomStrip(): React.JSX.Element {
  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const agentContext = useUiStore((s) => s.agentContext)
  const agentCaps = useUiStore((s) => s.agentCaps)
  const [usageOpen, setUsageOpen] = useState(false)
  const fuelBtnRef = useRef<HTMLButtonElement>(null)

  // Сколько панелей ждут решения человека. Считаем по тому же правилу, что и
  // карточка одобрения, — иначе счётчик и карточки разойдутся.
  const waiting = useAiStore(
    (s) => s.conversations.filter((c) => nextGate(c) !== undefined).length
  )

  const showFuel = Object.values(agentCaps).some((c) => c?.usage)
  const lead = ((): { short: string; label: string; pct: number } | null => {
    if (!showFuel) return null
    const u = claudeStatus.usage
    const five = u?.fiveHourPct
    const seven = u?.sevenDayPct
    if (five == null && seven == null) return null
    if (seven != null && (five == null || seven > five))
      return { short: '7дн', label: 'Недельный лимит', pct: seven }
    return { short: '5ч', label: 'Пятичасовой лимит', pct: five as number }
  })()

  return (
    <div className="zy-strip">
      {usageOpen && (
        <UsagePanel
          usage={showFuel ? claudeStatus.usage : undefined}
          context={agentContext}
          onClose={() => setUsageOpen(false)}
          anchor={fuelBtnRef.current}
        />
      )}
      <div className="zy-agentbar-fuel">
        <button
          ref={fuelBtnRef}
          className="zy-agentbar-fuel-main"
          title={
            lead
              ? `${lead.label}: израсходовано ${Math.round(lead.pct)}%. Нажми — все лимиты`
              : 'Лимиты подписки'
          }
          aria-expanded={usageOpen}
          onClick={() => setUsageOpen((v) => !v)}
        >
          {lead ? (
            <>
              <FuelGauge used={lead.pct} />
              <span className="zy-agentbar-fuel-val">
                {lead.short} {Math.round(lead.pct)}%
              </span>
            </>
          ) : (
            <span className="zy-agentbar-fuel-val">
              {showFuel ? 'борт заправлен' : '∞ без лимита · локальный борт'}
            </span>
          )}
          <Icon name={usageOpen ? 'chevron-down' : 'chevron-up'} size={10} />
        </button>
      </div>
      <button
        className="zy-agentbar-fuel-pult"
        onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
        title="Пусковой комплекс"
      >
        пульт ▴
      </button>
      <div className="zy-strip-spacer" />
      {waiting > 0 && (
        <span
          className="zy-strip-waiting"
          title="Панели, где агент ждёт вашего решения. Клавишами отвечает только та, что в фокусе"
        >
          ждут решения: {waiting}
        </span>
      )}
    </div>
  )
}

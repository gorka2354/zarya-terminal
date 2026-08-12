import { useRef, useState } from 'react'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { nextGate } from '@/features/ai/gates'
import { useUiStore } from '@/state/uiStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { formatCost } from '@shared/cost'
import { t, useLang } from '@/lib/i18n'
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
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const agentContext = useUiStore((s) => s.agentContext)
  const agentCaps = useUiStore((s) => s.agentCaps)
  const [usageOpen, setUsageOpen] = useState(false)
  const fuelBtnRef = useRef<HTMLButtonElement>(null)

  // Сколько панелей ждут решения человека. Считаем по тому же правилу, что и
  // карточка одобрения, — иначе счётчик и карточки разойдутся.
  const waiting = useAiStore((s) => s.conversations.filter((c) => nextGate(c) !== undefined).length)

  // Стоимость — у беседы ТОЙ панели, на которую человек смотрит: полоса одна на
  // окно, а разговоров в нём столько же, сколько панелей.
  const activeSessionId = useSessionsStore((s) => s.activeSessionId())
  const activeConv = useAiStore((s) => convForSession(s, activeSessionId))
  const costLabel = formatCost(activeConv?.costUsd)
  const onPlan = !!claudeStatus.usage?.subscriptionType

  const showFuel = Object.values(agentCaps).some((c) => c?.usage)
  const lead = ((): { short: string; label: string; pct: number } | null => {
    if (!showFuel) return null
    const u = claudeStatus.usage
    const five = u?.fiveHourPct
    const seven = u?.sevenDayPct
    if (five == null && seven == null) return null
    if (seven != null && (five == null || seven > five))
      return { short: t('usage.weekShort'), label: t('usage.weekLimit'), pct: seven }
    return { short: t('usage.fiveShort'), label: t('usage.fiveLimit'), pct: five as number }
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
              ? t('usage.leadHint', { label: lead.label, pct: Math.round(lead.pct) })
              : t('bar.limits')
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
              {t(showFuel ? 'strip.fueled' : 'strip.noLimit')}
            </span>
          )}
          <Icon name={usageOpen ? 'chevron-down' : 'chevron-up'} size={10} />
        </button>
      </div>
      {/*
        Во сколько обошёлся разговор АКТИВНОЙ панели.

        Движок считает это сам и до сих пор цифру выбрасывали. Стоит рядом с
        топливом, но говорит о другом: топливо — общий лимит аккаунта, а это
        деньги за конкретный разговор. Подпись обязательна и разная: на подписке
        сумма расчётная (ничего не списывается), по своему ключу — счёт.
      */}
      {costLabel && (
        <span
          className="zy-agentbar-fuel-cost"
          title={t(onPlan ? 'bar.costHintPlan' : 'bar.costHintApi')}
        >
          {costLabel}
        </span>
      )}
      <button
        className="zy-agentbar-fuel-pult"
        onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
        title={t('bar.launchPad')}
      >
        {t('strip.console')}
      </button>
      <div className="zy-strip-spacer" />
      {waiting > 0 && (
        <span className="zy-strip-waiting" title={t('strip.pendingHint')}>
          {t('strip.pendingLower', { n: waiting })}
        </span>
      )}
    </div>
  )
}

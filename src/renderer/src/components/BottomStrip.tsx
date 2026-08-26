import { useRef, useState } from 'react'
import { revealNextWaiting } from '@/actions/panes'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { nextGate } from '@/features/ai/gates'
import { useUiStore } from '@/state/uiStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { formatCost } from '@shared/cost'
import { t, useLang } from '@/lib/i18n'
import { agentStatusOf } from '@/state/uiStore'
import { fmtTokens, FuelGauge, prettyModel, UsagePanel } from './AgentBar'
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
 * Что показывается ПО АКТИВНОЙ панели, а не по окну: цена разговора,
 * заполнение контекста и подпись модели. Все три у каждой панели свои, и общего
 * значения у них нет вовсе — полоса показывает ту панель, на которую человек
 * смотрит, и вместе с ней меняется. Число «последнего отчитавшегося движка»
 * здесь не показывается никогда: это ровно то враньё, ради которого контекст в
 * прошлом выпуске переехал в беседу.
 *
 * Счётчик «ждут решения» здесь же: с четырьмя панелями гейт может висеть там,
 * куда вы сейчас не смотрите, а невидимый вопрос — это агент, вставший навсегда.
 */
export function BottomStrip(): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const agentCaps = useUiStore((s) => s.agentCaps)
  const ultracode = useUiStore((s) => s.ultracode)
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
  /*
   * Заполнение контекста и подпись модели — той же активной панели.
   *
   * Контекст стоял в ряду чипов над строкой ввода и отнимал место у неё самой:
   * при сетке 2×2 ряд органов управления упирался в поле ввода. Здесь ему и
   * место — рядом с лимитами подписки, среди чисел, а не среди кнопок.
   *
   * Модель и усилие берутся у ПАНЕЛИ (`agentStatusOf`), а не из настроек: с
   * прошлого выпуска модель пинится по беседе, и общее значение показывало бы
   * ту, чей ход закончился последним.
   */
  const convContext = activeConv?.context
  const paneStatus = useUiStore((s) => agentStatusOf(s, activeSessionId))
  // Движок без выбора моделей подписи не получает: чип обещал бы выбор, которого
  // у него нет. `builtin` сюда не попадает — у Зари своя подпись в самой строке.
  const showModel =
    !!activeConv &&
    activeConv.engine !== 'builtin' &&
    !!agentCaps[activeConv.engine]?.models &&
    (!!paneStatus.model || !!paneStatus.effort || ultracode)

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
          /* Контекст АКТИВНОЙ панели, а не последнего отчитавшегося движка:
             общее значение перезаписывает кто угодно, и панель показывала бы
             число соседа — прямо вопреки тому, что написано в шапке файла. */
          context={activeConv?.context}
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
        {/*
        ЗАПОЛНЕНИЕ КОНТЕКСТА АКТИВНОЙ ПАНЕЛИ.

        Стоит рядом с расходом подписки, но говорит о другом, и это разделение
        держится формой: расход — золотые ячейки лимита на весь аккаунт,
        контекст — тонкая серая шкала одного разговора. Подсказка называет
        числа: «контекст: 45K из 200K».

        Нет своего числа — нет и чипа: пустое место честнее чужой цифры, а
        появится она после первого же хода. Предупреждение о почти полном окне
        остаётся ТАКЖЕ в самой панели — там, куда человек смотрит.
      */}
        {convContext?.pct != null && (
          <span
            className={`zy-strip-ctx${convContext.pct >= 80 ? ' zy-strip-ctx--full' : ''}`}
            title={
              convContext.tokens != null && convContext.window != null
                ? `${t('usage.context')}: ${t('usage.tokensOf', {
                    used: fmtTokens(convContext.tokens),
                    total: fmtTokens(convContext.window)
                  })}`
                : t('usage.context')
            }
          >
            <span className="zy-strip-ctx-track">
              <span
                className="zy-strip-ctx-fill"
                style={{ width: `${Math.min(100, Math.max(0, convContext.pct))}%` }}
              />
            </span>
            {/* Знак, а не только цвет: предупреждение обязано доходить и в
              оттенках серого — тем же правилом, что и три глифа допуска. */}
            {convContext.pct >= 80 && (
              <span className="zy-strip-ctx-warn" aria-hidden="true">
                !
              </span>
            )}
            <span className="zy-strip-ctx-val">{Math.round(convContext.pct)}%</span>
          </span>
        )}
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
      {/*
        НА ЧЁМ РАБОТАЕТ ЭТА ПАНЕЛЬ.

        Подпись была задумана в строке ввода и вместе с копией топливной полосы
        оказалась под условием, которое не выполняется никогда, — то есть её не
        рисовалось нигде. Панель при этом держит СВОЮ модель, и посмотреть, на
        какой именно, было негде. Нажатие ведёт в пульт, где её и меняют.
      */}
      {showModel && (
        <button
          className="zy-agentbar-fuel-model"
          onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
          title={t('bar.engineHint')}
        >
          {paneStatus.model ? prettyModel(paneStatus.model) : ''}
          {ultracode
            ? ' · ⚡ULTRACODE'
            : paneStatus.effort
              ? ` · ${paneStatus.effort.toUpperCase()}`
              : ''}
        </button>
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
        /*
           СЧЁТЧИК — КНОПКА, а не надпись.
           
           Он говорит «ждут решения: 2» и до сих пор был просто текстом: человек
           читал число и шёл искать ждущую панель глазами по столам. Нажатие
           ведёт к первому из ждущих, повторное — к следующему по кругу
           (см. `revealNextWaiting`).
        */
        <button
          type="button"
          className="zy-strip-waiting"
          title={t('strip.pendingGo')}
          onClick={() => revealNextWaiting()}
        >
          {t('strip.pendingLower', { n: waiting })}
        </button>
      )}
    </div>
  )
}

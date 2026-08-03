import { registerActions } from '@/lib/actionRegistry'
import { deskTitle } from '@shared/deskTitle'
import { t } from '@/lib/i18n'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'

/**
 * Рабочие столы в палитре — по одному действию на стол.
 *
 * Зачем. Столы видно в сайдбаре, но сайдбар прячется (`Ctrl+B`), и тогда
 * навигация оставалась слепой: `Ctrl+Tab` перебирает по кругу, не показывая,
 * куда ведёт. Раньше в шапке лежал незаконченный ряд вкладок — его убрали,
 * потому что мёртвый код читается как «функция есть, просто спрятана».
 * Взамен человек набирает часть имени стола и попадает точно в него.
 *
 * Список перерегистрируется на каждое изменение столов: стол переименовали или
 * закрыли — палитра не должна предлагать вчерашнее.
 */
let unregister: (() => void) | null = null

function rebuild(): void {
  const { tabs, sessions, activeTabId } = useSessionsStore.getState()
  unregister?.()
  unregister = registerActions(
    tabs.map((tab) => {
      const names = listLeaves(tab.layout).map((sid) => sessions[sid]?.title ?? '')
      const title = deskTitle(names, tab.title, t('desk.untitled'))
      const panes = listLeaves(tab.layout).length
      return {
        id: `desk.switch.${tab.id}`,
        // Имя стола — то же, что в сайдбаре: человек ищет по тому, что видел.
        title: t('act.desk', { name: title }),
        category: t('act.cat.tabs'),
        // Панели и папка — чтобы стол находился и по проекту, в котором работа.
        keywords: [
          ...names,
          ...listLeaves(tab.layout).map((sid) => sessions[sid]?.cwd ?? ''),
          panes > 1 ? t('act.deskPanes', { n: panes }) : ''
        ]
          .filter(Boolean)
          .join(' '),
        // Текущий стол в списке не нужен: переходить в него неоткуда.
        enabled: () => useSessionsStore.getState().activeTabId !== tab.id,
        run: () => useSessionsStore.getState().setActiveTab(tab.id)
      }
    })
  )
  void activeTabId
}

/** Подписаться на столы и держать список действий свежим. */
export function registerDeskActions(): () => void {
  rebuild()
  const unsub = useSessionsStore.subscribe((s, prev) => {
    // Перебираем только когда изменился состав или имена — не на каждый ход
    // агента: перерегистрация дёргает всех подписчиков палитры.
    if (s.tabs !== prev.tabs || s.sessions !== prev.sessions) rebuild()
  })
  return () => {
    unsub()
    unregister?.()
    unregister = null
  }
}

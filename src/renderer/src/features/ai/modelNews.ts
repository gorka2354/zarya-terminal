import { freshModels, prettyModelName, withSeen } from '@shared/modelCatalog'
import { getSettings, useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'

/**
 * Новая модель у провайдера — и окно об этом.
 *
 * Модели выходят чаще, чем человек заглядывает в список: Opus 5 появился, а
 * Заря продолжала молча предлагать вчерашнее. Теперь, увидев в каталоге модель,
 * которой раньше не было, приложение говорит об этом один раз.
 *
 * Два правила, без которых окно превращается в шум:
 *
 * 1. Сравниваем с ВИДЕННЫМ, а не с прошлым ответом — отвалившаяся сеть иначе
 *    показала бы «новинку» повторно.
 * 2. Первый запуск не считается открытием: когда виденного нет вообще, каталог
 *    запоминается молча, иначе человек получит окно на каждую модель сразу.
 */
export async function checkModelNews(provider: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  const settings = getSettings()
  const seenAll = settings.ai.seenModels ?? {}
  const seen = seenAll[provider] ?? []
  const firstTime = seen.length === 0

  const fresh = freshModels(seen, ids)
  if (!fresh.length) return

  await useSettingsStore.getState().update({
    ai: { seenModels: { ...seenAll, [provider]: withSeen(seen, ids) } } as never
  })
  // Первый каталог запоминаем молча — рассказывать человеку «появились» про всё
  // сразу значит превратить новость в список.
  if (firstTime) return

  useUiStore.getState().set({
    modelNews: { provider, ids: fresh, names: fresh.map(prettyModelName) }
  })
}

// Прогону: подсунуть каталог и проверить, что про новинку сказано один раз.
// Настоящий каталог требует ключа и сети — а проверяется здесь не сеть, а то,
// как приложение об этом сообщает.
if (typeof window !== 'undefined') {
  ;(
    window as unknown as { __zaryaModelNews?: (provider: string, ids: string[]) => Promise<void> }
  ).__zaryaModelNews = (provider, ids) => checkModelNews(provider, ids)
}

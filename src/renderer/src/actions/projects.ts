import { samePath, withProject } from '@shared/projects'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'

/**
 * Проекты — папки, с которыми работают.
 *
 * Раньше их было две сущности: «проекты» (добавленные руками) и «недавние»
 * (вычисленные из сохранённых сессий), и жили они в двух разных меню — в шапке
 * и в сайдбаре. Снаружи разница не читалась: и то и другое — папка, которую
 * открываешь, а «добавить в проекты» открывало то же системное окно выбора,
 * что и «открыть папку», только не открывало саму папку.
 *
 * Теперь одна сущность и одно место. Открыл папку — она в списке, свежая
 * сверху; не нужна — крестик. Потолок держит список читаемым: у человека в
 * работе три-восемь проектов, и вытеснение не сработает никогда, но список,
 * растущий без предела, рано или поздно перестаёт быть списком.
 */
/** Запомнить папку: наверх списка проектов. */
export async function rememberProject(dir: string): Promise<void> {
  const cur = useSettingsStore.getState().settings.bookmarks
  const next = withProject(cur, dir)
  // Сравниваем по содержимому: лишняя запись настроек — лишний поход на диск и
  // лишняя перерисовка меню, из которого только что выбрали пункт.
  if (next.length === cur.length && next.every((b, i) => b === cur[i])) return
  await useSettingsStore.getState().update({ bookmarks: next })
}

/** Убрать папку из списка проектов. */
export async function forgetProject(dir: string): Promise<void> {
  const cur = useSettingsStore.getState().settings.bookmarks
  await useSettingsStore.getState().update({ bookmarks: cur.filter((b) => !samePath(b, dir)) })
}

/** Открыть проект вкладкой (и поднять его наверх списка). */
export async function openProject(dir: string): Promise<void> {
  await useSessionsStore.getState().newTab(undefined, dir)
  await rememberProject(dir)
}

/** Открыть проект панелью рядом с активной. */
export async function openProjectBeside(dir: string): Promise<void> {
  await useSessionsStore.getState().splitActive('row', dir)
  await rememberProject(dir)
}

/** Выбрать папку и открыть её вкладкой. Выбранная папка попадает в проекты. */
export async function openFolderAsTab(): Promise<void> {
  const dir = await window.zarya.app.pickDirectory()
  if (dir) await openProject(dir)
}

/** Выбрать папку и открыть её панелью рядом. */
export async function openFolderAsPane(): Promise<void> {
  const dir = await window.zarya.app.pickDirectory()
  if (dir) await openProjectBeside(dir)
}

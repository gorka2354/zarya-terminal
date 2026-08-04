import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SkillLayer } from '@shared/types'

/**
 * Настройки скиллов Claude Code: где лежат и как их читать.
 *
 * Отдельный модуль, а не кусок драйвера, по одной причине: здесь живёт правка
 * ЧУЖОГО файла, и она обязана проверяться юнит-тестами на настоящих файлах, а
 * не только сквозным прогоном. Ошибка тут стоит человеку его конфига.
 */

/** Пути настроек Claude Code: личные и два проектных. */
export function skillSettingsPaths(cwd?: string): Record<SkillLayer, string | undefined> {
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: cwd ? join(cwd, '.claude', 'settings.json') : undefined,
    local: cwd ? join(cwd, '.claude', 'settings.local.json') : undefined
  }
}

/**
 * Чем закончилось чтение файла настроек.
 *
 * Различать `missing` и `unreadable` ОБЯЗАТЕЛЬНО. Раньше и то и другое давало
 * `undefined`, а вызывающий подставлял `{}` — и правка скилла записывала поверх
 * чужого конфига файл из одного ключа. Достаточно было BOM (его ставит
 * PowerShell `Out-File -Encoding utf8`) или висячей запятой после ручной
 * правки, чтобы человек потерял модель, хуки и плагины без единого слова.
 */
export type SettingsRead =
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }

/**
 * BOM в начале файла.
 *
 * Снимаем, а не отвергаем: файл с BOM — обычный настроенный руками конфиг, и
 * отказ на нём был бы отказом на ровном месте. Обратно мы его не пишем.
 */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function readSettingsFile(path: string | undefined): SettingsRead {
  if (!path) return { kind: 'missing' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    // Нет файла — законное состояние: человек просто ничего не настраивал.
    // Всё остальное (нет прав, файл занят) — повод отказаться, а не гадать.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) }
  }
  // Пустой файл — то же, что отсутствующий: настроек в нём нет, и записывать
  // поверх пустоты безопасно.
  if (!stripBom(raw).trim()) return { kind: 'missing' }
  try {
    const parsed: unknown = JSON.parse(stripBom(raw))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'ok', value: parsed as Record<string, unknown> }
    }
    // Массив или число вместо объекта — это чей-то файл со смыслом, которого мы
    // не понимаем. Затирать его нельзя.
    return { kind: 'unreadable', error: 'не объект' }
  } catch (e) {
    return { kind: 'unreadable', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * `skillOverrides` из всех трёх слоёв настроек движка.
 *
 * Читаем все, а не только тот, куда пишем сами: у проектных слоёв приоритет
 * выше личного, и скилл, выключенный настройкой проекта, обязан выглядеть
 * выключенным — вместе с именем виноватого файла.
 *
 * Нечитаемый слой отмечается в `broken`: показывать «в работе» по файлу,
 * который мы не смогли прочитать, — это ровно тот интерфейс, который врёт.
 */
export function readSkillOverrides(cwd?: string): {
  layers: Partial<Record<SkillLayer, Record<string, unknown> | undefined>>
  broken: SkillLayer[]
} {
  const paths = skillSettingsPaths(cwd)
  const layers: Partial<Record<SkillLayer, Record<string, unknown> | undefined>> = {}
  const broken: SkillLayer[] = []
  for (const layer of ['user', 'project', 'local'] as SkillLayer[]) {
    const read = readSettingsFile(paths[layer])
    if (read.kind === 'unreadable') {
      broken.push(layer)
      continue
    }
    if (read.kind !== 'ok') continue
    const raw = read.value.skillOverrides
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      layers[layer] = raw as Record<string, unknown>
  }
  return { layers, broken }
}

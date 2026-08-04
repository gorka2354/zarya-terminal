import type { SkillState, SkillLayer } from './types'

/**
 * Скиллы: состояние, слои настроек и цена.
 *
 * Скилл — это папка с `SKILL.md`, которую агент подхватывает сам. Платить за
 * него приходится ВСЕГДА: имя и описание каждого скилла лежат в контексте
 * любого запроса, иначе агент не знал бы, что скилл существует. Тело грузится
 * только при вызове. Поэтому 83 скилла — это не «83 бесплатные возможности», а
 * постоянный оброк в несколько тысяч токенов, и человек имеет право видеть его
 * поимённо.
 *
 * Управление состоянием — не наша выдумка: Claude Code читает `skillOverrides`
 * из своих настроек. Мы туда пишем, но не притворяемся хозяином файла.
 */

/** Четыре состояния из `skillOverrides`. Пятого не изобретаем. */
export const SKILL_STATES: SkillState[] = ['on', 'name-only', 'user-invocable-only', 'off']

export function asSkillState(v: unknown): SkillState | undefined {
  return SKILL_STATES.includes(v as SkillState) ? (v as SkillState) : undefined
}

/**
 * Слои настроек Claude Code — в порядке силы, слабый первым.
 *
 * Порядок ровно такой, как у самого CLI: настройка проекта перебивает личную, а
 * локальная — обе. Знать это обязательно: Заря пишет в личный слой, и если
 * ключ перекрыт сверху, переключатель сработал бы «успешно» и ничего не изменил.
 * Такую кнопку показывать нельзя — вместо неё человек увидит, кто перебил.
 */
export const SKILL_LAYERS: SkillLayer[] = ['user', 'project', 'local']

export function layerLabel(layer: SkillLayer): string {
  return layer === 'user' ? 'личных настройках' : layer === 'project' ? 'настройках проекта' : 'локальных настройках проекта'
}

/** Эффективное состояние скилла и слой, который его задал. */
export function effectiveState(
  name: string,
  layers: Partial<Record<SkillLayer, Record<string, unknown> | undefined>>
): { state: SkillState; from?: SkillLayer } {
  let state: SkillState = 'on'
  let from: SkillLayer | undefined
  for (const layer of SKILL_LAYERS) {
    const v = asSkillState(layers[layer]?.[name])
    if (v) {
      state = v
      from = layer
    }
  }
  return from ? { state, from } : { state }
}

/**
 * Новый объект настроек с изменённым состоянием скилла.
 *
 * Чистая функция поверх РАЗОБРАННОГО json: главный процесс читает файл, зовёт
 * это, пишет обратно. Так правка чужого конфига проверяется юнит-тестом, а не
 * живым прогоном по файлу человека.
 *
 * `on` — это отсутствие ключа, а не значение `"on"`: возвращая скилл в обычное
 * состояние, мы обязаны убрать за собой след, иначе в чужом файле навсегда
 * останется мусор от Зари. По той же причине пустой `skillOverrides` удаляется.
 */
export function withSkillOverride(
  settings: Record<string, unknown>,
  name: string,
  state: SkillState
): Record<string, unknown> {
  const next = { ...settings }
  const src = next.skillOverrides
  const overrides: Record<string, unknown> =
    src && typeof src === 'object' && !Array.isArray(src) ? { ...(src as Record<string, unknown>) } : {}
  if (state === 'on') delete overrides[name]
  else overrides[name] = state
  if (Object.keys(overrides).length) next.skillOverrides = overrides
  else delete next.skillOverrides
  return next
}

/**
 * Плагинные скиллы `skillOverrides` не берёт — так устроен Claude Code.
 *
 * Показать им переключатель значило бы соврать: человек нажмёт, файл изменится,
 * скилл останется. Вместо кнопки такой строке полагается путь, который работает,
 * — команда `claude plugin`.
 */
export function isPluginSkill(source: string): boolean {
  return source === 'plugin' || source.startsWith('plugin')
}

/** Как назвать источник по-русски. Незнакомое имя показываем как есть. */
export function sourceLabel(source: string): string {
  const known: Record<string, string> = {
    'built-in': 'встроенный',
    builtin: 'встроенный',
    bundled: 'встроенный',
    plugin: 'плагин',
    userSettings: 'личный',
    user: 'личный',
    projectSettings: 'проектный',
    project: 'проектный',
    localSettings: 'локальный',
    local: 'локальный'
  }
  return known[source] ?? source
}

/** Имя плагина из имени скилла `плагин:скилл` — для команды отключения. */
export function pluginOf(name: string): string | undefined {
  const i = name.indexOf(':')
  return i > 0 ? name.slice(0, i) : undefined
}

/**
 * Команда, которой человек выключит плагин руками.
 *
 * Кавычки — по тому же правилу, что и у `claude mcp login`: имя с пробелом без
 * них развалится на два аргумента, и подсказка окажется той самой кнопкой,
 * которая соврала.
 */
export function pluginDisableCommand(plugin: string): string {
  const safe = /^[A-Za-z0-9._:-]+$/.test(plugin)
  return `claude plugin disable ${safe ? plugin : `"${plugin.replace(/(["\\$`])/g, '\\$1')}"`}`
}

/** Слова для состояний — в интерфейсе кодов быть не должно. */
export function stateLabel(state: SkillState): string {
  return state === 'on'
    ? 'в работе'
    : state === 'name-only'
      ? 'только имя'
      : state === 'user-invocable-only'
        ? 'только по «/»'
        : 'выключен'
}

/** Что это состояние значит — одной строкой, без жаргона. */
export function stateHint(state: SkillState): string {
  return state === 'on'
    ? 'агент видит имя и описание, берёт сам'
    : state === 'name-only'
      ? 'агент видит только имя — дешевле, но выбирает вслепую'
      : state === 'user-invocable-only'
        ? 'агент сам не возьмёт, вызовешь через «/»'
        : 'не виден никому'
}

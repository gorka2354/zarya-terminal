/**
 * Можно ли просить движок хранить копии файлов — и если нет, то почему.
 *
 * Отдельный модуль, потому что решение упирается в границу, которая у нас одна
 * и та же для всего приложения, и её легко не заметить: **копии лежат ВНЕ нашей
 * папки**. `ZARYA_USER_DATA` подменяет только `app.getPath('userData')`, а
 * `~/.claude/file-history` определяется движком от домашней папки. Значит
 * изолированный прогон QA, который во всём остальном не трогает настоящий
 * профиль, начал бы писать туда полные копии РЕАЛЬНЫХ файлов — это прямое
 * нарушение правила «прогоны не трогают настоящий профиль».
 *
 * Поэтому в изолированном запуске чекпоинты выключены, даже если настройка
 * включена. Прогон, которому они нужны по существу, обязан сначала увести
 * движок в свою папку (`CLAUDE_CONFIG_DIR`) и сказать об этом явно.
 */
export type CheckpointOff = 'setting' | 'qa-isolated'

export interface CheckpointPolicy {
  /** Просить ли движок снимать копии файлов. */
  on: boolean
  off?: CheckpointOff
}

export function checkpointPolicy(o: {
  /** Настройка приложения. */
  wanted: boolean
  /** Запуск с подменённым userData (QA-прогон, вторая копия приложения). */
  isolated: boolean
  /** Прогон увёл настройки движка в свою папку и осознанно просит чекпоинты. */
  configDirOverridden?: boolean
}): CheckpointPolicy {
  if (!o.wanted) return { on: false, off: 'setting' }
  if (o.isolated && !o.configDirOverridden) return { on: false, off: 'qa-isolated' }
  return { on: true }
}

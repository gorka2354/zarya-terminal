import { describe, expect, it } from 'vitest'
import { checkpointPolicy } from '@shared/checkpointPolicy'

/**
 * Копии файлов, которые движок снимает перед правками, лежат ВНЕ нашей папки:
 * ZARYA_USER_DATA подменяет только userData, а ~/.claude/file-history движок
 * определяет от домашней папки. Значит изолированный прогон, который во всём
 * остальном не касается настоящего профиля, писал бы туда полные копии РЕАЛЬНЫХ
 * файлов. Это правило — единственное, что стоит между прогоном и профилем
 * человека, поэтому оно проверяется отдельно.
 */
describe('checkpointPolicy', () => {
  it('настройка выключена — чекпоинтов нет ни при каких условиях', () => {
    expect(checkpointPolicy({ wanted: false, isolated: false })).toEqual({
      on: false,
      off: 'setting'
    })
  })

  it('обычный запуск с включённой настройкой — чекпоинты работают', () => {
    expect(checkpointPolicy({ wanted: true, isolated: false })).toEqual({ on: true })
  })

  it('изолированный прогон не пишет в настоящий профиль, даже когда настройка включена', () => {
    expect(checkpointPolicy({ wanted: true, isolated: true })).toEqual({
      on: false,
      off: 'qa-isolated'
    })
  })

  it('прогон, уведший настройки движка в свою папку, чекпоинты получает', () => {
    // Осознанное исключение для e2e самого отката: там копии нужны по существу,
    // и прогон обязан сначала увести движок в свою папку.
    expect(
      checkpointPolicy({ wanted: true, isolated: true, configDirOverridden: true })
    ).toEqual({ on: true })
  })
})

describe('checkpointPolicy — живой прогон', () => {
  it('изолированный прогон может ОСОЗНАННО попросить чекпоинты', () => {
    // Единственный случай: проверка на настоящем Claude Code. Увести
    // CLAUDE_CONFIG_DIR нельзя — вместе с настройками уедет авторизация, и
    // движок не запустится. Поэтому исключение явное и названное.
    expect(checkpointPolicy({ wanted: true, isolated: true, liveOverride: true })).toEqual({
      on: true
    })
  })

  it('без явной просьбы изоляция по-прежнему сильнее', () => {
    expect(checkpointPolicy({ wanted: true, isolated: true })).toEqual({
      on: false,
      off: 'qa-isolated'
    })
  })
})

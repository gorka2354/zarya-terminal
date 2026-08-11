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

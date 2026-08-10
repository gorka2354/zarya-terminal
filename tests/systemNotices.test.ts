/**
 * Служебные сообщения движка получают голос (inc-23).
 *
 * Формы сообщений взяты из типов SDK (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`),
 * а не придуманы: проверка стоит ровно на том, что движок действительно шлёт.
 */
import { describe, it, expect } from 'vitest'
import { isNoticeSubtype, noticeFor } from '../src/main/systemNotices'

describe('systemNotices', () => {
  it('повтор запроса называет код, попытку и задержку', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 4000,
      error_status: 503
    })
    expect(n?.level).toBe('warn')
    expect(n?.text).toMatch(/503/)
    expect(n?.text).toMatch(/2/)
    expect(n?.text).toMatch(/5/)
    expect(n?.text).toMatch(/4/)
  })

  it('обрыв связи без кода ответа объясняется без выдуманного нуля', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 900,
      error_status: null
    })
    // Ноль вместо кода — вранье: соединение оборвалось, HTTP-ответа не было вовсе.
    expect(n?.text).not.toMatch(/\b0\b/)
    // Меньше секунды округляем вверх: «через 0 с» читается как «уже сейчас».
    expect(n?.text).toMatch(/1/)
  })

  it('отказ без вопроса называет инструмент и причину', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu_1',
      decision_reason_type: 'rule'
    })
    expect(n?.level).toBe('warn')
    expect(n?.text).toMatch(/Bash/)
    // Причина объяснена словами интерфейса (язык словаря в тестах — английский),
    // а не подставлена служебным токеном `rule` как есть.
    expect(n?.text).toMatch(/a deny rule|запрещающее правило/)
    expect(n?.text).not.toMatch(/reason: rule/)
  })

  it('человеческое объяснение движка важнее разряда причины', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      decision_reason: 'rm -rf вне рабочей папки',
      decision_reason_type: 'rule'
    })
    expect(n?.text).toMatch(/rm -rf вне рабочей папки/)
  })

  it('управляющие последовательности в объяснении не доезжают до ленты', () => {
    // Типы SDK помечают decision_reason как «may carry ANSI escapes; sanitize
    // before rendering»: лента — это DOM, а не терминал.
    const esc = String.fromCharCode(27)
    const n = noticeFor({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      decision_reason: `${esc}[31mопасная команда${esc}[0m`
    })
    expect(n?.text).toMatch(/опасная команда/)
    expect(n?.text).not.toContain(esc)
    expect(n?.text).not.toContain('[31m')
  })

  it('причины нет — причину НЕ выдумываем', () => {
    const n = noticeFor({ type: 'system', subtype: 'permission_denied', tool_name: 'Write' })
    expect(n?.text).toMatch(/Write/)
    // Ключевое: не говорим «правило», когда движок правила не называл — иначе
    // человек идёт искать несуществующую строку в settings.json.
    expect(n?.text).not.toMatch(/deny rule|правило/)
  })

  it('незнакомый разряд причины не подставляется сырым токеном', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      decision_reason_type: 'somethingNew'
    })
    expect(n?.text).toMatch(/Edit/)
    expect(n?.text).not.toMatch(/somethingNew/)
  })

  it('ответ локальной команды показывается как есть', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'local_command_output',
      content: 'Сессия: 42 запроса за 5 часов'
    })
    expect(n?.level).toBe('info')
    expect(n?.text).toBe('Сессия: 42 запроса за 5 часов')
  })

  it('пустой ответ команды не рождает пустую строку в ленте', () => {
    expect(noticeFor({ type: 'system', subtype: 'local_command_output', content: '   ' })).toBeNull()
  })

  it('успешный хук молчит — их десятки за ход', () => {
    expect(
      noticeFor({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'format',
        hook_event: 'PostToolUse',
        outcome: 'success',
        exit_code: 0,
        output: '',
        stdout: '',
        stderr: ''
      })
    ).toBeNull()
  })

  it('упавший хук называет себя и последнюю строку ошибки', () => {
    const n = noticeFor({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'lint',
      hook_event: 'PostToolUse',
      outcome: 'error',
      exit_code: 1,
      stdout: '',
      stderr: 'warn: устарело\nerror: не найден конфиг'
    })
    expect(n?.level).toBe('warn')
    expect(n?.text).toMatch(/lint/)
    expect(n?.text).toMatch(/не найден конфиг/)
    // Именно ПОСЛЕДНЯЯ строка: в stderr обычно предупреждения, а причина внизу.
    expect(n?.text).not.toMatch(/устарело/)
  })

  it('молчаливый хук объясняется словами, а не голым кодом возврата', () => {
    const n = noticeFor({ type: 'system', subtype: 'hook_response', hook_name: 'guard', exit_code: 2 })
    expect(n?.text).toMatch(/guard/)
    // «Хук guard не отработал: 2» — не объяснение. Число должно стоять в фразе.
    expect(n?.text).toMatch(/code 2|кодом 2/)
  })

  it('остановленный хук не подставляет английский токен в фразу', () => {
    const n = noticeFor({ type: 'system', subtype: 'hook_response', hook_name: 'lint', outcome: 'cancelled' })
    expect(n?.text).toMatch(/lint/)
    expect(n?.text).not.toMatch(/: cancelled$/)
  })

  it('гашение воркера объясняет знакомую причину словами', () => {
    const n = noticeFor({ type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' })
    expect(n?.level).toBe('warn')
    // snake_case-токен хоста — не текст для человека.
    expect(n?.text).not.toMatch(/host_exit/)
    expect(n?.text).toMatch(/Claude Code/)
  })

  it('незнакомая причина гашения не тащит токен в конец фразы', () => {
    const n = noticeFor({ type: 'system', subtype: 'worker_shutting_down', reason: 'weird_new_reason' })
    expect(n?.text).toBeTruthy()
    expect(n?.text).not.toMatch(/weird_new_reason/)
  })

  it('гашение без причины всё равно предупреждает', () => {
    const n = noticeFor({ type: 'system', subtype: 'worker_shutting_down' })
    expect(n?.text).toBeTruthy()
  })

  it('чужие сабтайпы модуль не трогает', () => {
    expect(isNoticeSubtype('compact_boundary')).toBe(false)
    expect(isNoticeSubtype('init')).toBe(false)
    expect(noticeFor({ type: 'system', subtype: 'init' })).toBeNull()
    expect(noticeFor(null)).toBeNull()
  })

  it('свои — берёт все пять', () => {
    for (const s of [
      'api_retry',
      'permission_denied',
      'local_command_output',
      'hook_response',
      'worker_shutting_down'
    ])
      expect(isNoticeSubtype(s)).toBe(true)
  })
})

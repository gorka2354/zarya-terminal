/**
 * Служебные сообщения движка, которые обязаны дойти до человека словами.
 *
 * Claude Code рассказывает о себе куда больше, чем показывала лента: повтор
 * запроса после ошибки API, отказ инструменту по правилу, ответ локальной
 * слэш-команды, упавший хук, гашение рабочего процесса. Всё это приходило в
 * общий `switch` драйвера и проваливалось в пустой `break` — на экране оставалась
 * тишина, а тишина читается как «зависло».
 *
 * Разбор вынесен сюда отдельной чистой функцией, потому что проверять его внутри
 * живого стрима нечем: там нужен настоящий движок, настоящая сеть и настоящий
 * сбой. Здесь же — вход и выход, которые проверяются построчно.
 */
import { tm } from './lang'

export interface SystemNotice {
  level: 'info' | 'warn' | 'error'
  text: string
}

/** Сабтайпы, которые этот модуль берёт на себя. */
export const NOTICE_SUBTYPES = [
  'api_retry',
  'permission_denied',
  'local_command_output',
  'hook_response',
  'worker_shutting_down'
] as const

export function isNoticeSubtype(subtype: unknown): boolean {
  return NOTICE_SUBTYPES.includes(subtype as (typeof NOTICE_SUBTYPES)[number])
}

/**
 * Превратить системное сообщение SDK в строку для ленты.
 *
 * `null` — сказать нечего: успешный хук, пустой ответ команды. Молчание здесь
 * осознанное, а не забытое: хуков за ход десятки, и журнал из них вытеснил бы с
 * экрана всё остальное.
 */
export function noticeFor(msg: unknown): SystemNotice | null {
  const m = msg as Record<string, unknown>
  switch (m?.subtype) {
    case 'api_retry': {
      const attempt = num(m.attempt) ?? 1
      const max = num(m.max_retries) ?? 1
      const sec = Math.max(1, Math.round((num(m.retry_delay_ms) ?? 0) / 1000))
      const code = num(m.error_status)
      return {
        level: 'warn',
        text:
          code === undefined
            ? tm('drv.apiRetry', { attempt, max, sec })
            : tm('drv.apiRetryCode', { attempt, max, sec, code })
      }
    }
    case 'permission_denied': {
      const tool = str(m.tool_name) || '—'
      const why = denialReason(m)
      return {
        level: 'warn',
        // Причины может не быть вовсе (dontAsk, авто-отказ в фоне). Тогда — фраза
        // без хвоста: назвать причиной «правило», которого движок не называл,
        // значит отправить человека искать несуществующую строку в settings.json.
        text: why ? tm('drv.permDenied', { tool, why }) : tm('drv.permDeniedPlain', { tool })
      }
    }
    case 'local_command_output': {
      // Ответ команды — это содержимое, а не предупреждение: показываем как есть
      // и ничего к нему не приписываем.
      const text = str(m.content).trim()
      return text ? { level: 'info', text } : null
    }
    case 'hook_response': {
      const outcome = str(m.outcome)
      const exit = num(m.exit_code) ?? 0
      if (outcome !== 'error' && outcome !== 'cancelled' && !exit) return null
      const name = str(m.hook_name) || str(m.hook_event) || '—'
      // Слова хука — сначала его собственные (последняя строка обычно и есть
      // причина), потом stdout. Нет ни того ни другого — объясняем сами, а не
      // подставляем в русскую фразу английский токен outcome или голое число.
      const said = lastLine(str(m.stderr)) || lastLine(str(m.stdout))
      if (said) return { level: 'warn', text: tm('drv.hookFailed', { name, why: said }) }
      if (outcome === 'cancelled') return { level: 'warn', text: tm('drv.hookCancelled', { name }) }
      return { level: 'warn', text: tm('drv.hookExit', { name, code: exit || 1 }) }
    }
    case 'worker_shutting_down': {
      const why = str(m.reason).trim()
      const known = ['host_exit', 'remote_control_disabled']
      // Причина — snake_case-токен хоста, а не текст для человека. Знакомые
      // переводим, незнакомый показываем без хвоста: непонятное слово в конце
      // фразы объясняет не больше, чем его отсутствие.
      return {
        level: 'warn',
        text: known.includes(why) ? tm(`drv.workerDown.${why}`) : tm('drv.workerDown')
      }
    }
    default:
      return null
  }
}

/**
 * Причина отказа словами интерфейса — или пусто, если движок её не назвал.
 *
 * Порядок источников: сначала человекочитаемый `decision_reason` (движок пишет
 * туда объяснение для диалога), затем перевод служебного разряда
 * `decision_reason_type`. Оба могут отсутствовать — тогда пусто, и фраза
 * обойдётся без хвоста.
 */
function denialReason(m: Record<string, unknown>): string {
  const said = stripAnsi(str(m.decision_reason)).trim()
  if (said) return said
  const kind = str(m.decision_reason_type)
  // Полный перечень разрядов из sdk.d.ts. 'other' переводить нечего — движок сам
  // говорит «прочее», и повторять это отдельной фразой незачем.
  const known = [
    'rule',
    'mode',
    'subcommandResults',
    'permissionPromptTool',
    'hook',
    'asyncAgent',
    'sandboxOverride',
    'workingDir',
    'safetyCheck',
    'classifier'
  ]
  if (known.includes(kind)) return tm(`drv.deny.${kind}`)
  return ''
}

/** Последняя непустая строка — в выводе хука причина обычно внизу. */
function lastLine(text: string): string {
  const lines = stripAnsi(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/**
 * Снять управляющие последовательности.
 *
 * `decision_reason` в типах SDK прямо помечен как «may carry ANSI escapes;
 * sanitize before rendering»: лента — это DOM, а не терминал, и сырой escape
 * приехал бы в текст мусором вида `[31m`.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

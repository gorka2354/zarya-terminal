/**
 * Разговор, который можно унести: беседа → Markdown.
 *
 * Сохранить или скопировать беседу целиком было нельзя вовсе — только выделять
 * мышью через весь экран. При этом разговор с агентом сплошь и рядом и есть
 * результат работы: разбор задачи, объяснение, план.
 *
 * Формат — Markdown, потому что его читают и человек, и следующий агент.
 * Собираем ровно то, что было на экране: слова человека, ответы агента, вызовы
 * инструментов одной строкой и служебные отметки. Ничего не досочиняем — в
 * файле должно быть то же, что в ленте, иначе стенограмма врёт о разговоре.
 */
import type { AiMessage } from './types'

export interface TranscriptMeta {
  /** Заголовок беседы — обычно первый запрос человека. */
  title?: string
  engine?: string
  cwd?: string
  /** Когда сохранили; передаётся снаружи, чтобы функция осталась чистой. */
  at?: string
}

/** Строка вызова инструмента: имя и то, что человек видел в карточке. */
function toolLine(name: string, input: unknown): string {
  const o = (input ?? null) as Record<string, unknown> | null
  const first =
    (typeof o?.command === 'string' && o.command) ||
    (typeof o?.file_path === 'string' && o.file_path) ||
    (typeof o?.path === 'string' && o.path) ||
    (typeof o?.pattern === 'string' && o.pattern) ||
    (typeof o?.url === 'string' && o.url) ||
    ''
  const short = first.replace(/\s+/g, ' ').slice(0, 200)
  return short ? `\`${name}\`: ${short}` : `\`${name}\``
}

export function toMarkdown(messages: AiMessage[], meta: TranscriptMeta = {}): string {
  const out: string[] = []
  out.push(`# ${meta.title?.trim() || 'Разговор'}`)
  const head: string[] = []
  if (meta.engine) head.push(meta.engine)
  if (meta.cwd) head.push(meta.cwd)
  if (meta.at) head.push(meta.at)
  if (head.length) out.push('', `_${head.join(' · ')}_`)

  for (const m of messages) {
    const parts: string[] = []
    for (const p of m.content) {
      if (p.type === 'text' && p.text.trim()) parts.push(p.text.trim())
      else if (p.type === 'tool_use') parts.push(`→ ${toolLine(p.name, p.input)}`)
      else if (p.type === 'thinking')
        // Рассуждение — в свёрнутом виде: в стенограмме оно тоже не должно
        // вытеснять ответ, но и терять его нельзя.
        parts.push(`<details><summary>рассуждение агента</summary>

${p.text.trim()}

</details>`)
      else if (p.type === 'tool_result' && p.images)
        /*
         * Картинку в Markdown не унести: base64 скриншота раздул бы файл до
         * мегабайтов, а в самой беседе этих байтов уже нет — они живут только в
         * открытой ленте. Поэтому отметка: в стенограмме видно, что инструмент
         * вернул картинку, и видно, что её здесь не будет.
         *
         * Остальные итоги инструментов стенограмма по-прежнему не переносит —
         * это отдельный пробел inc-26, и закрывать его молча, заодно, значило бы
         * менять формат выгрузки под видом правки про картинки.
         */
        parts.push(`> _картинок от инструмента: ${p.images} (в файл не переносятся)_`)
      else if (p.type === 'notice') parts.push(`> ${p.text.trim()}`)
      /*
       * Записка соседней панели уходит в файл ПОМЕЧЕННОЙ. Без пометки она в
       * стенограмме читалась бы как слова агента или человека — та же подмена
       * авторства, что и на экране, только уже в файле, который человек кому-то
       * покажет.
       */
      else if (p.type === 'pane-note')
        parts.push(
          `> _записка от панели «${p.from}»${
            p.held ? `, придержана (${p.held === 'busy' ? 'панель занята' : 'автопилот'})` : ''
          }:_ ${p.text.trim()}`
        )
      /*
       * Хвост консоли — пометкой, а не полным выводом. Полный вывод раздул бы
       * файл чужими байтами, которых в самой беседе уже нет: на диске от хвоста
       * остаётся только список команд. А умолчать вовсе нельзя — стенограмма
       * тогда показала бы вопрос человека без того, что агент при этом читал,
       * и объяснить его ответ по такому файлу было бы невозможно.
       */
      else if (p.type === 'shell-tail')
        parts.push(
          `> _агент прочитал консоль: ${p.used
            .map((u) => `\`${u.command || '(команда неизвестна)'}\``)
            .join(', ')}${p.dropped ? `, не поместилось: ${p.dropped}` : ''}_`
        )
      else if (p.type === 'reset') parts.push('> _агент забыл разговор выше_')
      else if (p.type === 'compact') parts.push('> _контекст сжат_')
      else if (p.type === 'turn' && p.endReason) parts.push(`> _${p.endReason}_`)
    }
    const body = parts.join('\n\n').trim()
    if (!body) continue
    /*
     * Роль подписываем словом, а не цветом: в файле цвета нет, а понять, кто
     * говорит, надо с первого взгляда.
     *
     * Итоги инструментов приезжают сообщениями РОЛИ «user» — так устроен
     * протокол, — и отметка о картинке оказывалась под заголовком «Человек»,
     * будто её написал он. Сообщение, в котором нет ни одного слова человека,
     * подписываем третьим словом: это и не он, и не агент, а инструмент.
     */
    const fromTool =
      m.role === 'user' && m.content.length > 0 && m.content.every((p) => p.type === 'tool_result')
    /*
     * Записка соседней панели живёт в ходе роли `user` — так её видит модель. В
     * файле она поэтому оказывалась под заголовком «Человек», то есть выдавала
     * чужие слова за его собственные. То же враньё об авторстве, что и на
     * экране, только в файле, который он кому-то покажет.
     */
    const fromPane = m.content.some((p) => p.type === 'pane-note')
    out.push(
      '',
      fromTool
        ? '## Инструмент'
        : fromPane
          ? '## Соседняя панель'
          : m.role === 'user'
            ? '## Человек'
            : '## Агент',
      '',
      body
    )
  }
  return out.join('\n').trim() + '\n'
}

/** Имя файла по умолчанию: короткое, из заголовка, без запрещённых знаков. */
export function transcriptFileName(title: string | undefined, stamp: string): string {
  const base = (title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
  return `${base || 'разговор'} — ${stamp}.md`
}

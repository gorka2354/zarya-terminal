import { z } from 'zod'
import { paneRegistry } from './paneRegistry'

/**
 * Два инструмента, которыми агент видит соседние панели и пишет им.
 *
 * ЖИВУТ ВНУТРИ НАШЕГО ПРОЦЕССА. SDK умеет MCP-сервер без сети и без
 * подпроцесса (`createSdkMcpServer`), а значит обработчик — обычная функция
 * главного процесса, у которой есть доступ к реестру панелей. Ни сокетов, ни
 * файлов регистрации, ни токенов: всё, на что у Claude Code уходит половина
 * его документации про messaging, здесь не нужно вовсе, потому что панели —
 * это один процесс.
 *
 * ОПИСАНИЯ ПО-АНГЛИЙСКИ. Это не интерфейс, а данные для модели, как и системный
 * промпт: движок разговаривает с собой по-английски.
 *
 * СЕРВЕР СОЗДАЁТСЯ НА КАЖДУЮ СЕССИЮ, а не один на приложение: обработчику надо
 * знать, КТО пишет, и единственный надёжный способ — замкнуть отправителя при
 * создании. Из аргументов инструмента это брать нельзя: агент назвал бы там что
 * угодно, и одна панель писала бы от имени другой.
 */

/** Минимальная часть SDK, которая нам тут нужна. Полный тип грузится динамически. */
interface SdkToolApi {
  createSdkMcpServer: (o: { name: string; tools: unknown[] }) => unknown
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: never, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>
  ) => unknown
}

const say = (text: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text }]
})

/**
 * Сервер инструментов для ОДНОЙ беседы.
 *
 * @param sdk загруженный модуль SDK
 * @param fromConvId кто отправитель — замыкается здесь и не берётся из аргументов
 */
export function paneToolServer(sdk: SdkToolApi, fromConvId: string): unknown {
  return sdk.createSdkMcpServer({
    name: 'zarya',
    tools: [
      sdk.tool(
        'list_panes',
        'List the other Zarya panes open on this machine right now: name, working ' +
          'folder, engine, whether it is busy and what it is doing at this moment. ' +
          'Use it when a question belongs to another project or another part of the ' +
          'work — a pane whose folder matches is usually the one that knows. ' +
          'Returns no conversation history and no files: only what a person can see ' +
          'on that pane right now.',
        {},
        async () => {
          const panes = paneRegistry.list(fromConvId)
          if (!panes.length) return say('No other panes are open right now.')
          return say(
            panes
              .map(
                (p) =>
                  `- ${p.title} (id=${p.convId}) — folder: ${p.cwd ?? 'unknown'}; engine: ${p.engine}; ${p.busy ? 'busy' : 'idle'}${p.doing ? `; doing: ${p.doing}` : ''}`
              )
              .join('\n')
          )
        }
      ),
      sdk.tool(
        'send_to_pane',
        'Deliver a short plain-text note to another Zarya pane on this machine — ' +
          'a finding, a status, a question, or an answer that pane is blocked on. ' +
          'The note arrives in that conversation labelled as coming from another ' +
          'pane, never as the person speaking. It cannot approve permissions, ' +
          'change settings, or run commands there: slash commands arrive as plain ' +
          'text, and anything that pane then does still passes its own gate. ' +
          'You may ASK another pane and wait for its note back — say plainly that ' +
          "you expect a reply. When a question is outside this pane's folder or " +
          'subject, prefer telling the person which pane knows and offering to ask ' +
          'it, rather than guessing. Keep it to a couple of sentences: this is a ' +
          'note, not a transfer of context.',
        {
          pane: z
            .string()
            .describe('Target pane: its exact name, or the id from list_panes when names repeat.'),
          text: z.string().describe('The note itself, plain text, a couple of sentences.')
        },
        async (args: never) => {
          const a = args as unknown as { pane?: string; text?: string }
          const res = await paneRegistry.send(
            fromConvId,
            String(a.pane ?? ''),
            String(a.text ?? '')
          )
          return say(res.message)
        }
      )
    ]
  })
}

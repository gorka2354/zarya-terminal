import { tm } from './lang'
import { parseModelList } from '@shared/modelCatalog'
import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type { AiChatRequest, AiMessage, AiProviderKind, AiStreamEvent } from '@shared/types'
import { OLLAMA_DEFAULT_URL } from '@shared/defaults'

/** Версия протокола Anthropic — та же, что в chatAnthropic. */
const ANTHROPIC_VERSION = '2023-06-01'
/**
 * Официальные адреса каталогов. Обратите внимание: у Anthropic путь версии
 * входит в адрес, а у OpenAI — уже в базовом URL, поэтому дальше к базе
 * дописывается только `/models`, иначе получится `/v1/v1/models`.
 */
const CATALOG_BASE: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1'
}

/**
 * AI transport living in the main process so API keys never enter the renderer.
 * Normalizes Anthropic / OpenAI / Ollama streams into AiStreamEvent.
 */
export class AiProxy {
  private aborts = new Map<string, AbortController>()
  private getWindow: () => BrowserWindow | null

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow
  }

  private emit(requestId: string, ev: AiStreamEvent): void {
    this.getWindow()?.webContents.send(CH.aiStream, requestId, ev)
  }

  abort(requestId: string): void {
    this.aborts.get(requestId)?.abort()
    this.aborts.delete(requestId)
  }

  async chat(requestId: string, req: AiChatRequest, apiKey: string | undefined): Promise<void> {
    const ctrl = new AbortController()
    this.aborts.set(requestId, ctrl)
    this.emit(requestId, { type: 'start' })
    try {
      if (req.provider === 'anthropic') {
        await this.chatAnthropic(requestId, req, apiKey, ctrl.signal)
      } else {
        await this.chatOpenAiCompatible(requestId, req, apiKey, ctrl.signal)
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        this.emit(requestId, { type: 'done', stopReason: 'aborted' })
      } else {
        this.emit(requestId, {
          type: 'error',
          message: e instanceof Error ? e.message : String(e)
        })
      }
    } finally {
      this.aborts.delete(requestId)
    }
  }

  // ------------------------------------------------------------------ Anthropic

  private async chatAnthropic(
    requestId: string,
    req: AiChatRequest,
    apiKey: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    if (!apiKey) throw new Error(tm('main.err.noAnthropicKey'))
    const base = req.baseUrl?.trim() || 'https://api.anthropic.com'
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      system: req.system || undefined,
      stream: true,
      messages: flattenForProvider(req.messages).map((m) => ({
        role: m.role,
        content: m.content.map((p) => {
          if (p.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: p.toolUseId,
              content: p.content,
              is_error: p.isError ?? false
            }
          }
          return p
        })
      })),
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      }))
    }

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`)
    }

    let stopReason: string | undefined
    let toolBlock: { id: string; name: string; json: string } | null = null

    for await (const data of sseData(res.body, signal)) {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      const type = ev.type as string
      if (type === 'content_block_start') {
        const cb = ev.content_block as { type: string; id?: string; name?: string }
        if (cb?.type === 'tool_use') {
          toolBlock = { id: cb.id ?? '', name: cb.name ?? '', json: '' }
        }
      } else if (type === 'content_block_delta') {
        const delta = ev.delta as { type: string; text?: string; partial_json?: string }
        if (delta?.type === 'text_delta' && delta.text) {
          this.emit(requestId, { type: 'text', text: delta.text })
        } else if (delta?.type === 'input_json_delta' && toolBlock) {
          toolBlock.json += delta.partial_json ?? ''
        }
      } else if (type === 'content_block_stop') {
        if (toolBlock) {
          let input: unknown = {}
          try {
            input = toolBlock.json ? JSON.parse(toolBlock.json) : {}
          } catch {
            input = { _raw: toolBlock.json }
          }
          this.emit(requestId, { type: 'tool_use', id: toolBlock.id, name: toolBlock.name, input })
          toolBlock = null
        }
      } else if (type === 'message_delta') {
        const d = ev.delta as { stop_reason?: string }
        if (d?.stop_reason) stopReason = d.stop_reason
      } else if (type === 'error') {
        const err = ev.error as { message?: string }
        throw new Error(err?.message ?? 'Anthropic stream error')
      }
    }
    this.emit(requestId, { type: 'done', stopReason })
  }

  // ------------------------------------------------- OpenAI / Ollama / compat

  private async chatOpenAiCompatible(
    requestId: string,
    req: AiChatRequest,
    apiKey: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    let base: string
    if (req.provider === 'openai') {
      base = req.baseUrl?.trim() || 'https://api.openai.com/v1'
      if (!apiKey) throw new Error(tm('main.err.noOpenaiKey'))
    } else if (req.provider === 'ollama') {
      base = (req.baseUrl?.trim() || OLLAMA_DEFAULT_URL).replace(/\/$/, '') + '/v1'
    } else {
      if (!req.baseUrl?.trim()) throw new Error(tm('main.err.noBaseUrl'))
      base = req.baseUrl.trim().replace(/\/$/, '')
    }

    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      temperature: req.temperature,
      messages: toOpenAiMessages(req.system, req.messages)
    }
    if (req.provider !== 'openai' && req.maxTokens) body.max_tokens = req.maxTokens
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }))
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body)
    })
    if (!res.ok || !res.body) {
      throw new Error(`AI API ${res.status}: ${(await res.text()).slice(0, 400)}`)
    }

    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: string | undefined

    for await (const data of sseData(res.body, signal)) {
      if (data === '[DONE]') break
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      const choice = (ev.choices as Array<Record<string, unknown>>)?.[0]
      if (!choice) continue
      const delta = choice.delta as
        | {
            content?: string
            tool_calls?: Array<{
              index: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        | undefined
      if (delta?.content) {
        this.emit(requestId, { type: 'text', text: delta.content })
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        toolCalls.set(tc.index, cur)
      }
      if (choice.finish_reason) stopReason = choice.finish_reason as string
    }

    for (const tc of toolCalls.values()) {
      let input: unknown = {}
      try {
        input = tc.args ? JSON.parse(tc.args) : {}
      } catch {
        input = { _raw: tc.args }
      }
      this.emit(requestId, {
        type: 'tool_use',
        id: tc.id || `call_${Date.now()}`,
        name: tc.name,
        input
      })
    }
    this.emit(requestId, {
      type: 'done',
      stopReason: stopReason === 'tool_calls' ? 'tool_use' : stopReason
    })
  }

  /**
   * Каталог моделей у провайдера.
   *
   * Список моделей раньше был константой в коде и устаревал молча: вышел
   * Opus 5, а человек по-прежнему выбирал из Opus 4.8. У всех провайдеров есть
   * эндпоинт со списком — спрашиваем их, а не свою память.
   *
   * SECURITY: запрос делает главный процесс, потому что несёт ключ. baseUrl
   * приходит уже проверенным (см. ipc): renderer не может назвать чужой хост
   * провайдеру, у которого есть сохранённый ключ, — иначе ключ уедет туда.
   */
  async listProviderModels(
    provider: AiProviderKind,
    baseUrl: string | undefined,
    apiKey: string | undefined
  ): Promise<string[]> {
    if (provider === 'ollama') return this.listOllamaModels(baseUrl ?? '')
    const base = (baseUrl?.trim() || CATALOG_BASE[provider] || '').replace(/\/$/, '')
    if (!base) throw new Error(tm('main.err.noBaseUrl'))
    if (!apiKey) {
      throw new Error(
        tm(provider === 'anthropic' ? 'main.err.noAnthropicKey' : 'main.err.noOpenaiKey')
      )
    }
    const headers: Record<string, string> =
      provider === 'anthropic'
        ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
        : { authorization: `Bearer ${apiKey}` }
    const res = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`${provider} ${res.status}`)
    return parseModelList(await res.json())
  }

  async listOllamaModels(baseUrl: string): Promise<string[]> {
    const base = (baseUrl?.trim() || OLLAMA_DEFAULT_URL).replace(/\/$/, '')
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`Ollama ${res.status}`)
    const json = (await res.json()) as { models?: Array<{ name: string }> }
    return (json.models ?? []).map((m) => m.name)
  }
}

/**
 * Записка соседней панели — НАШ вид части, и наружу он ехать не должен.
 *
 * Anthropic на неизвестный блок отвечает 400, и сообщение остаётся в истории:
 * беседа ломается НАВСЕГДА, каждый следующий ход упирается в ту же ошибку. У
 * OpenAI и Ollama мягче и хуже: часть просто отфильтровывается, текст записки
 * пропадает, и модель отвечает на то, чего не видела.
 *
 * Поэтому на границе с провайдером записка становится обычным текстом с
 * пометкой — той же, что уходит движкам агентов. Пометка обязательна: без неё
 * модель прочитает чужую записку как слова человека.
 */
export function flattenForProvider(messages: AiMessage[]): AiMessage[] {
  /*
   * ХВОСТ КОНСОЛИ ЖИВЁТ ОДИН ХОД.
   *
   * Здесь, в отличие от движков агентов, история уезжает провайдеру ЦЕЛИКОМ
   * каждым запросом. Оставь мы хвост в старых сообщениях — десятый ход тащил бы
   * десять снимков консоли, девять из которых давно неверны, и человек платил
   * бы за них в каждом запросе до конца разговора.
   *
   * Поэтому хвост остаётся только у ПОСЛЕДНЕГО хода человека, из прежних
   * выбрасывается. Это не потеря смысла: агент уже прочитал их тогда, когда они
   * были правдой, и его ответы на них в истории остались.
   */
  /*
   * Ищем ПОСЛЕДНЕЕ СООБЩЕНИЕ С ХВОСТОМ, а не последний ход роли `user`.
   *
   * Ревью поймало здесь дефект: итог инструмента приезжает сообщением той же
   * роли `user` (так устроен протокол), и внутри агентского цикла «последним
   * user» оказывался он. Хвост настоящего хода человека выбрасывался со
   * второго запроса того же хода — то есть ровно там, где агент выполняет
   * команды и вывод консоли нужен ему больше всего.
   *
   * По самой части считать надёжнее: она есть только у ходов, которые человек
   * отправил сам, и никакое служебное сообщение её не подделает.
   */
  const lastTailAt = messages.reduce(
    (at, m, i) => (m.content.some((p) => p.type === 'shell-tail' && p.text) ? i : at),
    -1
  )
  return messages.map((m, i) => {
    const content = m.content
      /*
       * Хвост остаётся только у последнего хода. Пустой текст — ход, поднятый
       * с диска: там от хвоста остался только список команд для плашки (см.
       * `stripTailText` в aiStore), отправлять нечего.
       *
       * Сообщение из ОДНОГО хвоста этим не осиротить: `send` не пускает
       * отправку без слов, картинки или контекста, так что рядом всегда есть
       * другая часть. Инвариант закреплён тестом — пустой `content` провайдер
       * встречает четырёхсотой ошибкой, и разговор встаёт навсегда.
       */
      .filter((p) => p.type !== 'shell-tail' || (i === lastTailAt && !!p.text))
      .map((p) =>
        p.type === 'pane-note'
          ? ({ type: 'text', text: `[note from pane "${p.from}"] ${p.text}` } as const)
          : p.type === 'shell-tail'
            ? ({ type: 'text', text: p.text } as const)
            : p
      )
    return { ...m, content }
  })
}

/** Convert internal messages to OpenAI chat format (tool calls included). */
function toOpenAiMessages(system: string | undefined, messages: AiMessage[]): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of flattenForProvider(messages)) {
    const texts = m.content.filter((p) => p.type === 'text')
    const toolUses = m.content.filter((p) => p.type === 'tool_use')
    const toolResults = m.content.filter((p) => p.type === 'tool_result')

    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: texts.map((t) => t.text).join('') || null
      }
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) }
        }))
      }
      out.push(msg)
    } else {
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.toolUseId, content: tr.content })
      }
      const text = texts.map((t) => t.text).join('')
      if (text) out.push({ role: 'user', content: text })
    }
  }
  return out
}

/** Async iterator over `data:` payloads of an SSE stream. */
async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.startsWith('data:')) {
          yield line.slice(5).trim()
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

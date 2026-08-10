import { appendFileSync } from 'fs'
import { type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import { noticeFor } from './systemNotices'
import { endReasonText } from './turnOutcome'
import type {
  AgentCapabilities,
  AgentEngine,
  AgentPermissionDecision,
  AgentQuestionAnswer,
  AgentRewind,
  AgentStreamEvent,
  AgentStartOpts
} from '@shared/types'
import { rewindPoint } from '@shared/rewind'
import type { AgentDriver } from './agentDriver'
import { irreversible } from '@shared/irreversible'

/**
 * A scripted in-process AgentDriver for QA (Ф5). It emits the same
 * {@link AgentStreamEvent}s a real driver would, on a timer so turns "stream",
 * with a CONFIGURABLE {@link AgentCapabilities} profile. This lets the harness
 * prove the whole abstraction (registry routing, per-engine event delivery,
 * capability-gated UI, concurrent turns in one terminal, quit teardown) against
 * engines OTHER than Claude — catching any claude-specific assumption the
 * real-driver paritet tests can't. Registered only when ZARYA_FAKE_AGENT is set.
 */
export class FakeAgentDriver implements AgentDriver {
  readonly engine: AgentEngine
  readonly capabilities: AgentCapabilities
  private getWindow: () => BrowserWindow | null
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  private started = new Set<string>()
  /**
   * Состояние «сессии» — ровно то, что нужно отмотке: чем сессия себя назвала,
   * что последним сказал агент и от какой точки эта ветка началась. Живёт между
   * ходами, как у настоящего драйвера (ключ — requestId, он же id беседы).
   */
  /** Запросы, чей инструмент должен работать долго (прогон смотрит на «выполняется»). */
  private slowTools = new Set<string>()
  /** Режим разрешений, установленный на ходу. Прогон читает его через debugFlags. */
  private modes = new Map<string, 'plan' | 'default'>()
  private sessions = new Map<
    string,
    {
      sessionId: string
      lastAssistantUuid?: string
      forkBase?: { sessionId: string; at: string }
      resumed: boolean
    }
  >()
  private seq = 0

  constructor(
    engine: AgentEngine,
    capabilities: AgentCapabilities,
    getWindow: () => BrowserWindow | null
  ) {
    this.engine = engine
    this.capabilities = capabilities
    this.getWindow = getWindow
  }

  private emit(requestId: string, ev: AgentStreamEvent): void {
    this.getWindow()?.webContents.send(CH.agentStream, requestId, this.engine, ev)
  }

  private schedule(requestId: string, ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms)
    const list = this.timers.get(requestId) ?? []
    list.push(t)
    this.timers.set(requestId, list)
  }

  async start(requestId: string, opts: AgentStartOpts): Promise<void> {
    this.started.add(requestId)
    // Что драйвер получил на входе — для проверки отмотки: тест обязан видеть,
    // с каким resume/resumeAt ушёл СЛЕДУЮЩИЙ ход, иначе «сообщение пропало из
    // контекста» останется словами.
    const log = process.env.ZARYA_FAKE_START_LOG
    if (log) {
      try {
        appendFileSync(
          log,
          JSON.stringify({
            engine: this.engine,
            requestId,
            prompt: opts.prompt,
            resume: opts.resume ?? null,
            resumeAt: opts.resumeAt ?? null,
            // С каким режимом и автопилотом ушёл ход. Проверять это на экране
            // нельзя: чип показывает НАМЕРЕНИЕ, а спор идёт о том, что и правда
            // уехало драйверу — единственное, что определяет поведение агента.
            permissionMode: opts.permissionMode ?? null,
            bypass: opts.bypass === true
          }) + '\n'
        )
      } catch {
        /* best-effort */
      }
    }
    // Ветка (или первый запуск) — новая сессия со своим id; продолжение живой
    // сессии оставляет прежний.
    const prev = this.sessions.get(requestId)
    const session =
      prev && !opts.resumeAt
        ? prev
        : {
            sessionId: `fake-${this.engine}-${++this.seq}`,
            resumed: !!opts.resume,
            ...(opts.resume && opts.resumeAt
              ? { forkBase: { sessionId: opts.resume, at: opts.resumeAt } }
              : {})
          }
    // Папка беседы: по ней прогон проверяет, что команды и перечитывание
    // приходят от СВОЕЙ панели, а наблюдатель смотрит в её проект.
    this.cwds.set(requestId, opts.cwd ?? '')
    this.sessions.set(requestId, session)
    // init immediately (like a real driver's system:init).
    this.emit(requestId, {
      type: 'init',
      sessionId: session.sessionId,
      model: `${this.engine}-model`,
      cwd: opts.cwd ?? '',
      permissionMode: opts.permissionMode ?? 'default',
      tools: [],
      effort: opts.effort
    })
    if (this.capabilities.usage)
      this.emit(requestId, { type: 'usage', usage: { subscriptionType: 'fake', fiveHourPct: 10 } })
    if (this.capabilities.models)
      this.emit(requestId, {
        type: 'models',
        models: [{ value: `${this.engine}-a`, displayName: `${this.engine} A` }]
      })
    // Stream an assistant reply so the turn takes real wall-clock time. «mute:»
    // — ход, в котором агент НИЧЕГО не говорит: только в таком окне отмена
    // отправленного и имеет смысл, а иначе тест гонялся бы с таймером.
    const mute = /mute/i.test(opts.prompt)
    // Оборванный ход обязан быть НЕМЫМ: весь смысл строки движка в том, что
    // ответа не будет вовсе. Скажи фейк хоть слово — прогон проверял бы не то.
    // Печать говорит сама за себя и шлёт своё сообщение в конце: лишнее здесь
    // сделало бы в беседе два ответа вместо одного и спрятало бы главное —
    // что куски печати в историю НЕ ложатся.
    const silent = mute || /оборв|abort|печат|typing/i.test(opts.prompt)
    if (!silent)
      this.schedule(requestId, 250, () => {
        session.lastAssistantUuid = `fake-uuid-${++this.seq}`
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: `fake ${this.engine}: ${opts.prompt}` }]
        })
      })
    if (mute) {
      this.schedule(requestId, 8000, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    } else if (/подписи|labels/i.test(opts.prompt)) {
      /*
       * Инструменты, которые раньше выпадали в голое имя. Нужны прогону, чтобы
       * подписи проверялись НА ЭКРАНЕ, а не только юнитом: между toolLabel и
       * карточкой лежит вся лента, и связь могла потеряться там.
       */
      this.schedule(requestId, 350, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: `${requestId}-l1`, name: 'WebSearch', input: { query: 'kimi cli acp' } },
            {
              type: 'tool_use',
              id: `${requestId}-l2`,
              name: 'Grep',
              input: { pattern: 'launchPadOpen', path: 'C:/p/src', output_mode: 'files_with_matches' }
            },
            {
              type: 'tool_use',
              id: `${requestId}-l3`,
              name: 'SendUserFile',
              input: { files: ['C:/p/shots/hero.png'] }
            }
          ]
        })
        for (const [i, out] of ['нашлось 4', 'совпадений: 12', 'файл отправлен'].entries()) {
          this.emit(requestId, {
            type: 'tool_result',
            toolUseId: `${requestId}-l${i + 1}`,
            content: out,
            isError: false
          })
        }
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/выход из плана|exitplan/i.test(opts.prompt)) {
      /*
       * Выход из режима плана. У настоящего движка вход этого вызова ПУСТ:
       * план лежит в его файле, а сюда приходит голый объект. Фейк повторяет
       * это дословно — иначе прогон проверял бы подпись, которой в жизни нет.
       */
      this.schedule(requestId, 400, () =>
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-plan`,
          toolName: 'ExitPlanMode',
          input: {}
        })
      )
    } else if (/plan|план/i.test(opts.prompt)) {
      /*
       * План агента. Настоящий движок ведёт его обычными вызовами инструментов,
       * и номер задачи называет ТОЛЬКО в тексте результата — «Task #1 created
       * successfully: …». Фейк повторяет это дословно, иначе прогон проверял бы
       * не тот путь: связать TaskUpdate с задачей можно лишь по этому номеру.
       */
      const plan = [
        { subject: 'Прочитать конфиг', activeForm: 'Читаю конфиг' },
        { subject: 'Переписать разбор', activeForm: 'Переписываю разбор' },
        { subject: 'Прогнать тесты', activeForm: 'Гоняю тесты' }
      ]
      let at = 300
      plan.forEach((task, i) => {
        const id = `${requestId}-tc${i}`
        this.schedule(requestId, at, () => {
          this.emit(requestId, {
            type: 'assistant',
            content: [{ type: 'tool_use', id, name: 'TaskCreate', input: task }]
          })
          this.emit(requestId, {
            type: 'tool_result',
            toolUseId: id,
            content: `Task #${i + 1} created successfully: ${task.subject}`,
            isError: false
          })
        })
        at += 200
      })
      // Первая задача пошла в работу, вторая успела закрыться — так на экране
      // видны СРАЗУ три состояния, а не одно.
      this.schedule(requestId, at + 200, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${requestId}-tu1`,
              name: 'TaskUpdate',
              input: { taskId: '1', status: 'completed' }
            },
            {
              type: 'tool_use',
              id: `${requestId}-tu2`,
              name: 'TaskUpdate',
              input: { taskId: '2', status: 'in_progress' }
            }
          ]
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.02 })
      })
    } else if (/забудь|reset|clear/i.test(opts.prompt)) {
      /*
       * Движок начал беседу заново — так бывает от `/clear`, от выхода из
       * режима плана и при новой сессии. Раньше Заря об этом не знала и
       * продолжала показывать ленту, которой агент уже не помнит.
       */
      this.schedule(requestId, 400, () => {
        this.emit(requestId, { type: 'reset', sessionId: `fake-${this.engine}-${++this.seq}` })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0 })
      })
    } else if (/останов|stop/i.test(opts.prompt)) {
      /*
       * Три задачи, которые сами НЕ кончаются. Нужны ровно затем, чтобы
       * остановку проверить начисто: в волне с расписанием исходов не отличить
       * «остановили одну» от «остальные успели доработать сами».
       */
      this.schedule(requestId, 300, () => {
        for (const id of ['s1', 's2', 's3']) {
          this.emit(requestId, {
            type: 'subagent',
            taskId: id,
            phase: 'started',
            description: `задача ${id}`,
            subagentType: 'general-purpose',
            taskType: 'local_agent'
          })
        }
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/волн|wave/i.test(opts.prompt)) {
      /*
       * Волна задач с РАЗНЫМ исходом. Ровно то, чего фейк раньше не умел, а
       * значит и на экране не проверялось: успешная, упавшая, остановленная и
       * воркфлоу. До этой правки все четыре получили бы один зелёный чек, а
       * воркфлоу не показался бы вовсе — его глушил белый список драйвера.
       */
      const wave = [
        { id: 'w1', what: 'считает файлы', kind: 'local_agent' as const },
        { id: 'w2', what: 'читает версию', kind: 'local_agent' as const },
        { id: 'w3', what: 'ищет по коду', kind: 'local_agent' as const },
        { id: 'w4', what: 'ревью ветки', kind: 'local_workflow' as const, name: 'review-changes' }
      ]
      this.schedule(requestId, 300, () => {
        for (const w of wave) {
          this.emit(requestId, {
            type: 'subagent',
            taskId: w.id,
            phase: 'started',
            description: w.what,
            subagentType: w.kind === 'local_agent' ? 'general-purpose' : undefined,
            taskType: w.kind,
            workflowName: 'name' in w ? w.name : undefined
          })
        }
      })
      this.schedule(requestId, 900, () => {
        for (const w of wave) {
          this.emit(requestId, {
            type: 'subagent',
            taskId: w.id,
            phase: 'progress',
            totalTokens: 31_899,
            toolUses: 4,
            durationMs: 3440,
            lastTool: 'Grep'
          })
        }
        // Одна уходит в фон: ход идёт дальше, а она остаётся работать.
        this.emit(requestId, {
          type: 'subagent',
          taskId: 'w3',
          phase: 'progress',
          backgrounded: true
        })
      })
      this.schedule(requestId, 1700, () => {
        this.emit(requestId, { type: 'subagent', taskId: 'w1', phase: 'done', status: 'completed' })
        this.emit(requestId, {
          type: 'subagent',
          taskId: 'w2',
          phase: 'done',
          status: 'failed',
          summary: 'не нашёл package.json'
        })
        this.emit(requestId, { type: 'subagent', taskId: 'w4', phase: 'done', status: 'stopped' })
        // Последним — событие БЕЗ исхода: если оно затрёт статус, неудача тихо
        // станет успехом. Здесь это и проверяется.
        this.emit(requestId, { type: 'subagent', taskId: 'w2', phase: 'done' })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.05 })
      })
      // Ушедшая в фон досчитывает ПОСЛЕ конца хода — так и бывает: ход кончился,
      // а задача осталась. Пока она идёт, у волны законная крутилка; знак
      // неудачи встаёт только когда доработали все.
      this.schedule(requestId, 2900, () =>
        this.emit(requestId, { type: 'subagent', taskId: 'w3', phase: 'done', status: 'completed' })
      )
    } else if (/печат|typing/i.test(opts.prompt)) {
      /*
       * Ответ, который печатается на глазах. Куски идут отдельными событиями и
       * в историю НЕ попадают: настоящим текстом становится целое сообщение,
       * которое приходит в конце. Прогон проверяет обе половины — что печать
       * видна и что в беседе осталось ровно одно сообщение, а не два.
       */
      // Текста нарочно много: он обязан ПЕРЕПОЛНИТЬ ленту. На коротком ответе
      // проверка «лента следует за печатью» проходила бы и без слежения — то
      // есть не проверяла бы ничего.
      const parts = [
        'Смотрю, ',
        // Объём — в ПЕРВЫХ кусках: лента должна переполниться уже к середине
        // потока, иначе прогон проверял бы слежение на тексте, который и так
        // весь помещается на экране.
        'что тут происходит: файл на месте, конфиг читается, зависимости встали. ' +
          'Дальше по порядку — сборка, типы, юниты. '.repeat(40),
        'Ничего из этого не падает, и это хорошо. '.repeat(40),
        'Осталось прогнать ленту и посмотреть глазами. '.repeat(40),
        'тест зелёный.'
      ]
      parts.forEach((chunk, i) => {
        this.schedule(requestId, 300 + i * 260, () =>
          this.emit(requestId, { type: 'text_delta', text: chunk })
        )
      })
      this.schedule(requestId, 300 + parts.length * 260 + 400, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: parts.join('') }]
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/вывод|output/i.test(opts.prompt)) {
      /*
       * Длинный вывод инструмента. Ровно тот случай, ради которого раскрытие и
       * делалось: первая строка («Test Files 2 failed») говорит, ЧТО не так, а
       * какие именно тесты упали — только в хвосте. Раньше хвост оставался
       * внутри агента, и узнать его можно было, лишь спросив его ещё раз.
       */
      this.schedule(requestId, 400, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${requestId}-o1`,
              name: 'Bash',
              input: { command: 'npm test' }
            }
          ]
        })
        this.emit(requestId, {
          type: 'tool_result',
          toolUseId: `${requestId}-o1`,
          content: [
            'Test Files  2 failed | 41 passed (43)',
            '',
            'FAIL  tests/gates.test.ts > подпись поиска',
            '  ожидалось «kimi cli acp», получено «WebSearch»',
            'FAIL  tests/agentPlan.test.ts > порядок задач',
            '  ожидалось [1,2,3], получено [2,1,3]',
            '',
            'Duration  4.21s'
          ].join('\n'),
          isError: false
        })
        // Короткий вывод рядом: у него раскрывать нечего, и кнопки быть не
        // должно. Обещание продолжения там, где продолжения нет, — та же ложь.
        this.emit(requestId, {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${requestId}-o2`,
              name: 'Bash',
              input: { command: 'git rev-parse --short HEAD' }
            }
          ]
        })
        this.emit(requestId, {
          type: 'tool_result',
          toolUseId: `${requestId}-o2`,
          content: 'fc5d8d8',
          isError: false
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/сжат|compact/i.test(opts.prompt)) {
      /*
       * Сжатие контекста. Настоящий движок сперва шлёт `status: compacting`
       * (работа идёт), потом `compact_boundary` с числами до и после. Порядок и
       * пауза между ними тут не для красоты: проверяется, что на экране успевает
       * появиться строка «сворачиваю…», а не только итог.
       */
      this.schedule(requestId, 300, () =>
        this.emit(requestId, { type: 'compact', phase: 'running' })
      )
      this.schedule(requestId, 1400, () => {
        // Настоящий движок объявляет конец ДВАЖДЫ: строкой состояния (без
        // чисел) и границей (с числами). Фейк повторяет это дословно — иначе
        // прогон не поймал бы вторую черту об одном и том же событии.
        this.emit(requestId, { type: 'compact', phase: 'done' })
        this.emit(requestId, {
          type: 'compact',
          phase: 'done',
          before: 128000,
          after: 21000,
          auto: /сам|auto/i.test(opts.prompt)
        })
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: 'fake: продолжаю с пересказом' }]
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/оборв|abort/i.test(opts.prompt)) {
      /*
       * Ход, оборванный движком. Раньше это не давало на экране НИЧЕГО: точки
       * гасли, и человек оставался с вопросом «оно упало или думает?». Прогону
       * нужен именно такой конец — с текстом и без ответа.
       */
      this.schedule(requestId, 400, () => {
        this.emit(requestId, {
          type: 'notice',
          level: 'warn',
          text: 'ход прерван, ответ не дописан'
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.002 })
      })
    } else if (/рассужд|thinking/i.test(opts.prompt)) {
      // Рассуждение агента (inc-27): фейк отдаёт его тем же видом части, что и
      // настоящий движок, — проверять надо показ, а не форму блока SDK.
      this.schedule(requestId, 300, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            { type: 'thinking', text: 'Сначала проверю сборку.\nПотом посмотрю тесты.' },
            { type: 'text', text: 'fake: сборка падает на типах' }
          ]
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.001 })
      })
    } else if (/пульс|pulse/i.test(opts.prompt)) {
      /*
       * Пульс инструмента (inc-27). Карточка должна остаться ИДУЩЕЙ: результат
       * закрыл бы ровно то, что проверяем. Гейта тоже нет — так ходит вызов под
       * автопилотом, и именно там у карточки нет своего секундомера, а пульс
       * оказывается единственным, что о ней вообще известно.
       *
       * Ритм частый, а потом тишина: сколько её нужно, чтобы стать новостью,
       * решает `pulseSilence` по НАБЛЮДЁННОМУ ритму, и прогон ждёт по-настоящему
       * — подделать здесь порог значило бы проверить не ту логику.
       */
      const pid = `${requestId}-p1`
      const retry = /повтор|retry/i.test(opts.prompt)
      this.schedule(requestId, 300, () =>
        this.emit(requestId, {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: pid, name: 'Bash', input: { command: 'npm run build' } }
          ]
        })
      )
      for (let i = 1; i <= 3; i++) {
        this.schedule(requestId, 400 + i * 600, () =>
          this.emit(requestId, {
            type: 'tool_pulse',
            toolUseId: pid,
            elapsedSec: i,
            retry: retry ? { attempt: 2, max: 3 } : undefined
          })
        )
      }
    } else if (/итог|outcome/i.test(opts.prompt)) {
      /*
       * Итог хода (inc-24): длинный ход, кончившийся не по-хорошему. Дожидаться
       * настоящего исчерпания шагов в прогоне нельзя — а показать строку надо
       * ровно такой, какой её увидит человек.
       */
      this.schedule(requestId, 300, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: 'fake: сделал что успел' }]
        })
        this.emit(requestId, {
          type: 'result',
          isError: true,
          costUsd: 0.21,
          numTurns: 12,
          durationMs: 74_300,
          ttftMs: 2_600,
          denials: 2,
          endReason: endReasonText({ subtype: 'error_max_turns', terminal_reason: 'max_turns' })
        })
      })
    } else if (/повтор|retry/i.test(opts.prompt)) {
      /*
       * То, о чём движок раньше говорил в пустоту (inc-23): повтор запроса после
       * ошибки API, отказ инструменту по правилу, упавший хук. Прогону нужен
       * весь набор разом — чтобы увидеть, что три разные новости читаются как
       * три разные строки, а не сливаются в одну «ошибку».
       */
      this.schedule(requestId, 300, () => {
        for (const m of [
          { subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 4000, error_status: 503 },
          { subtype: 'permission_denied', tool_name: 'Bash', decision_reason_type: 'rule' },
          {
            subtype: 'hook_response',
            hook_name: 'lint',
            outcome: 'error',
            exit_code: 1,
            stderr: 'error: не найден конфиг'
          }
        ]) {
          const n = noticeFor(m)
          if (n) this.emit(requestId, { type: 'notice', ...n })
        }
        this.emit(requestId, {
          type: 'assistant',
          content: [{ type: 'text', text: 'fake: запрос прошёл со второй попытки' }]
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.003 })
      })
    } else if (/skill/i.test(opts.prompt)) {
      // Скилл, взятый агентом. Настоящий движок объявляет это обычным `tool_use`
      // с именем `Skill` и именем скилла в `input.skill` — проверено по записям
      // Claude Code. Прогону это нужно, чтобы увидеть две вещи: что карточка в
      // ленте называет скилл, а не пишет голое «Skill», и что раздел настроек
      // отмечает сработавший.
      this.schedule(requestId, 400, () => {
        this.emit(requestId, {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `${requestId}-s1`,
              name: 'Skill',
              input: { skill: 'code-review', args: 'дифф ветки' }
            }
          ]
        })
        this.emit(requestId, {
          type: 'tool_result',
          toolUseId: `${requestId}-s1`,
          content: 'fake: скилл отработал',
          isError: false
        })
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.01 })
      })
    } else if (/tool/i.test(opts.prompt)) {
      if (/slow/i.test(opts.prompt)) this.slowTools.add(requestId)
      // Gate a tool so approve/deny + concurrent-gate behaviour is testable.
      // «danger» в запросе — команда, которую нельзя отменить. Нужна прогонам:
      // пол под автопилотом проверяется только настоящим необратимым вызовом.
      const command = /danger/i.test(opts.prompt) ? 'rm -rf build' : 'echo fake'
      const stop = irreversible('Bash', { command })
      // «mcp» в запросе — инструмент стороннего сервера, помеченного им же как
      // разрушающий. Автопилот его не глотает: пометка сервера идёт через тот
      // же пол, что и наше необратимое (см. claudeCodeDriver.canUseTool).
      const viaMcp = /mcp/i.test(opts.prompt)
      // Автопилот здесь ведёт себя как у настоящих движков: обычное проходит
      // молча, необратимое показывается всё равно. Без этого пол нечем
      // проверить — фейковый драйвер спрашивал бы всегда и «прошёл» бы тест,
      // ничего не доказав.
      const viaEdit = /edit/i.test(opts.prompt)
      this.schedule(requestId, 400, () => {
        if (opts.bypass && !stop && !viaMcp) {
          /*
           * Настоящий движок объявляет инструмент блоком `tool_use` в ответе
           * модели — независимо от того, спрашивали разрешение или нет. Раньше
           * фейк при автопилоте слал сразу результат, и в ленте не оставалось
           * НИЧЕГО о том, что агент сделал: прогон не мог проверить показ
           * правки постфактум, а именно так работает человек с автопилотом.
           */
          this.emit(requestId, {
            type: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `${requestId}-t1`,
                name: viaEdit ? 'Edit' : 'Bash',
                input: viaEdit
                  ? {
                      file_path: 'src/shared/fake.ts',
                      old_string: 'const a = 1\nconst b = 2\nkeep me',
                      new_string: 'const a = 42\nkeep me\nconst c = 3'
                    }
                  : { command }
              }
            ]
          })
          this.emit(requestId, {
            type: 'tool_result',
            toolUseId: `${requestId}-t1`,
            content: 'fake: выполнено без подтверждения',
            isError: false
          })
          return
        }
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-t1`,
          toolName: viaEdit ? 'Edit' : viaMcp ? 'mcp__fake_server__wipe' : 'Bash',
          input: viaEdit
            ? {
                file_path: 'src/shared/fake.ts',
                old_string: 'const a = 1\nconst b = 2\nkeep me',
                new_string: 'const a = 42\nkeep me\nconst c = 3'
              }
            : viaMcp
              ? { path: '/tmp/fake' }
              : { command },
          irreversible: stop ?? undefined,
          mcpMark: viaMcp ? { destructive: true } : undefined
        })
      })
    } else if (/ask/i.test(opts.prompt) && this.capabilities.structuredQuestions) {
      // Structured AskUserQuestion (only if the driver declares the capability).
      this.schedule(requestId, 400, () =>
        this.emit(requestId, {
          type: 'permission',
          toolUseId: `${requestId}-q1`,
          toolName: 'AskUserQuestion',
          input: {},
          questions: [
            {
              question: 'Цвет?',
              header: 'Тема',
              options: [{ label: 'Красный' }, { label: 'Синий' }]
            }
          ]
        })
      )
    } else if (/slow/i.test(opts.prompt)) {
      // Долгий ход без гейта — чтобы успеть проверить то, что делается ПОКА
      // агент работает: очередь, Esc, прерывание. На 500мс такие сценарии
      // превращаются в гонку с самим тестом.
      this.schedule(requestId, 8000, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    } else {
      this.schedule(requestId, 500, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    }
  }

  input(requestId: string, text: string): void {
    this.schedule(requestId, 150, () =>
      this.emit(requestId, {
        type: 'assistant',
        content: [{ type: 'text', text: `fake ${this.engine} f/u: ${text}` }]
      })
    )
    this.schedule(requestId, 300, () =>
      this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
    )
  }

  interrupt(requestId: string): void {
    this.emit(requestId, { type: 'result', isError: false })
  }

  /**
   * Отмотка — только если профиль движка её заявляет: так харнесс проверяет ОБА
   * поведения. Правило то же, что у настоящего драйвера: есть ответ агента —
   * ветка от него; нет, но ветка сама откуда-то началась — от той же точки;
   * продолженная сессия без ответа — отматывать нечем, честный отказ.
   */
  rewindAfterInterrupt(requestId: string): AgentRewind | null {
    if (!this.capabilities.rewind) return null
    const s = this.sessions.get(requestId)
    if (!s) return null
    const at = rewindPoint(s)
    if (!at) return null
    if (at.kind === 'fresh') this.sessions.delete(requestId)
    this.interrupt(requestId)
    return at
  }

  resolvePermission(requestId: string, toolUseId: string, decision: AgentPermissionDecision): void {
    // «slow» в запросе — инструмент, который ДОЛГО работает. Настоящая команда
    // агента (клонирование, установка пакетов) идёт секунды и минуты, и всё,
    // что показывает лента в это время, проверить на мгновенном ответе нельзя:
    // карточка исчезает раньше, чем прогон успевает на неё посмотреть.
    const slow = decision.behavior === 'allow' && this.slowTools.has(requestId)
    const emitResult = (): void => {
      this.emit(requestId, {
        type: 'tool_result',
        toolUseId,
        content: decision.behavior === 'allow' ? 'fake tool output' : decision.message,
        isError: decision.behavior === 'deny'
      })
      this.schedule(requestId, 120, () =>
        this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
      )
    }
    if (slow) this.schedule(requestId, 6000, emitResult)
    else emitResult()
  }

  resolveQuestion(requestId: string, toolUseId: string, answer: AgentQuestionAnswer): void {
    this.emit(requestId, {
      type: 'tool_result',
      toolUseId,
      content: `answered: ${Object.values(answer.answers).flat().join(', ')}`,
      isError: false
    })
    this.schedule(requestId, 120, () =>
      this.emit(requestId, { type: 'result', isError: false, costUsd: 0.04, models: [`${this.engine}-model`] })
    )
  }

  async listSessions(): Promise<[]> {
    return []
  }
  async listModels(): Promise<{ value: string; displayName: string }[]> {
    return [{ value: `${this.engine}-a`, displayName: `${this.engine} A` }]
  }
  setModel(): void {}
  setEffort(): void {}
  setBypass(): void {}
  setVendorFlag(): void {}

  /** Папка каждой беседы — источник ответов sessionCwd/listCommands. */
  private cwds = new Map<string, string>()

  sessionCwd(requestId: string): string | undefined {
    return this.cwds.get(requestId)
  }

  /**
   * Команды ЭТОЙ беседы.
   *
   * Одна общая — «/fake-common», и одна именная по папке — «/proj-<папка>».
   * Именно вторая доказывает маршрутизацию: две панели в разных проектах
   * обязаны получить разные списки, а не один от случайной сессии.
   */
  async listCommands(
    requestId?: string
  ): Promise<import('@shared/agentCommands').AgentCommand[]> {
    const cwd = requestId ? this.cwds.get(requestId) : undefined
    const leaf = (cwd ?? '').split(/[\\/]/).filter(Boolean).pop()
    return [
      { name: 'fake-common', description: 'команда, общая для всех панелей' },
      ...(leaf ? [{ name: `proj-${leaf}`, description: `команда проекта ${leaf}` }] : []),
      // Длинный список с ОЧЕНЬ длинным описанием у одной из команд. Нужен
      // прогону: описание раньше растягивало палитру, и та, прижатая к строке
      // ввода, подпрыгивала вверх при переходе стрелкой между соседними
      // строками. Двух команд для этого мало — список должен ещё и
      // прокручиваться.
      ...Array.from({ length: 24 }, (_, i) => ({
        name: `fake-${String(i).padStart(2, '0')}`,
        description: `разыгранная команда номер ${i}`
      })),
      {
        name: 'fake-long',
        description:
          'Команда с очень длинным описанием: проверка того, что палитра не меняет высоту, ' +
          'когда человек доходит стрелкой до такой строки. Раньше описание росло свободно, ' +
          'палитра вырастала вверх на десяток строк и сдвигала всё, во что человек целился ' +
          'мышью, — а список под курсором уезжал из-под него в момент нажатия. Текст здесь ' +
          'намеренно длинный: короткий не воспроизводит того, ради чего прогон написан. ' +
          'Длина взята с настоящих команд Claude Code: у /doctor описание перечисляет весь ' +
          'список проверок установки — дубли и остатки прошлых версий, PATH, нечитаемые ' +
          'файлы настроек, конфликтующие определения агентов, неиспользуемые скиллы, ' +
          'MCP-серверы и плагины против их цены в контексте, локальные CLAUDE.md против ' +
          'закоммиченных, медленные хуки и расширения, тяжёлые для контекста, а также ' +
          'предварительное одобрение часто отклоняемых команд только на чтение. Именно на ' +
          'такой строке палитра и подпрыгивала: десять строк текста против семи строк ' +
          'списка — разница в полсотни пикселей, и вся панель уезжала вверх под курсором. ' +
          'Текст продолжается намеренно: в широком окне колонка описания тоже широка, и ' +
          'короткий абзац в неё помещается целиком — тогда прогон проверял бы равенство ' +
          'высот там, где высоте нечем было меняться, и прошёл бы даже на сломанном коде. ' +
          'Чтобы этого не случилось, описание заведомо длиннее области при любой разумной ' +
          'ширине панели: прогон сам убеждается, что колонка прокручивается, и только ' +
          'после этого сравнивает положение палитры до и после перехода. Настоящие команды ' +
          'бывают и длиннее — у /doctor к перечислению проверок добавляются условия ' +
          'запуска, оговорки про версии и напоминание о том, что часть шагов требует ' +
          'подтверждения человека, потому что меняет файлы в его домашней папке.'
      }
    ]
  }

  /** Перечитать «диск» ЭТОЙ беседы — в ответе видно, чью именно. */
  async reloadExtras(requestId?: string): Promise<import('@shared/types').AgentExtrasReload> {
    if (!requestId || !this.started.has(requestId))
      return { ok: false, commands: [], plugins: 0, mcpServers: [], errors: 0 }
    return {
      ok: true,
      commands: await this.listCommands(requestId),
      plugins: 0,
      mcpServers: [{ name: `mcp-of-${this.cwds.get(requestId)?.split(/[\\/]/).pop() ?? '?'}` }],
      errors: 0
    }
  }

  /**
   * Состав инструментов — разыгранный, но со всеми состояниями сразу.
   *
   * Здесь нарочно есть каждое: упавший сервер с причиной, ждущий логина,
   * работающий с ценой в токенах и выключенный. Прогон должен видеть все
   * четыре строки, потому что в жизни человек видит именно такую смесь (на
   * машине владельца из четырнадцати серверов три упали и пять ждут логина).
   *
   * Возможность объявляется через `capabilities.mcp`: у движка без неё этих
   * методов нет вовсе, и окно скажет «не умеет» вместо пустого списка.
   */
  private mcpDisabled = new Set<string>()
  private skillStates = new Map<string, import('@shared/types').SkillState>()

  async mcpStatus(
    requestId: string | undefined,
    opts?: { probe?: boolean }
  ): Promise<import('@shared/types').McpSnapshot> {
    if (!this.capabilities.mcp) return { unsupported: true, servers: [] }
    // Живой беседы нет: без нажатия — прошлый снимок (у фейка его нет, значит
    // пусто с пометкой), с нажатием — «проверили».
    const live = !!requestId && this.started.has(requestId)
    if (!live && !opts?.probe) return { servers: [], stale: true }
    const off = (name: string): boolean => this.mcpDisabled.has(name)
    const sk = (
      name: string,
      source: string,
      tokens: number,
      extra?: Partial<import('@shared/types').SkillRow>
    ): import('@shared/types').SkillRow => ({
      name,
      source,
      tokens,
      state: this.skillStates.get(name) ?? 'on',
      ...extra
    })
    return {
      at: Date.now(),
      contextTokens: 42_000,
      contextMax: 200_000,
      /*
       * Разбор по статьям — с той же ловушкой, что у настоящего движка: сумма
       * ВСЕХ статей вдвое больше «занято», потому что отложенные в контексте не
       * лежат. Числа подобраны так, чтобы 8 000 + 14 000 + 12 000 + 7 000 +
       * 1 000 = 42 000 сошлись с `contextTokens`, а отложенные 30 000 остались
       * за скобками. Сложи прогон одно с другим — и он это увидит.
       */
      contextParts: [
        { name: 'System tools', tokens: 14_000 },
        { name: 'Memory files', tokens: 12_000 },
        { name: 'Messages', tokens: 8_000 },
        { name: 'Skills', tokens: 7_000 },
        { name: 'System prompt', tokens: 1_000 },
        { name: 'MCP tools', tokens: 22_000, deferred: true },
        { name: 'System tools', tokens: 8_000, deferred: true }
      ],
      memoryFiles: [
        { path: 'C:/Users/qa/.claude/CLAUDE.md', kind: 'User', tokens: 9_400 },
        { path: 'C:/proj/CLAUDE.md', kind: 'Project', tokens: 2_600 }
      ],
      // Разыгранные скиллы покрывают все случаи, из-за которых строка ведёт
      // себя по-разному: дорогой личный, встроенный, плагинный (его
      // `skillOverrides` не берёт), перекрытый настройкой проекта и уже
      // выключенный — тот, которого в контексте нет и цена которого неизвестна.
      skills: {
        total: 5,
        included: 4,
        tokens: 1_190,
        items: [
          sk('code-review', 'userSettings', 620),
          sk('dataviz', 'built-in', 380),
          sk('cloudflare:email-service', 'plugin', 190),
          sk('team-deploy', 'projectSettings', 0, { state: 'name-only', from: 'project' }),
          sk('legacy-context', '', 0, { state: 'off', from: 'user' })
        ]
      },
      servers: [
        {
          name: 'broken-one',
          status: off('broken-one') ? 'disabled' : 'failed',
          error: 'MCP endpoint not found at https://example.invalid',
          transport: 'http',
          origin: 'example.invalid',
          scope: 'user'
        },
        {
          name: 'needs-login',
          status: off('needs-login') ? 'disabled' : 'needs-auth',
          transport: 'http',
          origin: 'login.example.com',
          scope: 'user'
        },
        {
          name: 'working-one',
          status: off('working-one') ? 'disabled' : 'connected',
          transport: 'stdio',
          origin: 'npx',
          scope: 'project',
          version: '1.2.3',
          tools: 12,
          tokens: 8_400
        },
        {
          name: 'switched-off',
          status: 'disabled',
          transport: 'stdio',
          origin: 'uvx',
          scope: 'local'
        }
      ]
    }
  }

  /**
   * Остановка одной задачи. Фейк повторяет настоящий путь: сам вызов лишь
   * ПРОСИТ, а «остановлено» приходит отдельным событием — как у движка.
   */
  /** Смена режима на ходу. Запоминаем — прогон читает её через debugFlags. */
  setPermissionMode(requestId: string, mode: 'plan' | 'default'): void {
    this.modes.set(requestId, mode)
  }

  async stopTask(
    requestId: string,
    taskId: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    if (!this.capabilities.stopTask) return { ok: false, reason: 'unsupported' }
    if (!this.started.has(requestId)) return { ok: false, reason: 'no-session' }
    this.schedule(requestId, 400, () =>
      this.emit(requestId, { type: 'subagent', taskId, phase: 'done', status: 'stopped' })
    )
    return { ok: true }
  }

  async mcpReconnect(
    requestId: string,
    name: string
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    if (!this.capabilities.mcp) return { ok: false, reason: 'unsupported' }
    if (!this.started.has(requestId)) return { ok: false, reason: 'no-session' }
    // Сломанный остаётся сломанным: кнопка, которая «чинит» одним нажатием всё,
    // научила бы человека верить ей и там, где чинить нечего.
    if (name === 'broken-one') return { ok: false, error: 'connection refused' }
    return { ok: true }
  }

  async mcpToggle(
    requestId: string,
    name: string,
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string; reason?: 'no-session' | 'unsupported' }> {
    if (!this.capabilities.mcp) return { ok: false, reason: 'unsupported' }
    if (!this.started.has(requestId)) return { ok: false, reason: 'no-session' }
    if (enabled) this.mcpDisabled.delete(name)
    else this.mcpDisabled.add(name)
    return { ok: true }
  }

  /**
   * Состояние скилла — в памяти прогона.
   *
   * Настоящий драйвер пишет в `~/.claude/settings.json`; фейку это запрещено:
   * прогон не имеет права трогать настройки человека, а на машине QA их может
   * не быть вовсе. Отказ на перекрытом ключе разыгран, потому что именно он
   * решает, показывать ли переключатель.
   */
  async skillOverride(
    _requestId: string | undefined,
    name: string,
    state: import('@shared/types').SkillState
  ): Promise<{
    ok: boolean
    error?: string
    reason?: 'overridden' | 'unreadable'
    by?: import('@shared/types').SkillLayer
  }> {
    if (name === 'team-deploy') return { ok: false, reason: 'overridden', by: 'project' }
    // Нечитаемый файл настроек: настоящий драйвер тут отказывается писать, и
    // окно обязано сказать почему — иначе человек потерял бы чужой конфиг.
    if (name === 'dataviz') return { ok: false, reason: 'unreadable', error: '~/.claude/settings.json' }
    if (name === 'cloudflare:email-service') return { ok: false, error: 'скилл плагина' }
    this.skillStates.set(name, state)
    return { ok: true }
  }

  killAll(): void {
    this.timers.forEach((ts) => ts.forEach(clearTimeout))
    this.timers.clear()
    this.started.clear()
    // QA teardown assert: prove the registry called killAll on quit for EVERY
    // driver (a leaked real subprocess would be the production bug this catches).
    const log = process.env.ZARYA_FAKE_KILL_LOG
    if (log) {
      try {
        appendFileSync(log, this.engine + '\n')
      } catch {
        /* best-effort */
      }
    }
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentEngine, McpServerRow, McpSnapshot } from '@shared/types'
import { t, useLang } from '@/lib/i18n'
import { useAiStore } from '@/features/ai/aiStore'
import { useUiStore } from '@/state/uiStore'
import { shortenPath } from '@/lib/ansi'
import { mcpLoginCommand } from '@shared/mcp'
import {
  contextDeferred,
  contextPartKey,
  contextUsed,
  fmtCtxTokens,
  type ContextPart
} from '@shared/contextParts'
import { SkillsPanel } from './SkillsPanel'
import './toolstab.css'

/**
 * Здоровье инструментов агента: MCP-серверы одной панели и их цена в контексте.
 *
 * ПОЧЕМУ ОДНОЙ. `.mcp.json` живёт в папке проекта, а окно контекста принадлежит
 * сессии: две панели в разных репозиториях видят разные наборы. Показать «все
 * инструменты Зари» невозможно — таких не существует, — поэтому вверху стоит
 * выбор панели, а заголовок всегда называет, чьи инструменты на экране.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни `env`, ни заголовков, ни адресов с ключом внутри: главный
 * процесс присылает уже урезанную строку (см. `shared/mcp.ts`). Показать
 * секрет «только посмотреть» нельзя — он попадёт в первый же скриншот.
 */
function num(n: number): string {
  // Разряды разделяет НЕРАЗРЫВНЫЙ пробел (U+00A0): запятая в русском дробная,
  // а узкий пробел (U+2009) есть не во всех шрифтах — в Handjet на его месте
  // вышел бы прямоугольник. Неразрывный заодно не даёт числу переломиться
  // пополам на конце строки.
  return n.toLocaleString('en-US').replace(/,/g, ' ')
}

/**
 * Как называется панель в этом выборе.
 *
 * Имя беседы — это её первый запрос, и он бывает длинным: «объясни, почему
 * сборка падает на windows и что…». Целиком он разрывает шапку и вытесняет
 * папку, а папка здесь важнее — именно она определяет, какие MCP-серверы
 * видит панель.
 */
function paneLabel(title: string | undefined, cwd: string | undefined): string {
  const name = (title ?? '').trim()
  const short = name.length > 34 ? `${name.slice(0, 33)}…` : name
  return cwd ? `${short} · ${shortenPath(cwd, 30)}` : short
}

function timeOf(ms: number): string {
  const d = new Date(ms)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const STATUS_KEY: Record<McpServerRow['status'], string> = {
  connected: 'tools.st.connected',
  failed: 'tools.st.failed',
  'needs-auth': 'tools.st.needsAuth',
  pending: 'tools.st.pending',
  disabled: 'tools.st.disabled'
}

/**
 * Откуда конфиг сервера, словами.
 *
 * Незнакомый scope показываем КАК ЕСТЬ, а не через словарь: `t()` на
 * отсутствующем ключе вернёт сам ключ, и человек увидит на экране
 * «tools.scope.enterprise» вместо ответа. Чужое слово честнее нашей поломки.
 */
function scopeLabel(scope: string): string {
  const known: Record<string, string> = {
    project: 'tools.scope.project',
    user: 'tools.scope.user',
    local: 'tools.scope.local',
    claudeai: 'tools.scope.claudeai',
    managed: 'tools.scope.managed'
  }
  const key = known[scope]
  return key ? t(key) : scope
}

/**
 * Путь входа для сервера, который ждёт авторизации.
 *
 * Готовую строку показываем ТОЛЬКО когда имя сервера безопасно для командной
 * строки. Имя приходит из `.mcp.json` открытого проекта — это чужой текст, и
 * раньше «опасное» имя заворачивалось в кавычки по правилам sh. Вставляют же
 * команду в PowerShell, где обратный слэш не экранирует ничего: строка
 * закрывалась раньше времени, и хвост имени исполнялся как отдельная команда.
 * Экранирования, годного сразу для sh, PowerShell и cmd, не существует —
 * поэтому здесь либо честная команда, либо честный отказ с именем отдельно.
 */
function LoginHint({
  name,
  say
}: {
  name: string
  say: (text: string, bad?: boolean) => void
}): React.JSX.Element {
  const cmd = mcpLoginCommand(name)
  if (!cmd) {
    return (
      <div className="zy-tools-login zy-tools-login--unsafe">
        <span className="zy-tools-why">{t('tools.unsafeName')}</span>
        <code className="zy-tools-cmd">{name}</code>
        <button
          type="button"
          className="zy-tools-btn"
          onClick={() => {
            void navigator.clipboard.writeText(name)
            say(t('tools.nameCopied'))
          }}
        >
          {t('tools.copyName')}
        </button>
      </div>
    )
  }
  return (
    <div className="zy-tools-login">
      <code className="zy-tools-cmd">{cmd}</code>
      <button
        type="button"
        className="zy-tools-btn"
        onClick={() => {
          void navigator.clipboard.writeText(cmd)
          say(t('tools.copied'))
        }}
      >
        {t('tools.copy')}
      </button>
    </div>
  )
}

/**
 * Чем занято окно контекста.
 *
 * Число «занято» отвечает на вопрос «много ли». Человек следом спрашивает «а
 * чем?» — и до сих пор ответа не было, хотя движок разбор считает и отдаёт.
 *
 * ДВЕ ВЕЩИ, КОТОРЫЕ ЗДЕСЬ НЕ ДЕЛАЮТСЯ. Не складывается отложенное с занятым:
 * этих описаний в контексте НЕТ, и общая сумма вышла бы вдвое больше правды
 * (см. @shared/contextParts). И не берётся цвет движка: `color` в его ответе —
 * не цвет, а имя токена ЕГО темы («promptBorder», «inactive»), в нашем CSS оно
 * не значит ничего.
 *
 * Доля рисуется от САМОЙ КРУПНОЙ статьи, а не от окна: при окне в миллион
 * токенов все полоски были бы одинаково пустыми, и сравнить статьи между собой
 * — то, ради чего сюда и смотрят, — стало бы нельзя.
 */
/**
 * Один файл памяти: чей он, во сколько обходится и можно ли его поправить.
 *
 * Цену Заря показывала и раньше — и на этом останавливалась. «У вас личный
 * CLAUDE.md на девять тысяч токенов в каждом запросе» без возможности его
 * открыть — это чек без кассы: человек узнаёт о трате и идёт искать файл руками.
 *
 * Правка здесь же, а не в редакторе Зари: тот живёт только в IDE-режиме, и
 * кнопка «править» без него молча не делала бы ничего — худший вид кнопки.
 *
 * `Managed` не правится: это политика организации, её нет на диске у человека.
 * Кнопки для него нет вовсе — показать её и получить отказ хуже, чем не
 * показывать.
 */
function MemoryRow({
  file
}: {
  file: NonNullable<McpSnapshot['memoryFiles']>[number]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState('')
  const managed = /^managed$/i.test(file.kind)

  // Что лежало в файле, когда его открыли. По нему видно, не поменял ли его
  // кто-то снаружи, пока редактор был открыт.
  const [base, setBase] = useState<string | null>(null)

  const edit = async (): Promise<void> => {
    if (open) {
      /*
       * Закрытие с несохранёнными правками — спрашиваем.
       *
       * Раньше щелчок по «закрыть» стирал набранное без единого слова: человек
       * писал правило в память проекта, случайно попадал по кнопке — и текста
       * не было нигде. Молчаливая потеря того, что человек напечатал руками,
       * — худший из возможных исходов этого экрана.
       */
      if (dirty && !window.confirm(t('mem.dropAsk'))) return
      setOpen(false)
      setDirty(false)
      return
    }
    setNote('')
    const read = await window.zarya.fs.readFile(file.path).catch(() => null)
    if (!read || read.binary) {
      // Файл может быть недоступен или оказаться не текстом. Молчать нельзя:
      // человек нажал «править» и вправе узнать, почему ничего не открылось.
      setNote(t('mem.unreadable'))
      return
    }
    /*
     * ОБРЕЗАННЫЙ ФАЙЛ НЕ ОТКРЫВАЕМ НА ПРАВКУ.
     *
     * Чтение отдаёт первые полтора мегабайта и честно помечает остаток
     * отброшенным. Сохранить такое значит записать поверх файла его начало —
     * то есть молча УНИЧТОЖИТЬ хвост чужой памяти. Отказ здесь единственно
     * возможный ответ, и он должен быть назван причиной.
     */
    if (read.truncated) {
      setNote(t('mem.tooBig'))
      return
    }
    setText(read.content)
    setBase(read.content)
    setDirty(false)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (text === null) return
    try {
      /*
       * Перед записью перечитываем.
       *
       * Пока редактор был открыт, файл мог поправить сам агент (жест «#»),
       * другая панель или человек в стороннем редакторе. Записать поверх — то
       * же уничтожение чужой работы, только с задержкой. Расхождение не
       * решаем за человека: говорим и не пишем.
       */
      const now = await window.zarya.fs.readFile(file.path).catch(() => null)
      if (now && !now.binary && base !== null && now.content !== base) {
        setNote(t('mem.changedOutside'))
        return
      }
      /*
       * Концы строк оставляем ТЕ ЖЕ.
       *
       * Поле ввода браузера отдаёт только LF. Записав его как есть, Заря
       * молча перевела бы весь файл с CRLF на LF — а это чужой файл, он лежит
       * в гите, и «перевод всего файла» вылез бы в дифф правкой КАЖДОЙ строки.
       * Человек менял одну.
       */
      const CR = String.fromCharCode(13)
      const LF = String.fromCharCode(10)
      const crlf = base !== null && base.includes(CR + LF)
      const body = crlf
        ? text
            .split(CR + LF)
            .join(LF)
            .split(LF)
            .join(CR + LF)
        : text
      await window.zarya.fs.writeFile(file.path, body)
      setBase(body)
      setDirty(false)
      // Цена в токенах ПОСЛЕ правки — уже другая, а цифра на экране прежняя.
      // Сказать об этом честнее, чем пересчитать своей арифметикой: считает её
      // движок, и он назовёт новую при следующем ответе.
      setNote(t('mem.saved'))
    } catch {
      setNote(t('mem.saveFailed'))
    }
  }

  return (
    <>
      <div className="zy-ctx-row zy-ctx-row--file">
        <span className="zy-ctx-name" title={file.path}>
          {shortenPath(file.path, 40)}
        </span>
        {/* Чей это файл. Движок называет уровень словом («User», «Project»), и
            без него два CLAUDE.md в списке различались только по пути. */}
        {file.kind && <span className="zy-mem-kind">{file.kind}</span>}
        <span className="zy-ctx-num">{fmtCtxTokens(file.tokens)}</span>
        {!managed && (
          <button className="zy-mem-edit" onClick={() => void edit()}>
            {t(open ? 'mem.close' : 'mem.edit')}
          </button>
        )}
      </div>
      {note && <div className="zy-mem-note">{note}</div>}
      {open && text !== null && (
        <div className="zy-mem-editor">
          <textarea
            className="zy-input zy-textarea zy-mem-area"
            rows={14}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value)
              setDirty(true)
              if (note) setNote('')
            }}
          />
          <div className="zy-mem-actions">
            <button className="zy-mem-save" disabled={!dirty} onClick={() => void save()}>
              {t('mem.save')}
            </button>
            {/* Несохранённое видно словом, а не только состоянием кнопки. */}
            {dirty && <span className="zy-mem-dirty">{t('mem.dirty')}</span>}
          </div>
        </div>
      )}
    </>
  )
}

function ContextBreakdown({
  parts,
  files
}: {
  parts?: ContextPart[]
  files?: McpSnapshot['memoryFiles']
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!parts?.length) return null
  const live = parts.filter((p) => !p.deferred)
  const later = parts.filter((p) => p.deferred)
  const top = live[0]?.tokens || 1
  return (
    <div className="zy-ctx">
      <button type="button" className="zy-ctx-head" onClick={() => setOpen((v) => !v)}>
        <span className="zy-ctx-caret" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {t('ctx.whatFills')}
      </button>
      {open && (
        <div className="zy-ctx-body">
          {live.map((p) => {
            const key = contextPartKey(p.name)
            return (
              <div key={p.name} className="zy-ctx-row">
                <span className="zy-ctx-name">{key ? t(key) : p.name}</span>
                <span className="zy-ctx-bar" aria-hidden>
                  <span
                    className="zy-ctx-fill"
                    style={{ width: `${Math.max(2, Math.round((p.tokens / top) * 100))}%` }}
                  />
                </span>
                <span className="zy-ctx-num">{fmtCtxTokens(p.tokens)}</span>
              </div>
            )
          })}
          {/*
            Файлы памяти поимённо. Самая частая неожиданность всего разбора:
            личный CLAUDE.md молча стоит несколько тысяч токенов в КАЖДОМ
            запросе, и узнать об этом было неоткуда.
          */}
          {!!files?.length && (
            <>
              <div className="zy-ctx-sub">{t('ctx.memoryFiles')}</div>
              {files.map((f) => (
                <MemoryRow key={f.path} file={f} />
              ))}
            </>
          )}
          {/*
            Отложенное — ОТДЕЛЬНО и с объяснением. Это не расход, а то, что
            подгрузится по требованию; в общей сумме оно удвоило бы цифру и
            заставило человека выключать сервер, который сейчас бесплатен.
          */}
          {!!later.length && (
            <div className="zy-ctx-later">
              {t('ctx.deferred', { n: fmtCtxTokens(contextDeferred(parts)) })}
            </div>
          )}
          {/* Наша сумма занятого — рядом с цифрой движка выше. Разойдутся —
              значит мы что-то посчитали не так, и это видно сразу. */}
          <div className="zy-ctx-sum">{t('ctx.sum', { n: fmtCtxTokens(contextUsed(parts)) })}</div>
        </div>
      )}
    </div>
  )
}

export function ToolsTab(): React.JSX.Element {
  // Подписка на язык: без неё надписи сменились бы не в момент переключения, а
  // при следующей перерисовке по другой причине.
  useLang()

  const conversations = useAiStore((s) => s.conversations)
  const activeId = useAiStore((s) => s.activeId)
  const agentCaps = useUiStore((s) => s.agentCaps)

  // Беседы встроенного агента сюда не попадают: у него нет MCP вообще, и
  // строка «движок не умеет» про него была бы не отказом, а недоразумением.
  const panes = useMemo(() => conversations.filter((c) => c.engine !== 'builtin'), [conversations])
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = useMemo(
    () => panes.find((c) => c.id === (picked ?? activeId)) ?? panes[0],
    [panes, picked, activeId]
  )

  const [snap, setSnap] = useState<McpSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  // Сообщение и его тон. Тон нужен потому, что здесь встречаются оба: отказ
  // движка и ответ на удачное нажатие. Красить «команда скопирована» цветом
  // danger — врать цветом, а цвет в Заре значит «сломано» или «ждёт тебя».
  const [note, setNote] = useState<{ text: string; bad?: boolean }>({ text: '' })
  const say = useCallback((text: string, bad = false) => setNote({ text, bad }), [])

  const engine = chosen?.engine as AgentEngine | undefined
  const caps = engine ? agentCaps?.[engine] : undefined
  // `caps === undefined` — «ещё не приехали», а не «не умеет»: карта возможностей
  // приходит одним асинхронным вызовом. Пока её нет, спрашиваем движок и верим
  // его ответу, а не догадке.
  const unsupported = caps ? !caps.mcp : false

  const load = useCallback(
    // `keepNote` — для перезагрузки ПОСЛЕ действия: без него ответ на нажатие
    // («подействует со следующей беседы») стирался бы обновлением списка через
    // долю секунды, и человек не успевал его прочитать.
    async (probe: boolean, keepNote = false): Promise<void> => {
      if (!chosen || !engine || unsupported) return
      setBusy(true)
      if (!keepNote) setNote({ text: '' })
      try {
        setSnap(await window.zarya.agent.mcpStatus(engine, chosen.id, probe))
      } finally {
        setBusy(false)
      }
    },
    [chosen, engine, unsupported]
  )

  // Открыли вкладку или сменили панель — спрашиваем БЕЗ probe: живая панель
  // ответит из своей сессии, а мёртвая отдаст прошлый снимок. Поднимать движок
  // ради свежих цифр здесь нельзя — проверка связи запускает MCP-серверы
  // по-настоящему, то есть чужие процессы и секунды ожидания.
  useEffect(() => {
    setSnap(null)
    void load(false)
  }, [load])

  const act = async (
    fn: () => Promise<{ ok: boolean; error?: string; reason?: string }>
  ): Promise<void> => {
    setBusy(true)
    try {
      const r = await fn()
      if (r.ok) {
        await load(false)
      } else if (r.reason === 'no-session') {
        say(t('tools.noSession'), true)
      } else if (r.reason === 'unsupported') {
        say(t('tools.unsupported'), true)
      } else {
        // Причина — от движка, дословно: наш пересказ «не вышло» бесполезен.
        say(r.error || t('tools.failedPlain'), true)
      }
    } finally {
      setBusy(false)
    }
  }

  if (!panes.length) {
    return (
      <section className="zy-set-section">
        <div className="zy-tools-empty">{t('tools.noPanes')}</div>
      </section>
    )
  }

  const rows = snap?.servers ?? []
  const stale = !!snap?.stale
  const mcpTotal = rows.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  /*
   * ЦЕНА И ЗАНЯТОЕ — РАЗНЫЕ ЧИСЛА, и до сегодняшнего дня здесь было одно,
   * названное именем другого: «занимают ~N токенов в каждом запросе».
   *
   * Движок описания инструментов ОТКЛАДЫВАЕТ: в старте едут имена, полное
   * описание подгружается, когда модель за ним потянется. Живой замер
   * (scripts/live/mcp-self-cost.mjs) показал разрыв в лицо — 25 966 токенов
   * инструментов при 42 165 занятого окна, и движок называет их отложенными.
   *
   * `undefined` значит «движок не сказал», и это не ноль: показывать в таком
   * случае нечего, а догадываться — снова врать.
   */
  const loadedKnown = rows.some((s) => s.loadedTokens !== undefined)
  const mcpLoaded = rows.reduce((sum, s) => sum + (s.loadedTokens ?? 0), 0)

  return (
    <section className="zy-set-section">
      <div className="zy-tools-head">
        <div className="zy-tools-pick">
          <span className="zy-tools-pick-label">{t('tools.pane')}</span>
          {panes.length > 1 ? (
            <select
              className="zy-select zy-tools-select"
              value={chosen?.id ?? ''}
              onChange={(e) => setPicked(e.target.value)}
            >
              {panes.map((c) => (
                <option key={c.id} value={c.id}>
                  {paneLabel(c.title, c.cwd)}
                </option>
              ))}
            </select>
          ) : (
            <span className="zy-tools-pick-one">{paneLabel(chosen?.title, chosen?.cwd)}</span>
          )}
        </div>
        <button
          type="button"
          className="zy-tools-refresh"
          disabled={busy || unsupported}
          onClick={() => void load(true)}
          title={t('tools.checkHint')}
        >
          {busy ? t('tools.checking') : t('tools.check')}
        </button>
      </div>

      {unsupported ? (
        <div className="zy-tools-empty">{t('tools.unsupported')}</div>
      ) : (
        <>
          {stale && (
            <div className="zy-tools-stale">
              {snap?.at ? t('tools.staleAt', { time: timeOf(snap.at) }) : t('tools.staleNone')}
            </div>
          )}
          {note.text && (
            <div className={`zy-tools-note${note.bad ? ' zy-tools-note--bad' : ''}`}>
              {note.text}
            </div>
          )}

          {!rows.length && !busy && (
            <div className="zy-tools-empty">{stale ? t('tools.staleEmpty') : t('tools.none')}</div>
          )}

          <div className={`zy-tools-list${stale ? ' zy-tools-list--stale' : ''}`}>
            {rows.map((s) => (
              <div key={s.name} className={`zy-tools-row zy-tools-row--${s.status}`}>
                <div className="zy-tools-row-main">
                  <span className={`zy-tools-dot zy-tools-dot--${s.status}`} />
                  <span className="zy-tools-name">{s.name}</span>
                  <span className="zy-tools-status">{t(STATUS_KEY[s.status])}</span>
                </div>
                {s.error && <div className="zy-tools-why">{s.error}</div>}
                <div className="zy-tools-meta">
                  {[
                    s.transport,
                    s.origin,
                    s.scope && scopeLabel(s.scope),
                    s.version && `v${s.version}`,
                    s.tools !== undefined && t('tools.count', { n: s.tools }),
                    s.tokens !== undefined && t('tools.tokens', { n: num(s.tokens) }),
                    // Отложенное называем словом, а не нулём: «0 токенов» рядом
                    // с ценой читается как поломка счётчика, а не как ответ.
                    s.loadedTokens !== undefined &&
                      (s.loadedTokens > 0
                        ? t('tools.loadedNow', { n: num(s.loadedTokens) })
                        : t('tools.deferred'))
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {/*
                  Ждущему входа НЕ предлагаем «переподключить»: соединение у
                  него в порядке, не хватает авторизации, и нажатие ничего не
                  изменит. Логинить из Зари мы пока не умеем — значит честный
                  путь руками, а не кнопка, которая сделает вид.
                */}
                {s.status === 'needs-auth' && !stale && <LoginHint name={s.name} say={say} />}
                {!stale && (
                  <div className="zy-tools-actions">
                    {s.status !== 'disabled' &&
                      s.status !== 'connected' &&
                      s.status !== 'needs-auth' && (
                        <button
                          type="button"
                          className="zy-tools-btn"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              window.zarya.agent.mcpReconnect(engine!, chosen!.id, s.name)
                            )
                          }
                        >
                          {t('tools.reconnect')}
                        </button>
                      )}
                    <button
                      type="button"
                      className="zy-tools-btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          window.zarya.agent.mcpToggle(
                            engine!,
                            chosen!.id,
                            s.name,
                            s.status === 'disabled'
                          )
                        )
                      }
                    >
                      {s.status === 'disabled' ? t('tools.enable') : t('tools.disable')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/*
            Итог по MCP — главное число вкладки: оно превращает «выключить» из
            уборки в решение. Складываем цены, которые назвал сам движок; своей
            арифметики поверх (доли, прогнозы «сколько освободится») здесь нет —
            разойдётся с /context, и веры не будет ни одной из цифр.
          */}
          {mcpTotal > 0 && (
            <div className="zy-tools-total">
              {t('tools.mcpTotal', { n: num(mcpTotal) })}
              {/*
                Вторая строка — про то, сколько из этого лежит в окне СЕЙЧАС.
                Без неё первое число человек читает как расход на каждый запрос
                и выключает серверы, которые ему ничего не стоят.
              */}
              {loadedKnown && (
                <div className="zy-tools-total-sub">
                  {mcpLoaded > 0
                    ? t('tools.mcpLoaded', { n: num(mcpLoaded) })
                    : t('tools.mcpAllDeferred')}
                </div>
              )}
            </div>
          )}
          {snap?.contextTokens !== undefined && snap?.contextMax !== undefined && (
            <div className="zy-tools-context">
              {t('tools.context', {
                used: num(snap.contextTokens),
                max: num(snap.contextMax)
              })}
            </div>
          )}
          <ContextBreakdown parts={snap?.contextParts} files={snap?.memoryFiles} />

          {/* Кто чей файл правит — это человек должен знать ДО нажатия. */}
          <div className="zy-tools-foot">{t('tools.writesConfig')}</div>

          {/*
            Скиллы — вторая половина той же цены. MCP-серверы и скиллы платят из
            одного окна контекста, поэтому и живут на одной вкладке: решение
            «что выключить» человек принимает про весь оброк сразу.
          */}
          {snap?.skills && chosen && engine && (
            <SkillsPanel
              engine={engine}
              requestId={chosen.id}
              skills={snap.skills}
              stale={stale}
              busy={busy}
              used={chosen.skillsUsed ?? []}
              onNote={say}
              onChanged={() => void load(false, true)}
            />
          )}
        </>
      )}
    </section>
  )
}

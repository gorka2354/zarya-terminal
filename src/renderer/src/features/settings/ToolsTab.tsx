import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentEngine, McpServerRow, McpSnapshot } from '@shared/types'
import { t, useLang } from '@/lib/i18n'
import { useAiStore } from '@/features/ai/aiStore'
import { useUiStore } from '@/state/uiStore'
import { shortenPath } from '@/lib/ansi'
import { mcpLoginCommand } from '@shared/mcp'
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

export function ToolsTab(): React.JSX.Element {
  // Подписка на язык: без неё надписи сменились бы не в момент переключения, а
  // при следующей перерисовке по другой причине.
  useLang()

  const conversations = useAiStore((s) => s.conversations)
  const activeId = useAiStore((s) => s.activeId)
  const agentCaps = useUiStore((s) => s.agentCaps)

  // Беседы встроенного агента сюда не попадают: у него нет MCP вообще, и
  // строка «движок не умеет» про него была бы не отказом, а недоразумением.
  const panes = useMemo(
    () => conversations.filter((c) => c.engine !== 'builtin'),
    [conversations]
  )
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
              {snap?.at
                ? t('tools.staleAt', { time: timeOf(snap.at) })
                : t('tools.staleNone')}
            </div>
          )}
          {note.text && (
            <div className={`zy-tools-note${note.bad ? ' zy-tools-note--bad' : ''}`}>
              {note.text}
            </div>
          )}

          {!rows.length && !busy && (
            <div className="zy-tools-empty">
              {stale ? t('tools.staleEmpty') : t('tools.none')}
            </div>
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
                    s.tokens !== undefined && t('tools.tokens', { n: num(s.tokens) })
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
                {s.status === 'needs-auth' && !stale && (
                  <div className="zy-tools-login">
                    <code className="zy-tools-cmd">{mcpLoginCommand(s.name)}</code>
                    <button
                      type="button"
                      className="zy-tools-btn"
                      onClick={() => {
                        void navigator.clipboard.writeText(mcpLoginCommand(s.name))
                        say(t('tools.copied'))
                      }}
                    >
                      {t('tools.copy')}
                    </button>
                  </div>
                )}
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
            <div className="zy-tools-total">{t('tools.mcpTotal', { n: num(mcpTotal) })}</div>
          )}
          {snap?.contextTokens !== undefined && snap?.contextMax !== undefined && (
            <div className="zy-tools-context">
              {t('tools.context', {
                used: num(snap.contextTokens),
                max: num(snap.contextMax)
              })}
            </div>
          )}

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

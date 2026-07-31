import { PANE_DRAG_CWD, PANE_DRAG_SESSION } from '@shared/types'
import type { DropSide } from '@shared/paneTree'
import { useEffect, useRef, useState } from 'react'
import { XtermView } from '@/terminal/XtermView'
import { MissionFeed } from './MissionFeed'
import { AgentBar } from './AgentBar'
import { getTerminal } from '@/terminal/terminalRegistry'
import { closePaneAsking, toggleMaximizePane } from '@/actions/panes'
import { focusPane } from '@/terminal/paneFocus'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { isRaw, setRaw, useUiStore } from '@/state/uiStore'
import { useContextMenu } from './ContextMenu'
import { Icon } from './Icon'

interface Props {
  sessionId: string
  active: boolean
  visible: boolean
}

/**
 * К какому ребру панели ближе курсор — туда и встанет принесённая.
 *
 * Считается по ДОЛЯМ, а не по пикселям: панель в сетке 2×2 вчетверо меньше
 * окна, и фиксированная кромка в ней заняла бы половину. Ничья решается в
 * пользу горизонтали — колонки для CLI привычнее строк.
 */
function sideAt(el: HTMLElement, x: number, y: number): DropSide {
  const r = el.getBoundingClientRect()
  const fx = (x - r.left) / (r.width || 1)
  const fy = (y - r.top) / (r.height || 1)
  const dist = [
    { side: 'left' as const, d: fx },
    { side: 'right' as const, d: 1 - fx },
    { side: 'top' as const, d: fy },
    { side: 'bottom' as const, d: 1 - fy }
  ]
  return dist.reduce((best, cur) => (cur.d < best.d ? cur : best)).side
}

export function TerminalPane({ sessionId, active, visible }: Props): React.JSX.Element {
  const store = useSessionsStore.getState()
  const searchOpenFor = useUiStore((s) => s.searchOpenFor)
  const rightClickBehavior = useSettingsStore((s) => s.settings.terminal.rightClickBehavior)
  const { menu, open } = useContextMenu()
  const raw = useUiStore((s) => isRaw(s, sessionId))
  // Разворот — по своей вкладке: чужая развёрнутая панель этой ничего не говорит.
  const maximized = useUiStore((s) => {
    const tab = useSessionsStore.getState().tabs.find((t) => listLeaves(t.layout).includes(sessionId))
    return !!tab && s.maximizedByTab[tab.id] === sessionId
  })
  /** Ребро, к которому встанет принесённая панель, пока её держат над этой. */
  const [dropSide, setDropSide] = useState<DropSide | null>(null)
  // Соседи считаются по СВОЕЙ вкладке, а не по активной: панель скрытой вкладки
  // иначе приглушалась бы по чужой раскладке.
  const multiPane = useSessionsStore((s) => {
    const tab = s.tabs.find((t) => listLeaves(t.layout).includes(sessionId))
    return tab ? tab.layout.type !== 'leaf' : false
  })

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const handle = getTerminal(sessionId)
    if (rightClickBehavior === 'paste') {
      void navigator.clipboard.readText().then((t) => t && handle?.term.paste(t))
      return
    }
    const hasSelection = !!handle?.term.getSelection()
    open(e.clientX, e.clientY, [
      {
        label: 'Копировать',
        hint: 'Ctrl+Shift+C',
        disabled: !hasSelection,
        onClick: () => {
          const sel = handle?.term.getSelection()
          if (sel) void navigator.clipboard.writeText(sel)
        }
      },
      {
        label: 'Вставить',
        hint: 'Ctrl+Shift+V',
        onClick: () => void navigator.clipboard.readText().then((t) => t && handle?.term.paste(t))
      },
      { separator: true },
      {
        label: 'Найти в терминале',
        hint: 'Ctrl+Shift+F',
        onClick: () => useUiStore.getState().set({ searchOpenFor: sessionId })
      },
      {
        label: 'Очистить',
        hint: 'Ctrl+Shift+K',
        onClick: () => handle?.term.clear()
      },
      { separator: true },
      {
        label: 'Разделить вправо',
        hint: 'Ctrl+Shift+D',
        onClick: () => void store.splitActive('row')
      },
      {
        label: 'Разделить вниз',
        hint: 'Ctrl+Shift+S',
        onClick: () => void store.splitActive('col')
      },
      {
        label: maximized ? 'Свернуть к раскладке' : 'Развернуть на всю вкладку',
        onClick: () => toggleMaximizePane(sessionId)
      },
      {
        // Убрать панель с разделённого экрана, не убивая её процесс.
        label: 'Вынести в отдельную вкладку',
        hint: 'или перетащи шапку в список',
        disabled: !multiPane,
        onClick: () => store.detachPane(sessionId)
      },
      { separator: true },
      {
        // Спрашиваем про несохранённый текст: закрыть панель с недописанным
        // запросом молча — то же, что закрыть редактор без вопроса.
        label: 'Закрыть панель',
        danger: true,
        onClick: () => void closePaneAsking(sessionId)
      }
    ])
  }

  return (
    <div
      className={`zy-pane${active ? ' zy-pane--focused' : multiPane ? ' zy-pane--dim' : ''}${dropSide ? ' zy-pane--drop' : ''}`}
      // Чья это панель — видно в разметке. Нужно прогонам: «строка сайдбара
      // указывает на ЭТУ панель» иначе проверяется догадкой по порядку.
      data-session={sessionId}
      // Рамка и адресат клавиш — ОДНА величина: активная сессия вкладки. Если
      // однажды они разойдутся, рамка начнёт врать о том, куда уйдёт Enter, —
      // а это одобрение запуска команды (см. features/ai/keyRouter).
      title={multiPane && active ? 'Активная панель — сюда уходят Enter и Esc' : undefined}
      onMouseDown={() => {
        if (!active) store.setActiveSession(sessionId)
      }}
      onContextMenu={onContextMenu}
      // Бросок проекта из сайдбара — новая панель рядом, в этой папке. Тип
      // данных свой: файлы обрабатывает строка ввода, и пути не должны
      // путаться с вложениями.
      // Куда именно встанет принесённая панель, решает БЛИЖАЙШЕЕ РЕБРО: пока
      // сторона не спрашивалась, всё вставало справа, и человек, целившийся в
      // левый край, получал панель не там, куда показывал. Ребро подсвечивается
      // до отпускания — иначе выбор виден только по результату.
      onDragOver={(e) => {
        const kinds = e.dataTransfer.types
        if (!kinds.includes(PANE_DRAG_CWD) && !kinds.includes(PANE_DRAG_SESSION)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = kinds.includes(PANE_DRAG_SESSION) ? 'move' : 'copy'
        setDropSide(sideAt(e.currentTarget as HTMLElement, e.clientX, e.clientY))
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropSide(null)
      }}
      onDrop={(e) => {
        const moved = e.dataTransfer.getData(PANE_DRAG_SESSION)
        const cwd = e.dataTransfer.getData(PANE_DRAG_CWD)
        if (!moved && !cwd) return
        e.preventDefault()
        e.stopPropagation()
        const side = sideAt(e.currentTarget as HTMLElement, e.clientX, e.clientY)
        setDropSide(null)
        if (moved) {
          // Уже открытый терминал переезжает сюда: новый не создаём.
          store.movePaneNextTo(moved, sessionId, side)
          return
        }
        // Делим ИМЕННО ту панель, на которую бросили, и с той стороны, куда
        // показали: иначе новая появлялась бы у активной и всегда справа.
        void store.splitBeside(sessionId, side, cwd)
      }}
    >
      <PaneHeader sessionId={sessionId} maximized={maximized} multiPane={multiPane} />
      {/* Половина панели, которую займёт принесённая: выбор виден до броска. */}
      {dropSide && <div className={`zy-pane-drop-hint zy-pane-drop-hint--${dropSide}`} />}
      {/* Сцена — терминал и лента в одном слоистом контейнере. Лента лежит
          абсолютным слоем, и без этой обёртки она накрыла бы строку ввода
          собой, как накрыла рамку панели. */}
      <div className="zy-pane-stage">
        <XtermView sessionId={sessionId} active={active} visible={visible} />
      {/* Лента живёт ВНУТРИ панели, а не поверх всей рабочей области. Раньше она
          была непрозрачным слоем на всё окно: в блочном режиме сплитов не было
          видно вообще — четыре панели существовали, но человек видел одну ленту.
          Слой позиционируется по .zy-pane (position: relative), заголовок панели
          остаётся над ним. */}
        {!raw && <MissionFeed sessionId={sessionId} />}
      </div>
      {/* Своя строка ввода: у каждой панели свой разговор, свой ввод и свой
          статус — иначе это не CLI, а один разговор на четыре терминала. */}
      {!raw && <AgentBar paneSessionId={sessionId} />}
      {searchOpenFor === sessionId && <TermSearchBar sessionId={sessionId} />}
      {menu}
    </div>
  )
}

/**
 * Thin instrument-panel strip above the xterm surface: "★ CLI-АГЕНТ · ЗАРЯ"
 * mark, the pane's own cwd, split + search shortcuts. One per pane (not per
 * split gutter) so every terminal keeps its own working-directory readout.
 */
function PaneHeader({
  sessionId,
  maximized,
  multiPane
}: {
  sessionId: string
  maximized: boolean
  multiPane: boolean
}): React.JSX.Element {
  const cwd = useSessionsStore((s) => s.sessions[sessionId]?.cwd)
  const searchOpenFor = useUiStore((s) => s.searchOpenFor)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '6px 10px',
        flexShrink: 0,
        background: 'color-mix(in srgb, var(--panel) 60%, transparent)',
        borderBottom: '1px solid var(--border)'
      }}
    >
      {/* Зона хватания: панель таскается за свою шапку. Бросок на другую панель
          переносит её туда, бросок в список слева — выносит в отдельный рабочий
          стол. До этого панель не хваталась вовсе, и убрать лишний CLI с
          разделённого экрана можно было только убив процесс. */}
      <div
        className="zy-pane-grip"
        title="Перетащи: на другую панель — перенести, в список слева — вынести в отдельную вкладку"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_DRAG_SESSION, sessionId)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--accent)', flexShrink: 0 }}>
          <Icon name="star" size={12} />
        </span>
        <span
          style={{
            fontFamily: 'var(--font-tech)',
            fontSize: 13,
            letterSpacing: '0.1em',
            color: 'var(--accent)',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
        >
          CLI-АГЕНТ · ЗАРЯ
        </span>
        {cwd && (
          <span
            title={cwd}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--fg-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0
            }}
          >
            {cwd}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <button
          className="zy-icon-btn"
          title="Вернуться к блокам (Warp-фид)"
          onClick={() => setRaw(sessionId, false)}
        >
          <Icon name="sessions" size={13} />
        </button>
        <button
          className="zy-icon-btn"
          title="Разделить вправо"
          onClick={() => void useSessionsStore.getState().splitActive('row')}
        >
          <Icon name="split-h" size={13} />
        </button>
        {/* Путь назад из «во весь экран» обязан быть там же, где сама панель:
            сайдбар бывает закрыт, и другого выхода тогда не остаётся. */}
        {(multiPane || maximized) && (
          <button
            className={`zy-icon-btn${maximized ? ' zy-icon-btn--active' : ''}`}
            title={maximized ? 'Свернуть к раскладке' : 'Развернуть на всю вкладку'}
            onClick={() => toggleMaximizePane(sessionId)}
          >
            <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
          </button>
        )}
        <button
          className={`zy-icon-btn${searchOpenFor === sessionId ? ' zy-icon-btn--active' : ''}`}
          title="Найти в терминале"
          onClick={() =>
            useUiStore
              .getState()
              .set({ searchOpenFor: searchOpenFor === sessionId ? null : sessionId })
          }
        >
          <Icon name="search" size={13} />
        </button>
      </div>
    </div>
  )
}

function TermSearchBar({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const close = (): void => {
    getTerminal(sessionId)?.search.clearDecorations()
    useUiStore.getState().set({ searchOpenFor: null })
    // Не в скрытое поле xterm: оттуда голый Enter перестаёт одобрять гейт —
    // диспетчер считает его «чужим полем» (см. paneFocus / features/ai/keyRouter).
    focusPane(sessionId)
  }

  const find = (dir: 1 | -1): void => {
    const handle = getTerminal(sessionId)
    if (!handle || !query) return
    const opts = {
      decorations: { matchOverviewRuler: '#ff8a4c', activeMatchColorOverviewRuler: '#ffb86b' }
    }
    if (dir === 1) handle.search.findNext(query, opts)
    else handle.search.findPrevious(query, opts)
  }

  return (
    <div className="zy-searchbar">
      <input
        ref={inputRef}
        value={query}
        placeholder="Поиск…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? -1 : 1)
          if (e.key === 'Escape') close()
        }}
      />
      <button className="zy-icon-btn" title="Назад (Shift+Enter)" onClick={() => find(-1)}>
        <Icon name="chevron-up" size={13} />
      </button>
      <button className="zy-icon-btn" title="Далее (Enter)" onClick={() => find(1)}>
        <Icon name="chevron-down" size={13} />
      </button>
      <button className="zy-icon-btn" title="Закрыть (Esc)" onClick={close}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

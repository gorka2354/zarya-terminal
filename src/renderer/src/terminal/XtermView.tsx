import { t } from '@/lib/i18n'
import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { closePaneAsking } from '@/actions/panes'
import { focusPane } from './paneFocus'
import { useSettingsStore } from '@/state/settingsStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { isRaw, setRaw, useUiStore } from '@/state/uiStore'
import { getTheme, toXtermTheme } from '@/features/themes/themes'
import { shouldBypassTerminal } from '@/features/palette/keybindings'
import { openFileInEditor } from '@/features/editor/editorBridge'
import { BlockEngine } from './blockEngine'
import { terminalOptionsFrom, applyTerminalOptions } from './terminalOptions'
import {
  getTerminal,
  isLayoutDragging,
  registerTerminal,
  takePendingRestore
} from './terminalRegistry'
import { findPathsInLine, resolveAgainstCwd } from './termLinks'
import { suggestFor } from './historyCache'

interface Props {
  sessionId: string
  /** Pane is the active one within its tab. */
  active: boolean
  /** Tab is visible. */
  visible: boolean
}

interface Ghost {
  text: string
  left: number
  top: number
}

export const XtermView = memo(function XtermView({
  sessionId,
  active,
  visible
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const ghostRef = useRef<{ full: string; typed: string } | null>(null)
  // True while «Терминал» mode was entered automatically by a full-screen (alt
  // buffer) program — so we can return to «Блоки» when it exits, without ever
  // yanking the user out of a Терминал they opened by hand.
  const autoRawRef = useRef(false)
  const shadowRef = useRef<{ buf: string; reliable: boolean }>({ buf: '', reliable: true })
  const session = useSessionsStore((s) => s.sessions[sessionId])
  const settings = useSettingsStore((s) => s.settings)
  const rawTerminal = useUiStore((s) => isRaw(s, sessionId))
  const status = session?.status

  // ------------------------------------------------------------- lifecycle
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const s = useSettingsStore.getState().settings
    const theme = getTheme(s.appearance.themeId)
    const term = new Terminal({
      allowProposedApi: true,
      ...terminalOptionsFrom(s.appearance, s.terminal.scrollback),
      theme: toXtermTheme(theme),
      fontWeightBold: '600',
      minimumContrastRatio: 1,
      scrollOnUserInput: true,
      // In «Блоки» mode the terminal is display-only (single input is the
      // ask-agent bar). In «Терминал» mode stdin is enabled so you can type
      // directly and run interactive tools (vim / claude / ssh). Toggled live.
      disableStdin: !isRaw(useUiStore.getState(), sessionId)
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    const serialize = new SerializeAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(serialize)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        window.zarya.app.openExternal(uri)
      })
    )

    const initialCwd = useSessionsStore.getState().sessions[sessionId]?.cwd ?? ''
    const engine = new BlockEngine(term, sessionId, initialCwd)

    // Dev HMR can re-run this effect for a live session — never stack a second
    // xterm DOM inside the same container.
    container.replaceChildren()
    term.open(container)

    if (s.terminal.webgl) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // DOM renderer fallback
      }
    }

    // Clickable file paths -> editor
    term.registerLinkProvider({
      provideLinks(y, callback) {
        try {
          const line = term.buffer.active.getLine(y - 1)
          if (!line) return callback(undefined)
          const text = line.translateToString(true)
          const matches = findPathsInLine(text)
          if (!matches.length) return callback(undefined)
          callback(
            matches.map((m) => ({
              range: { start: { x: m.start, y }, end: { x: m.end, y } },
              text: text.slice(m.start - 1, m.end),
              activate: () => {
                const full = resolveAgainstCwd(m.path, engine.currentCwd)
                void window.zarya.fs.stat(full).then((st) => {
                  if (st?.exists && !st.isDir) openFileInEditor(full, m.line)
                  else if (st?.exists && st.isDir) {
                    useUiStore.getState().setSidebar('files')
                  }
                })
              }
            }))
          )
        } catch {
          callback(undefined)
        }
      }
    })

    // ---------------------------------------------------------- ghost text
    const clearGhost = (): void => {
      ghostRef.current = null
      setGhost(null)
    }

    const updateGhost = (): void => {
      if (!useSettingsStore.getState().settings.blocks.autosuggest) return clearGhost()
      const shadow = shadowRef.current
      if (!shadow.reliable || !engine.inputPhase || shadow.buf.length < 2) return clearGhost()
      const suggestion = suggestFor(shadow.buf)
      if (!suggestion) return clearGhost()
      try {
        const core = (
          term as unknown as {
            _core: {
              _renderService: {
                dimensions: { css: { cell: { width: number; height: number } } }
              }
            }
          }
        )._core
        const cell = core._renderService.dimensions.css.cell
        const buf = term.buffer.active
        const left = buf.cursorX * cell.width
        const top = buf.cursorY * cell.height
        ghostRef.current = { full: suggestion, typed: shadow.buf }
        setGhost({ text: suggestion.slice(shadow.buf.length), left, top })
      } catch {
        clearGhost()
      }
    }

    engine.onPhaseChange = (phase) => {
      shadowRef.current = { buf: '', reliable: true }
      if (phase !== 'input') clearGhost()
    }

    // ------------------------------------------------------------ user input
    const dataDisp = term.onData((data) => {
      window.zarya.pty.write(sessionId, data)
      const shadow = shadowRef.current
      if (engine.inputPhase) {
        if (data === '\r' || data === '\x03') {
          shadowRef.current = { buf: '', reliable: true }
          clearGhost()
        } else if (data === '\x7f') {
          shadow.buf = shadow.buf.slice(0, -1)
          updateGhost()
        } else if (data.startsWith('\x1b')) {
          shadow.reliable = false
          clearGhost()
        } else if (!/[\x00-\x1f]/.test(data)) {
          shadow.buf += data
          updateGhost()
        } else {
          shadow.reliable = false
          clearGhost()
        }
      }
    })

    /**
     * Единственная дверь для вставки — вместе с вопросом о многострочном тексте.
     *
     * Вопрос жил только здесь, а сюда приходил один путь из четырёх: Ctrl+Shift+V.
     * Ctrl+V, «Вставить» из меню и средняя кнопка мыши — это браузерное событие
     * `paste`, и оно шло мимо, прямо в оболочку. Настройка обещала защиту, а
     * текст с переносами выполнялся сразу — из тех обещаний, после которых
     * настройкам перестают верить.
     */
    const pasteChecked = (text: string): void => {
      if (!text) return
      const st = useSettingsStore.getState().settings
      if (
        st.terminal.pasteWarnMultiline &&
        text.includes('\n') &&
        !window.confirm(t('term.pasteAsk'))
      )
        return
      term.paste(text)
    }

    const pasteText = async (): Promise<void> => {
      try {
        pasteChecked(await navigator.clipboard.readText())
      } catch {
        // clipboard denied
      }
    }

    // Перехват в фазе погружения: xterm получит текст только после ответа
    // человека. Однострочную вставку не трогаем вовсе — она уходит своим путём,
    // без лишнего посредника.
    const onPasteCapture = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text') ?? ''
      if (!text.includes('\n')) return
      if (!useSettingsStore.getState().settings.terminal.pasteWarnMultiline) return
      e.preventDefault()
      e.stopPropagation()
      if (window.confirm(t('term.pasteAsk'))) term.paste(text)
    }
    container.addEventListener('paste', onPasteCapture, true)

    /*
     * Перетащенный файл ловит ПАНЕЛЬ, а не этот узел (см. TerminalPane).
     *
     * Здесь обработчик стоял первым и был мёртв: в блочном режиме — то есть по
     * умолчанию — лента лежит абсолютным непрозрачным слоем поверх терминала
     * (`.zy-mf`, z-index 2), и мышь до `.zy-term` не доходит вовсе. Событие
     * всплывало до корня окна, где значит «открой вкладку в этой папке», —
     * ровно то, от чего уходили.
     */

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Accept ghost suggestion
      if (e.key === 'ArrowRight' && ghostRef.current) {
        const g = ghostRef.current
        const remainder = g.full.slice(g.typed.length)
        if (remainder) {
          window.zarya.pty.write(sessionId, remainder)
          shadowRef.current = { buf: g.full, reliable: true }
          clearGhost()
          e.preventDefault()
          return false
        }
      }
      if (e.key === 'Escape' && ghostRef.current) {
        clearGhost()
        return true
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = term.getSelection()
        if (sel) {
          void navigator.clipboard.writeText(sel)
          e.preventDefault()
          return false
        }
        return true
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        void pasteText()
        e.preventDefault()
        return false
      }
      if (shouldBypassTerminal(e)) return false
      return true
    })

    const selDisp = term.onSelectionChange(() => {
      const st = useSettingsStore.getState().settings
      if (st.terminal.copyOnSelect) {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel)
      }
    })

    const bellDisp = term.onBell(() => {
      const st = useSettingsStore.getState().settings
      if (st.terminal.bell === 'visual') {
        container.classList.add('zy-bell')
        setTimeout(() => container.classList.remove('zy-bell'), 160)
      }
    })

    // Full-screen (TUI) programs — vim, htop, less, the claude/codex agents —
    // switch to the alternate screen buffer. Auto-flip to the live «Терминал»
    // view so arrows/prompts work, and return to «Блоки» when they exit.
    const bufDisp = term.buffer.onBufferChange((buf) => {
      const isAlt = buf.type === 'alternate'
      // Полноэкранная программа переключает ТОЛЬКО свою панель: раньше vim в
      // одной гасил ленты и строки ввода во всех остальных.
      if (isAlt && !isRaw(useUiStore.getState(), sessionId)) {
        autoRawRef.current = true
        setRaw(sessionId, true)
        requestAnimationFrame(() => term.focus())
      } else if (!isAlt && autoRawRef.current) {
        autoRawRef.current = false
        setRaw(sessionId, false)
      }
    })

    // ------------------------------------------------------------- sizing
    let fitRaf = 0
    // Последний размер, о котором знает оболочка. Пересчёт вызывается на каждое
    // наблюдение за размером, а ConPTY стоит дорого: сообщать ей одно и то же
    // по десять раз в секунду — значит платить ни за что.
    let told = { cols: 0, rows: 0 }
    const doFit = (): void => {
      cancelAnimationFrame(fitRaf)
      fitRaf = requestAnimationFrame(() => {
        if (!container.isConnected || container.clientWidth < 40) return
        // Пока тянут разделитель, размеры меняются каждый кадр. Перекладывать
        // буфер и дёргать консоль на каждый промежуточный размер незачем — по
        // отпусканию реестр вызовет пересчёт один раз (см. setLayoutDragging).
        if (isLayoutDragging()) return
        try {
          fit.fit()
          if (term.cols !== told.cols || term.rows !== told.rows) {
            told = { cols: term.cols, rows: term.rows }
            window.zarya.pty.resize(sessionId, term.cols, term.rows)
          }
        } catch {
          // ignore transient layout errors
        }
      })
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(container)

    // Replay restored scrollback before any live pty data.
    const restored = takePendingRestore(sessionId)
    if (restored) {
      term.write(restored)
      term.write(`\r\n\x1b[2m╌╌╌╌╌  ${t('term.restoredMark')}  ╌╌╌╌╌\x1b[0m\r\n`)
    }

    // A freshly spawned ConPTY shell begins with a full-screen repaint
    // (clear + cursor jumps over every row) which visually wipes the replayed
    // scrollback. For restored sessions we gate the live stream: drop
    // everything until the first OSC 133;A prompt mark, then continue from a
    // clean new line. Fallback (no shell integration): flush after a timeout
    // with clear/home sequences stripped.
    let restoredGate: { buf: string } | null = restored ? { buf: '' } : null
    let gateTimer: ReturnType<typeof setTimeout> | undefined
    const releaseGate = (): void => {
      if (!restoredGate) return
      const tail = restoredGate.buf
      restoredGate = null
      clearTimeout(gateTimer)
      term.write(tail.replace(/\x1b\[[0-9;]*[23]J/g, '').replace(/\x1b\[(?:1;1)?H/g, ''))
    }
    if (restoredGate) {
      gateTimer = setTimeout(releaseGate, 2500)
    }
    const writeLive = (data: string): void => {
      if (restoredGate) {
        restoredGate.buf += data
        const idx = restoredGate.buf.indexOf('\x1b]133;A')
        if (idx >= 0) {
          const tail = restoredGate.buf.slice(idx)
          restoredGate = null
          clearTimeout(gateTimer)
          term.write('\r\n')
          term.write(tail)
        } else if (restoredGate.buf.length > 65536) {
          releaseGate()
        }
        return
      }
      term.write(data)
    }

    // ------------------------------------------------------------ register
    registerTerminal(sessionId, {
      term,
      engine,
      search,
      write: writeLive,
      serialize: (maxLines) => serialize.serialize({ scrollback: maxLines }),
      fit: doFit,
      focus: () => term.focus(),
      dispose: () => {
        engine.dispose()
        term.dispose()
      }
    })

    doFit()

    return () => {
      ro.disconnect()
      cancelAnimationFrame(fitRaf)
      clearTimeout(gateTimer)
      container.removeEventListener('paste', onPasteCapture, true)
      dataDisp.dispose()
      selDisp.dispose()
      bellDisp.dispose()
      bufDisp.dispose()
      // Terminal itself is disposed via the registry when the session closes.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Live option updates from settings
  useEffect(() => {
    const handle = getTerminal(sessionId)
    if (!handle) return
    const t = handle.term
    const a = settings.appearance
    applyTerminalOptions(t, a, settings.terminal.scrollback)
    t.options.theme = toXtermTheme(getTheme(a.themeId))
    handle.fit()
  }, [sessionId, settings])

  // Refit + focus when becoming visible/active
  useEffect(() => {
    if (!visible) return
    const handle = getTerminal(sessionId)
    handle?.fit()
    // Курсор — туда, где в этой панели печатают: в блочном режиме это строка
    // ввода, в сыром — сам терминал. Безусловный фокус в скрытое поле xterm
    // делал голый Enter «чужим полем» для гейта: рамка обещала «сюда уйдёт
    // Enter», а одобрение не срабатывало (см. paneFocus / features/ai/keyRouter).
    if (active) focusPane(sessionId)
  }, [visible, active, sessionId])

  // Toggle interactive stdin live; entering «Терминал» mode re-fits and focuses
  // so you can type into vim/claude/ssh right away.
  useEffect(() => {
    const handle = getTerminal(sessionId)
    if (!handle) return
    handle.term.options.disableStdin = !rawTerminal
    handle.fit()
    if (!visible || !active) return
    if (rawTerminal) {
      requestAnimationFrame(() => handle.focus())
      return
    }
    // Обратный переход тоже нужен: vim закрылся, сырой режим снялся, строка
    // ввода вернулась вместе с набранным — а каретка оставалась в поле xterm,
    // где ввод выключен. Печатать было некуда, и это не объяснялось ничем.
    focusPane(sessionId)
  }, [rawTerminal, visible, active, sessionId])

  const pad = settings.appearance.terminalPadding

  return (
    /*
     * ПОД ЛЕНТОЙ ТЕРМИНАЛ НЕ РИСУЕТСЯ.
     *
     * В блочном режиме лента лежит поверх непрозрачным слоем, а xterm под ней
     * остаётся живым и продолжает перерисовывать свои канвасы — курсор мигает,
     * вывод идёт. Композитор перерисовывает регион нижнего слоя, лента в этот
     * регион не попадает, и на её месте остаётся голый фон терминала: широкая
     * полоса поверх текста, которая исчезает сама при следующей перерисовке.
     * Владелец приносил её трижды, и трижды она была не тем, на что похожа.
     *
     * `visibility: hidden` гасит отрисовку, но СОХРАНЯЕТ размеры — xterm.js
     * продолжает мерить себя правильно, и переключение в сырой режим не требует
     * пересборки. `display: none` так не умеет: он обнуляет размеры, и терминал
     * возвращается с испорченной геометрией.
     */
    <div
      className="zy-term-wrap"
      style={{ padding: pad, visibility: rawTerminal ? 'visible' : 'hidden' }}
    >
      <div ref={containerRef} className="zy-term" />
      {ghost && (
        <div
          className="zy-ghost"
          style={{ left: ghost.left + pad, top: ghost.top + pad }}
          aria-hidden
        >
          {ghost.text}
          <span className="zy-ghost-hint">→</span>
        </div>
      )}
      {status === 'exited' && (
        <div className="zy-term-exited">
          <div className="zy-term-exited-card">
            <div className="zy-term-exited-title">
              {t('term.exited', {
                code:
                  session?.exitCode !== undefined
                    ? t('term.exitCode', { code: session.exitCode })
                    : ''
              })}
            </div>
            <div className="zy-row">
              <button
                className="zy-btn zy-btn--accent"
                onClick={() => void useSessionsStore.getState().restartSession(sessionId)}
              >
                {t('term.restart')}
              </button>
              <button className="zy-btn" onClick={() => void closePaneAsking(sessionId)}>
                {t('term.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

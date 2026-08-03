import { registerActions } from '@/lib/actionRegistry'
import { onLangChange, t } from '@/lib/i18n'
import { closePaneAsking, closeTabAsking } from '@/actions/panes'
import { openFolderAsPane, openFolderAsTab } from '@/actions/projects'
import { useBlocksStore } from '@/state/blocksStore'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { getSettings, useSettingsStore } from '@/state/settingsStore'
import { activeAgentCaps, isRaw, setRaw, useUiStore } from '@/state/uiStore'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { aiOpenCommandBar, aiOpenPanel } from '@/features/ai/aiBridge'
import { setIdeMode, toggleIdeMode } from '@/features/ide/ideMode'

function activeSessionId(): string | null {
  return useSessionsStore.getState().activeSessionId()
}

/** Беседа активной панели — та, которой касаются действия про агента. */
function activeConversation(): ReturnType<typeof convForSession> {
  const sid = activeSessionId()
  return sid ? convForSession(useAiStore.getState(), sid) : undefined
}

/** Автопилот, запомненный за панелью, — до того как в ней завелась беседа. */
function paneBypassOf(sessionId: string | null): boolean {
  return !!sessionId && !!useAiStore.getState().bypassBySession[sessionId]
}

function withActiveTerm(fn: (handle: NonNullable<ReturnType<typeof getTerminal>>) => void): void {
  const id = activeSessionId()
  if (!id) return
  const handle = getTerminal(id)
  if (handle) fn(handle)
}

let registered = false

export function registerCoreActions(): void {
  if (registered) return
  registered = true
  // Названия команд — такой же текст интерфейса, как всё остальное. Реестр
  // собирается один раз при старте, поэтому пересобираем его на смену языка:
  // иначе палитра навсегда осталась бы на языке, который был при запуске.
  onLangChange(() => {
    registered = false
    registerCoreActions()
  })
  const ui = useUiStore.getState()
  const sessions = useSessionsStore.getState()

  registerActions([
    // ------------------------------------------------------------------ app
    {
      id: 'app.command-palette',
      title: t('act.palette'),
      category: t('act.cat.app'),
      run: () => ui.set({ paletteOpen: true })
    },
    {
      id: 'app.quick-open',
      title: t('act.quickOpen'),
      category: t('act.cat.app'),
      run: () => ui.set({ quickOpenOpen: true })
    },
    {
      id: 'app.settings',
      title: t('act.settings'),
      category: t('act.cat.app'),
      run: () => ui.set({ settingsOpen: true })
    },
    {
      id: 'app.toggle-sidebar',
      title: t('act.sidebar'),
      category: t('act.cat.app'),
      run: () => {
        const st = useUiStore.getState()
        // Разворачиваем ТОТ раздел, что был открыт. Раньше здесь стояло
        // «сессии» жёстко: человек, работавший с файлами или историей, после
        // Ctrl+B дважды оказывался не там, где был, и искал своё место заново.
        ui.set({ sidebarView: st.sidebarView ? null : st.lastSidebarView })
      }
    },
    {
      id: 'app.toggle-ide',
      title: t('act.ide'),
      category: t('act.cat.app'),
      keywords: t('act.ideKw'),
      run: () => toggleIdeMode()
    },
    {
      id: 'app.toggle-ai-panel',
      title: t('act.idePanel'),
      category: 'IDE',
      run: () => {
        if (!getSettings().ideMode) setIdeMode(true)
        const open = useUiStore.getState().aiPanelOpen
        if (open) ui.set({ aiPanelOpen: false })
        else aiOpenPanel()
      }
    },
    {
      id: 'app.launch-pad',
      title: t('act.launchpad'),
      category: 'AI',
      keywords: t('act.launchpadKw'),
      run: () => ui.set({ launchPadOpen: !useUiStore.getState().launchPadOpen })
    },
    {
      id: 'ai.command-bar',
      title: t('act.aiCommand'),
      category: 'AI',
      run: () => {
        const id = activeSessionId()
        if (id) aiOpenCommandBar(id)
      }
    },
    {
      id: 'history.search',
      title: t('act.history'),
      category: t('act.cat.history'),
      run: () => ui.set({ historyOverlayOpen: true })
    },
    {
      id: 'blocks.panel',
      title: t('act.blocksPanel'),
      category: t('act.cat.blocks'),
      run: () => ui.set({ blocksPanelOpen: !useUiStore.getState().blocksPanelOpen })
    },

    // ----------------------------------------------------------------- tabs
    {
      id: 'tab.new',
      title: t('act.newTab'),
      category: t('act.cat.tabs'),
      run: () => void sessions.newTab()
    },
    {
      id: 'tab.new-in-folder',
      title: t('act.newTabFolder'),
      category: t('act.cat.tabs'),
      keywords: t('act.newTabFolderKw'),
      run: () => void openFolderAsTab()
    },
    {
      id: 'tab.close',
      title: t('act.closeTab'),
      category: t('act.cat.tabs'),
      run: () => {
        const { activeTabId } = useSessionsStore.getState()
        // Через спрашивающую обёртку: горячая клавиша не должна выбрасывать
        // недописанный запрос агенту молча, раз крестик в сайдбаре спрашивает.
        if (activeTabId) void closeTabAsking(activeTabId)
      }
    },
    {
      id: 'tab.next',
      title: t('act.nextTab'),
      category: t('act.cat.tabs'),
      run: () => sessions.nextTab(1)
    },
    {
      id: 'tab.prev',
      title: t('act.prevTab'),
      category: t('act.cat.tabs'),
      run: () => sessions.nextTab(-1)
    },

    /*
     * ---------------------------------------------------------------- агент
     *
     * Всё, что появилось за последние выпуски, жило только в баре: автопилот,
     * ultracode, перечитывание скиллов, здоровье инструментов. Палитра — то
     * место, где человек ищет функцию по названию, и её отсутствие там значит
     * «функции нет» для всех, кто не заметил нужный чип глазами.
     *
     * Каждое действие спрашивает у движка, умеет ли он это: `enabled` прячет
     * то, чего в текущем движке не существует, вместо кнопки, которая молча
     * ничего не сделает.
     */
    {
      id: 'agent.toggle-bypass',
      title: t('act.bypass'),
      category: t('act.cat.agent'),
      keywords: t('act.bypassKw'),
      enabled: () => activeAgentCaps()?.bypass === true,
      run: () => {
        const conv = activeConversation()
        const sid = activeSessionId()
        const on = conv ? !conv.bypass : !paneBypassOf(sid)
        if (conv) useAiStore.getState().setBypass(conv.id, on)
        else if (sid) useAiStore.getState().setPaneBypass(sid, on)
        useUiStore.getState().toast(t(on ? 'act.bypassOn' : 'act.bypassOff'), on ? 'error' : 'info')
      }
    },
    {
      id: 'agent.toggle-ultracode',
      title: t('act.ultracode'),
      category: t('act.cat.agent'),
      enabled: () => !!activeAgentCaps()?.vendorFlags?.some((f) => f.key === 'ultracode'),
      run: () => {
        const ui = useUiStore.getState()
        const on = !ui.ultracode
        ui.set({ ultracode: on })
        const conv = activeConversation()
        if (conv && conv.engine !== 'builtin')
          window.zarya.agent.setVendorFlag(conv.engine, conv.id, 'ultracode', on)
        ui.toast(t(on ? 'act.ultracodeOn' : 'act.ultracodeOff'), 'info')
      }
    },
    {
      id: 'agent.tools',
      title: t('act.tools'),
      category: t('act.cat.agent'),
      keywords: t('act.toolsKw'),
      run: () => useUiStore.getState().set({ settingsOpen: true, settingsTab: 'tools' })
    },
    {
      id: 'agent.reload-extras',
      title: t('act.reloadExtras'),
      category: t('act.cat.agent'),
      keywords: t('act.reloadExtrasKw'),
      run: async () => {
        const conv = activeConversation()
        const ui = useUiStore.getState()
        if (!conv || conv.engine === 'builtin') {
          // Перечитывать нечего: живой беседы движка нет. Честнее сказать это,
          // чем сделать вид, что подхватили.
          ui.toast(t('extras.nothing'), 'info')
          return
        }
        const r = await window.zarya.agent.reloadExtras(conv.engine, conv.id)
        if (r?.unsupported) ui.toast(t('extras.unsupported'), 'info')
        else if (r?.ok)
          ui.toast(
            t('extras.done', { commands: r.commands?.length ?? 0, mcp: r.mcpServers?.length ?? 0 }),
            r.errors ? 'error' : 'success'
          )
        else ui.toast(t('extras.nothing'), 'info')
      }
    },

    // ------------------------------------------------------------- terminal
    {
      id: 'terminal.toggle-raw',
      title: t('act.mode'),
      category: t('act.cat.terminal'),
      keywords: t('act.modeKw'),
      run: () => {
        // Режим переключается у АКТИВНОЙ панели: соседние продолжают жить
        // своей жизнью, а не гаснут заодно.
        const id = activeSessionId()
        const raw = isRaw(useUiStore.getState(), id)
        setRaw(id, !raw)
        if (!raw) {
          if (id) setTimeout(() => getTerminal(id)?.focus(), 60)
        }
      }
    },
    {
      id: 'terminal.split-right',
      title: t('act.splitRight'),
      category: t('act.cat.terminal'),
      run: () => void sessions.splitActive('row')
    },
    {
      id: 'terminal.split-folder',
      title: t('act.splitFolder'),
      category: t('act.cat.terminal'),
      keywords: t('act.splitFolderKw'),
      // Сетка нужна для того, чтобы держать рядом РАЗНЫЕ проекты. Без этого
      // деление панели давало ещё один сеанс той же папки.
      run: () => {
        void openFolderAsPane()
      }
    },
    {
      id: 'terminal.split-down',
      title: t('act.splitDown'),
      category: t('act.cat.terminal'),
      run: () => void sessions.splitActive('col')
    },
    {
      id: 'terminal.close-pane',
      title: t('act.closePane'),
      category: t('act.cat.terminal'),
      run: () => {
        const id = activeSessionId()
        if (id) void closePaneAsking(id)
      }
    },
    {
      id: 'terminal.focus-next-pane',
      title: t('act.focusNext'),
      category: t('act.cat.terminal'),
      run: () => cyclePane(1)
    },
    {
      id: 'terminal.focus-prev-pane',
      title: t('act.focusPrev'),
      category: t('act.cat.terminal'),
      run: () => cyclePane(-1)
    },
    {
      id: 'terminal.clear',
      title: t('act.clear'),
      category: t('act.cat.terminal'),
      run: () => withActiveTerm((h) => h.term.clear())
    },
    {
      id: 'terminal.search',
      title: t('act.find'),
      category: t('act.cat.terminal'),
      run: () => {
        const id = activeSessionId()
        if (id) ui.set({ searchOpenFor: id })
      }
    },
    {
      id: 'terminal.copy',
      title: t('act.copy'),
      category: t('act.cat.terminal'),
      run: () =>
        withActiveTerm((h) => {
          const sel = h.term.getSelection()
          if (sel) void navigator.clipboard.writeText(sel)
        })
    },
    {
      id: 'terminal.paste',
      title: t('act.paste'),
      category: t('act.cat.terminal'),
      run: () =>
        withActiveTerm((h) => {
          void navigator.clipboard.readText().then((t) => t && h.term.paste(t))
        })
    },

    // --------------------------------------------------------------- blocks
    {
      id: 'blocks.prev',
      title: t('act.prevBlock'),
      category: t('act.cat.blocks'),
      run: () => withActiveTerm((h) => h.engine.jumpBlock(-1))
    },
    {
      id: 'blocks.next',
      title: t('act.nextBlock'),
      category: t('act.cat.blocks'),
      run: () => withActiveTerm((h) => h.engine.jumpBlock(1))
    },
    {
      id: 'blocks.copy-last-output',
      title: t('act.copyOutput'),
      category: t('act.cat.blocks'),
      run: () => {
        const id = activeSessionId()
        if (!id) return
        const last = useBlocksStore.getState().lastBlock(id)
        if (last?.output) {
          void navigator.clipboard.writeText(last.output)
          ui.toast(t('act.outputCopied'), 'success')
        }
      }
    },

    // ----------------------------------------------------------------- font
    {
      id: 'font.increase',
      title: t('act.fontUp'),
      category: t('act.cat.view'),
      run: () => bumpFont(1)
    },
    {
      id: 'font.decrease',
      title: t('act.fontDown'),
      category: t('act.cat.view'),
      run: () => bumpFont(-1)
    },
    {
      id: 'font.reset',
      title: t('act.fontReset'),
      category: t('act.cat.view'),
      run: () => void useSettingsStore.getState().update({ appearance: { fontSize: 14 } as never })
    }
  ])
}

function bumpFont(delta: number): void {
  const cur = useSettingsStore.getState().settings.appearance.fontSize
  const next = Math.min(28, Math.max(9, cur + delta))
  void useSettingsStore.getState().update({ appearance: { fontSize: next } as never })
}

function cyclePane(dir: 1 | -1): void {
  const s = useSessionsStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  if (!tab) return
  const leaves = listLeaves(tab.layout)
  if (leaves.length < 2) return
  const i = leaves.indexOf(tab.activeSessionId)
  const next = leaves[(i + dir + leaves.length) % leaves.length]
  s.setActiveSession(next)
  getTerminal(next)?.focus()
}

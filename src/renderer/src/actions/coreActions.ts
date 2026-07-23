import { registerActions } from '@/lib/actionRegistry'
import { useBlocksStore } from '@/state/blocksStore'
import { listLeaves, useSessionsStore } from '@/state/sessionsStore'
import { getSettings, useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTerminal } from '@/terminal/terminalRegistry'
import { aiOpenCommandBar, aiOpenPanel } from '@/features/ai/aiBridge'
import { setIdeMode, toggleIdeMode } from '@/features/ide/ideMode'

function activeSessionId(): string | null {
  return useSessionsStore.getState().activeSessionId()
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
  const ui = useUiStore.getState()
  const sessions = useSessionsStore.getState()

  registerActions([
    // ------------------------------------------------------------------ app
    {
      id: 'app.command-palette',
      title: 'Палитра команд',
      category: 'Приложение',
      run: () => ui.set({ paletteOpen: true })
    },
    {
      id: 'app.quick-open',
      title: 'Быстрое открытие файла',
      category: 'Приложение',
      run: () => ui.set({ quickOpenOpen: true })
    },
    {
      id: 'app.settings',
      title: 'Настройки',
      category: 'Приложение',
      run: () => ui.set({ settingsOpen: true })
    },
    {
      id: 'app.toggle-sidebar',
      title: 'Показать/скрыть сайдбар',
      category: 'Приложение',
      run: () => {
        const cur = useUiStore.getState().sidebarView
        ui.set({ sidebarView: cur ? null : 'sessions' })
      }
    },
    {
      id: 'app.toggle-ide',
      title: 'IDE-надстройка: вкл/выкл (Файлы · Редактор · Workflows · IDE-агент)',
      category: 'Приложение',
      keywords: 'ide редактор файлы workflows надстройка ide-агент editor',
      run: () => toggleIdeMode()
    },
    {
      id: 'app.toggle-ai-panel',
      title: 'IDE-агент: панель (второй пилот)',
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
      title: 'Пусковой комплекс (модель · тяга)',
      category: 'AI',
      keywords: 'launch pad model effort тяга двигатель поехали',
      run: () => ui.set({ launchPadOpen: !useUiStore.getState().launchPadOpen })
    },
    {
      id: 'ai.command-bar',
      title: 'AI: сгенерировать команду (натуральный язык)',
      category: 'AI',
      run: () => {
        const id = activeSessionId()
        if (id) aiOpenCommandBar(id)
      }
    },
    {
      id: 'history.search',
      title: 'История команд (все сессии)',
      category: 'История',
      run: () => ui.set({ historyOverlayOpen: true })
    },
    {
      id: 'blocks.panel',
      title: 'Панель блоков',
      category: 'Блоки',
      run: () => ui.set({ blocksPanelOpen: !useUiStore.getState().blocksPanelOpen })
    },

    // ----------------------------------------------------------------- tabs
    {
      id: 'tab.new',
      title: 'Новая вкладка',
      category: 'Вкладки',
      run: () => void sessions.newTab()
    },
    {
      id: 'tab.new-in-folder',
      title: 'Новый терминал в папке…',
      category: 'Вкладки',
      keywords: 'folder cwd папка проект open directory',
      run: () => {
        void window.zarya.app.pickDirectory().then((dir) => {
          if (dir) void sessions.newTab(undefined, dir)
        })
      }
    },
    {
      id: 'tab.close',
      title: 'Закрыть вкладку',
      category: 'Вкладки',
      run: () => {
        const { activeTabId } = useSessionsStore.getState()
        if (activeTabId) void sessions.closeTab(activeTabId)
      }
    },
    {
      id: 'tab.next',
      title: 'Следующая вкладка',
      category: 'Вкладки',
      run: () => sessions.nextTab(1)
    },
    {
      id: 'tab.prev',
      title: 'Предыдущая вкладка',
      category: 'Вкладки',
      run: () => sessions.nextTab(-1)
    },

    // ------------------------------------------------------------- terminal
    {
      id: 'terminal.toggle-raw',
      title: 'Режим: Терминал ⇄ Блоки',
      category: 'Терминал',
      keywords: 'raw interactive интерактивный warp фид блоки claude vim tui',
      run: () => {
        const raw = useUiStore.getState().rawTerminal
        ui.set({ rawTerminal: !raw })
        if (!raw) {
          const id = activeSessionId()
          if (id) setTimeout(() => getTerminal(id)?.focus(), 60)
        }
      }
    },
    {
      id: 'terminal.split-right',
      title: 'Разделить вправо',
      category: 'Терминал',
      run: () => void sessions.splitActive('row')
    },
    {
      id: 'terminal.split-down',
      title: 'Разделить вниз',
      category: 'Терминал',
      run: () => void sessions.splitActive('col')
    },
    {
      id: 'terminal.close-pane',
      title: 'Закрыть панель',
      category: 'Терминал',
      run: () => {
        const id = activeSessionId()
        if (id) void sessions.closeSession(id)
      }
    },
    {
      id: 'terminal.focus-next-pane',
      title: 'Фокус: следующая панель',
      category: 'Терминал',
      run: () => cyclePane(1)
    },
    {
      id: 'terminal.focus-prev-pane',
      title: 'Фокус: предыдущая панель',
      category: 'Терминал',
      run: () => cyclePane(-1)
    },
    {
      id: 'terminal.clear',
      title: 'Очистить терминал',
      category: 'Терминал',
      run: () => withActiveTerm((h) => h.term.clear())
    },
    {
      id: 'terminal.search',
      title: 'Найти в терминале',
      category: 'Терминал',
      run: () => {
        const id = activeSessionId()
        if (id) ui.set({ searchOpenFor: id })
      }
    },
    {
      id: 'terminal.copy',
      title: 'Копировать выделение',
      category: 'Терминал',
      run: () =>
        withActiveTerm((h) => {
          const sel = h.term.getSelection()
          if (sel) void navigator.clipboard.writeText(sel)
        })
    },
    {
      id: 'terminal.paste',
      title: 'Вставить',
      category: 'Терминал',
      run: () =>
        withActiveTerm((h) => {
          void navigator.clipboard.readText().then((t) => t && h.term.paste(t))
        })
    },

    // --------------------------------------------------------------- blocks
    {
      id: 'blocks.prev',
      title: 'Предыдущий блок',
      category: 'Блоки',
      run: () => withActiveTerm((h) => h.engine.jumpBlock(-1))
    },
    {
      id: 'blocks.next',
      title: 'Следующий блок',
      category: 'Блоки',
      run: () => withActiveTerm((h) => h.engine.jumpBlock(1))
    },
    {
      id: 'blocks.copy-last-output',
      title: 'Скопировать вывод последней команды',
      category: 'Блоки',
      run: () => {
        const id = activeSessionId()
        if (!id) return
        const last = useBlocksStore.getState().lastBlock(id)
        if (last?.output) {
          void navigator.clipboard.writeText(last.output)
          ui.toast('Вывод скопирован', 'success')
        }
      }
    },

    // ----------------------------------------------------------------- font
    {
      id: 'font.increase',
      title: 'Шрифт крупнее',
      category: 'Вид',
      run: () => bumpFont(1)
    },
    {
      id: 'font.decrease',
      title: 'Шрифт мельче',
      category: 'Вид',
      run: () => bumpFont(-1)
    },
    {
      id: 'font.reset',
      title: 'Шрифт по умолчанию',
      category: 'Вид',
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

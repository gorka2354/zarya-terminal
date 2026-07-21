import type { Settings } from './types'

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'app.command-palette': 'Ctrl+Shift+P',
  'app.quick-open': 'Ctrl+P',
  'app.settings': 'Ctrl+,',
  'app.toggle-ai-panel': 'Ctrl+Shift+A',
  'app.launch-pad': 'Ctrl+Alt+M',
  'app.toggle-sidebar': 'Ctrl+B',
  'ai.command-bar': 'Ctrl+I',
  'history.search': 'Ctrl+R',
  'tab.new': 'Ctrl+Shift+T',
  'tab.close': 'Ctrl+Shift+W',
  'tab.next': 'Ctrl+Tab',
  'tab.prev': 'Ctrl+Shift+Tab',
  'terminal.split-right': 'Ctrl+Shift+D',
  'terminal.split-down': 'Ctrl+Shift+S',
  'terminal.close-pane': 'Ctrl+Shift+X',
  'terminal.focus-next-pane': 'Alt+ArrowRight',
  'terminal.focus-prev-pane': 'Alt+ArrowLeft',
  'terminal.clear': 'Ctrl+Shift+K',
  'terminal.search': 'Ctrl+Shift+F',
  'terminal.copy': 'Ctrl+Shift+C',
  'terminal.paste': 'Ctrl+Shift+V',
  'blocks.prev': 'Ctrl+ArrowUp',
  'blocks.next': 'Ctrl+ArrowDown',
  'blocks.copy-last-output': 'Ctrl+Shift+O',
  'font.increase': 'Ctrl+=',
  'font.decrease': 'Ctrl+-',
  'font.reset': 'Ctrl+0'
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    themeId: 'zarya-cosmos',
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.35,
    cursorStyle: 'bar',
    cursorBlink: true,
    terminalPadding: 14,
    windowOpacity: 1,
    acrylic: false,
    uiDensity: 'cozy'
  },
  terminal: {
    scrollback: 10000,
    copyOnSelect: true,
    rightClickBehavior: 'menu',
    pasteWarnMultiline: true,
    webgl: true,
    defaultProfileId: 'auto',
    customProfiles: [],
    bell: 'visual',
    confirmCloseRunning: true
  },
  blocks: {
    enabled: true,
    separators: true,
    exitBadges: true,
    autosuggest: true
  },
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    baseUrl: '',
    effort: 'medium',
    temperature: 0.4,
    maxTokens: 4096,
    autoApprove: false,
    contextBlocks: 3,
    systemPromptExtra: ''
  },
  sessions: {
    restoreOnLaunch: 'workspace',
    autosaveSec: 20,
    scrollbackSaveLines: 2000
  },
  editor: {
    fontSize: 13,
    wordWrap: false,
    minimap: false,
    tabSize: 2
  },
  keybindings: DEFAULT_KEYBINDINGS,
  bookmarks: []
}

/** Ollama default endpoint (local inference). */
export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

/** Reasoning thrust (тяга) → temperature + maxTokens. */
export const EFFORT_TUNING: Record<string, { temperature: number; maxTokens: number; label: string }> = {
  low: { temperature: 0.15, maxTokens: 2048, label: 'НИЗКАЯ' },
  medium: { temperature: 0.4, maxTokens: 4096, label: 'СРЕДНЯЯ' },
  high: { temperature: 0.6, maxTokens: 6144, label: 'ВЫСОКАЯ' },
  max: { temperature: 0.85, maxTokens: 8192, label: 'МАКСИМУМ' }
}

export const AI_MODEL_PRESETS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5.2', 'gpt-5.2-mini', 'o4-mini'],
  ollama: [],
  'openai-compat': []
}

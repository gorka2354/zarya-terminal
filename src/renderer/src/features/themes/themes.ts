import type { ThemeDef } from '@shared/types'

/**
 * Theme engine. Applying a theme sets CSS variables on <html> and returns
 * xterm colors via toXtermTheme(). The signature themes are cosmic-
 * constructivist (deep space / Soviet red / brass gold); the extended
 * community pack is appended by themePack.ts.
 */

// ---------------------------------------------------------------------------
// Заря · Космос — signature cosmic-constructivist theme (default).
// ---------------------------------------------------------------------------
export const zaryaCosmos: ThemeDef = {
  id: 'zarya-cosmos',
  name: 'Заря · Космос',
  type: 'dark',
  ui: {
    bg: '#0a0e1a',
    bgElev1: '#10162a',
    bgElev2: '#192244',
    panel: '#080b16',
    border: 'rgba(224, 177, 90, 0.16)',
    borderStrong: 'rgba(224, 177, 90, 0.34)',
    fg: '#e9e4d6',
    fgDim: '#a8a18b',
    fgFaint: '#5c6180',
    accent: '#e2231a',
    accent2: '#e0b15a',
    accentGradient: 'linear-gradient(120deg, #e2231a 0%, #f0662e 52%, #e0b15a 100%)',
    danger: '#f0453a',
    success: '#5fb88a',
    warn: '#e0b15a'
  },
  terminal: {
    background: '#0a0e1a',
    foreground: '#e4dfd0',
    cursor: '#e0b15a',
    selectionBackground: '#e2231a44',
    black: '#141a2e',
    red: '#e2231a',
    green: '#6fbf8e',
    yellow: '#e0b15a',
    blue: '#5b8cf0',
    magenta: '#c77dff',
    cyan: '#4fd6d6',
    white: '#d7d2c2',
    brightBlack: '#4a5170',
    brightRed: '#ff5a4a',
    brightGreen: '#8fe0ac',
    brightYellow: '#f5ce7a',
    brightBlue: '#84abff',
    brightMagenta: '#dda9ff',
    brightCyan: '#7eeaea',
    brightWhite: '#f4f0e4'
  }
}

// ---------------------------------------------------------------------------
// Заря · Восток — red-dominant, deep maroon space.
// ---------------------------------------------------------------------------
export const zaryaVostok: ThemeDef = {
  id: 'zarya-vostok',
  name: 'Заря · Восток',
  type: 'dark',
  ui: {
    bg: '#120a0c',
    bgElev1: '#1d1013',
    bgElev2: '#2c161a',
    panel: '#0d0708',
    border: 'rgba(226, 35, 26, 0.20)',
    borderStrong: 'rgba(240, 102, 46, 0.40)',
    fg: '#f0e6d8',
    fgDim: '#b39a8f',
    fgFaint: '#7a5a56',
    accent: '#f0662e',
    accent2: '#e0b15a',
    accentGradient: 'linear-gradient(120deg, #e2231a 0%, #f0662e 100%)',
    danger: '#ff5a4a',
    success: '#7fb87f',
    warn: '#e0b15a'
  },
  terminal: {
    background: '#120a0c',
    foreground: '#f0e6d8',
    cursor: '#f0662e',
    selectionBackground: '#f0662e40',
    black: '#2c161a',
    red: '#e2231a',
    green: '#8bbf7a',
    yellow: '#e0b15a',
    blue: '#c98f6a',
    magenta: '#e08a5a',
    cyan: '#d6a06a',
    white: '#e8ddcf',
    brightBlack: '#7a5a56',
    brightRed: '#ff5a4a',
    brightGreen: '#a7d495',
    brightYellow: '#f5ce7a',
    brightBlue: '#e0a878',
    brightMagenta: '#f0a070',
    brightCyan: '#f0c088',
    brightWhite: '#fbf4e8'
  }
}

// ---------------------------------------------------------------------------
// Заря · Орбита — teal control-panel / oscilloscope retrofuturism.
// ---------------------------------------------------------------------------
export const zaryaOrbita: ThemeDef = {
  id: 'zarya-orbita',
  name: 'Заря · Орбита',
  type: 'dark',
  ui: {
    bg: '#05100f',
    bgElev1: '#0a1a18',
    bgElev2: '#0f2724',
    panel: '#030b0a',
    border: 'rgba(79, 214, 214, 0.16)',
    borderStrong: 'rgba(79, 214, 214, 0.34)',
    fg: '#d8ece8',
    fgDim: '#7fa8a2',
    fgFaint: '#3f5e59',
    accent: '#4fd6d6',
    accent2: '#e0b15a',
    accentGradient: 'linear-gradient(120deg, #2fb8c8 0%, #4fd6d6 60%, #e0b15a 100%)',
    danger: '#f0453a',
    success: '#5fd6a0',
    warn: '#e0b15a'
  },
  terminal: {
    background: '#05100f',
    foreground: '#d8ece8',
    cursor: '#4fd6d6',
    selectionBackground: '#4fd6d63a',
    black: '#0f2724',
    red: '#f0453a',
    green: '#5fd6a0',
    yellow: '#e0b15a',
    blue: '#4fd6d6',
    magenta: '#8fd0c8',
    cyan: '#7eeaea',
    white: '#c2d6d2',
    brightBlack: '#3f5e59',
    brightRed: '#ff6a5a',
    brightGreen: '#7fe6b8',
    brightYellow: '#f5ce7a',
    brightBlue: '#7eeaea',
    brightMagenta: '#a7e0d8',
    brightCyan: '#9ff0f0',
    brightWhite: '#eaf6f4'
  }
}

// ---------------------------------------------------------------------------
// Заря · Рассвет — original sunrise theme, kept as a warm option.
// ---------------------------------------------------------------------------
export const zaryaDawn: ThemeDef = {
  id: 'zarya-dawn',
  name: 'Заря · Рассвет',
  type: 'dark',
  ui: {
    bg: '#0b0f1a',
    bgElev1: '#111726',
    bgElev2: '#171f33',
    panel: '#0e1421',
    border: 'rgba(148, 168, 220, 0.14)',
    borderStrong: 'rgba(148, 168, 220, 0.28)',
    fg: '#e6eaf2',
    fgDim: '#9aa5bd',
    fgFaint: '#5a6785',
    accent: '#ff8a4c',
    accent2: '#ffb86b',
    accentGradient: 'linear-gradient(135deg, #ff6b4a 0%, #ffb86b 100%)',
    danger: '#ff5c69',
    success: '#3ddc97',
    warn: '#ffc24b'
  },
  terminal: {
    background: '#0b0f1a',
    foreground: '#e6eaf2',
    cursor: '#ff8a4c',
    selectionBackground: '#ff8a4c40',
    black: '#1c2333',
    red: '#ff5c69',
    green: '#3ddc97',
    yellow: '#ffc24b',
    blue: '#6ca8ff',
    magenta: '#c792ea',
    cyan: '#56d9d9',
    white: '#d5dcea',
    brightBlack: '#48547a',
    brightRed: '#ff8090',
    brightGreen: '#6ff0b5',
    brightYellow: '#ffd98a',
    brightBlue: '#93c0ff',
    brightMagenta: '#dda9f5',
    brightCyan: '#7eeaea',
    brightWhite: '#f2f5fb'
  }
}

/** Extra themes are appended by themePack.ts (imported by the gallery). */
const registry: ThemeDef[] = [zaryaCosmos, zaryaVostok, zaryaOrbita, zaryaDawn]

export function registerThemes(themes: ThemeDef[]): void {
  for (const t of themes) {
    if (!registry.some((x) => x.id === t.id)) registry.push(t)
  }
}

export function getThemes(): ThemeDef[] {
  return registry
}

export function getTheme(id: string): ThemeDef {
  return registry.find((t) => t.id === id) ?? zaryaCosmos
}

export function toXtermTheme(t: ThemeDef): Record<string, string> {
  return { ...t.terminal, cursorAccent: t.terminal.background }
}

const VAR_MAP: Array<[keyof ThemeDef['ui'], string]> = [
  ['bg', '--bg'],
  ['bgElev1', '--bg-elev1'],
  ['bgElev2', '--bg-elev2'],
  ['panel', '--panel'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['fg', '--fg'],
  ['fgDim', '--fg-dim'],
  ['fgFaint', '--fg-faint'],
  ['accent', '--accent'],
  ['accent2', '--accent-2'],
  ['accentGradient', '--accent-grad'],
  ['danger', '--danger'],
  ['success', '--success'],
  ['warn', '--warn']
]

export function applyTheme(t: ThemeDef): void {
  const root = document.documentElement
  for (const [key, cssVar] of VAR_MAP) {
    root.style.setProperty(cssVar, t.ui[key])
  }
  // Keep the native window backing in sync with the theme so there's no dark
  // flash under a light theme (and the OS window chrome matches).
  document.body.style.backgroundColor = t.ui.bg
  root.style.setProperty('--term-bg', t.terminal.background)
  // Extract accent RGB for alpha compositing in effects (starfield glow, etc.).
  root.dataset.theme = t.id
  root.dataset.themeType = t.type
}

import type { ThemeDef } from '@shared/types'

/**
 * Theme engine. Applying a theme sets CSS variables on <html> and returns
 * xterm colors via toXtermTheme(). The theme list is extended in themePack.ts.
 */

export const zaryaDawn: ThemeDef = {
  id: 'zarya-dawn',
  name: 'Zarya Dawn',
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

export const zaryaNight: ThemeDef = {
  id: 'zarya-night',
  name: 'Zarya Night',
  type: 'dark',
  ui: {
    ...zaryaDawn.ui,
    accent: '#7c9cff',
    accent2: '#9db8ff',
    accentGradient: 'linear-gradient(135deg, #5f7dff 0%, #9db8ff 100%)'
  },
  terminal: {
    ...zaryaDawn.terminal,
    cursor: '#7c9cff',
    selectionBackground: '#7c9cff40'
  }
}

/** Extra themes are appended by themePack.ts (imported below). */
const registry: ThemeDef[] = [zaryaDawn, zaryaNight]

export function registerThemes(themes: ThemeDef[]): void {
  for (const t of themes) {
    if (!registry.some((x) => x.id === t.id)) registry.push(t)
  }
}

export function getThemes(): ThemeDef[] {
  return registry
}

export function getTheme(id: string): ThemeDef {
  return registry.find((t) => t.id === id) ?? zaryaDawn
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
  root.style.setProperty('--term-bg', t.terminal.background)
  root.dataset.theme = t.id
  root.dataset.themeType = t.type
}

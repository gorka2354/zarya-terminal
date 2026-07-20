import type { ThemeDef } from '@shared/types'
import { registerThemes } from './themes'

/**
 * Extended theme pack. Eight curated themes (six dark, two light) covering
 * the most popular community palettes, adapted to Zarya's ui+terminal
 * ThemeDef shape. Registered as a side effect on import — see bottom.
 */

// ---------------------------------------------------------------------------
// Nord — https://www.nordtheme.com/
// ---------------------------------------------------------------------------
export const nord: ThemeDef = {
  id: 'nord',
  name: 'Nord',
  type: 'dark',
  ui: {
    bg: '#2e3440',
    bgElev1: '#3b4252',
    bgElev2: '#434c5e',
    panel: '#292d38',
    border: 'rgba(216, 222, 233, 0.12)',
    borderStrong: 'rgba(216, 222, 233, 0.24)',
    fg: '#eceff4',
    fgDim: '#d8dee9',
    fgFaint: '#4c566a',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    accentGradient: 'linear-gradient(135deg, #5e81ac 0%, #88c0d0 100%)',
    danger: '#bf616a',
    success: '#a3be8c',
    warn: '#ebcb8b'
  },
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#88c0d0',
    selectionBackground: '#4c566a',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4'
  }
}

// ---------------------------------------------------------------------------
// Dracula — https://draculatheme.com/
// ---------------------------------------------------------------------------
export const dracula: ThemeDef = {
  id: 'dracula',
  name: 'Dracula',
  type: 'dark',
  ui: {
    bg: '#282a36',
    bgElev1: '#343746',
    bgElev2: '#44475a',
    panel: '#21222c',
    border: 'rgba(248, 248, 242, 0.10)',
    borderStrong: 'rgba(248, 248, 242, 0.20)',
    fg: '#f8f8f2',
    fgDim: '#b4b7d1',
    fgFaint: '#6272a4',
    accent: '#ff79c6',
    accent2: '#bd93f9',
    accentGradient: 'linear-gradient(135deg, #ff79c6 0%, #bd93f9 100%)',
    danger: '#ff5555',
    success: '#50fa7b',
    warn: '#f1fa8c'
  },
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#ff79c6',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff'
  }
}

// ---------------------------------------------------------------------------
// Tokyo Night — https://github.com/enkia/tokyo-night-vscode-theme
// ---------------------------------------------------------------------------
export const tokyoNight: ThemeDef = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  type: 'dark',
  ui: {
    bg: '#1a1b26',
    bgElev1: '#232433',
    bgElev2: '#292e42',
    panel: '#16161e',
    border: 'rgba(192, 202, 245, 0.10)',
    borderStrong: 'rgba(192, 202, 245, 0.20)',
    fg: '#c0caf5',
    fgDim: '#a9b1d6',
    fgFaint: '#565f89',
    accent: '#7aa2f7',
    accent2: '#bb9af7',
    accentGradient: 'linear-gradient(135deg, #7aa2f7 0%, #bb9af7 100%)',
    danger: '#f7768e',
    success: '#9ece6a',
    warn: '#e0af68'
  },
  terminal: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#7aa2f7',
    selectionBackground: '#283457',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5'
  }
}

// ---------------------------------------------------------------------------
// Gruvbox Dark — https://github.com/morhetz/gruvbox
// ---------------------------------------------------------------------------
export const gruvboxDark: ThemeDef = {
  id: 'gruvbox-dark',
  name: 'Gruvbox Dark',
  type: 'dark',
  ui: {
    bg: '#282828',
    bgElev1: '#32302f',
    bgElev2: '#3c3836',
    panel: '#1d2021',
    border: 'rgba(235, 219, 178, 0.12)',
    borderStrong: 'rgba(235, 219, 178, 0.22)',
    fg: '#ebdbb2',
    fgDim: '#bdae93',
    fgFaint: '#928374',
    accent: '#fe8019',
    accent2: '#fabd2f',
    accentGradient: 'linear-gradient(135deg, #fe8019 0%, #fabd2f 100%)',
    danger: '#fb4934',
    success: '#b8bb26',
    warn: '#fabd2f'
  },
  terminal: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#fe8019',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2'
  }
}

// ---------------------------------------------------------------------------
// Catppuccin Mocha — https://catppuccin.com/
// ---------------------------------------------------------------------------
export const catppuccinMocha: ThemeDef = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  type: 'dark',
  ui: {
    bg: '#1e1e2e',
    bgElev1: '#313244',
    bgElev2: '#45475a',
    panel: '#181825',
    border: 'rgba(205, 214, 244, 0.10)',
    borderStrong: 'rgba(205, 214, 244, 0.20)',
    fg: '#cdd6f4',
    fgDim: '#a6adc8',
    fgFaint: '#6c7086',
    accent: '#cba6f7',
    accent2: '#f5c2e7',
    accentGradient: 'linear-gradient(135deg, #cba6f7 0%, #f5c2e7 100%)',
    danger: '#f38ba8',
    success: '#a6e3a1',
    warn: '#f9e2af'
  },
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8'
  }
}

// ---------------------------------------------------------------------------
// Rosé Pine — https://rosepinetheme.com/
// ---------------------------------------------------------------------------
export const rosePine: ThemeDef = {
  id: 'rose-pine',
  name: 'Rosé Pine',
  type: 'dark',
  ui: {
    bg: '#191724',
    bgElev1: '#1f1d2e',
    bgElev2: '#26233a',
    panel: '#16141f',
    border: 'rgba(224, 222, 244, 0.10)',
    borderStrong: 'rgba(224, 222, 244, 0.20)',
    fg: '#e0def4',
    fgDim: '#908caa',
    fgFaint: '#6e6a86',
    accent: '#c4a7e7',
    accent2: '#ebbcba',
    accentGradient: 'linear-gradient(135deg, #c4a7e7 0%, #ebbcba 100%)',
    danger: '#eb6f92',
    success: '#31748f',
    warn: '#f6c177'
  },
  terminal: {
    background: '#191724',
    foreground: '#e0def4',
    cursor: '#c4a7e7',
    selectionBackground: '#403d52',
    black: '#26233a',
    red: '#eb6f92',
    green: '#31748f',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ebbcba',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#31748f',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ebbcba',
    brightWhite: '#e0def4'
  }
}

// ---------------------------------------------------------------------------
// One Light — inspired by Atom's "One Light" syntax palette
// ---------------------------------------------------------------------------
export const oneLight: ThemeDef = {
  id: 'one-light',
  name: 'One Light',
  type: 'light',
  ui: {
    bg: '#fafafa',
    bgElev1: '#ececed',
    bgElev2: '#e1e1e3',
    panel: '#f3f3f4',
    border: 'rgba(56, 58, 66, 0.12)',
    borderStrong: 'rgba(56, 58, 66, 0.24)',
    fg: '#383a42',
    fgDim: '#696c77',
    fgFaint: '#a0a1a7',
    accent: '#4078f2',
    accent2: '#0184bc',
    accentGradient: 'linear-gradient(135deg, #4078f2 0%, #0184bc 100%)',
    danger: '#e45649',
    success: '#50a14f',
    warn: '#c18401'
  },
  terminal: {
    background: '#fafafa',
    foreground: '#383a42',
    cursor: '#4078f2',
    selectionBackground: '#d3dcf5',
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#4078f2',
    magenta: '#a626a4',
    cyan: '#0184bc',
    white: '#fafafa',
    brightBlack: '#696c77',
    brightRed: '#ff5f5f',
    brightGreen: '#6bc46d',
    brightYellow: '#d4a72c',
    brightBlue: '#6a94ff',
    brightMagenta: '#c76ac2',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  }
}

// ---------------------------------------------------------------------------
// Solarized Light — https://ethanschoonover.com/solarized/
// ---------------------------------------------------------------------------
export const solarizedLight: ThemeDef = {
  id: 'solarized-light',
  name: 'Solarized Light',
  type: 'light',
  ui: {
    bg: '#fdf6e3',
    bgElev1: '#f1e9d0',
    bgElev2: '#eee8d5',
    panel: '#f7f0da',
    border: 'rgba(101, 123, 131, 0.18)',
    borderStrong: 'rgba(101, 123, 131, 0.32)',
    fg: '#586e75',
    fgDim: '#657b83',
    fgFaint: '#93a1a1',
    accent: '#268bd2',
    accent2: '#2aa198',
    accentGradient: 'linear-gradient(135deg, #268bd2 0%, #2aa198 100%)',
    danger: '#dc322f',
    success: '#859900',
    warn: '#b58900'
  },
  terminal: {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    selectionBackground: '#eee8d5',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  }
}

registerThemes([
  nord,
  dracula,
  tokyoNight,
  gruvboxDark,
  catppuccinMocha,
  rosePine,
  oneLight,
  solarizedLight
])

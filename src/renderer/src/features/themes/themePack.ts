import type { ThemeDef } from '@shared/types'
import { registerThemes } from './themes'

/**
 * Extended cosmic-constructivist theme pack. Every theme speaks the same
 * language (Soviet space programme + constructivism) but in a different key:
 * two more dark moods and three light "poster paper" themes, because plenty of
 * people work on light backgrounds. Registered on import (side effect).
 *
 * Light themes carry darkened, saturated ANSI palettes so terminal text stays
 * legible on cream/paper backgrounds.
 */

// ------------------------------------------------------------------ dark

/** Заря · Спутник — cold graphite hull, brand red, brass telemetry. */
const sputnik: ThemeDef = {
  id: 'zarya-sputnik',
  name: 'Заря · Спутник',
  type: 'dark',
  ui: {
    bg: '#0d0f12',
    bgElev1: '#16191d',
    bgElev2: '#21262c',
    panel: '#0a0c0e',
    border: 'rgba(160, 180, 200, 0.14)',
    borderStrong: 'rgba(160, 180, 200, 0.30)',
    fg: '#dbe1e6',
    fgDim: '#8b959e',
    fgFaint: '#4d565e',
    accent: '#e2231a',
    accent2: '#cbb183',
    accentGradient: 'linear-gradient(120deg, #e2231a 0%, #f0662e 55%, #cbb183 100%)',
    danger: '#f0453a',
    success: '#5fb88a',
    warn: '#cbb183'
  },
  terminal: {
    background: '#0d0f12',
    foreground: '#dbe1e6',
    cursor: '#cbb183',
    selectionBackground: '#9fb2c033',
    black: '#21262c',
    red: '#e2231a',
    green: '#6fbf8e',
    yellow: '#cbb183',
    blue: '#7aa0c8',
    magenta: '#b98cc0',
    cyan: '#6fc0c0',
    white: '#c4ccd2',
    brightBlack: '#4d565e',
    brightRed: '#ff5a4a',
    brightGreen: '#8fe0ac',
    brightYellow: '#e6cfa0',
    brightBlue: '#9fbce0',
    brightMagenta: '#d4aed8',
    brightCyan: '#8fdada',
    brightWhite: '#eef2f5'
  }
}

/** Заря · Байконур — warm steppe night, sodium launch-pad amber. */
const baikonur: ThemeDef = {
  id: 'zarya-baikonur',
  name: 'Заря · Байконур',
  type: 'dark',
  ui: {
    bg: '#14100a',
    bgElev1: '#1f180f',
    bgElev2: '#2c2213',
    panel: '#0d0a06',
    border: 'rgba(240, 147, 46, 0.16)',
    borderStrong: 'rgba(240, 147, 46, 0.34)',
    fg: '#f0e6d2',
    fgDim: '#b0a184',
    fgFaint: '#6e6349',
    accent: '#f0932e',
    accent2: '#e0b15a',
    accentGradient: 'linear-gradient(120deg, #e2231a 0%, #f0932e 55%, #e0b15a 100%)',
    danger: '#f0453a',
    success: '#9fb87a',
    warn: '#e0b15a'
  },
  terminal: {
    background: '#14100a',
    foreground: '#f0e6d2',
    cursor: '#f0932e',
    selectionBackground: '#f0932e38',
    black: '#2c2213',
    red: '#e2231a',
    green: '#9fb87a',
    yellow: '#e0b15a',
    blue: '#d0a26a',
    magenta: '#e08a5a',
    cyan: '#d6b06a',
    white: '#e6dcc6',
    brightBlack: '#6e6349',
    brightRed: '#ff5a4a',
    brightGreen: '#b8cf95',
    brightYellow: '#f5ce7a',
    brightBlue: '#e0bc84',
    brightMagenta: '#f0a070',
    brightCyan: '#f0cc88',
    brightWhite: '#fbf4e8'
  }
}

// ------------------------------------------------------------------ light

/** Заря · Плакат — constructivist poster: cream paper, red + black ink. */
const plakat: ThemeDef = {
  id: 'zarya-plakat',
  name: 'Заря · Плакат',
  type: 'light',
  ui: {
    bg: '#efe7d4',
    bgElev1: '#f6efdd',
    bgElev2: '#e6dcc4',
    panel: '#eae1cd',
    border: 'rgba(30, 20, 14, 0.16)',
    borderStrong: 'rgba(30, 20, 14, 0.32)',
    fg: '#201a14',
    fgDim: '#6b6152',
    fgFaint: '#9c937f',
    accent: '#d21e1e',
    accent2: '#1a1410',
    accentGradient: 'linear-gradient(120deg, #d21e1e 0%, #1a1410 100%)',
    danger: '#c1121f',
    success: '#2e7d46',
    warn: '#9a6a1e'
  },
  terminal: {
    background: '#efe7d4',
    foreground: '#241d15',
    cursor: '#d21e1e',
    selectionBackground: '#d21e1e2e',
    black: '#201a14',
    red: '#c1121f',
    green: '#2e7d46',
    yellow: '#9a6a1e',
    blue: '#1f4e8c',
    magenta: '#8e3a8e',
    cyan: '#157a7a',
    white: '#6b6152',
    brightBlack: '#9c937f',
    brightRed: '#e01e1e',
    brightGreen: '#3a9a58',
    brightYellow: '#b5820f',
    brightBlue: '#2a63ad',
    brightMagenta: '#a84aa8',
    brightCyan: '#1c9494',
    brightWhite: '#201a14'
  }
}

/** Заря · Полдень — warm cosmonaut daylight, red + brass. */
const polden: ThemeDef = {
  id: 'zarya-polden',
  name: 'Заря · Полдень',
  type: 'light',
  ui: {
    bg: '#f4f0e8',
    bgElev1: '#fbf8f1',
    bgElev2: '#e9e3d6',
    panel: '#efeadf',
    border: 'rgba(34, 32, 27, 0.14)',
    borderStrong: 'rgba(34, 32, 27, 0.28)',
    fg: '#22201b',
    fgDim: '#6d685c',
    fgFaint: '#a49d8d',
    accent: '#e2231a',
    accent2: '#b07d1e',
    accentGradient: 'linear-gradient(120deg, #e2231a 0%, #f0662e 55%, #b07d1e 100%)',
    danger: '#c1121f',
    success: '#2e7d46',
    warn: '#b07d1e'
  },
  terminal: {
    background: '#f4f0e8',
    foreground: '#26231c',
    cursor: '#e2231a',
    selectionBackground: '#e2231a26',
    black: '#22201b',
    red: '#c1121f',
    green: '#2e7d46',
    yellow: '#a06a12',
    blue: '#22568f',
    magenta: '#8e3a8e',
    cyan: '#157a7a',
    white: '#6d685c',
    brightBlack: '#a49d8d',
    brightRed: '#e01e1e',
    brightGreen: '#3a9a58',
    brightYellow: '#c08615',
    brightBlue: '#2f68a8',
    brightMagenta: '#a84aa8',
    brightCyan: '#1c9494',
    brightWhite: '#22201b'
  }
}

/** Заря · Чертёж — technical drawing on cool paper, navy lines + red notes. */
const chertyozh: ThemeDef = {
  id: 'zarya-chertyozh',
  name: 'Заря · Чертёж',
  type: 'light',
  ui: {
    bg: '#e8ecef',
    bgElev1: '#f2f5f7',
    bgElev2: '#dce3e8',
    panel: '#e2e8ec',
    border: 'rgba(26, 40, 51, 0.14)',
    borderStrong: 'rgba(26, 40, 51, 0.30)',
    fg: '#1a2833',
    fgDim: '#5a6b78',
    fgFaint: '#97a3ad',
    accent: '#1f4e8c',
    accent2: '#d21e1e',
    accentGradient: 'linear-gradient(120deg, #1f4e8c 0%, #3a78c0 70%, #d21e1e 100%)',
    danger: '#c1121f',
    success: '#2e7d46',
    warn: '#b5730f'
  },
  terminal: {
    background: '#e8ecef',
    foreground: '#1a2833',
    cursor: '#1f4e8c',
    selectionBackground: '#1f4e8c26',
    black: '#1a2833',
    red: '#c1121f',
    green: '#2e7d46',
    yellow: '#8a6a12',
    blue: '#1f4e8c',
    magenta: '#8e3a8e',
    cyan: '#157a7a',
    white: '#5a6b78',
    brightBlack: '#97a3ad',
    brightRed: '#e01e1e',
    brightGreen: '#3a9a58',
    brightYellow: '#a5820f',
    brightBlue: '#2a63ad',
    brightMagenta: '#a84aa8',
    brightCyan: '#1c9494',
    brightWhite: '#1a2833'
  }
}

registerThemes([sputnik, baikonur, plakat, polden, chertyozh])

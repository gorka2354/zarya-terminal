/**
 * Tiny 5×7 monospace pixel font — enough uppercase letters + symbols for the
 * shell monograms (PS / PWSH / CMD / SH / WSL / ZSH / FSH / >_). Rendered by
 * {@link PixelText} as run-length <rect>s in currentColor, so a monogram
 * inherits its badge's per-shell colour and stays crisp at the shared PX scale.
 *
 * Designed as bitmaps here (the single source); Aseprite/pixelforge can preview
 * the same grids. Add glyphs as new shells appear.
 */
export const FONT_W = 5
export const FONT_H = 7

export const PIXEL_FONT: Record<string, string[]> = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111']
}

/**
 * Tiny 5×7 monospace pixel font — enough uppercase letters + symbols for the
 * shell monograms (PS / PWSH / CMD / SH / WSL / ZSH / FSH / >_) and the agent
 * monograms (CC / CX / GM / KM / QW). Rendered by {@link PixelText} as
 * run-length <rect>s in currentColor, so a monogram inherits its badge's colour
 * and stays crisp at the shared PX scale.
 *
 * Designed as bitmaps here (the single source); Aseprite/pixelforge can preview
 * the same grids. Add glyphs as new shells/engines appear.
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
  // Engine monograms: X (Codex), G (Gemini), K (Kimi), Q (Qwen).
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  // Q keeps C's round shell so CC/CX/GM/KM/QW read as one family, plus a tail.
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111']
}

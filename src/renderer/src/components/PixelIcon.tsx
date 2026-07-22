import pixelIcons from './pixelIcons.json'
import { PIXEL_FONT, FONT_W, FONT_H } from './pixelFont'

/**
 * Global art-pixel unit — the Stardew-Valley rule: ONE pixel size everywhere.
 * Every pixel-art element in the UI renders at an integer multiple of this, so
 * a "pixel" is always the same physical size (icons, badges, mascot, scenes).
 * Bump this single number to make all pixel art chunkier in lockstep.
 */
export const PX = 2

const ICONS = pixelIcons.icons as Record<string, string[]>
const GRID = pixelIcons.size // 16

export type PixelIconName = keyof typeof pixelIcons.icons

/**
 * Crisp, theme-aware pixel glyph. The bitmap (from pixelIcons.json, the shared
 * source Aseprite also renders) is emitted as run-length-merged <rect>s in a
 * GRID×GRID viewBox with fill=currentColor + shape-rendering:crispEdges — so it
 * inherits the surrounding color (active accent / inactive faint) exactly like
 * the line icons did, and stays razor-sharp at the fixed PX scale.
 */
export function PixelIcon({
  name,
  px = PX,
  className,
  title
}: {
  name: PixelIconName
  px?: number
  className?: string
  title?: string
}): React.JSX.Element {
  const grid = ICONS[name]
  const rects: React.JSX.Element[] = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    let x = 0
    while (x < GRID) {
      if (row[x] === '1') {
        let w = 1
        while (x + w < GRID && row[x + w] === '1') w++
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={w} height={1} />)
        x += w
      } else {
        x++
      }
    }
  }
  const size = GRID * px
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {rects}
    </svg>
  )
}

/**
 * Short string rendered in the 5×7 {@link PIXEL_FONT} as run-length <rect>s
 * (currentColor, crisp) — used for shell monograms. Same PX unit as the icons,
 * so a "pixel" here matches everywhere. Unknown characters are skipped.
 */
export function PixelText({
  text,
  px = PX,
  gap = 1,
  className
}: {
  text: string
  px?: number
  gap?: number
  className?: string
}): React.JSX.Element {
  const chars = text.toUpperCase().split('')
  const rects: React.JSX.Element[] = []
  let ox = 0
  for (const ch of chars) {
    const g = PIXEL_FONT[ch]
    if (g) {
      for (let y = 0; y < FONT_H; y++) {
        const row = g[y]
        let x = 0
        while (x < FONT_W) {
          if (row[x] === '1') {
            let w = 1
            while (x + w < FONT_W && row[x + w] === '1') w++
            rects.push(<rect key={`${ox}-${x}-${y}`} x={ox + x} y={y} width={w} height={1} />)
            x += w
          } else {
            x++
          }
        }
      }
    }
    ox += FONT_W + gap
  }
  const totalW = Math.max(1, chars.length * (FONT_W + gap) - gap)
  return (
    <svg
      className={className}
      width={totalW * px}
      height={FONT_H * px}
      viewBox={`0 0 ${totalW} ${FONT_H}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
      focusable="false"
    >
      {rects}
    </svg>
  )
}

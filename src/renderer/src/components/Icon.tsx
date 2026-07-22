/**
 * Zarya iconography — constructivist / space-programme line glyphs.
 * Replaces every emoji in the UI. 24x24 viewBox, stroke = currentColor so
 * icons inherit the surrounding text color; a few marks are filled (star).
 *
 * Usage: <Icon name="star" /> · size via the `size` prop or font-size context.
 */
import { PixelText, PixelIcon, type PixelIconName } from './PixelIcon'
import pixelIconData from './pixelIcons.json'

// Names available as small (≤8-tall) pixel glyphs — routed through PixelIcon so
// the whole UI shares one pixel look at the consistent PX. Larger 16×16 names
// (sessions/files/… ) stay as line glyphs here; the activity bar renders those
// big via PixelIcon directly.
const PIXEL_SMALL = new Set(
  Object.entries((pixelIconData as { icons: Record<string, string[]> }).icons)
    .filter(([, g]) => g.length <= 8)
    .map(([k]) => k)
)
// Names whose big (16×16) glyph belongs to the activity bar — Icon uses a small
// dedicated variant so it stays 16px inline instead of ballooning to 32px.
const PIXEL_ALIAS: Record<string, string> = {
  sputnik: 'sputnik-sm',
  gear: 'gear-sm',
  history: 'history-sm'
}

export type IconName =
  | 'star'
  | 'star-outline'
  | 'sessions'
  | 'files'
  | 'folder'
  | 'folder-open'
  | 'workflows'
  | 'history'
  | 'sputnik'
  | 'gear'
  | 'pin'
  | 'terminal'
  | 'branch'
  | 'save'
  | 'copy'
  | 'run'
  | 'insert'
  | 'download'
  | 'rerun'
  | 'search'
  | 'close'
  | 'plus'
  | 'minus'
  | 'maximize'
  | 'restore'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'check'
  | 'cross'
  | 'dot'
  | 'rocket'
  | 'satellite'
  | 'trash'
  | 'refresh'
  | 'stop'
  | 'send'
  | 'split-h'
  | 'split-v'
  | 'orbit'
  | 'radio'
  | 'bolt'
  | 'edit'
  | 'external'

interface Props {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
  title?: string
}

// Path/element content per icon. `f` = filled shapes (use fill=currentColor),
// everything else strokes with currentColor.
const PATHS: Record<IconName, React.ReactNode> = {
  // Five-point star — favorite / accent / AI. Filled.
  star: <path d="M12 2.4l2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 17.1 6.7 20.6 8.2 14 3.2 9.7l6.6-.6z" fill="currentColor" stroke="none" />,
  'star-outline': (
    <path d="M12 3.2l2.5 5.6 6.1.5-4.6 4 1.4 6-5.4-3.2-5.4 3.2 1.4-6-4.6-4 6.1-.5z" />
  ),
  // Sessions — stacked orbital cards.
  sessions: (
    <>
      <rect x="3.5" y="5" width="17" height="5" rx="1" />
      <rect x="3.5" y="14" width="17" height="5" rx="1" />
      <circle cx="6.6" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6.6" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  files: (
    <>
      <path d="M4 6.5h5l1.6 2H20v9.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M4 8.5h6" />
    </>
  ),
  folder: <path d="M4 6.5h5l1.6 2H20v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />,
  'folder-open': (
    <>
      <path d="M4 7h4.8l1.5 1.8H19a1 1 0 0 1 1 1V11" />
      <path d="M3 18.5l2.3-7h16l-2.3 7z" />
    </>
  ),
  // Workflows — reactor / piston stack.
  workflows: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21M5.6 5.6l2.4 2.4M16 16l2.4 2.4M18.4 5.6L16 8M8 16l-2.4 2.4" />
    </>
  ),
  // History — orbital clock.
  history: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.2V12l3.4 2" />
    </>
  ),
  // AI — Sputnik.
  sputnik: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 6.2V3M12 21v-3.2M6.2 12H3M21 12h-3.2M8.1 8.1L5.6 5.6M18.4 18.4L15.9 15.9M15.9 8.1l2.5-2.5M5.6 18.4l2.5-2.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.6l1 2.6 2.7-.7.4 2.8 2.6 1-1.3 2.5 1.9 2-2.1 1.9.5 2.7-2.8.2-1.1 2.6L12 21.4l-1.8-1.9-2.6.7-.6-2.7-2.7-.5.7-2.7-2-2 2-1.7-.7-2.7 2.7-.6.6-2.7 2.6.9z" />
    </>
  ),
  pin: (
    <>
      <path d="M12 3.5l4.5 4.5-2 .6-1.2 4.9-2.6-2.6-4.6 4.6 4.6-4.6-2.6-2.6 4.9-1.2z" fill="currentColor" stroke="none" />
      <path d="M9.8 14.2L5 19" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="9" r="2" />
      <path d="M7 8v8M17 11v1a4 4 0 0 1-4 4H9" />
    </>
  ),
  save: (
    <>
      <path d="M5 4.5h11L19.5 8v11.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" />
      <path d="M8 4.5v4h7v-4M8 20v-5h8v5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="10" height="11" rx="1.2" />
      <path d="M5.5 15.5V5.5a1 1 0 0 1 1-1H15" />
    </>
  ),
  run: <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="none" />,
  insert: <path d="M20 6v5a3 3 0 0 1-3 3H5m0 0l4-4m-4 4l4 4" />,
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />,
  rerun: (
    <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restore: (
    <>
      <rect x="7" y="7" width="12" height="12" rx="1" />
      <path d="M5 15V6a1 1 0 0 1 1-1h9" />
    </>
  ),
  'chevron-up': <path d="M5 15l7-7 7 7" />,
  'chevron-down': <path d="M5 9l7 7 7-7" />,
  'chevron-left': <path d="M15 5l-7 7 7 7" />,
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  check: <path d="M4 12.5l5 5 11-11" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  // Rocket — the signature mark.
  rocket: (
    <>
      <path d="M12 2.5c3.2 2.2 5 5.6 5 9.4 0 2-.5 3.4-.9 4.3H7.9C7.5 15.3 7 13.9 7 11.9c0-3.8 1.8-7.2 5-9.4z" />
      <circle cx="12" cy="10" r="1.8" fill="currentColor" stroke="none" />
      <path d="M7.6 15.5L5 18.5l3.4-.4M16.4 15.5L19 18.5l-3.4-.4M10.4 19.5c.6 1.4 3 1.4 3.2 0" />
    </>
  ),
  satellite: (
    <>
      <rect x="10.5" y="10.5" width="3" height="3" transform="rotate(45 12 12)" />
      <path d="M7 7l2.5 2.5M14.5 14.5L17 17M6 12a6 6 0 0 1 6-6M9 12a3 3 0 0 1 3-3" />
    </>
  ),
  trash: (
    <>
      <path d="M5 6.5h14M9 6.5V4.5h6v2M6.5 6.5l1 12.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-12.5" />
      <path d="M10 10v6M14 10v6" />
    </>
  ),
  refresh: <path d="M4 12a8 8 0 0 1 13.7-5.6M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6M4 20v-4h4" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  send: <path d="M4 12l16-7-7 16-2.5-6.5z" />,
  'split-h': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M12 4v16" />
    </>
  ),
  'split-v': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 12h16" />
    </>
  ),
  orbit: (
    <>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a8 8 0 0 0 0 12M18 6a8 8 0 0 1 0 12" />
    </>
  ),
  bolt: <path d="M13 2.5L5.5 13H11l-1 8.5L18.5 11H13z" fill="currentColor" stroke="none" />,
  edit: <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" />,
  external: <path d="M14 5h5v5M19 5l-8 8M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" />
}

export function Icon({ name, size = 16, className, strokeWidth = 1.6, title }: Props): React.JSX.Element {
  // Pixel glyph if we have one at this small scale; otherwise the line glyph.
  const pixelName = PIXEL_ALIAS[name] ?? (PIXEL_SMALL.has(name) ? name : undefined)
  if (pixelName) {
    return <PixelIcon name={pixelName as PixelIconName} className={className} title={title} />
  }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}

/**
 * Shell monogram chip — replaces per-shell emoji with a constructivist Oswald
 * badge (PS / CMD / SH / WSL / ZSH / FSH). Accepts either a known shell code or
 * a legacy emoji string (rendered as-is for backward compat with old sessions).
 */
const SHELL_CODES = new Set(['PS', 'CMD', 'SH', 'WSL', 'ZSH', 'FSH', 'PWSH', '>_'])

export function ShellGlyph({ code, size = 15 }: { code: string; size?: number }): React.JSX.Element {
  const up = code.toUpperCase()
  if (!SHELL_CODES.has(up)) {
    // Legacy emoji or unknown — show a generic terminal glyph, not the emoji.
    return <Icon name="terminal" size={size + 1} />
  }
  // Pixel monogram (5×7 font, PX=2) tinted by the badge's per-shell colour.
  const label = up === 'PWSH' ? 'PS' : up
  return (
    <span className="zy-shell-mono" data-shell={up}>
      <PixelText text={label} />
    </span>
  )
}

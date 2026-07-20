import type * as Monaco from 'monaco-editor'
import type { ThemeDef } from '@shared/types'

/**
 * Lazy Monaco bootstrap. `monaco-editor` (and its workers) must never land in
 * the startup bundle — everything here is behind dynamic `import()`, invoked
 * only when the editor feature actually mounts (see EditorPane).
 */

let monacoPromise: Promise<typeof Monaco> | null = null

// The `?worker` suffix is a Vite-only import form (resolved at build time to
// a Worker-constructor module); no package ships a .d.ts for that shape, and
// a wildcard ambient declaration can't live in this file (it has real
// exports, so TS treats it as a module — wildcard `declare module` is only
// legal from a non-module/global file). Each import is verified correct at
// runtime by Vite's own worker plugin; ts-expect-error only silences the
// missing-types diagnostic, not a real type error.
async function setupWorkerEnvironment(): Promise<void> {
  // monaco-editor >= 0.53 maps subpaths via package exports: "./*" -> "./esm/vs/*.js",
  // so worker specifiers must NOT include the esm/vs prefix.
  // @ts-expect-error -- Vite "?worker" import, see comment above.
  const editorWorkerMod = await import('monaco-editor/editor/editor.worker.js?worker')
  // @ts-expect-error -- Vite "?worker" import, see comment above.
  const jsonWorkerMod = await import('monaco-editor/language/json/json.worker.js?worker')
  // @ts-expect-error -- Vite "?worker" import, see comment above.
  const cssWorkerMod = await import('monaco-editor/language/css/css.worker.js?worker')
  // @ts-expect-error -- Vite "?worker" import, see comment above.
  const htmlWorkerMod = await import('monaco-editor/language/html/html.worker.js?worker')
  // @ts-expect-error -- Vite "?worker" import, see comment above.
  const tsWorkerMod = await import('monaco-editor/language/typescript/ts.worker.js?worker')

  const EditorWorker = editorWorkerMod.default as new () => Worker
  const JsonWorker = jsonWorkerMod.default as new () => Worker
  const CssWorker = cssWorkerMod.default as new () => Worker
  const HtmlWorker = htmlWorkerMod.default as new () => Worker
  const TsWorker = tsWorkerMod.default as new () => Worker

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'less':
        case 'scss':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    }
  }
}

/** Loads Monaco + wires its workers exactly once. Safe to call repeatedly/concurrently. */
export async function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      await setupWorkerEnvironment()
      const monaco = await import('monaco-editor')
      return monaco
    })()
  }
  return monacoPromise
}

/** Converts a CSS color (hex or rgb/rgba) to the hex(+alpha) form Monaco themes require. */
function toMonacoHex(css: string): string {
  const v = css.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\)$/i.exec(v)
  if (m) {
    const [, r, g, b, a] = m
    const byte = (n: string): string =>
      Math.round(Math.min(255, Math.max(0, Number(n))))
        .toString(16)
        .padStart(2, '0')
    const alpha = a !== undefined ? byte(String(Math.min(1, Math.max(0, Number(a))) * 255)) : ''
    return `#${byte(r)}${byte(g)}${byte(b)}${alpha}`
  }
  return '#00000000'
}

const definedThemes = new Set<string>()

/** Defines (once) a Monaco theme derived from a Zarya ThemeDef and returns its name. */
export function ensureMonacoTheme(monaco: typeof Monaco, themeDef: ThemeDef): string {
  const name = `zarya-${themeDef.id}`
  if (definedThemes.has(name)) return name
  monaco.editor.defineTheme(name, {
    base: themeDef.type === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': toMonacoHex(themeDef.terminal.background),
      'editor.foreground': toMonacoHex(themeDef.terminal.foreground),
      'editorCursor.foreground': toMonacoHex(themeDef.terminal.cursor),
      'editor.selectionBackground': toMonacoHex(themeDef.terminal.selectionBackground),
      'editor.lineHighlightBackground': toMonacoHex(themeDef.ui.bgElev1),
      'editorLineNumber.foreground': toMonacoHex(themeDef.ui.fgFaint),
      'editorLineNumber.activeForeground': toMonacoHex(themeDef.ui.fgDim),
      'editorWhitespace.foreground': toMonacoHex(themeDef.ui.fgFaint),
      'editorIndentGuide.background': toMonacoHex(themeDef.ui.bgElev2),
      'editorWidget.background': toMonacoHex(themeDef.ui.bgElev1),
      'editorWidget.foreground': toMonacoHex(themeDef.ui.fg),
      'editorSuggestWidget.background': toMonacoHex(themeDef.ui.bgElev1),
      'editorSuggestWidget.selectedBackground': toMonacoHex(themeDef.ui.bgElev2),
      'input.background': toMonacoHex(themeDef.ui.bg),
      'scrollbarSlider.background': toMonacoHex(themeDef.ui.bgElev2),
      'diffEditor.insertedTextBackground': `${toMonacoHex(themeDef.ui.success).slice(0, 7)}26`,
      'diffEditor.removedTextBackground': `${toMonacoHex(themeDef.ui.danger).slice(0, 7)}26`
    }
  })
  definedThemes.add(name)
  return name
}

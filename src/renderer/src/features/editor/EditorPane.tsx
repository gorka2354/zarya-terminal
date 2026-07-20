import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { getTheme } from '@/features/themes/themes'
import { useSettingsStore } from '@/state/settingsStore'
import { type OpenFile, useEditorStore } from './editorStore'
import { ensureMonacoTheme, loadMonaco } from './monacoSetup'
import './editor.css'

/** Extensions Monaco's bundled tokenizers don't register a matching id for by default. */
const FALLBACK_EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  sql: 'sql',
  vue: 'html',
  svelte: 'html',
  txt: 'plaintext'
}

function resolveLanguage(monaco: typeof Monaco, path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = base.slice(dot + 1).toLowerCase()
  const known = monaco.languages.getLanguages().find((l) => l.extensions?.includes(`.${ext}`))
  if (known) return known.id
  return FALLBACK_EXT_LANG[ext] ?? 'plaintext'
}

function buildOptions(
  editorSettings: { fontSize: number; wordWrap: boolean; minimap: boolean; tabSize: number },
  fontFamily: string
): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  return {
    fontSize: editorSettings.fontSize,
    wordWrap: editorSettings.wordWrap ? 'on' : 'off',
    minimap: { enabled: editorSettings.minimap },
    tabSize: editorSettings.tabSize,
    fontFamily,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    fixedOverflowWidgets: true
  }
}

export default function EditorPane(): React.JSX.Element {
  const files = useEditorStore((s) => s.files)
  const activeId = useEditorStore((s) => s.activeId)
  const pendingReveal = useEditorStore((s) => s.pendingReveal)
  const closeFile = useEditorStore((s) => s.closeFile)
  const setActive = useEditorStore((s) => s.setActive)
  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal)

  const editorSettings = useSettingsStore((s) => s.settings.editor)
  const fontFamily = useSettingsStore((s) => s.settings.appearance.fontFamily)
  const themeId = useSettingsStore((s) => s.settings.appearance.themeId)

  const editorHostRef = useRef<HTMLDivElement>(null)
  const diffHostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const fileModels = useRef(new Map<string, Monaco.editor.ITextModel>())
  const diffModels = useRef(
    new Map<string, { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel }>()
  )
  const activeIdRef = useRef<string | null>(null)

  const [monacoApi, setMonacoApi] = useState<typeof Monaco | null>(null)
  const [showDiff, setShowDiff] = useState(false)

  const activeFile: OpenFile | null = files.find((f) => f.id === activeId) ?? null

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // Load Monaco once, lazily. Never imported at module scope elsewhere.
  useEffect(() => {
    let cancelled = false
    void loadMonaco().then((m) => {
      if (!cancelled) setMonacoApi(m)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Create the (single) code editor + the (single) diff editor once Monaco is ready.
  useEffect(() => {
    if (!monacoApi || !editorHostRef.current || !diffHostRef.current || editorRef.current) return
    const monaco = monacoApi
    const themeName = ensureMonacoTheme(monaco, getTheme(useSettingsStore.getState().settings.appearance.themeId))
    const options = buildOptions(
      useSettingsStore.getState().settings.editor,
      useSettingsStore.getState().settings.appearance.fontFamily
    )

    const editor = monaco.editor.create(editorHostRef.current, { ...options, theme: themeName, model: null })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const id = activeIdRef.current
      if (id) void useEditorStore.getState().save(id)
    })
    editorRef.current = editor

    const diffEditor = monaco.editor.createDiffEditor(diffHostRef.current, {
      ...options,
      theme: themeName,
      readOnly: true,
      renderSideBySide: true
    })
    diffEditorRef.current = diffEditor

    return () => {
      editor.dispose()
      diffEditor.dispose()
      for (const m of fileModels.current.values()) m.dispose()
      for (const { original, modified } of diffModels.current.values()) {
        original.dispose()
        modified.dispose()
      }
      fileModels.current.clear()
      diffModels.current.clear()
      editorRef.current = null
      diffEditorRef.current = null
    }
  }, [monacoApi])

  // Live theme updates.
  useEffect(() => {
    if (!monacoApi) return
    const name = ensureMonacoTheme(monacoApi, getTheme(themeId))
    monacoApi.editor.setTheme(name)
  }, [monacoApi, themeId])

  // Live editor settings updates.
  useEffect(() => {
    if (!monacoApi) return
    const options = buildOptions(editorSettings, fontFamily)
    editorRef.current?.updateOptions(options)
    // Diff editor options don't include tabSize/insertSpaces (model-level only, N/A for read-only diffs).
    const { tabSize: _tabSize, ...diffSafe } = options
    diffEditorRef.current?.updateOptions(diffSafe)
  }, [monacoApi, editorSettings.fontSize, editorSettings.wordWrap, editorSettings.minimap, editorSettings.tabSize, fontFamily])

  // Switch the visible model when the active tab (or its load state) changes.
  const switchSignal = activeFile ? `${activeFile.id}:${activeFile.loading}:${activeFile.kind}` : ''
  useEffect(() => {
    const monaco = monacoApi
    const editor = editorRef.current
    const diffEditor = diffEditorRef.current
    if (!monaco || !editor || !diffEditor) return
    const file = useEditorStore.getState().files.find((f) => f.id === activeId) ?? null
    if (!file) return

    if (file.kind === 'diff') {
      setShowDiff(true)
      let entry = diffModels.current.get(file.id)
      if (!entry) {
        const lang = resolveLanguage(monaco, file.path)
        entry = {
          original: monaco.editor.createModel(file.original ?? '', lang),
          modified: monaco.editor.createModel(file.content, lang)
        }
        diffModels.current.set(file.id, entry)
      }
      diffEditor.setModel({ original: entry.original, modified: entry.modified })
      return
    }

    setShowDiff(false)
    if (file.loading) return
    let model = fileModels.current.get(file.id)
    if (!model) {
      const lang = resolveLanguage(monaco, file.path)
      const uri = monaco.Uri.file(file.path)
      model = monaco.editor.createModel(file.content, lang, uri)
      const openId = file.id
      const createdModel = model
      createdModel.onDidChangeContent(() => {
        useEditorStore.getState().setContent(openId, createdModel.getValue())
      })
      fileModels.current.set(file.id, model)
    }
    editor.setModel(model)
    editor.updateOptions({ readOnly: file.readOnly })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monacoApi, activeId, switchSignal])

  // Reveal a requested line once its model exists.
  useEffect(() => {
    if (!pendingReveal || !editorRef.current) return
    const model = fileModels.current.get(pendingReveal.fileId)
    if (!model || editorRef.current.getModel() !== model) return
    editorRef.current.revealLineInCenter(pendingReveal.line)
    editorRef.current.setPosition({ lineNumber: pendingReveal.line, column: 1 })
    editorRef.current.focus()
    clearPendingReveal()
  }, [pendingReveal, switchSignal, clearPendingReveal])

  return (
    <div className="zy-editor-pane">
      <div className="zy-editor-tabs">
        {files.map((f) => (
          <div
            key={f.id}
            className={`zy-editor-tab${f.id === activeId ? ' zy-editor-tab--active' : ''}`}
            onClick={() => setActive(f.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeFile(f.id)
              }
            }}
            title={f.path}
          >
            <span className="zy-editor-tab-icon">{f.kind === 'diff' ? '⇄' : '📄'}</span>
            <span className="zy-editor-tab-title">
              {f.name}
              {f.kind === 'diff' ? ' (diff)' : ''}
            </span>
            {f.dirty && <span className="zy-editor-tab-dot" title="Есть несохранённые изменения" />}
            <button
              className="zy-tab-close"
              title="Закрыть"
              onClick={(e) => {
                e.stopPropagation()
                closeFile(f.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="zy-editor-body">
        {!monacoApi && <div className="zy-editor-loading">Загрузка редактора…</div>}
        {monacoApi && activeFile?.kind === 'file' && activeFile.loading && (
          <div className="zy-editor-loading">Открываю «{activeFile.name}»…</div>
        )}
        <div ref={editorHostRef} className={`zy-editor-host${showDiff ? ' zy-editor-host--hidden' : ''}`} />
        <div ref={diffHostRef} className={`zy-editor-host${showDiff ? '' : ' zy-editor-host--hidden'}`} />
      </div>
    </div>
  )
}

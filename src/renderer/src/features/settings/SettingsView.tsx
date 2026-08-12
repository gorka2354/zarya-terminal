import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AI_MODEL_PRESETS,
  DEFAULT_KEYBINDINGS,
  EFFORT_TUNING,
  OLLAMA_DEFAULT_URL,
  OPENAI_COMPAT_PRESETS
} from '@shared/defaults'
import type { AiEffort, AiProviderKind, AiProviderStatus, AppInfo } from '@shared/types'
import { MANIFEST_SAMPLE } from '@shared/sttCustom'
import { getAllActions, onActionsChanged } from '@/lib/actionRegistry'
import { Icon, type IconName } from '@/components/Icon'
import { chordFromEvent, formatChord } from '@/features/palette/keybindings'
import { getThemes } from '@/features/themes/themes'
import { setIdeMode } from '@/features/ide/ideMode'
import { ToolsTab } from './ToolsTab'
import { EngineTab } from './EngineTab'
import {
  isProtectionRisky,
  protectionHint,
  protectionLabel,
  type SecretProtection
} from '@shared/secretProtection'
import {
  labelsHidden,
  listMics,
  micName,
  onDeviceChange,
  revealMicLabels,
  usableMics,
  type MicDevice
} from '@/features/voice/devices'
import { MicCheck } from './MicCheck'
import { useUpdateStore } from '@/features/updates/updateStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import './settings.css'
import { t, useLang } from '@/lib/i18n'
import type { UiLang } from '@shared/types'

type TabId =
  | 'appearance'
  | 'terminal'
  | 'blocks'
  | 'ai'
  | 'tools'
  | 'engine'
  | 'voice'
  | 'sessions'
  | 'editor'
  | 'keybindings'
  | 'about'

type TabGroup = 'base' | 'ide' | 'meta'
const TABS: Array<{ id: TabId; labelKey: string; sub: string; icon: IconName; group: TabGroup }> = [
  {
    id: 'appearance',
    labelKey: 'set.tab.appearance',
    sub: 'APPEARANCE',
    icon: 'star',
    group: 'base'
  },
  {
    id: 'terminal',
    labelKey: 'set.tab.terminal',
    sub: 'TERMINAL',
    icon: 'terminal',
    group: 'base'
  },
  { id: 'blocks', labelKey: 'set.tab.blocks', sub: 'BLOCKS', icon: 'split-h', group: 'base' },
  { id: 'voice', labelKey: 'set.tab.voice', sub: 'VOICE', icon: 'mic', group: 'base' },
  { id: 'sessions', labelKey: 'set.tab.sessions', sub: 'SESSIONS', icon: 'save', group: 'base' },
  // Инструменты агента живут в БАЗОВОЙ группе, а не в IDE: надстройку можно
  // выключить целиком, но агент в строке панели работает и без неё — и его
  // MCP-серверы всё так же ломаются молча.
  { id: 'tools', labelKey: 'set.tab.tools', sub: 'MCP · TOOLS', icon: 'bolt', group: 'base' },
  // Движок — тоже базовая группа, и по тому же доводу, что и «Инструменты»:
  // когда Claude Code сломан, сломанной выглядит Заря, и спрятать диагноз за
  // IDE-надстройку значит спрятать его ровно от того, кому он нужен.
  {
    id: 'engine',
    labelKey: 'set.tab.engine',
    sub: 'ENGINE · HEALTH',
    icon: 'sputnik',
    group: 'base'
  },
  { id: 'keybindings', labelKey: 'set.tab.keys', sub: 'KEYBINDINGS', icon: 'gear', group: 'base' },
  // IDE superstructure — only shown when the IDE layer is enabled.
  { id: 'ai', labelKey: 'set.tab.ai', sub: 'IDE · AGENT', icon: 'sputnik', group: 'ide' },
  { id: 'editor', labelKey: 'set.tab.editor', sub: 'IDE · EDITOR', icon: 'edit', group: 'ide' },
  { id: 'about', labelKey: 'set.tab.about', sub: 'ABOUT', icon: 'orbit', group: 'meta' }
]

const PROVIDERS: Array<{ id: AiProviderKind; label: string; labelKey?: string }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'ollama', label: 'Ollama', labelKey: 'set.prov.ollama' },
  { id: 'openai-compat', label: 'OpenAI', labelKey: 'set.prov.compat' }
]

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** Full-screen settings modal: vertical tabs on the left, content on the right. */
export default function SettingsView(): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const open = useUiStore((s) => s.settingsOpen)
  // Версия в подписи — настоящая: зашитая строкой, она отстаёт от сборки и
  // тихо врёт ровно в том месте, куда идут смотреть версию.
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    if (open) void window.zarya.app.info().then(setAppInfo)
  }, [open])
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  const [tab, setTab] = useState<TabId>('appearance')

  /*
   * Открыть сразу нужный раздел, если попросили.
   *
   * Палитра ведёт в «Инструменты» одним действием — высаживать человека во
   * «Внешний вид», откуда он ищет раздел сам, значит выполнить просьбу лишь
   * наполовину. Просьбу гасим сразу: она разовая, а не состояние.
   */
  const wantTab = useUiStore((s) => s.settingsTab)
  useEffect(() => {
    if (!wantTab) return
    if (TABS.some((x) => x.id === wantTab)) setTab(wantTab as TabId)
    useUiStore.getState().set({ settingsTab: undefined })
  }, [wantTab])

  // If the IDE layer is turned off while an IDE tab is open, fall back to base.
  useEffect(() => {
    if (!ideMode && (tab === 'ai' || tab === 'editor')) setTab('appearance')
  }, [ideMode, tab])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useUiStore.getState().set({ settingsOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const close = (): void => useUiStore.getState().set({ settingsOpen: false })
  // Hide IDE-layer tabs when the IDE superstructure is off.
  const visibleTabs = TABS.filter((x) => x.group !== 'ide' || ideMode)
  const activeTab = visibleTabs.find((x) => x.id === tab) ?? visibleTabs[0]
  const renderNavItem = (nav: (typeof TABS)[number]): React.JSX.Element => (
    <button
      key={nav.id}
      type="button"
      className={`zy-settings-nav-item${tab === nav.id ? ' zy-settings-nav-item--active' : ''}`}
      onClick={() => setTab(nav.id)}
    >
      <span className="zy-settings-nav-icon">
        <Icon name={nav.icon} size={17} strokeWidth={1.5} />
      </span>
      <span className="zy-settings-nav-item-text">
        <span className="zy-settings-nav-item-label">{t(nav.labelKey)}</span>
        {showSub(t(nav.labelKey), nav.sub) && (
          <span className="zy-settings-nav-item-sub">{nav.sub}</span>
        )}
      </span>
    </button>
  )

  return (
    <div className="zy-overlay-backdrop zy-overlay-backdrop--center" onMouseDown={close}>
      <div className="zy-settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="zy-settings-nav">
          <div className="zy-settings-nav-title">{t('set.navTitle')}</div>
          <div className="zy-settings-nav-list">
            <div className="zy-settings-nav-group">{t('set.groupBase')}</div>
            {visibleTabs.filter((x) => x.group === 'base').map(renderNavItem)}

            <div className="zy-settings-nav-group zy-settings-nav-group--ide">
              <span>{t('set.groupIde')}</span>
              <button
                type="button"
                className={`zy-settings-ide-switch${ideMode ? ' zy-settings-ide-switch--on' : ''}`}
                title={t(ideMode ? 'set.ideOn' : 'set.ideOff')}
                onClick={() => setIdeMode(!ideMode)}
              >
                <span className="zy-settings-ide-knob" />
              </button>
            </div>
            {ideMode ? (
              visibleTabs.filter((x) => x.group === 'ide').map(renderNavItem)
            ) : (
              <div className="zy-settings-nav-hint">{t('set.ideHint')}</div>
            )}

            <div className="zy-settings-nav-group" />
            {visibleTabs.filter((x) => x.group === 'meta').map(renderNavItem)}
          </div>
          <div className="zy-settings-nav-footer">
            {t('set.navFooter', { v: appInfo?.version ?? '' })}
          </div>
        </nav>
        <div className="zy-settings-content">
          <header className="zy-settings-content-header">
            <div className="zy-settings-content-title-wrap">
              <h2 className="zy-settings-content-title">
                {activeTab ? t(activeTab.labelKey) : null}
              </h2>
              {activeTab && showSub(t(activeTab.labelKey), activeTab.sub) && (
                <span className="zy-settings-content-sub">{activeTab.sub}</span>
              )}
            </div>
            <button
              type="button"
              className="zy-icon-btn"
              onClick={close}
              title={t('common.closeEsc')}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="zy-settings-content-body">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'terminal' && <TerminalTab />}
            {tab === 'blocks' && <BlocksTab />}
            {tab === 'ai' && <AiTab />}
            {tab === 'tools' && <ToolsTab />}
            {tab === 'engine' && <EngineTab />}
            {tab === 'voice' && <VoiceTab />}
            {tab === 'sessions' && <SessionsTab />}
            {tab === 'editor' && <EditorTab />}
            {tab === 'keybindings' && <KeybindingsTab />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared field primitives
// ---------------------------------------------------------------------------

function clamp(n: number, min?: number, max?: number): number {
  let v = n
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

/**
 * Латинская микро-подпись под названием — часть двуязычного пульта: под «Внешний
 * вид» стоит APPEARANCE. В английском интерфейсе она превращается в то же слово
 * дважды, поэтому показываем её, только когда она что-то добавляет.
 */
function showSub(title: string, sub?: string): boolean {
  if (!sub) return false
  return sub.trim().toLowerCase() !== title.trim().toLowerCase()
}

function Row({
  title,
  sub,
  desc,
  stack,
  children
}: {
  title: string
  /** Bilingual EN micro-label rendered under the title (Handjet, dim). */
  sub?: string
  desc?: string
  stack?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`zy-set-row${stack ? ' zy-set-row--stack' : ''}`}>
      <div className="zy-set-row-label">
        <div className="zy-set-row-title">{title}</div>
        {showSub(title, sub) && <div className="zy-set-row-sub">{sub}</div>}
        {desc && <div className="zy-item-sub">{desc}</div>}
      </div>
      <div className="zy-set-row-control">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`zy-switch${checked ? ' zy-switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="zy-switch-knob" />
    </button>
  )
}

/** "Rocket" toggle — pill with a glowing knob, reserved for the dangerous auto-approve switch. */
function RocketToggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`zy-rocket-switch${checked ? ' zy-rocket-switch--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="zy-rocket-switch-knob" />
    </button>
  )
}

function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1
}: {
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
}): React.JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  function commit(): void {
    const parsed = parseFloat(text)
    const n = clamp(Number.isNaN(parsed) ? value : parsed, min, max)
    setText(String(n))
    if (n !== value) onCommit(n)
  }
  return (
    <input
      className="zy-input zy-input--num"
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/** Gold −/+ stepper for font size, glowing digit readout in the middle. */
function FontSizeStepper({
  value,
  onChange,
  min = 9,
  max = 28
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}): React.JSX.Element {
  const set = (v: number): void => onChange(clamp(v, min, max))
  return (
    <div className="zy-fontsize-stepper">
      <button
        type="button"
        className="zy-stepper-btn"
        aria-label={t('set.fontDec')}
        disabled={value <= min}
        onClick={() => set(value - 1)}
      >
        −
      </button>
      <span className="zy-stepper-value">{value}</span>
      <button
        type="button"
        className="zy-stepper-btn"
        aria-label={t('set.fontInc')}
        disabled={value >= max}
        onClick={() => set(value + 1)}
      >
        +
      </button>
    </div>
  )
}

function TextField({
  value,
  onCommit,
  placeholder,
  mono
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  mono?: boolean
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      className={`zy-input${mono ? ' zy-input--mono' : ''}`}
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function TextAreaField({
  value,
  onCommit,
  rows = 4,
  placeholder
}: {
  value: string
  onCommit: (v: string) => void
  rows?: number
  placeholder?: string
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <textarea
      className="zy-input zy-textarea"
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text)
      }}
    />
  )
}

function SelectField<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <select className="zy-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** Two-way segmented control — framed pair of buttons, used for cozy/compact density. */
function SegmentedField<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="zy-segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`zy-segmented-btn${o.value === value ? ' zy-segmented-btn--on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function RangeField({
  value,
  min,
  max,
  step,
  onChange,
  format
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}): React.JSX.Element {
  return (
    <div className="zy-range-wrap">
      <input
        className="zy-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="zy-range-value">{format ? format(value) : value}</span>
    </div>
  )
}

/** Model field styled as a gold console readout (min-width 190/height 34, Handjet). */
function ModelField({
  value,
  options,
  onCommit
}: {
  value: string
  options: string[]
  onCommit: (v: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <>
      <input
        className="zy-input zy-input--model"
        list="zy-ai-model-presets"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== value) onCommit(text)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      <datalist id="zy-ai-model-presets">
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  )
}

/** 4-segment reasoning-thrust bar, mirrors the LaunchPad "тяга" control. */
function EffortControl({
  value,
  onChange
}: {
  value: AiEffort
  onChange: (v: AiEffort) => void
}): React.JSX.Element {
  const idx = EFFORTS.indexOf(value)
  return (
    <div className="zy-effort-control">
      <div className="zy-effort-bars">
        {EFFORTS.map((e, i) => (
          <button
            key={e}
            type="button"
            className={`zy-effort-bar${i <= idx ? ' zy-effort-bar--on' : ''}`}
            title={t(EFFORT_TUNING[e].labelKey)}
            onClick={() => onChange(e)}
          />
        ))}
      </div>
      <span className="zy-effort-value">{t(EFFORT_TUNING[value].labelKey)}</span>
    </div>
  )
}

/** 2-column theme picker: swatches + name + type + active marker. */
function ThemeCardsGrid(): React.JSX.Element {
  const themeId = useSettingsStore((s) => s.settings.appearance.themeId)
  const themes = getThemes()

  const select = (id: string): void => {
    void useSettingsStore.getState().update({ appearance: { themeId: id } as never })
  }

  return (
    <div className="zy-set-theme-grid">
      {themes.map((th) => {
        const active = th.id === themeId
        return (
          <button
            key={th.id}
            type="button"
            className={`zy-set-theme-card${active ? ' zy-set-theme-card--active' : ''}`}
            onClick={() => select(th.id)}
            title={t(th.nameKey)}
          >
            <div className="zy-set-theme-swatches">
              <span className="zy-set-theme-swatch" style={{ background: th.ui.bg }} />
              <span className="zy-set-theme-swatch" style={{ background: th.ui.accent }} />
              <span className="zy-set-theme-swatch" style={{ background: th.ui.accent2 }} />
            </div>
            <div className="zy-set-theme-info">
              <div className="zy-set-theme-name">{t(th.nameKey)}</div>
              <div className="zy-set-theme-type">
                {t(th.type === 'dark' ? 'set.themeDark' : 'set.themeLight')}
              </div>
            </div>
            {active && <span className="zy-set-theme-active">{t('set.themeActive')}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function AppearanceTab(): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const a = useSettingsStore((s) => s.settings.appearance)
  const update = useSettingsStore((s) => s.update)

  return (
    <>
      <section className="zy-set-section">
        {/* Язык — первое, что ищет человек, открывший чужой по языку интерфейс,
            поэтому он стоит выше темы и шрифта. Переключение мгновенное: оба
            словаря лежат в приложении, перезапуск не нужен. */}
        <div className="zy-section-label">{t('common.language')}</div>
        <Row title={t('common.language')} sub="LANGUAGE">
          <select
            className="zy-select"
            data-lang-select
            value={a.language ?? 'auto'}
            onChange={(e) =>
              void update({ appearance: { language: e.target.value as UiLang } as never })
            }
          >
            <option value="auto">{t('common.langAuto')}</option>
            <option value="en">{t('common.langEn')}</option>
            <option value="ru">{t('common.langRu')}</option>
          </select>
        </Row>
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">{t('settings.theme')}</div>
        <ThemeCardsGrid />
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">{t('set.fontSection')}</div>
        <Row title={t('set.font')} sub="FONT FAMILY" desc={t('set.fontDesc')}>
          <TextField
            value={a.fontFamily}
            mono
            onCommit={(v) => void update({ appearance: { fontFamily: v } as never })}
          />
        </Row>
        <Row title={t('set.fontSize')} sub="FONT SIZE">
          <FontSizeStepper
            value={a.fontSize}
            onChange={(v) => void update({ appearance: { fontSize: v } as never })}
          />
        </Row>
        <Row title={t('set.lineHeight')} sub="LINE HEIGHT">
          <NumberField
            value={a.lineHeight}
            min={1}
            max={2.4}
            step={0.05}
            onCommit={(v) => void update({ appearance: { lineHeight: v } as never })}
          />
        </Row>
        <Row title={t('set.padding')} sub="TERMINAL PADDING" desc={t('set.paddingDesc')}>
          <NumberField
            value={a.terminalPadding}
            min={0}
            max={60}
            onCommit={(v) => void update({ appearance: { terminalPadding: v } as never })}
          />
        </Row>
        <Row title={t('set.cursorStyle')} sub="CURSOR STYLE">
          <SelectField
            value={a.cursorStyle}
            options={[
              { value: 'block', label: t('set.cursorBlock') },
              { value: 'bar', label: t('set.cursorBar') },
              { value: 'underline', label: t('set.cursorUnderline') }
            ]}
            onChange={(v) => void update({ appearance: { cursorStyle: v } as never })}
          />
        </Row>
        <Row title={t('set.cursorBlink')} sub="CURSOR BLINK">
          <Toggle
            checked={a.cursorBlink}
            onChange={(v) => void update({ appearance: { cursorBlink: v } as never })}
          />
        </Row>
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">{t('set.window')}</div>
        <Row title={t('set.opacity')} sub="WINDOW OPACITY">
          <RangeField
            value={a.windowOpacity}
            min={0.5}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => void update({ appearance: { windowOpacity: v } as never })}
          />
        </Row>
        <Row title={t('set.acrylic')} sub="ACRYLIC BLUR" desc={t('set.acrylicDesc')}>
          <Toggle
            checked={a.acrylic}
            onChange={(v) => void update({ appearance: { acrylic: v } as never })}
          />
        </Row>
        <Row title={t('set.density')} sub="UI DENSITY">
          <SegmentedField
            value={a.uiDensity}
            options={[
              { value: 'cozy', label: t('set.densityCozy') },
              { value: 'compact', label: t('set.densityCompact') }
            ]}
            onChange={(v) => void update({ appearance: { uiDensity: v } as never })}
          />
        </Row>
      </section>
    </>
  )
}

function TerminalTab(): React.JSX.Element {
  const term = useSettingsStore((s) => s.settings.terminal)
  const profiles = useSettingsStore((s) => s.profiles)
  const update = useSettingsStore((s) => s.update)

  const profileOptions = [
    { value: 'auto', label: t('set.auto') },
    ...profiles.map((p) => ({ value: p.id, label: `${p.icon} ${p.name}` }))
  ]

  return (
    <section className="zy-set-section">
      <Row title={t('set.defaultProfile')} sub="DEFAULT PROFILE" desc={t('set.defaultProfileDesc')}>
        <SelectField
          value={term.defaultProfileId}
          options={profileOptions}
          onChange={(v) => void update({ terminal: { defaultProfileId: v } as never })}
        />
      </Row>
      <Row title={t('set.scrollback')} sub="SCROLLBACK" desc={t('set.scrollbackDesc')}>
        <NumberField
          value={term.scrollback}
          min={100}
          max={1000000}
          step={100}
          onCommit={(v) => void update({ terminal: { scrollback: v } as never })}
        />
      </Row>
      <Row title={t('set.copyOnSelect')} sub="COPY ON SELECT">
        <Toggle
          checked={term.copyOnSelect}
          onChange={(v) => void update({ terminal: { copyOnSelect: v } as never })}
        />
      </Row>
      <Row title={t('set.rightClick')} sub="RIGHT CLICK" desc={t('set.rightClickDesc')}>
        <SelectField
          value={term.rightClickBehavior}
          options={[
            { value: 'paste', label: t('set.rcPaste') },
            { value: 'menu', label: t('set.rcMenu') }
          ]}
          onChange={(v) => void update({ terminal: { rightClickBehavior: v } as never })}
        />
      </Row>
      <Row title={t('set.pasteWarn')} sub="PASTE WARNING">
        <Toggle
          checked={term.pasteWarnMultiline}
          onChange={(v) => void update({ terminal: { pasteWarnMultiline: v } as never })}
        />
      </Row>
      <Row title={t('set.webgl')} sub="WEBGL RENDERER" desc={t('set.webglDesc')}>
        <Toggle
          checked={term.webgl}
          onChange={(v) => void update({ terminal: { webgl: v } as never })}
        />
      </Row>
      <Row title={t('set.bell')} sub="BELL">
        <SelectField
          value={term.bell}
          options={[
            { value: 'none', label: t('set.bellNone') },
            { value: 'visual', label: t('set.bellVisual') }
          ]}
          onChange={(v) => void update({ terminal: { bell: v } as never })}
        />
      </Row>
      <Row title={t('set.confirmClose')} sub="CONFIRM CLOSE">
        <Toggle
          checked={term.confirmCloseRunning}
          onChange={(v) => void update({ terminal: { confirmCloseRunning: v } as never })}
        />
      </Row>
    </section>
  )
}

function BlocksTab(): React.JSX.Element {
  const b = useSettingsStore((s) => s.settings.blocks)
  const update = useSettingsStore((s) => s.update)
  return (
    <section className="zy-set-section">
      <Row title={t('set.blocks')} sub="COMMAND BLOCKS" desc={t('set.blocksDesc')}>
        <Toggle
          checked={b.enabled}
          onChange={(v) => void update({ blocks: { enabled: v } as never })}
        />
      </Row>
      <Row title={t('set.separators')} sub="SEPARATORS" desc={t('set.separatorsDesc')}>
        <Toggle
          checked={b.separators}
          disabled={!b.enabled}
          onChange={(v) => void update({ blocks: { separators: v } as never })}
        />
      </Row>
      <Row title={t('set.exitBadges')} sub="EXIT BADGES" desc={t('set.exitBadgesDesc')}>
        <Toggle
          checked={b.exitBadges}
          disabled={!b.enabled}
          onChange={(v) => void update({ blocks: { exitBadges: v } as never })}
        />
      </Row>
      <Row title={t('set.ghost')} sub="AUTOSUGGEST" desc={t('set.ghostDesc')}>
        <Toggle
          checked={b.autosuggest}
          disabled={!b.enabled}
          onChange={(v) => void update({ blocks: { autosuggest: v } as never })}
        />
      </Row>
    </section>
  )
}

function AiTab(): React.JSX.Element {
  const ai = useSettingsStore((s) => s.settings.ai)
  const update = useSettingsStore((s) => s.update)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaBusy, setOllamaBusy] = useState(false)

  const presets = AI_MODEL_PRESETS[ai.provider] ?? []
  const modelOptions = useMemo(
    () => Array.from(new Set([...presets, ...ollamaModels])),
    [presets, ollamaModels]
  )

  async function refreshOllamaModels(): Promise<void> {
    setOllamaBusy(true)
    try {
      const url = ai.baseUrl || OLLAMA_DEFAULT_URL
      const models = await window.zarya.ai.listOllamaModels(url)
      setOllamaModels(models)
      useUiStore.getState().toast(t('set.modelsFound', { n: models.length }), 'success')
    } catch {
      useUiStore.getState().toast(t('set.modelsFail'), 'error')
    } finally {
      setOllamaBusy(false)
    }
  }

  return (
    <>
      <section className="zy-set-section">
        <Row title={t('set.provider')} sub="PROVIDER">
          <SelectField
            value={ai.provider}
            options={PROVIDERS.map((p) => ({
              value: p.id,
              label: p.labelKey ? t(p.labelKey) : p.label
            }))}
            onChange={(v) => void update({ ai: { provider: v } as never })}
          />
        </Row>
        <Row title={t('set.model')} sub="MODEL" desc={t('set.modelDesc')} stack>
          <div className="zy-inline-group zy-inline-group--wrap">
            <ModelField
              value={ai.model}
              options={modelOptions}
              onCommit={(v) => void update({ ai: { model: v } as never })}
            />
            {ai.provider === 'ollama' && (
              <button
                type="button"
                className="zy-btn zy-btn--sm"
                disabled={ollamaBusy}
                onClick={() => void refreshOllamaModels()}
              >
                {ollamaBusy ? '…' : t('set.refreshList')}
              </button>
            )}
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--launch"
              onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
            >
              <Icon name="rocket" size={13} strokeWidth={1.6} />
              {t('set.openLaunchpad')}
            </button>
          </div>
        </Row>
        <Row
          title="Base URL"
          sub="BASE URL"
          desc={
            ai.provider === 'ollama'
              ? t('set.baseUrlDefault', { url: OLLAMA_DEFAULT_URL })
              : t('set.baseUrlDesc')
          }
        >
          <TextField
            value={ai.baseUrl}
            mono
            placeholder={ai.provider === 'ollama' ? OLLAMA_DEFAULT_URL : 'https://…'}
            onCommit={(v) => void update({ ai: { baseUrl: v } as never })}
          />
          {ai.provider === 'openai-compat' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {OPENAI_COMPAT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="zy-btn zy-btn--sm"
                  title={p.hint}
                  onClick={() => void update({ ai: { baseUrl: p.baseUrl } as never })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </Row>
        <Row
          title={t('set.effort')}
          sub={`REASONING EFFORT · ${t(EFFORT_TUNING[ai.effort].labelKey)}`}
        >
          <EffortControl
            value={ai.effort}
            onChange={(v) => void update({ ai: { effort: v } as never })}
          />
        </Row>
        <Row title={t('set.temperature')} sub="TEMPERATURE" desc={t('set.temperatureDesc')}>
          <RangeField
            value={ai.temperature}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => void update({ ai: { temperature: v } as never })}
          />
        </Row>
        <Row title={t('set.maxTokens')} sub="MAX TOKENS">
          <NumberField
            value={ai.maxTokens}
            min={256}
            max={200000}
            step={256}
            onCommit={(v) => void update({ ai: { maxTokens: v } as never })}
          />
        </Row>
        <Row title={t('set.ctxBlocks')} sub="CONTEXT BLOCKS" desc={t('set.ctxBlocksDesc')}>
          <NumberField
            value={ai.contextBlocks}
            min={0}
            max={20}
            onCommit={(v) => void update({ ai: { contextBlocks: v } as never })}
          />
        </Row>
        <Row
          title={t('set.autoApprove')}
          sub={t('set.autoApproveSub')}
          desc={t('set.autoApproveDesc')}
        >
          <RocketToggle
            checked={ai.autoApprove}
            onChange={(v) => void update({ ai: { autoApprove: v } as never })}
          />
        </Row>
        {ai.autoApprove && <div className="zy-set-warning">{t('set.autoApproveWarn')}</div>}
        <Row title={t('set.sysPrompt')} sub="SYSTEM PROMPT" stack desc={t('set.sysPromptDesc')}>
          <TextAreaField
            value={ai.systemPromptExtra}
            rows={4}
            placeholder={t('set.sysPromptPh')}
            onCommit={(v) => void update({ ai: { systemPromptExtra: v } as never })}
          />
        </Row>
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">{t('set.apiKeys')}</div>
        <ApiKeysBlock />
      </section>
    </>
  )
}

function ApiKeysBlock(): React.JSX.Element {
  const [status, setStatus] = useState<AiProviderStatus[]>([])
  const [inputs, setInputs] = useState<Partial<Record<AiProviderKind, string>>>({})
  const [busy, setBusy] = useState<AiProviderKind | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.zarya.settings.providerStatus())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function hasKey(id: AiProviderKind): boolean {
    return status.find((s) => s.provider === id)?.hasKey ?? false
  }

  /**
   * Один зелёный бейдж на все случаи скрывал главное: при недоступном хранилище
   * ОС ключ пишется открытым текстом. «Сохранён» — это про факт записи, а
   * человек читал его как «в безопасности».
   */
  function protectionOf(id: AiProviderKind): SecretProtection {
    return status.find((s) => s.provider === id)?.protection ?? 'none'
  }

  async function save(id: AiProviderKind): Promise<void> {
    const key = (inputs[id] ?? '').trim()
    if (!key) return
    setBusy(id)
    try {
      await window.zarya.settings.setSecret(id, key)
      setInputs((s) => ({ ...s, [id]: '' }))
      await refresh()
      useUiStore.getState().toast(t('set.keySaved'), 'success')
    } catch {
      useUiStore.getState().toast(t('set.keySaveFail'), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: AiProviderKind): Promise<void> {
    setBusy(id)
    try {
      await window.zarya.settings.setSecret(id, '')
      await refresh()
      useUiStore.getState().toast(t('set.keyDeleted'))
    } catch {
      useUiStore.getState().toast(t('set.keyDeleteFail'), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="zy-apikey-row">
          <div className="zy-apikey-head">
            <span className="zy-set-row-title">{p.labelKey ? t(p.labelKey) : p.label}</span>
            <span
              className={`zy-badge${
                protectionOf(p.id) === 'os'
                  ? ' zy-badge--ok'
                  : isProtectionRisky(protectionOf(p.id))
                    ? ' zy-badge--warn'
                    : ''
              }`}
              title={protectionHint(protectionOf(p.id))}
            >
              {protectionLabel(protectionOf(p.id))}
            </span>
          </div>
          {isProtectionRisky(protectionOf(p.id)) && (
            <div className="zy-set-warning">{protectionHint(protectionOf(p.id))}</div>
          )}
          <div className="zy-apikey-controls">
            <input
              type="password"
              className="zy-input zy-input--mono"
              placeholder={p.id === 'ollama' ? t('set.keyNotNeeded') : 'sk-…'}
              value={inputs[p.id] ?? ''}
              onChange={(e) => setInputs((s) => ({ ...s, [p.id]: e.target.value }))}
            />
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--accent"
              disabled={busy === p.id || !(inputs[p.id] ?? '').trim()}
              onClick={() => void save(p.id)}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--danger"
              disabled={busy === p.id || !hasKey(p.id)}
              onClick={() => void remove(p.id)}
            >
              {t('common.deleteShort')}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

function SessionsTab(): React.JSX.Element {
  const s = useSettingsStore((st) => st.settings.sessions)
  const notifications = useSettingsStore((st) => st.settings.notifications)
  const update = useSettingsStore((st) => st.update)
  return (
    <section className="zy-set-section">
      {/* Зов живёт здесь, а не в «Внешнем виде»: это про работу с панелями, а
          не про то, как приложение выглядит. */}
      <Row
        title={t('set.notifyWaiting')}
        sub="NOTIFY WHEN WAITING"
        desc={t('set.notifyWaitingDesc')}
      >
        <Toggle
          checked={notifications?.whenWaiting ?? true}
          onChange={(v) => void update({ notifications: { whenWaiting: v } as never })}
        />
      </Row>
      <Row
        title={t('set.notifyLongDone')}
        sub="NOTIFY WHEN DONE"
        desc={t('set.notifyLongDoneDesc')}
      >
        <Toggle
          checked={notifications?.whenLongDone ?? true}
          onChange={(v) => void update({ notifications: { whenLongDone: v } as never })}
        />
      </Row>
      <Row title={t('set.restore')} sub="RESTORE ON LAUNCH">
        <SelectField
          value={s.restoreOnLaunch}
          options={[
            { value: 'workspace', label: t('set.restoreWorkspace') },
            { value: 'none', label: t('set.restoreNone') }
          ]}
          onChange={(v) => void update({ sessions: { restoreOnLaunch: v } as never })}
        />
      </Row>
      <Row title={t('set.autosave')} sub="AUTOSAVE INTERVAL">
        <NumberField
          value={s.autosaveSec}
          min={5}
          max={600}
          onCommit={(v) => void update({ sessions: { autosaveSec: v } as never })}
        />
      </Row>
      <Row title={t('set.histLines')} sub="SCROLLBACK LINES" desc={t('set.histLinesDesc')}>
        <NumberField
          value={s.scrollbackSaveLines}
          min={0}
          max={200000}
          step={100}
          onCommit={(v) => void update({ sessions: { scrollbackSaveLines: v } as never })}
        />
      </Row>
      <div className="zy-item-sub zy-set-footnote">{t('set.sessionsNote')}</div>
      <div className="zy-section-label">{t('set.cmdHistory')}</div>
      <HistoryRows />
    </section>
  )
}

/**
 * История команд («Хроника», Ctrl+R).
 *
 * Команды регулярно содержат секреты: токены в переменных окружения, ключи в
 * аргументах curl, пароли в строках подключения. Файл рос без ограничений,
 * выключить запись было нельзя, стереть — тоже. Три недостающих управления и
 * честная строка о том, сколько всего накопилось.
 */
function HistoryRows(): React.JSX.Element {
  const h = useSettingsStore((s) => s.settings.history)
  const update = useSettingsStore((s) => s.update)
  const [stats, setStats] = useState<{ entries: number; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    void window.zarya.history.stats().then(setStats)
  }, [])
  useEffect(() => refresh(), [refresh])

  const size = stats
    ? stats.bytes >= 1_000_000
      ? `${(stats.bytes / 1_000_000).toFixed(1)} ${t('unit.mb')}`
      : `${Math.max(1, Math.round(stats.bytes / 1000))} ${t('unit.kb')}`
    : '…'

  return (
    <>
      <Row title={t('set.keepHistory')} sub="RECORD HISTORY" desc={t('set.keepHistoryDesc')}>
        <Toggle
          checked={h.record}
          onChange={(v) => void update({ history: { record: v } as never })}
        />
      </Row>
      <Row title={t('set.histCap')} sub="MAX ENTRIES" desc={t('set.histCapDesc')}>
        <NumberField
          value={h.maxEntries}
          min={0}
          max={1_000_000}
          step={1000}
          onCommit={(v) => void update({ history: { maxEntries: v } as never })}
        />
      </Row>
      <Row
        title={t('set.histNow')}
        sub="STORED"
        desc={stats ? t('set.histStats', { n: stats.entries, size }) : t('set.counting')}
      >
        <button
          type="button"
          className="zy-btn zy-btn--danger"
          disabled={busy || !stats?.entries}
          onClick={() => {
            setBusy(true)
            void window.zarya.history
              .clear()
              .then(() => {
                refresh()
                useUiStore.getState().toast(t('set.histCleared'), 'success')
              })
              .finally(() => setBusy(false))
          }}
        >
          {t('set.clearHistory')}
        </button>
      </Row>
    </>
  )
}

function EditorTab(): React.JSX.Element {
  const e = useSettingsStore((s) => s.settings.editor)
  const update = useSettingsStore((s) => s.update)
  return (
    <section className="zy-set-section">
      <Row title={t('set.fontSize')} sub="FONT SIZE">
        <NumberField
          value={e.fontSize}
          min={8}
          max={32}
          onCommit={(v) => void update({ editor: { fontSize: v } as never })}
        />
      </Row>
      <Row title={t('set.wordWrap')} sub="WORD WRAP">
        <Toggle
          checked={e.wordWrap}
          onChange={(v) => void update({ editor: { wordWrap: v } as never })}
        />
      </Row>
      <Row title={t('set.minimap')} sub="MINIMAP">
        <Toggle
          checked={e.minimap}
          onChange={(v) => void update({ editor: { minimap: v } as never })}
        />
      </Row>
      <Row title={t('set.tabSize')} sub="TAB SIZE">
        <NumberField
          value={e.tabSize}
          min={1}
          max={8}
          onCommit={(v) => void update({ editor: { tabSize: v } as never })}
        />
      </Row>
    </section>
  )
}

interface KbRow {
  id: string
  title: string
  category: string
}

/**
 * Голос — какой микрофон слушает диктовка.
 *
 * Названия устройств браузер прячет, пока странице не давали доступ к
 * микрофону. Молча показать список безымянных строк — значит переложить
 * угадывание на человека, поэтому это состояние названо прямо и лечится одной
 * кнопкой; сам микрофон ради списка не открывается. На Windows эта строка не
 * появляется никогда — доступ там уже выдан нашим же обработчиком разрешений,
 * — она для macOS/Linux, где гейтит ОС.
 */
function VoiceTab(): React.JSX.Element {
  const voice = useSettingsStore((s) => s.settings.voice)
  const update = useSettingsStore((s) => s.update)
  const [mics, setMics] = useState<MicDevice[]>([])

  const refresh = useCallback(() => {
    void listMics().then(setMics)
  }, [])
  useEffect(() => {
    refresh()
    // Гарнитуру втыкают и вынимают при открытых настройках — список обязан это
    // отражать, иначе выбирают из устаревшего.
    return onDeviceChange(refresh)
  }, [refresh])

  const list = usableMics(mics)
  const hidden = labelsHidden(mics)
  const mode = voice.mode ?? 'stream'
  const options = [
    { value: '', label: t('set.micSystem') },
    ...list.map((d, i) => ({ value: d.deviceId, label: micName(d, i) }))
  ]
  // Сохранённого устройства нет в списке: без этой строки <select> показал бы
  // «Системный по умолчанию» — то есть соврал бы про то, что выбрано.
  const missing = !!voice.deviceId && !list.some((d) => d.deviceId === voice.deviceId)
  if (missing) {
    options.push({
      value: voice.deviceId,
      label: t('set.micMissing', { name: voice.deviceLabel || t('set.micChosen') })
    })
  }

  return (
    <section className="zy-set-section">
      <div className="zy-section-label">{t('set.dictation')}</div>
      <Row title={t('set.mic')} sub="INPUT DEVICE" desc={t('set.micDesc')}>
        <SelectField
          value={voice.deviceId}
          options={options}
          onChange={(v) => {
            const d = list.find((x) => x.deviceId === v)
            void update({
              voice: { deviceId: v, deviceLabel: v ? (d?.label ?? voice.deviceLabel) : '' } as never
            })
          }}
        />
      </Row>
      {hidden && (
        <Row title={t('set.micHidden')} sub="PERMISSION NEEDED" desc={t('set.micHiddenDesc')}>
          <button
            type="button"
            className="zy-btn"
            onClick={() =>
              void revealMicLabels()
                .then(setMics)
                .catch(() => useUiStore.getState().toast(t('set.micDenied'), 'error'))
            }
          >
            {t('set.micReveal')}
          </button>
        </Row>
      )}
      {/*
        Режим — второй вопрос после «какой микрофон»: он про то, как человек
        работает, а не про железо. Три ритма не сводятся один к другому, поэтому
        выбор, а не тумблер «выключать при молчании».
      */}
      <Row title={t('set.micMode')} sub="MODE" desc={t(`set.micMode.${mode}.desc`)}>
        <SelectField
          value={mode}
          options={[
            { value: 'stream', label: t('set.micMode.stream') },
            { value: 'phrase', label: t('set.micMode.phrase') },
            { value: 'hold', label: t('set.micMode.hold') }
          ]}
          onChange={(v) => void update({ voice: { mode: v } as never })}
        />
      </Row>
      {/*
        Проверка стоит СРАЗУ под выбором устройства: вопрос «тот ли микрофон
        выбран» и вопрос «слышит ли он меня» — один и тот же вопрос, и разносить
        их по разным местам значит заставлять человека помнить первый, пока он
        ищет второй.
      */}
      <Row title={t('set.micCheck')} sub="CHECK" desc={t('set.micCheckDesc')}>
        <MicCheck />
      </Row>
      {missing && (
        <Row title={t('set.micGone')} sub="DEVICE MISSING" desc={t('set.micGoneDesc')}>
          <button
            type="button"
            className="zy-btn"
            onClick={() => void update({ voice: { deviceId: '', deviceLabel: '' } as never })}
          >
            {t('set.micBackToSystem')}
          </button>
        </Row>
      )}
      <SttModels />
      <div className="zy-item-sub zy-set-footnote">{t('set.micHold')}</div>
      <div className="zy-item-sub zy-set-footnote">{t('set.micNote')}</div>
    </section>
  )
}

/**
 * Список моделей распознавания.
 *
 * Каждая строка честно говорит вес и лицензию: 225 МБ — заметная трата, и решать
 * должен человек, а не приложение за него. Скачанные можно удалить: держать три
 * модели рядом больше полугигабайта, и незаметно накопить это легко.
 */
function SttModels(): React.JSX.Element {
  const chosen = useSettingsStore((s) => s.settings.voice.modelId)
  const update = useSettingsStore((s) => s.update)
  const [st, setSt] = useState<Awaited<ReturnType<typeof window.zarya.stt.state>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.zarya.stt.state().then(setSt)
  }, [])
  useEffect(() => {
    refresh()
    // Скачивание идёт в main и длится минуты — состояние надо перечитывать.
    return window.zarya.stt.onProgress(() => refresh())
  }, [refresh])

  const mb = (b: number): string => `${Math.round(b / 1_000_000)} ${t('unit.mb')}`
  const models = st?.models ?? []
  const activeId = st?.activeModelId ?? null

  return (
    <>
      <div className="zy-section-label">{t('set.sttModel')}</div>
      {models.length === 0 && <div className="zy-set-hint">…</div>}
      {models.map((m) => {
        const isChosen = (chosen || activeId) === m.id
        return (
          <div key={m.id} className="zy-set-row">
            <div className="zy-set-row-label">
              <div className="zy-set-row-title">
                {/* Своя модель подписана именем, которое дал человек: ключа в
                    словаре у неё нет и быть не может. */}
                {m.custom ? m.name : t(m.labelKey)}
                {m.id === activeId && (
                  <span className="zy-badge zy-badge--ok">{t('set.badgeActive')}</span>
                )}
                {m.custom && <span className="zy-badge">{t('set.customBadge')}</span>}
                {m.custom && !m.installed && (
                  <span className="zy-badge zy-badge--warn">{t('set.customMissing')}</span>
                )}
                {m.legacy && (
                  <span className="zy-badge zy-badge--warn">{t('set.badgeLegacy')}</span>
                )}
              </div>
              <div className="zy-set-row-sub">
                {[m.lang, mb(m.bytes), m.license].filter(Boolean).join(' · ')}
              </div>
              {/* У своей модели вместо пояснения — путь и честная оговорка: она
                  пришла не от нас, и обещать за неё нечего. Длинный путь строка
                  обрезает, поэтому целиком он живёт в подсказке. */}
              <div className="zy-item-sub" title={m.custom ? m.dir : undefined}>
                {m.custom ? m.dir : t(m.noteKey)}
              </div>
              {m.custom && <div className="zy-item-sub">{t('set.customNote')}</div>}
            </div>
            <div className="zy-set-row-control">
              <div className="zy-inline-group">
                {m.custom && !isChosen && m.installed && (
                  <button
                    type="button"
                    className="zy-btn"
                    onClick={() => {
                      void update({ voice: { modelId: m.id } as never })
                      setTimeout(refresh, 200)
                    }}
                  >
                    {t('set.choose')}
                  </button>
                )}
                {m.custom && (
                  <button
                    type="button"
                    className="zy-btn"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy(m.id)
                      void window.zarya.stt
                        .forgetCustom(m.id)
                        .then(() => {
                          useUiStore.getState().toast(t('set.customForgotten'))
                          refresh()
                        })
                        .finally(() => setBusy(null))
                    }}
                  >
                    {t('set.customForget')}
                  </button>
                )}
                {!m.custom && !m.installed && !m.legacy && (
                  <button
                    type="button"
                    className="zy-btn zy-btn--accent"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy(m.id)
                      void window.zarya.stt
                        .ensureModel(m.id)
                        .then((r) => {
                          if (r?.ok) {
                            void update({ voice: { modelId: m.id } as never })
                            useUiStore.getState().toast(t('set.modelReady'), 'success')
                          } else {
                            useUiStore.getState().toast(r?.error ?? t('set.modelFail'), 'error')
                          }
                          refresh()
                        })
                        .finally(() => setBusy(null))
                    }}
                  >
                    {busy === m.id
                      ? t('set.downloading')
                      : t('set.download', { size: mb(m.bytes) })}
                  </button>
                )}
                {!m.custom && m.installed && !isChosen && (
                  <button
                    type="button"
                    className="zy-btn"
                    onClick={() => {
                      void update({ voice: { modelId: m.id } as never })
                      setTimeout(refresh, 200)
                    }}
                  >
                    {t('set.choose')}
                  </button>
                )}
                {!m.custom && m.installed && (
                  <button
                    type="button"
                    className="zy-btn zy-btn--danger"
                    disabled={!!busy}
                    onClick={() => {
                      setBusy(m.id)
                      void window.zarya.stt
                        .removeModel(m.id)
                        .then(() => {
                          useUiStore.getState().toast(t('set.modelDeleted'))
                          refresh()
                        })
                        .finally(() => setBusy(null))
                    }}
                  >
                    {t('common.deleteShort')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {/* Своя модель. Кнопка не спрашивает ссылку и не может её принять: папку
          выбирает человек в системном диалоге главного процесса. Скачать чужой
          файл в нативный движок и открыть свой — разные вещи, и разница здесь
          выражена тем, что поля ввода тут просто нет. */}
      <div className="zy-section-label">{t('set.customTitle')}</div>
      {/* Пояснение отдельной строкой: в колонке подписи оно ужималось до
          многоточия ровно на той половине фразы, ради которой написано. */}
      <div className="zy-set-hint">{t('set.customHint')}</div>
      <div className="zy-set-row">
        <div className="zy-set-row-label" />
        <div className="zy-set-row-control">
          <div className="zy-inline-group">
            <button
              type="button"
              className="zy-btn"
              onClick={() => {
                void navigator.clipboard
                  .writeText(MANIFEST_SAMPLE)
                  .then(() => useUiStore.getState().toast(t('set.customSampleDone')))
              }}
            >
              {t('set.customSample')}
            </button>
            <button
              type="button"
              className="zy-btn zy-btn--accent"
              disabled={busy === 'custom'}
              onClick={() => {
                setBusy('custom')
                void window.zarya.stt
                  .addCustom()
                  .then((r) => {
                    // Отказ от диалога — не ошибка: человек передумал, и
                    // сообщать ему об этом нечего.
                    if (r?.canceled) return
                    if (r?.ok)
                      useUiStore
                        .getState()
                        .toast(t('set.customAdded', { name: r.model?.name ?? '' }), 'success')
                    else useUiStore.getState().toast(r?.error ?? t('set.modelFail'), 'error')
                    refresh()
                  })
                  .finally(() => setBusy(null))
              }}
            >
              {t('set.customAdd')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function KeybindingsTab(): React.JSX.Element {
  const keybindings = useSettingsStore((s) => s.settings.keybindings)
  const update = useSettingsStore((s) => s.update)
  const [, forceTick] = useState(0)
  const [recordingId, setRecordingId] = useState<string | null>(null)

  useEffect(() => onActionsChanged(() => forceTick((n) => n + 1)), [])

  useEffect(() => {
    if (!recordingId) return
    const onKey = (e: KeyboardEvent): void => {
      const chord = chordFromEvent(e)
      if (!chord) return // pure modifier key press — keep waiting
      e.preventDefault()
      e.stopPropagation()
      if (chord === 'Escape') {
        setRecordingId(null)
        return
      }
      void update({ keybindings: { ...keybindings, [recordingId]: chord } })
      setRecordingId(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [recordingId, keybindings, update])

  const groups = useMemo(() => {
    const actions = getAllActions()
    const byId = new Map(actions.map((a) => [a.id, a]))
    const ids = new Set([...byId.keys(), ...Object.keys(keybindings)])
    const list: KbRow[] = [...ids].map((id) => {
      const a = byId.get(id)
      return { id, title: a?.title ?? id, category: a?.category ?? t('set.catOther') }
    })
    list.sort((x, y) => x.category.localeCompare(y.category) || x.title.localeCompare(y.title))
    const map = new Map<string, KbRow[]>()
    for (const r of list) {
      const g = map.get(r.category) ?? []
      g.push(r)
      map.set(r.category, g)
    }
    return map
  }, [keybindings])

  function resetAll(): void {
    if (!window.confirm(t('set.resetAsk'))) return
    void update({ keybindings: { ...DEFAULT_KEYBINDINGS } })
  }

  return (
    <section className="zy-set-section">
      <div className="zy-kb-toolbar">
        <div className="zy-item-sub">{t('set.keysHint')}</div>
        <button type="button" className="zy-btn zy-btn--sm" onClick={resetAll}>
          {t('set.resetAll')}
        </button>
      </div>
      {[...groups.entries()].map(([category, list]) => (
        <div key={category} className="zy-kb-group">
          <div className="zy-section-label">{category}</div>
          {list.map((r) => {
            const chord = keybindings[r.id]
            const def = DEFAULT_KEYBINDINGS[r.id]
            const recording = recordingId === r.id
            return (
              <div key={r.id} className="zy-kb-row">
                <div className="zy-kb-row-title">{r.title}</div>
                <button
                  type="button"
                  className={`zy-kbd zy-kb-chord-btn${recording ? ' zy-kb-chord-btn--recording' : ''}`}
                  onClick={() => setRecordingId(r.id)}
                >
                  {recording ? t('set.pressKeys') : chord ? formatChord(chord) : '—'}
                </button>
                {def && (
                  <button
                    type="button"
                    className="zy-icon-btn"
                    title={t('set.resetOne')}
                    disabled={def === chord}
                    onClick={() => void update({ keybindings: { ...keybindings, [r.id]: def } })}
                  >
                    ↺
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}

/**
 * Обновления в «О программе».
 *
 * Статус пишется честно во всех состояниях: «есть новая», «у вас последняя»,
 * «проверить не удалось» и «проверка выключена». Молчащая строка читалась бы
 * как «всё в порядке» и в том случае, когда проверка просто не состоялась.
 */
function UpdateRows(): React.JSX.Element {
  const enabled = useSettingsStore((s) => s.settings.updates.check)
  const update = useSettingsStore((s) => s.update)
  const state = useUpdateStore((s) => s.state)
  const check = useUpdateStore((s) => s.check)

  /**
   * «Давно ли проверяли» — не украшение. Подменённый ответ или молчащий прокси
   * могут бесконечно отвечать «у вас последняя версия», и человек останется на
   * уязвимой сборке, ничего не заметив. Возраст последней удачной проверки
   * делает такое молчание видимым.
   */
  const ago = ((): string => {
    if (!state?.checkedAt) return ''
    const days = Math.floor((Date.now() - state.checkedAt) / 86_400_000)
    if (days >= 1) return t('set.agoDays', { n: days })
    const hours = Math.floor((Date.now() - state.checkedAt) / 3_600_000)
    return hours >= 1 ? t('set.agoHours', { n: hours }) : t('set.agoNow')
  })()

  const status = ((): string => {
    if (!enabled) return t('set.updOff')
    if (state?.checking) return t('set.updChecking')
    if (state?.error) return t('set.updFail', { err: state.error, ago })
    if (!state?.checkedAt) return t('set.updNever')
    if (state.updateAvailable && state.latest)
      return t('set.updAvail', { v: state.latest.version, ago })
    return t('set.updLatest', { ago })
  })()

  return (
    <>
      <Row title={t('set.updCheck')} sub="UPDATE CHECK" desc={t('set.updCheckDesc')}>
        <Toggle
          checked={enabled}
          onChange={(v) => void update({ updates: { check: v } as never })}
        />
      </Row>
      <Row title={t('set.status')} sub="STATUS" desc={status}>
        <div className="zy-inline-group">
          {state?.updateAvailable && state.latest && (
            <button
              type="button"
              className="zy-btn zy-btn--accent"
              onClick={() => useUiStore.getState().set({ settingsOpen: false, updateOpen: true })}
            >
              {t('set.whatsNew')}
            </button>
          )}
          <button
            type="button"
            className="zy-btn"
            disabled={state?.checking}
            onClick={() => void check()}
          >
            {t('set.checkNow')}
          </button>
        </div>
      </Row>
    </>
  )
}

function AboutTab(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.zarya.app.info().then(setInfo)
  }, [])

  return (
    <section className="zy-set-section">
      <div className="zy-about-mark">
        <div className="zy-about-logo">Z</div>
        <div>
          <div className="zy-about-title">Zarya Terminal</div>
          <div className="zy-item-sub">
            {info ? t('set.version', { v: info.version }) : t('set.loading')}
          </div>
        </div>
      </div>
      {info && (
        <div className="zy-about-grid">
          <div className="zy-about-k">{t('set.platform')}</div>
          <div className="zy-about-v">{info.platform}</div>
          <div className="zy-about-k">Electron</div>
          <div className="zy-about-v">{info.electron}</div>
          <div className="zy-about-k">Chrome</div>
          <div className="zy-about-v">{info.chrome}</div>
          <div className="zy-about-k">Node.js</div>
          <div className="zy-about-v">{info.node}</div>
          <div className="zy-about-k">{t('set.dataFolder')}</div>
          <div className="zy-about-v zy-about-v--mono" title={info.userDataPath}>
            {info.userDataPath}
          </div>
        </div>
      )}
      <UpdateRows />
      <div className="zy-about-actions">
        <button
          type="button"
          className="zy-btn zy-btn--accent"
          onClick={() =>
            window.zarya.app.openExternal('https://github.com/gorka2354/zarya-terminal')
          }
        >
          {t('set.repo')}
        </button>
        {info && (
          <button
            type="button"
            className="zy-btn"
            onClick={() => window.zarya.app.showItemInFolder(info.userDataPath)}
          >
            {t('set.openDataFolder')}
          </button>
        )}
      </div>
    </section>
  )
}

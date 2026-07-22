import { useCallback, useEffect, useMemo, useState } from 'react'
import { AI_MODEL_PRESETS, DEFAULT_KEYBINDINGS, EFFORT_TUNING, OLLAMA_DEFAULT_URL } from '@shared/defaults'
import type { AiEffort, AiProviderKind, AiProviderStatus, AppInfo } from '@shared/types'
import { getAllActions, onActionsChanged } from '@/lib/actionRegistry'
import { Icon, type IconName } from '@/components/Icon'
import { chordFromEvent, formatChord } from '@/features/palette/keybindings'
import { getThemes } from '@/features/themes/themes'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import './settings.css'

type TabId = 'appearance' | 'terminal' | 'blocks' | 'ai' | 'sessions' | 'editor' | 'keybindings' | 'about'

const TABS: Array<{ id: TabId; label: string; sub: string; icon: IconName }> = [
  { id: 'appearance', label: 'Внешний вид', sub: 'APPEARANCE', icon: 'star' },
  { id: 'terminal', label: 'Терминал', sub: 'TERMINAL', icon: 'terminal' },
  { id: 'blocks', label: 'Блоки', sub: 'BLOCKS', icon: 'split-h' },
  { id: 'ai', label: 'AI', sub: 'AGENT', icon: 'sputnik' },
  { id: 'sessions', label: 'Сессии', sub: 'SESSIONS', icon: 'save' },
  { id: 'editor', label: 'Редактор', sub: 'EDITOR', icon: 'edit' },
  { id: 'keybindings', label: 'Клавиши', sub: 'KEYBINDINGS', icon: 'gear' },
  { id: 'about', label: 'О программе', sub: 'ABOUT', icon: 'orbit' }
]

const PROVIDERS: Array<{ id: AiProviderKind; label: string }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'ollama', label: 'Ollama (локально)' },
  { id: 'openai-compat', label: 'OpenAI-совместимый' }
]

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** Full-screen settings modal: vertical tabs on the left, content on the right. */
export default function SettingsView(): React.JSX.Element | null {
  const open = useUiStore((s) => s.settingsOpen)
  const [tab, setTab] = useState<TabId>('appearance')

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
  const activeTab = TABS.find((t) => t.id === tab)

  return (
    <div className="zy-overlay-backdrop zy-overlay-backdrop--center" onMouseDown={close}>
      <div className="zy-settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="zy-settings-nav">
          <div className="zy-settings-nav-title">ЦЕНТР УПРАВЛЕНИЯ</div>
          <div className="zy-settings-nav-list">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`zy-settings-nav-item${tab === t.id ? ' zy-settings-nav-item--active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="zy-settings-nav-icon">
                  <Icon name={t.icon} size={17} strokeWidth={1.5} />
                </span>
                <span className="zy-settings-nav-item-text">
                  <span className="zy-settings-nav-item-label">{t.label}</span>
                  <span className="zy-settings-nav-item-sub">{t.sub}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="zy-settings-nav-footer">ЗАРЯ v0.4 · ОРБИТА</div>
        </nav>
        <div className="zy-settings-content">
          <header className="zy-settings-content-header">
            <div className="zy-settings-content-title-wrap">
              <h2 className="zy-settings-content-title">{activeTab?.label}</h2>
              {activeTab?.sub && <span className="zy-settings-content-sub">{activeTab.sub}</span>}
            </div>
            <button type="button" className="zy-icon-btn" onClick={close} title="Закрыть (Esc)">
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="zy-settings-content-body">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'terminal' && <TerminalTab />}
            {tab === 'blocks' && <BlocksTab />}
            {tab === 'ai' && <AiTab />}
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
        {sub && <div className="zy-set-row-sub">{sub}</div>}
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
        aria-label="Уменьшить размер шрифта"
        disabled={value <= min}
        onClick={() => set(value - 1)}
      >
        −
      </button>
      <span className="zy-stepper-value">{value}</span>
      <button
        type="button"
        className="zy-stepper-btn"
        aria-label="Увеличить размер шрифта"
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
            title={EFFORT_TUNING[e].label}
            onClick={() => onChange(e)}
          />
        ))}
      </div>
      <span className="zy-effort-value">{EFFORT_TUNING[value].label}</span>
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
      {themes.map((t) => {
        const active = t.id === themeId
        return (
          <button
            key={t.id}
            type="button"
            className={`zy-set-theme-card${active ? ' zy-set-theme-card--active' : ''}`}
            onClick={() => select(t.id)}
            title={t.name}
          >
            <div className="zy-set-theme-swatches">
              <span className="zy-set-theme-swatch" style={{ background: t.ui.bg }} />
              <span className="zy-set-theme-swatch" style={{ background: t.ui.accent }} />
              <span className="zy-set-theme-swatch" style={{ background: t.ui.accent2 }} />
            </div>
            <div className="zy-set-theme-info">
              <div className="zy-set-theme-name">{t.name}</div>
              <div className="zy-set-theme-type">{t.type === 'dark' ? 'ТЁМНАЯ · DARK' : 'СВЕТЛАЯ · LIGHT'}</div>
            </div>
            {active && <span className="zy-set-theme-active">● АКТИВНА</span>}
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
  const a = useSettingsStore((s) => s.settings.appearance)
  const update = useSettingsStore((s) => s.update)

  return (
    <>
      <section className="zy-set-section">
        <div className="zy-section-label">Тема</div>
        <ThemeCardsGrid />
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">Шрифт и терминал</div>
        <Row title="Шрифт" sub="FONT FAMILY" desc="Семейство шрифтов терминала (CSS font-family).">
          <TextField
            value={a.fontFamily}
            mono
            onCommit={(v) => void update({ appearance: { fontFamily: v } as never })}
          />
        </Row>
        <Row title="Размер шрифта" sub="FONT SIZE">
          <FontSizeStepper
            value={a.fontSize}
            onChange={(v) => void update({ appearance: { fontSize: v } as never })}
          />
        </Row>
        <Row title="Межстрочный интервал" sub="LINE HEIGHT">
          <NumberField
            value={a.lineHeight}
            min={1}
            max={2.4}
            step={0.05}
            onCommit={(v) => void update({ appearance: { lineHeight: v } as never })}
          />
        </Row>
        <Row title="Отступы терминала" sub="TERMINAL PADDING" desc="Внутренний отступ вокруг текста, в пикселях.">
          <NumberField
            value={a.terminalPadding}
            min={0}
            max={60}
            onCommit={(v) => void update({ appearance: { terminalPadding: v } as never })}
          />
        </Row>
        <Row title="Стиль курсора" sub="CURSOR STYLE">
          <SelectField
            value={a.cursorStyle}
            options={[
              { value: 'block', label: 'Блок' },
              { value: 'bar', label: 'Полоска' },
              { value: 'underline', label: 'Подчёркивание' }
            ]}
            onChange={(v) => void update({ appearance: { cursorStyle: v } as never })}
          />
        </Row>
        <Row title="Мигание курсора" sub="CURSOR BLINK">
          <Toggle
            checked={a.cursorBlink}
            onChange={(v) => void update({ appearance: { cursorBlink: v } as never })}
          />
        </Row>
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">Окно</div>
        <Row title="Прозрачность окна" sub="WINDOW OPACITY">
          <RangeField
            value={a.windowOpacity}
            min={0.5}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => void update({ appearance: { windowOpacity: v } as never })}
          />
        </Row>
        <Row
          title="Акриловый эффект (Windows 11)"
          sub="ACRYLIC BLUR"
          desc="Полупрозрачный размытый фон окна. Нужен перезапуск приложения."
        >
          <Toggle checked={a.acrylic} onChange={(v) => void update({ appearance: { acrylic: v } as never })} />
        </Row>
        <Row title="Плотность интерфейса" sub="UI DENSITY">
          <SegmentedField
            value={a.uiDensity}
            options={[
              { value: 'cozy', label: 'Уютно' },
              { value: 'compact', label: 'Компактно' }
            ]}
            onChange={(v) => void update({ appearance: { uiDensity: v } as never })}
          />
        </Row>
      </section>
    </>
  )
}

function TerminalTab(): React.JSX.Element {
  const t = useSettingsStore((s) => s.settings.terminal)
  const profiles = useSettingsStore((s) => s.profiles)
  const update = useSettingsStore((s) => s.update)

  const profileOptions = [
    { value: 'auto', label: 'Автоматически' },
    ...profiles.map((p) => ({ value: p.id, label: `${p.icon} ${p.name}` }))
  ]

  return (
    <section className="zy-set-section">
      <Row title="Профиль по умолчанию" sub="DEFAULT PROFILE" desc="Какая оболочка открывается для новых вкладок.">
        <SelectField
          value={t.defaultProfileId}
          options={profileOptions}
          onChange={(v) => void update({ terminal: { defaultProfileId: v } as never })}
        />
      </Row>
      <Row title="Буфер прокрутки" sub="SCROLLBACK" desc="Количество строк истории терминала на сессию.">
        <NumberField
          value={t.scrollback}
          min={100}
          max={1000000}
          step={100}
          onCommit={(v) => void update({ terminal: { scrollback: v } as never })}
        />
      </Row>
      <Row title="Копировать при выделении" sub="COPY ON SELECT">
        <Toggle
          checked={t.copyOnSelect}
          onChange={(v) => void update({ terminal: { copyOnSelect: v } as never })}
        />
      </Row>
      <Row title="Клик правой кнопкой" sub="RIGHT CLICK" desc="Что делает правый клик по терминалу.">
        <SelectField
          value={t.rightClickBehavior}
          options={[
            { value: 'paste', label: 'Вставить' },
            { value: 'menu', label: 'Контекстное меню' }
          ]}
          onChange={(v) => void update({ terminal: { rightClickBehavior: v } as never })}
        />
      </Row>
      <Row title="Предупреждать при вставке многострочного текста" sub="PASTE WARNING">
        <Toggle
          checked={t.pasteWarnMultiline}
          onChange={(v) => void update({ terminal: { pasteWarnMultiline: v } as never })}
        />
      </Row>
      <Row
        title="Ускорение WebGL"
        sub="WEBGL RENDERER"
        desc="Рендер терминала через WebGL — быстрее, но может не работать на некоторых GPU."
      >
        <Toggle checked={t.webgl} onChange={(v) => void update({ terminal: { webgl: v } as never })} />
      </Row>
      <Row title="Звуковой сигнал (bell)" sub="BELL">
        <SelectField
          value={t.bell}
          options={[
            { value: 'none', label: 'Отключён' },
            { value: 'visual', label: 'Визуальный' }
          ]}
          onChange={(v) => void update({ terminal: { bell: v } as never })}
        />
      </Row>
      <Row title="Подтверждать закрытие при работающем процессе" sub="CONFIRM CLOSE">
        <Toggle
          checked={t.confirmCloseRunning}
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
      <Row
        title="Блоки команд"
        sub="COMMAND BLOCKS"
        desc="Группировать вывод терминала в блоки по командам (в стиле Warp)."
      >
        <Toggle checked={b.enabled} onChange={(v) => void update({ blocks: { enabled: v } as never })} />
      </Row>
      <Row title="Разделители" sub="SEPARATORS" desc="Тонкая линия-граница между соседними блоками.">
        <Toggle
          checked={b.separators}
          disabled={!b.enabled}
          onChange={(v) => void update({ blocks: { separators: v } as never })}
        />
      </Row>
      <Row
        title="Бейджи кода выхода"
        sub="EXIT BADGES"
        desc="Показывать код завершения команды (успех/ошибка) рядом с блоком."
      >
        <Toggle
          checked={b.exitBadges}
          disabled={!b.enabled}
          onChange={(v) => void update({ blocks: { exitBadges: v } as never })}
        />
      </Row>
      <Row
        title="Автоподсказки"
        sub="AUTOSUGGEST"
        desc="Полупрозрачные подсказки команд из истории (в стиле fish shell)."
      >
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
      useUiStore.getState().toast(`Найдено моделей: ${models.length}`, 'success')
    } catch {
      useUiStore.getState().toast('Не удалось получить список моделей Ollama', 'error')
    } finally {
      setOllamaBusy(false)
    }
  }

  return (
    <>
      <section className="zy-set-section">
        <Row title="Провайдер" sub="PROVIDER">
          <SelectField
            value={ai.provider}
            options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(v) => void update({ ai: { provider: v } as never })}
          />
        </Row>
        <Row
          title="Модель"
          sub="MODEL"
          desc="Можно ввести своё название или выбрать из списка пресетов."
          stack
        >
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
                {ollamaBusy ? '…' : 'Обновить список'}
              </button>
            )}
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--launch"
              onClick={() => useUiStore.getState().set({ launchPadOpen: true })}
            >
              <Icon name="rocket" size={13} strokeWidth={1.6} />
              Открыть пусковой комплекс
            </button>
          </div>
        </Row>
        <Row
          title="Base URL"
          sub="BASE URL"
          desc={
            ai.provider === 'ollama'
              ? `По умолчанию: ${OLLAMA_DEFAULT_URL}`
              : 'Нужен для ollama и openai-compat, для остальных — необязателен.'
          }
        >
          <TextField
            value={ai.baseUrl}
            mono
            placeholder={ai.provider === 'ollama' ? OLLAMA_DEFAULT_URL : 'https://…'}
            onCommit={(v) => void update({ ai: { baseUrl: v } as never })}
          />
        </Row>
        <Row title="Тяга рассуждений" sub={`REASONING EFFORT · ${EFFORT_TUNING[ai.effort].label}`}>
          <EffortControl value={ai.effort} onChange={(v) => void update({ ai: { effort: v } as never })} />
        </Row>
        <Row title="Температура" sub="TEMPERATURE" desc="Выше — разнообразнее и менее предсказуемо.">
          <RangeField
            value={ai.temperature}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => void update({ ai: { temperature: v } as never })}
          />
        </Row>
        <Row title="Макс. токенов ответа" sub="MAX TOKENS">
          <NumberField
            value={ai.maxTokens}
            min={256}
            max={200000}
            step={256}
            onCommit={(v) => void update({ ai: { maxTokens: v } as never })}
          />
        </Row>
        <Row
          title="Блоков контекста"
          sub="CONTEXT BLOCKS"
          desc="Сколько последних блоков терминала прикреплять к запросу автоматически."
        >
          <NumberField
            value={ai.contextBlocks}
            min={0}
            max={20}
            onCommit={(v) => void update({ ai: { contextBlocks: v } as never })}
          />
        </Row>
        <Row
          title="Автоподтверждение команд"
          sub="AUTO-APPROVE · опасно"
          desc="ИИ будет выполнять команды в терминале без запроса подтверждения."
        >
          <RocketToggle
            checked={ai.autoApprove}
            onChange={(v) => void update({ ai: { autoApprove: v } as never })}
          />
        </Row>
        {ai.autoApprove && (
          <div className="zy-set-warning">
            ⚠ Опасно: агент сможет выполнять команды в терминале без вашего одобрения, включая деструктивные.
          </div>
        )}
        <Row
          title="Доп. системный промпт"
          sub="SYSTEM PROMPT"
          stack
          desc="Добавляется к системному промпту ИИ-агента при каждом запросе."
        >
          <TextAreaField
            value={ai.systemPromptExtra}
            rows={4}
            placeholder="Например: всегда отвечай на русском, предпочитай pnpm вместо npm…"
            onCommit={(v) => void update({ ai: { systemPromptExtra: v } as never })}
          />
        </Row>
      </section>
      <section className="zy-set-section">
        <div className="zy-section-label">API-ключи</div>
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

  async function save(id: AiProviderKind): Promise<void> {
    const key = (inputs[id] ?? '').trim()
    if (!key) return
    setBusy(id)
    try {
      await window.zarya.settings.setSecret(id, key)
      setInputs((s) => ({ ...s, [id]: '' }))
      await refresh()
      useUiStore.getState().toast('Ключ сохранён', 'success')
    } catch {
      useUiStore.getState().toast('Не удалось сохранить ключ', 'error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: AiProviderKind): Promise<void> {
    setBusy(id)
    try {
      await window.zarya.settings.setSecret(id, '')
      await refresh()
      useUiStore.getState().toast('Ключ удалён')
    } catch {
      useUiStore.getState().toast('Не удалось удалить ключ', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {PROVIDERS.map((p) => (
        <div key={p.id} className="zy-apikey-row">
          <div className="zy-apikey-head">
            <span className="zy-set-row-title">{p.label}</span>
            <span className={`zy-badge${hasKey(p.id) ? ' zy-badge--ok' : ''}`}>
              {hasKey(p.id) ? 'Ключ сохранён' : 'Ключ не задан'}
            </span>
          </div>
          <div className="zy-apikey-controls">
            <input
              type="password"
              className="zy-input zy-input--mono"
              placeholder={p.id === 'ollama' ? 'Обычно не требуется' : 'sk-…'}
              value={inputs[p.id] ?? ''}
              onChange={(e) => setInputs((s) => ({ ...s, [p.id]: e.target.value }))}
            />
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--accent"
              disabled={busy === p.id || !(inputs[p.id] ?? '').trim()}
              onClick={() => void save(p.id)}
            >
              Сохранить
            </button>
            <button
              type="button"
              className="zy-btn zy-btn--sm zy-btn--danger"
              disabled={busy === p.id || !hasKey(p.id)}
              onClick={() => void remove(p.id)}
            >
              Удалить
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

function SessionsTab(): React.JSX.Element {
  const s = useSettingsStore((st) => st.settings.sessions)
  const update = useSettingsStore((st) => st.update)
  return (
    <section className="zy-set-section">
      <Row title="Восстановление при запуске" sub="RESTORE ON LAUNCH">
        <SelectField
          value={s.restoreOnLaunch}
          options={[
            { value: 'workspace', label: 'Восстанавливать рабочее пространство' },
            { value: 'none', label: 'Не восстанавливать' }
          ]}
          onChange={(v) => void update({ sessions: { restoreOnLaunch: v } as never })}
        />
      </Row>
      <Row title="Автосохранение, сек" sub="AUTOSAVE INTERVAL">
        <NumberField
          value={s.autosaveSec}
          min={5}
          max={600}
          onCommit={(v) => void update({ sessions: { autosaveSec: v } as never })}
        />
      </Row>
      <Row
        title="Строк истории на сессию"
        sub="SCROLLBACK LINES"
        desc="Сколько строк вывода терминала сохраняется на диск для каждой сессии."
      >
        <NumberField
          value={s.scrollbackSaveLines}
          min={0}
          max={200000}
          step={100}
          onCommit={(v) => void update({ sessions: { scrollbackSaveLines: v } as never })}
        />
      </Row>
      <div className="zy-item-sub zy-set-footnote">
        Сессии сохраняются локально и переживают перезагрузку устройства.
      </div>
    </section>
  )
}

function EditorTab(): React.JSX.Element {
  const e = useSettingsStore((s) => s.settings.editor)
  const update = useSettingsStore((s) => s.update)
  return (
    <section className="zy-set-section">
      <Row title="Размер шрифта" sub="FONT SIZE">
        <NumberField
          value={e.fontSize}
          min={8}
          max={32}
          onCommit={(v) => void update({ editor: { fontSize: v } as never })}
        />
      </Row>
      <Row title="Перенос строк" sub="WORD WRAP">
        <Toggle checked={e.wordWrap} onChange={(v) => void update({ editor: { wordWrap: v } as never })} />
      </Row>
      <Row title="Миникарта" sub="MINIMAP">
        <Toggle checked={e.minimap} onChange={(v) => void update({ editor: { minimap: v } as never })} />
      </Row>
      <Row title="Размер табуляции" sub="TAB SIZE">
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
      return { id, title: a?.title ?? id, category: a?.category ?? 'Другое' }
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
    if (!window.confirm('Сбросить все горячие клавиши к значениям по умолчанию?')) return
    void update({ keybindings: { ...DEFAULT_KEYBINDINGS } })
  }

  return (
    <section className="zy-set-section">
      <div className="zy-kb-toolbar">
        <div className="zy-item-sub">
          Клик по сочетанию клавиш начинает запись — нажмите новую комбинацию. Esc отменяет запись.
        </div>
        <button type="button" className="zy-btn zy-btn--sm" onClick={resetAll}>
          Сбросить всё
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
                  {recording ? 'Нажмите клавиши…' : chord ? formatChord(chord) : '—'}
                </button>
                {def && (
                  <button
                    type="button"
                    className="zy-icon-btn"
                    title="Сбросить к умолчанию"
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
          <div className="zy-item-sub">{info ? `Версия ${info.version}` : 'Загрузка…'}</div>
        </div>
      </div>
      {info && (
        <div className="zy-about-grid">
          <div className="zy-about-k">Платформа</div>
          <div className="zy-about-v">{info.platform}</div>
          <div className="zy-about-k">Electron</div>
          <div className="zy-about-v">{info.electron}</div>
          <div className="zy-about-k">Chrome</div>
          <div className="zy-about-v">{info.chrome}</div>
          <div className="zy-about-k">Node.js</div>
          <div className="zy-about-v">{info.node}</div>
          <div className="zy-about-k">Папка данных</div>
          <div className="zy-about-v zy-about-v--mono" title={info.userDataPath}>
            {info.userDataPath}
          </div>
        </div>
      )}
      <div className="zy-about-actions">
        <button
          type="button"
          className="zy-btn zy-btn--accent"
          onClick={() => window.zarya.app.openExternal('https://github.com/gorka2354/zarya-terminal')}
        >
          GitHub репозиторий
        </button>
        {info && (
          <button
            type="button"
            className="zy-btn"
            onClick={() => window.zarya.app.showItemInFolder(info.userDataPath)}
          >
            Открыть папку данных
          </button>
        )}
      </div>
    </section>
  )
}

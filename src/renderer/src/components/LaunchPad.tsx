import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiEffort, AiProviderKind, ClaudeModelInfo } from '@shared/types'
import { AI_MODEL_PRESETS, EFFORT_TUNING } from '@shared/defaults'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import './launchpad.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** Account chips (БОРТ · АККАУНТ) mapped to providers, as in the design. */
const ACCOUNTS: Array<{ tag: string; provider: AiProviderKind; full: string }> = [
  { tag: 'АНТ-1', provider: 'anthropic', full: 'Anthropic' },
  { tag: 'ГПТ-2', provider: 'openai', full: 'OpenAI' },
  { tag: 'ЛУНА', provider: 'ollama', full: 'Ollama · локальный' }
]

/**
 * Rich static catalog used ONLY when the dynamic SDK catalog hasn't loaded yet
 * (no live session ever + nothing cached). Mirrors the real live probe so Fable
 * is present offline and every row carries a version + tagline immediately.
 */
const CLAUDE_MODEL_FALLBACK: ClaudeModelInfo[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus', description: 'Opus 4.8 · 1M контекст', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · максимум', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · рутина', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · быстро' }
]

/** Russian labels for Claude effort levels (display copy, not fetched). */
const CLAUDE_EFFORT_LABELS: Record<string, string> = {
  low: 'МАЛАЯ',
  medium: 'СРЕДНЯЯ',
  high: 'ВЫСОКАЯ',
  xhigh: 'СВЕРХ',
  max: 'ФОРСАЖ'
}

/** Short Russian purpose line per model family (SDK description is the fallback). */
const FAMILY_TAGLINE: Record<string, string> = {
  opus: 'Сложные повседневные задачи',
  fable: 'Максимум для трудных и долгих задач',
  sonnet: 'Быстрая, для рутины',
  haiku: 'Самая быстрая, короткие ответы'
}

/** Family word from any model id/alias/resolved id ('claude-opus-4-8[1m]' -> 'opus'). */
function famOf(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/\[1m\]/i, '')
    .split(/[-\s]/)[0]
    .toLowerCase()
}

/**
 * Parse a version-qualified display name out of a model id: 'claude-opus-4-8[1m]'
 * -> { name: 'Opus 4.8', ctx: true }; 'sonnet' -> { name: 'Sonnet' }. Future-proof:
 * a new 'claude-sonnet-6-2' becomes 'Sonnet 6.2' with no code change.
 */
function parseVersion(id: string): { name: string; ctx: boolean } {
  const ctx = /\[1m\]/i.test(id)
  const s = id
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/i, '')
    .replace(/-\d{6,}$/, '') // trailing date stamp (haiku)
  const parts = s.split('-')
  const fam = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p))
  return { name: nums.length ? `${fam} ${nums.join('.')}` : fam, ctx }
}

/** Two ids refer to the same Claude model (matches alias/legacy/resolved by family). */
function sameModel(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return famOf(a) === famOf(b)
}

/**
 * Whether a model has no effort setting. Trust explicit SDK data first
 * (supportsEffort:false or supportedEffortLevels:[]); when the SDK omits effort
 * info entirely (as it does for Haiku today) fall back to the known no-effort
 * families so the chip section reads honestly instead of offering dead levels.
 */
const NO_EFFORT_FAMILIES = new Set(['haiku'])
function effortOffFor(info: ClaudeModelInfo): boolean {
  if (info.supportsEffort === false) return true
  if (Array.isArray(info.supportedEffortLevels)) return info.supportedEffortLevels.length === 0
  return NO_EFFORT_FAMILIES.has(famOf(info.value)) || NO_EFFORT_FAMILIES.has(famOf(info.resolvedModel || ''))
}

/** Prettify a model id for the non-Claude (builtin provider) console readout. */
function prettyModel(id: string): string {
  if (id === '') return 'ПО УМОЛЧАНИЮ'
  return id
    .replace(/^claude-/, '')
    .replace(/-\d{6,}$/, '')
    .replace(/\[1m\]$/i, '')
    .replace(/-/g, ' ')
    .toUpperCase()
}

interface Row {
  value: string
  title: string
  ctx: boolean
  desc: string
  effortOff: boolean
  selected: boolean
  active: boolean
}

/**
 * «Пусковой комплекс» — the model + reasoning-thrust console, reworked to read
 * like Claude Code's own /model + /effort: every row is version-qualified with a
 * one-line purpose, the ПО УМОЛЧАНИЮ row resolves live to the actual running
 * model, ultracode is a labeled switch, and the pixel rocket collapses to a slim
 * idle strip (only re-expanding for the launch animation).
 */
export function LaunchPad(): React.JSX.Element | null {
  const open = useUiStore((s) => s.launchPadOpen)
  const claudeMode = useUiStore((s) => s.barMode) === 'claude-code'
  const claudeModels = useUiStore((s) => s.claudeModels)
  const claudeStatus = useUiStore((s) => s.claudeStatus)
  const ultracodeOn = useUiStore((s) => s.ultracode)
  const ai = useSettingsStore((s) => s.settings.ai)
  const clockRef = useRef<HTMLSpanElement>(null)
  const openedAt = useRef(0)

  const [provider, setProvider] = useState<AiProviderKind>(ai.provider)
  const [model, setModel] = useState(claudeMode ? ai.claudeModel : ai.model)
  // Effort holds AiEffort (builtin) OR a ClaudeEffortLevel string incl. 'xhigh'.
  const [effort, setEffort] = useState<string>((claudeMode ? ai.claudeEffort : ai.effort) || 'high')
  const [ultracode, setUltra] = useState(ultracodeOn)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    if (open) {
      setProvider(ai.provider)
      setModel(claudeMode ? ai.claudeModel : ai.model)
      setEffort((claudeMode ? ai.claudeEffort : ai.effort) || 'high')
      setUltra(ultracodeOn)
      setLaunching(false)
      openedAt.current = Date.now()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Fetch the dynamic model catalog when opening in Claude mode (if not already
  // delivered by a session's init / restored from the persisted cache).
  useEffect(() => {
    if (open && claudeMode && useUiStore.getState().claudeModels.length === 0) {
      void window.zarya.claudeCode.listModels().then((list) => {
        if (list.length) useUiStore.getState().set({ claudeModels: list })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Mission clock: T+ elapsed since the console opened.
  useEffect(() => {
    if (!open) return
    const tick = (): void => {
      if (!clockRef.current) return
      const s = Math.floor((Date.now() - openedAt.current) / 1000)
      const hh = String(Math.floor(s / 3600)).padStart(2, '0')
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
      const ss = String(s % 60).padStart(2, '0')
      clockRef.current.textContent = `T+ ${hh}:${mm}:${ss}`
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [open])

  const committed = claudeMode ? ai.claudeModel : ai.model
  const runningName = claudeMode && claudeStatus.model ? parseVersion(claudeStatus.model).name : ''

  // Build the model rows. Claude: an ПО УМОЛЧАНИЮ account row (resolves live) +
  // the real catalog rows (version + tagline). Builtin: provider presets.
  const rows = useMemo<Row[]>(() => {
    if (claudeMode) {
      const catalog = claudeModels.length ? claudeModels : CLAUDE_MODEL_FALLBACK
      const runningId = claudeStatus.model || ''
      // No separate ПО УМОЛЧАНИЮ row: an empty pin ('' = no override) resolves to
      // whichever catalog row matches the model actually running, so the markers
      // land on a real row (e.g. Fable) instead of a redundant default entry.
      // Resolve to a SINGLE row value — exact match wins over family, so two
      // same-family variants (sonnet + sonnet[1m]) never both light up.
      const resolveRow = (v: string): string => {
        const val = v || (catalog.find((m) => sameModel(m.resolvedModel || m.value, runningId))?.value ?? '')
        if (!val) return ''
        return (
          catalog.find((m) => m.value === val)?.value ??
          catalog.find((m) => sameModel(m.value, val))?.value ??
          val
        )
      }
      const selRow = resolveRow(model)
      const actRow = resolveRow(committed)
      const out: Row[] = []
      for (const info of catalog) {
        if (info.value === '' || famOf(info.value) === 'default') continue
        const ver = parseVersion(info.resolvedModel || info.value)
        const fam = famOf(info.value)
        out.push({
          value: info.value,
          title: ver.name,
          ctx: ver.ctx,
          desc: FAMILY_TAGLINE[fam] ?? info.description ?? '',
          effortOff: effortOffFor(info),
          selected: info.value === selRow,
          active: info.value === actRow
        })
      }
      // A pinned/selected model not represented in the catalog → show it too.
      if (model && !out.some((r) => r.selected)) {
        out.push({
          value: model,
          title: parseVersion(model).name,
          ctx: /\[1m\]/i.test(model),
          desc: 'Пользовательская модель',
          effortOff: false,
          selected: true,
          active: committed === model
        })
      }
      return out
    }
    // Builtin provider path (unchanged behaviour, simple single-line rows).
    const preset = AI_MODEL_PRESETS[provider] ?? []
    const list = [...preset]
    if (provider === ai.provider && ai.model && !list.includes(ai.model)) list.unshift(ai.model)
    if (model && !list.includes(model)) list.unshift(model)
    const values = list.length ? list : [model || 'модель не задана']
    return values.map((v) => ({
      value: v,
      title: prettyModel(v),
      ctx: false,
      desc: '',
      effortOff: false,
      selected: v === model,
      active: v === ai.model
    }))
  }, [claudeMode, claudeModels, provider, ai.provider, ai.model, model, committed, claudeStatus.model])

  // Effort levels available for the selected Claude model (from the effective
  // catalog — dynamic when present, else the static fallback). An empty pin
  // resolves to the model actually running so e.g. Haiku correctly shows none.
  const claudeEfforts = useMemo<string[]>(() => {
    const catalog = claudeModels.length ? claudeModels : CLAUDE_MODEL_FALLBACK
    const runningId = claudeStatus.model || ''
    const val = model || (catalog.find((m) => sameModel(m.resolvedModel || m.value, runningId))?.value ?? '')
    if (!val) return ['low', 'medium', 'high', 'xhigh', 'max']
    const info = catalog.find((m) => m.value === val) ?? catalog.find((m) => sameModel(m.value, val))
    if (info && effortOffFor(info)) return []
    return info?.supportedEffortLevels ?? ['low', 'medium', 'high', 'xhigh', 'max']
  }, [claudeModels, model, claudeStatus.model])

  const accFull = claudeMode
    ? 'Claude Code · подписка Max'
    : (ACCOUNTS.find((a) => a.provider === provider)?.full ?? provider)

  const effectiveEffort = claudeMode && ultracode ? 'xhigh' : effort
  const effortIdx = claudeMode
    ? Math.max(0, claudeEfforts.indexOf(effectiveEffort))
    : EFFORTS.indexOf(effort as AiEffort)
  const selIdx = Math.max(0, rows.findIndex((r) => r.selected))
  const rocketType = claudeMode ? Math.max(0, selIdx - 1) : selIdx
  const effortValueLabel = ultracode
    ? 'ФОРСАЖ · ULTRACODE'
    : (CLAUDE_EFFORT_LABELS[effort] ?? effort.toUpperCase())
  const launchPreview = claudeMode
    ? claudeEfforts.length === 0 && !ultracode
      ? (rows[selIdx]?.title ?? 'модель')
      : `${rows[selIdx]?.title ?? 'модель'} · ${ultracode ? 'ULTRACODE' : effortValueLabel}`
    : ''

  // Publish a view-model snapshot for the QA harness (visual + functional tests).
  const viewRef = useRef<unknown>(null)
  viewRef.current = {
    open,
    claudeMode,
    catalogSource: claudeModels.length ? 'dynamic' : 'fallback',
    rows: rows.map((r) => ({
      value: r.value,
      title: r.title,
      ctx: r.ctx,
      desc: r.desc,
      effortOff: r.effortOff,
      selected: r.selected,
      active: r.active,
      current: claudeMode && !!runningName && parseVersion(r.value).name.split(' ')[0] === runningName.split(' ')[0]
    })),
    efforts: claudeEfforts,
    effort,
    effectiveEffort,
    effortValueLabel,
    ultracode,
    launchPreview,
    launching
  }
  useEffect(() => {
    ;(window as unknown as { __zaryaLaunchPadState?: () => unknown }).__zaryaLaunchPadState = () =>
      viewRef.current
  }, [])

  if (!open) return null

  const close = (): void => useUiStore.getState().set({ launchPadOpen: false })

  const pickProvider = (p: AiProviderKind): void => {
    setProvider(p)
    const first = (AI_MODEL_PRESETS[p] ?? [])[0]
    if (first) setModel(first)
  }

  const launch = (): void => {
    if (launching) return
    setLaunching(true)
    if (claudeMode) {
      // Apply to the native Claude Code engine: persist model/effort, push model
      // + effort + ultracode LIVE to the running session, update the readout.
      void useSettingsStore
        .getState()
        .update({ ai: { claudeModel: model, claudeEffort: effort } as never })
      const effEffort = ultracode ? 'xhigh' : effort
      useUiStore.getState().set({ ultracode })
      const sid = useSessionsStore.getState().activeSessionId()
      const conv = convForSession(useAiStore.getState(), sid)
      if (conv?.engine === 'claude-code') {
        window.zarya.claudeCode.setModel(conv.id, model || undefined)
        window.zarya.claudeCode.setUltracode(conv.id, ultracode)
        if (!ultracode) window.zarya.claudeCode.setEffort(conv.id, effEffort || undefined)
      }
      const cur = useUiStore.getState().claudeStatus
      // Store the underlying chip effort, NOT the ultracode-forced 'xhigh': the
      // ⚡ULTRACODE badge shows the mode live (from uiStore.ultracode), and this
      // value is persisted — so after a restart (ultracode resets off) the gauge
      // reads the real configured effort instead of a stale standalone XHIGH.
      useUiStore.getState().set({
        claudeStatus: { ...cur, model: model || cur.model, effort }
      })
    } else {
      void useSettingsStore.getState().update({ ai: { provider, model, effort } as never })
    }
    // Settings apply instantly; keep the console open through the full
    // countdown (3·2·1·ПОЕХАЛИ) + liftoff drawn on the canvas, then close.
    window.setTimeout(close, 3000)
  }

  return (
    <div className="zy-lp-backdrop" onMouseDown={close}>
      <div className="zy-launchpad" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`zy-lp-console${launching ? ' zy-lp-console--launching' : ' zy-lp-console--idle'}`}>
          {launching ? (
            <>
              <PadScene launching={launching} rocketType={rocketType} effortIdx={effortIdx} />
              <span className="zy-lp-console-title">ПУСКОВОЙ КОМПЛЕКС</span>
              <span ref={clockRef} className="zy-lp-clock" />
              <span className="zy-lp-scan" />
            </>
          ) : (
            <div className="zy-lp-idle">
              <IdleRocket type={rocketType} />
              <div className="zy-lp-idle-meta">
                <span className="zy-lp-idle-title">ПУСКОВОЙ КОМПЛЕКС</span>
                <span ref={clockRef} className="zy-lp-idle-clock" />
              </div>
            </div>
          )}
        </div>

        <div className="zy-lp-body">
          <div className="zy-lp-head">
            <span className="zy-lp-label zy-lp-label--inline">Борт · аккаунт</span>
            <span className="zy-lp-acc-full">{accFull}</span>
          </div>
          {!claudeMode && (
            <div className="zy-lp-accounts">
              {ACCOUNTS.map((a) => (
                <button
                  key={a.tag}
                  className={`zy-lp-acc${a.provider === provider ? ' zy-lp-acc--on' : ''}`}
                  onClick={() => pickProvider(a.provider)}
                >
                  {a.tag}
                </button>
              ))}
            </div>
          )}

          <div className="zy-lp-label">Двигатель · модель</div>
          <div className="zy-lp-models">
            {rows.map((r) => (
              <button
                key={r.value || '__default'}
                data-model={r.value || '__default'}
                className={`zy-lp-model${r.selected ? ' zy-lp-model--on' : ''}`}
                onClick={() => setModel(r.value)}
                title={r.value || 'account default'}
              >
                <div className="zy-lp-model-top">
                  <span className={`zy-lp-bullet${r.selected ? ' zy-lp-bullet--on' : ''}`} />
                  <span className="zy-lp-model-name">{r.title}</span>
                  {r.ctx && <span className="zy-lp-ver">1M</span>}
                  {r.effortOff && <span className="zy-lp-ver zy-lp-ver--muted">без effort</span>}
                  {r.active && <span className="zy-lp-tag-active">активна</span>}
                </div>
                {r.desc && <span className="zy-lp-model-desc">{r.desc}</span>}
              </button>
            ))}
          </div>

          {claudeMode ? (
            <>
              <div className="zy-lp-eff-head">
                <span className="zy-lp-label zy-lp-label--inline">Тяга · effort</span>
                <span className={`zy-lp-eff-val${ultracode || effort === 'max' ? ' zy-lp-eff-val--hot' : ''}`}>
                  {claudeEfforts.length === 0 && !ultracode ? '—' : effortValueLabel}
                </span>
              </div>
              <div className="zy-lp-cefforts">
                {claudeEfforts.length === 0 && (
                  <span className="zy-lp-ceff-none">Модель без настройки effort</span>
                )}
                {claudeEfforts.map((e) => (
                  <button
                    key={e}
                    data-eff={e}
                    className={`zy-lp-ceff${e === effectiveEffort ? ' zy-lp-ceff--on' : ''}${e === 'max' || e === 'xhigh' ? ' zy-lp-ceff--hot' : ''}`}
                    disabled={ultracode}
                    onClick={() => setEffort(e)}
                  >
                    {CLAUDE_EFFORT_LABELS[e] ?? e.toUpperCase()}
                  </button>
                ))}
              </div>
              {claudeEfforts.length > 1 && (
                <div className="zy-lp-poles">
                  <span>быстрее</span>
                  <span>умнее</span>
                </div>
              )}
              <button
                className={`zy-lp-switch-row${ultracode ? ' zy-lp-switch-row--on' : ''}`}
                data-ultra={ultracode ? 'on' : 'off'}
                onClick={() => setUltra((v) => !v)}
                title="Ultracode: xhigh + оркестрация воркфлоу (рой субагентов). Требует включённых workflows в плане Claude."
              >
                <span className="zy-lp-switch-text">
                  <span className="zy-lp-switch-title">ULTRACODE</span>
                  <span className="zy-lp-switch-desc">xhigh + оркестрация воркфлоу</span>
                </span>
                <span className={`zy-lp-switch${ultracode ? ' zy-lp-switch--on' : ''}`}>
                  <span className="zy-lp-switch-thumb" />
                </span>
              </button>
            </>
          ) : (
            <div className="zy-lp-thrust">
              <span className="zy-lp-label zy-lp-label--inline">Тяга</span>
              <div className="zy-lp-bars">
                {EFFORTS.map((e, i) => (
                  <button
                    key={e}
                    className={`zy-lp-bar${i <= effortIdx ? ' zy-lp-bar--on' : ''}`}
                    title={EFFORT_TUNING[e].label}
                    onClick={() => setEffort(e)}
                  />
                ))}
              </div>
              <span className={`zy-lp-thrust-label${effort === 'max' ? ' zy-lp-thrust-label--max' : ''}`}>
                {EFFORT_TUNING[effort as AiEffort].label}
              </span>
            </div>
          )}

          {claudeMode && launchPreview && (
            <div className="zy-lp-preview">Применить: {launchPreview}</div>
          )}
          <button className="zy-lp-launch" onClick={launch} disabled={launching}>
            ПУСК · ПОЕХАЛИ
          </button>
        </div>
      </div>
    </div>
  )
}

// 5×7 pixel-font glyphs for the on-canvas countdown (3·2·1·ПОЕХАЛИ!).
const PXF: Record<string, string[]> = {
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '00110', '00001', '00001', '11110'],
  П: ['11111', '10001', '10001', '10001', '10001', '10001', '10001'],
  О: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  Е: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  Х: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  А: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  Л: ['00111', '01001', '01001', '01001', '01001', '01001', '10001'],
  И: ['10001', '10001', '10011', '10101', '11001', '10001', '10001'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100']
}

interface Rocket {
  baseTop: number
  y: number
  vy: number
  thr: number
  launching: boolean
  gone: number
}

// Rocket sprites (11×18) — hand-designed pixel art (generated via the Aseprite/
// pixelforge pipeline), one per model slot. Palette chars below.
const ROCKET_PAL: Record<string, string> = {
  W: '#f6f1e2', w: '#ddd6c2', s: '#a89f88', R: '#e2231a', r: '#a81810',
  C: '#6fe0e0', c: '#2f9f9f', G: '#e0b15a', o: '#f0662e', y: '#fff2c0'
}
const ROCKETS: string[][] = [
  ['.....R.....', '....RRr....', '...RRRrr...', '...GGGGG...', '...WWwss...', '...Wwwss...', '...WcCcs...', '...WCCcs...', '...Wcccs...', '...Wwwss...', '...Wwwss...', '...Wwwss...', '..RWwwssR..', '.RRWwwssRR.', 'RRRWwwssRRR', '...sGGGs...', '...oyyyo...', '..RoyyyoR..'],
  ['.....W.....', '....Wws....', '...WWwss...', '...WWwss...', '..WWWwsss..', '..GGGGGGG..', '..WWcCcss..', '..WwCCCss..', '..WWcCcss..', '..RRRRrrr..', '.WWWWwssss.', '.RWWWwsssr.', '..WWWwsss..', '..GGGGGGG..', '...WWwss...', '...oyyyo...', '....ooo....', '.....R.....'],
  ['.....W.....', '....Wws....', '....Wws....', '...Wwwss...', '...WcCcs...', '...Wwwss...', '...Wwwss...', '..rWwwssr..', '..WWwwssW..', '..WRRRrrW..', '..WRRrrrW..', '..WWwwssW..', '..rWwwssr..', '.WWwwsssrr.', '....sGs....', '...oyyyo...', '..RoyyyoR..', '.RRoyyyoRR.'],
  ['.....W.....', '....Wws....', '...WWwss...', '...GGGGG...', '...WWwss...', '...WcCcs...', '...WcCcs...', '...WcCcs...', '...GGGGG...', '...WWwss...', '...Wwwss...', '..WWwwsss..', '.WWwwwssss.', '...WWwss...', '....Wws....', '....oyo....', '....RoR....', '.....R.....']
]

/** Small static per-model rocket glyph for the collapsed idle strip (drawn once). */
function IdleRocket({ type }: { type: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    ctx.clearRect(0, 0, 11, 18)
    const g = ROCKETS[type % ROCKETS.length]
    for (let r = 0; r < g.length; r++)
      for (let c = 0; c < g[r].length; c++) {
        const col = ROCKET_PAL[g[r][c]]
        if (col) {
          ctx.fillStyle = col
          ctx.fillRect(c, r, 1, 1)
        }
      }
  }, [type])
  return <canvas ref={ref} width={11} height={18} className="zy-lp-idle-rocket" />
}

/**
 * Pixel launch-pad scene (a faithful port of the design's `_drawScene`): a
 * vertical-gradient sky over a planet arc, drifting twinkling stars, a gantry
 * with a blinking beacon, and one of five model-specific pixel rockets whose
 * exhaust flame scales with ТЯГА. Hitting ПУСК plays a canvas countdown
 * (3·2·1·ПОЕХАЛИ!) then the rocket accelerates off-frame, leaving a star-streak
 * trail, and glides back to the pad. Internal buffer 132×48, CSS-upscaled with
 * image-rendering:pixelated for crisp pixel art. Only mounted during launch now.
 */
function PadScene({
  launching,
  rocketType,
  effortIdx
}: {
  launching: boolean
  rocketType: number
  effortIdx: number
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const launchRef = useRef(false)
  const typeRef = useRef(rocketType)
  const effortRef = useRef(effortIdx)
  const launchAt = useRef(0)
  launchRef.current = launching
  typeRef.current = rocketType
  effortRef.current = effortIdx

  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const W = 132
    const H = 48
    let raf = 0
    let last = performance.now()
    let beacon = 0
    let sceneLaunched = false
    const A = '#e2231a'
    const G = '#e0b15a'

    const stars = Array.from({ length: 24 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      s: Math.random() < 0.22 ? 2 : 1,
      p: Math.random() * 6
    }))
    let streaks: Array<{ x: number; y: number; v: number }> = []
    const R: Rocket = { baseTop: H - 22, y: H - 22, vy: 0, thr: 0, launching: false, gone: 0 }

    const px = (x: number, y: number, w: number, h: number, c: string): void => {
      if (w <= 0 || h <= 0) return
      ctx.fillStyle = c
      ctx.fillRect(x | 0, y | 0, w, h)
    }

    const drawPixelText = (
      text: string,
      cx: number,
      cy: number,
      ps: number,
      main: string,
      shadow: string,
      alpha: number
    ): void => {
      const gw = 5
      const gh = 7
      const sp = 1
      const total = text.length * (gw + sp) * ps - sp * ps
      let x = Math.round(cx - total / 2)
      const y = Math.round(cy - (gh * ps) / 2)
      ctx.globalAlpha = alpha
      for (const ch of text) {
        const g = PXF[ch]
        if (g) {
          for (let r = 0; r < gh; r++)
            for (let c = 0; c < gw; c++)
              if (g[r][c] === '1') {
                ctx.fillStyle = shadow
                ctx.fillRect(x + c * ps + 1, y + r * ps + 2, ps, ps)
              }
          for (let r = 0; r < gh; r++)
            for (let c = 0; c < gw; c++)
              if (g[r][c] === '1') {
                ctx.fillStyle = main
                ctx.fillRect(x + c * ps, y + r * ps, ps, ps)
              }
        }
        x += (gw + sp) * ps
      }
      ctx.globalAlpha = 1
    }

    const draw = (now: number): void => {
      const dt = Math.min(48, now - last)
      last = now
      beacon += dt

      // sky + planet arc
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, '#05070f')
      g.addColorStop(1, '#0a1024')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#0c1a38'
      ctx.beginPath()
      ctx.arc(W * 0.5, H + 52, 72, Math.PI, 2 * Math.PI)
      ctx.fill()
      ctx.strokeStyle = 'rgba(90,140,220,.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(W * 0.5, H + 52, 72, Math.PI, 2 * Math.PI)
      ctx.stroke()

      // twinkling drifting stars
      for (const st of stars) {
        st.p += dt * 0.004
        st.y += dt * 0.004
        if (st.y > H) st.y = 0
        ctx.globalAlpha = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(st.p))
        px(st.x, st.y, st.s, st.s, '#f0ecd8')
      }
      ctx.globalAlpha = 1

      // gantry + blinking beacon
      px(W - 18, H - 26, 2, 26, '#33405f')
      px(W - 24, H - 24, 6, 1, '#33405f')
      px(W - 24, H - 16, 6, 1, '#33405f')
      px(W - 26, H - 8, 10, 1, '#33405f')
      if (beacon % 1400 < 700) {
        ctx.globalAlpha = 0.9
        px(W - 18, H - 28, 2, 2, A)
        ctx.globalAlpha = 1
      }

      // countdown → liftoff trigger
      let cd: string | null = null
      if (launchRef.current) {
        if (!launchAt.current) launchAt.current = now
        const el = now - launchAt.current
        cd = el < 650 ? '3' : el < 1300 ? '2' : el < 1900 ? '1' : el < 3000 ? 'ПОЕХАЛИ!' : null
        if (el >= 1900 && !sceneLaunched) {
          sceneLaunched = true
          R.launching = true
          R.gone = 0
          R.vy = 0
        }
      } else {
        launchAt.current = 0
        sceneLaunched = false
      }

      // rocket physics
      if (R.launching) {
        R.thr = Math.min(1, R.thr + dt * 0.0018)
        if (R.thr > 0.5) {
          R.vy -= dt * 0.02
          R.y += R.vy
        }
        if (R.y < -16) {
          R.launching = false
          R.gone = now
        }
        if (Math.random() < 0.7) streaks.push({ x: Math.random() * W, y: -2, v: 2 + Math.random() * 3 })
      } else {
        const eb = [0.14, 0.34, 0.58, 0.92][effortRef.current] ?? 0.34
        R.thr += (eb - R.thr) * 0.12
        if (R.gone) {
          if (now - R.gone > 700) {
            R.y = -16
            R.gone = 0
          }
        }
        R.y += (R.baseTop - R.y) * 0.14
        R.vy = 0
      }

      // star-streak trail
      ctx.globalAlpha = 0.85
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i]
        s.y += s.v * dt * 0.16
        px(s.x, s.y, 1, 3, '#f0ecd8')
        if (s.y > H + 4) streaks.splice(i, 1)
      }
      ctx.globalAlpha = 1

      // launch pad base
      px(Math.round(W * 0.42) - 4, H - 7, 8, 2, '#3a4560')

      // rocket sprite (hand-drawn pixel art, one per model) + thrust plume
      if (R.y > -16) {
        const g = ROCKETS[typeRef.current % ROCKETS.length]
        const thr = R.thr
        const cx = Math.round(W * 0.42)
        const jitter = thr > 0.2 && !R.launching ? Math.round((Math.random() - 0.5) * thr * 2) : 0
        const rx = cx - 5 + jitter // sprite is 11 wide, centre col = 5
        const ry = Math.round(R.y) - 4
        // extra exhaust plume during thrust, below the sprite's own flame
        if (thr > 0.14) {
          const L = Math.round(thr * 16) + (Math.random() < 0.5 ? 1 : 0)
          px(cx - 1 + jitter, ry + 18, 2, L, '#fff2c0')
          px(cx - 2 + jitter, ry + 18, 4, Math.max(1, L - 3), G)
          px(cx - 1 + jitter, ry + 19, 2, L + 2, A)
          if (thr > 0.62) {
            const sc = Math.max(2, Math.round(L * 0.5))
            px(cx - 3 + jitter, ry + 19, 1, sc, G)
            px(cx + 2 + jitter, ry + 19, 1, sc, G)
          }
        }
        // blit the sprite
        for (let r = 0; r < g.length; r++) {
          const row = g[r]
          for (let c = 0; c < row.length; c++) {
            const col = ROCKET_PAL[row[c]]
            if (col) px(rx + c, ry + r, 1, 1, col)
          }
        }
      }

      // CRT scanline dim
      ctx.globalAlpha = 0.06
      for (let y = 0; y < H; y += 2) px(0, y, W, 1, '#000')
      ctx.globalAlpha = 1

      // countdown glyph
      if (cd) {
        const big = cd.length <= 2
        const ps = big ? 4 : 2
        drawPixelText(cd, W / 2, H / 2, ps, G, A, 1)
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} width={132} height={48} className="zy-lp-canvas" />
}

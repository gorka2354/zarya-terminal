import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiEffort, AiProviderKind, ClaudeModelInfo } from '@shared/types'
import { AI_MODEL_PRESETS, EFFORT_TUNING } from '@shared/defaults'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { t, useLang } from '@/lib/i18n'
import { useSessionsStore } from '@/state/sessionsStore'
import { convForSession, useAiStore } from '@/features/ai/aiStore'
import { checkModelNews } from '@/features/ai/modelNews'
import {
  famOf,
  parseVersion,
  resolveRowValue,
  sameModel,
  shownRows
} from '@/features/ai/modelMatch'
import './launchpad.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** Account chips (БОРТ · АККАУНТ) mapped to providers, as in the design. */
const ACCOUNTS: Array<{ tagKey: string; provider: AiProviderKind; full: string }> = [
  { tagKey: 'lp.tag.anthropic', provider: 'anthropic', full: 'Anthropic' },
  { tagKey: 'lp.tag.openai', provider: 'openai', full: 'OpenAI' },
  { tagKey: 'lp.tag.ollama', provider: 'ollama', full: 'Ollama' }
]

/**
 * Rich static catalog used ONLY when the dynamic SDK catalog hasn't loaded yet
 * (no live session ever + nothing cached). Mirrors the real live probe so Fable
 * is present offline and every row carries a version + tagline immediately.
 */
/**
 * Emergency catalog, shown only when the live one is unreachable (offline, or
 * the CLI never answered). Deliberately version-FREE: these are floating
 * aliases whose resolved model changes under us on every Claude release —
 * pinning 'claude-opus-4-8' here made the console claim "Opus 4.8" while the
 * CLI actually ran Opus 5. Without a pin the row honestly reads "Opus", and the
 * live catalog (which does carry resolvedModel) supplies the exact version.
 */
const CLAUDE_MODEL_FALLBACK: ClaudeModelInfo[] = [
  { value: 'opus[1m]', displayName: 'Opus', description: '1M context', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // No floating 'fable' alias is published — its own id already names the
  // version, so this one row is version-qualified by nature (and mirrors the
  // live catalog, where the [1m] value resolves to the plain id).
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: '1M context', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: '' }
]

/**
 * Уровень усилия называется так же, как в Claude Code: low/medium/high/xhigh/max.
 * Своя метафора («тяга», «форсаж») читалась красиво, но заставляла держать в
 * голове перевод при чтении документации CLI.
 */
function effortLabel(id: string): string {
  return t(`lp.effort.${id}`) || id.toUpperCase()
}

/**
 * Ключ строки-назначения на семейство моделей (описание из SDK — запасной
 * вариант). Именно КЛЮЧ: карточки собираются один раз, и готовая подпись
 * застыла бы на языке, который был при сборке списка.
 */
const FAMILY_TAGLINE: Record<string, string> = {
  opus: 'lp.model.opus',
  fable: 'lp.model.fable',
  sonnet: 'lp.model.sonnet',
  haiku: 'lp.model.haiku'
}

// Model-identity rules (version-aware matching, row resolution) live in
// features/ai/modelMatch so they can be unit-tested away from the component.

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
  if (id === '') return t('lp.byDefault')
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
 * «Пусковой комплекс» — the model + effort console, reworked to read
 * like Claude Code's own /model + /effort: every row is version-qualified with a
 * one-line purpose, the ПО УМОЛЧАНИЮ row resolves live to the actual running
 * model, ultracode is a labeled switch, and the pixel rocket collapses to a slim
 * idle strip (only re-expanding for the launch animation).
 */
export function LaunchPad(): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

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

  /**
   * Каталог моделей провайдера (встроенный борт). Раньше здесь стоял список,
   * зашитый в код: вышел Opus 5 — а человек по-прежнему выбирал из Opus 4.8.
   * Теперь спрашиваем самого провайдера, а пресет остаётся аварийным.
   */
  const [providerModels, setProviderModels] = useState<string[]>([])
  useEffect(() => {
    if (!open || claudeMode) return
    void window.zarya.ai.listModels(provider).then((cat) => {
      if (!cat?.ids?.length) return
      setProviderModels(cat.ids)
      void checkModelNews(provider, cat.ids)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, claudeMode, provider])

  // Refresh the dynamic model catalog every time the console opens in Claude
  // mode, so a newly released model appears without an app restart. The cached
  // / restored list still renders instantly; this overwrites it once the fresh
  // catalog arrives (main falls back to a standalone fetch when no session is
  // live). An empty result is ignored, so we never blank out a good cache.
  useEffect(() => {
    if (open && claudeMode) {
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
      // Resolve against the RENDERED rows only — resolving against the raw
      // catalog could land on the 'default' entry, which is filtered out below,
      // leaving every row dark while a model was plainly running.
      const shown = shownRows(catalog)
      const selRow = resolveRowValue(shown, model, runningId)
      const actRow = resolveRowValue(shown, committed, runningId)
      const out: Row[] = []
      for (const info of shown) {
        const ver = parseVersion(info.resolvedModel || info.value)
        const fam = famOf(info.value)
        out.push({
          value: info.value,
          title: ver.name,
          ctx: ver.ctx,
          desc: FAMILY_TAGLINE[fam] ? t(FAMILY_TAGLINE[fam]) : (info.description ?? ''),
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
          desc: t('lp.customModel'),
          effortOff: false,
          selected: true,
          active: committed === model
        })
      }
      return out
    }
    // Builtin provider path (unchanged behaviour, simple single-line rows).
    // Живой каталог, если он есть; пресет из кода — только когда спросить не
    // удалось (нет ключа, нет сети). Список из памяти показывать как свежий
    // нельзя: он устаревает молча.
    const preset = AI_MODEL_PRESETS[provider] ?? []
    const list = providerModels.length ? [...providerModels] : [...preset]
    if (provider === ai.provider && ai.model && !list.includes(ai.model)) list.unshift(ai.model)
    if (model && !list.includes(model)) list.unshift(model)
    const values = list.length ? list : [model || t('lp.noModel')]
    return values.map((v) => ({
      value: v,
      title: prettyModel(v),
      ctx: false,
      desc: '',
      effortOff: false,
      selected: v === model,
      active: v === ai.model
    }))
  }, [
    claudeMode,
    claudeModels,
    providerModels,
    provider,
    ai.provider,
    ai.model,
    model,
    committed,
    claudeStatus.model
  ])

  // Effort levels available for the selected Claude model (from the effective
  // catalog — dynamic when present, else the static fallback). An empty pin
  // resolves to the model actually running so e.g. Haiku correctly shows none.
  const claudeEfforts = useMemo<string[]>(() => {
    const catalog = claudeModels.length ? claudeModels : CLAUDE_MODEL_FALLBACK
    const runningId = claudeStatus.model || ''
    // Same rendered-rows resolve as the model list, so the chips always belong
    // to the row the user sees highlighted (never the hidden 'default' entry).
    const shown = shownRows(catalog)
    const val = resolveRowValue(shown, model, runningId)
    if (!val) return ['low', 'medium', 'high', 'xhigh', 'max']
    const info = shown.find((m) => m.value === val) ?? shown.find((m) => sameModel(m.value, val))
    if (info && effortOffFor(info)) return []
    return info?.supportedEffortLevels ?? ['low', 'medium', 'high', 'xhigh', 'max']
  }, [claudeModels, model, claudeStatus.model])

  const accFull = claudeMode
    ? t('lp.claudePlan')
    : (ACCOUNTS.find((a) => a.provider === provider)?.full ?? provider)

  const effectiveEffort = claudeMode && ultracode ? 'xhigh' : effort
  const effortIdx = claudeMode
    ? Math.max(0, claudeEfforts.indexOf(effectiveEffort))
    : EFFORTS.indexOf(effort as AiEffort)
  const selIdx = Math.max(0, rows.findIndex((r) => r.selected))
  const rocketType = claudeMode ? Math.max(0, selIdx - 1) : selIdx
  const effortValueLabel = ultracode
    ? `${t('lp.effort.max')} · ULTRACODE`
    : effortLabel(effort)
  const launchPreview = claudeMode
    ? claudeEfforts.length === 0 && !ultracode
      ? (rows[selIdx]?.title ?? t('lp.model'))
      : `${rows[selIdx]?.title ?? t('lp.model')} · ${ultracode ? 'ULTRACODE' : effortValueLabel}`
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
    // Settings apply instantly; a brief pixel spark confirms the change, then
    // the console closes — no long countdown/liftoff.
    window.setTimeout(close, 450)
  }

  return (
    <div className="zy-lp-backdrop" onMouseDown={close}>
      <div className="zy-launchpad" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`zy-lp-console zy-lp-console--idle${launching ? ' zy-lp-console--fired' : ''}`}>
          <div className="zy-lp-idle">
            <IdleRocket type={rocketType} />
            <div className="zy-lp-idle-meta">
              <span className="zy-lp-idle-title">{t('lp.title')}</span>
              <span ref={clockRef} className="zy-lp-idle-clock" />
            </div>
            {launching && <span className="zy-lp-spark" aria-hidden />}
          </div>
        </div>

        <div className="zy-lp-body">
          <div className="zy-lp-head">
            <span className="zy-lp-label zy-lp-label--inline">{t('lp.account')}</span>
            <span className="zy-lp-acc-full">{accFull}</span>
          </div>
          {!claudeMode && (
            <div className="zy-lp-accounts">
              {ACCOUNTS.map((a) => (
                <button
                  key={a.tagKey}
                  className={`zy-lp-acc${a.provider === provider ? ' zy-lp-acc--on' : ''}`}
                  onClick={() => pickProvider(a.provider)}
                >
                  {t(a.tagKey)}
                </button>
              ))}
            </div>
          )}

          <div className="zy-lp-label">{t('lp.engine')}</div>
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
                  {r.effortOff && <span className="zy-lp-ver zy-lp-ver--muted">{t('lp.noEffort')}</span>}
                  {r.active && <span className="zy-lp-tag-active">{t('lp.active')}</span>}
                </div>
                {r.desc && <span className="zy-lp-model-desc">{r.desc}</span>}
              </button>
            ))}
          </div>

          {claudeMode ? (
            <>
              <div className="zy-lp-eff-head">
                <span className="zy-lp-label zy-lp-label--inline">{t('lp.thrustEffort')}</span>
                <span className={`zy-lp-eff-val${ultracode || effort === 'max' ? ' zy-lp-eff-val--hot' : ''}`}>
                  {claudeEfforts.length === 0 && !ultracode ? '—' : effortValueLabel}
                </span>
              </div>
              <div className="zy-lp-cefforts">
                {claudeEfforts.length === 0 && (
                  <span className="zy-lp-ceff-none">{t('lp.modelNoEffort')}</span>
                )}
                {claudeEfforts.map((e) => (
                  <button
                    key={e}
                    data-eff={e}
                    className={`zy-lp-ceff${e === effectiveEffort ? ' zy-lp-ceff--on' : ''}${e === 'max' || e === 'xhigh' ? ' zy-lp-ceff--hot' : ''}`}
                    disabled={ultracode}
                    onClick={() => setEffort(e)}
                  >
                    {effortLabel(e)}
                  </button>
                ))}
              </div>
              {claudeEfforts.length > 1 && (
                <div className="zy-lp-poles">
                  <span>{t('lp.faster')}</span>
                  <span>{t('lp.smarter')}</span>
                </div>
              )}
              <button
                className={`zy-lp-switch-row${ultracode ? ' zy-lp-switch-row--on' : ''}`}
                data-ultra={ultracode ? 'on' : 'off'}
                onClick={() => setUltra((v) => !v)}
                title={t('lp.ultracodeHint')}
              >
                <span className="zy-lp-switch-text">
                  <span className="zy-lp-switch-title">ULTRACODE</span>
                  <span className="zy-lp-switch-desc">{t('lp.ultracodeDesc')}</span>
                </span>
                <span className={`zy-lp-switch${ultracode ? ' zy-lp-switch--on' : ''}`}>
                  <span className="zy-lp-switch-thumb" />
                </span>
              </button>
            </>
          ) : (
            <div className="zy-lp-thrust">
              <span className="zy-lp-label zy-lp-label--inline">{t('lp.thrust')}</span>
              <div className="zy-lp-bars">
                {EFFORTS.map((e, i) => (
                  <button
                    key={e}
                    className={`zy-lp-bar${i <= effortIdx ? ' zy-lp-bar--on' : ''}`}
                    title={t(EFFORT_TUNING[e].labelKey)}
                    onClick={() => setEffort(e)}
                  />
                ))}
              </div>
              <span className={`zy-lp-thrust-label${effort === 'max' ? ' zy-lp-thrust-label--max' : ''}`}>
                {t(EFFORT_TUNING[effort as AiEffort].labelKey)}
              </span>
            </div>
          )}

          {claudeMode && launchPreview && (
            <div className="zy-lp-preview">{t('lp.apply')}: {launchPreview}</div>
          )}
          <button className="zy-lp-launch" onClick={launch} disabled={launching}>
            {t('lp.launch')}
          </button>
        </div>
      </div>
    </div>
  )
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

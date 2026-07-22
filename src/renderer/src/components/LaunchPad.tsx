import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiEffort, AiProviderKind } from '@shared/types'
import { AI_MODEL_PRESETS, EFFORT_TUNING } from '@shared/defaults'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import './launchpad.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/** Account chips (БОРТ · АККАУНТ) mapped to providers, as in the design. */
const ACCOUNTS: Array<{ tag: string; provider: AiProviderKind; full: string }> = [
  { tag: 'АНТ-1', provider: 'anthropic', full: 'Anthropic' },
  { tag: 'ГПТ-2', provider: 'openai', full: 'OpenAI' },
  { tag: 'ЛУНА', provider: 'ollama', full: 'Ollama · локальный' }
]

/** Prettify a model id for the console readout (claude-sonnet-5 -> SONNET-5). */
function prettyModel(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/-\d{6,}$/, '')
    .replace(/-/g, ' ')
    .toUpperCase()
}

/**
 * «Пусковой комплекс» — the model + reasoning-thrust console. Picking двигатель
 * (model) and ТЯГА (effort) then hitting ПУСК applies both to settings and
 * launches the rocket *inside* the console canvas (no full-screen overlay).
 */
export function LaunchPad(): React.JSX.Element | null {
  const open = useUiStore((s) => s.launchPadOpen)
  const ai = useSettingsStore((s) => s.settings.ai)
  const clockRef = useRef<HTMLSpanElement>(null)
  const openedAt = useRef(0)

  const [provider, setProvider] = useState<AiProviderKind>(ai.provider)
  const [model, setModel] = useState(ai.model)
  const [effort, setEffort] = useState<AiEffort>(ai.effort)
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    if (open) {
      setProvider(ai.provider)
      setModel(ai.model)
      setEffort(ai.effort)
      setLaunching(false)
      openedAt.current = Date.now()
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

  const models = useMemo(() => {
    const preset = AI_MODEL_PRESETS[provider] ?? []
    const list = [...preset]
    if (provider === ai.provider && ai.model && !list.includes(ai.model)) list.unshift(ai.model)
    if (model && !list.includes(model)) list.unshift(model)
    return list.length ? list : [model || 'модель не задана']
  }, [provider, ai.provider, ai.model, model])

  const accFull = ACCOUNTS.find((a) => a.provider === provider)?.full ?? provider

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
    void useSettingsStore.getState().update({ ai: { provider, model, effort } as never })
    // Apply + close after the in-console liftoff finishes (~1.4s).
    window.setTimeout(close, 1400)
  }

  const effortIdx = EFFORTS.indexOf(effort)

  return (
    <div className="zy-lp-backdrop" onMouseDown={close}>
      <div className="zy-launchpad" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-lp-console">
          <PadScene launching={launching} />
          <span className="zy-lp-console-title">ПУСКОВОЙ КОМПЛЕКС</span>
          <span ref={clockRef} className="zy-lp-clock" />
          <span className="zy-lp-scan" />
          {launching && <span className="zy-lp-poehali">ПОЕХАЛИ!</span>}
        </div>

        <div className="zy-lp-body">
          <div className="zy-lp-head">
            <span className="zy-lp-label zy-lp-label--inline">Борт · аккаунт</span>
            <span className="zy-lp-acc-full">{accFull}</span>
          </div>
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

          <div className="zy-lp-label">Двигатель · модель</div>
          <div className="zy-lp-models">
            {models.map((m) => (
              <button
                key={m}
                className={`zy-lp-model${m === model ? ' zy-lp-model--on' : ''}`}
                onClick={() => setModel(m)}
                title={m}
              >
                <span className={`zy-lp-bullet${m === model ? ' zy-lp-bullet--on' : ''}`} />
                <span className="zy-lp-model-name">{prettyModel(m)}</span>
              </button>
            ))}
          </div>

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
              {EFFORT_TUNING[effort].label}
            </span>
          </div>

          <button className="zy-lp-launch" onClick={launch} disabled={launching}>
            ПУСК · ПОЕХАЛИ
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Pixel launch-pad scene. Idle: rocket on the gantry, drifting stars. On
 * `launching`, the rocket lifts off with an exhaust plume and screen-lift.
 */
function PadScene({ launching }: { launching: boolean }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const launchRef = useRef(false)
  const launchStart = useRef(0)
  launchRef.current = launching

  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    let raf = 0
    let beacon = 0
    const stars = Array.from({ length: 20 }, () => ({
      x: Math.random() * 132,
      y: Math.random() * 48,
      p: Math.random() * 6
    }))
    const px = (x: number, y: number, w: number, h: number, c: string): void => {
      ctx.fillStyle = c
      ctx.fillRect(x | 0, y | 0, w, h)
    }
    const draw = (now: number): void => {
      const g = ctx.createLinearGradient(0, 0, 0, 48)
      g.addColorStop(0, '#05070f')
      g.addColorStop(1, '#0a1024')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 132, 48)

      // planet arc at the bottom
      ctx.fillStyle = '#0c1a38'
      ctx.beginPath()
      ctx.arc(66, 60, 40, Math.PI, 2 * Math.PI)
      ctx.fill()

      const speed = launchRef.current ? 3 : 1
      for (const s of stars) {
        s.p += 0.05
        s.y += 0.03 * speed
        if (s.y > 48) s.y = 0
        ctx.globalAlpha = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(s.p))
        px(s.x, s.y, 1, 1, '#f0ecd8')
      }
      ctx.globalAlpha = 1

      // liftoff offset
      let lift = 0
      if (launchRef.current) {
        if (!launchStart.current) launchStart.current = now
        const t = (now - launchStart.current) / 1000
        lift = Math.min(60, t * t * 90)
      } else {
        launchStart.current = 0
      }
      const ry = 20 - lift

      // gantry (stays)
      px(48, 22, 2, 22, '#5c6180')
      px(82, 22, 2, 22, '#5c6180')
      px(52, 42, 28, 2, '#0c1a38')

      // rocket (pixel Vostok)
      px(62, ry, 8, 18, '#e8e2d2')
      px(62, ry + 4, 8, 3, '#e2231a')
      px(64, ry - 4, 4, 4, '#e2231a')
      px(64, ry + 10, 4, 3, '#4fd6d6')
      px(59, ry + 14, 3, 6, '#e2231a')
      px(70, ry + 14, 3, 6, '#e2231a')

      // exhaust flame during liftoff
      if (launchRef.current) {
        const fl = ry + 20
        px(63, fl, 6, 4 + ((now / 80) % 3 | 0) * 2, '#fff2c0')
        px(64, fl + 4, 4, 5, '#f0662e')
        px(65, fl + 8, 2, 4, '#e2231a')
      }

      beacon = (beacon + 1) % 90
      if (beacon < 45) px(118, 8, 2, 2, '#e2231a')
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} width={132} height={48} className="zy-lp-canvas" />
}

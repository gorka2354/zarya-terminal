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
    // Settings apply instantly; keep the console open through the full
    // countdown (3·2·1·ПОЕХАЛИ) + liftoff drawn on the canvas, then close.
    window.setTimeout(close, 3000)
  }

  const effortIdx = EFFORTS.indexOf(effort)
  const rocketType = Math.max(0, models.indexOf(model))

  return (
    <div className="zy-lp-backdrop" onMouseDown={close}>
      <div className="zy-launchpad" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-lp-console">
          <PadScene launching={launching} rocketType={rocketType} effortIdx={effortIdx} />
          <span className="zy-lp-console-title">ПУСКОВОЙ КОМПЛЕКС</span>
          <span ref={clockRef} className="zy-lp-clock" />
          <span className="zy-lp-scan" />
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

/**
 * Pixel launch-pad scene (a faithful port of the design's `_drawScene`): a
 * vertical-gradient sky over a planet arc, drifting twinkling stars, a gantry
 * with a blinking beacon, and one of five model-specific pixel rockets whose
 * exhaust flame scales with ТЯГА. Hitting ПУСК plays a canvas countdown
 * (3·2·1·ПОЕХАЛИ!) then the rocket accelerates off-frame, leaving a star-streak
 * trail, and glides back to the pad. Internal buffer 132×48, CSS-upscaled with
 * image-rendering:pixelated for crisp pixel art.
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
    const C = '#4fd6d6'

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

      // rocket sprite (5 model variants) + thrust-scaled flame
      if (R.y > -16) {
        const type = typeRef.current % 5
        const thr = R.thr
        let cx = Math.round(W * 0.42)
        const top = Math.round(R.y)
        if (thr > 0.2 && !R.launching) cx += Math.round((Math.random() - 0.5) * thr * 3)
        if (thr > 0.08) {
          const L = Math.round(thr * 18) + (Math.random() < 0.5 ? 1 : 0)
          px(cx - 1, top + 12, 2, L, '#fff2c0')
          px(cx - 2, top + 12, 4, Math.max(1, L - 3), G)
          px(cx - 1, top + 13, 2, L + 2, A)
          if (thr > 0.62) {
            const s = Math.max(2, Math.round(L * 0.5))
            px(cx - 4, top + 13, 1, s, G)
            px(cx + 3, top + 13, 1, s, G)
          }
        }
        if (type === 1) {
          px(cx - 2, top - 2, 4, 16, '#e8e2d2')
          px(cx - 2, top + 2, 4, 1, A)
          px(cx - 1, top - 4, 2, 2, G)
          px(cx - 3, top + 9, 2, 4, A)
          px(cx + 3, top + 9, 2, 4, A)
          px(cx - 1, top + 4, 2, 2, G)
        } else if (type === 2) {
          px(cx - 2, top + 3, 4, 9, '#e8e2d2')
          px(cx - 1, top + 1, 2, 2, C)
          px(cx - 3, top + 8, 2, 4, C)
          px(cx + 3, top + 8, 2, 4, C)
          px(cx - 1, top + 6, 2, 2, C)
        } else if (type === 3) {
          px(cx - 4, top + 4, 2, 9, '#c9c3b2')
          px(cx + 2, top + 4, 2, 9, '#c9c3b2')
          px(cx - 2, top, 4, 12, '#e8e2d2')
          px(cx - 2, top + 3, 4, 1, A)
          px(cx - 1, top - 2, 2, 2, A)
          px(cx - 1, top + 5, 2, 2, C)
        } else if (type === 4) {
          px(cx - 3, top + 2, 6, 8, '#c9c3b2')
          px(cx - 3, top + 2, 6, 1, A)
          px(cx - 4, top + 10, 2, 3, A)
          px(cx + 3, top + 10, 2, 3, A)
          px(cx - 1, top + 4, 2, 2, C)
          px(cx - 1, top, 2, 2, A)
        } else {
          px(cx - 2, top, 4, 12, '#e8e2d2')
          px(cx - 2, top + 3, 4, 1, A)
          px(cx - 3, top + 7, 2, 4, A)
          px(cx + 3, top + 7, 2, 4, A)
          px(cx - 1, top - 2, 2, 2, A)
          px(cx - 2, top - 1, 4, 1, A)
          px(cx - 1, top + 5, 2, 2, C)
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

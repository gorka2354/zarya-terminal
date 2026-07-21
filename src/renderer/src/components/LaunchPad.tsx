import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiEffort } from '@shared/types'
import { AI_MODEL_PRESETS, EFFORT_TUNING } from '@shared/defaults'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { launchRocket } from './RocketLaunch'
import './launchpad.css'

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'max']

/**
 * "Пусковой комплекс" (Launch Complex) — the model + reasoning-thrust selector,
 * themed as a rocket launch console. Picking a двигатель (model) and ТЯГА
 * (effort) then hitting ПУСК applies both to settings and fires the launch.
 */
export function LaunchPad(): React.JSX.Element | null {
  const open = useUiStore((s) => s.launchPadOpen)
  const ai = useSettingsStore((s) => s.settings.ai)
  const clockRef = useRef<HTMLSpanElement>(null)

  // Draft selections (committed on ПУСК).
  const [model, setModel] = useState(ai.model)
  const [effort, setEffort] = useState<AiEffort>(ai.effort)

  useEffect(() => {
    if (open) {
      setModel(ai.model)
      setEffort(ai.effort)
    }
  }, [open, ai.model, ai.effort])

  // Live mission clock in the console header.
  useEffect(() => {
    if (!open) return
    const tick = (): void => {
      if (clockRef.current) {
        clockRef.current.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false })
      }
    }
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [open])

  const models = useMemo(() => {
    const preset = AI_MODEL_PRESETS[ai.provider] ?? []
    const list = [...preset]
    if (ai.model && !list.includes(ai.model)) list.unshift(ai.model)
    if (model && !list.includes(model)) list.unshift(model)
    return list.length ? list : [model || 'модель не задана']
  }, [ai.provider, ai.model, model])

  if (!open) return null

  const close = (): void => useUiStore.getState().set({ launchPadOpen: false })

  const launch = (): void => {
    void useSettingsStore.getState().update({ ai: { model, effort } as never })
    launchRocket({ label: `${model} · тяга ${EFFORT_TUNING[effort].label.toLowerCase()}` })
    close()
  }

  const effortIdx = EFFORTS.indexOf(effort)

  return (
    <div className="zy-lp-backdrop" onMouseDown={close}>
      <div className="zy-launchpad" onMouseDown={(e) => e.stopPropagation()}>
        <div className="zy-lp-console">
          <PadScene />
          <span className="zy-lp-console-title">ПУСКОВОЙ КОМПЛЕКС</span>
          <span ref={clockRef} className="zy-lp-clock" />
          <span className="zy-lp-scan" />
        </div>

        <div className="zy-lp-body">
          <div className="zy-lp-label">Двигатель · модель</div>
          <div className="zy-lp-models">
            {models.map((m) => (
              <button
                key={m}
                className={`zy-lp-model${m === model ? ' zy-lp-model--on' : ''}`}
                onClick={() => setModel(m)}
              >
                <span className={`zy-lp-bullet${m === model ? ' zy-lp-bullet--on' : ''}`} />
                <span className="zy-lp-model-name">{m}</span>
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
            <span className="zy-lp-thrust-label">{EFFORT_TUNING[effort].label}</span>
          </div>

          <button className="zy-lp-launch" onClick={launch}>
            ПУСК · ПОЕХАЛИ
          </button>
          <div className="zy-lp-hint">двигатель и тяга применятся к агенту</div>
        </div>
      </div>
    </div>
  )
}

/** Small pixel launch-pad scene: a rocket on a gantry under a drifting star. */
function PadScene(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    let raf = 0
    const stars = Array.from({ length: 16 }, () => ({
      x: Math.random() * 132,
      y: Math.random() * 48,
      p: Math.random() * 6
    }))
    let beacon = 0
    const px = (x: number, y: number, w: number, h: number, c: string): void => {
      ctx.fillStyle = c
      ctx.fillRect(x | 0, y | 0, w, h)
    }
    const draw = (): void => {
      const g = ctx.createLinearGradient(0, 0, 0, 48)
      g.addColorStop(0, '#05070f')
      g.addColorStop(1, '#0a1024')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 132, 48)
      for (const s of stars) {
        s.p += 0.05
        s.y += 0.03
        if (s.y > 48) s.y = 0
        ctx.globalAlpha = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(s.p))
        px(s.x, s.y, 1, 1, '#f0ecd8')
      }
      ctx.globalAlpha = 1
      // pad + rocket (pixel)
      px(52, 42, 28, 3, '#0c1a38')
      px(62, 20, 8, 18, '#e8e2d2')
      px(62, 24, 8, 3, '#e2231a')
      px(64, 16, 4, 4, '#e2231a')
      px(64, 30, 4, 4, '#4fd6d6')
      px(59, 34, 3, 6, '#e2231a')
      px(70, 34, 3, 6, '#e2231a')
      // gantry
      px(48, 22, 2, 22, '#5c6180')
      px(82, 22, 2, 22, '#5c6180')
      // beacon
      beacon = (beacon + 1) % 90
      if (beacon < 45) px(118, 8, 2, 2, '#e2231a')
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} width={132} height={48} className="zy-lp-canvas" />
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Cinematic "Поехали!" rocket-launch overlay. Fired on model/provider changes
 * (and reusable anywhere via launchRocket). Full-screen, pointer-events:none,
 * self-dismissing (~1.9s). A canvas paints the parallax starfield + exhaust
 * particles; the rocket, countdown and title are DOM/CSS for crisp type.
 */

interface LaunchOpts {
  label?: string
}

type Listener = (opts: LaunchOpts) => void
const listeners = new Set<Listener>()

/** Trigger the launch sequence from anywhere. Coalesced by the overlay. */
export function launchRocket(opts: LaunchOpts = {}): void {
  listeners.forEach((l) => l(opts))
}

// Test/QA hook: lets the offscreen capture harness (scripts/shoot.mjs) fire the
// launch overlay without driving native clicks. Harmless in production.
;(window as unknown as { __zaryaLaunchRocket?: typeof launchRocket }).__zaryaLaunchRocket =
  launchRocket

const DURATION = 1900
const COUNTDOWN = ['3', '2', '1']

interface Star {
  x: number
  y: number
  z: number // depth 0.2..1 -> speed + size
  len: number
}

interface Ember {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  hue: number
  size: number
}

export function RocketLaunch(): React.JSX.Element | null {
  const [active, setActive] = useState(false)
  const [label, setLabel] = useState<string | undefined>()
  const [phase, setPhase] = useState<'countdown' | 'liftoff'>('countdown')
  const [count, setCount] = useState('3')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const runIdRef = useRef(0)

  useEffect(() => {
    const listener: Listener = (opts) => {
      runIdRef.current++
      setLabel(opts.label)
      setPhase('countdown')
      setCount('3')
      setActive(true)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const myRun = runIdRef.current

    // Countdown ticks, then liftoff.
    const t0 = window.setTimeout(() => setCount('2'), 300)
    const t1 = window.setTimeout(() => setCount('1'), 600)
    const t2 = window.setTimeout(() => setPhase('liftoff'), 900)

    // Screen shake on liftoff.
    const shakeAt = window.setTimeout(() => {
      document.getElementById('root')?.classList.add('zy-shake')
    }, 900)
    const shakeOff = window.setTimeout(() => {
      document.getElementById('root')?.classList.remove('zy-shake')
    }, 1500)

    const done = window.setTimeout(() => {
      if (runIdRef.current === myRun) setActive(false)
    }, DURATION)

    // --- canvas starfield + exhaust ---
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    let stars: Star[] = []
    const embers: Ember[] = []
    let start = performance.now()

    const resize = (): void => {
      if (!canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      stars = Array.from({ length: 150 }, () => {
        const z = 0.2 + Math.random() * 0.8
        return {
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
          z,
          len: 0
        }
      })
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (now: number): void => {
      if (!ctx || !canvas || runIdRef.current !== myRun) return
      const t = now - start
      const w = window.innerWidth
      const h = window.innerHeight
      ctx.clearRect(0, 0, w, h)

      // Radial launch glow at the pad (bottom center), grows after liftoff.
      const lift = Math.max(0, (t - 900) / 1000)
      const padX = w / 2
      const padY = h * 0.9
      const glow = ctx.createRadialGradient(padX, padY, 0, padX, padY, 260 + lift * 120)
      glow.addColorStop(0, `rgba(255,150,60,${0.28 * Math.min(1, t / 400)})`)
      glow.addColorStop(0.5, 'rgba(226,35,26,0.10)')
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, w, h)

      // Parallax star streaks (accelerate on liftoff — the ship "rises").
      const speed = 40 + lift * 900
      ctx.lineCap = 'round'
      for (const s of stars) {
        s.len = 1 + s.z * s.z * speed * 0.02
        s.y += s.z * speed * 0.016
        if (s.y > h + 20) {
          s.y = -20
          s.x = Math.random() * w
        }
        ctx.strokeStyle = `rgba(240,236,220,${0.25 + s.z * 0.6})`
        ctx.lineWidth = s.z * 1.6
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(s.x, s.y + s.len)
        ctx.stroke()
      }

      // Exhaust embers, spawned during liftoff from the rocket nozzle.
      if (t > 900 && t < 1700) {
        const rocketY = padY - lift * (h * 0.95)
        for (let i = 0; i < 6; i++) {
          embers.push({
            x: padX + (Math.random() - 0.5) * 16,
            y: rocketY + 26,
            vx: (Math.random() - 0.5) * 1.4,
            vy: 1.5 + Math.random() * 2.6,
            life: 0,
            max: 420 + Math.random() * 380,
            hue: 20 + Math.random() * 35,
            size: 2 + Math.random() * 3.5
          })
        }
      }
      const dt = 16
      for (const e of embers) {
        e.life += dt
        e.x += e.vx
        e.y += e.vy
        e.vy += 0.05
        const k = 1 - e.life / e.max
        if (k <= 0) continue
        ctx.fillStyle = `hsla(${e.hue}, 100%, ${55 + k * 20}%, ${k * 0.9})`
        ctx.beginPath()
        ctx.arc(e.x, e.y, e.size * k, 0, Math.PI * 2)
        ctx.fill()
      }
      // Trim dead embers.
      for (let i = embers.length - 1; i >= 0; i--) {
        if (embers[i].life >= embers[i].max) embers.splice(i, 1)
      }

      rafRef.current = requestAnimationFrame(draw)
    }
    start = performance.now()
    rafRef.current = requestAnimationFrame(draw)

    return () => {
      window.clearTimeout(t0)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(shakeAt)
      window.clearTimeout(shakeOff)
      window.clearTimeout(done)
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      document.getElementById('root')?.classList.remove('zy-shake')
    }
  }, [active])

  if (!active) return null

  return createPortal(
    <div className="zy-rocket-overlay" aria-hidden>
      <canvas ref={canvasRef} className="zy-rocket-canvas" />
      <div className={`zy-rocket-stage zy-rocket-stage--${phase}`}>
        <RocketMark />
        <div className="zy-rocket-flame" />
      </div>
      {phase === 'countdown' ? (
        <div key={count} className="zy-rocket-count">
          {count}
        </div>
      ) : (
        <div className="zy-rocket-title">
          ПОЕХАЛИ!
          {label && <span className="zy-rocket-sub">{label}</span>}
        </div>
      )}
    </div>,
    document.body
  )
}

function RocketMark(): React.JSX.Element {
  // Vostok-ish silhouette in the brand red/gold.
  return (
    <svg width="64" height="120" viewBox="0 0 64 120" fill="none" aria-hidden>
      <defs>
        <linearGradient id="zy-rk-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F2E9D6" />
          <stop offset="1" stopColor="#C9BFA6" />
        </linearGradient>
      </defs>
      <path d="M32 4c11 12 15 26 15 40v34H17V44C17 30 21 16 32 4z" fill="url(#zy-rk-body)" stroke="#0A0E1A" strokeWidth="1.5" />
      <path d="M17 62L6 84l11-6zM47 62l11 22-11-6z" fill="#E2231A" stroke="#0A0E1A" strokeWidth="1.5" />
      <circle cx="32" cy="40" r="7" fill="#0A0E1A" stroke="#E0B15A" strokeWidth="2" />
      <circle cx="32" cy="40" r="2.6" fill="#4FD6D6" />
      <path d="M22 84h20l-3 10H25z" fill="#E2231A" stroke="#0A0E1A" strokeWidth="1.5" />
      <rect x="27" y="52" width="10" height="3" fill="#E2231A" />
    </svg>
  )
}

import { useEffect, useRef } from 'react'

/**
 * Cosmic backdrop: a pixelated starfield that slowly drifts and twinkles, with
 * the occasional shooting star. Sits behind the whole app (pointer-events:none)
 * and adapts to light themes (dark stars on cream). Cheap: ~110 stars, capped
 * DPR, pauses under prefers-reduced-motion.
 */
interface Star {
  x: number
  y: number
  vy: number
  p: number
  a: number
  sz: number
  gold: boolean
}
interface Shoot {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

export function StarBackdrop(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let stars: Star[] = []
    let shoots: Shoot[] = []
    let W = 0
    let H = 0
    let raf = 0
    let last = performance.now()
    let shootTimer = 2600 + Math.random() * 3200

    const resize = (): void => {
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width = W
      canvas.height = H
      const count = Math.round((W * H) / 14000)
      stars = Array.from({ length: Math.min(180, Math.max(50, count)) }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        vy: 0.004 + Math.random() * 0.012,
        p: Math.random() * 6.28,
        a: 0.5 + Math.random() * 0.5,
        sz: Math.random() < 0.16 ? 2 : 1,
        gold: Math.random() < 0.22
      }))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const isLight = (): boolean => document.documentElement.dataset.themeType === 'light'

    const frame = (now: number): void => {
      const dt = Math.min(48, now - last)
      last = now
      ctx.clearRect(0, 0, W, H)
      const light = isLight()
      const base = light ? '40,32,24' : '240,236,216'
      const gold = light ? '150,106,30' : '224,177,90'

      for (const s of stars) {
        if (!reduce) {
          s.y += s.vy * dt
          if (s.y > H + 2) {
            s.y = -2
            s.x = Math.random() * W
          }
          s.p += dt * 0.003
        }
        const tw = 0.22 + 0.6 * (0.5 + 0.5 * Math.sin(s.p))
        ctx.globalAlpha = Math.min(1, tw * s.a) * (light ? 0.5 : 0.9)
        ctx.fillStyle = 'rgb(' + (s.gold ? gold : base) + ')'
        ctx.fillRect(s.x | 0, s.y | 0, s.sz, s.sz)
      }
      ctx.globalAlpha = 1

      if (!reduce) {
        shootTimer -= dt
        if (shootTimer <= 0) {
          shootTimer = 4200 + Math.random() * 5000
          shoots.push({
            x: W * (0.5 + Math.random() * 0.5),
            y: Math.random() * H * 0.4,
            vx: -(0.18 + Math.random() * 0.12),
            vy: 0.12 + Math.random() * 0.08,
            life: 0
          })
        }
        for (let i = shoots.length - 1; i >= 0; i--) {
          const sh = shoots[i]
          sh.x += sh.vx * dt
          sh.y += sh.vy * dt
          sh.life += dt
          const a = Math.max(0, 1 - sh.life / 950)
          if (a <= 0 || sh.x < -20 || sh.y > H + 20) {
            shoots.splice(i, 1)
            continue
          }
          ctx.globalAlpha = a * 0.85
          ctx.strokeStyle = 'rgba(' + (light ? '32,26,18' : '255,245,232') + ',' + a.toFixed(2) + ')'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(sh.x, sh.y)
          ctx.lineTo(sh.x - sh.vx * 46, sh.y - sh.vy * 46)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="zy-star-backdrop" aria-hidden />
}

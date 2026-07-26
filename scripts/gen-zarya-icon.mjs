#!/usr/bin/env node
/**
 * Renders the Zarya dawn-sun icon NATIVELY at every size Windows asks for, then
 * assembles build/icon.ico from those native renders.
 *
 * Why this exists: art/zarya-icon.lua draws the sun natively per size (crisp at
 * any N), but it needs Aseprite. The .ico that shipped was assembled elsewhere
 * and held only 4 entries (16/32/48/256) whose 48px was a DOWNSCALE of 256 —
 * blurry exactly where the desktop uses it. Anything Windows asks for that is
 * missing (96px "large icons", 60/72px at 125/150% DPI) got resampled too.
 *
 * This is a straight port of art/zarya-icon.lua — same circle, gradient, slits
 * and corner rounding — so the art is unchanged; only the pipeline is. Verified
 * against the committed native PNGs (see --verify).
 *
 * Usage:
 *   node scripts/gen-zarya-icon.mjs            # render + assemble the .ico
 *   node scripts/gen-zarya-icon.mjs --verify   # only check the port matches
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ICONS_DIR = path.join(repoRoot, 'build', 'icons')
const BUILD_DIR = path.join(repoRoot, 'build')
const RES_DIR = path.join(repoRoot, 'resources')

/**
 * Sizes embedded in the .ico. This is what the Windows shell actually requests:
 * 16 (list view) · 20/24 (small) · 32 (taskbar, alt-tab) · 40 (125% of 32)
 * 48 (desktop, medium icons) · 64 · 96 (large icons) · 128 · 256 (extra large,
 * and Explorer's preview). A missing size is not "close enough" — the shell
 * resamples the nearest one, which is what made the desktop icon mushy.
 */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
/** Extra PNGs kept on disk for Linux/macOS packaging. */
const PNG_SIZES = [...new Set([...ICO_SIZES, 512])].sort((a, b) => a - b)

// --------------------------------------------------------------- the artwork

/** Gradient stops: deep orange at the top → pale yellow at the bottom. */
const STOPS = [
  [0.0, 232, 84, 26],
  [0.26, 255, 118, 40],
  [0.48, 255, 172, 44],
  [0.68, 255, 214, 54],
  [0.84, 255, 240, 92],
  [1.0, 255, 248, 184]
]

function grad(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i]
    const b = STOPS[i + 1]
    if (c >= a[0] && c <= b[0]) {
      const f = (c - a[0]) / (b[0] - a[0])
      return [
        Math.floor(a[1] + (b[1] - a[1]) * f),
        Math.floor(a[2] + (b[2] - a[2]) * f),
        Math.floor(a[3] + (b[3] - a[3]) * f)
      ]
    }
  }
  return STOPS[STOPS.length - 1].slice(1)
}

/**
 * One icon as a raw RGBA buffer. Every coordinate is computed at the target size
 * — nothing is drawn once and scaled, which is the whole point.
 */
function render(N, { transparent = false } = {}) {
  const px = Buffer.alloc(N * N * 4, 0)
  const set = (x, y, r, g, b, a) => {
    const o = (y * N + x) * 4
    px[o] = r
    px[o + 1] = g
    px[o + 2] = b
    px[o + 3] = a
  }

  if (!transparent) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) set(x, y, 10, 14, 26, 255)

  const cx = (N - 1) / 2
  const cy = N * 0.475
  const R = N * 0.375
  const top = cy - R
  const bot = cy + R

  // Horizontal slits across the lower half; thickness and count scale with N so
  // the sun reads the same at 16px and at 256px.
  const gapT = Math.max(1, Math.floor(N / 26 + 0.5))
  const fracs = N < 22 ? [0.66, 0.86] : N < 40 ? [0.6, 0.75, 0.88] : [0.58, 0.71, 0.82, 0.92]
  const gaps = new Set()
  for (const f of fracs) {
    const gy = Math.floor(top + f * (bot - top) + 0.5)
    for (let k = 0; k < gapT; k++) gaps.add(gy + k)
  }

  for (let y = 0; y < N; y++) {
    if (gaps.has(y)) continue
    for (let x = 0; x < N; x++) {
      const dx = (x - cx) / R
      const dy = (y - cy) / R
      if (dx * dx + dy * dy <= 1.0) {
        const [r, g, b] = grad((y - top) / (bot - top))
        set(x, y, r, g, b, 255)
      }
    }
  }

  if (!transparent) roundCorners(px, N, Math.max(2, Math.floor(N / 6 + 0.5)))
  return px
}

/** Punches the four corners transparent — the squircle silhouette. */
function roundCorners(px, N, r) {
  const clear = (x, y) => {
    px[(y * N + x) * 4 + 3] = 0
  }
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      const dx = r - 1 - x
      const dy = r - 1 - y
      if (dx * dx + dy * dy > r * r) {
        clear(x, y)
        clear(N - 1 - x, y)
        clear(x, N - 1 - y)
        clear(N - 1 - x, N - 1 - y)
      }
    }
  }
}

// ------------------------------------------------------------ png read/write

function encodePng(rgba, N) {
  const raw = Buffer.alloc((N * 4 + 1) * N)
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0 // filter: none — keeps the encoder trivial
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(N, 0)
  ihdr.writeUInt32BE(N, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Minimal decoder — only for --verify (8-bit RGBA, non-interlaced). */
function decodePng(buf) {
  let off = 8
  let width = 0
  let height = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('verify: expected 8-bit RGBA png')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0
      let v = line[i]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) v += paeth(a, b, c)
      out[y * stride + i] = v & 0xff
    }
  }
  return { width, height, rgba: out }
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

// ------------------------------------------------------------------- verify

/**
 * The committed PNGs were produced by the Aseprite script. If this port renders
 * them pixel-for-pixel, the artwork is provably unchanged and only the .ico
 * assembly differs.
 */
async function verify() {
  let ok = true
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const file = path.join(ICONS_DIR, `${size}x${size}.png`)
    let ref
    try {
      ref = decodePng(await readFile(file))
    } catch {
      console.log(`  ? ${size}px — эталона нет, пропуск`)
      continue
    }
    const mine = render(size)
    let diff = 0
    for (let i = 0; i < mine.length; i += 4) {
      // Compare visible pixels only: fully transparent ones may differ in RGB.
      if (ref.rgba[i + 3] !== mine[i + 3]) diff++
      else if (mine[i + 3] !== 0 && (ref.rgba[i] !== mine[i] || ref.rgba[i + 1] !== mine[i + 1] || ref.rgba[i + 2] !== mine[i + 2]))
        diff++
    }
    const total = size * size
    if (diff === 0) console.log(`  ✓ ${size}px — совпадает с эталоном пиксель в пиксель`)
    else {
      ok = false
      console.log(`  ✗ ${size}px — расходится в ${diff} из ${total} пикселей (${((diff / total) * 100).toFixed(2)}%)`)
    }
  }
  return ok
}

// --------------------------------------------------------------------- main

async function main() {
  const verifyOnly = process.argv.includes('--verify')

  console.log('[zarya-icon] сверка порта с закоммиченными PNG:')
  const matches = await verify()
  if (verifyOnly) {
    process.exitCode = matches ? 0 : 1
    return
  }
  if (!matches) {
    throw new Error('порт разошёлся с эталоном — рисунок изменился бы, останавливаюсь')
  }

  await mkdir(ICONS_DIR, { recursive: true })
  const pngBySize = new Map()
  for (const size of PNG_SIZES) {
    const buf = encodePng(render(size), size)
    pngBySize.set(size, buf)
    await writeFile(path.join(ICONS_DIR, `${size}x${size}.png`), buf)
  }
  console.log(`[zarya-icon] нативных PNG: ${PNG_SIZES.join(', ')}`)

  await writeFile(path.join(BUILD_DIR, 'icon.png'), pngBySize.get(512))

  const ico = await pngToIco(ICO_SIZES.map((s) => pngBySize.get(s)))
  await writeFile(path.join(BUILD_DIR, 'icon.ico'), ico)
  await writeFile(path.join(RES_DIR, 'zarya-icon.ico'), ico)

  const entries = ico.readUInt16LE(4)
  console.log(`[zarya-icon] icon.ico: ${entries} записей (${ico.length} байт) → build/ + resources/`)
  if (entries !== ICO_SIZES.length)
    throw new Error(`ожидалось ${ICO_SIZES.length} записей в .ico, получено ${entries}`)

  // Transparent UI logos come from the same renderer, so they can't drift.
  const assets = path.join(repoRoot, 'src', 'renderer', 'src', 'assets')
  for (const size of [48, 64]) {
    await writeFile(path.join(assets, `logo-zarya-${size}.png`), encodePng(render(size, { transparent: true }), size))
  }
  console.log('[zarya-icon] logo-zarya-48/64.png (прозрачные) обновлены')
  console.log('[zarya-icon] готово.')
}

main().catch((err) => {
  console.error('[zarya-icon] ОШИБКА:', err.message)
  process.exitCode = 1
})

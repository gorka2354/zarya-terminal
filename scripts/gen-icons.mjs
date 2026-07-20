#!/usr/bin/env node
// Renders resources/icon.svg into the full set of PNG sizes + a Windows .ico
// used by electron-builder (see electron-builder.yml -> buildResources: build).
//
// Usage: node scripts/gen-icons.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const SVG_PATH = path.join(repoRoot, 'resources', 'icon.svg')
const ICONS_DIR = path.join(repoRoot, 'build', 'icons')
const BUILD_DIR = path.join(repoRoot, 'build')

// Every PNG size we generate for build/icons/{size}x{size}.png.
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
// Subset embedded into the multi-resolution Windows .ico.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * Renders the source SVG to a PNG buffer at the given square size.
 */
function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)'
  })
  return resvg.render().asPng()
}

async function main() {
  console.log('[gen-icons] reading source SVG:', path.relative(repoRoot, SVG_PATH))
  if (!existsSync(SVG_PATH)) {
    throw new Error(`Source SVG not found at ${SVG_PATH}`)
  }
  const svg = await readFile(SVG_PATH, 'utf8')

  await mkdir(ICONS_DIR, { recursive: true })

  /** @type {Map<number, Buffer>} */
  const pngBySize = new Map()

  for (const size of PNG_SIZES) {
    process.stdout.write(`[gen-icons] rendering ${size}x${size}.png ... `)
    const buf = renderPng(svg, size)
    pngBySize.set(size, buf)
    const outPath = path.join(ICONS_DIR, `${size}x${size}.png`)
    await writeFile(outPath, buf)
    console.log(`ok (${buf.length} bytes)`)
  }

  // build/icon.png = the 512px master, used as the generic app icon on
  // platforms that don't need a dedicated .ico/.icns.
  const master = pngBySize.get(512)
  const masterPath = path.join(BUILD_DIR, 'icon.png')
  await writeFile(masterPath, master)
  console.log(`[gen-icons] wrote ${path.relative(repoRoot, masterPath)} (${master.length} bytes)`)

  // Assemble the Windows multi-resolution .ico from the PNG buffers we
  // already rendered (avoids re-rendering / re-reading from disk).
  console.log(`[gen-icons] building icon.ico from sizes: ${ICO_SIZES.join(', ')}`)
  const icoBuffers = ICO_SIZES.map((size) => pngBySize.get(size))
  const icoBuffer = await pngToIco(icoBuffers)
  const icoPath = path.join(BUILD_DIR, 'icon.ico')
  await writeFile(icoPath, icoBuffer)
  console.log(`[gen-icons] wrote ${path.relative(repoRoot, icoPath)} (${icoBuffer.length} bytes)`)

  console.log('[gen-icons] done.')
}

main().catch((err) => {
  console.error('[gen-icons] FAILED:', err)
  process.exitCode = 1
})

/**
 * Дописать тишину в конец WAV.
 *
 *   node scripts/lib/wav-pad.mjs вход.wav выход.wav 4
 *   node scripts/lib/wav-pad.mjs а.wav,б.wav выход.wav 6   # склейка с паузой
 *
 * Несколько входов склеиваются через паузу WAV_GAP секунд (по умолчанию 2): так
 * получается запись из НЕСКОЛЬКИХ фраз — единственный способ проверить, что в
 * потоковом режиме текст приходит по ходу речи, а не одним куском в конце.
 *
 * Нужно для прогонов с подменённым микрофоном: Chromium ЗАЦИКЛИВАЕТ файл, и без
 * паузы в конце получается человек, который говорит без остановки. Автостоп по
 * тишине в таких условиях не сработает никогда — и прогон обвинит продукт в
 * том, чего сам ему не дал.
 *
 * Синтезатор Windows хвост `<break>` обрезает, поэтому тишину дописываем сами.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [srcArg, dst, secStr] = process.argv.slice(2)
const seconds = Number(secStr || 4)
const sources = srcArg.split(',').filter(Boolean)
const b = readFileSync(sources[0])

if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('это не WAV')
  process.exit(1)
}

// Ищем чанки честно: между `fmt ` и `data` встречаются и другие (LIST, fact).
let pos = 12
let fmt = null
let data = null
while (pos + 8 <= b.length) {
  const id = b.toString('ascii', pos, pos + 4)
  const size = b.readUInt32LE(pos + 4)
  if (id === 'fmt ') fmt = { pos, size }
  if (id === 'data') {
    data = { pos, size: Math.min(size, b.length - pos - 8) }
    break
  }
  pos += 8 + size + (size % 2)
}
if (!fmt || !data) {
  console.error('не нашёл fmt/data')
  process.exit(1)
}

const channels = b.readUInt16LE(fmt.pos + 10)
const rate = b.readUInt32LE(fmt.pos + 12)
const bits = b.readUInt16LE(fmt.pos + 22)
const bytesPerSec = (rate * channels * bits) / 8
/*
 * Хвост: тишина или ФОНОВЫЙ ШУМ.
 *
 * Шум важнее тишины. Настоящая комната не молчит — кулер, кондиционер,
 * улица, — и автостоп по фиксированному порогу в такой комнате не срабатывает
 * НИКОГДА: фон стоит выше порога, «тишины» с точки зрения программы не
 * наступает, и человек ждёт с включённым микрофоном, пока не нажмёт второй раз.
 * Идеально чистые нули этот случай прячут.
 */
const noise = Number(process.env.WAV_NOISE || 0)
const pad = Buffer.alloc(Math.round(bytesPerSec * seconds))
if (noise > 0) {
  // Свой генератор, а не Math.random: прогон обязан быть повторяемым.
  let seed = 12345
  for (let i = 0; i + 1 < pad.length; i += 2) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = ((seed / 0x7fffffff) * 2 - 1) * noise * 32767
    pad.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i)
  }
}

const head = b.subarray(0, data.pos + 8)
let body = b.subarray(data.pos + 8, data.pos + 8 + data.size)

// Остальные входы — их звук, разделённый паузой. Заголовки берём от первого:
// прогоны генерируют файлы одним и тем же синтезатором, формат совпадает.
const gap = Buffer.alloc(Math.round(bytesPerSec * Number(process.env.WAV_GAP || 2)))
for (const extra of sources.slice(1)) {
  const e = readFileSync(extra)
  let p2 = 12
  let d2 = null
  while (p2 + 8 <= e.length) {
    const id = e.toString('ascii', p2, p2 + 4)
    const size = e.readUInt32LE(p2 + 4)
    if (id === 'data') {
      d2 = { pos: p2, size: Math.min(size, e.length - p2 - 8) }
      break
    }
    p2 += 8 + size + (size % 2)
  }
  if (!d2) continue
  body = Buffer.concat([body, gap, e.subarray(d2.pos + 8, d2.pos + 8 + d2.size)])
}

const out = Buffer.concat([head, body, pad])
out.writeUInt32LE(out.length - 8, 4) // RIFF
out.writeUInt32LE(body.length + pad.length, data.pos + 4) // data
writeFileSync(dst, out)

const было = body.length / bytesPerSec
console.log(
  `${rate} Гц · ${bits} бит · ${channels} кан. | было ${было.toFixed(1)} с → стало ${(было + seconds).toFixed(1)} с` +
    (noise > 0 ? ` | хвост — ФОН ${noise}` : ' | хвост — тишина')
)

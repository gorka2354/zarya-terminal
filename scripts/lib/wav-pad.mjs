/**
 * Дописать тишину в конец WAV.
 *
 *   node scripts/lib/wav-pad.mjs вход.wav выход.wav 4
 *
 * Нужно для прогонов с подменённым микрофоном: Chromium ЗАЦИКЛИВАЕТ файл, и без
 * паузы в конце получается человек, который говорит без остановки. Автостоп по
 * тишине в таких условиях не сработает никогда — и прогон обвинит продукт в
 * том, чего сам ему не дал.
 *
 * Синтезатор Windows хвост `<break>` обрезает, поэтому тишину дописываем сами.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [src, dst, secStr] = process.argv.slice(2)
const seconds = Number(secStr || 4)
const b = readFileSync(src)

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
const body = b.subarray(data.pos + 8, data.pos + 8 + data.size)
const out = Buffer.concat([head, body, pad])
out.writeUInt32LE(out.length - 8, 4) // RIFF
out.writeUInt32LE(body.length + pad.length, data.pos + 4) // data
writeFileSync(dst, out)

const было = data.size / bytesPerSec
console.log(
  `${rate} Гц · ${bits} бит · ${channels} кан. | было ${было.toFixed(1)} с → стало ${(было + seconds).toFixed(1)} с` +
    (noise > 0 ? ` | хвост — ФОН ${noise}` : ' | хвост — тишина')
)

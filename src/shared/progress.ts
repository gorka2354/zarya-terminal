/**
 * Строка скачивания в выводе команды.
 *
 * Загрузчики (`git clone`, `pip`, `wget`, `docker pull`, `curl`) пишут прогресс
 * одной перерисовываемой строкой. В терминале это читается, а в ленте
 * превращается в мельтешение: цифры прыгают, и понять «сколько осталось» можно
 * только вглядываясь.
 *
 * Здесь эта строка разбирается на части, чтобы показать её спокойно — полосой и
 * числом. Разбор нарочно придирчив: полоса, появившаяся не вовремя или на
 * случайных «100%» в тексте, — это интерфейс, который врёт о происходящем, а
 * молчание в такой ситуации честнее.
 */

export interface ProgressLine {
  /** 0..100, если процент назван явно. */
  percent: number | null
  /** Сколько уже — «12.4 MiB». */
  done?: string
  /** Сколько всего — «45.6 MB». */
  total?: string
  /** Скорость — «3.2 MiB/s». */
  speed?: string
  /** Сколько осталось — «0:00:12», «3s». */
  eta?: string
  /** Чем занят — «Receiving objects», «Downloading». */
  label?: string
}

/** Управляющие последовательности: до разбора их надо снять. */
// eslint-disable-next-line no-control-regex
const ANSI =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

const UNIT = '(?:[KMGT]i?)?B'
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s*%/
const SPEED = new RegExp(`(\\d+(?:[.,]\\d+)?\\s*${UNIT}/s)`, 'i')
/** «12.4 MiB | 3.2 MiB/s», «12.3/45.6 MB», «1.2 MB of 10 MB». */
const PAIR = new RegExp(
  `(\\d+(?:[.,]\\d+)?\\s*${UNIT}?)\\s*(?:/|of)\\s*(\\d+(?:[.,]\\d+)?\\s*${UNIT})`,
  'i'
)
const ETA = /\beta\s+([0-9:]+\w?|\d+[smh])/i
/** Полоса: «[====>   ]», «━━━━━━╺━━», «####----». */
const BAR = /\[[#=>.\-\s]{6,}\]|[━█▉▊▋▌▍▎▏]{4,}|[#]{4,}/
/** Чем занят загрузчик — по этим словам строку можно считать прогрессом. */
const LABEL =
  /\b(receiving objects|resolving deltas|counting objects|compressing objects|downloading|fetching|extracting|unpacking|installing|uploading|pulling|cloning)\b/i

/** Строка длиннее этого — уже не индикатор, а абзац текста. */
const MAX_LEN = 240

/**
 * Разобрать строку прогресса. `null` — если её тут нет.
 *
 * Берём ПОСЛЕДНЮЮ подходящую строку: загрузчик перерисовывает свою, и свежая
 * всегда ниже. Смотрим несколько строк, а не одну: некоторые печатают под
 * индикатором пустую строку или курсорный мусор.
 */
export function parseProgress(text: string, lookback = 6): ProgressLine | null {
  if (!text) return null
  const lines = text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - lookback; i--) {
    const hit = parseLine(lines[i])
    if (hit) return hit
  }
  return null
}

function parseLine(raw: string): ProgressLine | null {
  const line = raw.trim()
  if (!line || line.length > MAX_LEN) return null

  const pct = PERCENT.exec(line)
  const speed = SPEED.exec(line)
  const pair = PAIR.exec(line)
  const eta = ETA.exec(line)
  const bar = BAR.test(line)
  const label = LABEL.exec(line)

  // Одного процента мало: «100% coverage» в выводе тестов — не скачивание.
  // Нужен второй признак того, что это индикатор: скорость, объём, полоса или
  // прямое имя работы. Иначе молчим: полоса на пустом месте хуже её отсутствия.
  const corroborated = !!(speed || pair || bar || label)
  if (!corroborated) return null
  if (!pct && !pair) return null

  const percent = pct ? clampPercent(pct[1]) : null
  if (pct && percent === null) return null

  return {
    percent,
    done: pair ? tidy(pair[1]) : undefined,
    total: pair ? tidy(pair[2]) : undefined,
    speed: speed ? tidy(speed[1]) : undefined,
    eta: eta ? eta[1] : undefined,
    label: label ? capitalize(label[0]) : undefined
  }
}

function clampPercent(v: string): number | null {
  const n = Number(v.replace(',', '.'))
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n)
}

function tidy(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

function capitalize(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase()
}

/**
 * Короткая подпись рядом с полосой: «35% · 12.4 MiB/45.6 MiB · 3.2 MiB/s».
 * Пустые части опускаются — подпись должна читаться с одного взгляда.
 */
export function progressText(p: ProgressLine): string {
  const parts: string[] = []
  if (p.percent !== null) parts.push(`${p.percent}%`)
  if (p.done && p.total) parts.push(`${p.done}/${p.total}`)
  if (p.speed) parts.push(p.speed)
  if (p.eta) parts.push(`ETA ${p.eta}`)
  return parts.join(' · ')
}

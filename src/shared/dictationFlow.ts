/**
 * Как ведёт себя диктовка: три способа, три ожидания.
 *
 * Раньше способ был один — «нажал, сказал фразу, подождал, получил текст», — и
 * он подходил не всем. Владелец сформулировал ровно: «нажал и говоришь, он
 * сразу вводит, что слышит; нажал ещё раз — стоп». Это другой ритм работы, и
 * навязывать вместо него паузы значит навязывать чужую привычку.
 *
 *   'stream'  — НАЖАЛ И ГОВОРЮ. Текст дописывается по ходу речи: каждая
 *               законченная фраза уходит в строку, не дожидаясь конца записи.
 *               Останавливает только второе нажатие. Пауза, раздумье, глоток
 *               чая — запись продолжается.
 *   'phrase'  — ОДНА ФРАЗА. Сказал — замолчал — получил текст, микрофон закрыт.
 *               Для короткой команды это меньше движений: нажатие всего одно.
 *   'hold'    — ЗАЖАЛ И ГОВОРЮ (Ctrl+Shift+Space). Отпустил — конец. Тишина
 *               посреди фразы ничего не значит: человек думает, а не закончил.
 *
 * Здесь только РЕШЕНИЯ, без микрофона и без React: их видно целиком и можно
 * проверить тестами. Уровень входа приходит снаружи, время — тоже.
 */

export type DictationMode = 'stream' | 'phrase' | 'hold'

/**
 * Ниже этого — не речь ни при каком усилении.
 *
 * Пол против шума: дыхание, вентилятор, гул сети. Занизить — и запись начнёт
 * «слышать речь» в тишине.
 */
export const NOISE_FLOOR = 0.035

/**
 * Какую долю от самого громкого места считаем речью.
 *
 * Порог подстраивается под микрофон: у громкого поднимется, у тихого
 * опустится. Константа не годилась — тихий микрофон не переступал её ни разу за
 * запись, и «речь звучала» не выставлялось вовсе.
 */
export const SPEECH_RATIO = 0.5

/** Столько тишины — и фраза считается законченной. */
export const PHRASE_MS = 1500

/**
 * Столько тишины — и в потоковом режиме кусок уходит на распознавание.
 *
 * Короче, чем конец фразы: здесь пауза не заканчивает работу, а лишь отмечает
 * место, где можно резать, не разрубая слово. Слишком коротко — резали бы между
 * слогами; слишком длинно — текст появлялся бы редко и режим потерял бы смысл.
 */
export const CHUNK_MS = 700

/**
 * Дольше этого кусок не копим даже без пауз.
 *
 * Человек, говорящий без остановки, иначе не увидел бы ни слова до конца
 * записи — то есть получил бы ровно то поведение, от которого уходили.
 */
export const MAX_CHUNK_MS = 12_000

export interface FlowInput {
  /** Уровень входа 0..1 прямо сейчас. */
  level: number
  /** Сейчас, мс (снаружи: время — не дело чистой функции). */
  now: number
  /** Как настроена диктовка. */
  mode: DictationMode
  /** Запись начата удержанием клавиши — тишина её не заканчивает. */
  heldByKey: boolean
}

export interface FlowState {
  /** Речь в этой записи уже звучала — до неё тишина ничего не значит. */
  heard: boolean
  /** Самое громкое место записи: от него считается порог. */
  peak: number
  /** Момент начала текущей тишины (0 — звук есть). */
  quietSince: number
  /** Когда начался несобранный кусок (0 — куска нет). */
  chunkSince: number
}

export interface FlowDecision extends FlowState {
  /** Забрать накопленное и распознать — запись продолжается. */
  flush: boolean
  /** Закончить запись целиком. */
  stop: boolean
}

export const initialFlow = (): FlowState => ({
  heard: false,
  peak: 0,
  quietSince: 0,
  chunkSince: 0
})

/** Порог речи для записи с таким пиком. */
export function speechLevel(peak: number): number {
  return Math.max(NOISE_FLOOR, peak * SPEECH_RATIO)
}

export function dictationFlow(s: FlowState, i: FlowInput): FlowDecision {
  const peak = Math.max(s.peak, i.level)
  const speaking = i.level > speechLevel(peak)
  const idle = { ...s, peak, flush: false, stop: false }

  if (speaking) {
    return {
      ...idle,
      heard: true,
      quietSince: 0,
      // Кусок начинается с первого звука, а не с нажатия: молчание перед
      // началом не должно съедать предел длины.
      chunkSince: s.chunkSince || i.now
    }
  }

  // Речи ещё не было: человек собирается с мыслями — ждём сколько угодно.
  if (!s.heard) return { ...idle, quietSince: 0 }

  const quietSince = s.quietSince || i.now
  const quietFor = i.now - quietSince
  const withQuiet = { ...idle, heard: true, quietSince }

  // Клавишу держат — конец только по отпусканию, что бы ни говорила тишина.
  if (i.heldByKey || i.mode === 'hold') return withQuiet

  if (i.mode === 'phrase') {
    return quietFor > PHRASE_MS ? { ...withQuiet, stop: true } : withQuiet
  }

  // 'stream': пауза — не конец работы, а место, где можно резать.
  if (s.chunkSince && quietFor > CHUNK_MS) {
    return { ...withQuiet, chunkSince: 0, quietSince: 0, heard: false, flush: true }
  }
  return withQuiet
}

/**
 * Пора резать кусок принудительно: человек говорит без пауз.
 *
 * Отдельно от `dictationFlow`, потому что решается по ДЛИНЕ записи, а не по
 * уровню: тишины нет вовсе, а показать что-то надо.
 */
export function chunkOverdue(s: FlowState, now: number): boolean {
  return s.chunkSince > 0 && now - s.chunkSince > MAX_CHUNK_MS
}

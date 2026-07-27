/**
 * Microphone capture for dictation.
 *
 * The mic is opened on an explicit user action and closed the moment the
 * utterance ends — no permanently-open stream, no VAD listening in the
 * background. Audio never leaves the machine: samples go to the main process,
 * which transcribes them locally, and nothing is written to disk.
 *
 * Resampling is NOT done here: the main process has sherpa-onnx's own resampler,
 * so the renderer hands over whatever rate the device gave and stays dumb.
 */

export interface Recording {
  /** Stop, release the microphone and return the captured mono PCM. */
  stop: () => Promise<{ samples: Float32Array; sampleRate: number }>
  /** Give up without transcribing (Esc). */
  cancel: () => void
  /** Current input level, 0..1 — drives the on-screen meter. */
  level: () => number
  /**
   * Запрошенное устройство не открылось (отключили гарнитуру) и запись идёт в
   * системное. Молчать здесь нельзя: человек говорит в один микрофон, а пишет
   * другой, и узнать об этом можно только по качеству расшифровки.
   */
  fellBackToDefault: boolean
}

/** Longest single dictation. The main process enforces its own cap too. */
const MAX_SECONDS = 120

/** Общая часть запроса — меняется только устройство. */
const AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
} as const

/**
 * Устройство пропало — это не отказ в доступе и не поломка. Замерено в этом
 * Electron (scripts/mic-select-test.mjs): `exact` с несуществующим id даёт
 * OverconstrainedError. NotFoundError и NotReadableError (устройство занято
 * другим приложением) перечислены на будущее — они означают ровно то же самое,
 * и ответ на все три один: писать в системный, но сказать об этом.
 */
function isDeviceGone(e: unknown): boolean {
  const name = e instanceof Error ? e.name : ''
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError'
}

export interface RecordingOpts {
  /**
   * Устройство исчезло посреди записи (выдернули гарнитуру). Запись уже
   * остановлена и микрофон отпущен — обработчику остаётся погасить UI и сказать
   * об этом. Без этого onaudioprocess просто перестаёт приходить: индикатор
   * продолжает показывать запись, счётчик тишины ждёт «конца фразы», а
   * распознавать в итоге нечего.
   */
  onDeviceLost?: () => void
}

export async function startRecording(
  deviceId?: string,
  opts: RecordingOpts = {}
): Promise<Recording> {
  let fellBackToDefault = false
  let stream: MediaStream
  try {
    // `exact`, а не `ideal`, намеренно. С `ideal` Chromium при отсутствии
    // устройства молча возьмёт любое другое — успех неотличим от подмены, и
    // сказать о ней стало бы нечем. Ровно эта тихая подмена и есть то, ради
    // чего писался выбор микрофона. Менять на `ideal` можно только вместе с
    // другим способом узнать, что открылось не то устройство.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), ...AUDIO_CONSTRAINTS }
    })
  } catch (e) {
    // Отказ в доступе (NotAllowedError) сюда не попадает: он относится к
    // микрофону вообще, и повтор без устройства ничего не изменит.
    if (!deviceId || !isDeviceGone(e)) throw e
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS } })
    fellBackToDefault = true
  }

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but is the one path that works without
  // shipping a separate worklet file through the bundler; the buffer is small
  // and this runs only while dictating.
  //
  // It needs ONE output channel, not zero: Chromium refuses to connect a node
  // with no outputs, and the node has to reach the destination or onaudioprocess
  // never fires. The output is then silenced by a zero gain — otherwise the
  // microphone would be played back through the speakers.
  const node = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0

  const chunks: Float32Array[] = []
  let total = 0
  let peak = 0
  let stopped = false
  const maxSamples = ctx.sampleRate * MAX_SECONDS

  node.onaudioprocess = (e): void => {
    if (stopped) return
    const input = e.inputBuffer.getChannelData(0)
    if (total >= maxSamples) return
    chunks.push(new Float32Array(input))
    total += input.length
    // Peak with decay — a meter that only rises reads as stuck.
    let localPeak = 0
    for (let i = 0; i < input.length; i += 8) {
      const v = Math.abs(input[i])
      if (v > localPeak) localPeak = v
    }
    peak = Math.max(localPeak, peak * 0.82)
  }

  source.connect(node)
  node.connect(mute)
  mute.connect(ctx.destination)

  const tracks = stream.getTracks()
  const onEnded = (): void => {
    if (stopped) return
    release()
    opts.onDeviceLost?.()
  }

  const release = (): void => {
    // Идемпотентно: release() зовут и обычный стоп, и обрыв устройства, а
    // повторный ctx.close() отдаёт отклонённый промис, который некому ловить.
    if (stopped) return
    stopped = true
    for (const t of tracks) t.removeEventListener('ended', onEnded)
    try {
      node.disconnect()
      mute.disconnect()
      source.disconnect()
    } catch {
      /* already torn down */
    }
    for (const t of tracks) t.stop()
    void ctx.close()
  }

  // Трек кончается сам, когда устройство физически пропало. По спеке — да;
  // проверить это в тестах нечем (синтетическое устройство не выдернуть, а
  // track.stop() события не даёт), поэтому путь написан по спецификации и на
  // живом железе не воспроизводился.
  for (const t of tracks) t.addEventListener('ended', onEnded)

  return {
    fellBackToDefault,
    level: () => Math.min(1, peak * 1.6),
    cancel: release,
    stop: async () => {
      const sampleRate = ctx.sampleRate
      release()
      const samples = new Float32Array(total)
      let at = 0
      for (const c of chunks) {
        samples.set(c, at)
        at += c.length
      }
      return { samples, sampleRate }
    }
  }
}

/** Below this the take is silence — don't bother the recognizer with it. */
export function isSilent(samples: Float32Array): boolean {
  let sum = 0
  const step = Math.max(1, Math.floor(samples.length / 4000))
  let n = 0
  for (let i = 0; i < samples.length; i += step) {
    sum += samples[i] * samples[i]
    n++
  }
  return n === 0 || Math.sqrt(sum / n) < 0.004
}

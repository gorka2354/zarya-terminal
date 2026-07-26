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
}

/** Longest single dictation. The main process enforces its own cap too. */
const MAX_SECONDS = 120

export async function startRecording(deviceId?: string): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

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

  const release = (): void => {
    stopped = true
    try {
      node.disconnect()
      mute.disconnect()
      source.disconnect()
    } catch {
      /* already torn down */
    }
    for (const t of stream.getTracks()) t.stop()
    void ctx.close()
  }

  return {
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

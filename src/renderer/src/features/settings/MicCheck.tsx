import { useEffect, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { isSilent, startRecording, type Recording } from '@/features/voice/dictation'
import {
  chunkOverdue,
  dictationFlow,
  initialFlow,
  PHRASE_MS,
  speechLevel,
  type FlowState
} from '@shared/dictationFlow'
import { Icon } from '@/components/Icon'

/**
 * Проверка микрофона.
 *
 * «Он меня слышит?» — вопрос, на который до сих пор отвечал только опыт: нажми
 * диктовку в рабочей строке, скажи что-нибудь, посмотри, что вставится. Не
 * вставилось — гадай: не тот микрофон, слишком тихо, модель не скачалась,
 * распознало и выкинуло.
 *
 * Поэтому здесь показано ровно то, ЧТО ВИДИТ ЗАРЯ:
 *
 *   уровень   — живая шкала входа, прямо сейчас;
 *   порог     — с какого места этот звук считается речью (он адаптивный —
 *               подстраивается под самое громкое место записи);
 *   вердикт   — теми же словами, какими судит диктовка;
 *   поведение — ТОГО РЕЖИМА, который выбран рядом. Проверка, которая ведёт себя
 *               иначе, чем рабочая строка, проверяет что-то другое.
 */
export function MicCheck(): React.JSX.Element {
  const voice = useSettingsStore((s) => s.settings.voice)
  const mode = voice.mode ?? 'stream'
  const [state, setState] = useState<'idle' | 'rec' | 'work'>('idle')
  const [level, setLevel] = useState(0)
  const [flow, setFlow] = useState<FlowState>(initialFlow())
  const [left, setLeft] = useState(0)
  const [said, setSaid] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const recRef = useRef<Recording | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // Уход со вкладки не должен оставлять микрофон открытым: он один на всю
      // машину, и соседняя панель получила бы «занято» без объяснений.
      recRef.current?.cancel()
      recRef.current = null
    }
  }, [])

  const add = (text: string): void => setSaid((prev) => (prev ? `${prev} ${text}` : text))

  const hear = async (samples: Float32Array, rate: number): Promise<void> => {
    if (isSilent(samples)) return
    const res = await window.zarya.stt.transcribe(samples, rate)
    if (!aliveRef.current) return
    if (!res.ok) {
      setErr(res.error ?? t('voice.failed'))
      return
    }
    const text = (res.text ?? '').trim()
    // Пустая расшифровка — тоже ответ: микрофон слышал, а слов не разобрал.
    add(text || '')
    if (!text && said === null) setSaid('')
  }

  // Тот же таймер и то же правило, что в строке ввода.
  useEffect(() => {
    if (state !== 'rec') return
    let s = initialFlow()
    let busy = false
    const chunk = (): void => {
      const rec = recRef.current
      if (!rec || busy) return
      busy = true
      const { samples, sampleRate } = rec.take()
      void hear(samples, sampleRate).finally(() => {
        busy = false
      })
    }
    const timer = window.setInterval(() => {
      const lvl = recRef.current?.level() ?? 0
      const now = Date.now()
      const d = dictationFlow(s, { level: lvl, now, mode, heldByKey: false })
      s = { heard: d.heard, peak: d.peak, quietSince: d.quietSince, chunkSince: d.chunkSince }
      setLevel(lvl)
      setFlow(s)
      setLeft(mode === 'phrase' && s.quietSince ? Math.max(0, PHRASE_MS - (now - s.quietSince)) : 0)
      if (d.stop) {
        void finish()
        return
      }
      if (d.flush || (mode === 'stream' && chunkOverdue(s, now))) {
        if (!d.flush) s = { ...s, chunkSince: 0, heard: false, quietSince: 0 }
        chunk()
      }
    }, 100)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, mode])

  const start = async (): Promise<void> => {
    setSaid(null)
    setErr('')
    setFlow(initialFlow())
    try {
      const rec = await startRecording(voice.deviceId || undefined)
      if (!aliveRef.current) {
        rec.cancel()
        return
      }
      recRef.current = rec
      if (rec.fellBackToDefault) {
        // Человек говорит в один микрофон, а пишет другой: без этой строки
        // разница видна только по качеству расшифровки.
        useUiStore.getState().toast(t('mic.fellBack'), 'error')
      }
      setState('rec')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setState('idle')
    }
  }

  const finish = async (): Promise<void> => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    setLevel(0)
    setState('work')
    const { samples, sampleRate } = await rec.stop()
    await hear(samples, sampleRate)
    if (!aliveRef.current) return
    setState('idle')
    setSaid((prev) => prev ?? '')
  }

  const порог = speechLevel(flow.peak)
  const pct = (v: number): string => `${Math.min(100, Math.round(v * 100))}%`
  const вердикт =
    state === 'work'
      ? t('mic.working')
      : state !== 'rec'
        ? t('mic.idle')
        : !flow.heard
          ? t('mic.sayIt')
          : level > порог
            ? t('mic.hearing')
            : left > 0
              ? t('mic.endingIn', { s: (left / 1000).toFixed(1) })
              : t('mic.quiet')

  return (
    <div className="zy-miccheck">
      <div className="zy-miccheck-row">
        <button
          type="button"
          className={`zy-btn${state === 'rec' ? ' zy-btn--on' : ''}`}
          disabled={state === 'work'}
          onClick={() => (state === 'rec' ? void finish() : void start())}
        >
          <Icon name={state === 'rec' ? 'stop' : 'mic'} size={12} />
          {state === 'rec' ? t('mic.stop') : state === 'work' ? t('mic.working') : t('mic.start')}
        </button>
        <span className="zy-miccheck-verdict">{вердикт}</span>
      </div>

      {/*
        Шкала с ЧЕРТОЙ порога. Просто полоска отвечала бы «что-то слышно», а
        вопрос у человека другой: достаточно ли громко, чтобы Заря сочла это
        речью.
      */}
      <div className="zy-miccheck-meter" aria-hidden>
        <div
          className={`zy-miccheck-fill${level > порог ? ' zy-miccheck-fill--speech' : ''}`}
          style={{ width: pct(level) }}
        />
        {state === 'rec' && flow.peak > 0 && (
          <div className="zy-miccheck-mark" style={{ left: pct(порог) }} />
        )}
      </div>
      <div className="zy-miccheck-nums">
        {t('mic.levelNow', { n: Math.round(level * 100) })}
        {flow.peak > 0 && <> · {t('mic.threshold', { n: Math.round(порог * 100) })}</>}
      </div>

      {said !== null && (
        <div className="zy-miccheck-said">
          {said ? (
            <>
              {t('mic.heardText')} <b>{said}</b>
            </>
          ) : (
            t('mic.heardNothing')
          )}
        </div>
      )}
      {err && <div className="zy-miccheck-err">{err}</div>}
    </div>
  )
}

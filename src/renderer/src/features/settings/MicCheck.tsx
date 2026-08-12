import { useEffect, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { startRecording, type Recording } from '@/features/voice/dictation'
import { dictationStop, QUIET_MS, speechLevel, type StopDecision } from '@shared/dictationStop'
import { Icon } from '@/components/Icon'

/**
 * Проверка микрофона.
 *
 * «Он меня слышит?» — вопрос, на который до сих пор отвечал только опыт: нажми
 * диктовку в рабочей строке, скажи что-нибудь, посмотри, что вставится. Если не
 * вставилось — гадай, где сломалось: не тот микрофон, слишком тихо, модель не
 * скачалась, распознало и выкинуло.
 *
 * Поэтому здесь показано ровно то, ЧТО ВИДИТ ЗАРЯ, а не наше представление о
 * микрофоне:
 *
 *   уровень   — живая шкала входа, прямо сейчас;
 *   порог     — с какого места этот звук считается речью (он адаптивный —
 *               подстраивается под самое громкое место записи);
 *   вердикт   — «слышу речь» / «тихо», теми же словами, какими судит автостоп;
 *   отсчёт    — сколько осталось до конца фразы, когда стало тихо.
 *
 * Последняя строка — самая полезная. Автостоп и есть то место, где «микрофон не
 * работает» чаще всего означает «фраза не кончилась»: программа ждёт паузы,
 * человек ждёт текста, и оба правы.
 *
 * И весь путь целиком: сказанное уходит в ту же расшифровку, что и настоящая
 * диктовка, и показывается словами. Проверка, которая проверяет не то, чем
 * пользуются, — обман с лишним шагом.
 */
export function MicCheck(): React.JSX.Element {
  const voice = useSettingsStore((s) => s.settings.voice)
  const [state, setState] = useState<'idle' | 'rec' | 'work'>('idle')
  const [level, setLevel] = useState(0)
  const [judge, setJudge] = useState<StopDecision>({
    heard: false,
    peak: 0,
    quietSince: 0,
    stop: false
  })
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

  // Тот же таймер и то же правило, что в строке ввода: проверка обязана судить
  // по тем же законам, иначе она проверяет что-то другое.
  useEffect(() => {
    if (state !== 'rec') return
    let s: StopDecision = { heard: false, peak: 0, quietSince: 0, stop: false }
    const timer = window.setInterval(() => {
      const lvl = recRef.current?.level() ?? 0
      s = dictationStop({ ...s, level: lvl, now: Date.now(), heldByKey: false })
      setLevel(lvl)
      setJudge(s)
      setLeft(s.quietSince ? Math.max(0, QUIET_MS - (Date.now() - s.quietSince)) : 0)
      if (s.stop) void finish()
    }, 100)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const start = async (): Promise<void> => {
    setSaid(null)
    setErr('')
    setJudge({ heard: false, peak: 0, quietSince: 0, stop: false })
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
    const res = await window.zarya.stt.transcribe(samples, sampleRate)
    if (!aliveRef.current) return
    setState('idle')
    if (!res.ok) {
      setErr(res.error ?? t('voice.failed'))
      return
    }
    // Пустая расшифровка — тоже ответ, и он важнее пустого места на экране:
    // микрофон слышал, а слов не разобрал.
    setSaid((res.text ?? '').trim())
  }

  const порог = speechLevel(judge.peak)
  const pct = (v: number): string => `${Math.min(100, Math.round(v * 100))}%`

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
        <span className="zy-miccheck-verdict">
          {state === 'rec'
            ? judge.heard
              ? level > порог
                ? t('mic.hearing')
                : left > 0
                  ? t('mic.endingIn', { s: (left / 1000).toFixed(1) })
                  : t('mic.quiet')
              : t('mic.sayIt')
            : state === 'work'
              ? t('mic.working')
              : t('mic.idle')}
        </span>
      </div>

      {/*
        Шкала с ЧЕРТОЙ порога. Просто полоска отвечала бы «что-то слышно», а
        вопрос у человека другой: достаточно ли громко, чтобы Заря сочла это
        речью и потом дождалась конца фразы.
      */}
      <div className="zy-miccheck-meter" aria-hidden>
        <div
          className={`zy-miccheck-fill${level > порог ? ' zy-miccheck-fill--speech' : ''}`}
          style={{ width: pct(level) }}
        />
        {state === 'rec' && judge.peak > 0 && (
          <div className="zy-miccheck-mark" style={{ left: pct(порог) }} />
        )}
      </div>
      <div className="zy-miccheck-nums">
        {t('mic.levelNow', { n: Math.round(level * 100) })}
        {judge.peak > 0 && <> · {t('mic.threshold', { n: Math.round(порог * 100) })}</>}
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

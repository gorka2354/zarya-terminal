import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEngine, AgentEngineHealth } from '@shared/types'
import { t, useLang } from '@/lib/i18n'
import { useAiStore } from '@/features/ai/aiStore'
import { useSessionsStore } from '@/state/sessionsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import './enginetab.css'

/**
 * ДВИЖОК: что запускается, кем вошли и что с ним не так.
 *
 * Когда Claude Code сломан, сломанной выглядит Заря. Два разных `claude` в
 * системе (один старый, другой свежий), вход не тем аккаунтом, битая запятая в
 * чужом `settings.json` — снаружи всё это одинаково: агент не отвечает или
 * отвечает не тем. Человек чинит Зарю, которая не виновата, и обычно не там.
 *
 * Экран отвечает на три вопроса, ответа на которые нигде не было: КАКОЙ файл
 * работает, КТО вошёл и ЧТО о себе думает сам движок.
 *
 * ГРАНИЦА, которую здесь важно держать. Своё утверждение мы делаем только о
 * том, что знаем достоверно: пути, версии, выбор и его причина — наши данные.
 * Отчёт `claude doctor` показывается ДОСЛОВНО и без нашего вердикта поверх: он
 * внутренне противоречив (печатает найденную проблему и следом «проблем нет»),
 * и свести его в одно наше слово значило бы выбрать, какой из двух его фраз
 * верить.
 */
export function EngineTab(): React.JSX.Element {
  // Подписка на язык: без неё надписи сменились бы не в момент переключения, а
  // при следующей перерисовке по другой причине.
  useLang()

  const conversations = useAiStore((s) => s.conversations)
  const activeId = useAiStore((s) => s.activeId)
  const agentCaps = useUiStore((s) => s.agentCaps)
  const sessions = useSessionsStore((s) => s.sessions)

  /*
   * Движок выбираем по беседе — как во вкладке «Инструменты» и по той же
   * причине: движков несколько, и «здоровье вообще» не существует. Папка тоже
   * берётся у беседы: `claude doctor` читает настройки ТЕКУЩЕЙ папки, и без
   * неё отчёт был бы о чужом проекте.
   */
  const panes = useMemo(
    () => conversations.filter((c) => c.engine !== 'builtin'),
    [conversations]
  )
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = useMemo(
    () => panes.find((c) => c.id === (picked ?? activeId)) ?? panes[0],
    [panes, picked, activeId]
  )
  const engine = chosen?.engine as AgentEngine | undefined
  const caps = engine ? agentCaps?.[engine] : undefined
  /*
   * `caps === undefined` — «ещё не приехали», а не «не умеет»: карта
   * возможностей приходит одним асинхронным вызовом. Спрашиваем движок и верим
   * его ответу; `null` от него и означает «так не умею» (см. ниже).
   */
  const unsupported = caps ? !caps.health : false
  /*
   * Папка панели. Живая сессия знает свою (в неё могли `cd`), а если панель уже
   * закрыта — берём ту, в которой беседа открывалась.
   *
   * Раньше при закрытой панели выходило `undefined`, и `claude doctor`
   * запускался в папке САМОЙ ЗАРИ: подпись обещала «в папке этой панели», а
   * отчёт приходил о чужом каталоге.
   */
  const cwd = (chosen?.sessionId ? sessions[chosen.sessionId]?.cwd : undefined) ?? chosen?.cwd

  const [health, setHealth] = useState<AgentEngineHealth | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  // Номер последнего запроса: ответ старого не должен рисоваться поверх нового.
  const reqRef = useRef(0)
  // Движок ответил «так не умею» — это ответ, а не отсутствие ответа.
  const [denied, setDenied] = useState(false)

  const load = useCallback(
    async (doctor: boolean): Promise<void> => {
      if (!engine || unsupported) return
      if (doctor) setAsking(true)
      else setBusy(true)
      /*
       * Ответ, пришедший после смены панели, — ответ О ДРУГОЙ ПАПКЕ.
       *
       * `claude doctor` живёт секунды, и за это время человек успевает
       * переключить панель. Дорисовать его отчёт на новом экране значило бы
       * выдать разбор чужого проекта за разбор этого.
       */
      const mine = ++reqRef.current
      try {
        const h = await window.zarya.agent.health(engine, cwd, doctor)
        if (mine !== reqRef.current) return
        // `null` — движок так не умеет. Без этого экран навсегда оставался бы в
        // «Спрашиваю…»: карта возможностей могла не успеть приехать.
        if (!h) {
          setDenied(true)
          return
        }
        setDenied(false)
        // Отчёт движка НЕ затираем дешёвым обновлением: человек его только что
        // прочитал, а перерисовка списка не повод убирать текст с экрана.
        setHealth((prev) => (doctor || !prev?.doctor ? h : h && { ...h, doctor: prev.doctor }))
      } finally {
        if (mine === reqRef.current) {
          setBusy(false)
          setAsking(false)
        }
      }
    },
    [engine, cwd, unsupported]
  )

  // Открыли вкладку — спрашиваем ДЕШЁВОЕ: пути, версии, вход. Это доли секунды
  // и не запускает беседу. `doctor` — только с нажатия: он живёт секунды.
  useEffect(() => {
    /*
     * Health НЕ обнуляем: `cwd` меняется от обычного `cd` в панели, и обнуление
     * стирало бы уже прочитанный отчёт движка без единого слова. Ответ заменит
     * прежний сам, когда придёт.
     */
    void load(false)
  }, [load])

  // Сменили ПАНЕЛЬ — вот тогда прежний ответ и правда чужой.
  useEffect(() => {
    setHealth(null)
    setDenied(false)
  }, [chosen?.id])

  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const copyUpdate = async (): Promise<void> => {
    // Буфер обмена бывает занят другим приложением. Сказать «скопировано» и не
    // скопировать — отправить человека вставлять пустоту.
    try {
      await navigator.clipboard.writeText(UPDATE_CMD)
      setCopied('yes')
    } catch {
      setCopied('no')
    }
    setTimeout(() => setCopied(null), 2500)
  }

  if (!panes.length) {
    return (
      <section className="zy-set-section">
        <FileCheckpoints />
        <div className="zy-eng-empty">{t('eng.noPane')}</div>
      </section>
    )
  }

  const chosenBin = health?.binaries.find((b) => b.chosen)
  const others = health?.binaries.filter((b) => !b.chosen) ?? []

  return (
    <section className="zy-set-section">
      <FileCheckpoints />
      {panes.length > 1 && (
        <div className="zy-eng-pick">
          <span className="zy-eng-pick-label">{t('eng.pane')}</span>
          <select
            className="zy-input"
            value={chosen?.id ?? ''}
            onChange={(e) => setPicked(e.target.value)}
          >
            {panes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.engine}
              </option>
            ))}
          </select>
        </div>
      )}

      {unsupported || denied ? (
        <div className="zy-eng-empty">{t('eng.unsupported')}</div>
      ) : (
        <>
          <div className="zy-section-label">{t('eng.whatRuns')}</div>
          {!health && <div className="zy-eng-empty">{t(busy ? 'eng.loading' : 'eng.noAnswer')}</div>}
          {/*
            Ничего не выбрано — САМЫЙ ВАЖНЫЙ случай этого экрана, и раньше он был
            единственным, где экран показывал пустоту: блок рисовался только для
            выбранного, а «Ещё нашлись» без него читалось как заголовок ни к
            чему. Молчать про сломанный движок на экране про сломанный движок —
            худшее, что тут можно сделать.
          */}
          {health && !chosenBin && (
            <div className="zy-eng-bin zy-eng-bin--none">
              <div className="zy-eng-origin">{t('eng.noneChosen')}</div>
              <div className="zy-eng-why">{t(`eng.reason.${health.reason}`)}</div>
            </div>
          )}
          {chosenBin && (
            <div className="zy-eng-bin zy-eng-bin--chosen">
              <div className="zy-eng-bin-head">
                <span className="zy-eng-origin">{t(`eng.origin.${chosenBin.origin}`)}</span>
                <span className="zy-eng-ver">{chosenBin.version ?? t('eng.verUnknown')}</span>
              </div>
              <code className="zy-eng-path">{chosenBin.path}</code>
              {/* Почему именно он. Причина — ключ от главного процесса: политика
                  выбора живёт там, и пересказывать её здесь значило бы завести
                  вторую, которая однажды разойдётся с первой. */}
              <div className="zy-eng-why">{t(`eng.reason.${health?.reason}`)}</div>
            </div>
          )}
          {!!others.length && (
            <>
              {/*
                Другие найденные. Ровно тот случай, ради которого экран и нужен:
                «у меня же новая версия» — а работает не она.
              */}
              <div className="zy-eng-sub">{t(chosenBin ? 'eng.others' : 'eng.found')}</div>
              {others.map((b) => (
                <div key={b.path} className="zy-eng-bin">
                  <div className="zy-eng-bin-head">
                    <span className="zy-eng-origin">{t(`eng.origin.${b.origin}`)}</span>
                    <span className="zy-eng-ver">{b.version ?? t('eng.verUnknown')}</span>
                  </div>
                  <code className="zy-eng-path">{b.path}</code>
                </div>
              ))}
            </>
          )}

          <div className="zy-section-label">{t('eng.account')}</div>
          {health?.auth === undefined && <div className="zy-eng-empty">{t('eng.loading')}</div>}
          {health?.auth === null && (
            // Файла нет — значит спрашивать было НЕЧЕМ. Сказать «движок не
            // ответил» о вопросе, который не задавали, — второе враньё подряд
            // на экране, который для того и сделан, чтобы не врать.
            <div className="zy-eng-empty">
              {t(chosenBin ? 'eng.authUnknown' : 'eng.authNotAsked')}
            </div>
          )}
          {health?.auth && (
            <div className="zy-eng-auth">
              {health.auth.loggedIn ? (
                <>
                  <span className="zy-eng-ok">{t('eng.authIn')}</span>
                  {health.auth.email && <code className="zy-eng-path">{health.auth.email}</code>}
                  <span className="zy-eng-dim">
                    {[health.auth.plan, health.auth.method].filter(Boolean).join(' · ')}
                  </span>
                </>
              ) : (
                <>
                  <span className="zy-eng-bad">{t('eng.authOut')}</span>
                  <span className="zy-eng-dim">{t('eng.authOutHow')}</span>
                </>
              )}
            </div>
          )}

          <div className="zy-section-label">{t('eng.update')}</div>
          {/*
            Обновляем НЕ МЫ. Ставить чужой движок из-под себя — риск оставить
            человека без рабочего терминала посреди дня, и у самой команды нет
            даже проверки без установки. Показать версию и дать команду —
            ровно та граница, где мы ничем не рискуем за него.
          */}
          <div className="zy-eng-update">
            <code className="zy-eng-cmd">{UPDATE_CMD}</code>
            <button className="zy-eng-btn" onClick={() => void copyUpdate()}>
              {t(copied === 'yes' ? 'eng.copied' : copied === 'no' ? 'eng.copyFail' : 'eng.copy')}
            </button>
          </div>
          <div className="zy-eng-note">{t('eng.updateWhy')}</div>

          <div className="zy-section-label">{t('eng.doctor')}</div>
          {/* Папку называем прямо здесь: подпись обещает «в папке этой панели»,
              и человек должен видеть, о какой именно идёт речь. */}
          <div className="zy-eng-note">
            {cwd ? t('eng.doctorWhatIn', { dir: cwd }) : t('eng.doctorNoCwd')}
          </div>
          <button
            className="zy-eng-btn"
            disabled={asking || !cwd}
            onClick={() => void load(true)}
          >
            {t(asking ? 'eng.asking' : 'eng.ask')}
          </button>
          {health?.doctor?.ok === false && (
            <div className="zy-eng-empty">
              {/* Внутренний код отказа человеку не показываем: «exe-unknown» на
                  экране — это не объяснение, а утечка нашей кухни. */}
              {health.doctor.error === 'exe-unknown'
                ? t('eng.doctorNoExe')
                : t('eng.doctorFail', { why: health.doctor.error })}
            </div>
          )}
          {health?.doctor?.ok && (
            <>
              {/* Слова движка — дословно и с указанием, что они его, а не наши. */}
              <div className="zy-eng-sub">{t('eng.doctorSaid')}</div>
              <pre className="zy-eng-report">{health.doctor.text}</pre>
            </>
          )}

          <AppendPrompt />
        </>
      )}
    </section>
  )
}


/**
 * Человеческий размер: точность до десятых там, где она что-то значит.
 *
 * Единицы берутся из словаря: «6 KB» посреди русского экрана читается как
 * чужая строка, случайно оставшаяся от разработчика.
 */
function human(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} ${t('unit.kb')}`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} ${t('unit.mb')}`
  return `${(mb / 1024).toFixed(1)} ${t('unit.gb')}`
}

/**
 * Чекпоинты файлов — единственная наша настройка, которая платит ЧУЖИМ диском.
 *
 * Поэтому здесь порядок обратный обычному: сначала цена (полные копии открытым
 * текстом, включая .env и ключи, если агент их правил), потом польза, и только
 * потом переключатель. И размер папки — настоящий, посчитанный, а не «примерно
 * 3-10 МБ за сессию»: цифру, которой человек меряет цену, нельзя писать
 * константой в интерфейсе.
 */
function FileCheckpoints(): React.JSX.Element {
  const on = useSettingsStore((s) => s.settings.ai.fileCheckpoints)
  const update = useSettingsStore((s) => s.update)
  const [usage, setUsage] = useState<{
    dir: string
    bytes: number
    sessions: number
    missing?: boolean
    partial?: boolean
  } | null>(null)
  /*
   * НАШИ страховочные копии — отдельной строкой от копий движка.
   *
   * Там его копии и его же срок, здесь наши, и убрать их человек вправе в один
   * клик. Смешать их в одну цифру значило бы предложить удалить чужое.
   */
  const [mine, setMine] = useState<{ dir: string; bytes: number; runs: number } | null>(null)

  useEffect(() => {
    let alive = true
    void window.zarya.app.checkpointUsage().then((u) => {
      if (alive) setUsage(u)
    })
    void window.zarya.app.backupUsage().then((b) => {
      if (alive) setMine(b)
    })
    return () => {
      alive = false
    }
  }, [on])

  return (
    <>
      <div className="zy-section-label">{t('eng.cp')}</div>
      <div className="zy-eng-note">{t('eng.cpWhat')}</div>
      <div className="zy-eng-note">{t('eng.cpWhy')}</div>
      {/* Тот же переключатель, что во всех настройках: своя разметка здесь
          выглядела бы «другой настройкой», а это ровно та мелочь, из-за которой
          экран перестаёт читаться как одно целое. */}
      <div className="zy-eng-cp-row">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`zy-switch${on ? ' zy-switch--on' : ''}`}
          onClick={() => void update({ ai: { fileCheckpoints: !on } as never })}
        >
          <span className="zy-switch-knob" />
        </button>
        <span className="zy-eng-cp-label">{t('eng.cpToggle')}</span>
      </div>
      {mine && (
        <div className="zy-eng-sub">
          {mine.runs === 0
            ? t('eng.cpBackupNone')
            : t('eng.cpBackup', { size: human(mine.bytes), n: mine.runs })}
          {mine.runs > 0 && (
            <>
              {' · '}
              <button
                type="button"
                className="zy-eng-btn"
                onClick={() => void window.zarya.app.backupClear().then(setMine)}
              >
                {t('eng.cpBackupClear')}
              </button>
            </>
          )}
          <div className="zy-eng-note">{t('eng.cpBackupWhat')}</div>
        </div>
      )}
      {usage && (
        <div className="zy-eng-sub">
          {usage.missing || usage.bytes === 0
            ? t('eng.cpEmpty')
            : t(usage.partial ? 'eng.cpSizeAtLeast' : 'eng.cpSize', {
                size: human(usage.bytes),
                n: usage.sessions
              })}
          {!usage.missing && (
            <>
              {' · '}
              <button
                type="button"
                className="zy-eng-btn"
                onClick={() => window.zarya.app.showItemInFolder(usage.dir)}
              >
                {t('eng.cpOpen')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}

/** Команда обновления движка. Одна на весь экран — чтобы не разошлась. */
const UPDATE_CMD = 'claude update'

/**
 * Приписка к системному промпту движка.
 *
 * То же, что `--append-system-prompt` у консоли: правило «на сейчас», которое
 * не хочется класть в `CLAUDE.md` проекта. Уходит движку как
 * `systemPrompt: { preset: 'claude_code', append }` — то есть ДОПОЛНЯЕТ его
 * собственный промпт, а не заменяет: замена сняла бы с агента всё, что он о
 * себе знает, и это была бы не настройка, а поломка.
 *
 * Действует в беседах, начатых ПОСЛЕ изменения. Так честнее, чем обещать
 * немедленность: состав промпта движку задаётся при запуске сессии, а сессия
 * живёт весь разговор.
 */
function AppendPrompt(): React.JSX.Element {
  const value = useSettingsStore((s) => s.settings.ai.enginePromptExtra)
  const update = useSettingsStore((s) => s.update)
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <>
      <div className="zy-section-label">{t('eng.append')}</div>
      <div className="zy-eng-note">{t('eng.appendWhen')}</div>
      <textarea
        className="zy-input zy-textarea"
        rows={3}
        value={text}
        placeholder={t('eng.appendPh')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== value) void update({ ai: { enginePromptExtra: text } as never })
        }}
      />
    </>
  )
}

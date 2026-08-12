import { useEffect, useState } from 'react'
import type { AiCli } from '@shared/types'
import { t, useLang } from '@/lib/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { setIdeMode } from '@/features/ide/ideMode'
import { Icon } from '@/components/Icon'
import logoZarya from '@/assets/logo-zarya-64.png'
import './onboarding.css'

/**
 * Первый экран — три шага, каждый пропускается.
 *
 * ЧТО ОН НЕ ДЕЛАЕТ. Не заводит идентификатор, не отправляет ответы и вообще не
 * ходит в сеть: знакомство — самая удобная минута, чтобы завести «анонимный ID
 * только для метрик», и именно за это мы ругаем соседей. Всё, что здесь
 * спрашивается, применяется к настройкам этого же человека и остаётся у него.
 *
 * ПОЧЕМУ НЕ ТУР С ПОДСВЕТКОЙ. Тур закрывает собой продукт и пролистывается не
 * читая. Здесь коротко: что это, чем работать, и одна развилка, которая правда
 * меняет интерфейс. Пропуск не отнимает ничего — второй раз экран не придёт, а
 * всё то же лежит в настройках и палитре.
 */
export function Onboarding(): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const onboarded = useSettingsStore((s) => s.settings.onboarded)
  const ideMode = useSettingsStore((s) => s.settings.ideMode)
  const [step, setStep] = useState(0)
  const [clis, setClis] = useState<AiCli[]>([])
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (onboarded) return
    void window.zarya.aiClis.detect().then(setClis)
  }, [onboarded])

  useEffect(() => {
    if (onboarded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded])

  if (onboarded) return null

  const finish = async (): Promise<void> => {
    await useSettingsStore.getState().update({ onboarded: true } as never)
  }

  const found = clis.filter((c) => c.detected)
  const missing = clis.filter((c) => !c.detected)

  const steps: Array<{ title: string; body: React.JSX.Element }> = [
    {
      title: t('ob.s1.title'),
      body: (
        <>
          <p className="zy-ob-text">{t('ob.s1.what')}</p>
          <p className="zy-ob-text">{t('ob.s1.panes')}</p>
          <p className="zy-ob-text zy-ob-text--quiet">{t('ob.s1.local')}</p>
        </>
      )
    },
    {
      title: t('ob.s2.title'),
      body: (
        <>
          {!clis.length && <p className="zy-ob-text zy-ob-text--quiet">{t('ob.s2.checking')}</p>}
          {!!found.length && (
            <>
              <p className="zy-ob-text">{t('ob.s2.found')}</p>
              <div className="zy-ob-clis">
                {found.map((c) => (
                  <span key={c.id} className="zy-ob-cli zy-ob-cli--on">
                    <Icon name="check" size={12} />
                    {c.name}
                  </span>
                ))}
              </div>
            </>
          )}
          {!!missing.length && (
            <>
              <p className="zy-ob-text">
                {found.length ? t('ob.s2.restMore') : t('ob.s2.restNone')}
              </p>
              <div className="zy-ob-install">
                {missing.map((c) => (
                  <div key={c.id} className="zy-ob-install-row">
                    <span className="zy-ob-cli">{c.name}</span>
                    {c.install ? (
                      <>
                        <code className="zy-ob-cmd">{c.install}</code>
                        <button
                          type="button"
                          className="zy-ob-btn zy-ob-btn--slim"
                          onClick={() => {
                            void navigator.clipboard.writeText(c.install as string)
                            setCopied(c.id)
                          }}
                        >
                          {t(copied === c.id ? 'ob.s2.copied' : 'ob.s2.copy')}
                        </button>
                      </>
                    ) : (
                      // Команды не знаем — и не выдумываем: отправляем туда, где
                      // она написана авторами.
                      <button
                        type="button"
                        className="zy-ob-btn zy-ob-btn--slim"
                        onClick={() => c.site && window.zarya.app.openExternal(c.site)}
                        title={c.site}
                      >
                        {t('ob.s2.site')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="zy-ob-text zy-ob-text--quiet">{t('ob.s2.note')}</p>
            </>
          )}
        </>
      )
    },
    {
      title: t('ob.s3.title'),
      body: (
        <>
          <p className="zy-ob-text">{t('ob.s3.what')}</p>
          <div className="zy-ob-choice">
            <button
              type="button"
              className={`zy-ob-card${!ideMode ? ' zy-ob-card--on' : ''}`}
              onClick={() => setIdeMode(false)}
            >
              <span className="zy-ob-card-title">{t('ob.s3.plain')}</span>
              <span className="zy-ob-card-sub">{t('ob.s3.plainSub')}</span>
            </button>
            <button
              type="button"
              className={`zy-ob-card${ideMode ? ' zy-ob-card--on' : ''}`}
              onClick={() => setIdeMode(true)}
            >
              <span className="zy-ob-card-title">{t('ob.s3.ide')}</span>
              <span className="zy-ob-card-sub">{t('ob.s3.ideSub')}</span>
            </button>
          </div>
          <p className="zy-ob-text zy-ob-text--quiet">{t('ob.s3.later')}</p>
        </>
      )
    }
  ]

  const last = step === steps.length - 1

  return (
    <div className="zy-overlay-backdrop zy-overlay-backdrop--center">
      <div className="zy-ob" role="dialog" aria-label={t('ob.aria')}>
        <header className="zy-ob-head">
          <img
            src={logoZarya}
            width={28}
            height={28}
            alt=""
            style={{ imageRendering: 'pixelated' }}
          />
          <div>
            <div className="zy-ob-title">{steps[step].title}</div>
            <div className="zy-ob-step">{t('ob.step', { i: step + 1, n: steps.length })}</div>
          </div>
          <div className="zy-ob-spacer" />
        </header>

        <div className="zy-ob-body">{steps[step].body}</div>

        <footer className="zy-ob-foot">
          {/* Пропуск стоит первым и не прячется: человек, которому это не нужно,
              не должен искать выход. */}
          <button
            type="button"
            className="zy-ob-btn zy-ob-btn--quiet"
            onClick={() => void finish()}
          >
            {t('ob.skip')}
          </button>
          <div className="zy-ob-spacer" />
          {step > 0 && (
            <button type="button" className="zy-ob-btn" onClick={() => setStep((s) => s - 1)}>
              {t('ob.back')}
            </button>
          )}
          <button
            type="button"
            className="zy-ob-btn zy-ob-btn--go"
            onClick={() => (last ? void finish() : setStep((s) => s + 1))}
          >
            {t(last ? 'ob.start' : 'ob.next')}
          </button>
        </footer>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import {
  assetUrl,
  releasePageUrl,
  shouldRecheck,
  splitByPlatform,
  type ReleaseAsset
} from '@shared/updates'
import { renderMarkdown } from '@/features/ai/markdown'
import { Icon } from '@/components/Icon'
import { PixelIcon } from '@/components/PixelIcon'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUpdateStore } from './updateStore'
import { t, useLang } from '@/lib/i18n'
import './updates.css'

/**
 * «Что нового» — отдельная страница, а не всплывашка поверх работы.
 *
 * Показывает то, ради чего человек нажал: что изменилось (тело релиза, тот же
 * markdown-рендер с DOMPurify, что и у ответов агента), чем это скачать и как
 * убедиться, что скачалось именно оно.
 *
 * Приложение ничего не скачивает и не запускает само. Кнопка открывает страницу
 * релиза во внешнем браузере, а адрес собран НАМИ из константы репозитория и
 * проверенного тега — не взят из ответа сервера. Подменённый ответ не должен
 * уметь превратить доверенную кнопку в ссылку куда угодно.
 */
function fmtSize(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / 1_000_000
  return mb >= 1
    ? `${mb.toFixed(0)} ${t('unit.mb')}`
    : `${Math.max(1, Math.round(bytes / 1000))} ${t('unit.kb')}`
}

/**
 * Ссылки в заметках о релизе обезвреживаются: текст остаётся, адрес показывается
 * рядом простым текстом, нажать нельзя.
 *
 * DOMPurify вырезает скрипты, но обычная ссылка — не скрипт: строка из сети
 * превращалась в один клик до произвольного адреса, а выглядело это как кнопка
 * от автора приложения («скачать»). Все законные адреса эта страница строит
 * сама, из константы репозитория, — значит кликабельные ссылки здесь просто не
 * нужны, и дешевле убрать целый класс фишинга, чем рассуждать о его вероятности.
 */
function defuseLinks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const span = doc.createElement('span')
    span.className = 'zy-upd-link'
    const href = a.getAttribute('href') ?? ''
    span.textContent = href && href !== a.textContent ? `${a.textContent} (${href})` : a.textContent
    a.replaceWith(span)
  }
  return doc.body.innerHTML
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Когда спрашивали в последний раз — часы и минуты, без секундной суеты. */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Одна кнопка на весь путь: «Установить» → полоса скачивания → «Перезапустить».
 *
 * Приложение не качает и не ставит ничего в фоне. Разница между «нажал кнопку» и
 * «оно само подменило исполняемый файл, пока ты работал» — принципиальная, тем
 * более что сборки не подписаны. Зато после нажатия человеку больше делать
 * нечего: ни браузера, ни мастера установки, ни ручной сверки хеша — её
 * выполняет обновлятор по sha512 из метаданных релиза.
 */
function InstallButton(): React.JSX.Element {
  const state = useUpdateStore((s) => s.state)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const dl = state?.downloading

  if (state?.downloaded) {
    return (
      <button
        className="zy-btn zy-btn--accent"
        title={t('upd.restartHint')}
        onClick={() => void install()}
      >
        {t('upd.restart')}
      </button>
    )
  }
  if (dl) {
    const mb = (n: number): string => (n / 1_000_000).toFixed(0)
    return (
      <button className="zy-btn zy-upd-progress" disabled>
        <span className="zy-upd-progress-fill" style={{ width: `${dl.percent}%` }} />
        <span className="zy-upd-progress-text">
          {dl.total
            ? t('upd.progress', { done: mb(dl.transferred), total: mb(dl.total) })
            : t('upd.downloading')}
        </span>
      </button>
    )
  }
  return (
    <button
      className="zy-btn zy-btn--accent"
      title={t('upd.installHint')}
      onClick={() => void download()}
    >
      {t('upd.install')}
    </button>
  )
}

/**
 * Сборки для других систем — под катом.
 *
 * Страница релиза одна на все платформы, и человеку с Windows четыре строки из
 * пяти не нужны. Но и прятать совсем нельзя: бывает, качают для другой машины.
 */
function OtherPlatforms({
  files,
  tag,
  sums
}: {
  files: ReleaseAsset[]
  tag: string
  sums: Record<string, string>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button className="zy-upd-more" onClick={() => setOpen(true)}>
        {t('upd.otherBuilds', { n: files.length })}
      </button>
    )
  }
  return (
    <>
      {files.map((f) => {
        const url = assetUrl(tag, f.name)
        const sha = sums[f.name]
        return (
          <div key={f.name} className="zy-upd-file">
            <div className="zy-upd-file-main">
              <span className="zy-upd-file-name">{f.name}</span>
              <span className="zy-upd-file-size">{fmtSize(f.size)}</span>
              {url && (
                <button
                  className="zy-btn"
                  data-url={url}
                  title={t('upd.openUrl', { url })}
                  onClick={() => window.zarya.app.openExternal(url)}
                >
                  {t('upd.download')}
                </button>
              )}
            </div>
            {sha && <div className="zy-upd-file-sha">SHA256 {sha}</div>}
          </div>
        )
      })}
    </>
  )
}

export default function UpdateView(): React.JSX.Element | null {
  const open = useUiStore((s) => s.updateOpen)
  const state = useUpdateStore((s) => s.state)
  const check = useUpdateStore((s) => s.check)
  /*
   * «Проверять обновления» выключено — значит Заря не спрашивает САМА нигде,
   * включая это окно. Кнопка «Проверить снова» при этом остаётся: человек,
   * отключивший фоновые проверки, не отказывался от права спросить руками.
   */
  const autoCheck = useSettingsStore((s) => s.settings.updates.check)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useUiStore.getState().set({ updateOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /*
   * Открыли окно — спрашиваем заново.
   *
   * Проверка идёт раз при запуске, и до этой правки окно показывало тот
   * единственный ответ как текущий. Подпись же появляется ПОЗЖЕ сборки: её
   * ставит человек ключом, которого нет в CI. Поэтому оказалось так, что
   * приложение честно говорило «у релиза нет подписи автора» ещё долго после
   * того, как подпись легла, — и переоткрытие окна ничего не меняло.
   *
   * Свежее чем полминуты не перепроверяем: открыть и закрыть окно дважды
   * подряд — обычное дело, а сеть за это платить не должна.
   */
  useEffect(() => {
    const recheck = shouldRecheck({
      open,
      autoCheck,
      checkedAt: useUpdateStore.getState().state?.checkedAt,
      now: Date.now()
    })
    if (recheck) void check()
  }, [open, autoCheck, check])

  /*
   * Пока окно открыто, а подписи нет — тихо переспрашиваем.
   *
   * Это единственное состояние, которое чинится САМО, без действий человека:
   * мейнтейнер подписывает релиз через минуты после сборки. Всё остальное
   * (нет обновления, ошибка сети) ждать не нужно, поэтому и таймера нет.
   * Фонового опроса при закрытом окне здесь не появляется: интервал живёт
   * ровно столько, сколько человек смотрит.
   */
  const unsigned = open && autoCheck && !!state?.latest && state?.signature !== 'ok'
  useEffect(() => {
    if (!unsigned) return
    const iv = setInterval(() => void check(), 120_000)
    return () => clearInterval(iv)
  }, [unsigned, check])

  if (!open) return null
  const close = (): void => useUiStore.getState().set({ updateOpen: false })
  const rel = state?.latest
  const busy = !!state?.downloading
  // Подпись списка сумм ключом автора — единственное, что не может подделать
  // сам сборочный конвейер. Нет её — ставить одним нажатием нельзя, но ручной
  // путь со страницы релиза остаётся: это не блокировка, а отказ ручаться.
  const signed = state?.signature === 'ok'
  const selfInstall = !!state?.canInstall && signed
  const page = rel ? releasePageUrl(rel.tag) : null
  const { mine, others } = rel
    ? splitByPlatform(rel.assets, state?.platform ?? 'win32')
    : { mine: [] as ReleaseAsset[], others: [] as ReleaseAsset[] }

  return (
    <div className="zy-overlay-backdrop zy-overlay-backdrop--center" onMouseDown={close}>
      <div className="zy-upd" onMouseDown={(e) => e.stopPropagation()}>
        <header className="zy-upd-head">
          <span className="zy-upd-mark">
            <PixelIcon name="download" />
          </span>
          <div className="zy-upd-title">
            <div className="zy-upd-name">
              {rel?.name || (rel ? t('upd.name', { v: rel.version }) : t('upd.update'))}
            </div>
            <div className="zy-upd-sub">
              {rel ? t('upd.versionCaps', { v: rel.version }) : 'UPDATE'}
              {rel && fmtDate(rel.publishedAt) ? ` · ${fmtDate(rel.publishedAt)}` : ''}
            </div>
          </div>
          <div className="zy-upd-spacer" />
          <button className="zy-upd-x" onClick={close} title={t('common.closeEsc')}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="zy-upd-body">
          {state?.installError && (
            <div className="zy-set-warning">
              {t('upd.installFail', { err: state.installError })}
            </div>
          )}
          {rel && state?.signature && !signed && (
            <div className="zy-set-warning">
              {state.signature === 'bad' ? t('upd.sigBad') : t('upd.sigNone')}
            </div>
          )}
          {!rel ? (
            <div className="zy-upd-empty">
              {state?.checking
                ? t('upd.checking')
                : state?.error
                  ? t('upd.checkFail', { err: state.error })
                  : t('upd.nothing')}
            </div>
          ) : (
            <>
              <div className="zy-upd-vers">
                <span className="zy-upd-vers-cur">
                  {t('upd.yours', { v: state?.current ?? '' })}
                </span>
                <span className="zy-upd-vers-arrow">→</span>
                <span className="zy-upd-vers-new">{rel.version}</span>
              </div>

              {rel.body.trim() ? (
                <div
                  className="zy-upd-notes zy-md"
                  dangerouslySetInnerHTML={{ __html: defuseLinks(renderMarkdown(rel.body)) }}
                />
              ) : (
                <div className="zy-upd-empty">{t('upd.emptyNotes')}</div>
              )}

              {mine.length > 0 && (
                <div className="zy-upd-files">
                  <div className="zy-section-label">{t('upd.files')}</div>
                  {mine.map((f) => {
                    const url = assetUrl(rel.tag, f.name)
                    const sha = rel.sums[f.name]
                    return (
                      <div key={f.name} className="zy-upd-file">
                        <div className="zy-upd-file-main">
                          <span className="zy-upd-file-name">{f.name}</span>
                          <span className="zy-upd-file-size">{fmtSize(f.size)}</span>
                          {url && (
                            <button
                              className="zy-btn"
                              // Адрес виден до нажатия: кнопка ведёт наружу, и
                              // человек вправе знать куда, не кликая наугад.
                              data-url={url}
                              title={t('upd.openUrl', { url })}
                              onClick={() => window.zarya.app.openExternal(url)}
                            >
                              {t('upd.download')}
                            </button>
                          )}
                        </div>
                        {/* Хеш рядом с файлом — чтобы «скачайте установщик» не было
                            просьбой поверить сети на слово. */}
                        {sha && (
                          <div className="zy-upd-file-sha" title={t('upd.shaHint')}>
                            SHA256 {sha}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {others.length > 0 && (
                    <OtherPlatforms files={others} tag={rel.tag} sums={rel.sums} />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="zy-upd-foot">
          <span className="zy-upd-foot-note">
            {!state?.canInstall
              ? t('upd.manualBuild')
              : signed
                ? t('upd.safeNote')
                : t('upd.unsignedNote')}
            {/*
              Когда спрашивали в последний раз. Без этого ответ получасовой
              давности выглядит как сегодняшний — а он меняется: подпись
              появляется уже после сборки, и «нет подписи» бывает просто
              устаревшим.
            */}
            {state?.checkedAt ? (
              <span className="zy-upd-foot-when">
                {' · '}
                {state.checking
                  ? t('upd.checkingNow')
                  : t('upd.checkedAt', { time: fmtTime(state.checkedAt) })}
              </span>
            ) : null}
          </span>
          <div className="zy-upd-spacer" />
          <button
            className="zy-btn"
            onClick={() => void check()}
            disabled={state?.checking || busy}
          >
            {state?.checking ? t('upd.checking') : t('upd.checkAgain')}
          </button>
          {rel && selfInstall && <InstallButton />}
          {page && (
            <button
              // Акцент достаётся ровно одному действию. Когда приложение умеет
              // поставить обновление само, главное — «Установить»; страница
              // релиза становится второстепенной. Когда не умеет (macOS без
              // подписи), главным становится ручной путь.
              className={`zy-btn${selfInstall ? '' : ' zy-btn--accent'}`}
              data-url={page}
              title={t('upd.openUrl', { url: page })}
              onClick={() => window.zarya.app.openExternal(page)}
            >
              {t('upd.openRelease')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

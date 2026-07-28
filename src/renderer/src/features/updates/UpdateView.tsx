import { useEffect, useState } from 'react'
import {
  assetUrl,
  releasePageUrl,
  splitByPlatform,
  type ReleaseAsset
} from '@shared/updates'
import { renderMarkdown } from '@/features/ai/markdown'
import { Icon } from '@/components/Icon'
import { PixelIcon } from '@/components/PixelIcon'
import { useUiStore } from '@/state/uiStore'
import { useUpdateStore } from './updateStore'
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
  return mb >= 1 ? `${mb.toFixed(0)} МБ` : `${Math.max(1, Math.round(bytes / 1000))} КБ`
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
        title="Заря закроется, поставит обновление и откроется снова. Открытые сессии сохранятся."
        onClick={() => void install()}
      >
        Перезапустить и установить
      </button>
    )
  }
  if (dl) {
    const mb = (n: number): string => (n / 1_000_000).toFixed(0)
    return (
      <button className="zy-btn zy-upd-progress" disabled>
        <span className="zy-upd-progress-fill" style={{ width: `${dl.percent}%` }} />
        <span className="zy-upd-progress-text">
          {dl.total ? `${mb(dl.transferred)} / ${mb(dl.total)} МБ` : 'Скачиваю…'}
        </span>
      </button>
    )
  }
  return (
    <button
      className="zy-btn zy-btn--accent"
      title="Скачает обновление и проверит его целостность. Установка — по отдельному подтверждению."
      onClick={() => void download()}
    >
      Установить обновление
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
        Сборки для других систем ({files.length})
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
                  title={`Открыть ${url}`}
                  onClick={() => window.zarya.app.openExternal(url)}
                >
                  Скачать
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

  if (!open) return null
  const close = (): void => useUiStore.getState().set({ updateOpen: false })
  const rel = state?.latest
  const busy = !!state?.downloading
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
            <div className="zy-upd-name">{rel?.name || (rel ? `Заря ${rel.version}` : 'Обновление')}</div>
            <div className="zy-upd-sub">
              {rel ? `ВЕРСИЯ ${rel.version}` : 'UPDATE'}
              {rel && fmtDate(rel.publishedAt) ? ` · ${fmtDate(rel.publishedAt)}` : ''}
            </div>
          </div>
          <div className="zy-upd-spacer" />
          <button className="zy-upd-x" onClick={close} title="Закрыть (Esc)">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="zy-upd-body">
          {state?.installError && (
            <div className="zy-set-warning">Не удалось обновить: {state.installError}</div>
          )}
          {!rel ? (
            <div className="zy-upd-empty">
              {state?.checking ? 'Проверяю…' : state?.error ? `Не удалось проверить: ${state.error}` : 'Пока нечего показать.'}
            </div>
          ) : (
            <>
              <div className="zy-upd-vers">
                <span className="zy-upd-vers-cur">у вас {state?.current}</span>
                <span className="zy-upd-vers-arrow">→</span>
                <span className="zy-upd-vers-new">{rel.version}</span>
              </div>

              {rel.body.trim() ? (
                <div
                  className="zy-upd-notes zy-md"
                  dangerouslySetInnerHTML={{ __html: defuseLinks(renderMarkdown(rel.body)) }}
                />
              ) : (
                <div className="zy-upd-empty">Описание релиза пустое.</div>
              )}

              {mine.length > 0 && (
                <div className="zy-upd-files">
                  <div className="zy-section-label">Файлы</div>
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
                              title={`Открыть ${url}`}
                              onClick={() => window.zarya.app.openExternal(url)}
                            >
                              Скачать
                            </button>
                          )}
                        </div>
                        {/* Хеш рядом с файлом — чтобы «скачайте установщик» не было
                            просьбой поверить сети на слово. */}
                        {sha && (
                          <div className="zy-upd-file-sha" title="SHA256 из файла контрольных сумм релиза">
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
            {state?.canInstall
              ? 'Ничего не качается и не ставится в фоне. Целостность проверяется автоматически.'
              : 'Эта сборка не умеет обновляться сама (переносимая версия, macOS или .deb) — скачайте файл и запустите установку. Рядом с файлом лежит SHA256 для сверки.'}
          </span>
          <div className="zy-upd-spacer" />
          <button className="zy-btn" onClick={() => void check()} disabled={state?.checking || busy}>
            {state?.checking ? 'Проверяю…' : 'Проверить снова'}
          </button>
          {rel && state?.canInstall && <InstallButton />}
          {page && (
            <button
              // Акцент достаётся ровно одному действию. Когда приложение умеет
              // поставить обновление само, главное — «Установить»; страница
              // релиза становится второстепенной. Когда не умеет (macOS без
              // подписи), главным становится ручной путь.
              className={`zy-btn${state?.canInstall ? '' : ' zy-btn--accent'}`}
              data-url={page}
              title={`Открыть ${page}`}
              onClick={() => window.zarya.app.openExternal(page)}
            >
              Открыть страницу релиза
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

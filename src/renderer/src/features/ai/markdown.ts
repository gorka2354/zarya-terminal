import { t } from '@/lib/i18n'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * Markdown renderer for AI chat messages.
 *
 * marked -> DOMPurify.sanitize -> code-block decoration (wraps every fenced
 * code block in a `.zy-md-code` container with a header bar holding
 * Copy/Insert/Run buttons). The raw code text is stored URI-encoded in a
 * `data-code` attribute so the panel can read it back exactly via event
 * delegation without re-parsing rendered/escaped HTML.
 */

const ACTIONS: Array<{ action: string; icon: string; titleKey: string }> = [
  { action: 'copy', icon: '⧉', titleKey: 'md.copy' },
  { action: 'insert', icon: '⏎', titleKey: 'md.insert' },
  { action: 'run', icon: '▶', titleKey: 'md.run' }
]

/**
 * Уже разобранная разметка. Разбор стоит дорого: marked + DOMPurify + разбор
 * готового HTML в документ ради подписей к блокам кода. А зовут его на КАЖДУЮ
 * перерисовку каждого ответа: пока агент печатает, лента из двух десятков ходов
 * пересобирала всю свою разметку по несколько раз в секунду — и это в каждой из
 * четырёх панелей. Текст сообщения не меняется после того, как дописан, поэтому
 * разбирать его повторно незачем.
 */
const cache = new Map<string, string>()
/** Потолок: лента не бесконечна, а память — не свалка (см. «Заря не оставляет мусор»). */
const CACHE_MAX = 400

export function renderMarkdown(md: string): string {
  if (!md) return ''
  const hit = cache.get(md)
  if (hit !== undefined) return hit
  const rawHtml = marked.parse(md, { gfm: true, breaks: true, async: false }) as string
  const clean = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel'] })
  const out = decorateCodeBlocks(clean)
  // Самая старая запись уходит первой: у растущего ответа каждый кусок даёт
  // новый ключ, и без вытеснения карта росла бы вместе с разговором.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(md, out)
  return out
}

function decorateCodeBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pres = doc.querySelectorAll('pre')
  pres.forEach((pre) => {
    const codeEl = pre.querySelector('code')
    const codeText = codeEl?.textContent ?? pre.textContent ?? ''
    const langMatch = /language-(\S+)/.exec(codeEl?.className ?? '')
    const lang = langMatch?.[1] ?? 'text'
    const isDiff = lang === 'diff' || lang === 'patch'

    const wrapper = doc.createElement('div')
    wrapper.className = isDiff ? 'zy-md-code zy-md-patch' : 'zy-md-code'
    wrapper.setAttribute('data-code', encodeURIComponent(codeText))

    const bar = doc.createElement('div')
    bar.className = 'zy-md-code-bar'

    const langSpan = doc.createElement('span')
    langSpan.className = 'zy-md-code-lang'
    // Patch header: «ПАТЧ · <file>» if the diff names a target file.
    if (isDiff) {
      const fileMatch =
        /^\+\+\+\s+b?\/?(\S+)/m.exec(codeText) || /^diff --git a\/\S+ b\/(\S+)/m.exec(codeText)
      langSpan.textContent = fileMatch ? t('md.patchFile', { file: fileMatch[1] }) : t('md.patch')
    } else {
      langSpan.textContent = lang
    }
    bar.appendChild(langSpan)

    const actions = doc.createElement('span')
    actions.className = 'zy-md-code-actions'
    for (const { action, icon, titleKey } of ACTIONS) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = 'zy-md-code-btn'
      btn.dataset.codeAction = action
      btn.title = t(titleKey)
      btn.textContent = icon
      actions.appendChild(btn)
    }
    bar.appendChild(actions)

    // Color diff lines (+ added / - removed), skipping the +++/--- headers.
    if (isDiff && codeEl) {
      const lines = codeText.replace(/\n$/, '').split('\n')
      codeEl.textContent = ''
      for (const line of lines) {
        const span = doc.createElement('span')
        span.className = 'zy-diff-line'
        if (line.startsWith('+') && !line.startsWith('+++')) span.classList.add('zy-diff-add')
        else if (line.startsWith('-') && !line.startsWith('---')) span.classList.add('zy-diff-del')
        span.textContent = line + '\n'
        codeEl.appendChild(span)
      }
    }

    pre.parentNode?.insertBefore(wrapper, pre)
    wrapper.appendChild(bar)
    wrapper.appendChild(pre)
  })
  return doc.body.innerHTML
}

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

const ACTIONS: Array<{ action: string; icon: string; title: string }> = [
  { action: 'copy', icon: '⧉', title: 'Скопировать' },
  { action: 'insert', icon: '⏎', title: 'Вставить в терминал' },
  { action: 'run', icon: '▶', title: 'Выполнить в терминале' }
]

export function renderMarkdown(md: string): string {
  if (!md) return ''
  const rawHtml = marked.parse(md, { gfm: true, breaks: true, async: false }) as string
  const clean = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel'] })
  return decorateCodeBlocks(clean)
}

function decorateCodeBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pres = doc.querySelectorAll('pre')
  pres.forEach((pre) => {
    const codeEl = pre.querySelector('code')
    const codeText = codeEl?.textContent ?? pre.textContent ?? ''
    const langMatch = /language-(\S+)/.exec(codeEl?.className ?? '')
    const lang = langMatch?.[1] ?? 'text'

    const wrapper = doc.createElement('div')
    wrapper.className = 'zy-md-code'
    wrapper.setAttribute('data-code', encodeURIComponent(codeText))

    const bar = doc.createElement('div')
    bar.className = 'zy-md-code-bar'

    const langSpan = doc.createElement('span')
    langSpan.className = 'zy-md-code-lang'
    langSpan.textContent = lang
    bar.appendChild(langSpan)

    const actions = doc.createElement('span')
    actions.className = 'zy-md-code-actions'
    for (const { action, icon, title } of ACTIONS) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = 'zy-md-code-btn'
      btn.dataset.codeAction = action
      btn.title = title
      btn.textContent = icon
      actions.appendChild(btn)
    }
    bar.appendChild(actions)

    pre.parentNode?.insertBefore(wrapper, pre)
    wrapper.appendChild(bar)
    wrapper.appendChild(pre)
  })
  return doc.body.innerHTML
}

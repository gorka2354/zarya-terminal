import { useEffect, useState } from 'react'
import type { AgentEngine } from '@shared/types'
import { useUiStore } from '@/state/uiStore'
import { t, useLang } from '@/lib/i18n'
import './extrasbar.css'

/**
 * «На диске появились новые скиллы или MCP — подхватить?»
 *
 * Обычный путь после установки MCP-сервера или скилла — сообщение агента
 * «перезапустите сессию», то есть предложение потерять разговор и начать
 * сначала. Перезапуск при этом не нужен: живая сессия умеет перечитать диск
 * (reloadExtras) — но кто-то должен заметить, что на диске появилось новое.
 *
 * Полоса не перечитывает сама. Молча менять состав инструментов у работающего
 * агента — значит менять правила посреди хода: человек одобрял команду, зная
 * один набор, а получил другой. Поэтому здесь предложение и одно нажатие.
 */
export function ExtrasBar({
  engine,
  requestId
}: {
  engine: AgentEngine
  /** Беседа этой панели: перечитать надо ЕЁ, а не соседнюю. */
  requestId?: string
}): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => window.zarya.agent.onExtrasChanged(() => setChanged(true)), [])

  if (!changed) return null

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.zarya.agent.reloadExtras(engine, requestId)
      const ui = useUiStore.getState()
      if (r?.unsupported) {
        // Движок так не умеет — говорим прямо, а не делаем вид, что подхватили.
        ui.toast(t('extras.unsupported'), 'info')
      } else if (r?.ok) {
        ui.toast(
          t('extras.done', {
            commands: r.commands?.length ?? 0,
            mcp: r.mcpServers?.length ?? 0
          }),
          r.errors ? 'error' : 'success'
        )
      } else {
        // Живой сессии нет — перечитывать нечего, следующая и так стартует со
        // свежим диском. Это не ошибка, но и не успех.
        ui.toast(t('extras.nothing'), 'info')
      }
    } finally {
      setBusy(false)
      setChanged(false)
    }
  }

  return (
    <div className="zy-extras" data-extras-bar>
      <span className="zy-extras-text">{t('extras.found')}</span>
      <button type="button" className="zy-extras-go" disabled={busy} onClick={() => void pick()}>
        {busy ? t('extras.working') : t('extras.pick')}
      </button>
      <button
        type="button"
        className="zy-extras-x"
        title={t('extras.dismiss')}
        onClick={() => setChanged(false)}
      >
        ✕
      </button>
    </div>
  )
}

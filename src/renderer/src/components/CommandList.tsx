import { useEffect, useRef } from 'react'
import type { AgentCommand } from '@shared/agentCommands'
import { t, useLang } from '@/lib/i18n'
import './commandlist.css'

/**
 * Команды движка — список, который вырастает НАД строкой ввода.
 *
 * Почему не отдельное окно и не палитра приложения: это продолжение набора, а
 * не выход из него. Человек печатает «/rev», список сужается, Enter подставляет
 * — строка всё время остаётся на месте и остаётся полем. Тем же языком говорит
 * виджет вопросов агента (ClaudeQuestionBar): та же рамка, тот же подвал с
 * подсказкой клавиш — чтобы это читалось как один орган интерфейса, а не как
 * второй, живущий по своим правилам.
 *
 * Клавиши обрабатывает СТРОКА (AgentBar), а не этот компонент: иначе пришлось
 * бы отбирать фокус у поля, и набор прерывался бы на каждом нажатии.
 */
export function CommandList({
  commands,
  cursor,
  source,
  loading,
  onPick,
  onHover
}: {
  commands: AgentCommand[]
  cursor: number
  /** Откуда список: «engine» — движок назвал сам, «unknown» — не назвал. */
  source: 'engine' | 'unknown'
  /** Список ещё спрашивают у движка — это не то же самое, что «команд нет». */
  loading: boolean
  onPick: (cmd: AgentCommand) => void
  onHover: (index: number) => void
}): React.JSX.Element {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const listRef = useRef<HTMLDivElement>(null)

  // Выбранная строка всегда на виду: список длинный (у Claude Code за сотню
  // команд), и стрелка, уводящая курсор за край, превратила бы выбор в игру
  // вслепую.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const active = commands[cursor]

  return (
    <div className="zy-cmdlist" data-command-list>
      <div className="zy-cmdlist-head">
        <span className="zy-cmdlist-title">{t('cmd.title')}</span>
        {/* Шапка называет источник. «Движок команд не назвал» и «команд нет» —
            разные вещи, и пустой список без этой подписи человек прочитает как
            вторую, хотя правда первая. */}
        <span className="zy-cmdlist-source">
          {loading
            ? t('cmd.loading')
            : source === 'engine'
              ? t('cmd.fromEngine', { n: commands.length })
              : t('cmd.unknownSource')}
        </span>
      </div>

      {commands.length === 0 ? (
        <div className="zy-cmdlist-empty">
          {loading ? t('cmd.loading') : source === 'engine' ? t('cmd.noMatch') : t('cmd.noList')}
        </div>
      ) : (
        <div className="zy-cmdlist-body">
          <div className="zy-cmdlist-items" ref={listRef}>
            {commands.map((c, i) => (
              <button
                key={c.name}
                type="button"
                data-idx={i}
                className={`zy-cmdlist-item${i === cursor ? ' zy-cmdlist-item--on' : ''}`}
                // mousedown, а не click: клик уводит фокус из поля, и строка
                // успевает закрыть список раньше, чем выбор доедет.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(c)
                }}
                onMouseEnter={() => onHover(i)}
              >
                <span className="zy-cmdlist-name">/{c.name}</span>
                {c.argumentHint && <span className="zy-cmdlist-args">{c.argumentHint}</span>}
                <span className="zy-cmdlist-desc">{c.description}</span>
              </button>
            ))}
          </div>
          {active && (
            <div className="zy-cmdlist-preview">
              <div className="zy-cmdlist-preview-name">/{active.name}</div>
              {active.argumentHint && (
                <div className="zy-cmdlist-preview-args">{active.argumentHint}</div>
              )}
              <div className="zy-cmdlist-preview-desc">{active.description || t('cmd.noDesc')}</div>
              {!!active.aliases?.length && (
                <div className="zy-cmdlist-preview-alias">
                  {t('cmd.aliases', { list: active.aliases.map((a) => `/${a}`).join(' · ') })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="zy-cmdlist-foot">{t('cmd.keys')}</div>
    </div>
  )
}

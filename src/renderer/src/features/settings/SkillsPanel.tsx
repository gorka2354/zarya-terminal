import { useState } from 'react'
import type { AgentEngine, McpSkills, SkillRow, SkillState } from '@shared/types'
import { t } from '@/lib/i18n'
import { SKILL_STATES, isPluginSkill, pluginDisableCommand, pluginOf, sourceLabel } from '@shared/skills'

/**
 * Скиллы панели: во сколько обходятся и чем управляются.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. Скилл платный всегда, а не только когда сработал: его имя и
 * описание лежат в контексте КАЖДОГО запроса, иначе агент не знал бы, что скилл
 * существует. Полсотни скиллов — это тысячи токенов в каждом обращении, за
 * которые человек платит, ни разу их не увидев. Движок считает это поимённо —
 * и до сих пор никто не показывал.
 *
 * ПОЧЕМУ ЧЕТЫРЕ СОСТОЯНИЯ, А НЕ ГАЛОЧКА. Их четыре у самого Claude Code, и
 * средние два — самое ценное здесь: «только имя» оставляет скилл рабочим за
 * малую часть цены, «только по „/“» убирает его из контекста, не отнимая
 * возможность позвать руками. Свести это к «вкл/выкл» значило бы спрятать
 * единственные два выхода, которые ничего не ломают.
 */
export function SkillsPanel({
  engine,
  requestId,
  skills,
  stale,
  busy,
  used,
  onNote,
  onChanged
}: {
  engine: AgentEngine
  requestId: string
  skills: McpSkills
  stale: boolean
  busy: boolean
  /** Скиллы, которые агент реально взял в этой беседе. */
  used: string[]
  onNote: (text: string, bad?: boolean) => void
  onChanged: () => void
}): React.JSX.Element {
  // Список отсортирован по цене, поэтому первые строки — самые дорогие: то, ради
  // чего сюда пришли, видно без раскрытия. У человека их бывает под сотню.
  const FIRST = 12
  const [all, setAll] = useState(false)
  // Сработавшие — наверх, поверх сортировки по цене: их трогать нельзя, а
  // остальное и есть предмет разговора. Иначе рабочий скилл терялся бы на
  // восьмидесятой строке ровно тогда, когда человек решает, что выключить.
  const ranked = used.length
    ? [...skills.items].sort(
        (a, b) => Number(used.includes(b.name)) - Number(used.includes(a.name))
      )
    : skills.items
  const items = all ? ranked : ranked.slice(0, FIRST)
  const hidden = ranked.length - items.length
  // Плагины — по всему списку, а не по видимой части: строка внизу отвечает за
  // весь раздел, и сворачивание не должно менять её состав.
  const plugins = [
    ...new Set(
      skills.items.filter((s) => isPluginSkill(s.source)).map((s) => pluginOf(s.name) ?? '')
    )
  ]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en'))

  const set = async (row: SkillRow, state: SkillState): Promise<void> => {
    const r = await window.zarya.agent.skillOverride(engine, requestId, row.name, state)
    if (r.ok) {
      onNote(t('skills.applies'))
      onChanged()
    } else if (r.reason === 'overridden') {
      onNote(t('skills.fromLayer', { where: t(`skills.layer.${r.by ?? 'project'}`) }), true)
    } else {
      onNote(r.error || t('tools.failedPlain'), true)
    }
  }

  return (
    <div className="zy-skills">
      <div className="zy-skills-head">
        <span className="zy-skills-title">{t('skills.title')}</span>
        <span className="zy-skills-total">
          {t('skills.total', {
            n: skills.total,
            tok: skills.tokens.toLocaleString('en-US').replace(/,/g, ' ')
          })}
        </span>
      </div>
      {/*
        «Вошло не всё» — не мелочь: цена внизу считается по вошедшим, и без этой
        строки итог выглядел бы как полный.
      */}
      {skills.included < skills.total && (
        <div className="zy-skills-sub">
          {t('skills.someHidden', { n: skills.included, total: skills.total })}
        </div>
      )}
      {/*
        Что из оплаченного пошло в дело. Пустой список — не ошибка и не упрёк:
        это и есть ответ на вопрос «за что я плачу», и он честнее умолчания.
      */}
      <div className="zy-skills-sub">
        {used.length
          ? t('skills.usedSome', { n: used.length, total: skills.total })
          : t('skills.usedNone')}
      </div>

      <div className="zy-skills-list">
        {items.map((s) => {
          const plugin = isPluginSkill(s.source)
          // Перекрыт настройкой проекта — переключателя нет: запись в личные
          // настройки прошла бы успешно и не изменила ничего. Такая кнопка врёт.
          const lockedBy = s.from && s.from !== 'user' ? s.from : undefined
          return (
            <div key={s.name} className={`zy-skills-row zy-skills-row--${s.state}`}>
              <div className="zy-skills-row-main">
                <span className="zy-skills-name">{s.name}</span>
                {used.includes(s.name) && (
                  <span className="zy-skills-used">{t('skills.used')}</span>
                )}
                <span className="zy-skills-src">{s.source ? sourceLabel(s.source) : '—'}</span>
                <span className="zy-skills-price">
                  {s.tokens > 0
                    ? t('tools.tokens', { n: s.tokens.toLocaleString('en-US').replace(/,/g, ' ') })
                    : t('skills.noPrice')}
                </span>
                {plugin || lockedBy || stale ? (
                  <span className="zy-skills-state">{t(`skills.state.${s.state}`)}</span>
                ) : (
                  <select
                    className="zy-select zy-skills-select"
                    value={s.state}
                    disabled={busy}
                    // Что значит состояние — по наведению. Под строкой оно
                    // печатается только у необычных: у восьмидесяти скиллов
                    // подряд одна и та же фраза «берёт сам» — это не объяснение,
                    // а стена текста, из-за которой не видно самих скиллов.
                    title={t(`skills.hint.${s.state}`)}
                    onChange={(e) => void set(s, e.target.value as SkillState)}
                  >
                    {SKILL_STATES.map((st) => (
                      <option key={st} value={st}>
                        {t(`skills.state.${st}`)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {/* Строка объяснения — только когда есть что объяснять. */}
              {(lockedBy || plugin || s.state !== 'on') && (
                <div className="zy-skills-why">
                  {lockedBy
                    ? t('skills.fromLayer', { where: t(`skills.layer.${lockedBy}`) })
                    : plugin
                      ? t('skills.plugin')
                      : t(`skills.hint.${s.state}`)}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {(hidden > 0 || all) && (
        <button type="button" className="zy-skills-more" onClick={() => setAll(!all)}>
          {all ? t('skills.less') : t('skills.more', { n: skills.items.length })}
        </button>
      )}

      {/*
        Плагины — одной строкой на весь список, а не под каждой строкой.
        Плагин у человека один на десяток скиллов, и та же команда, повторённая
        десять раз подряд, перестаёт читаться: остаётся стена, из-за которой не
        видно самих скиллов. Кнопка тут по-прежнему нужна — `skillOverrides`
        плагинных скиллов не берёт, и без команды раздел просто отказал бы.
      */}
      {plugins.length > 0 && (
        <div className="zy-skills-plugins">
          <span className="zy-skills-plugins-text">{t('skills.pluginsFoot')}</span>
          {plugins.map((p) => (
            <button
              key={p}
              type="button"
              className="zy-tools-btn zy-skills-plugin-btn"
              title={pluginDisableCommand(p)}
              onClick={() => {
                void navigator.clipboard.writeText(pluginDisableCommand(p))
                onNote(t('tools.copied'))
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      <div className="zy-tools-foot">{t('skills.writesConfig')}</div>
    </div>
  )
}

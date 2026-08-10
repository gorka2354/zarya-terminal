import React, { useEffect, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { useLang } from '@/lib/i18n'
import { useAiStore, isConversationBusy, type Conversation } from '@/features/ai/aiStore'
import { describeRule } from '@shared/allowRules'

/**
 * ЧТО РАЗРЕШЕНО ЭТОЙ ПАНЕЛИ — на одном экране.
 *
 * Выдать разрешение можно было только на гейте, в тот единственный миг, когда
 * карточка ждёт ответа. Посмотреть, что уже роздано, и забрать обратно — негде.
 * То есть согласие давалось навсегда (до конца беседы) и в спешке, а отменить
 * его было нельзя: обычная дорога в «нажму, чтоб отстало».
 *
 * Здесь три вещи, и все три — про доступ, а не про удобство:
 *   1) ступень допуска и то, чего она НЕ покрывает;
 *   2) правила «до конца беседы» — дословно, с кнопкой отзыва;
 *   3) папки, в которые агент вправе заходить.
 *
 * Панель принадлежит БЕСЕДЕ, а не приложению: у соседней панели свой агент,
 * своя папка и своё согласие, и общий экран настроек врал бы о трёх из четырёх.
 */
export function PermissionsPanel({
  conv,
  onClose,
  anchor
}: {
  conv: Conversation
  onClose: () => void
  /**
   * Кнопка, которой панель открывают: нажатие по ней не считается «щелчком
   * снаружи». Иначе повторное нажатие закрывало бы панель и тут же открывало
   * заново — со стороны это выглядит как мигание.
   */
  anchor?: HTMLElement | null
}): React.JSX.Element {
  useLang()
  const ref = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<string>('')
  const [busyDir, setBusyDir] = useState(false)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (anchor?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Отложенно: щелчок, который открыл панель, ещё летит.
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchor])

  const store = useAiStore.getState()
  const rules = conv.sessionAllows ?? []
  const dirs = conv.extraDirs ?? []
  const busy = isConversationBusy(conv)
  const stage = conv.planMode
    ? 'plan'
    : conv.bypass
      ? 'auto'
      : conv.editsAuto
        ? 'edits'
        : 'ask'

  const addDir = async (): Promise<void> => {
    setBusyDir(true)
    try {
      const res = await store.addWorkDir(conv.id)
      // Каждый исход называется словами. Молчащая кнопка — это кнопка, про
      // которую человек решит, что доступ выдан.
      setNote(
        res.ok
          ? t('perm.dirAdded')
          : res.reason === 'busy'
            ? t('perm.dirBusy')
            : res.reason === 'already'
              ? t('perm.dirAlready')
              : res.reason === 'no-engine'
                ? t('perm.dirNoEngine')
                : ''
      )
    } finally {
      setBusyDir(false)
    }
  }

  return (
    <div className="zy-perm-panel" ref={ref} role="dialog" aria-label={t('perm.title')}>
      <div className="zy-perm-head">
        <span>{t('perm.title')}</span>
        <span className="zy-perm-sub">{t(`perm.stage.${stage}`)}</span>
      </div>

      {/*
        Чего ступень НЕ покрывает. Безобидные команды (`echo`, `ls`) движок
        разрешает сам и до Зари они не доходят вовсе — гейта на них не будет ни
        в каком режиме. Человек, включивший «спрашивать всё», вправе знать, что
        часть команд проходит мимо него: обещание «спросят про каждую» здесь
        было бы неправдой.
      */}
      <div className="zy-perm-note">{t('perm.engineAllows')}</div>

      <div className="zy-perm-section">
        <div className="zy-perm-label">{t('perm.rules')}</div>
        {rules.length === 0 ? (
          <div className="zy-perm-empty">{t('perm.rulesEmpty')}</div>
        ) : (
          <ul className="zy-perm-list">
            {rules.map((rule) => {
              const parts = describeRule(rule)
              return (
                <li key={rule} className="zy-perm-item">
                  <span className="zy-perm-tool">{parts.tool}</span>
                  {/* Команда — дословно и целиком: правило, показанное с
                      многоточием, отзывают вслепую. */}
                  {parts.command && <code className="zy-perm-cmd">{parts.command}</code>}
                  <button
                    className="zy-perm-revoke"
                    title={t('perm.revokeHint')}
                    onClick={() => store.revokeSessionRule(conv.id, rule)}
                  >
                    {t('perm.revoke')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="zy-perm-section">
        <div className="zy-perm-label">{t('perm.dirs')}</div>
        {/*
          ЧТО ЭТОТ СПИСОК НА САМОМ ДЕЛЕ ДЕЛАЕТ.

          «Добавить папку» звучит как «дать доступ», а даёт другое. Проверено
          зондами к SDK: работать за пределами рабочей папки агент может и без
          этого — каждый раз через гейт Зари. Папка в списке становится СВОЕЙ, и
          движок перестаёт спрашивать про чтение внутри неё вовсе.

          То есть это ослабление вопроса, а не расширение прав. Кнопка, молча
          выдающая себя за первое, — ровно тот случай, когда человек думает, что
          открыл дверь, а на самом деле выключил замок.
        */}
        <div className="zy-perm-note">{t('perm.dirsWhat')}</div>
        <ul className="zy-perm-list">
          {/* Рабочая папка — тоже доступ, и она в том же списке. Отзыву не
              подлежит: без неё беседе негде работать. */}
          <li className="zy-perm-item">
            <code className="zy-perm-dir">{conv.cwd || t('perm.noCwd')}</code>
            <span className="zy-perm-base">{t('perm.dirBase')}</span>
          </li>
          {dirs.map((dir) => (
            <li key={dir} className="zy-perm-item">
              <code className="zy-perm-dir">{dir}</code>
              <button
                className="zy-perm-revoke"
                title={t('perm.dirRemoveHint')}
                onClick={() => void store.removeWorkDir(conv.id, dir)}
              >
                {t('perm.revoke')}
              </button>
            </li>
          ))}
        </ul>
        {/* Без иконки: соседняя кнопка в этом же списке («отозвать») тоже без
            неё, а плюс рядом с пиксельной подписью перевешивал её и читался как
            главное на кнопке. Две кнопки одного списка должны выглядеть как две
            кнопки одного списка. */}
        <button className="zy-perm-add" disabled={busy || busyDir} onClick={() => void addDir()}>
          {t('perm.dirAdd')}
        </button>
        {/* Пока идёт ход, кнопка выключена — и сказано, почему. Выключенная
            кнопка без объяснения читается как поломка. */}
        {busy && <span className="zy-perm-hint">{t('perm.dirBusy')}</span>}
      </div>

      {note && <div className="zy-perm-note zy-perm-note--said">{note}</div>}
    </div>
  )
}

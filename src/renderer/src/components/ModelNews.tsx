import { t, useLang } from '@/lib/i18n'
import { useUiStore } from '@/state/uiStore'
import { Icon } from './Icon'
import './modelnews.css'

/**
 * «Появилась новая модель».
 *
 * Модели выходят чаще, чем человек открывает список: Opus 5 вышел, а Заря
 * молча продолжала предлагать вчерашнее. Окно маленькое и разовое — сообщить
 * факт и уйти, а не требовать решения.
 *
 * Кнопка ведёт в пусковой комплекс, потому что единственное осмысленное
 * действие после такой новости — посмотреть и, если надо, переключиться.
 */
export function ModelNews(): React.JSX.Element | null {
  // Подписка на язык: без неё надписи этого компонента сменились бы не в
  // момент переключения, а при следующей перерисовке по другой причине.
  useLang()

  const news = useUiStore((s) => s.modelNews)
  if (!news) return null

  const close = (): void => useUiStore.getState().set({ modelNews: null })
  const openLaunchPad = (): void => {
    useUiStore.getState().set({ modelNews: null, launchPadOpen: true })
  }

  return (
    <div className="zy-modelnews" role="status" data-model-news>
      <span className="zy-modelnews-mark">
        <Icon name="sputnik" size={15} strokeWidth={1.5} />
      </span>
      <div className="zy-modelnews-body">
        <div className="zy-modelnews-title">
          {t(news.names.length > 1 ? 'news.modelsTitle' : 'news.modelTitle')}
        </div>
        <div className="zy-modelnews-names">{news.names.join(' · ')}</div>
      </div>
      <button type="button" className="zy-modelnews-go" onClick={openLaunchPad}>
        {t('news.open')}
      </button>
      <button
        type="button"
        className="zy-icon-btn zy-modelnews-x"
        title={t('common.close')}
        onClick={close}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

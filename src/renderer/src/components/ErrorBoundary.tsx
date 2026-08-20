import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '@/lib/i18n'

/**
 * Последняя черта: ошибка отрисовки больше не уносит окно в пустоту.
 *
 * ПОВОД, И ОН НЕ ГИПОТЕТИЧЕСКИЙ. Сторож мёртвых нажатий (inc-48) нашёл
 * действие «Панель блоков», которое роняло React ошибкой #185: дерево
 * снималось целиком, окно становилось ПУСТЫМ, и вернуть его можно было только
 * перезапуском. Ни строки на экране, ни следа в журнале — человек видел белый
 * прямоугольник и не мог даже сказать, что произошло.
 *
 * ЧТО ЭТО НЕ ЕСТЬ. Не починка ошибок и не «приложение продолжит работать как
 * ни в чём не бывало»: после срыва отрисовки состояние ненадёжно, и делать вид,
 * что всё в порядке, значило бы соврать. Здесь — честная остановка: что
 * случилось, куда это записано и две кнопки, обе из которых человек понимает.
 *
 * ПОЧЕМУ КЛАСС. React ловит ошибки отрисовки только через componentDidCatch —
 * хуками этого не сделать. Единственный классовый компонент в проекте, и он
 * здесь по необходимости, а не по стилю.
 */
interface State {
  error?: Error
  info?: string
  /** Только для прогона: следующий кадр обязан сорваться (см. componentDidMount). */
  boom?: boolean
}

/**
 * Пробник для прогона: срывается при отрисовке — как настоящий дефект.
 *
 * Отдельным компонентом, потому что боундари НЕ ловит ошибку из собственной
 * отрисовки: React ищет ближайшую границу ВЫШЕ по дереву, и уронив себя, она
 * унесла бы окно в ту самую пустоту, от которой заведена. Первый вариант этого
 * пробника так и сделал — прогон показал пустой экран и был прав.
 */
function CrashProbe({ boom }: { boom?: boolean }): null {
  if (boom) throw new Error('прогон: срыв отрисовки')
  return null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {}

  componentDidMount(): void {
    /*
     * ПРОГОНУ: уронить отрисовку по-настоящему.
     *
     * Проверять этот экран, подсовывая ошибку мимо React, значило бы проверять
     * не его: боундари ловит ровно срыв ОТРИСОВКИ. Хук поднимает флаг и просит
     * перерисовку — дальше падает `render` ниже, тем же путём, каким падал
     * настоящий дефект «Панели блоков».
     */
    ;(window as unknown as { __zaryaCrashRender?: () => void }).__zaryaCrashRender = () =>
      this.setState({ boom: true })
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * ПИШЕМ В ЖУРНАЛ СРАЗУ. Экран человек закроет или перезапустит, а разбирать
     * причину будем потом — и по памяти это делать нечем. Стек компонентов
     * важнее стека вызовов: он называет, какой кусок интерфейса сорвался.
     */
    const where = (info.componentStack ?? '').split('\n').slice(0, 12).join('\n')
    this.setState({ info: where })
    void window.zarya.app.logError?.(
      [`renderer: ${error.name}: ${error.message}`, error.stack ?? '', where]
        .filter(Boolean)
        .join('\n')
    )
  }

  private details(): string {
    const e = this.state.error
    return [
      `${e?.name ?? 'Error'}: ${e?.message ?? ''}`,
      e?.stack ?? '',
      this.state.info ?? ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  render(): ReactNode {
    if (!this.state.error) {
      return (
        <>
          {this.props.children}
          <CrashProbe boom={this.state.boom} />
        </>
      )
    }
    return (
      <div className="zy-crash">
        <div className="zy-crash-box">
          <div className="zy-crash-title">{t('crash.title')}</div>
          {/*
            Текст ошибки — дословно, без нашего пересказа. «Что-то пошло не так»
            не даёт человеку ничего: ни понять, ни рассказать, ни найти.
          */}
          <div className="zy-crash-what">{`${this.state.error.name}: ${this.state.error.message}`}</div>
          <div className="zy-crash-hint">{t('crash.hint')}</div>
          <div className="zy-crash-actions">
            <button
              type="button"
              className="zy-btn zy-btn--accent"
              onClick={() => window.location.reload()}
            >
              {t('crash.reload')}
            </button>
            <button
              type="button"
              className="zy-btn"
              onClick={() => void navigator.clipboard.writeText(this.details())}
            >
              {t('crash.copy')}
            </button>
            <button
              type="button"
              className="zy-btn"
              onClick={() => void window.zarya.app.showLog?.()}
            >
              {t('crash.log')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

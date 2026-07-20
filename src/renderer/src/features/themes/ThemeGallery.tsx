import { useSettingsStore } from '@/state/settingsStore'
import { getThemes } from './themes'
import './themes.css'
import './themePack'
import type { ThemeDef } from '@shared/types'

/** ANSI colors sampled from each theme's terminal palette for the preview dots. */
function previewDots(t: ThemeDef): string[] {
  return [t.terminal.red, t.terminal.green, t.terminal.yellow, t.terminal.blue, t.terminal.magenta]
}

/** Gallery of every registered theme as a clickable preview card. No props — reads/writes global settings directly. */
export default function ThemeGallery(): React.JSX.Element {
  const themeId = useSettingsStore((s) => s.settings.appearance.themeId)
  const themes = getThemes()

  const select = (id: string): void => {
    void useSettingsStore.getState().update({ appearance: { themeId: id } as never })
  }

  return (
    <div className="zy-theme-gallery">
      {themes.map((t) => {
        const active = t.id === themeId
        return (
          <button
            key={t.id}
            type="button"
            className={`zy-theme-card${active ? ' zy-theme-card--active' : ''}`}
            onClick={() => select(t.id)}
            title={t.name}
          >
            <div
              className="zy-theme-preview"
              style={{ background: t.ui.bg, borderColor: t.ui.border }}
            >
              <div className="zy-theme-preview-accent" style={{ background: t.ui.accentGradient }} />
              <div className="zy-theme-preview-dots">
                {previewDots(t).map((c, i) => (
                  <span key={i} className="zy-theme-preview-dot" style={{ background: c }} />
                ))}
              </div>
              <div
                className="zy-theme-preview-code"
                style={{ color: t.terminal.foreground }}
              >
                <span style={{ color: t.ui.accent }}>❯</span> zarya --theme
              </div>
            </div>
            <div className="zy-theme-card-foot">
              <span className="zy-theme-card-name">{t.name}</span>
              <span className={`zy-badge ${t.type === 'dark' ? '' : 'zy-badge--accent'}`}>
                {t.type === 'dark' ? 'тёмная' : 'светлая'}
              </span>
            </div>
            {active && <span className="zy-theme-card-check">✓ активна</span>}
          </button>
        )
      })}
    </div>
  )
}

import { useUiStore } from '@/state/uiStore'

export function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  return (
    <div className="zy-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`zy-toast zy-toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

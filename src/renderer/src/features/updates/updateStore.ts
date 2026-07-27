import { create } from 'zustand'
import type { UpdateState } from '@shared/updates'

/**
 * Состояние проверки обновлений в окне.
 *
 * Считать его умеет только main: сеть, таймаут и разбор ответа — там. Здесь
 * лежит копия для отрисовки и ничего больше, никакой своей логики о версиях.
 */
interface UpdateStore {
  state: UpdateState | null
  init: () => void
  check: () => Promise<void>
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  state: null,

  init: () => {
    void window.zarya.updates.state().then((s) => set({ state: s }))
    window.zarya.updates.onChange((s) => set({ state: s }))
  },

  check: async () => {
    const s = await window.zarya.updates.check()
    set({ state: s })
  }
}))

/** Есть ли что показать в индикаторе. */
export function hasUpdate(s: UpdateState | null): boolean {
  return !!s?.updateAvailable && !!s.latest
}

// QA-хук: подставить состояние без похода в сеть. Нужен, чтобы проверять
// отрисовку и — главное — что страница строит адреса САМА, даже если ей
// подсунули релиз с враждебным тегом или именем файла. Открывать ради этого
// подменяемый адрес проверки в main было бы лечением хуже болезни.
;(window as unknown as { __zaryaSetUpdate?: (s: UpdateState) => void }).__zaryaSetUpdate = (s) =>
  useUpdateStore.setState({ state: s })

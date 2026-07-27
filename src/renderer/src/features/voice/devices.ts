/**
 * Выбор микрофона.
 *
 * Устройств у человека обычно несколько — гарнитура, вебкамера, встроенный
 * микрофон ноутбука, — и до сих пор диктовка молча брала системное. Отсюда две
 * задачи: дать выбрать и не соврать про то, что в итоге слушают.
 *
 * Про идентификаторы. Chromium отдаёт не «сырой» id устройства, а хэш,
 * посоленный для каждого origin; соль живёт в профиле. Замерено: id одного и
 * того же микрофона совпадает между запусками приложения на общем профиле и
 * различается на разных профилях. Причины смены id бывают и другие
 * (переустановка драйвера — правдоподобно, но не проверялось), и точная причина
 * не важна: один сохранённый id — это тихая поломка, гарнитура на месте, а
 * пишет встроенный микрофон, и понять это неоткуда. Поэтому рядом с id хранится
 * имя, и выбор чинится по имени при ЛЮБОЙ смене id.
 *
 * Про названия. `enumerateDevices()` прячет `label`, пока у страницы нет
 * доступа к микрофону. В Заре на Windows этого не случается: main отвечает
 * `true` на проверку разрешения 'media' (см. setPermissionCheckHandler), и
 * названия видны сразу — замерено, `permissions.query({name:'microphone'})`
 * возвращает 'granted' на чистом профиле ещё до первого getUserMedia. Ветка
 * оставлена для macOS/Linux, где доступ гейтит сама ОС (TCC) поверх решения
 * Electron; там она не проверялась. Пустой список без объяснения читается как
 * «нет устройств», поэтому состояние названо отдельно ({@link labelsHidden}).
 */

export interface MicDevice {
  deviceId: string
  /** Пусто, пока не выдан доступ к микрофону. */
  label: string
  /**
   * Группа физического узла. Хранится для диагностики и НЕ используется как
   * ключ устройства: у гарнитуры с несколькими капсюлями и у док-станции разные
   * микрофоны делят groupId — дедупликация по нему схлопнула бы их в одну
   * строку и увела бы выбор не на то устройство.
   */
  groupId: string
}

/** Что сохранено в настройках. */
export interface SavedMic {
  deviceId: string
  deviceLabel: string
}

/**
 * Какое устройство открывать. Отдельный тип, а не «id или undefined»: разница
 * между «выбрано системное» и «выбранное пропало» видна вызывающему, и он
 * может сказать об этом вслух.
 */
export type MicPick =
  /** Системное устройство: так выбрал пользователь. */
  | { kind: 'default' }
  /** Сохранённый id на месте. */
  | { kind: 'exact'; deviceId: string; label: string }
  /** Id сменился, но устройство с тем же именем есть — чиним молча. */
  | { kind: 'relabelled'; deviceId: string; label: string }
  /** Выбранного устройства нет: пишем в системное и говорим об этом. */
  | { kind: 'missing'; label: string }

/**
 * Псевдо-устройства Windows. `default` и `communications` — это не отдельные
 * микрофоны, а ссылки на текущий системный выбор; в списке они дублируют
 * реальные строки, а роль «как в системе» у нас уже играет пустой id.
 */
const PSEUDO_IDS = new Set(['default', 'communications'])

/** Микрофоны, пригодные для показа: без псевдо-строк и без пустых id. */
export function usableMics(devices: MicDevice[]): MicDevice[] {
  return devices.filter((d) => d.deviceId !== '' && !PSEUDO_IDS.has(d.deviceId))
}

/**
 * Названия скрыты — доступ к микрофону ещё не выдавали. Именно «скрыты», а не
 * «устройств нет»: устройства есть, показывать нечего. На Windows всегда false
 * (см. шапку файла).
 */
export function labelsHidden(devices: MicDevice[]): boolean {
  const list = usableMics(devices)
  return list.length > 0 && list.every((d) => d.label.trim() === '')
}

/** Читаемое имя строки списка: без доступа имени нет — нумеруем. */
export function micName(d: MicDevice, index: number): string {
  const label = d.label.trim()
  return label || `Микрофон ${index + 1}`
}

/**
 * Решение о том, что открывать. Порядок намеренный: сначала точный id, потом
 * имя, и только потом системное — молчаливый откат на встроенный микрофон
 * посреди диктовки хуже, чем секунда на поиск по имени.
 */
export function resolveMic(devices: MicDevice[], saved: SavedMic): MicPick {
  const wantedId = saved.deviceId.trim()
  if (!wantedId) return { kind: 'default' }

  const list = usableMics(devices)
  const byId = list.find((d) => d.deviceId === wantedId)
  if (byId) return { kind: 'exact', deviceId: wantedId, label: byId.label || saved.deviceLabel }

  const wantedLabel = saved.deviceLabel.trim()
  if (wantedLabel) {
    const byLabel = list.filter((d) => d.label.trim() === wantedLabel)
    // Ровно одно совпадение — это то самое устройство. Два одинаковых имени
    // (две одинаковые гарнитуры, два одинаковых монитора с микрофоном) — уже
    // гадание: выбрать «первое» значит с равной вероятностью выбрать не то.
    if (byLabel.length === 1) {
      return { kind: 'relabelled', deviceId: byLabel[0].deviceId, label: wantedLabel }
    }
  }

  // Список без названий (нет доступа) — судить по нему нельзя: устройство может
  // быть на месте. Пробуем сохранённый id как есть, пусть решает getUserMedia.
  if (labelsHidden(devices)) return { kind: 'exact', deviceId: wantedId, label: wantedLabel }

  return { kind: 'missing', label: wantedLabel || 'выбранный микрофон' }
}

/** Id для getUserMedia: у «системного» и «пропавшего» его нет. */
export function pickDeviceId(pick: MicPick): string | undefined {
  return pick.kind === 'exact' || pick.kind === 'relabelled' ? pick.deviceId : undefined
}

/** Список микрофонов у браузера. Пустой, если API недоступен. */
export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }))
}

/**
 * Разово открыть и сразу закрыть микрофон, чтобы Chromium показал названия
 * устройств. Вызывается ТОЛЬКО по явному нажатию: включать микрофон ради
 * списка за спиной пользователя нельзя.
 */
export async function revealMicLabels(): Promise<MicDevice[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  for (const t of stream.getTracks()) t.stop()
  return listMics()
}

/** Подписка на появление/исчезновение устройств — список не должен устаревать. */
export function onDeviceChange(cb: () => void): () => void {
  const md = navigator.mediaDevices
  if (!md?.addEventListener) return () => {}
  md.addEventListener('devicechange', cb)
  return () => md.removeEventListener('devicechange', cb)
}

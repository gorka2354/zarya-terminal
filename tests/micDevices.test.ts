import { describe, expect, it } from 'vitest'
import {
  labelsHidden,
  micName,
  pickDeviceId,
  resolveMic,
  usableMics,
  type MicDevice
} from '@/features/voice/devices'

/**
 * Выбор микрофона обязан отвечать на один вопрос честно: в какое устройство
 * сейчас пишут. Тихий откат на встроенный микрофон ноутбука — худший исход:
 * человек говорит в гарнитуру, расшифровка выходит мусорной, и понять почему
 * неоткуда.
 */
const dev = (over: Partial<MicDevice> = {}): MicDevice => ({
  deviceId: 'id-headset',
  label: 'Гарнитура Jabra',
  groupId: 'g1',
  ...over
})

describe('usableMics', () => {
  it('убирает псевдо-устройства Windows', () => {
    // 'default' и 'communications' — это ссылки на системный выбор, а не
    // отдельные микрофоны: в списке они дублируют реальные строки.
    const list = usableMics([
      dev({ deviceId: 'default', label: 'По умолчанию — Гарнитура Jabra' }),
      dev({ deviceId: 'communications', label: 'Связь — Гарнитура Jabra' }),
      dev({ deviceId: 'id-headset' })
    ])
    expect(list.map((d) => d.deviceId)).toEqual(['id-headset'])
  })

  it('убирает строки с пустым id', () => {
    expect(usableMics([dev({ deviceId: '' })])).toEqual([])
  })
})

describe('labelsHidden', () => {
  it('устройства есть, названий нет — это «скрыты», а не «пусто»', () => {
    expect(labelsHidden([dev({ label: '' }), dev({ deviceId: 'id-2', label: '' })])).toBe(true)
  })

  it('хотя бы одно название есть — доступ выдан', () => {
    expect(labelsHidden([dev({ label: '' }), dev({ deviceId: 'id-2', label: 'Вебкамера' })])).toBe(
      false
    )
  })

  it('устройств нет вовсе — прятать нечего', () => {
    expect(labelsHidden([])).toBe(false)
  })

  it('псевдо-устройства не считаются за названия', () => {
    expect(labelsHidden([dev({ deviceId: 'default', label: 'Default' }), dev({ label: '' })])).toBe(
      true
    )
  })
})

describe('micName', () => {
  it('без доступа имени нет — нумеруем, а не показываем пустую строку', () => {
    expect(micName(dev({ label: '' }), 0)).toBe('Микрофон 1')
    expect(micName(dev({ label: '   ' }), 2)).toBe('Микрофон 3')
  })

  it('название есть — показываем его', () => {
    expect(micName(dev(), 0)).toBe('Гарнитура Jabra')
  })
})

describe('resolveMic', () => {
  const headset = dev()
  const builtin = dev({ deviceId: 'id-builtin', label: 'Встроенный микрофон', groupId: 'g2' })

  it('пустой id = системное устройство', () => {
    expect(resolveMic([headset, builtin], { deviceId: '', deviceLabel: '' })).toEqual({
      kind: 'default'
    })
  })

  it('сохранённый id на месте — берём его', () => {
    const pick = resolveMic([headset, builtin], {
      deviceId: 'id-headset',
      deviceLabel: 'Гарнитура Jabra'
    })
    expect(pick).toMatchObject({ kind: 'exact', deviceId: 'id-headset' })
    expect(pickDeviceId(pick)).toBe('id-headset')
  })

  it('id сменился, устройство с тем же именем есть — чиним молча', () => {
    // Chromium солит deviceId; после переустановки драйвера id другой, а
    // гарнитура та же. Молча переключиться на встроенный микрофон нельзя.
    const renamed = dev({ deviceId: 'id-headset-NEW' })
    const pick = resolveMic([renamed, builtin], {
      deviceId: 'id-headset',
      deviceLabel: 'Гарнитура Jabra'
    })
    expect(pick).toEqual({
      kind: 'relabelled',
      deviceId: 'id-headset-NEW',
      label: 'Гарнитура Jabra'
    })
    expect(pickDeviceId(pick)).toBe('id-headset-NEW')
  })

  it('два устройства с одинаковым именем — не гадаем', () => {
    // Две одинаковые гарнитуры: «первое совпадение» с равной вероятностью
    // окажется не тем. Честнее откатиться на системное и сказать об этом.
    const a = dev({ deviceId: 'id-a' })
    const b = dev({ deviceId: 'id-b' })
    const pick = resolveMic([a, b], { deviceId: 'id-старый', deviceLabel: 'Гарнитура Jabra' })
    expect(pick.kind).toBe('missing')
  })

  it('устройства нет ни по id, ни по имени — системное + сказать вслух', () => {
    const pick = resolveMic([builtin], { deviceId: 'id-headset', deviceLabel: 'Гарнитура Jabra' })
    expect(pick).toEqual({ kind: 'missing', label: 'Гарнитура Jabra' })
    // Именно undefined: getUserMedia должен взять системное устройство.
    expect(pickDeviceId(pick)).toBeUndefined()
  })

  it('без доступа (названий нет) не объявляет устройство пропавшим', () => {
    // Судить по списку без названий нельзя: гарнитура может быть на месте.
    // Пробуем сохранённый id, дальше решает getUserMedia.
    const blind = [dev({ deviceId: 'id-headset', label: '' }), dev({ deviceId: 'id-x', label: '' })]
    const pick = resolveMic(blind, { deviceId: 'id-gone', deviceLabel: 'Гарнитура Jabra' })
    expect(pick).toMatchObject({ kind: 'exact', deviceId: 'id-gone' })
  })

  it('имя не сохранено и id пропал — всё равно не молчим', () => {
    const pick = resolveMic([builtin], { deviceId: 'id-gone', deviceLabel: '' })
    expect(pick.kind).toBe('missing')
  })

  it('псевдо-устройство не годится в качестве совпадения', () => {
    // 'default' носит имя текущего системного микрофона; совпадение по имени с
    // ним вернуло бы «системный» под видом выбранного устройства.
    const list = [dev({ deviceId: 'default', label: 'Гарнитура Jabra' }), builtin]
    const pick = resolveMic(list, { deviceId: 'id-headset', deviceLabel: 'Гарнитура Jabra' })
    expect(pick.kind).toBe('missing')
  })

  it('id с пробелами считается пустым — это системное', () => {
    expect(resolveMic([headset], { deviceId: '   ', deviceLabel: '' }).kind).toBe('default')
  })
})

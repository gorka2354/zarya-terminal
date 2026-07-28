import { describe, expect, it } from 'vitest'
import { staleUpdaterFiles, versionFromFileName } from '@shared/updates'

/**
 * electron-updater не убирает за собой: после установки в его кеше остаются ДВЕ
 * копии установщика. На нашей сборке это 365 МБ — и так после каждого
 * обновления. Замерено на живой машине после обновления 0.5.5 → 0.5.6.
 *
 * Но чистить можно только заведомо ненужное: если человек скачал обновление и
 * ещё не нажал «перезапустить», снос файла заставит качать 190 МБ заново.
 */
const CACHE_AFTER_UPDATE = [
  'current.blockmap',
  'installer.exe',
  'update-info.json',
  'Zarya-Setup-0.5.6-win-x64.exe'
]

describe('versionFromFileName', () => {
  it('достаёт версию из имени сборки', () => {
    expect(versionFromFileName('Zarya-Setup-0.5.6-win-x64.exe')).toBe('0.5.6')
    expect(versionFromFileName('Zarya-Portable-0.5.10-win-x64.exe')).toBe('0.5.10')
    expect(versionFromFileName('Zarya-0.5.6-arm64.dmg')).toBe('0.5.6')
    expect(versionFromFileName('zarya-terminal_0.5.6_amd64.deb')).toBe('0.5.6')
  })

  it('без версии в имени — null, а не выдумка', () => {
    // installer.exe — копия, которую делает сам обновлятор; версии в имени нет.
    expect(versionFromFileName('installer.exe')).toBeNull()
    expect(versionFromFileName('update-info.json')).toBeNull()
  })
})

describe('staleUpdaterFiles', () => {
  it('после установки убирает обе тяжёлые копии', () => {
    const stale = staleUpdaterFiles(CACHE_AFTER_UPDATE, '0.5.6')
    expect(stale.sort()).toEqual(['Zarya-Setup-0.5.6-win-x64.exe', 'installer.exe'])
  })

  it('мелочь не трогает — .blockmap ускоряет следующее скачивание', () => {
    const stale = staleUpdaterFiles(CACHE_AFTER_UPDATE, '0.5.6')
    expect(stale).not.toContain('current.blockmap')
    expect(stale).not.toContain('update-info.json')
  })

  it('СКАЧАННОЕ, НО НЕ ПОСТАВЛЕННОЕ обновление не трогает вовсе', () => {
    // Человек нажал «Установить», файл скачан, но перезапуск ещё не сделан.
    // Снести его — значит заставить качать 190 МБ заново.
    const stale = staleUpdaterFiles(['installer.exe', 'Zarya-Setup-0.5.7-win-x64.exe'], '0.5.6')
    expect(stale).toEqual([])
  })

  it('старая версия в кеше при более новой ожидающей — тоже не трогается', () => {
    // Осторожность важнее экономии: пока в кеше есть что-то новее, не чистим
    // ничего, иначе легко снести половину ожидающего обновления.
    const stale = staleUpdaterFiles(
      ['Zarya-Setup-0.5.5-win-x64.exe', 'Zarya-Setup-0.5.7-win-x64.exe'],
      '0.5.6'
    )
    expect(stale).toEqual([])
  })

  it('версия та же — файл уже поставлен, можно убирать', () => {
    expect(staleUpdaterFiles(['Zarya-Setup-0.5.6-win-x64.exe'], '0.5.6')).toEqual([
      'Zarya-Setup-0.5.6-win-x64.exe'
    ])
  })

  it('пустой кеш — пустой ответ', () => {
    expect(staleUpdaterFiles([], '0.5.6')).toEqual([])
  })

  it('чужие расширения не считаются сборками', () => {
    expect(staleUpdaterFiles(['readme.txt', 'current.blockmap'], '0.5.6')).toEqual([])
  })
})

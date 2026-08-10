import { describe, expect, it } from 'vitest'
import { cleanArgPath, folderArg } from '@shared/cliArgs'

/**
 * Аргументы приходят из трёх разных мест и в разной форме: собранное
 * приложение, запуск из исходников (`electron .`) и второй экземпляр, который
 * приносит argv чужого процесса. На живом запуске виден ровно один случай из
 * трёх — поэтому разбор чистый и проверяется здесь.
 *
 * Цена ошибки несимметрична. Пропустить папку — команда не сработала, человек
 * попробует ещё раз. Взять НЕ ТУ — Заря при каждом запуске в разработке
 * открывала бы свой собственный каталог.
 */
describe('folderArg — собранное приложение', () => {
  const P = true

  it('первый непрефиксный аргумент — это папка', () => {
    expect(folderArg(['C:/app/zarya.exe', 'C:/proj'], P)).toBe('C:/proj')
  })

  it('точка тоже папка — раскрывать её будет главный процесс', () => {
    expect(folderArg(['/usr/bin/zarya', '.'], P)).toBe('.')
  })

  it('без аргументов — null, это обычный запуск', () => {
    expect(folderArg(['C:/app/zarya.exe'], P)).toBeNull()
  })

  it('ключи Electron и Chromium пропускаются', () => {
    expect(
      folderArg(['zarya.exe', '--no-sandbox', '--allow-file-access', 'C:/proj'], P)
    ).toBe('C:/proj')
  })

  it('одни ключи и ни одной папки — null', () => {
    expect(folderArg(['zarya.exe', '--inspect', '--no-sandbox'], P)).toBeNull()
  })

  it('лишние аргументы после папки не мешают: берём первый', () => {
    expect(folderArg(['zarya.exe', 'C:/a', 'C:/b'], P)).toBe('C:/a')
  })

  it('пустые аргументы не считаются папкой', () => {
    expect(folderArg(['zarya.exe', '   ', 'C:/proj'], P)).toBe('C:/proj')
  })
})

describe('folderArg — запуск из исходников', () => {
  const D = false

  it('первый аргумент — САМА Заря, и папкой человека он не является', () => {
    // `electron . ` — иначе приложение открывало бы свой каталог при каждом
    // запуске в разработке.
    expect(folderArg(['/path/electron', '.'], D)).toBeNull()
  })

  it('папка человека идёт вторым: `electron . C:/proj`', () => {
    expect(folderArg(['/path/electron', '.', 'C:/proj'], D)).toBe('C:/proj')
  })

  it('ключи не сдвигают счёт', () => {
    expect(folderArg(['/path/electron', '--inspect', '.', 'C:/proj'], D)).toBe('C:/proj')
  })
})

describe('cleanArgPath — то, что добавляет оболочка', () => {
  it('кавычки вокруг пути с пробелами снимаются', () => {
    expect(cleanArgPath('"C:/Мои проекты/заря"')).toBe('C:/Мои проекты/заря')
    expect(cleanArgPath("'/home/me/my proj'")).toBe('/home/me/my proj')
  })

  it('кавычка ВНУТРИ пути остаётся — она часть имени', () => {
    expect(cleanArgPath('C:/it"s')).toBe('C:/it"s')
  })

  it('одна кавычка на конце не считается парой', () => {
    expect(cleanArgPath('C:/proj"')).toBe('C:/proj"')
  })

  it('пробелы по краям убираются', () => {
    expect(cleanArgPath('  C:/proj  ')).toBe('C:/proj')
  })

  it('пустое остаётся пустым, а не превращается в точку', () => {
    expect(cleanArgPath('   ')).toBe('')
    expect(cleanArgPath('""')).toBe('')
  })
})

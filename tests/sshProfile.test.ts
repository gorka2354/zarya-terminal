import { describe, expect, it } from 'vitest'
import { portValid, sshArgs, sshLabel, sshValid } from '@shared/sshProfile'

/**
 * Сборка запуска `ssh`. Проверяется здесь, а не глазами, потому что ошибка
 * молчалива: неверный порядок аргументов не даёт сообщения — он даёт
 * подключение, которое «почему-то просит пароль».
 *
 * Отдельно — дефис в начале значения. Для `ssh` такой «хост» не хост, а опция:
 * `-oProxyCommand=…` превращает подключение к своему серверу в запуск чужой
 * команды на ЭТОЙ машине.
 */
describe('sshArgs — что уедет в командную строку', () => {
  it('простое подключение — одна цель и ничего лишнего', () => {
    expect(sshArgs({ host: '100.81.218.50', user: 'egor' })).toEqual(['egor@100.81.218.50'])
  })

  it('без пользователя — только хост: его задаёт ~/.ssh/config', () => {
    expect(sshArgs({ host: 'egorka23' })).toEqual(['egorka23'])
  })

  it('опции идут ПЕРЕД целью, иначе они уедут удалённой команде', () => {
    const args = sshArgs({ host: 'h', user: 'u', port: '2222' })
    expect(args).toEqual(['-p', '2222', 'u@h'])
    expect(args.indexOf('-p')).toBeLessThan(args.indexOf('u@h'))
  })

  it('ключ передаётся отдельным аргументом — пробелы в пути не ломают запуск', () => {
    expect(sshArgs({ host: 'h', keyPath: 'C:\\Users\\Мои ключи\\id_ed25519' })).toEqual([
      '-i',
      'C:\\Users\\Мои ключи\\id_ed25519',
      'h'
    ])
  })

  it('порт и ключ вместе — оба перед целью', () => {
    expect(sshArgs({ host: 'h', user: 'u', port: '22', keyPath: 'k' })).toEqual([
      '-p',
      '22',
      '-i',
      'k',
      'u@h'
    ])
  })

  it('пустой порт не превращается в «-p» без значения', () => {
    expect(sshArgs({ host: 'h', port: '   ' })).toEqual(['h'])
  })
})

describe('sshValid — чего не пустим в argv', () => {
  it('хост, начинающийся с дефиса, — это опция ssh, а не хост', () => {
    expect(sshValid({ host: '-oProxyCommand=calc.exe' })).toBe(false)
    expect(sshArgs({ host: '-oProxyCommand=calc.exe' })).toEqual([])
  })

  it('и пользователь тоже', () => {
    expect(sshValid({ host: 'h', user: '-oProxyCommand=x' })).toBe(false)
  })

  it('и путь к ключу', () => {
    expect(sshValid({ host: 'h', keyPath: '-oProxyCommand=x' })).toBe(false)
  })

  it('пробел в хосте — опечатка, а не конфигурация', () => {
    expect(sshValid({ host: 'два слова' })).toBe(false)
  })

  it('пустой хост — подключаться некуда', () => {
    expect(sshValid({ host: '' })).toBe(false)
    expect(sshValid({ host: '   ' })).toBe(false)
  })

  it('обычные имена проходят', () => {
    expect(sshValid({ host: '100.81.218.50', user: 'egor' })).toBe(true)
    expect(sshValid({ host: 'egorka23.local', user: 'egor-2' })).toBe(true)
  })
})

describe('portValid', () => {
  it('пусто — порт по умолчанию, это законно', () => {
    expect(portValid('')).toBe(true)
    expect(portValid(undefined)).toBe(true)
  })

  it('обычные порты', () => {
    expect(portValid('22')).toBe(true)
    expect(portValid('65535')).toBe(true)
  })

  it('вне диапазона и не число', () => {
    expect(portValid('0')).toBe(false)
    expect(portValid('65536')).toBe(false)
    expect(portValid('22x')).toBe(false)
    expect(portValid('-1')).toBe(false)
  })
})

describe('sshLabel — подпись в списке', () => {
  it('то же, что человек набрал бы руками', () => {
    expect(sshLabel({ host: '100.81.218.50', user: 'egor' })).toBe('egor@100.81.218.50')
    expect(sshLabel({ host: 'h', user: 'u', port: '2222' })).toBe('u@h:2222')
    expect(sshLabel({ host: 'h' })).toBe('h')
  })
})

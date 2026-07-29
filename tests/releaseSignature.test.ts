import { describe, expect, it } from 'vitest'
import {
  parseSignature,
  sha256Hex,
  sigAssetName,
  verifyManifest
} from '../src/main/releaseSignature'

/**
 * Подпись релиза — единственное звено цепочки доверия, которое не может
 * подделать сам сборочный конвейер: ключ живёт у мейнтейнера, а не в CI. Всё
 * остальное (sha512 в latest.yml, суммы в SHA256SUMS) считает та же машина, что
 * и собирает, — при её захвате эти числа сойдутся.
 *
 * Ключевая проверка здесь — «наш ли открытый ключ зашит в приложение». Опечатка
 * в нём никак не проявится до выпуска: подпись просто перестанет сходиться у
 * ВСЕХ пользователей разом, и обновление встанет. Поэтому в тесте лежит образец,
 * подписанный настоящим закрытым ключом (подпись — величина публичная).
 */

/** Кусок списка сумм, подписанный настоящим ключом выпуска. */
const SIGNED_TEXT =
  '0000000000000000000000000000000000000000000000000000000000000001  Zarya-Setup-9.9.9.exe\n'
const SIGNATURE =
  '57Z1ykYNURCtHjEtNBrNPPz/eaIpFFg/V3/xnEQdaXvhg78oEAXGaKHIoCg9XVbEeaZhTHwP4u+Pt02gq3dUBQ=='

describe('подпись релиза', () => {
  it('зашитый открытый ключ — от ключа выпуска', () => {
    expect(verifyManifest(SIGNED_TEXT, SIGNATURE)).toBe('ok')
  })

  it('переводы строк и пробелы в файле подписи не мешают', () => {
    expect(verifyManifest(SIGNED_TEXT, `${SIGNATURE}\n`)).toBe('ok')
  })

  it('подменённый список сумм не проходит', () => {
    const tampered = SIGNED_TEXT.replace('0000000000000000', '1111111111111111')
    expect(verifyManifest(tampered, SIGNATURE)).toBe('bad')
  })

  it('лишний байт в конце списка ломает подпись', () => {
    // Подписываются БАЙТЫ файла, а не разобранная таблица: дописать строку
    // «ниже подписи» нельзя.
    expect(verifyManifest(SIGNED_TEXT + 'deadbeef  чужое.exe\n', SIGNATURE)).toBe('bad')
  })

  it('подписи нет — это отдельный случай, не ошибка', () => {
    expect(verifyManifest(SIGNED_TEXT, undefined)).toBe('missing')
  })

  it('мусор вместо подписи — «не сходится», а не падение', () => {
    expect(verifyManifest(SIGNED_TEXT, 'не подпись вовсе')).toBe('bad')
    expect(verifyManifest(SIGNED_TEXT, '')).toBe('bad')
    // Валидный base64, но не 64 байта Ed25519.
    expect(verifyManifest(SIGNED_TEXT, 'AAAA')).toBe('bad')
  })

  it('подпись читается только как 64 байта', () => {
    expect(parseSignature(SIGNATURE)?.length).toBe(64)
    expect(parseSignature('AAAA')).toBeNull()
    expect(parseSignature('###')).toBeNull()
  })

  it('файл подписи лежит рядом со списком сумм', () => {
    expect(sigAssetName('SHA256SUMS-0.5.8.txt')).toBe('SHA256SUMS-0.5.8.txt.sig')
  })

  it('sha256 считается так же, как в списке сумм', () => {
    // Значение из coreutils: printf '' | sha256sum
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })
})

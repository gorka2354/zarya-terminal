import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  compareVersions,
  downloadableAssets,
  findSigAsset,
  findSumsAsset,
  isNewer,
  latestReleaseApiUrl,
  parseRelease,
  parseSha256Sums,
  releasePageUrl,
  shouldRecheck
} from '@shared/updates'

/**
 * Проверка обновлений — первое место, куда в приложение приезжает контент из
 * сети. Здесь проверяется главное правило: ни один адрес не берётся из ответа.
 * Подменённый ответ не должен уметь увести кнопку «Скачать» куда угодно — её
 * нажмут, потому что показало доверенное приложение.
 */
const release = (over: Record<string, unknown> = {}): unknown => ({
  tag_name: 'v0.5.1',
  name: 'Zarya 0.5.1 «Часовой»',
  body: '**Релиз безопасности.**',
  published_at: '2026-07-25T21:38:46Z',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Zarya-Setup-0.5.1-win-x64.exe', size: 188_000_000 },
    { name: 'SHA256SUMS-0.5.1.txt', size: 200 }
  ],
  ...over
})

describe('compareVersions', () => {
  it('сравнивает по числам, а не по строкам', () => {
    // По лексикографике «0.5.10» оказалось бы МЕНЬШЕ «0.5.9», и десятый патч
    // человек бы не увидел.
    expect(compareVersions('0.5.10', '0.5.9')).toBe(1)
    expect(compareVersions('0.5.9', '0.5.10')).toBe(-1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
  })

  it('одинаковые версии равны, ведущая v не мешает', () => {
    expect(compareVersions('0.5.2', '0.5.2')).toBe(0)
    expect(compareVersions('v0.5.2', '0.5.2')).toBe(0)
  })

  it('недостающие части считаются нулями', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBe(1)
  })

  it('мусор не роняет сравнение', () => {
    expect(compareVersions('', '0.0.0')).toBe(0)
    expect(compareVersions('абв', '0.0.1')).toBe(-1)
  })

  /*
   * Пререлизный хвост раньше отбрасывался — с пометкой «свои релизы мы так не
   * помечаем». А мы помечаем: владелец работает на бетах. В день выпуска 0.7.5
   * установленная `0.7.5-beta.8` сказала «у вас последняя версия», потому что
   * для отбрасывающего сравнения это одно и то же. Проверено на живой машине.
   */
  it('бета МЛАДШЕ такой же версии без хвоста — иначе выпуск до неё не доедет', () => {
    expect(compareVersions('0.7.5-beta.8', '0.7.5')).toBe(-1)
    expect(compareVersions('0.7.5', '0.7.5-beta.8')).toBe(1)
    expect(isNewer('0.7.5-beta.8', '0.7.5')).toBe(true)
  })

  it('две беты сравниваются по номеру, а не по буквам', () => {
    // По строкам «beta.10» оказалась бы МЕНЬШЕ «beta.9».
    expect(compareVersions('0.7.5-beta.10', '0.7.5-beta.9')).toBe(1)
    expect(compareVersions('0.7.5-beta.2', '0.7.5-beta.10')).toBe(-1)
    expect(compareVersions('0.7.5-beta.3', '0.7.5-beta.3')).toBe(0)
  })

  it('следующая версия старше любой беты предыдущей — и наоборот', () => {
    expect(isNewer('0.7.5-beta.1', '0.7.6')).toBe(true)
    // Обратное направление важнее: беты 0.7.6 НЕ должны звать откатиться на 0.7.5.
    expect(isNewer('0.7.6-beta.1', '0.7.5')).toBe(false)
  })

  it('короткий хвост младше длинного, число младше буквы', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('сборочный хвост не значит ничего', () => {
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.1+build', '1.0.0-beta.1')).toBe(0)
  })
})

describe('isNewer', () => {
  it('предлагает только то, что действительно новее', () => {
    expect(isNewer('0.5.1', '0.5.2')).toBe(true)
    expect(isNewer('0.5.2', '0.5.2')).toBe(false)
    // Установлена сборка новее опубликованной (так сейчас и есть: тег v0.5.2
    // запушен, релиз не опубликован) — предлагать «обновиться» назад нельзя.
    expect(isNewer('0.5.2', '0.5.1')).toBe(false)
  })
})

describe('parseRelease', () => {
  it('разбирает нормальный релиз', () => {
    const r = parseRelease(release())
    expect(r).toMatchObject({ version: '0.5.1', tag: 'v0.5.1' })
    expect(r?.assets.map((a) => a.name)).toEqual([
      'Zarya-Setup-0.5.1-win-x64.exe',
      'SHA256SUMS-0.5.1.txt'
    ])
  })

  it('пропускает черновик и пререлиз', () => {
    expect(parseRelease(release({ draft: true }))).toBeNull()
    expect(parseRelease(release({ prerelease: true }))).toBeNull()
  })

  it('отвергает тег неизвестной формы', () => {
    // Из тега строится URL. Всё, что не «vX.Y.Z», до сборки ссылок не доходит.
    expect(parseRelease(release({ tag_name: 'v1.0.0/../../evil' }))).toBeNull()
    expect(parseRelease(release({ tag_name: 'latest' }))).toBeNull()
    expect(parseRelease(release({ tag_name: '' }))).toBeNull()
    expect(parseRelease(release({ tag_name: 'v1.0.0 ' }))).toMatchObject({ tag: 'v1.0.0' })
  })

  it('выбрасывает ассеты с опасными именами, оставляя нормальные', () => {
    const r = parseRelease(
      release({
        assets: [
          { name: '../../../etc/passwd', size: 1 },
          { name: 'ok-file.exe', size: 2 },
          { name: 'a/b.exe', size: 3 }
        ]
      })
    )
    expect(r?.assets.map((a) => a.name)).toEqual(['ok-file.exe'])
  })

  it('не падает на чужой форме ответа', () => {
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease('строка')).toBeNull()
    expect(parseRelease({})).toBeNull()
    expect(parseRelease(release({ assets: 'не массив' }))?.assets).toEqual([])
  })

  it('терпит отсутствие необязательных полей', () => {
    const r = parseRelease({ tag_name: 'v1.2.3' })
    expect(r).toMatchObject({ version: '1.2.3', name: '', body: '', publishedAt: '' })
  })
})

describe('сборка ссылок', () => {
  it('страница релиза строится из константы репозитория', () => {
    expect(releasePageUrl('v0.5.1')).toBe(
      'https://github.com/gorka2354/zarya-terminal/releases/tag/v0.5.1'
    )
  })

  it('ссылка на файл — тоже из константы', () => {
    expect(assetUrl('v0.5.1', 'Zarya-Setup-0.5.1-win-x64.exe')).toBe(
      'https://github.com/gorka2354/zarya-terminal/releases/download/v0.5.1/Zarya-Setup-0.5.1-win-x64.exe'
    )
  })

  it('кривой тег или имя файла ссылку не дают', () => {
    expect(releasePageUrl('../../evil')).toBeNull()
    expect(releasePageUrl('v1.0.0-rc1')).toBeNull()
    expect(assetUrl('v0.5.1', '../../../evil.exe')).toBeNull()
    expect(assetUrl('v0.5.1', 'a b.exe')).toBeNull()
  })

  it('адрес проверки — константа, его нельзя переставить', () => {
    expect(latestReleaseApiUrl()).toBe(
      'https://api.github.com/repos/gorka2354/zarya-terminal/releases/latest'
    )
  })
})

describe('parseSha256Sums', () => {
  const hash = 'f86ebfa0429ced91be6054fc344827e9c6c2572f3c318416cd974b06f66437ec'

  it('разбирает обычный формат', () => {
    const map = parseSha256Sums(`${hash}  Zarya-Setup-0.5.1-win-x64.exe\n`)
    expect(map['Zarya-Setup-0.5.1-win-x64.exe']).toBe(hash)
  })

  it('понимает звёздочку двоичного режима', () => {
    expect(parseSha256Sums(`${hash} *file.exe`)['file.exe']).toBe(hash)
  })

  it('пропускает мусорные строки, не падая', () => {
    const map = parseSha256Sums(`не хеш\n\n${hash}  file.exe\nкороткий1234  x.exe`)
    expect(Object.keys(map)).toEqual(['file.exe'])
  })

  it('не берёт имена с путями', () => {
    expect(parseSha256Sums(`${hash}  ../../evil.exe`)).toEqual({})
  })
})

describe('раскладка ассетов', () => {
  const assets = [
    { name: 'Zarya-Setup-0.5.1-win-x64.exe', size: 1 },
    { name: 'SHA256SUMS-0.5.1.txt', size: 2 }
  ]

  it('файл сумм находится и не предлагается к скачиванию', () => {
    expect(findSumsAsset(assets)?.name).toBe('SHA256SUMS-0.5.1.txt')
    expect(downloadableAssets(assets).map((a) => a.name)).toEqual([
      'Zarya-Setup-0.5.1-win-x64.exe'
    ])
  })

  it('подпись не путается со списком сумм', () => {
    // Оба файла начинаются на SHA256SUMS, порядок ассетов задаёт GitHub. Принять
    // подпись за список — значит проверять её саму собой и ничего не проверить.
    const withSig = [{ name: 'SHA256SUMS-0.5.1.txt.sig', size: 89 }, ...assets]
    expect(findSumsAsset(withSig)?.name).toBe('SHA256SUMS-0.5.1.txt')
    expect(findSigAsset(withSig)?.name).toBe('SHA256SUMS-0.5.1.txt.sig')
    // И то и другое — служебное: в списке файлов для человека их быть не должно.
    expect(downloadableAssets(withSig).map((a) => a.name)).toEqual([
      'Zarya-Setup-0.5.1-win-x64.exe'
    ])
  })

  it('подписи нет — так и говорим', () => {
    expect(findSigAsset(assets)).toBeUndefined()
  })
})

describe('переспросить ли при открытии окна', () => {
  const NOW = 1_700_000_000_000

  it('старый ответ переспрашиваем: подпись появляется уже после сборки', () => {
    // Ровно случай 0.7.3: релиз собрался без подписи, человек открыл окно,
    // подпись легла через несколько минут — и окно продолжало утверждать, что
    // её нет.
    expect(
      shouldRecheck({ open: true, autoCheck: true, checkedAt: NOW - 30 * 60_000, now: NOW })
    ).toBe(true)
  })

  it('свежий не трогаем — открыть и закрыть окно дважды подряд это норма', () => {
    expect(shouldRecheck({ open: true, autoCheck: true, checkedAt: NOW - 5_000, now: NOW })).toBe(
      false
    )
  })

  it('не проверяли ни разу — спрашиваем', () => {
    expect(shouldRecheck({ open: true, autoCheck: true, now: NOW })).toBe(true)
  })

  it('окно закрыто — молчим, фонового опроса тут нет', () => {
    expect(shouldRecheck({ open: false, autoCheck: true, checkedAt: 0, now: NOW })).toBe(false)
  })

  it('человек выключил проверки — не спрашиваем даже с открытым окном', () => {
    expect(shouldRecheck({ open: true, autoCheck: false, checkedAt: 0, now: NOW })).toBe(false)
  })

  it('порог свежести можно задать явно', () => {
    expect(
      shouldRecheck({ open: true, autoCheck: true, checkedAt: NOW - 10_000, now: NOW, freshMs: 5_000 })
    ).toBe(true)
  })
})

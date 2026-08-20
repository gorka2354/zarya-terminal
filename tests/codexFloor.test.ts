import { describe, expect, it, vi } from 'vitest'

/**
 * Пол под автопилотом — ОДИНАКОВЫЙ ДЛЯ ВСЕХ ДВИЖКОВ.
 *
 * Разведка 2026-08-19: `@shared/irreversible` читали три драйвера, а Codex в
 * автопилоте не спрашивал вовсе — `approvalPolicy: 'never'`. Обещание же в
 * интерфейсе одно на всех: подпись чипа автопилота и строка «показано несмотря
 * на автопилот» не знают, каким движком работает эта панель.
 *
 * Теперь политика всегда `on-request`, а тишину даёт сам драйвер — кроме того,
 * что стоит в списке необратимого. Здесь проверяется ровно это правило.
 *
 * ЧЕГО ЭТОТ ПОЛ НЕ ЛОВИТ (и это сказано в самом коде): правку внутри рабочей
 * папки codex в режиме `workspaceWrite` одобряет сам и нам о ней не сообщает.
 * Тест на несуществующую защиту был бы хуже отсутствующего.
 */
vi.mock('electron', () => ({ BrowserWindow: class {} }))

const { codexFloor } = await import('../src/main/codexDriver')

describe('автопилот Codex не глотает необратимое', () => {
  it('удаление рекурсией показывается, несмотря на автопилот', () => {
    for (const cmd of ['rm -rf /', 'rm -rf ~/work', 'sudo rm -fr .']) {
      expect(codexFloor(true, cmd), cmd).toBeTruthy()
    }
  })

  it('и другие необратимые — из общего списка, а не из своего', () => {
    /*
     * Список один на все движки (@shared/irreversible). Заведи Codex свой — и
     * «необратимое» стало бы означать разное в соседних панелях.
     */
    for (const cmd of ['git push --force origin main', 'git clean -fdx']) {
      expect(codexFloor(true, cmd), cmd).toBeTruthy()
    }
  })

  it('и НЕ считает необратимым то, чего в списке нет намеренно', () => {
    /*
     * `git reset --hard` в списке отсутствует осознанно: коммиты достаются из
     * reflog (см. шапку @shared/irreversible). Список один на все движки — и
     * границу «что необратимо» Codex не имеет права двигать в свою сторону.
     */
    expect(codexFloor(true, 'git reset --hard HEAD~3')).toBeUndefined()
  })

  it('рутина в автопилоте проходит молча — иначе это не автопилот', () => {
    for (const cmd of ['git status', 'npm test', 'ls -la', 'cat README.md']) {
      expect(codexFloor(true, cmd), cmd).toBeUndefined()
    }
  })

  it('без автопилота функция молчит: там спрашивают всё и так', () => {
    // `undefined` здесь значит не «можно молча», а «карточка будет в любом
    // случае»: политика `on-request` доносит до человека каждый вызов.
    expect(codexFloor(false, 'rm -rf /')).toBeUndefined()
    expect(codexFloor(false, 'git status')).toBeUndefined()
  })

  it('пустая команда не роняет', () => {
    expect(codexFloor(true, '')).toBeUndefined()
  })
})

/**
 * Флаг чекпоинтов на НАСТОЯЩЕМ CLI — проверка того самого P1.
 *
 * Откат кода требует id хода человека, а движок отдаёт его только с флагом
 * `--replay-user-messages`. Флага нет в типизированном контракте SDK: он едет
 * сырой строкой в конец командной строки. Если бинарник его не знает, CLI
 * падает ДО начала хода («error: unknown option»), и человек теряет не кнопку
 * отката, а агента — на каждый ход, пока не догадается выключить настройку.
 *
 * Юнит-тесты проверяют наш разбор ответа. Здесь проверяется чужая программа:
 * что ПОЛНАЯ командная строка (та же, что собирает SDK в headless-режиме)
 * вместе с нашим флагом действительно запускается, а контрольный выдуманный
 * флаг — действительно падает. Без второй половины проверка была бы бумажной:
 * «не нашли ошибку» ничего не значит, если ошибка не находится никогда.
 *
 * Ни одного обращения к модели: stdin закрывается сразу, CLI разбирает
 * аргументы, не получает работы и выходит. Токены не тратятся.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let pass = 0,
  fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log('  ✓', name)
  } else {
    fail++
    console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : '')
  }
}

const candidates =
  process.platform === 'win32'
    ? [
        join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        join(homedir(), '.local', 'bin', 'claude.exe')
      ]
    : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']

const exe = candidates.find((p) => p && existsSync(p))
if (!exe) {
  /*
   * Пропуск — это не успех, и код возврата обязан это повторить.
   *
   * Раньше здесь стоял `exit(0)`: на машине без движка прогон писал «ПРОПУЩЕНО»
   * и отдавал зелёный код. Тот, кто смотрит на код возврата, а не в вывод (то
   * есть любая автоматика), читал это как «флаг проверен». Отдельный код 2
   * отличает «не смогли проверить» и от успеха, и от найденной поломки.
   */
  console.log('ПРОПУЩЕНО: настоящий claude не найден — ФЛАГ НЕ ПРОВЕРЕН')
  process.exit(2)
}
console.log('Бинарник:', exe)

/** Те же аргументы, что SDK собирает для headless-хода, плюс проверяемый флаг. */
const sdkArgs = (flag) => [
  flag,
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose'
]

function run(args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })
    )
    // Работы не даём: CLI разберёт аргументы и завершится сам.
    child.stdin?.end()
  })
}

console.log('\n[1] Наш флаг в полной командной строке движок принимает')
const started = Date.now()
const good = await run(sdkArgs('--replay-user-messages'))
ok('запуск НЕ отвергнут как неизвестный флаг', !/unknown option/i.test(good.stderr), good.stderr.slice(0, 200))
ok('проверка укладывается в разумное время', Date.now() - started < 25000, Date.now() - started)

console.log('\n[2] Контроль: выдуманный флаг движок действительно отвергает')
const bad = await run(sdkArgs('--zzz-not-a-real-flag'))
// Без этой половины первая проверка ничего не стоила бы: она обязана уметь
// падать. Заодно это и есть воспроизведение самого P1 — так выглядит поломка.
ok('CLI отвечает «unknown option»', /unknown option/i.test(bad.stderr), bad.stderr.slice(0, 200))
ok('и называет именно этот флаг', bad.stderr.includes('--zzz-not-a-real-flag'), bad.stderr.slice(0, 200))

console.log(`\nИтог: ${pass} ok, ${fail} fail`)
process.exit(fail ? 1 : 0)

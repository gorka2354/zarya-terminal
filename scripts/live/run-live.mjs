/**
 * Запустить ВСЕ живые сценарии против настоящего Claude Code.
 *
 * Отдельный раннер, а не переменная в npm-скрипте: `ZARYA_LIVE=1 npm run ...`
 * на Windows не работает без cross-env, а тащить зависимость ради одной
 * переменной не стоит.
 *
 * Прогон тратит токены (несколько коротких ходов) и идёт минуты — поэтому он
 * не в общем `npm test` и запускается руками перед выпуском.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'scripts', 'live')
const scenarios = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'run-live.mjs')

let failed = 0
for (const name of scenarios) {
  console.log(`\n══ ${name} ═══════════════════════════════════════════`)
  const r = spawnSync(process.execPath, [join(dir, name)], {
    stdio: 'inherit',
    env: { ...process.env, ZARYA_LIVE: '1' }
  })
  if (r.status !== 0) failed++
}
console.log(`\nСценариев: ${scenarios.length}, с ошибками: ${failed}`)
process.exit(failed ? 1 : 0)

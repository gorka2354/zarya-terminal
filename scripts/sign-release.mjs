/**
 * Подписать выпущенный релиз — последний шаг выпуска, руками.
 *
 *   node scripts/sign-release.mjs 0.5.8
 *
 * Что делает: скачивает со страницы релиза список контрольных сумм
 * (`SHA256SUMS-<версия>.txt`), подписывает его закрытым ключом мейнтейнера и
 * выкладывает подпись рядом файлом `SHA256SUMS-<версия>.txt.sig`.
 *
 * Почему не в CI: ключ в CI = подпись у любого, кто получил доступ к CI, а
 * значит подпись не значит ничего. См. src/main/releaseSignature.ts.
 *
 * ⚠️ Релиз БЕЗ подписи установленные копии не поставят сами: покажут «подпись
 * не подтверждена» и предложат ручной путь. Подписывать нужно каждый релиз.
 */
import { execFileSync } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Проверить весь путь, ничего не выкладывая: подпись ляжет во временную папку. */
const dryRun = process.argv.includes('--dry-run')
const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Укажите версию: node scripts/sign-release.mjs 0.5.8')
  process.exit(1)
}
const tag = `v${version}`
const sumsName = `SHA256SUMS-${version}.txt`
const keyPath = process.env.ZARYA_SIGN_KEY ?? join(homedir(), '.zarya', 'release-signing.key')

if (!existsSync(keyPath)) {
  console.error(`Нет закрытого ключа: ${keyPath}`)
  console.error('Создать: node scripts/gen-signing-key.mjs (один раз на проект)')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'zarya-sign-'))
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// Подписываем то, что РЕАЛЬНО выложено, а не локальную копию: подпись должна
// сходиться с тем файлом, который увидит приложение.
console.log(`Скачиваю ${sumsName} из релиза ${tag}…`)
gh(['release', 'download', tag, '--pattern', sumsName, '--dir', work, '--clobber'])
const sumsPath = join(work, sumsName)
const sums = readFileSync(sumsPath)
const lines = sums
  .toString('utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
console.log(`В списке ${lines.length} файлов:`)
for (const l of lines) console.log('  ' + l)

const key = createPrivateKey(readFileSync(keyPath))
const sigPath = join(work, `${sumsName}.sig`)
writeFileSync(sigPath, sign(null, sums, key).toString('base64') + '\n')

if (dryRun) {
  console.log(`\n[dry-run] Подпись готова, но не выложена: ${sigPath}`)
  process.exit(0)
}
console.log(`\nВыкладываю ${sumsName}.sig…`)
gh(['release', 'upload', tag, sigPath, '--clobber'])
console.log('Готово. Теперь установленные копии смогут поставить обновление сами.')

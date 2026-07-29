/**
 * Ключ для подписи релизов — один раз на всю жизнь проекта.
 *
 * Смысл подписи в том, что закрытой части НЕТ в репозитории и НЕТ в CI. Иначе
 * захват репозитория или утечка токена дают злоумышленнику и сборку, и валидную
 * подпись к ней, а с автообновлением это тихое выполнение кода у всех
 * пользователей. Поэтому ключ рождается здесь, на машине мейнтейнера, и отсюда
 * не уезжает.
 *
 *   node scripts/gen-signing-key.mjs
 *
 * Закрытая часть ляжет в ~/.zarya/release-signing.key (0600), открытую надо
 * вписать в PUBLIC_KEY_B64 в src/main/releaseSignature.ts.
 *
 * ⚠️ Потеря закрытой части = невозможность подписать следующий релиз: у всех
 * установленных копий зашита СТАРАЯ открытая часть, и новый ключ они не примут.
 * Сделайте резервную копию файла (менеджер паролей, оффлайн-носитель) — но не в
 * репозитории и не в облачной папке проекта.
 */
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = process.env.ZARYA_SIGN_DIR ?? join(homedir(), '.zarya')
const keyPath = process.env.ZARYA_SIGN_KEY ?? join(dir, 'release-signing.key')

if (existsSync(keyPath)) {
  console.error(`Ключ уже есть: ${keyPath}`)
  console.error('Перезаписать его — значит потерять возможность подписывать релизы старым ключом.')
  console.error('Если ключ и правда надо сменить, удалите файл руками и запустите снова.')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
mkdirSync(dir, { recursive: true, mode: 0o700 })
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
try {
  chmodSync(keyPath, 0o600)
} catch {
  /* на NTFS почти не работает — там защищает сам профиль пользователя */
}
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

console.log(`Закрытая часть: ${keyPath}  (никому, никогда, не в гит)`)
console.log('')
console.log('Открытую часть вписать в src/main/releaseSignature.ts:')
console.log('')
console.log(`const PUBLIC_KEY_B64 = '${pub}'`)
console.log('')
console.log('Дальше подписывать релизы: node scripts/sign-release.mjs <версия>')

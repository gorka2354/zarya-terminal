/**
 * Голос целиком: речь синтезируется здесь же, прогоны идут один за другим.
 *
 *   node scripts/voice-suite.mjs
 *
 * Зачем отдельный запускальщик. Три голосовых прогона требуют файл речи в
 * `ZARYA_FAKE_WAV` и без него ЧЕСТНО пишут «пропущено» — но в сводке полного
 * прогона это выглядит почти как «зелено», и целая подсистема выпуска может
 * уехать непроверенной. Проект уже обжигался на прогонах, которые молчали о
 * том, что ничего не проверили.
 *
 * Речь берём у синтезатора Windows: он есть на любой машине, где Заря
 * собирается под Windows, и даёт повторяемый файл — в отличие от записи живого
 * голоса, которая у каждого своя.
 *
 * Хвост тишины дописывает `lib/wav-pad.mjs`: Chromium ЗАЦИКЛИВАЕТ подменённый
 * файл, и без паузы получается человек, говорящий без остановки, — автостопу
 * тогда неоткуда сработать, и прогон обвинит продукт в том, чего сам ему не дал.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  console.log('ПРОПУЩЕНО: синтез речи здесь — средствами Windows')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'zarya-speech-'))
const PS = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/*
 * Две фразы, а не одна. Потоковый режим проверяется только тем, что вторая
 * фраза дописывается к первой ПОКА идёт запись; с одной фразой этого не видно.
 */
const ФРАЗЫ = ['Привет, это проверка диктовки.', 'Вторая фраза для потокового режима.']

const скрипт = `
$ErrorActionPreference = 'Stop'
# Без этого PowerShell шлёт в поток записи о ходе загрузки сборок, и они
# приезжают в вывод прогона куском XML.
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$texts = @(${ФРАЗЫ.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')})
for ($i = 0; $i -lt $texts.Length; $i++) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  # Русский голос, если он есть: английским синтезатором русская фраза звучит
  # так, что её не разберёт ни модель, ни человек.
  $ru = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'ru*' } | Select-Object -First 1
  if ($ru) { $s.SelectVoice($ru.VoiceInfo.Name) }
  $s.SetOutputToWaveFile((Join-Path '${dir.replace(/\\/g, '\\\\')}' "p$i.wav"), $fmt)
  $s.Speak($texts[$i])
  $s.Dispose()
}
`

console.log('Синтезирую речь…')
try {
  execFileSync(
    PS,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(скрипт, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', timeout: 120_000 }
  )
} catch (e) {
  console.log('ПРОПУЩЕНО: синтезатор речи недоступен —', e?.message ?? e)
  process.exit(2)
}

const одна = join(dir, 'one.wav')
const две = join(dir, 'two.wav')
const пад = (входы, выход, сек) =>
  execFileSync('node', ['scripts/lib/wav-pad.mjs', входы, выход, String(сек)], {
    encoding: 'utf8'
  }).trim()

console.log(' ', пад(join(dir, 'p0.wav'), одна, 4))
console.log(' ', пад([join(dir, 'p0.wav'), join(dir, 'p1.wav')].join(','), две, 6))
if (!existsSync(одна) || !existsSync(две)) {
  console.log('ПРОПУЩЕНО: файлы речи не собрались')
  process.exit(2)
}

const ПРОГОНЫ = [
  ['автостоп', 'scripts/voice-autostop-test.mjs', одна],
  ['режимы диктовки', 'scripts/voice-modes-test.mjs', две],
  ['проверка микрофона', 'scripts/mic-check-test.mjs', одна]
]

let плохих = 0
for (const [имя, файл, wav] of ПРОГОНЫ) {
  console.log(`\n${'='.repeat(60)}\n[${имя}] ${файл}\n${'='.repeat(60)}`)
  try {
    execFileSync('node', [файл], {
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 15 * 60_000,
      env: { ...process.env, ZARYA_FAKE_WAV: wav }
    })
  } catch (e) {
    // Код 2 — прогон сам сказал «пропущено» (например, нет модели распознавания).
    if (e.status === 2) console.log(`[${имя}] пропущен самим прогоном`)
    else {
      плохих++
      console.log(`[${имя}] УПАЛ (код ${e.status})`)
    }
  }
}

console.log(плохих ? `\nГОЛОС: упало ${плохих}` : '\nГОЛОС: всё зелено')
process.exit(плохих ? 1 : 0)

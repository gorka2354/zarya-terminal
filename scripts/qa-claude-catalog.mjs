/**
 * Proves where Zarya's Claude model catalog actually comes from, and whether it
 * is stale.
 *
 * The catalog (and every newly released model) is served by the `claude` BINARY,
 * not by the SDK — so a Zarya whose bundled binary lags behind the user's own
 * self-updating CLI silently hides new models. This script probes both binaries,
 * fetches the catalog from each via an idle SDK query (no prompt, no tokens
 * spent), and reports the delta. Run it whenever "model X doesn't show up".
 *
 *   node scripts/qa-claude-catalog.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
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
    console.log('  ✗', name, extra != null ? '→ ' + JSON.stringify(extra) : '')
  }
}

/** Mirrors src/main/claudeExe.ts — kept in sync by tests/claudeExe.test.ts. */
function bundledPath() {
  const pkg =
    process.platform === 'win32'
      ? 'claude-agent-sdk-win32-x64'
      : process.platform === 'darwin'
        ? `claude-agent-sdk-darwin-${process.arch}`
        : `claude-agent-sdk-linux-${process.arch}`
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(process.cwd(), 'node_modules', '@anthropic-ai', pkg, exe)
  return existsSync(p) ? p : undefined
}

function systemPath() {
  const home = homedir()
  const c =
    process.platform === 'win32'
      ? [
          process.env.APPDATA &&
            join(
              process.env.APPDATA,
              'npm',
              'node_modules',
              '@anthropic-ai',
              'claude-code',
              'bin',
              'claude.exe'
            ),
          join(home, '.local', 'bin', 'claude.exe'),
          join(home, '.claude', 'local', 'claude.exe')
        ]
      : [
          join(home, '.local', 'bin', 'claude'),
          join(home, '.claude', 'local', 'claude'),
          '/usr/local/bin/claude',
          '/opt/homebrew/bin/claude'
        ]
  return c.filter(Boolean).find((p) => existsSync(p))
}

const version = (exe) =>
  new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err && !stdout) return resolve(undefined)
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout))
      resolve(m ? m[0] : undefined)
    })
  })

function inputQueue() {
  let closed = false,
    resolveNext = null
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          closed
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((res) => (resolveNext = res))
      })
    },
    close() {
      closed = true
      if (resolveNext) resolveNext({ value: undefined, done: true })
    }
  }
}

/** Fetch the model catalog from a specific binary via a throwaway idle query. */
async function catalog(exe) {
  const input = inputQueue()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 60000)
  try {
    const q = query({
      prompt: input.iterable,
      options: {
        abortController: abort,
        permissionMode: 'default',
        includePartialMessages: false,
        stderr: () => {},
        ...(exe ? { pathToClaudeCodeExecutable: exe } : {})
      }
    })
    return await q.supportedModels()
  } catch (e) {
    return { error: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
    input.close()
    abort.abort()
  }
}

const bundled = bundledPath()
const system = systemPath()

console.log('\nБинарники claude:')
const bv = bundled ? await version(bundled) : undefined
const sv = system ? await version(system) : undefined
console.log(`  встроенный: ${bundled ?? '(не найден)'} → ${bv ?? '?'}`)
console.log(`  системный:  ${system ?? '(не найден)'} → ${sv ?? '?'}`)

console.log('\nПроверки:')
ok('встроенный бинарник найден', !!bundled, bundled)
ok('версия встроенного читается', !!bv, bv)

const cb = bundled ? await catalog(bundled) : { error: 'no bundled binary' }
ok('встроенный отдаёт каталог моделей', Array.isArray(cb) && cb.length > 0, cb?.error ?? cb?.length)

let cs
if (system) {
  cs = await catalog(system)
  ok('системный отдаёт каталог моделей', Array.isArray(cs) && cs.length > 0, cs?.error ?? cs?.length)
} else {
  console.log('  · системный claude не установлен — сравнение пропущено')
}

const ids = (c) => (Array.isArray(c) ? c.map((m) => `${m.value}→${m.resolvedModel ?? '?'}`) : [])

if (Array.isArray(cb)) {
  console.log('\nКаталог ВСТРОЕННОГО:')
  for (const m of cb) console.log(`  ${m.value}  →  ${m.resolvedModel ?? '?'}   (${m.displayName})`)
}
if (Array.isArray(cs)) {
  console.log('\nКаталог СИСТЕМНОГО:')
  for (const m of cs) console.log(`  ${m.value}  →  ${m.resolvedModel ?? '?'}   (${m.displayName})`)
}

if (Array.isArray(cb) && Array.isArray(cs)) {
  const same = JSON.stringify(ids(cb)) === JSON.stringify(ids(cs))
  if (same) {
    ok('каталоги совпадают — Заря не отстаёт', true)
  } else {
    console.log(
      '\n  ⚠ каталоги РАЗЛИЧАЮТСЯ: встроенный бинарник устарел. Заря предпочтёт системный\n' +
        '    (политика в src/main/claudeExe.ts). Чтобы обновить встроенный —\n' +
        '    npm i @anthropic-ai/claude-agent-sdk@latest --save-exact и пересобрать.'
    )
    ok('каталоги совпадают — Заря не отстаёт', false, {
      bundled: ids(cb),
      system: ids(cs)
    })
  }
}

console.log(`\n${fail === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ЕСТЬ ПРОБЛЕМЫ'}: pass=${pass} fail=${fail}\n`)
process.exit(fail === 0 ? 0 : 1)

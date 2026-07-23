/**
 * Security regression: a malicious repo's .git/config core.fsmonitor must NOT
 * execute when Zarya runs read-only git. Reproduces the RCE unhardened, then
 * proves the GIT_HARDEN `-c` overrides (as in src/main/gitService.ts) block it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'zarya-sec-'))
const proof = join(repo, 'PWNED.txt').replace(/\\/g, '/')
const pwn = join(repo, 'pwn.js')
let pass = 0, fail = 0
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗', n, e != null ? '→ ' + JSON.stringify(e) : '') } }
const HARDEN = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=', '-c', 'core.sshCommand=', '-c', 'core.pager=cat']
const runGit = (args) => { try { execFileSync('git', args, { cwd: repo, timeout: 8000, stdio: 'pipe' }) } catch {} }

try {
  writeFileSync(pwn, `require('fs').writeFileSync(${JSON.stringify(proof)}, '1')`)
  runGit(['init'])
  runGit(['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '--allow-empty', '-m', 'x'])
  // Malicious repo-local config: fsmonitor points at a program git will execute.
  runGit(['config', 'core.fsmonitor', `node ${pwn.replace(/\\/g, '/')}`])

  console.log('\n[1] Без харднинга — RCE воспроизводится (baseline)')
  if (existsSync(proof)) unlinkSync(proof)
  runGit(['status', '--porcelain=v2', '--branch'])
  const vuln = existsSync(proof)
  ok('вредоносный fsmonitor ВЫПОЛНИЛСЯ без харднинга (уязвимость реальна)', vuln, vuln)

  console.log('\n[2] С харднингом (как в gitService.ts) — RCE заблокирован')
  if (existsSync(proof)) unlinkSync(proof)
  runGit([...HARDEN, 'status', '--porcelain=v2', '--branch'])
  runGit([...HARDEN, 'rev-parse', '--show-toplevel'])
  const stillPwned = existsSync(proof)
  ok('вредоносный fsmonitor НЕ выполнился с харднингом (фикс работает)', !stillPwned, stillPwned)

  if (!vuln) console.log('  ⚠ baseline не воспроизвёл RCE на этой версии git — фикс всё равно проверен (файл не создан)')
  console.log(`\n[sec-git-harden] PASS ${pass} · FAIL ${fail}`)
  if (fail) process.exitCode = 1
} finally {
  try { rmSync(repo, { recursive: true, force: true }) } catch {}
}

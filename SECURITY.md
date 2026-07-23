# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports. Instead, use
[GitHub's private vulnerability reporting](https://github.com/gorka2354/zarya-terminal/security/advisories/new)
for this repository, or email the maintainer directly (see the profile on the
[repository's GitHub page](https://github.com/gorka2354/zarya-terminal)). Include
reproduction steps and, if relevant, which shell/OS/AI provider configuration is
involved. Expect an initial response within a few days — this is a small,
single-maintainer project, not a company with an SLA.

## What Zarya does with sensitive data

- **AI provider API keys** are encrypted at rest via Electron's `safeStorage`
  (Windows DPAPI, macOS Keychain, Linux Secret Service) before being written to
  `secrets.json` under the OS `userData` directory. Keys are read and used only in
  the main process; the renderer never receives raw key material, only a
  `hasKey: boolean` status per provider. If OS-level encryption is unavailable,
  Zarya falls back to storing the key base64-encoded rather than refusing to run —
  that fallback is **not** a security boundary, only a degrade path; a normal
  desktop session (which has `safeStorage` available) is assumed for real key
  protection.
- **No telemetry.** Zarya does not phone home, collect analytics, or send crash
  reports anywhere. The only outbound network requests it ever makes are to the AI
  provider endpoint you explicitly configure (and to a self-hosted Ollama/OpenAI
  Ollama-compatible host if you point it at one).
- **No account, no server component.** There is nothing to breach on Zarya's side
  beyond your own machine — session data, history, workflows and settings are all
  local files under the OS `userData` directory.
- **Cleartext at rest (everything except API keys).** Only provider API keys are
  encrypted. Terminal scrollback (`sessions/<id>.json`), AI conversations
  (`ai-conversations.json`) and command history (`history.jsonl`) are stored as
  plaintext JSON. If secrets transit your terminal or a chat (`cat .env`, `env`,
  `aws configure`, `curl -H "Authorization: …"`, tokens echoed by tools) they can
  persist there in cleartext and be read by anything with access to your user
  profile — notably an **AppData cloud backup, a shared/resold disk, or forensic
  recovery**. On shared or backed-up machines, set **Sessions → Restore on launch
  = none** to stop persisting scrollback, and avoid pasting long-lived credentials
  into the terminal or AI chat. (Same-user malware is not meaningfully mitigated
  by encryption here — the OS keystore decrypts transparently for the same user.)

## Opening untrusted repositories

The status/diff features run read-only `git` automatically against whatever folder
you open (terminal cwd / file tree). Because git honours a repository's local
`.git/config`, and some config keys make git execute an external program (e.g.
`core.fsmonitor`, which `git status` spawns), a malicious repository shipped in a
zip or shared folder could otherwise run code in Zarya's main process just by
being opened. Zarya neutralizes those exec-capable config keys (`core.fsmonitor`,
`core.hooksPath`, `core.sshCommand`, `core.pager`) on every internal git
invocation. Still, treat repositories from untrusted sources with the caution you
would give any downloaded code.
- **Shell-integration anti-spoofing.** The private OSC 6973 channel used to capture
  exact command lines is signed with a per-session, cryptographically random nonce
  minted at PTY spawn and never exposed to child processes; payloads with a missing
  or mismatched nonce are dropped. See [docs/shell-integration.md](docs/shell-integration.md).
- **Renderer sandboxing.** The `BrowserWindow` runs with `contextIsolation: true` and
  `sandbox: true`; the only bridge between the renderer and Node/OS APIs is the
  fixed, typed `window.zarya` surface exposed by the preload script — there is no
  direct `ipcRenderer`/Node access from application UI code.

## Supported versions

Zarya is pre-1.0. Security fixes land on the latest released version; there is no
long-term-support branch at this stage.

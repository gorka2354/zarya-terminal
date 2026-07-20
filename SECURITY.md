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

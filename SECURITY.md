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
  the main process; the renderer never receives raw key material, only a status
  per provider (`hasKey` plus how the key is actually protected). If OS-level
  encryption is unavailable, Zarya falls back to storing the key base64-encoded
  rather than refusing to run — that fallback is **not** a security boundary, only
  a degrade path.

  **That degrade is stated in the UI, not hidden.** The badge over each key
  reports one of three things: *Ключ в хранилище ОС* (green), *Ключ защищён
  слабо* (amber) or *Ключ открытым текстом* (amber, with an explanation of what
  to do). Two conditions are judged separately — how the key was written (the
  `enc:` / `b64:` prefix in `secrets.json`) and what the system can do right now
  (`safeStorage.isEncryptionAvailable()` and, on Linux, the selected backend).
  The second matters on its own: on a Linux box with no keyring the backend is
  `basic_text`, `encryptString` still produces an `enc:` prefix, and nothing is
  actually protected — so judging by the prefix alone would paint a green badge
  over plaintext.

  **No telemetry follows from this.** Reporting the protection level is a local
  UI decision; nothing about your keys leaves the machine.
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

## Approval gates

Anything an agent wants to run is gated, and the gate is meant to be *readable* — a
prompt you approve without seeing is no better than no prompt. Three rules hold:

- **One switch per engine, always displayed.** `autoApprove` (Settings → AI) governs
  only the built-in Zarya agent; native engines are weakened only by the explicit
  **АВТОПИЛОТ** chip. Nothing else lowers a gate: `autoApprove` is never translated
  into a driver permission mode, and the Codex sandbox follows the same chip rather
  than staying writable underneath it. The bar's chip is shown in every agent mode
  and reads whichever switch actually governs the active engine, so it cannot state
  a policy the driver isn't running; an engine with no bypass at all
  (Gemini/Kimi/Qwen always ask) shows it locked on «РУЧНОЙ».
- **Every gate has a card, and the card says what it is.** A request that arrives
  without a `tool_use` block still gets its own card, labelled from whatever the
  driver actually sent — command, path, or its own description — so a keyboard
  approval never lands on something invisible or on a bare tool name.
- **A pending card hides nothing.** While a gate awaits your decision the command is
  pinned open in a block of its own: no fold, no ellipsis, no inner scrollbar to
  clip the tail, and a line counter when it is multi-line. The feed scrolls to that
  card — specifically the one Enter would approve, which with parallel tool calls is
  not the last one on screen — and only that card shows the «Enter · Esc» hint.

## Terminal profiles

A shell profile is a program the app launches, so `terminal.customProfiles` is
effectively a list of things that will run on your machine — and the settings
channel is reachable from the renderer. Left open, a single renderer compromise
would become **persistent**: a profile survives restart, whereas the compromise
itself does not.

- **Structural validation.** A stored profile must name an absolute path to an
  existing file, free of control characters, with bounded argv. It may carry only
  locale, timezone and proxy variables — an allow list, because the deny list
  cannot be finished: `PROMPT_COMMAND`, `PS0`, `BASH_FUNC_*`, `PSModulePath`,
  `HOME` and friends each turn a trusted shell into an execution primitive, and
  the shell-integration scripts themselves source `$HOME/.bashrc`.
- **Explicit confirmation.** Validation cannot tell `powershell.exe -c <evil>`
  from a legitimate profile, so anything that would newly execute — a new
  profile, or an edited path/argv/env — requires your confirmation, with the
  path, arguments and environment values shown. Declining leaves the stored list
  untouched. Renaming a profile does not prompt.
- **Checked again at spawn.** The settings file is editable by hand, so the
  profile is re-validated when a terminal actually starts, not merely when it is
  stored. Auto-detected shells resolve to absolute paths for the same reason.

## Supported versions

Zarya is pre-1.0. Security fixes land on the latest released version; there is no
long-term-support branch at this stage.

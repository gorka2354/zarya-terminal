# Changelog

All notable changes to Zarya are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## 0.4.0 — «Орбита» (2026-07-21)

A large "cosmic CLI agent" redesign — Soviet-space pixel-constructivism. The whole
shell now reads like a launch console: pixel type, a drifting starfield, a launch
pad for the AI engine, and a bilingual "mission control" settings surface.

### Added

- **Pixel type system** — bundled offline pixel/dot-matrix fonts alongside the
  existing constructivist voice: **Pixelify Sans** (logo, hero headings) and
  **Handjet** (tech labels, bilingual sub-labels, telemetry gauges), plus PT Sans /
  JetBrains Mono for body and terminal (Oswald + Ruslan Display retained). All
  Cyrillic + Latin subsets, no network fetch (`src/renderer/src/main.tsx`).
- **Star backdrop** — a pixelated, twinkling starfield with occasional shooting
  stars sitting behind the whole app (`StarBackdrop.tsx`); pointer-events-none,
  DPR-capped, theme-aware (dark stars on light "poster" themes), and paused under
  `prefers-reduced-motion`.
- **Pixel logo** — "ЗАРЯ // ОРБИТА-1" wordmark in the titlebar (`Titlebar.tsx`).
- **Launch Pad ("Пусковой комплекс")** — a rocket-console overlay for picking the
  AI **engine (model)** and **thrust (effort)**, with a live mission clock and a
  pixel launch-pad scene; **ПУСК · ПОЕХАЛИ** applies both to settings and fires the
  launch animation (`LaunchPad.tsx`). Opened via `Ctrl+Alt+M` (`app.launch-pad`),
  the command palette, or a button in Settings → AI.
- **Reasoning thrust ("тяга")** — a new `AiSettings.effort` (`AiEffort`:
  `low` / `medium` / `high` / `max`) that drives temperature **and** token budget
  through `EFFORT_TUNING` (`src/shared/defaults.ts`). Surfaced as a 4-segment
  thrust bar in both the Launch Pad and Settings → AI.
- **Rocket-launch overlay** — a cinematic "ПОЕХАЛИ!" liftoff (countdown, parallax
  star streaks, exhaust embers, screen shake) fired on engine/thrust and
  provider/model changes (`RocketLaunch.tsx`).
- **"Центр управления" (Mission Control) settings** — the settings view is
  restyled as a control room with bilingual RU + EN labels, a 2-column theme-card
  picker, a gold −/+ font-size stepper, and a dedicated "rocket" toggle reserved for
  the dangerous auto-approve switch (`SettingsView.tsx`).
- **Expanded theme collection** — 9 cosmic-constructivist themes replacing the
  original two: 6 dark (**Заря · Космос** default, **Восток**, **Орбита**,
  **Спутник**, **Байконур**, **Рассвет**) and 3 light "poster paper" themes
  (**Плакат**, **Полдень**, **Чертёж**). See [docs/themes.md](docs/themes.md).
- **Terminal instrument-panel header** — a thin per-pane strip above each xterm
  surface ("★ CLI-АГЕНТ · ЗАРЯ" + the pane's own cwd) (`TerminalPane.tsx`).
- **"Топливо" fuel strip** — a launch-themed status line in the AI panel
  (`AiPanel.tsx`) and a matching fuel status item in the bottom status bar.
- **Offscreen QA harness** — `scripts/shoot.mjs`, a coverage-independent visual-QA
  tool that boots Zarya in an isolated throwaway instance (Playwright's Electron
  driver, its own `userData`, no single-instance lock, no user sessions) and
  captures the renderer's real pixels regardless of what covers the window or which
  monitor it's on. Supports `--theme`, `--rocket`, `--ui`, `--out`, `--wait`.

### Changed

- **Default theme** is now `zarya-cosmos` (Заря · Космос).
- **Exit-code badges, block separators and command blocks** restyled to match the
  new console aesthetic (behaviour unchanged).
- **Prepare-quit safety timer** raised from 2s to **8s** so session
  snapshot/prune has realistic room to finish on quit instead of being cut off
  mid-write (`src/main/index.ts`).

### Security

- **Prompt-injection spotlighting (OWASP LLM01)** — recent terminal output attached
  as automatic AI context is now wrapped in explicit `<untrusted-terminal-output>`
  markers in the system prompt, with an instruction to treat it strictly as data and
  never as instructions; a payload that forges the closing marker is neutralized
  (`src/renderer/src/features/ai/aiStore.ts`).
- **Navigation hardening** — `will-navigate` **and** `will-redirect` on the main
  window are now guarded: any off-origin navigation of the top frame is blocked and
  `http(s)` URLs are routed to the system browser instead, so the `window.zarya`
  bridge can never be exposed to a remote page (`src/main/index.ts`).
- **Isolated-instance override** — `ZARYA_USER_DATA` points a throwaway instance
  (used by the QA harness) at its own `userData` and bypasses the single-instance
  lock, so visual QA never touches the user's real sessions or settings.

## 0.1.0 (2026-07-20)

Initial release.

### Added

- **Terminal core** — xterm.js 6 with WebGL rendering (DOM fallback on context loss),
  find-in-terminal, clickable web links, Unicode 11 support, per-pane split/tab layout
  with drag-resizable gutters.
- **Blocks** — Warp-style command blocks driven by the OSC 133 shell-integration
  standard: per-command output capture, exit-code badges, duration, re-run, copy
  command/output, export as Markdown, and `Ctrl+↑`/`Ctrl+↓` navigation between blocks.
- **Shell integration** — bundled PowerShell (5.1 & 7+), bash and zsh integration
  scripts emitting OSC 133 (A/B/C/D), OSC 7/9;9/1337 (cwd), and a private,
  nonce-signed OSC 6973 channel for exact command-line capture; auto-detected shell
  profiles plus support for user-defined custom profiles.
- **Persistent sessions** — autosaved scrollback + blocks on an interval and on a
  graceful prepare-quit handshake; pin/favorite sessions; restore replays scrollback
  and blocks then starts a fresh shell in the saved directory; workspace (tabs +
  splits) restore on launch; 200-session prune policy exempting pinned/favorites.
- **AI Assistant** — provider-agnostic streaming transport (Anthropic, OpenAI, Ollama,
  any OpenAI-compatible endpoint) with the actual HTTP calls made from the main
  process so keys never cross into the renderer; encrypted key storage via
  `safeStorage`; tool-calling-capable agent transport with an explicit,
  off-by-default `autoApprove` safety gate; inline natural-language-to-command bar;
  per-block "ask AI" action.
- **Time Machine** — append-only, cross-session global command history with
  fuzzy multi-token search.
- **Workflows** — parameterized, reusable command snippets with `{{param}}`
  templating, user-defined plus a bundled starter pack mechanism.
- **IDE-lite** — Monaco-based editor pane, file tree, git diff view (porcelain v2
  status + HEAD-vs-working-tree diff), and click-to-open for file paths detected in
  terminal output (with `:line[:col]` suffix support).
- **Command palette & keybindings** — a single action registry drives both a
  searchable command palette and a fully remappable, JSON-configurable keybinding map.
- **Themes** — a CSS-variable + xterm-palette theme engine (`ThemeDef`) shipping
  Zarya Dawn and Zarya Night, with a `registerThemes()` extension point for adding
  more.
- **Ghost autosuggest** — fish-style inline command suggestions from cross-session
  history, accepted with `→`.
- **Privacy by construction** — no telemetry, no account, no server component; all
  state lives under the OS `userData` directory; API keys encrypted at rest via the
  OS keychain (Windows DPAPI / macOS Keychain / Linux Secret Service).
